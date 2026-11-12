// Run: node server/near/agent.check.ts   (Node 24 strips the types natively)
// Mocked-response tests for the merchant decision service. No network, no model call, no credits, no chain.
import assert from "node:assert/strict";
import { initialEconomy } from "../../src/economy/state.ts";
import { MIN_CONFIDENCE, agentConfig, attachTx, bandFor, claimBidSend, decideBid, decisionFor, parseAnswer, recentDecisions, releaseBidSend, stateFor, type AgentConfig, type BookOffer, type DecisionStore, type FetchLike } from "./agent.ts";

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
  assert.equal(store.data.has("vivolith:agent:pema:" + DAY + ":lock"), false, "the lock is released");
}

// 14. A lock that never resolves (the other tick crashed): wait, then skip the bid this turn, no model call.
{
  resetDecisions(); calls = 0;
  store.data.set("vivolith:agent:pema:" + DAY + ":lock", "1");
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

console.log("agent decision checks passed");
