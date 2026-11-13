// Run: node server/near/agent.check.ts   (Node 24 strips the types natively)
// Mocked-response tests for the merchant decision service. No network, no model call, no credits, no chain.
import assert from "node:assert/strict";
import { initialEconomy } from "../../src/economy/state.ts";
import { RESIDENTS, planResident, type Offer as ResOffer } from "../../src/economy/residents.ts";
import { MIN_CONFIDENCE, LEVERS, applyLivePrices, livePrices, priceMoved, agentConfig, decideResident, decisionKey, attachTx, bandFor, claimBidSend, decideBid, decisionFor, parseAnswer, recentDecisions, releaseBidSend, stateFor, type AgentConfig, type BookOffer, type DecisionStore, type FetchLike } from "./agent.ts";

const cfg: AgentConfig = agentConfig({ NEAR_AGENT_MERCHANTS: "pema", NEAR_AI_KEY: "test-key-not-real" });
const offers: BookOffer[] = [{ merchant: "tomas", token_id: "mango", side: "ask", qty: "20", price: "6" }];
const DAY = 7;

/** A shared store like Upstash: several "instances" use the same one; fail() simulates Redis being down. */
function memStore(): DecisionStore & { down: boolean; data: Map<string, string> } {
  const data = new Map<string, string>();
  const s = {
    down: false, data,
    get: async (k: string) => { if (s.down) throw new Error("down"); return data.get(k) ?? null; },
    setNx: async (k: string, v: string) => { if (s.down) throw new Error("down"); if (data.has(k)) return false; data.set(k, v); return true; },
    set: async (k: string, v: string) => { if (s.down) throw new Error("down"); data.set(k, v); },
    del: async (k: string) => { if (s.down) throw new Error("down"); data.delete(k); },
    incr: async (k: string) => { if (s.down) throw new Error("down"); const n = Number(data.get(k) ?? 0) + 1; data.set(k, String(n)); return n; },
  };
  return s;
}
let store = memStore();
const resetDecisions = (): void => { store = memStore(); };

const stall = () => {
  const st = initialEconomy();
  Object.assign(st.merchants.pema, { status: "open", cash: 30, stock: { mango: 4, lemon: 0, lassi: 0 } });
  return st;
};
const reply = (answer: unknown, id: string | null = "gen-123", status = 200): FetchLike => async () => ({
  ok: status < 400, status, headers: { get: (k: string) => (k.toLowerCase() === "x-generation-id" ? id : null) },
  json: async () => ({ id: "resp-1", model: "typesafe/jev-1.13", answers: { bid_action: answer } }),
});
const choice = (c: string, confidence = 0.9) => ({ type: "choice", choice: c, confidence, probabilities: { raise: 0.1, hold: 0.1, lower: 0.1, [c]: confidence } });
let calls = 0;
const counting = (f: FetchLike): FetchLike => async (...a) => { calls++; return f(...a); };
const decide = (st = stall(), f: FetchLike = reply(choice("raise")), c = cfg) => decideBid({ store, cfg: c, st, id: "pema", offers, day: DAY, fetchImpl: counting(f), now: () => 1000, sleep: async () => undefined });

// The band comes from the economy's own rules.
{
  const st = stall();
  const band = bandFor(st, "pema", offers)!;
  assert.ok(band, "an open stall with a bid has a band");
  assert.equal(band.raise === null || band.raise === band.base + 1, true);
  assert.equal(band.lower === null || band.lower === band.base - 1, true);
  assert.ok(band.min >= 1 && band.max >= band.base - 1, `band ${JSON.stringify(band)}`);
  const s = stateFor(st, "pema", offers, band, DAY);
  assert.equal(s.mangoes_on_shelf, 4); assert.equal(s.till_coins, 30); assert.equal(s.cheapest_rival_mango_ask_coins, 6);
  assert.ok(!JSON.stringify(s).includes("test-key"), "no secret reaches the model");
  Object.assign(st.merchants.pema, { status: "closed" });
  assert.equal(bandFor(st, "pema", offers), null, "a closed stall has no judgement call");
}

