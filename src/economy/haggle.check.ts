// Run: node src/economy/haggle.check.ts   (haggling is deterministic and personality matters)
import assert from "node:assert/strict";
import { initialEconomy } from "./state.ts";
import { agentPrice, agentPriceKey, bidFor, dealBounds, quote } from "./pricing.ts";
import { applyTactic, closeDeal, dealTotal, dealUnit, newcomerPrice, openHaggle, verifyDealUnit, type HaggleSession, type Tactic } from "./haggle.ts";

const open = (s: ReturnType<typeof initialEconomy>, id: "pema" | "tomas" | "arin"): HaggleSession => {
  const h = openHaggle(s, id);
  if ("error" in h) throw new Error(h.error);
  return h;
};

// Pema is proud: flattery lowers her price, mentioning Tomas (when she can pay rent) does not.
const a = initialEconomy();
a.merchants.pema.cash = 100;
const p = open(a, "pema");
const flat = applyTactic(a, p, "flatter");
assert.ok(flat.success && flat.session.unit < p.unit, "flatter should work on Pema");
assert.ok(!applyTactic(a, p, "rival").success, "rival should insult Pema");

// Tomas is greedy: flattery barely moves him, a cheaper rival does. Determinism: same input, same output.
const b = initialEconomy();
b.merchants.tomas.stock.mango = 10; // make Pema look cheap by comparison
b.merchants.pema.stock.mango = 30;
const t = open(b, "tomas");
const r1 = applyTactic(b, t, "rival"), r2 = applyTactic(b, t, "rival");
assert.deepEqual(r1, r2);
assert.ok(r1.session.unit <= applyTactic(b, t, "flatter").session.unit);

// Repeating a tactic stops working; patience runs out and the merchant walks.
let h = p;
for (let i = 0; i < 6 && !h.over; i++) h = applyTactic(a, h, "lowball").session;
assert.equal(h.over, "walked");
assert.equal(closeDeal(a, h).ok, false);
assert.ok("error" in openHaggle(a, "pema"), "Pema is locked for the day after walking out");

// A deal moves stock, coins and cash, and selling to Arin pays the player.
const c = initialEconomy();
const d = applyTactic(c, open(c, "tomas"), "fair").session;
const coins = c.player.coins;
const out = closeDeal(c, d);
assert.ok(out.ok && c.player.coins === coins - out.total && c.player.inventory.mango === d.qty);
const sell = applyTactic(c, open(c, "arin"), "fair").session;
const before = c.player.coins;
assert.ok(closeDeal(c, sell).ok && c.player.coins > before);

// The price shown is the price settled: whole coins per unit, rounded in the player's favour.
const frac = (mode: "buy" | "sell"): HaggleSession => ({ ...d, mode, unit: 3.67, qty: 3 });
assert.equal(dealUnit(frac("buy")), 3);
assert.equal(dealTotal(frac("buy")), 9);
assert.equal(dealTotal(frac("sell")), 12);

// A live NEAR AI price reaches the player: the quote, the haggle opening and the settled total all use it, and removing it
// returns exactly the rule price (the deterministic fallback).
{
  const st = initialEconomy();
  Object.assign(st.merchants.tomas, { status: "open", cash: 100, stock: { mango: 40, lemon: 0, lassi: 0 } });
  const rule = quote(st, "tomas", "mango").price;
  const ruleNpc = quote(st, "tomas", "mango", false).price;
  st.flags[agentPriceKey("tomas", "ask", "mango")] = rule + 2;
  assert.equal(agentPrice(st, "tomas", "ask", "mango"), rule + 2);
  assert.equal(quote(st, "tomas", "mango", false).price, rule + 2, "the NPC-facing quote is the posted AI price");
  const q = quote(st, "tomas", "mango");
  assert.ok(q.factors[0].label.includes("NEAR AI"), "the explanation says where the price came from");
  const h = open(st, "tomas");
  assert.equal(h.open, quote(st, "tomas", "mango").price, "haggling opens at the price the screen shows");
  const fair = structuredClone(h); fair.over = "deal";
  const out = closeDeal(structuredClone(st), fair);
  assert.ok(out.ok, out.ok ? "" : out.message);
  assert.equal(out.ok && out.total, quote(st, "tomas", "mango").price * fair.qty, "the executed total is the displayed price");
  delete st.flags[agentPriceKey("tomas", "ask", "mango")];
  assert.equal(quote(st, "tomas", "mango", false).price, ruleNpc, "no live decision: exactly the rule price");
  // an agent price cannot make a closed stall sell, or a stall that is not buying buy
  st.flags[agentPriceKey("tomas", "ask", "mango")] = 99; st.merchants.tomas.status = "closed";
  assert.equal(quote(st, "tomas", "mango", false).price, ruleNpc, "a closed stall ignores it");
  const sb = initialEconomy();
  sb.flags[agentPriceKey("tomas", "bid", "mango")] = 9;
  assert.equal(bidFor(sb, "tomas", "mango"), null, "Tomas never buys: an agent price cannot invent a bid");
  const pb = initialEconomy();
  Object.assign(pb.merchants.pema, { status: "open", stock: { mango: 2, lemon: 0, lassi: 0 } });
  const ruleBid = bidFor(pb, "pema", "mango")!;
  pb.flags[agentPriceKey("pema", "bid", "mango")] = ruleBid.price + 1;
  assert.equal(bidFor(pb, "pema", "mango")!.price, ruleBid.price + 1); assert.equal(bidFor(pb, "pema", "mango")!.qty, ruleBid.qty, "only the price moves");
}
// The relayer's price window: both sides, around the authoritative price, live AI price included.
{
  assert.deepEqual(dealBounds(6), { min: 3, max: 9 });
  assert.deepEqual(dealBounds(1), { min: 0, max: 2 });
  const st = initialEconomy();
  Object.assign(st.merchants.tomas, { status: "open", stock: { mango: 40, lemon: 0, lassi: 0 } });
  const base = quote(st, "tomas", "mango", false).price;
  st.flags[agentPriceKey("tomas", "ask", "mango")] = base + 3;
  const b = dealBounds(quote(st, "tomas", "mango", false).price);
  assert.ok(b.min > dealBounds(base).min, "the window follows the live AI price, not the old rule price");
  for (const unit of [b.min, base + 3, b.max]) assert.ok(unit >= b.min && unit <= b.max);
  assert.ok(0 < b.min && b.max < 10 * (base + 3), "no arbitrary client price fits: 1 c or 1000 c are outside");
  assert.ok(!(1000 >= b.min && 1000 <= b.max)); assert.ok(b.min > 1);
}

