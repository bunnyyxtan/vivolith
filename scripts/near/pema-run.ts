// Controlled live Phase 2 run for ONE agent (Pema) on NEAR testnet: real chain state -> one Jev decision -> server
// validation -> at most one transaction (Pema's own mango bid) -> stored decision and memory -> game decision endpoint
// -> signature check -> the memory outcome closed on the next market day.
//   node --env-file=.env.local scripts/near/pema-run.ts            read-only preflight: what would happen, nothing sent
//   node --env-file=.env.local scripts/near/pema-run.ts --yes      the whole run in one process (waits for the next market
//                                                                  day to close the memory row; about 10 minutes)
// Hard guards in this process (all abort before sending): a second request to the decision endpoint; any transaction that
// is not Pema's `bid` on the market contract; more than one transaction; any host other than the NEAR RPC, NEAR AI
// Cloud and Redis. Overrides apply to this process only (nothing persistent is enabled): agents = pema, decision retries
// = 0, today's decision budget = today's use + 1, chats 0, signature checks only after the turn. No secret is printed.
import fs from "node:fs";
import { randomBytes } from "node:crypto";
import { deserialize } from "borsh";
import { SCHEMA } from "near-api-js";

const yes = process.argv.includes("--yes");
const evidencePath = "docs/evidence/phase2-pema-live-run.json";
const report: Record<string, unknown> = { at: new Date().toISOString(), mode: yes ? "run" : "preflight" };
const save = (): void => { if (yes) fs.writeFileSync(evidencePath, JSON.stringify(report, null, 1)); };
const stop = (why: string): never => { report.stopped = why; save(); console.error(`STOP: ${why}`); process.exit(2); throw new Error(why); };

// ------------------------------------------------------------------ network guard (installed before any import) ----
const relayer = (): string => (process.env.NEAR_RELAYER_ID ?? process.env.NEAR_ACCOUNT_ID ?? "").trim();
const contract = (): string => (process.env.NEAR_CONTRACT_ID ?? `market.${relayer()}`).trim();
const real = globalThis.fetch;
const seen = { rpc: 0, decisions: 0, signatureReads: 0, redis: 0, sendTx: 0 };
let allowSend = false, allowSignatureReads = false;
const sentTxs: { signer: string; receiver: string; method: string; args: unknown }[] = [];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  const host = new URL(url).host;
  if (host === "cloud-api.near.ai") {
    if (url.includes("/v1/systemone")) {
      if (++seen.decisions > 1) stop("a second decision request was attempted");
    } else if (/\/v1\/(signature|attestation)\//.test(url)) {
      if (!allowSignatureReads) stop(`signature read outside the verification step: ${url.split("?")[0]}`);
      seen.signatureReads++;
    } else stop(`unexpected NEAR AI endpoint ${new URL(url).pathname}`);
  } else if (/rpc\.testnet\./.test(host) || host === new URL(process.env.NEAR_RPC_URL || "https://rpc.testnet.fastnear.com").host) {
    seen.rpc++;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as { method?: string; params?: unknown } : {};
    if (body.method === "send_tx" || body.method === "broadcast_tx_commit" || body.method === "broadcast_tx_async") {
      if (!allowSend) stop("a transaction was attempted outside the turn");
      if (++seen.sendTx > 1) stop("more than one transaction was attempted");
      const p = body.params as { signed_tx_base64?: string } | string[] | undefined;
      const raw = Array.isArray(p) ? String(p[0]) : p?.signed_tx_base64 ?? "";
      let tx: { transaction: { signerId: string; receiverId: string; actions: { functionCall?: { methodName: string; args: Uint8Array } }[] } };
      try { tx = deserialize(SCHEMA.SignedTransaction, Buffer.from(raw, "base64")) as typeof tx; } catch { return stop("could not decode the transaction to check it"); }
      const fc = tx.transaction.actions[0]?.functionCall;
      const t = { signer: tx.transaction.signerId, receiver: tx.transaction.receiverId, method: fc?.methodName ?? "?", args: fc ? JSON.parse(Buffer.from(fc.args).toString()) as unknown : null };
      if (t.signer !== `pema.${relayer()}` || t.receiver !== contract() || t.method !== "bid" || tx.transaction.actions.length !== 1 || (t.args as { token_id?: string } | null)?.token_id !== "mango") stop(`unexpected transaction ${JSON.stringify(t)}`);
      sentTxs.push(t);
    }
  } else if (process.env.UPSTASH_REDIS_REST_URL && host === new URL(process.env.UPSTASH_REDIS_REST_URL).host) {
    seen.redis++;
  } else if (!(host === "vivolith.world" && (init?.method ?? "GET") === "GET")) { // production's public status is read-only
    stop(`unexpected host ${host}`);
  }
  return real(input, init);
}) as typeof fetch;

