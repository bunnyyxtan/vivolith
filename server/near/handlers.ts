// NEAR relayer for VIVOLITH: framework-free handlers (web Request -> Response) shared by the Vercel function
// (api/near/[route].ts) and the Vite dev server (server/near-relay.ts). Keys stay on the server; responses never
// echo key material or stack traces.
//
// Routes: GET status | POST guest {publicKey} | POST relay {signedDelegate: base64} | POST settle | POST deal | POST tick
//         | POST social {idToken, guest?} | POST claim {account}
import { createHash, createPublicKey, randomBytes, verify as verifySignature, type JsonWebKey } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deserialize } from "borsh";
import { Account, JsonRpcProvider, KeyPairSigner, PublicKey, SCHEMA, actions, nearToYocto, teraToGas, type KeyPairString } from "near-api-js";
import { MERCHANTS, keyPairFromSeed, merchantKey, residentKey, type MerchantId } from "./keys.ts";
import { RESIDENTS, executableOffers, planResident, type Offer } from "../../src/economy/residents.ts";
import { spokenText } from "../../src/v2/audio-manifest.ts";
import { gameLine, speechToken, speechTokenOk, synthesize, voiceSecret, voiceText } from "./voice.ts";
import { MAX_QUESTION, answer, factsFor, moodOf, playerFacts, residentFacts, type Exchange, type Ledger, type Receipt } from "./talk.ts";
import { readMemory } from "./memory.ts";
import { LEVERS, agentConfig, applyLivePrices, attachTx, claimBidSend, decideBid, decideResident, decisionFor, livePrices, priceMoved, recentDecisions, releaseBidSend, type AgentConfig, type Decision, type DecisionStore } from "./agent.ts";
import { agentsHalted, fromScheduler, opsConfig, spend, takeTestTurn, testTurnKey, usage } from "./ops.ts";
import { AGENTS, memoriesFor, recordMemories, verifyPass } from "./autonomy.ts";
import { verifyDecision } from "./verify.ts";
import type { ChainReceipt, MemoryRow, Snapshot } from "./memory.ts";
import { addBond, bondFacts, chronicle, putDealRef, readBonds, readChronicle, takeDealRef } from "./ledger.ts";
import { changedSince, decisionEvent, eventId, lastDecisionAt, type ChronicleEvent } from "../../src/economy/chronicle.ts";
import { GRACE_DAYS, guildFillTo, guildPlan, rentToCharge, touristUnits } from "../../src/economy/recovery.ts";
import { ORCHARD_PICK, bidFor, dealBounds, planMerchantTrades, quote } from "../../src/economy/pricing.ts";
import { newcomerPrice, verifyDealUnit } from "../../src/economy/haggle.ts";
import { closingNeed, shopperWant } from "../../src/economy/sim.ts";
import { initialEconomy, type EconomyState } from "../../src/economy/state.ts";

export interface RelayEnv {
  [key: string]: string | undefined;
}

interface Config {
  relayerId: string;
  relayerKey: KeyPairString | null;
  contractId: string;
  rpcUrl: string;
  redisUrl: string | null;
  redisToken: string | null;
  /** Our Auth0 tenant (public values). Social login is offered only when both are set. */
  auth0Domain: string | null;
  auth0ClientId: string | null;
}

const MAX_BODY = 4096;
const MAX_GAS = teraToGas("100");
const PLAYER_METHODS = new Set(["buy", "sell", "deal"]);
const GOODS = new Set(["mango", "lemon", "lassi"]);
const DEAL_TTL_MS = 2 * 60 * 1000;
/** How far a haggle may move a merchant off its posted price before it refuses to sign. */
const GUEST_FUNDING = "0.01"; // account + key storage; guests never pay gas (meta-transactions)
/** One on-chain market day settles every 10 real minutes (fast-forward previews run in the client sim). */
export const MARKET_DAY_MS = 10 * 60 * 1000;
/** The Market Guild fund: minted once when the contract opens (`new`); it only lends what it holds, records every
 *  loan as the stall's debt, and is repaid (then refilled by dues) from earning tills. deploy-contract.ts seeds it.
 *  The lending and collection rules are in src/economy/recovery.ts. */
export { GUILD_FUND } from "../../src/economy/recovery.ts";
/** Tomas pays the harbor this per mango on his standing contract (the offline sim charges the same). */
const HARBOR_COST = 2;

const LIMITS = {
  guest: { max: 5, windowSec: 3600 }, // per IP
  relay: { max: 30, windowSec: 60 }, // per player account
  relayIp: { max: 60, windowSec: 60 }, // per IP
  settle: { max: 6, windowSec: 60 }, // global
  deal: { max: 20, windowSec: 60 }, // per player account
  claim: { max: 6, windowSec: 60 }, // per player account
  social: { max: 10, windowSec: 3600 }, // per IP
  // per signed-in account: guests whose progress (and starter purse) may merge into it. Each new guest gets the
  // starter grant once; this keeps "make guests, merge them into one account" from multiplying it.
  merge: { max: 3, windowSec: 30 * 24 * 3600 },
  save: { max: 20, windowSec: 60 }, // per account: cloud save reads and writes
  talk: { max: 10, windowSec: 60 }, // per IP: "Ask why" (each may be one NEAR AI call)
  voice: { max: 30, windowSec: 60 }, // per IP: spoken lines without a recorded file (cached; daily budget in voice.ts)
  voiceDay: { max: 1500, windowSec: 24 * 3600 }, // global: voice requests a day across instances (counted before the cache)
  voiceChars: { max: 20000, windowSec: 24 * 3600 }, // global: characters sent to the voice provider a day (about $1.60 at API prices)
  pick: { max: 6, windowSec: 3600 }, // per IP: orchard picks (each account also once per market day)
} as const;

export function readConfig(env: RelayEnv): Config {
  const relayerId = (env.NEAR_RELAYER_ID ?? env.NEAR_ACCOUNT_ID ?? "").trim();
  let relayerKey = (env.NEAR_RELAYER_KEY ?? env.NEAR_PRIVATE_KEY ?? "").trim() || null;
  if (!relayerKey && relayerId) {
    try {
      const file = path.join(os.homedir(), ".near-credentials", "testnet", `${relayerId}.json`);
      relayerKey = (JSON.parse(fs.readFileSync(file, "utf8")) as { private_key?: string }).private_key ?? null;
    } catch {
      /* no local keychain (expected on Vercel) */
    }
  }
  return {
    relayerId,
    relayerKey: relayerKey as KeyPairString | null,
    contractId: (env.NEAR_CONTRACT_ID ?? `market.${relayerId}`).trim(),
    rpcUrl: (env.NEAR_RPC_URL ?? "https://rpc.testnet.fastnear.com").trim(),
    redisUrl: (env.UPSTASH_REDIS_REST_URL ?? env.KV_REST_API_URL ?? "").trim() || null,
    redisToken: (env.UPSTASH_REDIS_REST_TOKEN ?? env.KV_REST_API_TOKEN ?? "").trim() || null,
    auth0Domain: (env.NEAR_AUTH0_DOMAIN ?? "").trim().replace(/^https?:\/\//, "").replace(/\/+$/, "") || null,
    auth0ClientId: (env.NEAR_AUTH0_CLIENT_ID ?? "").trim() || null,
  };
}

const configured = (c: Config): boolean => c.relayerId.endsWith(".testnet") && Boolean(c.relayerKey) && c.contractId.endsWith(".testnet");

// ---------- rate limiting (fixed window; Upstash Redis REST when configured, else per-instance memory) ----------

const memory = new Map<string, { n: number; until: number }>();

async function hit(cfg: Config, bucket: string, max: number, windowSec: number, n = 1): Promise<boolean> {
  const key = `vivolith:rl:${bucket}:${Math.floor(Date.now() / 1000 / windowSec)}`;
  if (cfg.redisUrl && cfg.redisToken) {
    const r = await fetch(`${cfg.redisUrl}/pipeline`, {
      method: "POST",
      headers: { authorization: `Bearer ${cfg.redisToken}`, "content-type": "application/json" },
      body: JSON.stringify([["INCRBY", key, String(n)], ["EXPIRE", key, String(windowSec + 5)]]),
    });
    if (!r.ok) throw new Error("rate limiter unavailable");
    const [{ result }] = (await r.json()) as [{ result: number }];
    return result <= max;
  }
  // ponytail: per-instance memory only resets on cold start; Upstash is the persistent path in production.
  const now = Date.now();
  const e = memory.get(key);
  if (!e || e.until < now) {
    memory.set(key, { n, until: now + windowSec * 1000 });
    return n <= max;
  }
  e.n += n;
  return e.n <= max;
}

const kvMemory = new Map<string, string>();
/** GET / SET one value: Upstash Redis REST when configured (persistent), else per-instance memory (dev only). */
async function kv(cfg: Config, cmd: ["GET", string] | ["SET", string, string]): Promise<string | null> {
  if (cfg.redisUrl && cfg.redisToken) {
    const r = await fetch(cfg.redisUrl, { method: "POST", headers: { authorization: `Bearer ${cfg.redisToken}`, "content-type": "application/json" }, body: JSON.stringify(cmd) });
    if (!r.ok) throw new HttpError(503, "save storage unavailable");
    return ((await r.json()) as { result: string | null }).result;
  }
  if (cmd[0] === "SET") { kvMemory.set(cmd[1], cmd[2]); return "OK"; }
  return kvMemory.get(cmd[1]) ?? null;
}

const agentMemory = new Map<string, { v: string; until: number }>();
/** The decision guard's store: the same Upstash Redis REST the limiter and market clock use (persistent, shared by every
 *  instance), else per-instance memory for local dev. Redis errors throw: agent.ts then falls back to the rule price. */
export function decisionStore(cfg: Config): DecisionStore {
  if (cfg.redisUrl && cfg.redisToken) {
    const cmd = async (args: string[]): Promise<string | null> => {
      const r = await fetch(cfg.redisUrl!, { method: "POST", headers: { authorization: `Bearer ${cfg.redisToken}`, "content-type": "application/json" }, body: JSON.stringify(args) });
      if (!r.ok) throw new Error("decision store unavailable");
      const res = ((await r.json()) as { result: string | number | null }).result;
      return res === null ? null : String(res);
    };
    return {
      get: (k) => cmd(["GET", k]),
      setNx: async (k, v, ttl) => (await cmd(["SET", k, v, "NX", "EX", String(ttl)])) === "OK",
      set: async (k, v, ttl) => { await cmd(["SET", k, v, "EX", String(ttl)]); },
      del: async (k) => { await cmd(["DEL", k]); },
      incr: async (k, ttl) => {
        const r = await fetch(`${cfg.redisUrl}/pipeline`, { method: "POST", headers: { authorization: `Bearer ${cfg.redisToken}`, "content-type": "application/json" }, body: JSON.stringify([["INCR", k], ["EXPIRE", k, String(ttl)]]) });
        if (!r.ok) throw new Error("decision store unavailable");
        const n = Number(((await r.json()) as [{ result: unknown }])[0]?.result);
        if (!Number.isFinite(n)) throw new Error("decision store gave no count");
        return n;
      },
    };
  }
  const live = (k: string): string | null => { const e = agentMemory.get(k); return e && e.until > Date.now() ? e.v : null; };
  return {
    get: async (k) => live(k),
    setNx: async (k, v, ttl) => { if (live(k) !== null) return false; agentMemory.set(k, { v, until: Date.now() + ttl * 1000 }); return true; },
    set: async (k, v, ttl) => { agentMemory.set(k, { v, until: Date.now() + ttl * 1000 }); },
    del: async (k) => { agentMemory.delete(k); },
    incr: async (k, ttl) => { const n = Number(live(k) ?? 0) + 1; agentMemory.set(k, { v: String(n), until: Date.now() + ttl * 1000 }); return n; },
  };
}

// ---------- helpers ----------

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

const clientIp = (req: Request): string => (req.headers.get("x-forwarded-for") ?? "local").split(",")[0].trim().slice(0, 64);

async function readJson(req: Request, max = MAX_BODY): Promise<Record<string, unknown>> {
  const raw = await req.text();
  if (raw.length > max) throw new HttpError(413, "body too large");
  try {
    const v = JSON.parse(raw || "{}") as unknown;
    if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error();
    return v as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "invalid JSON");
  }
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

interface TxResult {
  txHash: string;
  ok: boolean;
  error?: string;
}

/** Final outcome of a transaction: ok only if the transaction and every receipt succeeded. */
export function outcome(r: unknown): TxResult {
  const o = r as { transaction?: { hash?: string }; status?: unknown; receipts_outcome?: { outcome: { status: unknown } }[] };
  const statuses = [o.status, ...(o.receipts_outcome ?? []).map((x) => x.outcome.status)];
  const failure = statuses.find((s) => typeof s === "object" && s !== null && "Failure" in s) as { Failure: unknown } | undefined;
  const panic = failure ? /"(?:panic_msg|ExecutionError)":"([^"]{1,160})/.exec(JSON.stringify(failure.Failure))?.[1] : undefined;
  return { txHash: o.transaction?.hash ?? "", ok: !failure, error: failure ? panic ?? "transaction failed" : undefined };
}