// 1. Valid answer: the chosen step is applied inside the band, with model identity, receipt id and facts recorded.
{
  resetDecisions(); calls = 0;
  const st = stall(), band = bandFor(st, "pema", offers)!;
  const act = band.raise !== null ? "raise" : "hold";
  const o = await decide(st, reply(choice(act)));
  assert.equal(calls, 1);
  assert.ok(o.decision && !o.duplicate);
  assert.equal(o.decision.source, "ai"); assert.equal(o.decision.action, act);
  assert.equal(o.price, act === "raise" ? band.raise : band.base);
  assert.equal(o.decision.model, "typesafe/jev-1.13"); assert.equal(o.decision.receipt.id, "gen-123");
  assert.equal(o.decision.receipt.status, "unverified", "a receipt id is never presented as verified");
  assert.ok(o.decision.justification.length >= 3 && o.decision.justification.join(" ").includes("4 of "));
  assert.ok(o.decision.line.includes(String(o.price)));
  assert.equal(o.decision.txHash, null);
  await attachTx(store, "pema", DAY, "TXHASH123");
  assert.equal((await decisionFor(store, "pema", DAY))?.txHash, "TXHASH123");
  assert.equal((await recentDecisions(store, "pema", DAY))[0].txHash, "TXHASH123");
}

// 2. Lower and hold map to their prices too.
{
  const st = stall(), band = bandFor(st, "pema", offers)!;
  resetDecisions();
  const h = await decide(st, reply(choice("hold")));
  assert.equal(h.price, band.base); assert.equal(h.decision?.action, "hold");
  if (band.lower !== null) { resetDecisions(); const l = await decide(st, reply(choice("lower"))); assert.equal(l.price, band.lower); }
}

// 3. Duplicate request for the same market day: no second model call, same decision, same price.
{
  resetDecisions(); calls = 0;
  const a = await decide(stall(), reply(choice("hold")));
  const b = await decide(stall(), reply(choice("raise"))); // would differ if it were asked again
  assert.equal(calls, 1, "the model is asked once per merchant per market day");
  assert.ok(b.duplicate); assert.equal(b.price, a.price); assert.equal(b.decision?.action, a.decision?.action);
  // a new market day is a new decision
  const c = await decideBid({ store, cfg, st: stall(), id: "pema", offers, day: DAY + 1, fetchImpl: counting(reply(choice("hold"))) });
  assert.ok(!c.duplicate); assert.equal(calls, 2);
}

// 4. Invalid answers fall back to the deterministic price: unknown action, refusal, wrong type, missing answer, junk.
for (const [name, bad] of [["unknown action", { type: "choice", choice: "double", confidence: 0.9 }], ["refusal", { type: "refusal" }], ["wrong type", { type: "noul", noul: 0.9 }], ["no answer", undefined], ["null", null]] as const) {
  resetDecisions();
  const st = stall(), base = bandFor(st, "pema", offers)!.base;
  const o = await decide(st, reply(bad));
  assert.equal(o.price, base, `${name}: deterministic price`);
  assert.equal(o.decision?.source, "fallback", name); assert.equal(o.decision?.model, null, `${name}: no model identity claimed`);
  assert.equal(o.decision?.receipt.id, null); assert.ok(o.decision?.fallbackReason, name);
}
assert.equal(parseAnswer({ answers: { bid_action: { type: "choice", choice: "raise", confidence: 7 } } }, null, "m").confidence, null, "an out-of-range confidence is dropped, not trusted");

// 5. Low confidence holds (still the model's answer, recorded as such).
{
  resetDecisions();
  const st = stall(), base = bandFor(st, "pema", offers)!.base;
  const o = await decide(st, reply(choice("raise", MIN_CONFIDENCE - 0.2)));
  assert.equal(o.price, base); assert.equal(o.decision?.action, "hold"); assert.equal(o.decision?.source, "ai");
  assert.match(o.decision!.fallbackReason!, /confidence/);
}

// 6. Insufficient funds: the till cannot afford a raise, so a "raise" answer is refused and the price is unchanged.
{
  resetDecisions();
  const st = stall();
  Object.assign(st.merchants.pema, { cash: 0 });
  const band = bandFor(st, "pema", offers)!;
  assert.equal(band.raise, null, "an empty till cannot raise");
  const o = await decide(st, reply(choice("raise")));
  assert.equal(o.price, band.base); assert.equal(o.decision?.source, "fallback"); assert.match(o.decision!.fallbackReason!, /not permitted/);
}