// ------------------------------------------------------------------ process-only overrides ----
const secret = randomBytes(24).toString("hex"); // this process's scheduler secret; never stored or printed
Object.assign(process.env, { NEAR_AGENT_MERCHANTS: "pema", NEAR_AI_DECISION_RETRIES: "0", NEAR_AI_DAILY_CHATS: "0", NEAR_AI_DAILY_VERIFIES: "0", NEAR_MARKET_DRIVER: "players", NEAR_SCHEDULER_SECRET: secret });
delete process.env.NEAR_AGENTS_OFF;

const { agentConfig, bandFor, decisionFor, verifyStored, LEVERS } = await import("../../server/near/agent.ts");
const { MARKET_DAY_MS, chainEconomy, decisionStore, handle, readConfig } = await import("../../server/near/handlers.ts");
const { agentsHalted, opsConfig, usage, budgetKey } = await import("../../server/near/ops.ts");
const { readMemory } = await import("../../server/near/memory.ts");
const { recordMemories, AGENTS } = await import("../../server/near/autonomy.ts");
const { verifyDecision } = await import("../../server/near/verify.ts");
const { merchantKey } = await import("../../server/near/keys.ts");
const { bidFor } = await import("../../src/economy/pricing.ts");
const { JsonRpcProvider } = await import("near-api-js");

const env = process.env as Record<string, string | undefined>;
const cfg = readConfig(env), store = decisionStore(cfg), ops = opsConfig(env), ai = agentConfig(env);
const provider = new JsonRpcProvider({ url: cfg.rpcUrl });
const view = async <T>(method: string, args: Record<string, unknown>): Promise<T> => (await provider.callFunction({ contractId: cfg.contractId, method, args } as never)) as unknown as T;
const dayNow = (): number => Math.floor(Date.now() / MARKET_DAY_MS);
const pemaAcct = `pema.${cfg.relayerId}`;
type OfferRow = { merchant: string; account_id: string; token_id: string; side: string; qty: string; price: string };
interface Pre { readonly day: number; readonly budget: number; readonly band: { min: number; max: number }; readonly secondsLeft: number }