function account(cfg: Config): { provider: JsonRpcProvider; relayer: Account } {
  const provider = new JsonRpcProvider({ url: cfg.rpcUrl });
  return { provider, relayer: new Account(cfg.relayerId, provider, cfg.relayerKey!) };
}

async function view<T>(provider: JsonRpcProvider, contractId: string, method: string, args: Record<string, unknown>): Promise<T> {
  return (await provider.callFunction({ contractId, method, args, finality: "final" })) as unknown as T;
}

/** Guest ids are derived from the browser's public key, so retries are idempotent and one key = one account. */
export function guestIdFor(publicKey: string, relayerId: string): string {
  return `g${createHash("sha256").update(publicKey).digest("hex").slice(0, 16)}.${relayerId}`;
}

// ---------- routes ----------

async function status(cfg: Config, env: RelayEnv): Promise<Response> {
  const last = await kv(cfg, ["GET", LAST_TICK]).catch(() => null);
  const ops = opsConfig(env), store = decisionStore(cfg);
  const enabled = [...agentConfig(env).enabled].filter((id) => (AGENTS as readonly string[]).includes(id));
  return json(200, {
    // who moves the market and whether agents may use NEAR AI right now (no secrets, no limits beyond today's use)
    driver: ops.driver,
    agents: { enabled, halted: await agentsHalted(ops, store), usedToday: await usage(store) },
    // bounded playtest: the cap and how many market turns it has used (null = no cap)
    testTurns: ops.testTurns === null ? null : { run: ops.testRun, limit: ops.testTurns, used: Number(await store.get(testTurnKey(ops.testRun)).catch(() => null) ?? 0) },
    lastTick: last ? (JSON.parse(last) as unknown) : null,
    configured: configured(cfg),
    network: "testnet",
    contractId: cfg.contractId,
    relayer: cfg.relayerId || null,
    merchants: MERCHANTS.map((m) => `${m}.${cfg.relayerId}`),
    rateLimit: cfg.redisUrl ? "persistent" : "memory",
    marketDayMs: MARKET_DAY_MS,
    auth: cfg.auth0Domain && cfg.auth0ClientId ? { domain: cfg.auth0Domain, clientId: cfg.auth0ClientId } : null,
  });
}

async function guest(cfg: Config, req: Request): Promise<Response> {
  const body = await readJson(req);
  const pk = typeof body.publicKey === "string" ? body.publicKey : "";
  let publicKey: PublicKey;
  try {
    publicKey = PublicKey.fromString(pk);
  } catch {
    throw new HttpError(400, "invalid public key");
  }
  if (!pk.startsWith("ed25519:")) throw new HttpError(400, "ed25519 keys only");
  const { provider, relayer } = account(cfg);
  const accountId = guestIdFor(pk, cfg.relayerId);
  const exists = await provider.viewAccount({ accountId, finality: "final" }).then(() => true, () => false);
  const registered = exists && (await view<boolean>(provider, cfg.contractId, "is_registered", { account_id: accountId }));
  if (registered) return json(200, { status: "onchain", accountId, txHashes: [] }); // a repeat: nothing to create or grant
  // Only a new account (an account, NEAR for its key, and a starter purse) counts against the per-address limit.
  if (!(await hit(cfg, `guest:${clientIp(req)}`, LIMITS.guest.max, LIMITS.guest.windowSec))) throw new HttpError(429, "too many new players from this address, try later");
  const txs: string[] = [];
  if (!exists) {
    const r = outcome(
      await relayer.signAndSendTransaction({
        receiverId: accountId,
        actions: [
          actions.createAccount(),
          actions.transfer(nearToYocto(GUEST_FUNDING)),
          actions.addFunctionCallAccessKey(publicKey, cfg.contractId, [...PLAYER_METHODS]),
        ],
        throwOnFailure: false,
      }),
    );
    if (!r.ok) return json(502, { status: "failed", message: r.error });
    txs.push(r.txHash);
  }
  if (!(await view<boolean>(provider, cfg.contractId, "is_registered", { account_id: accountId }))) {
    const r = outcome(await relayer.callFunctionRaw({ contractId: cfg.contractId, methodName: "register_player", args: { account_id: accountId }, gas: MAX_GAS }));
    if (!r.ok) return json(502, { status: "failed", message: r.error });
    txs.push(r.txHash);
  }
  return json(200, { status: "onchain", accountId, txHashes: txs });
}

/** Re-registers an account this relayer created (a guest `g...` or signed-in `s...` sub-account that exists on chain)
 *  with the market contract, e.g. after the market's ledger was reset. Idempotent; never creates accounts. */
async function register(cfg: Config, req: Request): Promise<Response> {
  const body = await readJson(req);
  const accountId = String(body.accountId ?? "");
  const suffix = `.${cfg.relayerId}`;
  if (!accountId.endsWith(suffix) || !/^[gs][0-9a-f]{16}$/.test(accountId.slice(0, -suffix.length))) throw new HttpError(400, "not a game account");
  const { provider, relayer } = account(cfg);
  if (!(await provider.viewAccount({ accountId, finality: "final" }).then(() => true, () => false))) throw new HttpError(404, "no such account");
  if (await view<boolean>(provider, cfg.contractId, "is_registered", { account_id: accountId })) return json(200, { status: "onchain", accountId, txHashes: [] });
  // only a registration that would mint a starter purse counts against the per-address limit
  if (!(await hit(cfg, `register:${clientIp(req)}`, LIMITS.guest.max, LIMITS.guest.windowSec))) throw new HttpError(429, "too many new players from this address, try later");
  const r = outcome(await relayer.callFunctionRaw({ contractId: cfg.contractId, methodName: "register_player", args: { account_id: accountId }, gas: MAX_GAS }));
  return json(r.ok ? 200 : 502, { status: r.ok ? "onchain" : "failed", accountId, txHashes: [r.txHash], message: r.error });
}

interface DecodedDelegate {
  delegateAction: { senderId: string; receiverId: string; actions: { functionCall?: { methodName: string; gas: bigint; deposit: bigint } }[] };
}

/** Throws unless the delegate only calls player methods on our contract with zero deposit and bounded gas. */
export function checkDelegate(d: DecodedDelegate, contractId: string): void {
  const a = d.delegateAction;
  if (a.receiverId !== contractId) throw new HttpError(403, "receiver not allowed");
  if (a.actions.length < 1 || a.actions.length > 3) throw new HttpError(403, "1 to 3 actions only");
  for (const act of a.actions) {
    const fc = act.functionCall;
    if (!fc || Object.keys(act).some((k) => k !== "functionCall" && (act as Record<string, unknown>)[k] !== undefined)) throw new HttpError(403, "function calls only");
    if (!PLAYER_METHODS.has(fc.methodName)) throw new HttpError(403, "method not allowed");
    if (BigInt(fc.deposit) !== 0n) throw new HttpError(403, "deposit not allowed");
    if (BigInt(fc.gas) > MAX_GAS) throw new HttpError(403, "gas too high");
  }
}

async function relay(cfg: Config, req: Request): Promise<Response> {
  if (!(await hit(cfg, `relayip:${clientIp(req)}`, LIMITS.relayIp.max, LIMITS.relayIp.windowSec))) throw new HttpError(429, "slow down");
  const body = await readJson(req);
  if (typeof body.signedDelegate !== "string") throw new HttpError(400, "signedDelegate (base64) required");
  let decoded: DecodedDelegate;
  try {
    decoded = deserialize(SCHEMA.SignedDelegate, Buffer.from(body.signedDelegate, "base64")) as unknown as DecodedDelegate;
  } catch {
    throw new HttpError(400, "invalid signed delegate");
  }
  checkDelegate(decoded, cfg.contractId);
  const sender = decoded.delegateAction.senderId;
  if (!(await hit(cfg, `relay:${sender}`, LIMITS.relay.max, LIMITS.relay.windowSec))) throw new HttpError(429, "slow down");
  const { relayer } = account(cfg);
  let raw: unknown;
  try {
    raw = await relayer.signAndSendTransaction({ receiverId: sender, actions: [actions.signedDelegate(decoded as never)], throwOnFailure: false });
  } catch (e) {
    // Sent but unanswered (timeout, dropped connection): it may still land. The client resends these exact bytes,
    // which the chain accepts at most once (the delegate nonce), so "unknown" is safe to retry and never doubles.
    const msg = e instanceof Error ? e.message : String(e);
    if (/DelegateActionInvalidNonce|DelegateActionNonce/i.test(msg)) return json(409, { status: "duplicate", accountId: sender, message: "already submitted" });
    if (/DelegateActionExpired|InvalidSignature|DelegateActionInvalidSignature|AccessKeyNotFound/i.test(msg)) return json(422, { status: "failed", accountId: sender, message: msg.split("\n")[0].slice(0, 160) });
    return json(504, { status: "unknown", accountId: sender, message: "no answer from NEAR yet" });
  }
  if (/DelegateActionInvalidNonce|DelegateActionNonce/.test(JSON.stringify(raw))) {
    return json(409, { status: "duplicate", accountId: sender, message: "already submitted" });
  }
  const r = outcome(raw);
  await recordPlayerDeal(cfg, decoded, sender, r).catch(() => undefined); // history only: never changes the answer
  return json(r.ok ? 200 : 422, { status: r.ok ? "onchain" : "failed", txHash: r.txHash, accountId: sender, contractId: cfg.contractId, message: r.error });
}

/** A relayed `deal` (signed by the relayer moments earlier, see deal()) becomes history: a Chronicle trade event (confirmed
 *  or failed), a durable bond between this player and the stall, and a "reopened" event when a delivery opened a closed
 *  stall (read back from the contract). Only the transaction's own arguments and outcome are used. */
