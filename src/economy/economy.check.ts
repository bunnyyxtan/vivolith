// Run: node src/economy/economy.check.ts   (asserts the Mango Crisis economics hold)
import assert from "node:assert/strict";
import { initialEconomy } from "./state.ts";
import { accrueSale, advance, challengeStandingContract, invest, payReleaseFee, pemaBuysFromTomas, recordRestock, reopenGap, sellShares, shareSupply, teahouseForwardBuy, tryReopen } from "./sim.ts";
import { bidFor, quote } from "./pricing.ts";
import { RESIDENTS, planResident, type Offer } from "./residents.ts";

// 0. A closed stall still bids for stock, and reopens the moment deliveries cover the gap (not before).
const shut = initialEconomy();
Object.assign(shut.merchants.pema, { status: "closed", stock: { mango: 0, lemon: 0, lassi: 0 } });
assert.ok(bidFor(shut, "pema", "mango"), "a closed stall keeps bidding");
const gap = reopenGap(shut, "pema");
assert.ok(gap > 0);
shut.merchants.pema.stock.mango = gap - 1;
assert.equal(tryReopen(shut, "pema"), false);
shut.merchants.pema.stock.mango = gap;
assert.equal(tryReopen(shut, "pema"), true);
assert.equal(shut.merchants.pema.status, "open");
// Deliveries count: street shoppers emptying the restocked shelves never push the target back.
Object.assign(shut.merchants.pema, { status: "closed", stock: { mango: 0, lemon: 0, lassi: 0 } });
shut.flags["reopenNeed.pema"] = gap;
shut.merchants.pema.stock.mango = 3; recordRestock(shut, "pema", 3);
shut.merchants.pema.stock.mango = 0; // sold to the street
assert.equal(reopenGap(shut, "pema"), gap - 3);
shut.merchants.pema.stock.mango = gap - 3; recordRestock(shut, "pema", gap - 3);
assert.equal(tryReopen(shut, "pema"), true);
assert.equal(shut.flags["reopenNeed.pema"], undefined);

// 0b. Residents (WP6): sell the day's work into the best bid, then eat only what the purse covers.
{
  const picker = RESIDENTS[0];
  const o = (merchant: string, side: string, token_id: string, qty: number, price: number): Offer => ({ merchant, account_id: `${merchant}.x`, token_id, side, qty: String(qty), price: String(price) });
  const book = [o("arin", "bid", "mango", 6, 6), o("pema", "bid", "mango", 6, 5), o("arin", "ask", "lassi", 8, 3)];
  const p = planResident(picker, book, 0, 6);
  assert.deepEqual(p.sell, { buyer: "arin.x", merchant: "arin", qty: 6, price: 6 }, "sells to the best bid");
  assert.deepEqual(p.eat, { seller: "arin.x", merchant: "arin", price: 3 }, "eats from what it earned");
  const broke = planResident(picker, [o("arin", "ask", "lassi", 8, 3)], 2, 0); // no buyer and 2 c: hungry
  assert.equal(broke.sell, null); assert.equal(broke.eat, null); assert.equal(broke.hungry, 3);
  const partial = planResident(picker, [o("arin", "bid", "mango", 2, 6)], 0, 6);
  assert.equal(partial.sell?.qty, 2, "never sells more than the bid takes");
}

const hours = (h: number) => h * 60;

// 1. Do nothing: the held shipment starves Pema and she cannot make Day 1 rent.
const idle = initialEconomy();
advance(idle, hours(12.5)); // 09:00 -> 21:30
assert.equal(idle.merchants.pema.status, "closed", `idle path: pema cash ${idle.merchants.pema.cash}`);

// 2. Player pays the storage fee at 10:00: mangoes arrive 11:30, prices fall, Pema makes rent.
const rescue = initialEconomy();
advance(rescue, hours(1));
const before = quote(rescue, "pema", "mango").price;
assert.ok(payReleaseFee(rescue, "pema-mangoes").ok);
advance(rescue, hours(2));
const after = quote(rescue, "pema", "mango").price;
assert.ok(after < before, `price should fall after delivery: ${before} -> ${after}`);
advance(rescue, hours(9.5));
assert.equal(rescue.merchants.pema.status, "open", `rescue path: pema cash ${rescue.merchants.pema.cash}`);

// 3. Buying from the rival moves money and stock from Tomas to Pema.
const rival = initialEconomy();
const tomasStock = rival.merchants.tomas.stock.mango;
const res = pemaBuysFromTomas(rival, 10);
assert.ok(res.ok, res.message);
assert.ok(rival.merchants.tomas.stock.mango < tomasStock);

