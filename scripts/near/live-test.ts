// Controlled live test on testnet: ONE Jev decision for Tomas's mango ask -> posted on chain -> a player buys at that price.
//   node scripts/near/live-test.ts          dry run: reads chain state only (no NEAR AI call, no transaction)
//   node scripts/near/live-test.ts --yes    runs it: at most 1 NEAR AI request and 6 testnet transactions, no retries
// Steps: guest (1 tx) + register (1 tx) + orchard pick (1 tx) + sell 1 mango to Tomas, which reopens him (1 tx) + Tomas posts
// the AI ask (1 tx) + the player buys 1 mango at it (1 tx). It never runs the market tick. .env.local is read, never printed.
import fs from "node:fs";
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, actions, encodeSignedDelegate, teraToGas } from "near-api-js";
import { chainEconomy, decisionStore, handle, outcome, readConfig, MARKET_DAY_MS, type RelayEnv } from "../../server/near/handlers.ts";
import { merchantKey } from "../../server/near/keys.ts";
import { agentConfig, attachTx, bandFor, claimBidSend, decideBid, releaseBidSend, type BookOffer } from "../../server/near/agent.ts";
import { bidFor } from "../../src/economy/pricing.ts";

const send = process.argv.includes("--yes");
const env: RelayEnv = Object.fromEntries(
  fs.readFileSync(".env.local", "utf8").split(/\r?\n/).filter((l) => /^NEAR_[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
);
const cfg = readConfig(env);
const provider = new JsonRpcProvider({ url: cfg.rpcUrl });
const agentCfg = { ...agentConfig({ ...env, NEAR_AGENT_MERCHANTS: "tomas" }), retries: 0 }; // retries 0: never a second request
const store = decisionStore(cfg);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const link = (h: unknown): string => `https://testnet.nearblocks.io/txns/${String(h)}`;
const fail = (m: string): never => { console.error("STOP:", m); process.exit(1); };

const view = async <T>(method: string, args: Record<string, unknown> = {}): Promise<T> =>
  (await provider.callFunction({ contractId: cfg.contractId, method, args, finality: "final" })) as unknown as T;
const balances = async (id: string): Promise<Record<string, number>> => Object.fromEntries((await view<[string, string][]>("get_balances", { account_id: id })).map(([t, v]) => [t, Number(v)]));
async function settled(id: string): Promise<Record<string, number>> {
  let prev = JSON.stringify(await balances(id));
  for (let i = 0; i < 8; i++) { await sleep(2000); const n = JSON.stringify(await balances(id)); if (n === prev) break; prev = n; }
  return JSON.parse(prev) as Record<string, number>;
}
async function call(route: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const req = new Request(`http://localhost/api/near/${route}`, { method: body === undefined ? "GET" : "POST", body: body === undefined ? undefined : JSON.stringify(body) });
  const res = await handle(route, req, env);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

// ---- preflight: reads only ----
const day = Math.floor(Date.now() / MARKET_DAY_MS);
const tomasId = `tomas.${cfg.relayerId}`;
const offers = await view<BookOffer[]>("get_offers");
const st = await chainEconomy(provider, cfg);
const t = st.merchants.tomas;
const bid = bidFor(st, "tomas", "mango")?.price ?? null;
const reopened = structuredClone(st);
reopened.merchants.tomas.status = "open"; reopened.merchants.tomas.stock.mango += 1;
const band = bandFor(reopened, "tomas", offers);
const need = Number(st.flags["reopenNeed.tomas"] ?? 1);
console.log(`preflight: tomas ${t.status}, ${t.stock.mango} mangoes, ${Math.floor(t.cash)} c, bid for mango ${bid}, reopen need ${need}, band after reopening ${band ? JSON.stringify(band) : "none"}`);
if (!agentCfg.key) fail("NEAR_AI_KEY is not set");
if (t.status !== "closed") fail("Tomas is not closed: the reopen step does not apply (nothing was spent)");
if (bid === null || t.cash < bid) fail("Tomas has no mango bid or cannot pay it");
if (need > 1) fail(`Tomas needs ${need} mangoes to reopen, the test delivers 1`);
if (!band) fail("no decision band for Tomas after reopening: no NEAR AI call would happen");
if (!send) { console.log("DRY RUN: nothing sent. Re-run with --yes."); process.exit(0); }

// ---- run ----
const hashes: string[] = [];
let aiRequests = 0;
const oneFetch = ((url: string, init: RequestInit) => { if (++aiRequests > 1) throw new Error("a second NEAR AI request was refused"); return fetch(url, init); }) as never;
async function relayCall(player: Account, method: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  for (let i = 0; ; i++) {
    try {
      const { signedDelegate } = await player.createSignedMetaTransaction({ receiverId: cfg.contractId, actions: [actions.functionCall(method, args, teraToGas("50"), 0n)], blockHeightTtl: 120 });
      const r = await call("relay", { signedDelegate: Buffer.from(encodeSignedDelegate(signedDelegate)).toString("base64") });
      if (r.status !== 200) fail(`${method} refused: ${JSON.stringify(r.body)}`);
      hashes.push(String(r.body.txHash)); return r.body;
    } catch (e) { if (i >= 5) throw e; await sleep(1500); } // a just-created access key can take a block or two to show
  }
}

const key = KeyPair.fromRandom("ed25519");
const g = await call("guest", { publicKey: key.getPublicKey().toString() });
if (g.status !== 200) fail(`guest: ${JSON.stringify(g.body)}`);
const player = String(g.body.accountId);
hashes.push(...(g.body.txHashes as string[]));
const kavi = new Account(player, provider, new KeyPairSigner(key));
console.log(`1-2 guest ${player} created and registered`, (g.body.txHashes as string[]).map(link).join(" "));
const kaviBefore = await settled(player), tomasBefore = await settled(tomasId);

const pick = await call("pick", { account: player });
if (pick.status !== 200 || pick.body.status !== "onchain") fail(`pick: ${JSON.stringify(pick.body)}`);
hashes.push(String(pick.body.txHash)); console.log("3 orchard pick: 3 mangoes", link(pick.body.txHash));
await settled(player);

const sale = await call("deal", { merchant: "tomas", side: "sell", token: "mango", qty: 1, unit: bid, ref: 0, tactics: [], rep: 0, player });
if (sale.status !== 200) fail(`deal (sell to Tomas) refused: ${JSON.stringify(sale.body)}`);
const sold = await relayCall(kavi, "deal", sale.body.args as Record<string, unknown>);
console.log(`4 sold 1 mango to Tomas at ${bid} c (reopens him)`, link(sold.txHash));
await settled(tomasId);

// the one NEAR AI decision: fresh chain state, Tomas open
const st2 = await chainEconomy(provider, cfg);
const offers2 = await view<BookOffer[]>("get_offers");
if (st2.merchants.tomas.status !== "open") fail("Tomas did not reopen (4 transactions spent, no NEAR AI call made)");
const out = await decideBid({ store, cfg: agentCfg, st: st2, id: "tomas", offers: offers2, day, fetchImpl: oneFetch });
const d = out.decision;
if (!d) fail("no decision was made (rule price, no NEAR AI call)");
console.log(`decision: source=${d!.source} action=${d!.action} base ${d!.basePrice} -> ${d!.price} c confidence=${d!.confidence ?? "n/a"} receipt=${d!.receipt ? JSON.stringify(d!.receipt) : "none"} fallback=${d!.fallbackReason ?? "none"}`);
console.log(`  line: ${d!.line}`);
if (!(await claimBidSend(store, "tomas", day))) fail("the ask was already sent for this market day");
const tomas = new Account(tomasId, provider, new KeyPairSigner(merchantKey("tomas", env.NEAR_MERCHANT_SECRET!.trim())));
const listed = outcome(await tomas.signAndSendTransaction({ receiverId: cfg.contractId, actions: [actions.functionCall("list", { token_id: "mango", qty: String(st2.merchants.tomas.stock.mango), price: String(d!.price) }, teraToGas("30"), 0n)], throwOnFailure: false }));
if (!listed.ok) { await releaseBidSend(store, "tomas", day); fail(`list failed: ${listed.error}`); }
hashes.push(listed.txHash); await attachTx(store, "tomas", day, listed.txHash);
console.log(`5 Tomas posted his mango ask at ${d!.price} c`, link(listed.txHash));
await sleep(3000);

const buy = await call("deal", { merchant: "tomas", side: "buy", token: "mango", qty: 1, unit: d!.price, ref: d!.source === "ai" ? d!.price : 0, tactics: [], rep: 0, player });
if (buy.status !== 200) fail(`deal (buy from Tomas) refused: ${JSON.stringify(buy.body)}`);
const bought = await relayCall(kavi, "deal", buy.body.args as Record<string, unknown>);
console.log(`6 bought 1 mango from Tomas at ${d!.price} c`, link(bought.txHash));

const kaviAfter = await settled(player), tomasAfter = await settled(tomasId);
const stalls = await view<{ merchant: string; open: boolean }[]>("get_stalls");
const audit = await view<{ ok: boolean }>("audit");
console.log("\n--- result ---");
console.log(`NEAR AI requests: ${aiRequests}; transactions: ${hashes.length}`);
console.log(`guest  before ${JSON.stringify(kaviBefore)} after ${JSON.stringify(kaviAfter)}`);
console.log(`tomas  before ${JSON.stringify(tomasBefore)} after ${JSON.stringify(tomasAfter)}; open=${stalls.find((s) => s.merchant === "tomas")?.open}`);
console.log(`contract audit ok: ${audit.ok}`);
console.log("book:", JSON.stringify((await view<BookOffer[]>("get_offers")).filter((o) => o.merchant === "tomas")));