async function recordPlayerDeal(cfg: Config, d: DecodedDelegate, player: string, r: TxResult): Promise<void> {
  const fc = d.delegateAction.actions[0]?.functionCall as { methodName: string; args?: Uint8Array } | undefined;
  if (!fc || fc.methodName !== "deal" || !fc.args) return;
  const a = JSON.parse(Buffer.from(fc.args).toString()) as { merchant?: string; side?: string; token_id?: string; qty?: string; unit_price?: string; nonce?: string };
  const merchant = String(a.merchant ?? ""), side = a.side === "buy" ? "buy" : "sell", good = String(a.token_id ?? ""), qty = Number(a.qty), unit = Number(a.unit_price);
  if (!(MERCHANTS as readonly string[]).includes(merchant) || !Number.isInteger(qty) || !Number.isInteger(unit)) return;
  const store = decisionStore(cfg), at = Date.now(), day = Math.floor(at / MARKET_DAY_MS);
  const ref = await takeDealRef(store, player, String(a.nonce ?? ""));
  const reference = ref && ref.merchant === merchant && ref.unit === unit && ref.qty === qty ? ref.reference : null;
  const total = qty * unit, sign = side === "sell" ? 1 : -1; // sell: the player delivers goods and receives coins
  const name = merchant.charAt(0).toUpperCase() + merchant.slice(1);
  const events: ChronicleEvent[] = [{
    id: eventId(at, "trade"), at, day, kind: "trade", actors: [merchant], player,
    text: side === "sell"
      ? `A player sold ${qty} ${good} to ${name} at ${unit} c${reference !== null && unit < reference ? ` (${name}'s own bid was ${reference} c)` : ""}.`
      : `A player bought ${qty} ${good} from ${name} at ${unit} c.`,
    changes: [{ who: merchant, good, delta: sign * qty }, { who: merchant, good: "coin", delta: -sign * total }, { who: "player", good, delta: -sign * qty }, { who: "player", good: "coin", delta: sign * total }],
    status: r.ok ? "confirmed" : "failed", txHash: r.txHash || null, decision: null, since: [],
  }];
  if (r.ok) {
    await addBond(store, merchant, player, { at, day, kind: side === "sell" ? "delivered" : "bought", good, qty, unit, reference, evidence: "chain", txHash: r.txHash, note: null });
    if (ref?.closed && side === "sell") {
      const { provider } = account(cfg);
      const stalls = await view<{ merchant: string; open: boolean }[]>(provider, cfg.contractId, "get_stalls", {}).catch(() => []);
      if (stalls.find((s) => s.merchant === merchant)?.open) {
        // the market turn reads these for the one-time rent grace and so does not announce this reopening twice
        await kv(cfg, ["SET", `vivolith:stall:${merchant}`, "open"]).catch(() => null);
        await kv(cfg, ["SET", `vivolith:reopened:${merchant}`, String(day)]).catch(() => null);
      }
      if (stalls.find((s) => s.merchant === merchant)?.open) events.push({ id: eventId(at + 1, "reopened"), at: at + 1, day, kind: "reopened", actors: [merchant], player, text: `${name}'s stall reopened after a delivery.`, changes: [], status: "confirmed", txHash: r.txHash, decision: null, since: [] });
    }
  }
  await chronicle(store, events);
}

interface OfferRow {
  merchant: string;
  token_id: string;
  side: "ask" | "bid";
  qty: string;
  price: string;
}

/** A price better for the player than the stall's current price (live NEAR AI price included) needs a haggle the relayer can
 *  replay from the claimed tactics; anything else must be the current price. The two scripted first-day prices
 *  (newcomer buy, Pema's delivery) are allowed once per player. */
async function checkNegotiated(cfg: Config, st: EconomyState, id: MerchantId, side: "buy" | "sell", good: string, unit: number, b: Record<string, unknown>, player: string): Promise<void> {
  const tactics = Array.isArray(b.tactics) ? b.tactics.map(String) : [];
  const c = verifyDealUnit(st, id, side, good as "mango" | "lemon" | "lassi", unit, tactics, Number(b.rep));
  if (c.ok) return;
  if (newcomerPrice(side, id, unit, c.reference) && (await claimOnce(cfg, `newcomer:${player}:${side}`, 30 * 24 * 3600))) return;
  throw new HttpError(409, c.reason);
}

/** The merchant signs a haggled price if it is within its bounds; the player settles it with `deal` (one tx). */
async function deal(cfg: Config, req: Request, env: RelayEnv): Promise<Response> {
  const b = await readJson(req);
  const merchant = String(b.merchant ?? "");
  const side = String(b.side ?? "");
  const token = String(b.token ?? "");
  const player = String(b.player ?? "");
  const qty = Number(b.qty);
  const unit = Number(b.unit);
  /** The raw NEAR AI price the player's screen was built on (0 = "no agent price"); absent from older clients. */
  const ref = b.ref === undefined || b.ref === null ? null : Number(b.ref);
  if (ref !== null && !Number.isFinite(ref)) throw new HttpError(400, "bad price reference");
  if (!(MERCHANTS as readonly string[]).includes(merchant)) throw new HttpError(400, "unknown merchant");
  if (side !== "buy" && side !== "sell") throw new HttpError(400, "side must be buy or sell");
  if (!GOODS.has(token)) throw new HttpError(400, "unknown good");
  if (!Number.isInteger(qty) || qty < 1 || qty > 40 || !Number.isInteger(unit) || unit < 1 || unit > 1000) throw new HttpError(400, "bad quantity or price");
  if (!/^[a-z0-9._-]{2,64}$/.test(player)) throw new HttpError(400, "bad account id");
  if (!(await hit(cfg, `deal:${player}`, LIMITS.deal.max, LIMITS.deal.windowSec))) throw new HttpError(429, "slow down");
  const { provider } = account(cfg);
  // Judge the deal on the merchant's live balances with the same rules the game shows (src/economy/pricing.ts).
  // The posted order book is only a snapshot from the last market turn: Arin's kitchen burns mangoes every turn,
  // so his bid was withdrawn and re-posted minute by minute while the game still offered the sale.
  const [registered, offers, st] = await Promise.all([
    view<boolean>(provider, cfg.contractId, "is_registered", { account_id: player }),
    view<OfferRow[]>(provider, cfg.contractId, "get_offers", {}),
    chainEconomy(provider, cfg),
  ]);
  if (!registered) throw new HttpError(403, "player not registered");
  const id = merchant as MerchantId, good = token as "mango" | "lemon" | "lassi", m = st.merchants[id];
  // A live NEAR AI decision (confirmed, order still posted) sets this stall's price for the player too: same prices as the
  // game shows, so a quote built on an older price is refused with the current one instead of trading at a price nobody sees.
  applyLivePrices(st, await livePrices(decisionStore(cfg), offers, Math.floor(Date.now() / MARKET_DAY_MS)).catch(() => []));
  const moved = priceMoved(st, id, side as "buy" | "sell", good, ref);
  if (moved !== null) throw new HttpError(409, `price moved: now ${moved} c`);
  const posted = offers.find((o) => o.merchant === merchant && o.token_id === token && o.side === (side === "buy" ? "ask" : "bid"));
  let reference: number | null = null; // the stall's own price for this side: how a confirmed deal is described later
  const store = decisionStore(cfg);
  try {
    if (side === "buy") {
      if (m.status !== "open") throw new HttpError(409, "stall is closed");
      if (!m.sells.includes(good)) throw new HttpError(409, "doesn't sell that");
      if (m.stock[good] < qty) throw new HttpError(409, m.stock[good] > 0 ? `only ${m.stock[good]} on offer` : "sold out");
      const p = posted ? Number(posted.price) : quote(st, id, good, false).price;
      reference = p;
      const bounds = dealBounds(p); // the executed unit must sit inside the haggling range around the authoritative ask
      if (unit < bounds.min) throw new HttpError(409, `won't go below ${bounds.min} c`);
      if (unit > bounds.max) throw new HttpError(409, `won't take more than ${bounds.max} c`);
      await checkNegotiated(cfg, st, id, "buy", good, unit, b, player);
    } else {
      const p = bidFor(st, id, good)?.price ?? null;
      if (p === null) throw new HttpError(409, "not buying that today");
      reference = p;
      const bounds = dealBounds(p); // around the authoritative bid (a live NEAR AI bid when there is one)
      if (unit > bounds.max) throw new HttpError(409, `won't pay more than ${bounds.max} c`);
      if (unit < bounds.min) throw new HttpError(409, `won't pay less than ${bounds.min} c`);
      if (m.cash < qty * unit) throw new HttpError(409, "not enough coin to pay that");
      await checkNegotiated(cfg, st, id, "sell", good, unit, b, player);
    }
  } catch (e) {
    // a refused offer is part of the history between this player and this stall (no trade happened; the relayer said no)
    if (e instanceof HttpError && e.status === 409) await addBond(store, id, player, { at: Date.now(), day: Math.floor(Date.now() / MARKET_DAY_MS), kind: "refused", good, qty, unit, reference, evidence: "relayer", txHash: null, note: e.message.slice(0, 60) }).catch(() => undefined);
    throw e;
  }
  const secret = (env.NEAR_MERCHANT_SECRET ?? "").trim();
  if (!secret) throw new HttpError(503, "merchant keys not configured");
  const nonce = Date.now() * 1000 + Math.floor(Math.random() * 1000);
  await putDealRef(store, player, String(nonce), { merchant, side: side as "buy" | "sell", token, qty, unit, reference, closed: m.status !== "open" }).catch(() => undefined);
  const expiresMs = Date.now() + DEAL_TTL_MS;
  const message = `vivolith-deal|${cfg.contractId}|${merchant}|${player}|${side}|${token}|${qty}|${unit}|${nonce}|${expiresMs}`;
  const { signature } = merchantKey(merchant as MerchantId, secret).sign(new TextEncoder().encode(message));
  return json(200, {
    status: "signed",
    args: { merchant, side, token_id: token, qty: String(qty), unit_price: String(unit), nonce: String(nonce), expires_ms: String(expiresMs), signature: Buffer.from(signature).toString("base64") },
  });
}

// ---------- Google / email login (our Auth0 tenant) ----------

const jwksCache = new Map<string, { keys: (JsonWebKey & { kid?: string })[]; at: number }>();

interface IdClaims {
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
}

/** Verifies an RS256 ID token from our Auth0 tenant (signature, issuer, audience, expiry); throws otherwise. */
export async function verifyIdToken(token: string, cfg: Config): Promise<IdClaims> {
  const issuer = `https://${cfg.auth0Domain}/`;
  const parts = token.split(".");
  if (parts.length !== 3) throw new HttpError(400, "bad id token");
  const [h, p, sig] = parts;
  let header: { alg?: string; kid?: string };
  let c: { iss?: string; aud?: string | string[]; exp?: number; sub?: string; email?: string; email_verified?: boolean; name?: string };
  try {
    header = JSON.parse(Buffer.from(h, "base64url").toString()) as typeof header;
    c = JSON.parse(Buffer.from(p, "base64url").toString()) as typeof c;
  } catch {
    throw new HttpError(400, "bad id token");
  }
  if (header.alg !== "RS256") throw new HttpError(401, "unsupported token algorithm");
  let set = jwksCache.get(issuer);
  if (!set || Date.now() - set.at > 3600_000 || !set.keys.some((k) => k.kid === header.kid)) {
    const r = await fetch(`${issuer}.well-known/jwks.json`);
    if (!r.ok) throw new HttpError(502, "login provider unavailable");
    set = { ...((await r.json()) as { keys: (JsonWebKey & { kid?: string })[] }), at: Date.now() };
    jwksCache.set(issuer, set);
  }
  const jwk = set.keys.find((k) => k.kid === header.kid);
  if (!jwk) throw new HttpError(401, "unknown signing key");
  const ok = verifySignature("RSA-SHA256", Buffer.from(`${h}.${p}`), createPublicKey({ key: jwk, format: "jwk" }), Buffer.from(sig, "base64url"));
  if (!ok) throw new HttpError(401, "invalid token signature");
  const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (c.iss !== issuer || !aud.includes(cfg.auth0ClientId ?? "")) throw new HttpError(401, "token not issued for this game");
  if (!c.exp || c.exp * 1000 < Date.now()) throw new HttpError(401, "token expired, sign in again");
  if (!c.sub || c.sub.length > 200) throw new HttpError(401, "token has no subject");
  return { sub: c.sub, email: c.email, email_verified: c.email_verified, name: c.name };
}

/** Which game account a verified login owns. A verified email is the identity, so Google and an email code for
 *  the same address reach the same account; otherwise the login's own subject is. */
export function identityOf(claims: IdClaims): string {
  return claims.email && claims.email_verified === true ? `email:${claims.email.trim().toLowerCase()}` : `sub:${claims.sub}`;
}

interface GuestLink {
  accountId: string;
  publicKey: string;
  signature: string; // base64 ed25519 over `vivolith-link|<guest account>|<sha256 hex of the id token>`
}

/** Checks that the caller holds this browser's guest key: the guest id derives from the key, and the key signed a
 *  message bound to this very login token (a proof cannot be replayed for another login). */
function guestFromProof(link: GuestLink, idToken: string, cfg: Config): string | null {
  if (!link || typeof link.accountId !== "string" || typeof link.publicKey !== "string" || typeof link.signature !== "string") return null;
  if (guestIdFor(link.publicKey, cfg.relayerId) !== link.accountId) return null;
  const msg = `vivolith-link|${link.accountId}|${createHash("sha256").update(idToken).digest("hex")}`;
  try {
    return PublicKey.fromString(link.publicKey).verify(new TextEncoder().encode(msg), Buffer.from(link.signature, "base64")) ? link.accountId : null;
  } catch {
    return null;
  }
}

/** Contract STARTER_COIN: what register_player mints, once per account. */
const STARTER = 40;

type Holdings = Record<string, number>;
const holdingsOf = async (provider: JsonRpcProvider, cfg: Config, accountId: string): Promise<Holdings> =>
  Object.fromEntries((await view<[string, string][]>(provider, cfg.contractId, "get_balances", { account_id: accountId })).map(([t, v]) => [t, Number(v)]));
/** A guest that has done nothing yet holds exactly its starter purse. */
const untouched = (h: Holdings): boolean => Object.keys(h).every((t) => t === "coin") && (h.coin ?? 0) === STARTER;

/** Signs a player in with Google or email. The verified identity always maps to the same game account, whose
 *  function-call session key is derived from the identity, so the same account and key are recovered on any device.
 *
 *  A browser that proves it owns a guest account (a signature over this very login token) brings that guest along:
 *  - The identity has no account yet: one transaction registers it, moves everything the guest holds into it and
 *    burns the new account's own starter purse, so the player keeps exactly the guest's holdings and one purse in all.
 *    The transaction is atomic: an interrupted sign-in leaves the guest untouched, and a retry runs it again.
 *  - The identity already has an account and the guest has progress: nothing moves until the player chooses
 *    (`choice`): "merge" moves the guest in (one starter purse is burned, so the player still has one in all),
 *    "separate" signs in and leaves the guest in this browser, anything else changes nothing and returns `conflict`.
 *    Only the browser holding the guest key can make that choice (the proof is bound to the login token). */
async function social(cfg: Config, req: Request, env: RelayEnv): Promise<Response> {
  if (!cfg.auth0Domain || !cfg.auth0ClientId) throw new HttpError(503, "sign-in is not configured");
  if (!(await hit(cfg, `social:${clientIp(req)}`, LIMITS.social.max, LIMITS.social.windowSec))) throw new HttpError(429, "too many sign-ins from this address, try later");
  const body = await readJson(req);
  if (typeof body.idToken !== "string" || body.idToken.length > 4000) throw new HttpError(400, "idToken required");
  const claims = await verifyIdToken(body.idToken, cfg);
  const secret = (env.NEAR_MERCHANT_SECRET ?? "").trim();
  if (!secret) throw new HttpError(503, "session keys not configured");
  const guestId = guestFromProof(body.guest as GuestLink, body.idToken, cfg);
  const r = await linkIdentity(cfg, req, identityOf(claims), secret, guestId, typeof body.choice === "string" ? body.choice : null);
  if (r.status === "conflict") return json(409, r);
  return json(200, { ...r, label: (claims.email ?? claims.name ?? "").slice(0, 80) });
}

/** The sign-in after the login token was verified (exported for the testnet link check, scripts/near/link-check.ts). */
export async function linkIdentity(cfg: Config, req: Request, identity: string, secret: string, guestId: string | null, choice: string | null): Promise<Record<string, unknown>> {
  const { provider, relayer } = account(cfg);
  const session = keyPairFromSeed(createHash("sha256").update(`vivolith-session:${identity}:${secret}`).digest());
  const accountId = `s${createHash("sha256").update(`vivolith-account:${identity}`).digest("hex").slice(0, 16)}.${cfg.relayerId}`;
  const signedIn = (extra: Record<string, unknown>): Record<string, unknown> => ({ status: "onchain", accountId, sessionKey: session.toString(), ...extra });
  const txs: string[] = [];
  const exists = await provider.viewAccount({ accountId, finality: "final" }).then(() => true, () => false);
  const registered = exists && (await view<boolean>(provider, cfg.contractId, "is_registered", { account_id: accountId }));
  const guest = guestId && guestId !== accountId && (await view<boolean>(provider, cfg.contractId, "is_registered", { account_id: guestId })) ? guestId : null;
  // One mutating link per guest at a time: two tabs or a double click can never move or burn twice (the contract's
  // transactions are atomic; this stops two of them racing on the same guest).
  const lockGuest = async (): Promise<void> => {
    if (!(await hit(cfg, `link:${guest}`, 1, 30))) throw new HttpError(409, "sign-in already in progress, try again in a moment");
  };

  if (!exists) {
    if (!(await hit(cfg, `guest:${clientIp(req)}`, LIMITS.guest.max, LIMITS.guest.windowSec))) throw new HttpError(429, "too many new players from this address, try later");
    const r = outcome(await relayer.signAndSendTransaction({
      receiverId: accountId,
      actions: [actions.createAccount(), actions.transfer(nearToYocto(GUEST_FUNDING)), actions.addFunctionCallAccessKey(session.getPublicKey(), cfg.contractId, [...PLAYER_METHODS])],
      throwOnFailure: false,
    }));
    if (!r.ok) return { status: "failed", message: r.error };
    txs.push(r.txHash);
  }

  if (!registered) {
    // First sign-in for this identity. With a guest: register + move the guest in + burn the new purse, atomically.
    const calls = [actions.functionCall("register_player", { account_id: accountId }, MAX_GAS, 0n)];
    if (guest) {
      await lockGuest();
      calls.push(actions.functionCall("migrate_player", { from: guest, to: accountId }, MAX_GAS, 0n));
      calls.push(actions.functionCall("operator_burn", { account_id: accountId, token_id: "coin", amount: String(STARTER), reason: "one starter purse per player: the guest's came along" }, MAX_GAS, 0n));
    }
    const r = outcome(await relayer.signAndSendTransaction({ receiverId: cfg.contractId, actions: calls, throwOnFailure: false }));
    if (!r.ok) return { status: "failed", message: r.error };
    txs.push(r.txHash);
    return signedIn({ merged: guest, linked: Boolean(guest), txHashes: txs });
  }

  // The identity already has an account.
  if (!guest) return signedIn({ merged: null, txHashes: txs });
  const g = await holdingsOf(provider, cfg, guest);
  if (Object.keys(g).length === 0) return signedIn({ merged: null, txHashes: txs }); // nothing left in it (moved before)
  if (untouched(g) || choice === "separate") return signedIn({ merged: null, keptGuest: guest, txHashes: txs });
  if (choice !== "merge") {
    // Never merge without the player's say: describe both sides and change nothing.
    return { status: "conflict", accountId, guest, existing: await holdingsOf(provider, cfg, accountId), guestHoldings: g };
  }
  if (!(await hit(cfg, `merge:${accountId}`, LIMITS.merge.max, LIMITS.merge.windowSec))) throw new HttpError(429, "this account has taken in enough guest games for now");
  await lockGuest();
  const calls = [actions.functionCall("migrate_player", { from: guest, to: accountId }, MAX_GAS, 0n)];
  const burn = Math.min(STARTER, g.coin ?? 0); // two accounts, one player: one starter purse
  if (burn > 0) calls.push(actions.functionCall("operator_burn", { account_id: accountId, token_id: "coin", amount: String(burn), reason: "one starter purse per player: merged a guest" }, MAX_GAS, 0n));
  const r = outcome(await relayer.signAndSendTransaction({ receiverId: cfg.contractId, actions: calls, throwOnFailure: false }));
  if (!r.ok) return { status: "failed", message: r.error };
  txs.push(r.txHash);
  return signedIn({ merged: guest, txHashes: txs });
}

// ---------- cloud save (story progress for signed-in players, readable on any device) ----------

const SAVE_MAX = 256 * 1024;
const SAVE_SKEW_MS = 10 * 60 * 1000;

/** The request is signed by a key that NEAR shows on `account` (its session or guest key, limited to our contract):
 *  only whoever holds that account's key can read or write its save. */
async function saveAuth(cfg: Config, b: Record<string, unknown>, data: string): Promise<string> {
  const accountId = String(b.account ?? ""), publicKey = String(b.publicKey ?? ""), ts = Number(b.ts), sig = String(b.signature ?? "");
  const suffix = `.${cfg.relayerId}`;
  if (!accountId.endsWith(suffix) || !/^[gs][0-9a-f]{16}$/.test(accountId.slice(0, -suffix.length))) throw new HttpError(400, "not a game account");
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > SAVE_SKEW_MS) throw new HttpError(401, "stale request");
  let pk: PublicKey;
  try { pk = PublicKey.fromString(publicKey); } catch { throw new HttpError(400, "invalid public key"); }
  const msg = `vivolith-save|${accountId}|${ts}|${createHash("sha256").update(data).digest("hex")}`;
  let ok = false;
  try { ok = pk.verify(new TextEncoder().encode(msg), Buffer.from(sig, "base64")); } catch { ok = false; }
  if (!ok) throw new HttpError(401, "bad signature");
  const { provider } = account(cfg);
  const key = await provider.viewAccessKey({ accountId, publicKey: pk, finality: "final" }).catch(() => null) as { permission?: unknown } | null;
  const perm = key?.permission as { FunctionCall?: { receiver_id?: string } } | string | undefined;
  if (!key || typeof perm !== "object" || perm?.FunctionCall?.receiver_id !== cfg.contractId) throw new HttpError(403, "key does not belong to this account");
  if (!(await hit(cfg, `save:${accountId}`, LIMITS.save.max, LIMITS.save.windowSec))) throw new HttpError(429, "slow down");
  return accountId;
}

