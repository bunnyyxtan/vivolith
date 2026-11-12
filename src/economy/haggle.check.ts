// Run: node src/economy/haggle.check.ts   (haggling is deterministic and personality matters)
import assert from "node:assert/strict";
import { initialEconomy } from "./state.ts";
import { agentPrice, agentPriceKey, bidFor, quote } from "./pricing.ts";
import { applyTactic, closeDeal, dealTotal, dealUnit, openHaggle, type HaggleSession } from "./haggle.ts";

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
console.log("haggle checks passed");
