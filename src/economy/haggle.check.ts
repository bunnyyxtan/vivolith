// Run: node src/economy/haggle.check.ts   (haggling is deterministic and personality matters)
import assert from "node:assert/strict";
import { initialEconomy } from "./state.ts";
import { agentPrice, agentPriceKey, bidFor, dealBounds, quote, restockCost } from "./pricing.ts";
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

// At the merchant's limit a tactic that would have worked moves nothing and is not reported as a win.
{
  const e = initialEconomy();
  const lim = { ...open(e, "tomas"), unit: open(e, "tomas").limit };
  const r = applyTactic(e, lim, "flatter");
  assert.equal(r.session.unit, lim.unit);
  assert.equal(r.success, false, "no 'you win' when the price cannot move");
  assert.match(r.line, /as low as I go/);
}

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
  // a real haggle (Arin buying mangoes from Kavi; Pema is capped at her resale price, below): play tactics, then the same price verifies; one coin better does not
  const sref = verifyDealUnit(s, "arin", "sell", "mango", 1, []).reference;
  const hs = initialEconomy(); hs.player.inventory.mango = 3; hs.player.coins = 99;
  let h = open(hs, "arin"); const played: Tactic[] = []; const probe = structuredClone(hs);
  for (const t of ["lowball", "rival"] as const) { h = applyTactic(probe, h, t).session; played.push(t); }
  const won = dealUnit(h);
  assert.ok(won > sref, `the haggle beat the opening offer (${won} vs ${sref})`);
  assert.equal(verifyDealUnit(s, "arin", "sell", "mango", won, played).kind, "haggle", "a replayed haggle verifies");
  assert.ok(!verifyDealUnit(s, "arin", "sell", "mango", won + 1, played).ok, "one coin above the replay is refused");
  assert.ok(!verifyDealUnit(s, "arin", "sell", "mango", won, []).ok, "the same price without the tactics is refused");
  // Pema resells what she buys: a haggle never pushes her over her own shelf price (she would lose on every mango)
  { const ps = initialEconomy(); ps.player.inventory.mango = 3; let ph = open(ps, "pema"); const pp = structuredClone(ps);
    for (const t of ["lowball", "flatter", "rival", "bundle"] as const) ph = applyTactic(pp, ph, t).session;
    assert.ok(dealUnit(ph) <= Math.max(bidFor(ps, "pema", "mango")!.price, quote(ps, "pema", "mango", false).price - 1), "Pema never pays above what she can sell on for"); }
  assert.ok(!verifyDealUnit(s, "tomas", "buy", "mango", 1, ["lowball", "lowball", "lowball", "lowball", "lowball", "lowball", "lowball", "lowball", "lowball"]).ok, "too many or unknown tactics are refused");
  assert.ok(!verifyDealUnit(s, "tomas", "buy", "mango", ref - 1, ["fair"]).ok, "fair is not a haggle move");
  // a live NEAR AI price becomes the reference
  const live = initialEconomy(); live.flags[agentPriceKey("tomas", "ask", "mango")] = ref + 3;
  const lref = quote(live, "tomas", "mango").price;
  assert.ok(lref !== ref && !verifyDealUnit(live, "tomas", "buy", "mango", lref - 1, []).ok, "the live price is the one to beat");
  assert.ok(verifyDealUnit(s, "arin", "sell", "mango", sref, []).ok && !verifyDealUnit(s, "arin", "sell", "mango", sref + 1, []).ok, "selling above the reference needs a haggle");
  // scripted first-day prices are only a candidate; the relayer still claims them once per player
  assert.equal(newcomerPrice("sell", "pema", 6, sref), null, "no scripted sale price any more");
  assert.equal(newcomerPrice("sell", "pema", 9, sref), null);
  assert.equal(newcomerPrice("buy", "pema", ref - 1, ref), null);
}

// Every tactic sequence (up to 3 moves) on varied stalls: the deal the panel shows is one the relayer signs (inside
// dealBounds of the posted price), the till can pay, and a stall never sells under its restock cost.
{
  const moves: Tactic[] = ["lowball", "flatter", "rival", "bundle"];
  const seqs: Tactic[][] = [[]];
  for (let k = 0; k < 3; k++) for (const q of seqs.slice()) if (q.length === k) for (const t of moves) seqs.push([...q, t]);
  let n = 0;
  for (const id of ["pema", "tomas", "mira", "arin"] as const) for (const stockMul of [0.1, 0.5, 1, 1.6]) for (const cash of [5, 30, 200]) for (const held of [0, 6]) {
    const s = initialEconomy();
    const m = s.merchants[id];
    m.stock.mango = Math.round(m.target.mango * stockMul); m.cash = cash;
    s.player.inventory.mango = held; s.player.coins = 60;
    const opened = openHaggle(s, id);
    if ("error" in opened) continue;
    const auth = opened.mode === "buy" ? quote(s, id, "mango").price : bidFor(s, id, "mango")!.price;
    const b = dealBounds(auth);
    for (const seq of seqs) {
      let h: HaggleSession = opened; const probe = structuredClone(s);
      for (const t of seq) { h = applyTactic(probe, h, t).session; if (h.over) break; }
      if (h.over === "walked") continue;
      const u = dealUnit(h); n++;
      assert.ok(u >= b.min && u <= b.max, `${id} ${opened.mode} ${seq.join(",")}: ${u} c outside ${b.min}..${b.max}`);
      if (opened.mode === "buy") assert.ok(u >= Math.min(auth, restockCost(m, "mango")), `${id} sold under restock cost: ${u}`);
      else assert.ok(u * h.qty <= cash, `${id} cannot pay ${u * h.qty} c from ${cash} c`);
    }
  }
  assert.ok(n > 500, `enough haggles explored (${n})`);
}

// The tutorial's haggle lesson (Tomas, opening market) can actually win a coin.
{ const t = initialEconomy(); t.player.coins = 40; const o = openHaggle(t, "tomas");
  assert.ok(!("error" in o) && o.mode === "buy");
  const best = Math.min(...(["lowball", "flatter", "rival", "bundle"] as const).map((x) => dealUnit(applyTactic(structuredClone(t), o as HaggleSession, x).session)));
  assert.ok(best < (o as HaggleSession).open, `the tutorial haggle has room (${best} vs ${(o as HaggleSession).open})`); }

console.log("haggle checks passed");