async function cloudSave(cfg: Config, req: Request): Promise<Response> {
  const b = await readJson(req, SAVE_MAX + 2048);
  const data = typeof b.data === "string" ? b.data : "";
  if (!data || data.length > SAVE_MAX) throw new HttpError(400, "save missing or too large");
  const accountId = await saveAuth(cfg, b, data);
  await kv(cfg, ["SET", `vivolith:save:${accountId}`, JSON.stringify({ data, ts: Number(b.ts) })]);
  return json(200, { status: "saved" });
}

async function cloudLoad(cfg: Config, req: Request): Promise<Response> {
  const b = await readJson(req);
  const accountId = await saveAuth(cfg, b, "");
  const v = await kv(cfg, ["GET", `vivolith:save:${accountId}`]);
  return json(200, v ? { status: "found", ...(JSON.parse(v) as { data: string; ts: number }) } : { status: "none" });
}

// ---------- the merchants' autonomous turn ----------

/** Game hours of street trade one tick represents (ticks run at most once a minute, globally). */
const TICK_HOURS = 2;
const TICK_GAS = teraToGas("30");

interface StallRow { merchant: string; open: boolean; need: string; delivered: string; holders: number; supply: string; debt: string; last_settled: number | null; last_rent: number | null }

/** Rebuilds the four merchants from their on-chain balances and stall status so the shared rules in src/economy run
 *  on real state (a closed stall is closed for the planner, the pricing and the Guild alike). */
export async function chainEconomy(provider: JsonRpcProvider, cfg: Config): Promise<EconomyState> {
  const st = initialEconomy();
  st.flags.onchain = true;
  for (const s of await view<StallRow[]>(provider, cfg.contractId, "get_stalls", {})) {
    const id = s.merchant as MerchantId;
    if (!st.merchants[id]) continue;
    st.flags[`holders.${id}`] = s.holders;
    st.flags[`supply.${id}`] = Number(s.supply);
    st.flags[`debt.${id}`] = Number(s.debt);
    st.flags[`lastSettled.${id}`] = s.last_settled ?? -1;
    st.flags[`lastRent.${id}`] = s.last_rent ?? -1;
    if (!s.open) {
      st.merchants[id].status = "closed";
      st.flags[`reopenNeed.${id}`] = Math.max(0, Number(s.need) - Number(s.delivered));
    }
  }
  await Promise.all(MERCHANTS.map(async (id) => {
    const rows = await view<[string, string][]>(provider, cfg.contractId, "get_balances", { account_id: `${id}.${cfg.relayerId}` });
    const b = Object.fromEntries(rows.map(([t, v]) => [t, Number(v)]));
    const m = st.merchants[id];
    m.stock = { mango: b.mango ?? 0, lemon: b.lemon ?? 0, lassi: b.lassi ?? 0 };
    m.cash = b.coin ?? 0;
  }));
  return st;
}

const orderKey = (o: { merchant: string; token_id: string; side: string }): string => `${o.merchant}|${o.side}|${o.token_id}`;

type Call = ReturnType<typeof actions.functionCall>;
const coinMove = (from: string, to: string, amount: number, reason: string): Call[] => [
  actions.functionCall("operator_burn", { account_id: from, token_id: "coin", amount: String(amount), reason }, TICK_GAS, 0n),
  actions.functionCall("operator_mint", { account_id: to, token_id: "coin", amount: String(amount), reason }, TICK_GAS, 0n),
];

/** The Guild's calls for this turn, each at most once per market day per stall: a loan to a low till (the contract
 *  lends only what the fund holds and records the debt), or collection from a healthy till (loan repayment first, then
 *  dues while the fund is below its size). Adjusts `st` cash so this turn's bids already reflect them. */
