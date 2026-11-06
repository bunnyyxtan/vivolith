// Run: node src/economy/economy.check.ts   (asserts the Mango Crisis economics hold)
import assert from "node:assert/strict";
import { initialEconomy } from "./state.ts";
import { advance, challengeStandingContract, payReleaseFee, pemaBuysFromTomas, teahouseForwardBuy } from "./sim.ts";
import { quote } from "./pricing.ts";

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
const teaCash = forward.merchants.teahouse.cash;
assert.ok(teahouseForwardBuy(forward, 10).ok);
assert.equal(forward.merchants.teahouse.cash, teaCash - 30);
advance(forward, hours(12.5));
assert.equal(forward.merchants.pema.status, "open", `forward path: pema cash ${forward.merchants.pema.cash}`);
assert.ok(payReleaseFee(forward, "pema-mangoes").ok);
const teaMango = forward.merchants.teahouse.stock.mango;
advance(forward, hours(2));
assert.ok(forward.merchants.teahouse.stock.mango >= teaMango + 10 - 4, "pre-paid crates delivered to the Tea House");
assert.equal(forward.flags.forwardQty, 0);

// 4. Determinism: a week of fast-forward is identical across runs.
const a = initialEconomy();
const b = initialEconomy();
advance(a, hours(24 * 7));
for (let i = 0; i < 7 * 24 * 6; i++) advance(b, 10); // same span, different step size
assert.deepEqual(JSON.stringify(a.merchants), JSON.stringify(b.merchants));
assert.ok(a.history.length >= 6, "daily history recorded");

console.log("economy checks passed", {
  idleClosedWithCash: idle.merchants.pema.cash,
  priceBeforeAfterDelivery: [before, after],
  rescueCash: rescue.merchants.pema.cash,
  rival: res.message,
  week: a.history.map((d) => `${d.day}:${d.pemaMango}/${d.tomasMango}/${d.lassi}${d.pemaOpen ? "" : "X"}`).join(" "),
});
