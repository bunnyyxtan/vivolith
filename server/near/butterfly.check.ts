// Run: node server/near/butterfly.check.ts
// The economic butterfly effect, end to end on the game's own rules (offline: no chain, no network, no credits):
// a player's trade changes stock and tills -> the merchants' decision inputs change -> merchants decide (the deterministic
// rule, and the decision engine with a transparent STUB model standing in for Jev) -> a resident picks among the new
// offers -> a market day runs (shoppers, rent) -> the town reads differently -> the Chronicle links the evidence.
// The stub is NOT Jev: it is one generic policy, the same for every merchant, reading only the state Jev would be sent.
// Nothing here forces an outcome; the printed table is what the rules produced, and assertions check relationships
// (inputs differ, evidence links are correct, money is conserved), not hoped-for choices.
import assert from "node:assert/strict";
import { initialEconomy, type EconomyState, type MerchantId } from "../../src/economy/state.ts";
import { bidFor, dealBounds, quote, HAGGLE_FLOOR } from "../../src/economy/pricing.ts";
import { closeDeal, verifyDealUnit, type HaggleSession } from "../../src/economy/haggle.ts";
import { advance, recordRestock, tryReopen } from "../../src/economy/sim.ts";
import { RESIDENTS, planResident, type Offer } from "../../src/economy/residents.ts";
import { appendEvent, decisionEvent, eventId, gossipLine, provenance, type ChronicleEvent } from "../../src/economy/chronicle.ts";
import { agentConfig, bandFor, decideBid, decideResident, stateFor, type BookOffer, type DecisionStore, type FetchLike } from "./agent.ts";

const MERCHANTS: readonly MerchantId[] = ["pema", "tomas", "mira", "arin"];
const lin = RESIDENTS.find((r) => r.id === "picker")!;
const store = (): DecisionStore => {
  const d = new Map<string, string>();
  return { get: async (k) => d.get(k) ?? null, setNx: async (k, v) => (d.has(k) ? false : (d.set(k, v), true)), set: async (k, v) => { d.set(k, v); }, del: async (k) => { d.delete(k); }, incr: async (k) => { const n = Number(d.get(k) ?? 0) + 1; d.set(k, String(n)); return n; } };
};
const money = (s: EconomyState): number => s.player.coins + MERCHANTS.reduce((n, id) => n + s.merchants[id].cash, 0);

/** The game's own sell path (play.ts simpleDeal -> closeDeal), checked first with the relayer's rule (verifyDealUnit). */
function playerSells(s: EconomyState, id: MerchantId, qty: number, unit: number): number {
  assert.ok(verifyDealUnit(s, id, "sell", "mango", unit, [], 0).ok, `the relayer would sign ${unit} c to ${id}`);
  const b = bidFor(s, id, "mango")!; const bounds = dealBounds(b.price);
  assert.ok(unit >= bounds.min && unit <= bounds.max && s.merchants[id].cash >= qty * unit, `${unit} c is inside ${id}'s window and till`);
  const h: HaggleSession = { merchant: id, good: "mango", mode: "sell", qty, unit, open: unit, limit: unit, patience: 100, used: {}, history: [], moves: 0, over: "deal" };
  const out = closeDeal(s, h);
  assert.ok(out.ok, out.message);
  if (s.merchants[id].status !== "open") { recordRestock(s, id, qty); tryReopen(s, id); }
  return out.total;
}
/** The friend's price the trade panel offers a struggling stall (same formula as play.ts friendPrice). */
const friendPrice = (s: EconomyState, id: MerchantId): number | null => {
  const m = s.merchants[id], rule = bidFor(s, id, "mango")?.price ?? null;
  if (rule === null || m.status !== "open" || m.cash >= m.rent) return null;
  const f = Math.max(1, Math.floor(rule * HAGGLE_FLOOR), Math.min(rule - 1, quote(s, id, "mango", false).price - 1));
  return f < rule ? f : null;
};

/** STUB model (stands in for Jev; generic, identical for every merchant): reads only the posted state. */
const stub: FetchLike = async (_u, init) => {
  const s = (JSON.parse(init.body) as { state: Record<string, number | boolean | null> }).state;
  const shelf = Number(s.mangoes_on_shelf), normal = Number(s.mangoes_normally_stocked), till = Number(s.till_coins), rent = Number(s.rent_coins);
  const choice = shelf < normal * 0.5 && till > rent && s.raise_would_be_coins !== null ? "raise" : (shelf >= normal || till < rent) && s.lower_would_be_coins !== null ? "lower" : "hold";
  const body = JSON.stringify({ id: "stub", model: "STUB (not Jev)", answers: { bid_action: { type: "choice", choice, confidence: 0.9 } } });
  return { ok: true, status: 200, headers: { get: () => null }, json: async () => JSON.parse(body), text: async () => body };
};