async function guildTurn(cfg: Config, provider: JsonRpcProvider, st: EconomyState, day: number, log: string[]): Promise<Call[]> {
  const guild = await view<string>(provider, cfg.contractId, "get_guild", {});
  const rows = await view<[string, string][]>(provider, cfg.contractId, "get_balances", { account_id: guild });
  const fund = Number(rows.find(([t]) => t === "coin")?.[1] ?? 0);
  // the rules live in src/economy/recovery.ts (the market model simulates the same ones): loans up to DEBT_CAP, capped
  // repayment from any till above rent + reserve, dues that may rebuild a fund emptied by loans to closed stalls
  const debt = Object.fromEntries(MERCHANTS.map((id) => [id, Number(st.flags[`debt.${id}`] ?? 0)]));
  // A closed stall can only reopen if it can pay for the mangoes brought to it: the Guild covers that gap if it can.
  const rescueOf = (id: MerchantId): number => st.merchants[id].status === "open" ? 0 : Number(st.flags[`reopenNeed.${id}`] ?? 0) * (bidFor(st, id, "mango")?.price ?? 0);
  const fillTo = guildFillTo(st, MERCHANTS, debt);
  const calls: Call[] = [];
  for (const g of guildPlan(st, MERCHANTS, fund, debt, rescueOf, () => true)) {
    const m = st.merchants[g.merchant];
    if (g.kind === "lend") {
      // Loans may come every merchant turn (ticks run at most once a minute): a till that fell short mid-day can pay
      // the next delivery within a minute, not the next market day.
      calls.push(actions.functionCall("guild_lend", { merchant: g.merchant, amount: String(g.amount) }, TICK_GAS, 0n));
      m.cash += g.amount;
      log.push(`market guild lent ${g.merchant} ${g.amount} c (${g.merchant} owes ${debt[g.merchant] + g.amount} c)`);
    } else {
      if (!(await hit(cfg, `guild:${g.merchant}:${day}`, 1, Math.ceil(MARKET_DAY_MS / 1000)))) continue; // once a market day
      calls.push(actions.functionCall("guild_collect", { merchant: g.merchant, amount: String(g.amount), fill_to: String(fillTo) }, TICK_GAS, 0n));
      m.cash -= g.amount;
      log.push(`${g.merchant} ${g.repaid ? `repaid the market guild ${g.repaid} c` : ""}${g.repaid && g.dues ? " and " : ""}${g.dues ? `paid ${g.dues} c guild dues` : ""}`);
    }
  }
  return calls;
}

/** One merchant turn on NEAR: each merchant reprices its own asks and bids from pricing.ts (signed with its own
 *  key), merchants fill each other's bids, and the operator records street shoppers, Tomas's harbor contract and
 *  Arin's kitchen. Idempotent enough to call often: throttled to one turn per minute across all players. */
/** One market turn at a time, everywhere. An atomic lock (Redis SET NX EX) is claimed by the turn that starts and held
 *  for TICK_GAP_SEC: unlike the old fixed one-minute window it cannot let two turns through either side of a window
 *  boundary, and it outlasts the function's 60 s limit (vercel.json), so a slow turn can never overlap the next one.
 *  Rent and settlement are also once per market day in the contract itself. */
const TICK_GAP_SEC = 75;
const TICK_LOCK = "vivolith:tick:lock";
const LAST_TICK = "vivolith:tick:last";
let tickHeldUntil = 0; // memory fallback: one process (local dev)
export async function claimTick(cfg: Config): Promise<boolean> {
  if (cfg.redisUrl && cfg.redisToken) {
    const r = await fetch(cfg.redisUrl, {
      method: "POST",
      headers: { authorization: `Bearer ${cfg.redisToken}`, "content-type": "application/json" },
      body: JSON.stringify(["SET", TICK_LOCK, String(Date.now()), "NX", "EX", String(TICK_GAP_SEC)]),
    });
    if (!r.ok) throw new HttpError(503, "market clock unavailable");
    return ((await r.json()) as { result: string | null }).result === "OK";
  }
  const now = Date.now();
  if (now < tickHeldUntil) return false;
  tickHeldUntil = now + TICK_GAP_SEC * 1000;
  return true;
}

/** True the first time `key` is claimed (Redis SET NX, else this process's memory): a once-per-day guard that,
 *  unlike a fixed window, cannot pass twice when a day straddles a window boundary. */
const onceMemory = new Set<string>();
async function claimOnce(cfg: Config, key: string, ttlSec: number): Promise<boolean> {
  if (cfg.redisUrl && cfg.redisToken) {
    const r = await fetch(cfg.redisUrl, { method: "POST", headers: { authorization: `Bearer ${cfg.redisToken}`, "content-type": "application/json" }, body: JSON.stringify(["SET", `vivolith:once:${key}`, "1", "NX", "EX", String(ttlSec)]) });
    if (!r.ok) throw new HttpError(503, "market clock unavailable");
    return ((await r.json()) as { result: string | null }).result === "OK";
  }
  if (onceMemory.has(key)) return false;
  onceMemory.add(key);
  return true;
}

/** Gives back a claimOnce key. Only for an attempt NEAR definitely refused (nothing happened), so a retry is allowed. */
async function releaseOnce(cfg: Config, key: string): Promise<void> {
  if (cfg.redisUrl && cfg.redisToken) {
    await fetch(cfg.redisUrl, { method: "POST", headers: { authorization: `Bearer ${cfg.redisToken}`, "content-type": "application/json" }, body: JSON.stringify(["DEL", `vivolith:once:${key}`]) }).catch(() => null);
    return;
  }
  onceMemory.delete(key);
}

/** Residents' day (see src/economy/residents.ts). Returns what they ate per `merchant:good`, so tourists buy less. */
/** How an agent may decide on this turn: replay only (browser-driven), with a paid-call budget, and with its memory. */
interface AgentTurn {
  readonly replayOnly?: boolean; readonly budget?: () => Promise<boolean>; readonly memory?: Readonly<Record<string, readonly MemoryRow[]>>;
  /** The Chronicle before this turn, and where this turn's events are collected (written once at the end). */
  readonly history?: readonly ChronicleEvent[]; readonly events?: ChronicleEvent[];
}


export async function residentTurn(cfg: Config, provider: JsonRpcProvider, relayer: Account, secret: string, day: number, log: string[], txs: string[], agentCfg: AgentConfig, agentStore: DecisionStore, mint = true, turn: AgentTurn = {}): Promise<Record<string, number>> {
  const ate: Record<string, number> = {};
  for (const r of RESIDENTS) {
    const accountId = `${r.id}.${cfg.relayerId}`;
    if (!(await view<boolean>(provider, cfg.contractId, "is_registered", { account_id: accountId }).catch(() => false))) continue; // not created yet (resident-check.ts --run)
    if (!(await claimOnce(cfg, `resident:${r.id}:${day}`, Math.ceil(MARKET_DAY_MS / 1000) * 2))) continue;
    const me = new Account(accountId, provider, new KeyPairSigner(residentKey(r.id, secret)));
    const call = async (who: Account, method: string, args: Record<string, unknown>): Promise<TxResult> => {
      const res = outcome(await who.signAndSendTransaction({ receiverId: cfg.contractId, actions: [actions.functionCall(method, args, TICK_GAS, 0n)], throwOnFailure: false }));
      txs.push(res.txHash);
      return res;
    };
    if (mint) { // the day's piece work (a live test that proves the loop from existing stock passes mint = false)
      const work = await call(relayer, "operator_mint", { account_id: accountId, token_id: r.good, amount: String(r.perDay), reason: r.reason });
      if (!work.ok) { log.push(`${r.id} work FAILED: ${work.error}`); continue; }
    }
    const held = Object.fromEntries((await view<[string, string][]>(provider, cfg.contractId, "get_balances", { account_id: accountId })).map(([t, v]) => [t, Number(v)]));
    const stalls = (await chainEconomy(provider, cfg)).merchants;
    const book = executableOffers(await view<Offer[]>(provider, cfg.contractId, "get_offers", {}), stalls); // closed stalls and unfillable orders are never offered
    // NEAR AI picks where this resident sells and eats (agent.ts), only among orders that exist; else exactly the rule's plan
    const dec = await decideResident({ store: agentStore, cfg: agentCfg, res: r, offers: book, coin: held.coin ?? 0, holding: held[r.good] ?? 0, day, fetchImpl: fetch as never, replayOnly: turn.replayOnly, budget: turn.budget, memory: turn.memory?.[r.id] });
    if (dec.skip) { log.push(`resident ${r.id} decision is held by another tick`); continue; }
    const plan = dec.plan;
    if (dec.decision) log.push(`resident ${r.id} ${dec.decision.source === "ai" ? "NEAR AI" : "rule"} plan: ${dec.decision.action}${dec.decision.fallbackReason ? ` (${dec.decision.fallbackReason})` : ""}`);
    let carried: string | null = null; // the transaction that carried the decision out
    // what the resident chose between (the posted orders it saw), for the Chronicle; the choice is the model's or the rule's
    const seenBids = book.filter((o) => o.side === "bid" && o.token_id === r.good && Number(o.qty) > 0).map((o) => `${stalls[o.merchant as MerchantId]?.name ?? o.merchant} bid ${o.price} c`);
    const resDecision = (action: string): ChronicleEvent["decision"] => ({ source: dec.decision?.source === "ai" ? "ai" : "rule", action, from: null, to: null, model: dec.decision?.source === "ai" ? dec.decision.model : null, decisionId: dec.decision?.receipt.id ?? null, verification: dec.decision?.receipt.status ?? "none", inputs: [`${held[r.good] ?? 0} ${r.good}s and ${held.coin ?? 0} c in hand`, ...seenBids] });
    const resEvent = (kind: "sell" | "meal", text: string, changes: ChronicleEvent["changes"], tx: TxResult, mer: string): void => {
      const at = Date.now();
      turn.events?.push({ id: eventId(at, `res-${kind}`), at, day, kind: "resident", actors: [r.id, mer], player: null, text, changes, status: tx.ok ? "confirmed" : "failed", txHash: tx.txHash || null, decision: resDecision(kind === "sell" ? `sell to ${mer}` : `meal from ${mer}`), since: turn.history ? changedSince(turn.history, r.id, lastDecisionAt(turn.history, r.id, at), at) : [] });
    };
    if (plan.sell) {
      const s = await call(me, "sell", { buyer: plan.sell.buyer, token_id: r.good, qty: String(plan.sell.qty), min_price: String(plan.sell.price) });
      log.push(`resident ${r.id} sold ${plan.sell.qty} ${r.good} to ${plan.sell.merchant} at ${plan.sell.price} c${s.ok ? "" : ` FAILED: ${s.error}`}`);
      const total = plan.sell.qty * plan.sell.price, mer = plan.sell.merchant;
      resEvent("sell", `${r.name} sold ${plan.sell.qty} ${r.good}${plan.sell.qty > 1 ? "s" : ""} to ${stalls[mer as MerchantId]?.name ?? mer} at ${plan.sell.price} c.`, [{ who: r.id, good: r.good, delta: -plan.sell.qty }, { who: r.id, good: "coin", delta: total }, { who: mer, good: r.good, delta: plan.sell.qty }, { who: mer, good: "coin", delta: -total }], s, mer);
      if (!s.ok) continue;
      carried = s.txHash;
    }
    if (plan.eat) {
      const b = await call(me, "buy", { seller: plan.eat.seller, token_id: r.food, qty: "1", max_price: String(plan.eat.price) });
      const mer = plan.eat.merchant;
      resEvent("meal", `${r.name} bought a ${r.food} from ${stalls[mer as MerchantId]?.name ?? mer} for ${plan.eat.price} c.`, [{ who: r.id, good: "coin", delta: -plan.eat.price }, { who: mer, good: "coin", delta: plan.eat.price }, { who: mer, good: r.food, delta: -1 }], b, mer);
      if (b.ok) {
        carried ??= b.txHash;
        const e = await call(relayer, "operator_burn", { account_id: accountId, token_id: r.food, amount: "1", reason: "eaten" });
        ate[`${plan.eat.merchant}:${r.food}`] = (ate[`${plan.eat.merchant}:${r.food}`] ?? 0) + 1;
        log.push(`resident ${r.id} bought 1 ${r.food} from ${plan.eat.merchant} at ${plan.eat.price} c and ate it${e.ok ? "" : ` (eat FAILED: ${e.error})`}`);
      } else log.push(`resident ${r.id} buy ${r.food} FAILED: ${b.error}`);
    } else if (plan.hungry !== null) log.push(`resident ${r.id} could not afford ${r.food} at ${plan.hungry} c`);
    if (dec.decision && carried) await attachTx(agentStore, r.id, day, carried).catch(() => undefined);
  }
  return ate;
}

/** One market turn. `trusted` = called by the scheduler route with its secret: only such turns may ask NEAR AI (and
 *  only within the daily budget); browser-driven turns replay a decision already made today, else use the rule. With
 *  NEAR_MARKET_DRIVER=scheduler, browser requests do not move the market at all. */
/** `scope: "agents"` (scheduler only): a controlled turn that sends nothing but the enabled agents' own lever orders,
 *  and only when a decision exists; no settlement, rent, Guild, other orders, merchant trades, residents or operator. */