// 7. Limits: a raise above the cheapest rival ask, or a lower below the floor, is refused.
{
  resetDecisions();
  const st = stall();
  const tight: BookOffer[] = [{ merchant: "tomas", token_id: "mango", side: "ask", qty: "20", price: "1" }];
  const band = bandFor(st, "pema", tight)!;
  assert.equal(band.raise, null, "never bid above the cheapest rival ask");
  const o = await decideBid({ store, cfg, st, id: "pema", offers: tight, day: DAY, fetchImpl: reply(choice("raise")) });
  assert.equal(o.price, band.base);
  resetDecisions();
  const st2 = stall();
  st2.merchants.pema.baseCost.mango = 2; // floor = 1
  const b2 = bandFor(st2, "pema", offers);
  if (b2 && b2.lower === null) { const o2 = await decide(st2, reply(choice("lower"))); assert.equal(o2.price, b2.base); }
}

// 8. Timeout and transient failure: retried once, then the deterministic price; a 4xx is not retried.
{
  const timeout: FetchLike = async () => { const e = new Error("timed out"); e.name = "TimeoutError"; throw e; };
  resetDecisions(); calls = 0;
  const a = await decide(stall(), timeout);
  assert.equal(calls, 2, "one retry after a timeout"); assert.equal(a.decision?.source, "fallback"); assert.match(a.decision!.fallbackReason!, /timeout/);
  resetDecisions(); calls = 0;
  const b = await decide(stall(), reply(choice("raise"), null, 503));
  assert.equal(calls, 2, "5xx is retried once"); assert.equal(b.decision?.source, "fallback");
  resetDecisions(); calls = 0;
  const c = await decide(stall(), reply(choice("raise"), null, 401));
  assert.equal(calls, 1, "4xx is not retried"); assert.equal(c.decision?.source, "fallback"); assert.match(c.decision!.fallbackReason!, /401/);
}

// 9. Retry that succeeds: first call fails, second answers.
{
  resetDecisions(); calls = 0;
  let n = 0;
  const flaky: FetchLike = async (...a) => { if (n++ === 0) throw new Error("connection reset"); return reply(choice("hold"))(...a); };
  const o = await decide(stall(), flaky);
  assert.equal(calls, 2); assert.equal(o.decision?.source, "ai"); assert.equal(o.decision?.action, "hold");
}

// 10. Off by default and per merchant: no key, an empty allow-list or another merchant never asks the model.
{
  resetDecisions(); calls = 0;
  const noKey = agentConfig({ NEAR_AGENT_MERCHANTS: "pema" });
  const a = await decide(stall(), reply(choice("raise")), noKey);
  assert.equal(calls, 0); assert.equal(a.decision?.source, "fallback"); assert.match(a.decision!.fallbackReason!, /no_key/);
  resetDecisions(); calls = 0;
  const off = await decide(stall(), reply(choice("raise")), agentConfig({ NEAR_AI_KEY: "k" }));
  assert.equal(calls, 0); assert.equal(off.decision, null, "disabled: the tick behaves exactly as before");
  const tomas = await decideBid({ store, cfg, st: stall(), id: "tomas", offers, day: DAY, fetchImpl: counting(reply(choice("raise"))) });
  assert.equal(calls, 0); assert.equal(tomas.decision, null, "only enabled merchants decide");
}

// 11. The request that would be sent: documented schema, the key only in the header, only chain facts in the state.
{
  resetDecisions();
  let seen: { url: string; headers: Record<string, string>; body: { model: string; state: Record<string, unknown>; questions: Record<string, { type: string; criteria: Record<string, string> }> } } | null = null;
  const spy: FetchLike = async (url, init) => { seen = { url, headers: init.headers, body: JSON.parse(init.body) }; return reply(choice("hold"))(url, init); };
  await decide(stall(), spy);
  assert.equal(seen!.url, "https://cloud-api.near.ai/v1/systemone");
  assert.equal(seen!.body.model, "typesafe/jev-1.13");
  assert.equal(seen!.headers.authorization, "Bearer test-key-not-real");
  assert.ok(!JSON.stringify(seen!.body).includes("test-key"));
  const q = seen!.body.questions.bid_action;
  assert.equal(q.type, "choice"); assert.deepEqual(Object.keys(q.criteria).sort(), ["hold", "lower", "raise"]);
  assert.equal(seen!.body.state.mangoes_on_shelf, 4);
}

