// Run: node src/economy/haggle.check.ts   (haggling is deterministic and personality matters)
import assert from "node:assert/strict";
import { initialEconomy } from "./state.ts";
import { applyTactic, closeDeal, openHaggle, type HaggleSession } from "./haggle.ts";

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
console.log("haggle checks passed");