async function tick(cfg: Config, env: RelayEnv, trusted = false, scope: "market" | "agents" = "market"): Promise<Response> {
  const full = scope === "market";
  const ops = opsConfig(env);
  if (ops.driver === "scheduler" && !trusted) return json(200, { status: "scheduled", message: "market turns run on the city's own schedule" });
  if (!(await claimTick(cfg))) return json(200, { status: "skipped", message: "the merchants moved less than a minute ago" });
  // bounded playtest (NEAR_TEST_TURNS): checked before any chain read or signature, for browser and scheduler turns alike
  const cap = await takeTestTurn(ops, decisionStore(cfg));
  if (!cap.ok) return json(200, { status: "capped", message: "the playtest's market turns are used up", run: ops.testRun, limit: ops.testTurns, used: cap.used });
  const secret = (env.NEAR_MERCHANT_SECRET ?? "").trim();
  if (!secret) throw new HttpError(503, "merchant keys not configured");
  const { provider, relayer } = account(cfg);
  // ponytail: block, balances and stalls are three "final" reads moments apart; a trade landing between them can be
  // counted in both the opening balance and the day's receipts. Read at one block_id if exact accounting matters.
  const block = Number((await provider.viewBlock({ finality: "final" })).header.height);
  const st = await chainEconomy(provider, cfg);
  const posted = new Map((await view<OfferRow[]>(provider, cfg.contractId, "get_offers", {})).map((o) => [orderKey(o), o]));
  const agentStore = decisionStore(cfg);
  // no automatic retry inside a market turn: every paid request is one decision counted by the budget (a failed one
  // falls back to the rule price)
  const baseCfg: AgentConfig = { ...agentConfig(env), retries: 0 };
  const halted = await agentsHalted(ops, agentStore);
  const agentCfg: AgentConfig = halted ? { ...baseCfg, enabled: new Set() } : baseCfg; // kill switch: every price is the rule's
  const memory = agentCfg.enabled.size ? await memoriesFor(agentStore) : {};
  // the Chronicle so far (for each decision: which recorded events changed the decider since its last decision)
  const history = await readChronicle(agentStore).catch(() => []);
  const events: ChronicleEvent[] = [];
  const turn: AgentTurn = { replayOnly: !trusted, budget: () => spend(ops, agentStore, "decision"), memory, history, events };
  // each agent's opening position for its economic memory, read before this turn changes anything
  const snaps = new Map<string, Snapshot>();
  const day = Math.floor(Date.now() / MARKET_DAY_MS);
  for (const id of MERCHANTS) { const m = st.merchants[id]; snaps.set(id, { day, block, coin: m.cash, goods: { ...m.stock }, open: m.status === "open" }); }
  for (const r of RESIDENTS) {
    const rows = await view<[string, string][]>(provider, cfg.contractId, "get_balances", { account_id: `${r.id}.${cfg.relayerId}` }).catch(() => null);
    if (!rows) continue;
    const b = Object.fromEntries(rows.map(([t, v]) => [t, Number(v)]));
    snaps.set(r.id, { day, block, coin: b.coin ?? 0, goods: { mango: b.mango ?? 0, lemon: b.lemon ?? 0, lassi: b.lassi ?? 0 }, open: true });
  }
  const signerOf = (id: MerchantId): Account => new Account(`${id}.${cfg.relayerId}`, provider, new KeyPairSigner(merchantKey(id, secret)));
  const log: string[] = [];
  const txs: string[] = [];

  // 0. The Market Guild (contract methods guild_lend / guild_collect): coin only moves between the fund and the
  // stalls, every loan is recorded as debt, and repayment comes before dues. It never creates money after its seed.
  // Yesterday's dividends, once (settle_day is idempotent too). Its own transaction: 60 Tgas per stall.
  // The chain says which days already ran (rate-limit memory resets on a cold start; the contract's record does not).
  const unsettled = MERCHANTS.some((id) => Number(st.flags[`lastSettled.${id}`]) < day - 1);
  if (full && unsettled && (await hit(cfg, `settled:${day - 1}`, 1, Math.ceil(MARKET_DAY_MS / 1000) * 2))) {
    const r = outcome(await relayer.signAndSendTransaction({ receiverId: cfg.contractId, actions: MERCHANTS.map((merchant) => actions.functionCall("settle_day", { day: day - 1, merchant }, teraToGas("60"), 0n)), throwOnFailure: false }));
    txs.push(r.txHash);
    log.push(`dividends for market day ${day - 1} settled${r.ok ? "" : ` FAILED: ${r.error}`}`);
  }
  // Rent, on chain: due every `rentEveryDays` market days; a stall that cannot pay closes until deliveries of
  // `closingNeed` mangoes reopen it. Idempotent per stall and day in the contract.
  // Reopenings (contract deliveries reopen a stall silently): a stall last seen closed and open now reopened today. The
  // day is kept for the one-time rent grace (src/economy/recovery.ts) and told in the Chronicle.
  const reopenedDay: Record<string, number | null> = {};
  if (full) for (const id of MERCHANTS) {
    const open = st.merchants[id].status === "open";
    const was = await kv(cfg, ["GET", `vivolith:stall:${id}`]).catch(() => null);
    if (was === "closed" && open) {
      await kv(cfg, ["SET", `vivolith:reopened:${id}`, String(day)]).catch(() => null);
      const at = Date.now();
      events.push({ id: `reopened-${id}-${day}`, at, day, kind: "reopened", actors: [id], player: null, text: `${st.merchants[id].name}'s stall is open again: enough mangoes were delivered.`, changes: [], status: "confirmed", txHash: null, decision: null, since: [] });
    }
    if (was !== (open ? "open" : "closed")) await kv(cfg, ["SET", `vivolith:stall:${id}`, open ? "open" : "closed"]).catch(() => null);
    const r = await kv(cfg, ["GET", `vivolith:reopened:${id}`]).catch(() => null);
    reopenedDay[id] = r !== null && Number.isFinite(Number(r)) ? Number(r) : null;
  }
  const rentCalls: Call[] = [], rentEvents: ChronicleEvent[] = [];
  for (const id of MERCHANTS) {
    const m = st.merchants[id];
    if (!full || m.status !== "open" || day % m.rentEveryDays !== 0 || Number(st.flags[`lastRent.${id}`]) >= day) continue;
    if (!(await hit(cfg, `rent:${id}:${day}`, 1, Math.ceil(MARKET_DAY_MS / 1000) * 2))) continue;
    const need = closingNeed(st, id);
    // one rent waived per reopening, only for a stall that reopened within GRACE_DAYS and cannot pay (once-guarded)
    const rd = reopenedDay[id] ?? null;
    const eligible = rd !== null && day - rd >= 0 && day - rd <= GRACE_DAYS && m.cash < m.rent;
    const unused = eligible ? await claimOnce(cfg, `grace:${id}:${rd}`, 3 * Math.ceil(MARKET_DAY_MS / 1000) * (GRACE_DAYS + 1)) : false;
    const charge = rentToCharge(m, day, rd, () => unused);
    rentCalls.push(actions.functionCall("charge_rent", { day, merchant: id, rent: String(charge.rent), reopen_need: String(need) }, TICK_GAS, 0n));
    const at = Date.now(), name = st.merchants[id].name;
    if (charge.grace) {
      rentEvents.push({ id: eventId(at, "rent"), at, day, kind: "rent", actors: [id], player: null, text: `${name}'s rent was waived once: the stall reopened ${day - rd!} market day${day - rd! === 1 ? "" : "s"} ago and has ${Math.floor(m.cash)} c (recovery grace, once per reopening).`, changes: [], status: "pending", txHash: null, decision: null, since: [] });
      log.push(`${id} rent waived once (recovery grace)`);
    } else if (m.cash >= m.rent) {
      rentEvents.push({ id: eventId(at, "rent"), at, day, kind: "rent", actors: [id], player: null, text: `${name} paid ${m.rent} c rent.`, changes: [{ who: id, good: "coin", delta: -m.rent }], status: "pending", txHash: null, decision: null, since: [] });
      m.cash -= m.rent; log.push(`${id} paid ${m.rent} c rent`);
    } else {
      rentEvents.push({ id: eventId(at, "closed"), at, day, kind: "closed", actors: [id], player: null, text: `${name} could not pay ${m.rent} c rent with ${Math.floor(m.cash)} c in the till and closed; it reopens after ${Math.max(1, need)} mangoes are delivered.`, changes: [], status: "pending", txHash: null, decision: null, since: [] });
      m.status = "closed"; st.flags[`reopenNeed.${id}`] = Math.max(1, need); log.push(`${id} could not pay ${m.rent} c rent and closed (reopens after ${Math.max(1, need)} mangoes)`);
    }
  }
  if (rentCalls.length) {
    const r = outcome(await relayer.signAndSendTransaction({ receiverId: cfg.contractId, actions: rentCalls, throwOnFailure: false }));
    txs.push(r.txHash);
    events.push(...rentEvents.map((e) => ({ ...e, status: r.ok ? "confirmed" as const : "failed" as const, txHash: r.txHash || null })));
    if (!r.ok) { log.push(`rent FAILED: ${r.error}`); st.merchants = (await chainEconomy(provider, cfg)).merchants; }
  }
  const guildCalls = full ? await guildTurn(cfg, provider, st, day, log) : [];
  if (guildCalls.length) {
    // its own transaction, first: bids below use the new tills, and a refused Guild move touches nothing else
    const r = outcome(await relayer.signAndSendTransaction({ receiverId: cfg.contractId, actions: guildCalls, throwOnFailure: false }));
    txs.push(r.txHash);
    if (!r.ok) { log.push(`guild FAILED: ${r.error}`); st.merchants = (await chainEconomy(provider, cfg)).merchants; }
  }

  // 1. Every merchant reprices (only orders that changed are sent).
  const repriced = await Promise.all(MERCHANTS.map(async (id) => {
    if (!full && !(LEVERS[id] && agentCfg.enabled.has(id))) return []; // agents scope: other merchants are untouched
    const m = st.merchants[id];
    const calls: ReturnType<typeof actions.functionCall>[] = [];
    const want = (side: "ask" | "bid", token: string, qty: number, price: number): void => {
      const cur = posted.get(`${id}|${side}|${token}`);
      if (qty <= 0) { if (cur) calls.push(actions.functionCall(side === "ask" ? "list" : "bid", { token_id: token, qty: "0", price: "1" }, TICK_GAS, 0n)); return; }
      if (cur && Number(cur.qty) === qty && Number(cur.price) === price) return;
      calls.push(actions.functionCall(side === "ask" ? "list" : "bid", { token_id: token, qty: String(qty), price: String(price) }, TICK_GAS, 0n));
    };
    // One NEAR AI decision per merchant per market day on its one price lever (agent.ts); off, or any failure, leaves the
    // rule price. The lever's order is the only one the model can change: its price, inside a band the economy sets.
    const lever = LEVERS[id];
    let agent: Decision | null = null, skipLever = false, leverPrice: number | null = null;
    if (lever && agentCfg.enabled.has(id)) {
      const out = await decideBid({ store: agentStore, cfg: agentCfg, st, id, offers: [...posted.values()], day, fetchImpl: fetch as never, replayOnly: turn.replayOnly, budget: turn.budget, memory: memory[id] });
      agent = out.decision;
      skipLever = out.skipBid; // another tick holds this day's decision and posts its order
      if (agent) leverPrice = out.price;
      if (agent) log.push(`${id} ${agent.source === "ai" ? "NEAR AI" : "rule"} decision: ${agent.action} ${lever.good} ${lever.side} ${agent.basePrice} -> ${agent.price} c${agent.fallbackReason ? ` (${agent.fallbackReason})` : ""}`);
    }
    const isLever = (side: "ask" | "bid", good: string): boolean => lever !== undefined && lever.side === side && lever.good === good;
    // agents scope: only the lever's own order, and only when a decision prices it
    const skip = (side: "ask" | "bid", good: string): boolean => !full && (!isLever(side, good) || agent === null);
    // a closed stall sells nothing until it reopens (the contract refuses those sales anyway)
    for (const good of m.sells) {
      if (skip("ask", good)) continue;
      if (skipLever && isLever("ask", good)) continue; // a concurrent tick owns this merchant's order today
      want("ask", good, m.status === "open" ? m.stock[good] : 0, isLever("ask", good) && leverPrice !== null ? leverPrice : quote(st, id, good, false).price);
    }
    // Shares need no orders: their terms are fixed in the contract, which issues and buys back on demand.
    for (const good of ["mango", "lemon"] as const) {
      const b = bidFor(st, id, good);
      const price = isLever("bid", good) && leverPrice !== null ? leverPrice : b?.price ?? 1;
      if (skipLever && isLever("bid", good)) continue;
      if (skip("bid", good)) continue;
      want("bid", good, b ? Math.min(b.qty, Math.floor(m.cash / Math.max(1, price))) : 0, price);
    }
    // Function-call keys allow one action per transaction: one tx per order, in sequence for this merchant.
    const hashes: string[] = [];
    let leverTx: { hash: string; ok: boolean; price: number; was: number | null } | null = null;
    for (const call of calls) {
      // the agent-priced mango bid is sent by exactly one tick per market day (Redis claim); a failure releases it for a retry
      const isAgentCall = (c: typeof call): boolean => agent !== null && lever !== undefined && c.functionCall?.methodName === (lever.side === "ask" ? "list" : "bid") && (JSON.parse(new TextDecoder().decode(c.functionCall.args)) as { token_id: string }).token_id === lever.good;
      const agentBid = isAgentCall(call);
      if (agentBid && !(await claimBidSend(agentStore, id, day).catch(() => true))) { hashes.push(""); log.push(`${id} ${lever!.good} ${lever!.side} already sent for market day ${day}`); continue; }
      const r = outcome(await signerOf(id).signAndSendTransaction({ receiverId: cfg.contractId, actions: [call], throwOnFailure: false }));
      if (agentBid && !r.ok) await releaseBidSend(agentStore, id, day).catch(() => undefined);
      hashes.push(r.txHash);
      const fc = call.functionCall!;
      const a = JSON.parse(new TextDecoder().decode(fc.args)) as { token_id: string; qty: string; price: string; per?: string };
      log.push(`${id} ${fc.methodName === "list" ? "asks" : "bids"} ${a.qty === "0" ? "withdrawn for" : `${a.qty} x ${a.price} c${a.per ? ` per ${a.per}` : ""} for`} ${a.token_id}${r.ok ? "" : ` FAILED: ${r.error}`}`);
      if (lever && fc.methodName === (lever.side === "ask" ? "list" : "bid") && a.token_id === lever.good && a.qty !== "0") {
        const cur = posted.get(`${id}|${lever.side}|${lever.good}`);
        leverTx = { hash: r.txHash, ok: r.ok, price: Number(a.price), was: cur && Number(cur.qty) > 0 ? Number(cur.price) : null };
      }
    }
    if (agent) { // keep the hash of the transaction that carried the decision (none when the bid was already posted)
      const at = calls.findIndex((c) => lever !== undefined && c.functionCall?.methodName === (lever.side === "ask" ? "list" : "bid") && (JSON.parse(new TextDecoder().decode(c.functionCall.args)) as { token_id: string }).token_id === lever.good);
      if (at >= 0 && hashes[at]) await attachTx(agentStore, id, day, hashes[at]).catch(() => undefined); // a repeat tick posts nothing: the first hash stays
    }
    // The Chronicle: an agent's decision (AI or its rule fallback), or a rule price change on the lever with no agent
    if (lever && turn.events) {
      const tx = leverTx as { hash: string; ok: boolean; price: number; was: number | null } | null;
      if (agent) {
        turn.events.push(decisionEvent(id, m.name, turn.history ?? [], { source: agent.source === "ai" ? "ai" : "rule", action: agent.action, from: agent.basePrice, to: agent.price, side: lever.side, good: lever.good, model: agent.model, decisionId: agent.receipt.id, verification: agent.receipt.status, inputs: agent.justification.slice(0, -1) }, tx ? { hash: tx.hash, ok: tx.ok } : null, day));
      } else if (tx && tx.was !== null && tx.was !== tx.price) {
        const reason = lever.side === "bid" ? bidFor(st, id, lever.good)?.reason ?? "rule" : "rule";
        turn.events.push(decisionEvent(id, m.name, turn.history ?? [], { source: "rule", action: tx.price > tx.was ? "raise" : "lower", from: tx.was, to: tx.price, side: lever.side, good: lever.good, model: null, decisionId: null, verification: "none", inputs: [`${m.stock[lever.good]} ${lever.good}s on the shelf`, `${Math.floor(m.cash)} c in the till`, reason] }, { hash: tx.hash, ok: tx.ok }, day));
      }
    }
    return hashes;
  }));
  txs.push(...repriced.flat());

  // 2. Merchants fill each other's bids at the asks they just posted.
  for (const t of full ? planMerchantTrades(st) : []) {
    const r = outcome(await signerOf(t.buyer).signAndSendTransaction({
      receiverId: cfg.contractId,
      actions: [actions.functionCall("buy", { seller: `${t.seller}.${cfg.relayerId}`, token_id: t.good, qty: String(t.qty), max_price: String(t.price) }, TICK_GAS, 0n)],
      throwOnFailure: false,
    }));
    txs.push(r.txHash);
    log.push(`${t.buyer} bought ${t.qty} ${t.good} from ${t.seller} at ${t.price} c (${t.reason})${r.ok ? "" : ` FAILED: ${r.error}`}`);
  }

  // 2b. Residents (WP6): once a market day each, a day's piece work is sold into the best bid and one meal is bought
  // from what they hold; the meal is eaten (burned). Same keys and contract calls WP0 proved on testnet.
  const ate = full ? await residentTurn(cfg, provider, relayer, secret, day, log, txs, agentCfg, agentStore, true, turn) : {};

  // 3. Operator: tourists (street shoppers), the harbor contract, the tea kitchen.
  const op: ReturnType<typeof actions.functionCall>[] = [];
  for (const id of full ? MERCHANTS : []) {
    const m = st.merchants[id];
    if (m.status !== "open") continue; // shutters down: no shoppers
    for (const good of m.sells) {
      // residents now buy part of the lassi the street used to: tourists take only the rest. The fraction of a shopper
      // carries to the next turn (before, floor() per turn dropped every fruit sale: src/economy/recovery.ts)
      const key = `vivolith:carry:${id}:${good}`;
      const carried = Number(await kv(cfg, ["GET", key]).catch(() => null) ?? 0);
      const sold = touristUnits(shopperWant(st, id, good) * TICK_HOURS - (ate[`${id}:${good}`] ?? 0), Number.isFinite(carried) ? carried : 0, m.stock[good]);
      await kv(cfg, ["SET", key, String(sold.carry)]).catch(() => null);
      const units = sold.units;
      if (units > 0) op.push(actions.functionCall("street_sale", { merchant: id, token_id: good, qty: String(units), unit_price: String(quote(st, id, good, false).price) }, TICK_GAS, 0n));
      if (units > 0) log.push(`tourists bought ${units} ${good} from ${id}`);
    }
  }
  // The harbor's standing contract: once a market day when Tomas runs below his normal stock, and on any turn he is
  // nearly out (so no new player finds the market without mangoes for long). He pays HARBOR_COST a mango; the coin
  // leaves the economy as freight, as in the offline sim.
  const tomas = st.merchants.tomas;
  const nearlyOut = tomas.stock.mango < 6;
  const harborDue = full && tomas.status === "open" && (nearlyOut || tomas.stock.mango < tomas.target.mango)
    && (nearlyOut || (await hit(cfg, `harbor:${day}`, 1, Math.ceil(MARKET_DAY_MS / 1000))));
  const harborQty = harborDue ? Math.min(Math.round(tomas.target.mango * 1.4) - tomas.stock.mango, Math.floor(tomas.cash / HARBOR_COST)) : 0;
  if (harborQty > 0) {
    op.push(actions.functionCall("operator_burn", { account_id: `tomas.${cfg.relayerId}`, token_id: "coin", amount: String(harborQty * HARBOR_COST), reason: "harbor freight" }, TICK_GAS, 0n));
    op.push(actions.functionCall("operator_mint", { account_id: `tomas.${cfg.relayerId}`, token_id: "mango", amount: String(harborQty), reason: "harbor standing contract" }, TICK_GAS, 0n));
    log.push(`harbor delivered ${harborQty} mangoes to tomas for ${harborQty * HARBOR_COST} c`);
  }
  const arin = st.merchants.arin;
  const batches = !full ? 0 : Math.min(arin.stock.mango, Math.max(0, Math.ceil((8 - arin.stock.lassi) / 4)));
  if (batches > 0) {
    op.push(actions.functionCall("operator_burn", { account_id: `arin.${cfg.relayerId}`, token_id: "mango", amount: String(batches), reason: "tea kitchen" }, TICK_GAS, 0n));
    op.push(actions.functionCall("operator_mint", { account_id: `arin.${cfg.relayerId}`, token_id: "lassi", amount: String(batches * 4), reason: "tea kitchen" }, TICK_GAS, 0n));
    log.push(`arin's kitchen made ${batches * 4} lassi from ${batches} mangoes`);
  }
  if (op.length) {
    const r = outcome(await relayer.signAndSendTransaction({ receiverId: cfg.contractId, actions: op, throwOnFailure: false }));
    txs.push(r.txHash);
    if (!r.ok) log.push(`operator FAILED: ${r.error}`);
  }

  // 4. The Chronicle (this turn's recorded events, one write), agents' memory (read from chain, written by every driver)
  // and signature checks of NEAR AI decisions (scheduler turns only: they call NEAR AI, within their own daily budget).
  // None of these can change a balance.
  if (!(await chronicle(agentStore, events).catch(() => false))) log.push("chronicle not written (store busy or down)");
  const receiptsOf = (id: string): Promise<ChainReceipt[]> => view<ChainReceipt[]>(provider, cfg.contractId, "get_receipts", { account_id: `${id}.${cfg.relayerId}` });
  await recordMemories(agentStore, day, snaps, receiptsOf, log);
  if (trusted && !halted && baseCfg.key) {
    await verifyPass(agentStore, day, (decisionId, ev) => verifyDecision(baseCfg.url, baseCfg.key!, decisionId, ev, fetch as never), () => spend(ops, agentStore, "verify"), log);
  }

  // The proof screen shows when the city last moved (scheduled turns keep it moving with nobody playing).
  const last = { at: Date.now(), day, txs: txs.length, failed: log.filter((l) => /FAILED/.test(l)).length, by: trusted ? "scheduler" : "players" };
  await kv(cfg, ["SET", LAST_TICK, JSON.stringify(last)]).catch(() => null);
  return json(200, { status: "onchain", txHashes: txs, log, driver: trusted ? "scheduler" : "players", agents: { halted, enabled: [...agentCfg.enabled], replayOnly: !trusted } });
}