// 12. Persistence: a "restarted" instance (fresh module state, same Redis) sees the stored decision and asks nothing.
{
  resetDecisions(); calls = 0;
  const first = await decide(stall(), reply(choice("hold")));
  const after = await decide(stall(), reply(choice("raise"))); // a new instance would call decide() again: same store
  assert.equal(calls, 1, "one model call per merchant per market day, across restarts");
  assert.ok(after.duplicate && after.price === first.price && !after.skipBid);
  assert.ok([...store.data.keys()].every((k) => k.startsWith("vivolith:agent:pema:")), "keys are namespaced per merchant and day");
}

// 13. Concurrent ticks: both start together; exactly one asks the model, the other waits for that result and skips the bid.
{
  resetDecisions(); calls = 0;
  const slow: FetchLike = async (...a) => { await new Promise((r) => setTimeout(r, 30)); return reply(choice("hold"))(...a); };
  let waits = 0;
  const run = () => decideBid({ store, cfg, st: stall(), id: "pema", offers, day: DAY, fetchImpl: counting(slow), now: () => 1000, sleep: async () => { waits++; await new Promise((r) => setTimeout(r, 20)); } });
  const [a, b] = await Promise.all([run(), run()]);
  assert.equal(calls, 1, "the model is asked once for two concurrent ticks");
  const winner = a.duplicate ? b : a, loser = a.duplicate ? a : b;
  assert.ok(!winner.duplicate && !winner.skipBid, "the winner posts the bid");
  assert.ok(loser.duplicate && loser.skipBid, "the other tick does not post a bid");
  assert.equal(loser.price, winner.price); assert.ok(waits >= 1);
  assert.equal(store.data.has(decisionKey("pema", DAY) + ":lock"), false, "the lock is released");
}

// 14. A lock that never resolves (the other tick crashed): wait, then skip the bid this turn, no model call.
{
  resetDecisions(); calls = 0;
  store.data.set(decisionKey("pema", DAY) + ":lock", "1");
  const o = await decideBid({ store, cfg, st: stall(), id: "pema", offers, day: DAY, fetchImpl: counting(reply(choice("raise"))), sleep: async () => undefined, waitSteps: 3 });
  assert.equal(calls, 0); assert.ok(o.skipBid && o.decision === null);
  assert.equal(o.price, bandFor(stall(), "pema", offers)!.base, "deterministic price");
}

// 15. Redis down: no idempotency guarantee, so no model call and the plain rule price, exactly as before the agent.
{
  resetDecisions(); calls = 0;
  store.down = true;
  const o = await decide(stall(), reply(choice("raise")));
  assert.equal(calls, 0); assert.equal(o.decision, null); assert.ok(!o.skipBid);
  assert.equal(o.price, bandFor(stall(), "pema", offers)!.base);
}

// 16. Bid send claim: of concurrent ticks exactly one may send the transaction; a failed send is released for a retry.
{
  resetDecisions();
  const claims = await Promise.all([1, 2, 3, 4].map(() => claimBidSend(store, "pema", DAY)));
  assert.equal(claims.filter(Boolean).length, 1, "one bid transaction per merchant per market day");
  assert.equal(await claimBidSend(store, "pema", DAY + 1), true, "a new market day is a new claim");
  await releaseBidSend(store, "pema", DAY);
  assert.equal(await claimBidSend(store, "pema", DAY), true, "released after a failed send, the retry may go");
}

// ---- every agent: the other three merchants -------------------------------------------------------------------------
const allCfg: AgentConfig = agentConfig({ NEAR_AGENT_MERCHANTS: "pema,tomas,mira,arin,picker,porter", NEAR_AI_KEY: "test-key-not-real" });
const openAll = () => {
  const st = initialEconomy();
  for (const id of ["pema", "tomas", "mira", "arin"] as const) Object.assign(st.merchants[id], { status: "open", cash: 40 });
  Object.assign(st.merchants.pema, { stock: { mango: 4, lemon: 0, lassi: 0 } });
  Object.assign(st.merchants.tomas, { stock: { mango: 200, lemon: 10, lassi: 0 } }); // a glut: the only time Mira bids
  Object.assign(st.merchants.mira, { stock: { mango: 2, lemon: 2, lassi: 0 } });
  Object.assign(st.merchants.arin, { stock: { mango: 1, lemon: 0, lassi: 6 } });
  return st;
};
const book: BookOffer[] = [{ merchant: "tomas", token_id: "mango", side: "ask", qty: "30", price: "7" }];