// Server-side price verification: the rule price needs no haggle; a better price needs a replayable haggle.
{
  const s = initialEconomy();
  const ref = quote(s, "tomas", "mango").price;
  assert.equal(verifyDealUnit(s, "tomas", "buy", "mango", ref, []).kind, "rule", "buying at the current price is fine");
  assert.equal(verifyDealUnit(s, "tomas", "buy", "mango", ref + 1, []).ok, true, "paying more is never refused here");
  const cheap = verifyDealUnit(s, "tomas", "buy", "mango", ref - 1, []);
  assert.ok(!cheap.ok && cheap.reference === ref, "a lower price with no haggle record is refused");
  // a real haggle (Pema buying mangoes from Kavi): play tactics, then the same price verifies; one coin better does not
  const sref = verifyDealUnit(s, "pema", "sell", "mango", 1, []).reference;
  const hs = initialEconomy(); hs.player.inventory.mango = 3; hs.player.coins = 99;
  let h = open(hs, "pema"); const played: Tactic[] = []; const probe = structuredClone(hs);
  for (const t of ["lowball", "flatter", "rival"] as const) { h = applyTactic(probe, h, t).session; played.push(t); }
  const won = dealUnit(h);
  assert.ok(won > sref, `the haggle beat the opening offer (${won} vs ${sref})`);
  assert.equal(verifyDealUnit(s, "pema", "sell", "mango", won, played).kind, "haggle", "a replayed haggle verifies");
  assert.ok(!verifyDealUnit(s, "pema", "sell", "mango", won + 1, played).ok, "one coin above the replay is refused");
  assert.ok(!verifyDealUnit(s, "pema", "sell", "mango", won, []).ok, "the same price without the tactics is refused");
  assert.ok(!verifyDealUnit(s, "tomas", "buy", "mango", 1, ["lowball", "lowball", "lowball", "lowball", "lowball", "lowball", "lowball", "lowball", "lowball"]).ok, "too many or unknown tactics are refused");
  assert.ok(!verifyDealUnit(s, "tomas", "buy", "mango", ref - 1, ["fair"]).ok, "fair is not a haggle move");
  // a live NEAR AI price becomes the reference
  const live = initialEconomy(); live.flags[agentPriceKey("tomas", "ask", "mango")] = ref + 3;
  const lref = quote(live, "tomas", "mango").price;
  assert.ok(lref !== ref && !verifyDealUnit(live, "tomas", "buy", "mango", lref - 1, []).ok, "the live price is the one to beat");
  assert.ok(verifyDealUnit(s, "pema", "sell", "mango", sref, []).ok && !verifyDealUnit(s, "pema", "sell", "mango", sref + 1, []).ok, "selling above the reference needs a haggle");
  // scripted first-day prices are only a candidate; the relayer still claims them once per player
  assert.equal(newcomerPrice("sell", "pema", 6, sref), "sell");
  assert.equal(newcomerPrice("sell", "pema", 9, sref), null);
  assert.equal(newcomerPrice("buy", "pema", ref - 1, ref), null);
}

console.log("haggle checks passed");