/** The Mango Orchard: ORCHARD_PICK mangoes to a registered player, once per account per market day (atomic day
 *  key), minted as goods with the reason "orchard picking". Also capped per IP so new guests can't farm it. */
async function pick(cfg: Config, req: Request): Promise<Response> {
  const b = await readJson(req);
  const player = String(b.account ?? "");
  if (!/^[a-z0-9._-]{2,64}$/.test(player) || !player.endsWith(`.${cfg.relayerId}`)) throw new HttpError(400, "bad account id");
  if (!(await hit(cfg, `pick:${clientIp(req)}`, LIMITS.pick.max, LIMITS.pick.windowSec))) throw new HttpError(429, "slow down");
  const { provider, relayer } = account(cfg);
  if (!(await view<boolean>(provider, cfg.contractId, "is_registered", { account_id: player }))) throw new HttpError(400, "unregistered account");
  const day = Math.floor(Date.now() / MARKET_DAY_MS);
  const key = `pick:${player}:${day}`;
  if (!(await claimOnce(cfg, key, Math.ceil(MARKET_DAY_MS / 1000) * 2))) return json(200, { status: "picked", message: "already picked this market day" });
  const r = outcome(await relayer.signAndSendTransaction({ receiverId: cfg.contractId, actions: [actions.functionCall("operator_mint", { account_id: player, token_id: "mango", amount: String(ORCHARD_PICK), reason: "orchard picking" }, TICK_GAS, 0n)], throwOnFailure: false }));
  // A final failure minted nothing: hand the day's pick back. A send that threw (no final answer) keeps the claim, since
  // the mint may still have landed; the player's bag is re-read either way.
  if (!r.ok) await releaseOnce(cfg, key);
  return json(r.ok ? 200 : 502, { status: r.ok ? "onchain" : "failed", qty: ORCHARD_PICK, txHash: r.txHash, message: r.error });
}

/** "Ask why": a merchant explains its price and its day from facts read on NEAR (see talk.ts). Read-only on chain;
 *  NEAR AI phrases it when NEAR_AI_KEY and NEAR_AI_MODEL are set (server-side only), else the scripted line. */