for (const id of ["pema", "tomas", "mira", "arin"] as const) {
  resetDecisions();
  const st = openAll();
  const lever = LEVERS[id];
  const band = bandFor(st, id, book);
  assert.ok(band, `${id} has a ${lever.side} band on ${lever.good}`);
  const want = band.raise !== null ? "raise" : "hold";
  const o = await decideBid({ store, cfg: allCfg, st, id, offers: book, day: DAY, fetchImpl: reply(choice(want)), now: () => 1 });
  assert.ok(o.decision && o.decision.source === "ai", `${id}: a real decision is recorded as ai`);
  assert.equal(o.decision.lever, `${lever.side}:${lever.good}`); assert.equal(o.decision.kind, "price");
  assert.equal(o.price, want === "raise" ? band.raise : band.base, `${id}: price from the band`);
  assert.ok(o.price >= band.min && o.price <= Math.max(band.max, band.base), `${id}: inside the band`);
  assert.ok(decisionKey(id, DAY).includes(`:${id}:${lever.side}:${lever.good}:`), "per-agent, per-lever key");
  resetDecisions();
  const st2 = openAll(); Object.assign(st2.merchants[id], { cash: 0 });
  const b2 = bandFor(st2, id, book);
  if (b2 && b2.raise === null) { const o2 = await decideBid({ store, cfg: allCfg, st: st2, id, offers: book, day: DAY, fetchImpl: reply(choice("raise")) }); assert.equal(o2.price, b2.base); assert.equal(o2.decision?.source, "fallback"); }
}
{ // Tomas's lever is an ask: it needs stock, and only moves a selling price
  const st = openAll();
  assert.equal(LEVERS.tomas.side, "ask");
  Object.assign(st.merchants.tomas, { stock: { mango: 0, lemon: 0, lassi: 0 } });
  assert.equal(bandFor(st, "tomas", book), null, "nothing to sell: no price to set");
  const ok = openAll(), band = bandFor(ok, "tomas", book)!;
  assert.ok(band.max <= Math.ceil(ok.merchants.tomas.baseCost.mango * 4) && band.min >= Math.ceil(ok.merchants.tomas.baseCost.mango * 0.8));
}
{ // a closed agent never decides
  const st = openAll(); Object.assign(st.merchants.mira, { status: "closed" });
  calls = 0; resetDecisions();
  const o = await decideBid({ store, cfg: allCfg, st, id: "mira", offers: book, day: DAY, fetchImpl: counting(reply(choice("raise"))) });
  assert.equal(calls, 0); assert.equal(o.decision, null);
}