// ------------------------------------------------------------------ preflight (read-only) ----
async function preflight(): Promise<Pre> {
  const day = dayNow();
  if (!cfg.relayerKey || !cfg.relayerId.endsWith(".testnet") || !cfg.contractId.endsWith(".testnet")) stop("relayer not configured for testnet");
  if (!(env.NEAR_MERCHANT_SECRET ?? "").trim()) stop("merchant secret missing");
  if (!ai.key) stop("NEAR_AI_KEY missing");
  if ([...ai.enabled].join(",") !== "pema") stop(`enabled agents are ${[...ai.enabled].join(",")}, not pema alone`);
  if (ai.retries !== 0) stop("decision retries are not 0");
  if (await agentsHalted(ops, store)) stop("agents are halted (kill switch or store unreachable)");
  const before = seen.rpc;
  const st = await chainEconomy(provider, cfg);
  if (seen.rpc === before) stop("the network guard does not see RPC calls; refusing to run unguarded");
  const offers = await view<OfferRow[]>("get_offers", {});
  const p = st.merchants.pema;
  // Pema's own key must exist on chain, limited to the market contract
  const pk = merchantKey("pema", env.NEAR_MERCHANT_SECRET!.trim()).getPublicKey();
  const key = await provider.viewAccessKey({ accountId: pemaAcct, publicKey: pk } as never).catch(() => null) as { permission?: { FunctionCall?: { receiver_id?: string } } | string } | null;
  const perm = key && typeof key.permission === "object" ? key.permission.FunctionCall?.receiver_id : null;
  if (perm !== cfg.contractId) stop(`Pema's key is not a function-call key for ${cfg.contractId}`);
  const band = bandFor(st, "pema", offers);
  const posted = offers.find((o) => o.merchant === "pema" && o.side === "bid" && o.token_id === "mango") ?? null;
  const b = bidFor(st, "pema", "mango");
  const qtyAt = (price: number): number => (b ? Math.min(b.qty, Math.floor(p.cash / Math.max(1, price))) : 0); // as handlers.ts tick
  const prior = await decisionFor(store, "pema", day);
  const others = (await Promise.all(AGENTS.filter((a) => a !== "pema").map(async (a) => [a, await decisionFor(store, a, day)] as const))).filter(([, x]) => x !== null).map(([a]) => a);
  const used = await usage(store);
  if (!used) stop("budget counter unreachable");
  let prod: unknown = null;
  try { const j = await (await fetch("https://vivolith.world/api/near/status")).json() as { lastTick?: { at: number; day: number } }; prod = j.lastTick ? { minutesAgo: Math.round((Date.now() - j.lastTick.at) / 60000), day: j.lastTick.day } : null; } catch { prod = "unreachable"; }
  const secondsLeft = Math.round((MARKET_DAY_MS - (Date.now() % MARKET_DAY_MS)) / 1000);
  const pre = {
    marketDay: day, secondsLeftInDay: secondsLeft,
    contract: cfg.contractId, store: cfg.redisUrl ? "redis (persistent)" : "this process's memory (NOT persistent)",
    productionLastTurn: prod, enabledAgents: [...ai.enabled], decisionModel: ai.model, retries: ai.retries,
    pema: { status: p.status, till: p.cash, mangoes: p.stock.mango, normalStock: p.target.mango, rent: p.rent, rentEveryDays: p.rentEveryDays, rentDueToday: day % p.rentEveryDays === 0, reopensAfterMangoes: st.flags["reopenNeed.pema"] ?? null, guildDebt: st.flags["debt.pema"] ?? null, lastRentDay: st.flags["lastRent.pema"] ?? null },
    pemaPostedMangoBid: posted ? { price: Number(posted.price), qty: Number(posted.qty) } : null,
    // reopening by one player sale: the relayer signs a sale only inside dealBounds(bid) and only if the till covers it
    reopenSale: p.status === "open" ? "not needed" : ((): unknown => {
      const bid = b?.price ?? null;
      if (bid === null) return { bid: null, feasibleUnit: null, why: "Pema has no mango bid while closed" };
      const min = Math.floor(bid * 0.55), unit = Math.min(bid, Math.floor(p.cash));
      return { bid, allowedUnit: { min, max: bid }, till: p.cash, feasibleUnit: unit >= Math.max(1, min) ? unit : null };
    })(),
    stalls: Object.fromEntries((["pema", "tomas", "mira", "arin"] as const).map((id) => [id, { status: st.merchants[id].status, till: st.merchants[id].cash, mangoes: st.merchants[id].stock.mango, guildDebt: st.flags[`debt.${id}`] ?? null }])),
    guildFundCoins: await (async () => { try { const g = await view<string>("get_guild", {}); return Number((await view<[string, string][]>("get_balances", { account_id: g })).find(([t]) => t === "coin")?.[1] ?? 0); } catch { return null; } })(),
    band, lever: LEVERS.pema,
    // what each permitted choice would post; the turn sends a bid only if it differs from what is posted
    outcomes: band ? Object.fromEntries((["lower", "hold", "raise"] as const).map((c) => {
      const price = c === "hold" ? band.base : band[c];
      if (price === null) return [c, "not permitted today"];
      const q = qtyAt(price);
      return [c, posted && Number(posted.price) === price && Number(posted.qty) === q ? `no transaction (bid already ${q} x ${price} c)` : q <= 0 ? (posted ? "pema.bid mango withdrawn (qty 0)" : "no transaction (nothing to post)") : `pema.bid mango ${q} x ${price} c`];
    })) : "no band: Pema is closed or has no bid; the turn would decide nothing and send nothing",
    existingPemaDecisionToday: prior ? { source: prior.source, action: prior.action, price: prior.price } : null,
    otherAgentDecisionsToday: others, budgetUsedToday: used, decisionLimitForThisRun: used!.decision + 1,
    transactionsThisTurnMaySend: "at most 1: pema.<relayer> -> market contract `bid` {token_id: mango}. Scope=agents skips settlement, rent, Guild, other merchants' orders, merchant trades, residents (Lin, Dev), tourists, harbor and kitchen.",
  };
  report.preflight = pre;
  console.log(JSON.stringify(pre, null, 1));
  if (!band) stop("Pema has no decision to make right now (closed or no bid)");
  if (prior) stop("Pema already has a decision for this market day: the guard would replay it, not decide; run in the next market day");
  if (others.length) stop(`other agents have decisions today: ${others.join(", ")}`);
  return { day, budget: used!.decision + 1, band: { min: band!.min, max: band!.max }, secondsLeft };
}