// 5. NEAR Labs insight A: challenging Tomas's standing berth contract releases Pema's crates next 06:00
//    (instead of Day 4) and stops his free morning restock.
const challenge = initialEconomy();
const tomasBefore = challenge.merchants.tomas.stock.mango;
assert.ok(challengeStandingContract(challenge).ok);
assert.ok(!challengeStandingContract(challenge).ok, "only once");
assert.equal(challenge.shipments[0].autoReleaseAt, 24 * 60 + 6 * 60, "release moved to Day 2 06:00");
advance(challenge, hours(22)); // -> Day 2 07:00
assert.equal(challenge.shipments[0].status, "transit");
assert.ok(challenge.merchants.tomas.stock.mango <= tomasBefore, "no free 06:00 restock for Tomas");

// 6. NEAR Labs insight B: the Tea House pre-pays Pema for 10 crates; she makes Day 1 rent, and the
//    crates go to the Tea House on delivery.
const forward = initialEconomy();
const teaCash = forward.merchants.arin.cash;
assert.ok(teahouseForwardBuy(forward, 10).ok);
assert.equal(forward.merchants.arin.cash, teaCash - 30);
advance(forward, hours(12.5));
assert.equal(forward.merchants.pema.status, "open", `forward path: pema cash ${forward.merchants.pema.cash}`);
assert.ok(payReleaseFee(forward, "pema-mangoes").ok);
const teaMango = forward.merchants.arin.stock.mango;
advance(forward, hours(2));
assert.ok(forward.merchants.arin.stock.mango >= teaMango + 10 - 4, "pre-paid crates delivered to the Tea House");
assert.equal(forward.flags.forwardQty, 0);

// 4. Determinism: a week of fast-forward is identical across runs.
const a = initialEconomy();
const b = initialEconomy();
advance(a, hours(24 * 7));
for (let i = 0; i < 7 * 24 * 6; i++) advance(b, 10); // same span, different step size
assert.deepEqual(JSON.stringify(a.merchants), JSON.stringify(b.merchants));
assert.ok(a.history.length >= 6, "daily history recorded");

// 5. Shares and dividends follow the contract's rules (docs/ECONOMY_MATH.md).
const inv = initialEconomy();
inv.player.coins = 500;
const till0 = inv.merchants.pema.cash;
assert.ok(invest(inv, "pema", 75).ok);
assert.equal(inv.player.coins, 500 - 25, "5 c a pack of 15");
assert.equal(inv.merchants.pema.cash, till0 + 5, "1 c a pack is working capital");
assert.equal(inv.flags["reserve.pema"], 20, "4 c a pack is held in reserve");
assert.equal(invest(inv, "pema", 10).ok, false, "whole packs only");
// dividends accrue at each sale: 25% of the stall, a 60 c sale -> 30 declared -> 7.5 c: 7 now, the half carried
inv.merchants.pema.cash = 1000;
for (const sale of [1, 2]) {
  const coins = inv.player.coins;
  accrueSale(inv, "pema", 60);
  assert.equal(inv.player.coins - coins, sale === 1 ? 7 : 8, `sale ${sale}: exact pro rata with the fraction carried`);
}
// odd revenue: the half coin of the declaration carries too
accrueSale(inv, "pema", 3);
assert.equal(inv.flags["revRem.pema"], 5_000, "1.5 c declared: 1 now, half carried in basis points");
// sniping: shares bought after a sale earn nothing from it
const snipe = initialEconomy();
snipe.player.coins = 500; snipe.merchants.pema.cash = 1000;
accrueSale(snipe, "pema", 60);
const c1 = snipe.player.coins;
assert.ok(invest(snipe, "pema", 150).ok);
assert.equal(snipe.player.coins, c1 - 50, "no dividend from the sale before the shares were bought");
// selling back pays exactly the backing, whatever the till holds
inv.merchants.pema.cash = 0;
const c0 = inv.player.coins;
assert.ok(sellShares(inv, "pema", 30).ok);
assert.equal(inv.player.coins - c0, 8);
assert.equal(inv.flags["reserve.pema"], 12);
// past the float, new shares are issued on the same terms: investing never sells out
const big = initialEconomy();
big.player.coins = 10_000;
for (let i = 0; i < 25; i++) assert.ok(invest(big, "tomas", 15).ok);
assert.equal(shareSupply(big, "tomas"), 375);

console.log("economy checks passed", {
  idleClosedWithCash: idle.merchants.pema.cash,
  priceBeforeAfterDelivery: [before, after],
  rescueCash: rescue.merchants.pema.cash,
  rival: res.message,
  week: a.history.map((d) => `${d.day}:${d.pemaMango}/${d.tomasMango}/${d.lassi}${d.pemaOpen ? "" : "X"}`).join(" "),
});