// ---- residents: where to sell, where to eat -------------------------------------------------------------------------
const lin = RESIDENTS[0]; // picker: mangoes, eats lassi
const racks: ResOffer[] = [
  { merchant: "pema", account_id: "pema.x.testnet", token_id: "mango", side: "bid", qty: "10", price: "5" },
  { merchant: "arin", account_id: "arin.x.testnet", token_id: "mango", side: "bid", qty: "10", price: "4" },
  { merchant: "arin", account_id: "arin.x.testnet", token_id: "lassi", side: "ask", qty: "6", price: "8" },
  { merchant: "tomas", account_id: "tomas.x.testnet", token_id: "lassi", side: "ask", qty: "6", price: "9" },
];
const planReply = (sell: string, meal: string, conf = 0.9): FetchLike => async () => ({
  ok: true, status: 200, headers: { get: (k: string) => (k.toLowerCase() === "x-generation-id" ? "gen-res-1" : null) },
  json: async () => ({ model: "typesafe/jev-1.13", answers: { sell_to: choice(sell, conf), meal_from: choice(meal, conf) } }),
});
const rdecide = (f: FetchLike, o: { offers?: ResOffer[]; coin?: number; holding?: number; res?: typeof lin } = {}) =>
  decideResident({ store, cfg: allCfg, res: o.res ?? lin, offers: o.offers ?? racks, coin: o.coin ?? 0, holding: o.holding ?? 6, day: DAY, fetchImpl: counting(f), now: () => 1, sleep: async () => undefined });
{ // valid: the model prefers Arin's bid (not the rule's best price): honoured, recorded as ai, persisted
  resetDecisions(); calls = 0;
  const rule = planResident(lin, racks, 0, 6);
  assert.equal(rule.sell?.merchant, "pema", "the rule sells to the best bid");
  const o = await rdecide(planReply("arin", "arin"));
  assert.equal(calls, 1); assert.equal(o.decision?.source, "ai"); assert.equal(o.decision?.kind, "plan");
  assert.equal(o.plan.sell?.merchant, "arin"); assert.equal(o.plan.sell?.qty, 6); assert.equal(o.plan.sell?.price, 4);
  assert.equal(o.plan.eat?.merchant, "arin"); assert.equal(o.plan.eat?.price, 8);
  assert.deepEqual(o.decision?.choices?.map((c) => [c.question, c.chosen, c.source]), [["sell_to", "arin", "ai"], ["meal_from", "arin", "ai"]]);
  assert.equal(o.decision?.receipt.status, "unverified");
  const again = await rdecide(planReply("pema", "tomas"));
  assert.equal(calls, 1, "one model call per resident per market day"); assert.ok(again.duplicate);
  assert.equal(again.plan.sell?.merchant, "arin"); assert.equal(again.plan.eat?.merchant, "arin");
}
{ // hold: keep the goods, no sale
  resetDecisions();
  const o = await rdecide(planReply("hold", "skip"), { coin: 0 });
  assert.equal(o.plan.sell, null); assert.equal(o.plan.eat, null); assert.equal(o.decision?.source, "ai");
}
{ // invented stall or option: refused, the deterministic plan is used and flagged as fallback
  resetDecisions();
  const rule = planResident(lin, racks, 0, 6);
  const o = await rdecide(planReply("mira", "nowhere"));
  assert.deepEqual(o.plan, rule); assert.equal(o.decision?.source, "fallback");
  assert.ok(o.decision?.choices?.every((c) => c.source === "fallback" && c.note));
}
{ // a meal the purse cannot pay: refused, never overspent
  resetDecisions();
  const o = await rdecide(planReply("hold", "tomas"), { coin: 1 });
  assert.equal(o.plan.eat, null, "1 c cannot buy a 9 c lassi");
  assert.equal(o.decision?.choices?.find((c) => c.question === "meal_from")?.source, "fallback");
}
{ // quantity is the real holding, capped by the bid: never invented
  resetDecisions();
  const o = await rdecide(planReply("pema", "skip"), { holding: 3 });
  assert.equal(o.plan.sell?.qty, 3);
  resetDecisions();
  const o2 = await rdecide(planReply("pema", "skip"), { holding: 50 });
  assert.equal(o2.plan.sell?.qty, 10, "capped by the bid's size");
}
{ // low confidence, refusal, timeout, 5xx: all land on exactly the deterministic plan
  const rule = planResident(lin, racks, 0, 6);
  const refuse: FetchLike = async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ answers: { sell_to: { type: "refusal" }, meal_from: null } }) });
  const timeout: FetchLike = async () => { const e = new Error("t"); e.name = "TimeoutError"; throw e; };
  for (const f of [planReply("arin", "arin", 0.2), refuse, timeout, reply(choice("raise"), null, 503)]) {
    resetDecisions();
    const o = await rdecide(f);
    assert.deepEqual(o.plan, rule); assert.equal(o.decision?.source, "fallback");
  }
}
{ // concurrent ticks for one resident: one model call
  resetDecisions(); calls = 0;
  const slow: FetchLike = async (...a) => { await new Promise((r) => setTimeout(r, 30)); return planReply("pema", "arin")(...a); };
  const run = () => decideResident({ store, cfg: allCfg, res: lin, offers: racks, coin: 0, holding: 6, day: DAY, fetchImpl: counting(slow), sleep: async () => { await new Promise((r) => setTimeout(r, 20)); } });
  const [a, b] = await Promise.all([run(), run()]);
  assert.equal(calls, 1); assert.ok([a, b].some((x) => x.skip) && [a, b].some((x) => !x.skip));
}
{ // Dev (lemons); Redis down; agent off; nothing posted
  resetDecisions(); calls = 0;
  const dev = RESIDENTS[1];
  const lemons: ResOffer[] = [{ merchant: "mira", account_id: "mira.x.testnet", token_id: "lemon", side: "bid", qty: "8", price: "2" }];
  const o = await rdecide(planReply("mira", "skip"), { res: dev, offers: lemons, holding: 4 });
  assert.equal(o.plan.sell?.merchant, "mira"); assert.equal(o.plan.sell?.qty, 4);
  store.down = true; calls = 0;
  const d = await rdecide(planReply("mira", "skip"), { res: dev, offers: lemons, holding: 4 });
  assert.equal(calls, 0); assert.equal(d.decision, null); assert.deepEqual(d.plan, planResident(dev, lemons, 0, 4));
  store.down = false; calls = 0;
  const off = await decideResident({ store, cfg: agentConfig({ NEAR_AI_KEY: "k" }), res: dev, offers: lemons, coin: 0, holding: 4, day: DAY, fetchImpl: counting(planReply("mira", "skip")) });
  assert.equal(calls, 0); assert.equal(off.decision, null);
  const none = await rdecide(planReply("mira", "skip"), { res: dev, offers: [], holding: 4 });
  assert.equal(calls, 0, "nothing posted: nothing to decide"); assert.equal(none.decision, null);
}

