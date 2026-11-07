// NEAR relayer for VIVOLITH: framework-free handlers (web Request -> Response) shared by the Vercel function
// (api/near/[route].ts) and the Vite dev server (server/near-relay.ts). Keys stay on the server; responses never
// echo key material or stack traces.
//
// Routes: GET status | POST guest {publicKey} | POST relay {signedDelegate: base64} | POST settle
import { createHash, createPublicKey, verify as verifySignature, type JsonWebKey } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deserialize } from "borsh";
import { Account, JsonRpcProvider, KeyPairSigner, PublicKey, SCHEMA, actions, nearToYocto, teraToGas, type KeyPairString } from "near-api-js";
import { MERCHANTS, keyPairFromSeed, merchantKey, type MerchantId } from "./keys.ts";
import { bidFor, planMerchantTrades, quote } from "../../src/economy/pricing.ts";
import { shopperWant } from "../../src/economy/sim.ts";
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
const HAGGLE_FLOOR = 0.55; // buyer pays at least 55% of the ask
const HAGGLE_CEILING = 1.5; // merchant pays at most 150% of its bid
const GUEST_FUNDING = "0.01"; // account + key storage; guests never pay gas (meta-transactions)
/** One on-chain market day settles every 10 real minutes (fast-forward previews run in the client sim). */
export const MARKET_DAY_MS = 10 * 60 * 1000;