/** Posted mango bids as the market turn would post them (lever price from the decision, others from the rule). */
function bookAfter(s: EconomyState, lever: Partial<Record<MerchantId, number>>): Offer[] {
  const out: Offer[] = [];
  for (const id of MERCHANTS) {
    const b = bidFor(s, id, "mango");
    if (!b) continue;
    const price = lever[id] ?? b.price;
    const qty = Math.min(b.qty, Math.floor(s.merchants[id].cash / Math.max(1, price)));
    if (qty > 0) out.push({ merchant: id, account_id: `${id}.x`, token_id: "mango", side: "bid", qty: String(qty), price: String(price) });
  }
  out.push({ merchant: "arin", account_id: "arin.x", token_id: "lassi", side: "ask", qty: String(s.merchants.arin.stock.lassi), price: String(quote(s, "arin", "lassi", false).price) });
  return out;
}

interface Run { name: string; bids: string; pemaAfterTrade: string; s: EconomyState; sold: { to: MerchantId; unit: number; total: number }; inputs: Record<string, Record<string, unknown>>; rule: Record<string, number | null>; stub: Record<string, string>; lin: string; after: Record<string, unknown>; events: ChronicleEvent[] }

async function scenario(name: string, to: MerchantId, unitOf: (s: EconomyState) => number, setup: (s: EconomyState) => void = () => undefined, qty = 3): Promise<Run> {
  const s = initialEconomy();
  setup(s);
  s.player.inventory.mango = 3;
  const before = money(s);
  const t0 = 1_000, day = 1;
  // 1-2. the player's choice (real rules: the relayer would sign it)
  const unit = unitOf(s);
  const total = playerSells(s, to, qty, unit);
  assert.equal(money(s), before, "a trade moves coins, it never creates them");
  const pemaAfterTrade = s.merchants.pema.status;
  let history: ChronicleEvent[] = appendEvent([], { id: eventId(t0, "trade"), at: t0, day, kind: "trade", actors: [to], player: "kavi.test", text: `A player sold ${qty} mango to ${s.merchants[to].name} at ${unit} c.`, changes: [{ who: to, good: "mango", delta: qty }, { who: to, good: "coin", delta: -total }, { who: "player", good: "coin", delta: total }], status: "offline", txHash: null, decision: null, since: [] });
  // 3. merchants re-read the market: the rule price, and the decision engine (STUB model) on the same inputs
  const offers: BookOffer[] = bookAfter(s, {}).map((o) => ({ merchant: o.merchant, token_id: o.token_id, side: o.side, qty: o.qty, price: o.price }));
  offers.push({ merchant: "tomas", token_id: "mango", side: "ask", qty: String(s.merchants.tomas.stock.mango), price: String(quote(s, "tomas", "mango", false).price) });
  const inputs: Run["inputs"] = {}, rule: Run["rule"] = {}, stubbed: Run["stub"] = {}, lever: Partial<Record<MerchantId, number>> = {};
  const cfg = agentConfig({ NEAR_AGENT_MERCHANTS: "pema,tomas,mira,arin", NEAR_AI_KEY: "stub" });
  for (const id of MERCHANTS) {
    const band = bandFor(s, id, offers);
    rule[id] = band?.base ?? null;
    if (!band) { stubbed[id] = "no decision (closed or nothing to price)"; continue; }
    inputs[id] = stateFor(s, id, offers, band, day);
    const out = await decideBid({ store: store(), cfg, st: s, id, offers, day, fetchImpl: stub, now: () => t0 + 100 });
    stubbed[id] = `${out.decision!.action} ${band.base} -> ${out.price}`;
    lever[id] = out.price;
    history = appendEvent(history, decisionEvent(id, s.merchants[id].name, history, { source: "ai", action: out.decision!.action, from: band.base, to: out.price, side: "bid", good: "mango", model: "STUB (not Jev)", decisionId: null, verification: "none", inputs: out.decision!.justification.slice(0, -1) }, null, day, t0 + 100 + MERCHANTS.indexOf(id), true));
  }
  // 4. Lin sells her day's mangoes into the bids that now exist (her decision engine, same STUB rule: best price)
  const book = bookAfter(s, lever);
  const bids = book.filter((o) => o.side === "bid").map((o) => `${o.merchant} ${o.qty}x${o.price}`).join(", ");
  const dec = await decideResident({ store: store(), cfg: agentConfig({ NEAR_AGENT_MERCHANTS: "picker" }), res: lin, offers: book, coin: 0, holding: lin.perDay, day, fetchImpl: stub });
  const plan = dec.plan.sell ? dec.plan : planResident(lin, book, 0, lin.perDay);
  if (plan.sell) {
    const m = s.merchants[plan.sell.merchant as MerchantId];
    m.stock.mango += plan.sell.qty; m.cash -= plan.sell.qty * plan.sell.price;
    history = appendEvent(history, { id: eventId(t0 + 200, "res"), at: t0 + 200, day, kind: "resident", actors: ["picker", plan.sell.merchant], player: null, text: `Lin sold ${plan.sell.qty} mangoes to ${m.name} at ${plan.sell.price} c.`, changes: [{ who: plan.sell.merchant, good: "mango", delta: plan.sell.qty }], status: "offline", txHash: null, decision: { source: "rule", action: `sell to ${plan.sell.merchant}`, from: null, to: null, model: null, decisionId: null, verification: "none", inputs: book.filter((o) => o.side === "bid").map((o) => `${o.merchant} bid ${o.price} c`) }, since: [] });
  }
  // 5. one market day runs on the offline rules (shoppers, merchant trades, rent at 21:00)
  advance(s, 24 * 60);
  const after = Object.fromEntries(MERCHANTS.map((id) => [id, { status: s.merchants[id].status, till: Math.floor(s.merchants[id].cash), mango: s.merchants[id].stock.mango, ask: quote(s, id, id === "arin" ? "lassi" : "mango", false).price, bid: bidFor(s, id, "mango")?.price ?? null }]));
  return { name, bids, pemaAfterTrade, s, sold: { to, unit, total }, inputs, rule, stub: stubbed, lin: plan.sell ? `${plan.sell.qty} -> ${plan.sell.merchant} at ${plan.sell.price} c` : "held (no bid)", after: { ...after, playerCoins: s.player.coins }, events: history };
}