// ---- player-facing prices: live decisions only --------------------------------------------------------------------------
{
  resetDecisions();
  const st = openAll();
  const posted = (m: string, side: string, price: number, qty = "5"): BookOffer => ({ merchant: m, token_id: "mango", side, qty, price: String(price) });
  const put = async (id: "pema" | "tomas", o: { source: "ai" | "fallback"; tx: string | null; price: number; day?: number }) => {
    const base = await decideBid({ store, cfg: allCfg, st, id, offers: book, day: o.day ?? DAY, fetchImpl: reply(choice(o.source === "ai" ? "hold" : "raise"), "g"), now: () => 1 });
    const d = base.decision!;
    await store.set(decisionKey(id, o.day ?? DAY), JSON.stringify({ ...d, source: o.source, price: o.price, txHash: o.tx }), 100);
  };
  await put("pema", { source: "ai", tx: "TX1", price: 5 });
  assert.deepEqual(await livePrices(store, [posted("pema", "bid", 5)], DAY), [{ id: "pema", side: "bid", good: "mango", price: 5 }], "confirmed, posted at that price: live");
  assert.deepEqual(await livePrices(store, [posted("pema", "bid", 6)], DAY), [], "the order moved: the contract wins, no live price");
  assert.deepEqual(await livePrices(store, [posted("pema", "bid", 5, "0")], DAY), [], "a withdrawn order is not live");
  assert.deepEqual(await livePrices(store, [], DAY), [], "not posted");
  assert.deepEqual(await livePrices(store, [posted("pema", "bid", 5)], DAY + 1), [], "yesterday's decision is not today's price");
  await put("pema", { source: "ai", tx: null, price: 5 });
  assert.deepEqual(await livePrices(store, [posted("pema", "bid", 5)], DAY), [], "no confirmed transaction: not live");
  await put("pema", { source: "fallback", tx: "TX2", price: 5 });
  assert.deepEqual(await livePrices(store, [posted("pema", "bid", 5)], DAY), [], "a fallback is never presented as an AI price");
  await put("tomas", { source: "ai", tx: "TX3", price: 6 });
  const live = await livePrices(store, [posted("tomas", "ask", 6)], DAY);
  assert.deepEqual(live, [{ id: "tomas", side: "ask", good: "mango", price: 6 }]);
  // applying: flags set, stale ones removed, then the stale-reference check
  const eco = openAll(); eco.flags["agentPrice.mira.bid.mango"] = 3;
  applyLivePrices(eco, live);
  assert.equal(eco.flags["agentPrice.mira.bid.mango"], undefined); assert.equal(eco.flags["agentPrice.tomas.ask.mango"], 6);
  assert.equal(priceMoved(eco, "tomas", "buy", "mango", 6), null, "the screen used the live price: accepted");
  assert.equal(priceMoved(eco, "tomas", "buy", "mango", 5), 6, "a quote built on the older price is refused with the live one");
  assert.equal(priceMoved(eco, "tomas", "buy", "mango", 0), 6, "a screen with no agent price is refused too");
  assert.equal(priceMoved(eco, "tomas", "buy", "mango", null), null, "an older client sends no reference: existing bounds apply");
  assert.equal(priceMoved(eco, "tomas", "sell", "mango", 1), null, "a different side has no live price: untouched");
  assert.equal(priceMoved(eco, "pema", "sell", "mango", 1), null, "no live decision for this merchant: untouched");
}

console.log("agent decision checks passed");