const LIMITS = {
  guest: { max: 3, windowSec: 3600 }, // per IP
  relay: { max: 30, windowSec: 60 }, // per player account
  relayIp: { max: 60, windowSec: 60 }, // per IP
  settle: { max: 6, windowSec: 60 }, // global
  deal: { max: 20, windowSec: 60 }, // per player account
  social: { max: 10, windowSec: 3600 }, // per IP
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

async function hit(cfg: Config, bucket: string, max: number, windowSec: number): Promise<boolean> {
  const key = `vivolith:rl:${bucket}:${Math.floor(Date.now() / 1000 / windowSec)}`;
  if (cfg.redisUrl && cfg.redisToken) {
    const r = await fetch(`${cfg.redisUrl}/pipeline`, {
      method: "POST",
      headers: { authorization: `Bearer ${cfg.redisToken}`, "content-type": "application/json" },
      body: JSON.stringify([["INCR", key], ["EXPIRE", key, String(windowSec + 5)]]),
    });
    if (!r.ok) throw new Error("rate limiter unavailable");
    const [{ result }] = (await r.json()) as [{ result: number }];
    return result <= max;
  }
  // ponytail: per-instance memory only resets on cold start; Upstash is the persistent path in production.
  const now = Date.now();
  const e = memory.get(key);
  if (!e || e.until < now) {
    memory.set(key, { n: 1, until: now + windowSec * 1000 });
    return true;
  }
  e.n += 1;
  return e.n <= max;
}

// ---------- helpers ----------

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

const clientIp = (req: Request): string => (req.headers.get("x-forwarded-for") ?? "local").split(",")[0].trim().slice(0, 64);

async function readJson(req: Request): Promise<Record<string, unknown>> {
  const raw = await req.text();
  if (raw.length > MAX_BODY) throw new HttpError(413, "body too large");
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
function outcome(r: unknown): TxResult {
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

async function status(cfg: Config): Promise<Response> {
  return json(200, {
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
  if (!(await hit(cfg, `guest:${clientIp(req)}`, LIMITS.guest.max, LIMITS.guest.windowSec))) throw new HttpError(429, "too many new players from this address, try later");
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
  const r = outcome(
    await relayer.signAndSendTransaction({
      receiverId: sender,
      actions: [actions.signedDelegate(decoded as never)],
      throwOnFailure: false,
    }),
  );
  return json(r.ok ? 200 : 422, { status: r.ok ? "onchain" : "failed", txHash: r.txHash, accountId: sender, contractId: cfg.contractId, message: r.error });
}

interface OfferRow {
  merchant: string;
  token_id: string;
  side: "ask" | "bid";
  qty: string;
  price: string;
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
  if (!(MERCHANTS as readonly string[]).includes(merchant)) throw new HttpError(400, "unknown merchant");
  if (side !== "buy" && side !== "sell") throw new HttpError(400, "side must be buy or sell");
  if (!GOODS.has(token)) throw new HttpError(400, "unknown good");
  if (!Number.isInteger(qty) || qty < 1 || qty > 40 || !Number.isInteger(unit) || unit < 1 || unit > 1000) throw new HttpError(400, "bad quantity or price");
  if (!/^[a-z0-9._-]{2,64}$/.test(player)) throw new HttpError(400, "bad account id");
  if (!(await hit(cfg, `deal:${player}`, LIMITS.deal.max, LIMITS.deal.windowSec))) throw new HttpError(429, "slow down");
  const { provider } = account(cfg);
  if (!(await view<boolean>(provider, cfg.contractId, "is_registered", { account_id: player }))) throw new HttpError(403, "player not registered");
  const offers = await view<OfferRow[]>(provider, cfg.contractId, "get_offers", {});
  const posted = offers.find((o) => o.merchant === merchant && o.token_id === token && o.side === (side === "buy" ? "ask" : "bid"));
  if (!posted) throw new HttpError(409, side === "buy" ? "sold out" : "not buying that today");
  const p = Number(posted.price);
  if (side === "buy" && unit < Math.floor(p * HAGGLE_FLOOR)) throw new HttpError(409, `won't go below ${Math.floor(p * HAGGLE_FLOOR)} c`);
  if (side === "sell" && unit > Math.ceil(p * HAGGLE_CEILING)) throw new HttpError(409, `won't pay more than ${Math.ceil(p * HAGGLE_CEILING)} c`);
  if (side === "buy" && qty > Number(posted.qty)) throw new HttpError(409, `only ${posted.qty} on offer`);
  const secret = (env.NEAR_MERCHANT_SECRET ?? "").trim();
  if (!secret) throw new HttpError(503, "merchant keys not configured");
  const nonce = Date.now() * 1000 + Math.floor(Math.random() * 1000);
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

/** Signs a player in with Google or email. The verified identity always maps to the same game account, created on
 *  first sign-in with a function-call session key for buy/sell/deal (derived per identity, so every device gets the
 *  same key). If the browser proves it owns a guest account, the guest's coins, goods and shares move into it. */
async function social(cfg: Config, req: Request, env: RelayEnv): Promise<Response> {
  if (!cfg.auth0Domain || !cfg.auth0ClientId) throw new HttpError(503, "sign-in is not configured");
  if (!(await hit(cfg, `social:${clientIp(req)}`, LIMITS.social.max, LIMITS.social.windowSec))) throw new HttpError(429, "too many sign-ins from this address, try later");
  const body = await readJson(req);
  if (typeof body.idToken !== "string" || body.idToken.length > 4000) throw new HttpError(400, "idToken required");
  const claims = await verifyIdToken(body.idToken, cfg);
  const identity = identityOf(claims);
  const secret = (env.NEAR_MERCHANT_SECRET ?? "").trim();
  if (!secret) throw new HttpError(503, "session keys not configured");
  const { provider, relayer } = account(cfg);
  const session = keyPairFromSeed(createHash("sha256").update(`vivolith-session:${identity}:${secret}`).digest());
  const accountId = `s${createHash("sha256").update(`vivolith-account:${identity}`).digest("hex").slice(0, 16)}.${cfg.relayerId}`;
  const exists = await provider.viewAccount({ accountId, finality: "final" }).then(() => true, () => false);
  const txs: string[] = [];
  if (!exists) {
    const r = outcome(await relayer.signAndSendTransaction({
      receiverId: accountId,
      actions: [actions.createAccount(), actions.transfer(nearToYocto(GUEST_FUNDING)), actions.addFunctionCallAccessKey(session.getPublicKey(), cfg.contractId, [...PLAYER_METHODS])],
      throwOnFailure: false,
    }));
    if (!r.ok) return json(502, { status: "failed", message: r.error });
    txs.push(r.txHash);
  }
  if (!(await view<boolean>(provider, cfg.contractId, "is_registered", { account_id: accountId }))) {
    const r = outcome(await relayer.callFunctionRaw({ contractId: cfg.contractId, methodName: "register_player", args: { account_id: accountId }, gas: MAX_GAS }));
    if (!r.ok) return json(502, { status: "failed", message: r.error });
    txs.push(r.txHash);
  }
  let merged: string | null = null;
  const guest = guestFromProof(body.guest as GuestLink, body.idToken, cfg);
  if (guest && guest !== accountId && (await view<boolean>(provider, cfg.contractId, "is_registered", { account_id: guest }))) {
    const r = outcome(await relayer.signAndSendTransaction({
      receiverId: cfg.contractId,
      actions: [actions.functionCall("migrate_player", { from: guest, to: accountId }, MAX_GAS, 0n)],
      throwOnFailure: false,
    }));
    if (r.ok) { merged = guest; txs.push(r.txHash); }
  }
  const label = (claims.email ?? claims.name ?? "").slice(0, 80);
  return json(200, { status: "onchain", accountId, sessionKey: session.toString(), label, merged, txHashes: txs });
}

// ---------- the merchants' autonomous turn ----------

/** Game hours of street trade one tick represents (ticks run at most once a minute, globally). */
const TICK_HOURS = 2;
const TICK_GAS = teraToGas("30");

/** Rebuilds the four merchants from their on-chain balances so the shared rules in src/economy run on real state. */
async function chainEconomy(provider: JsonRpcProvider, cfg: Config): Promise<EconomyState> {
  const st = initialEconomy();
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

/** One merchant turn on NEAR: each merchant reprices its own asks and bids from pricing.ts (signed with its own
 *  key), merchants fill each other's bids, and the operator records street shoppers, Tomas's harbor contract and
 *  Arin's kitchen. Idempotent enough to call often: throttled to one turn per minute across all players. */
async function tick(cfg: Config, env: RelayEnv): Promise<Response> {
  if (!(await hit(cfg, "tick", 1, 60))) return json(200, { status: "skipped", message: "the merchants moved less than a minute ago" });
  const secret = (env.NEAR_MERCHANT_SECRET ?? "").trim();
  if (!secret) throw new HttpError(503, "merchant keys not configured");
  const { provider, relayer } = account(cfg);
  const st = await chainEconomy(provider, cfg);
  const posted = new Map((await view<OfferRow[]>(provider, cfg.contractId, "get_offers", {})).map((o) => [orderKey(o), o]));
  const signerOf = (id: MerchantId): Account => new Account(`${id}.${cfg.relayerId}`, provider, new KeyPairSigner(merchantKey(id, secret)));
  const log: string[] = [];
  const txs: string[] = [];

  // 1. Every merchant reprices (only orders that changed are sent).
  const repriced = await Promise.all(MERCHANTS.map(async (id) => {
    const m = st.merchants[id];
    const calls: ReturnType<typeof actions.functionCall>[] = [];
    const want = (side: "ask" | "bid", token: string, qty: number, price: number): void => {
      const cur = posted.get(`${id}|${side}|${token}`);
      if (qty <= 0) { if (cur) calls.push(actions.functionCall(side === "ask" ? "list" : "bid", { token_id: token, qty: "0", price: "1" }, TICK_GAS, 0n)); return; }
      if (cur && Number(cur.qty) === qty && Number(cur.price) === price) return;
      calls.push(actions.functionCall(side === "ask" ? "list" : "bid", { token_id: token, qty: String(qty), price: String(price) }, TICK_GAS, 0n));
    };
    for (const good of m.sells) want("ask", good, m.stock[good], quote(st, id, good, false).price);
    for (const good of ["mango", "lemon"] as const) {
      const b = bidFor(st, id, good);
      want("bid", good, b ? Math.min(b.qty, Math.floor(m.cash / Math.max(1, b.price))) : 0, b?.price ?? 1);
    }
    // Function-call keys allow one action per transaction: one tx per order, in sequence for this merchant.
    const hashes: string[] = [];
    for (const call of calls) {
      const r = outcome(await signerOf(id).signAndSendTransaction({ receiverId: cfg.contractId, actions: [call], throwOnFailure: false }));
      hashes.push(r.txHash);
      const fc = call.functionCall!;
      const a = JSON.parse(new TextDecoder().decode(fc.args)) as { token_id: string; qty: string; price: string };
      log.push(`${id} ${fc.methodName === "list" ? "asks" : "bids"} ${a.qty === "0" ? "withdrawn for" : `${a.qty} x ${a.price} c for`} ${a.token_id}${r.ok ? "" : ` FAILED: ${r.error}`}`);
    }
    return hashes;
  }));
  txs.push(...repriced.flat());

  // 2. Merchants fill each other's bids at the asks they just posted.
  for (const t of planMerchantTrades(st)) {
    const r = outcome(await signerOf(t.buyer).signAndSendTransaction({
      receiverId: cfg.contractId,
      actions: [actions.functionCall("buy", { seller: `${t.seller}.${cfg.relayerId}`, token_id: t.good, qty: String(t.qty), max_price: String(t.price) }, TICK_GAS, 0n)],
      throwOnFailure: false,
    }));
    txs.push(r.txHash);
    log.push(`${t.buyer} bought ${t.qty} ${t.good} from ${t.seller} at ${t.price} c (${t.reason})${r.ok ? "" : ` FAILED: ${r.error}`}`);
  }

  // 3. Operator: street shoppers, the harbor contract, the tea kitchen.
  const op: ReturnType<typeof actions.functionCall>[] = [];
  for (const id of MERCHANTS) {
    const m = st.merchants[id];
    for (const good of m.sells) {
      const units = Math.min(m.stock[good], Math.floor(shopperWant(st, id, good) * TICK_HOURS));
      if (units > 0) op.push(actions.functionCall("street_sale", { merchant: id, token_id: good, qty: String(units), unit_price: String(quote(st, id, good, false).price) }, TICK_GAS, 0n));
      if (units > 0) log.push(`street shoppers bought ${units} ${good} from ${id}`);
    }
  }
  const tomas = st.merchants.tomas;
  const day = Math.floor(Date.now() / MARKET_DAY_MS);
  const harborDue = tomas.stock.mango < tomas.target.mango && (await hit(cfg, `harbor:${day}`, 1, Math.ceil(MARKET_DAY_MS / 1000)));
  if (harborDue) {
    const qty = Math.round(tomas.target.mango * 1.4) - tomas.stock.mango;
    op.push(actions.functionCall("operator_mint", { account_id: `tomas.${cfg.relayerId}`, token_id: "mango", amount: String(qty), reason: "harbor standing contract" }, TICK_GAS, 0n));
    log.push(`harbor delivered ${qty} mangoes to tomas`);
  }
  const arin = st.merchants.arin;
  const batches = Math.min(arin.stock.mango, Math.max(0, Math.ceil((8 - arin.stock.lassi) / 4)));
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
  return json(200, { status: "onchain", txHashes: txs, log });
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
    if (route === "status" && req.method === "GET") return await status(cfg);
    if (req.method !== "POST") return json(405, { status: "error", message: "method not allowed" });
    if (!configured(cfg)) return json(503, { status: "unconfigured", message: "NEAR relayer not configured (see docs/DEPLOY.md)" });
    const origin = req.headers.get("origin");
    if (origin && new URL(origin).host !== new URL(req.url).host) return json(403, { status: "error", message: "cross-origin requests not allowed" });
    if (route === "guest") return await guest(cfg, req);
    if (route === "relay") return await relay(cfg, req);
    if (route === "settle") return await settle(cfg);
    if (route === "deal") return await deal(cfg, req, env);
    if (route === "tick") return await tick(cfg, env);
    if (route === "social") return await social(cfg, req, env);
    return json(404, { status: "error", message: "unknown route" });
  } catch (e) {
    if (e instanceof HttpError) return json(e.status, { status: "error", message: e.message });
    const message = e instanceof Error ? e.message.split("\n")[0].replace(/ed25519:[1-9A-HJ-NP-Za-km-z]{40,}/g, "[key]").slice(0, 160) : "error";
    return json(502, { status: "failed", message });
  }
}