const pre = await preflight();
if (!yes) { console.log("\nPREFLIGHT ONLY: nothing was sent. Re-run with --yes for the controlled run."); process.exit(0); }
if (pre.secondsLeft < 120) stop("less than 2 minutes left in this market day; run again at the start of the next one");

// ------------------------------------------------------------------ the turn ----
process.env.NEAR_AI_DAILY_DECISIONS = String(pre.budget);
const usedBefore = Number((await store.get(budgetKey("decision", Date.now()))) ?? 0);
allowSend = true;
const r = await handle("market-turn", new Request("http://localhost/api/near/market-turn?scope=agents", { method: "POST", headers: { authorization: `Bearer ${secret}` }, body: "{}" }), process.env as Record<string, string | undefined>);
allowSend = false;
const turn = (await r.json()) as { status?: string; log?: string[]; txHashes?: string[]; agents?: unknown; message?: string };
report.turn = { http: r.status, status: turn.status, log: turn.log, txHashes: turn.txHashes, agents: turn.agents, message: turn.message, sentTransactions: sentTxs, decisionRequests: seen.decisions };
console.log("\n--- turn ---\n", JSON.stringify(report.turn, null, 1));
if (r.status !== 200 || turn.status !== "onchain") stop(`turn did not run: ${r.status} ${turn.status ?? ""} ${turn.message ?? ""}`);
if (dayNow() !== pre.day) stop("the market day changed during the turn");

// ------------------------------------------------------------------ checks ----
const d = await decisionFor(store, "pema", pre.day);
if (!d) stop("no Pema decision was stored");
const dec = d!;
const usedAfter = Number((await store.get(budgetKey("decision", Date.now()))) ?? 0);
const others = (await Promise.all(AGENTS.filter((a) => a !== "pema").map(async (a) => [a, await decisionFor(store, a, pre.day)] as const))).filter(([, x]) => x !== null).map(([a]) => a);
const offersAfter = await view<OfferRow[]>("get_offers", {});
const bidNow = offersAfter.find((o) => o.merchant === "pema" && o.side === "bid" && o.token_id === "mango") ?? null;
let confirmation: unknown = null;
if (dec.txHash) {
  const tx = await provider.viewTransactionStatus({ txHash: dec.txHash, accountId: pemaAcct, waitUntil: "FINAL" } as never) as unknown as { status?: Record<string, unknown>; transaction?: { signer_id?: string; receiver_id?: string } };
  confirmation = { status: tx.status && "SuccessValue" in tx.status ? "SuccessValue" : tx.status, signer: tx.transaction?.signer_id, receiver: tx.transaction?.receiver_id, explorer: `https://testnet.nearblocks.io/txns/${dec.txHash}` };
}
const kind = dec.source !== "ai" ? "deterministic fallback (rule price)" : dec.txHash ? "NEAR AI decision carried out by a confirmed transaction" : "NEAR AI decision, no transaction needed (the posted bid already matched)";
report.decision = {
  classification: kind, source: dec.source, action: dec.action, model: dec.model, confidence: dec.confidence, probabilities: dec.probabilities,
  decisionId: dec.receipt.id, receiptStatus: dec.receipt.status, evidenceHashes: dec.receipt.evidence ? { request: dec.receipt.evidence.requestHash, response: dec.receipt.evidence.responseHash } : null,
  basePrice: dec.basePrice, price: dec.price, band: (report.preflight as { band: unknown }).band, justification: dec.justification, fallbackReason: dec.fallbackReason,
  txHash: dec.txHash, confirmation, postedBidAfter: bidNow ? { price: Number(bidNow.price), qty: Number(bidNow.qty) } : null,
  paidDecisionRequests: seen.decisions, budgetCounter: { before: usedBefore, after: usedAfter }, otherAgentDecisionsToday: others,
};
console.log("\n--- decision ---\n", JSON.stringify(report.decision, null, 1));
if (seen.decisions > 1) stop("more than one decision request");
if (others.length) stop(`other agents decided: ${others.join(", ")}`);
if (sentTxs.length > 1) stop("more than one transaction");
if (dec.txHash && sentTxs.length !== 1) stop("a transaction hash was stored but the guard saw no transaction");
if (dec.source === "ai" && dec.txHash && (!bidNow || Number(bidNow.price) !== dec.price)) stop("the posted bid does not match the decision price");
if (dec.price < pre.band.min || dec.price > pre.band.max) stop("the decision price is outside the band");
save();