async function talk(cfg: Config, req: Request, env: RelayEnv): Promise<Response> {
  const b = await readJson(req);
  const id = String(b.npc ?? "");
  const resident = RESIDENTS.find((r) => r.id === id) ?? null;
  if (!(MERCHANTS as readonly string[]).includes(id) && !resident) throw new HttpError(400, "unknown speaker");
  if (!(await hit(cfg, `talk:${clientIp(req)}`, LIMITS.talk.max, LIMITS.talk.windowSec))) throw new HttpError(429, "slow down");
  const question = typeof b.question === "string" ? b.question.slice(0, MAX_QUESTION) : "";
  // the player's own trades with this speaker come from the player's receipts (public chain data); any game account works
  const player = typeof b.account === "string" && /^[gs][0-9a-f]{16}\./.test(b.account) && b.account.endsWith(`.${cfg.relayerId}`) ? b.account : null;
  // conversation history lives on the server under an unguessable id it issued: the client cannot plant past lines
  const conv = typeof b.conv === "string" && /^[0-9a-f]{32}$/.test(b.conv) ? b.conv : randomBytes(16).toString("hex");
  const store = decisionStore(cfg), day = Math.floor(Date.now() / MARKET_DAY_MS), npcAccount = `${id}.${cfg.relayerId}`;
  const histKey = `vivolith:talk:${conv}:${id}`;
  const { provider } = account(cfg);
  const [offers, receipts, decision, memory, history, playerReceipts, bonds] = await Promise.all([
    view<OfferRow[]>(provider, cfg.contractId, "get_offers", {}),
    view<Receipt[]>(provider, cfg.contractId, "get_receipts", { account_id: npcAccount }).catch(() => []),
    (async () => (await decisionFor(store, id, day)) ?? (await decisionFor(store, id, day - 1)))().catch(() => null),
    readMemory(store, id).catch(() => []),
    store.get(histKey).then((v) => (v ? (JSON.parse(v) as Exchange[]) : [])).catch(() => []),
    player ? view<Receipt[]>(provider, cfg.contractId, "get_receipts", { account_id: player }).catch(() => []) : Promise.resolve([] as Receipt[]),
    player ? readBonds(store, id, player).catch(() => []) : Promise.resolve([]),
  ]);
  // what this character can still recall about this player beyond the 20 latest receipts (ledger.ts, 30 days)
  const noun = (good: string, n: number): string => `${n} ${good === "mango" ? (n === 1 ? "mango" : "mangoes") : `${good}${n === 1 ? "" : "s"}`}`;
  const recalled = bondFacts(bonds, noun);
  // the speaker's recent confirmed market events from the Chronicle (reopening, rent, trades), as facts it may mention
  const town = (await readChronicle(store).catch(() => [])).filter((e) => e.actors.includes(id) && (e.status === "confirmed" || e.status === "recorded")).slice(-3).map((e) => `Recently in the market: ${e.text}`);
  let built: { facts: string[]; script: string; topics: Record<string, string>; ledger: Ledger };
  let mood: string = "neutral";
  if (resident) {
    const held = Object.fromEntries((await view<[string, string][]>(provider, cfg.contractId, "get_balances", { account_id: npcAccount }).catch(() => [])).map(([t, v]) => [t, Number(v)]));
    const st = await chainEconomy(provider, cfg);
    const names = Object.fromEntries(MERCHANTS.map((m) => [m, st.merchants[m].name]));
    built = residentFacts(resident, held, executableOffers(offers as unknown as Offer[], st.merchants), names, { decision, memory });
    built.facts.push(...town);
  } else {
    const st = await chainEconomy(provider, cfg);
    mood = moodOf(st, id as MerchantId);
    built = factsFor(st, id as MerchantId, offers, receipts, { decision, memory, player: player ? [...playerFacts(playerReceipts, npcAccount), ...recalled] : [] });
    built.facts.push(...town);
    const reopened = town.find((f) => /reopened|open again/.test(f));
    if (reopened && !built.topics.past) built.topics.past = reopened.replace(/^Recently in the market: /, "Recently, ").replace(/Pema's stall/, "my stall");
    const delivered = bonds.filter((x) => x.evidence === "chain" && x.kind === "delivered");
    if (delivered.length && !built.topics.you) built.topics.you = `You've brought me ${noun("mango", delivered.reduce((n, x) => n + x.qty, 0))} so far. I keep count.`;
  }
  const ops = opsConfig(env);
  const ai = { key: (env.NEAR_AI_KEY ?? "").trim() || null, model: (env.NEAR_AI_CHAT_MODEL ?? env.NEAR_AI_MODEL ?? "").trim() || null };
  const allowed = async (): Promise<boolean> => !(await agentsHalted(ops, store)) && (await spend(ops, store, "chat"));
  const r = await answer({ ai, id, facts: built.facts, script: built.script, topics: built.topics, ledger: built.ledger, question, history: Array.isArray(history) ? history : [], allowed });
  if (question) await store.set(histKey, JSON.stringify([...(Array.isArray(history) ? history : []), { q: question, a: r.line }].slice(-3)), 3600).catch(() => undefined);
  // each validated sentence may be voiced exactly as it is, by this speaker and mood (a short-lived speech token)
  const secret = voiceSecret(env.NEAR_MERCHANT_SECRET);
  const speech = r.sentences.map((t) => speechToken(secret, id, mood, spokenText(t)));
  return json(200, { ...r, conv, mood, speech });
}

/** Pays a player the whole coins of dividends they are owed (the contract can only ever pay what is owed). Players'
 *  own trades claim too; this lets dividends land for someone who is only watching. */
async function claim(cfg: Config, req: Request): Promise<Response> {
  const b = await readJson(req);
  const player = String(b.account ?? "");
  if (!/^[a-z0-9._-]{2,64}$/.test(player)) throw new HttpError(400, "bad account id");
  if (!(await hit(cfg, `claim:${player}`, LIMITS.claim.max, LIMITS.claim.windowSec))) throw new HttpError(429, "slow down");
  const { provider, relayer } = account(cfg);
  const owed = await view<{ coins: string }[]>(provider, cfg.contractId, "get_pending", { account_id: player });
  const coins = owed.reduce((n, p) => n + Number(p.coins), 0);
  if (coins === 0) return json(200, { status: "nothing", coins: 0 });
  const r = outcome(await relayer.signAndSendTransaction({ receiverId: cfg.contractId, actions: [actions.functionCall("claim", { account_id: player }, TICK_GAS, 0n)], throwOnFailure: false }));
  return json(r.ok ? 200 : 502, { status: r.ok ? "onchain" : "failed", coins, txHash: r.txHash, message: r.error });
}

async function settle(cfg: Config): Promise<Response> {
  if (!(await hit(cfg, "settle", LIMITS.settle.max, LIMITS.settle.windowSec))) throw new HttpError(429, "slow down");
  const day = Math.floor(Date.now() / MARKET_DAY_MS);
  const { relayer } = account(cfg);
  const r = outcome(
    await relayer.signAndSendTransaction({
      receiverId: cfg.contractId,
      actions: MERCHANTS.map((merchant) => actions.functionCall("settle_day", { day, merchant }, teraToGas("60"), 0n)),
      throwOnFailure: false,
    }),
  );
  return json(r.ok ? 200 : 502, { status: r.ok ? "onchain" : "failed", day, txHash: r.txHash, message: r.error });
}

/** Entry point for both runtimes. `route` is the last path segment under /api/near/. */
export async function handle(route: string, req: Request, env: RelayEnv): Promise<Response> {
  const cfg = readConfig(env);
  try {
    if (route === "status" && req.method === "GET") return await status(cfg, env);
    // The city's own schedule: a scheduler (Vercel Cron sends GET with `Authorization: Bearer $CRON_SECRET`, or the
    // operator script) runs a turn that may let agents decide with NEAR AI. Nobody else can call it.
    if (route === "market-turn") {
      if (!fromScheduler(opsConfig(env), req.headers.get("authorization"))) return json(401, { status: "error", message: "scheduler only" });
      if (!configured(cfg)) return json(503, { status: "unconfigured", message: "NEAR relayer not configured" });
      return await tick(cfg, env, true, new URL(req.url).searchParams.get("scope") === "agents" ? "agents" : "market");
    }
    // read-only: the Town Chronicle (recorded market events with their evidence), newest last
    if (route === "chronicle" && req.method === "GET") return json(200, { events: (await readChronicle(decisionStore(cfg)).catch(() => [])).slice(-40) });
    // read-only: an agent's recent NEAR AI / rule decisions (was unreachable behind the POST-only check below)
    if (route === "decisions" && req.method === "GET") {
      const who = new URL(req.url).searchParams.get("merchant") ?? "";
      if (!(AGENTS as readonly string[]).includes(who)) return json(200, { decisions: [] });
      const store = decisionStore(cfg), day = Math.floor(Date.now() / MARKET_DAY_MS);
      const ds = await recentDecisions(store, who, day).catch(() => []);
      // `live`: this decision is setting the price right now (confirmed, this market day, order still posted on chain)
      const live = !configured(cfg) ? [] : await (async () => { try { return await livePrices(store, await view<OfferRow[]>(account(cfg).provider, cfg.contractId, "get_offers", {}), day); } catch { return []; } })();
      return json(200, { decisions: ds.map((d) => ({ ...d, live: live.some((p) => p.id === d.merchant && d.day === day) })) });
    }
    if (req.method !== "POST") return json(405, { status: "error", message: "method not allowed" });
    if (route === "voice") { // spoken lines work offline too: no NEAR needed
      const origin = req.headers.get("origin");
      if (origin && new URL(origin).host !== new URL(req.url).host) return json(403, { status: "error", message: "cross-origin requests not allowed" });
      if (!(await hit(cfg, `voice:${clientIp(req)}`, LIMITS.voice.max, LIMITS.voice.windowSec))) return json(429, { status: "error", message: "slow down" });
      const e = env as Record<string, string | undefined>;
      // placeholder voice for local play without credits; refused on a production deployment
      const mock = e.VIVOLITH_VOICE_MOCK?.trim() === "1" && e.VERCEL_ENV !== "production";
      // every instance together: at most this many voice requests a day (cached answers count too: a conservative cap)
      if (!mock && !(await hit(cfg, "voice:day", LIMITS.voiceDay.max, LIMITS.voiceDay.windowSec))) return json(429, { status: "budget", message: "voice budget used for today" });
      const b = await readJson(req);
      const speaker = String(b.speaker ?? ""), text = voiceText(String(b.text ?? "")), mood = typeof b.mood === "string" ? b.mood : "neutral";
      // only lines the server validated (speech token) or lines made of the game's own words: not a general TTS service
      if (!speechTokenOk(voiceSecret(e.NEAR_MERCHANT_SECRET), b.token, speaker, mood, text) && !gameLine(text)) return json(403, { status: "error", message: "not a line of this game" });
      const charge = (n: number): Promise<boolean> => hit(cfg, "voice:chars", LIMITS.voiceChars.max, LIMITS.voiceChars.windowSec, n);
      const r = await synthesize(speaker, text, e.ELEVENLABS_API_KEY?.trim(), { mood, mock, charge });
      return json(r.status, r.body);
    }
    if (!configured(cfg)) return json(503, { status: "unconfigured", message: "NEAR relayer not configured (see docs/DEPLOY.md)" });
    const origin = req.headers.get("origin");
    if (origin && new URL(origin).host !== new URL(req.url).host) return json(403, { status: "error", message: "cross-origin requests not allowed" });
    if (route === "guest") return await guest(cfg, req);
    if (route === "relay") return await relay(cfg, req);
    if (route === "settle") return await settle(cfg);
    if (route === "deal") return await deal(cfg, req, env);
    if (route === "tick") return await tick(cfg, env);
    if (route === "pick") return await pick(cfg, req);
    if (route === "talk") return await talk(cfg, req, env);
    if (route === "social") return await social(cfg, req, env);
    if (route === "claim") return await claim(cfg, req);
    if (route === "register") return await register(cfg, req);
    if (route === "save") return await cloudSave(cfg, req);
    if (route === "load") return await cloudLoad(cfg, req);
    return json(404, { status: "error", message: "unknown route" });
  } catch (e) {
    if (e instanceof HttpError) return json(e.status, { status: "error", message: e.message });
    const message = e instanceof Error ? e.message.split("\n")[0].replace(/ed25519:[1-9A-HJ-NP-Za-km-z]{40,}/g, "[key]").slice(0, 160) : "error";
    return json(502, { status: "failed", message });
  }
}