// ---------------------------------------------------------------- 1 & 2: the player's two choices ----
const profit = await scenario("1. higher profit: sell 3 to Arin at his bid", "arin", (s) => bidFor(s, "arin", "mango")!.price);
const support = await scenario("2. support Pema: sell 3 at the friend's price", "pema", (s) => friendPrice(s, "pema")!);
assert.ok(profit.sold.total > support.sold.total, "the profitable choice earns the player more now");

// ---------------------------------------------------------------- 3: merchants respond to changed conditions ----
assert.notDeepEqual(profit.inputs.pema, support.inputs.pema, "Pema's decision inputs differ with the player's choice");
assert.notEqual(profit.inputs.pema.mangoes_on_shelf, support.inputs.pema?.mangoes_on_shelf ?? null);
// Measured: the rule bid PRICES are flat (Pema's restock price and Arin's fixed kitchen price do not move with stock);
// what the player's trade changes is how much each stall will still buy, i.e. the posted bid quantities.
assert.notDeepEqual(profit.bids, support.bids, "the posted bids (quantities) respond to the changed stock");
console.log(`rule bid prices after the trade: higher profit ${JSON.stringify(profit.rule)} | support ${JSON.stringify(support.rule)}${JSON.stringify(profit.rule) === JSON.stringify(support.rule) ? " (identical: prices are flat; quantities differ)" : ""}`);

// ---------------------------------------------------------------- 4: a resident reacts to the offers that exist ----
assert.ok(profit.lin !== support.lin || profit.rule.pema !== support.rule.pema, "Lin's market differs between the two towns");

// ---------------------------------------------------------------- 2b: a broke, closed stall (the real testnet case) ----
const closed = (s: EconomyState): void => { Object.assign(s.merchants.pema, { status: "closed", cash: 1 }); s.flags["reopenNeed.pema"] = 1; };
const rescue = await scenario("2b. Pema closed with 1 c: deliver at the only price she can pay", "pema", (s) => bidFor(s, "pema", "mango")!.price, closed, 1);
const elsewhere = await scenario("2c. Pema closed with 1 c: sell to Arin instead", "arin", (s) => bidFor(s, "arin", "mango")!.price, closed, 1);
assert.equal(rescue.sold.unit, 1, "a closed stall with 1 c can only bid 1 c (affordable reopen bid)");
assert.ok(rescue.sold.total < elsewhere.sold.total, "rescuing costs the player real money");

// ---------------------------------------------------------------- 3b: genuinely different valid conditions ----
// Scenarios 1 and 2 leave Pema's till under her rent either way, so the same generic policy chooses the same step for
// her in both (reported, not hidden). With her rent already covered the same policy, same code, chooses differently.
const covered = await scenario("3b. same delivery as 2, but Pema's rent is already covered (till 60 c)", "pema", (s) => friendPrice(s, "pema") ?? bidFor(s, "pema", "mango")!.price, (s) => { s.merchants.pema.cash = 60; });
assert.notEqual(covered.stub.pema, support.stub.pema, "different valid conditions give Pema a different decision");