// the game's own endpoint (the same handler production serves)
const ep = await handle("decisions", new Request("http://localhost/api/near/decisions?merchant=pema"), process.env as Record<string, string | undefined>);
const epBody = (await ep.json()) as { decisions?: Record<string, unknown>[] };
const top = epBody.decisions?.[0] ?? null;
report.endpoint = { http: ep.status, count: epBody.decisions?.length ?? 0, top: top && { source: top.source, action: top.action, price: top.price, model: top.model, txHash: top.txHash, live: top.live, receipt: { id: (top.receipt as { id?: string })?.id, status: (top.receipt as { status?: string })?.status } } };
console.log("\n--- game endpoint ---\n", JSON.stringify(report.endpoint, null, 1));
if (ep.status !== 200 || !top || top.txHash !== dec.txHash || top.price !== dec.price) stop("the decision endpoint does not match the stored decision");

const memToday = (await readMemory(store, "pema")).find((x) => x.day === pre.day) ?? null;
report.memoryAfterTurn = memToday;
if (!memToday || !memToday.decision || memToday.decision.action !== dec.action || memToday.decision.txHash !== dec.txHash) stop("memory does not hold today's decision");
console.log("\n--- memory (today) ---\n", JSON.stringify(memToday, null, 1));
save();

// ------------------------------------------------------------------ signature check (reads only, no inference) ----
if (dec.source === "ai" && dec.receipt.status === "pending" && dec.receipt.id && dec.receipt.evidence) {
  allowSignatureReads = true;
  for (let k = 0; k < 3; k++) {
    await new Promise((res) => setTimeout(res, 15_000));
    const v = await verifyStored(store, "pema", pre.day, (id, ev) => verifyDecision(ai.url, ai.key!, id, ev, fetch as never));
    report.verification = v ? { status: v.receipt.status, note: v.receipt.note, signer: v.receipt.signer, attempts: v.receipt.attempts } : "nothing due";
    console.log("\n--- signature check ---\n", JSON.stringify(report.verification));
    if (!v || v.receipt.status !== "pending") break;
  }
  allowSignatureReads = false;
  save();
}

// ------------------------------------------------------------------ next market day: close the memory row (no tx) ----
const wait = MARKET_DAY_MS - (Date.now() % MARKET_DAY_MS) + 5_000;
console.log(`\nwaiting ${Math.round(wait / 1000)} s for the next market day to close Pema's memory row (no transaction)...`);
await new Promise((res) => setTimeout(res, wait));
const block = Number(((await provider.viewBlock({ finality: "final" } as never)) as unknown as { header: { height: number } }).header.height);
const st2 = await chainEconomy(provider, cfg);
const m2 = st2.merchants.pema;
const log: string[] = [];
await recordMemories(store, dayNow(), new Map([["pema", { day: dayNow(), block, coin: m2.cash, goods: { ...m2.stock }, open: m2.status === "open" }]]), (id) => view(`get_receipts`, { account_id: `${id}.${cfg.relayerId}` }), log);
const closed = (await readMemory(store, "pema")).find((x) => x.day === pre.day) ?? null;
report.memoryClosed = { row: closed, log, pemaNow: { till: m2.cash, mangoes: m2.stock.mango, open: m2.status === "open" } };
console.log("\n--- memory (closed) ---\n", JSON.stringify(report.memoryClosed, null, 1));
if (!closed?.outcome) stop("the memory row did not close");
report.network = seen;
report.result = "completed";
save();
console.log(`\nDONE. Evidence: ${evidencePath}. Network: ${JSON.stringify(seen)}`);