// ---------------------------------------------------------------- 5 & 6: different outcomes, and the town shows them ----
const outcome = (r: Run) => r.after as Record<string, { status: string; till: number; mango: number; ask: number; bid: number | null }> & { playerCoins: number };
assert.notDeepEqual(outcome(profit).pema, outcome(support).pema, "Pema's day ends differently");
assert.equal(rescue.pemaAfterTrade, "open", "the 1 c delivery reopens Pema at once (the contract counts deliveries the same way)");
assert.equal(elsewhere.pemaAfterTrade, "closed", "selling to Arin leaves her shutters down for now");
assert.ok(outcome(profit).playerCoins > outcome(support).playerCoins, "the player's purse reflects the choice");

// ---------------------------------------------------------------- 7: the Chronicle shows the evidence, no more ----
for (const r of [profit, support]) {
  const trade = r.events.find((e) => e.kind === "trade")!;
  for (const e of r.events.filter((x) => x.kind === "decision")) {
    const touched = e.actors[0] === r.sold.to;
    assert.equal(e.since.includes(trade.id), touched, `${r.name}: ${e.actors[0]}'s decision links the player's trade only if that trade changed its stock`);
    assert.ok(provenance(e).startsWith("NEAR AI decision (STUB (not Jev)) · offline simulation"), "a stub decision is never shown as plain NEAR AI");
  }
  assert.ok(r.events.every((e) => !/because/i.test(e.text)), "no event claims a cause");
  assert.equal(provenance(trade), "Player action · offline simulation, not on NEAR");
  assert.ok(gossipLine(trade, (id) => id) !== null);
}

console.log("\nscenario | player sold | Pema rule bid / stub | Arin rule bid / stub | Lin sold | end of day: Pema | Arin | player coins");
for (const r of [profit, support, covered, rescue, elsewhere]) {
  const a = outcome(r);
  console.log(`${r.name}\n  Pema right after the trade: ${r.pemaAfterTrade} | bids posted: ${r.bids}\n  ${r.sold.total} c (${r.sold.unit} c each) | ${r.rule.pema ?? "-"} / ${r.stub.pema} | ${r.rule.arin ?? "-"} / ${r.stub.arin} | ${r.lin} | ${a.pema.status} till ${a.pema.till} mango ${a.pema.mango} | ${a.arin.status} till ${a.arin.till} | ${a.playerCoins}`);
}
// ---------------------------------------------------------------- the world remembers: bonds and Chronicle storage ----
{
  const { addBond, bondFacts, chronicle, readBonds, readChronicle, putDealRef, takeDealRef } = await import("./ledger.ts");
  const st = store(), noun = (g: string, n: number) => `${n} ${g === "mango" ? (n === 1 ? "mango" : "mangoes") : g}`;
  const delivery = { at: 1, day: 1, kind: "delivered" as const, good: "mango", qty: 3, unit: 3, reference: 4, evidence: "chain" as const, txHash: "tx1", note: null };
  await addBond(st, "pema", "kavi", delivery);
  await addBond(st, "pema", "kavi", delivery); // a retried relay
  await addBond(st, "pema", "kavi", { ...delivery, kind: "refused", unit: 9, reference: 4, evidence: "relayer", txHash: null, note: "won't pay more than 6 c" });
  const bonds = await readBonds(st, "pema", "kavi");
  assert.equal(bonds.length, 2, "one confirmed delivery (deduplicated by transaction) and one refused offer");
  const facts = bondFacts(bonds, noun);
  assert.match(facts[0], /^Fact \(recorded on NEAR\): this customer has delivered 3 mangoes to you in 1 sale\.$/);
  assert.match(facts[1], /^Interpretation: in 1 of those sales they accepted less than your own bid, which left 3 coins more/);
  assert.match(facts[2], /^Fact \(no trade happened\): an offer of 9 coins each/);
  assert.ok(!facts.join(" ").match(/friend|discount|promise|always/i), "no fabricated friendship or preferential pricing");
  await putDealRef(st, "kavi", "77", { merchant: "pema", side: "sell", token: "mango", qty: 3, unit: 3, reference: 4, closed: false });
  assert.equal((await takeDealRef(st, "kavi", "77"))?.reference, 4);
  const e = support.events[0];
  assert.equal(await chronicle(st, [e, e]), true);
  assert.equal(await chronicle(st, [e]), true);
  assert.equal((await readChronicle(st)).length, 1, "the same event is recorded once");
  await st.setNx("vivolith:chronicle:lock", "1", 10);
  assert.equal(await chronicle(st, [support.events[1]], async () => undefined), false, "a busy Chronicle skips the write instead of risking a wrong one");
}

console.log("\nbutterfly checks passed");
