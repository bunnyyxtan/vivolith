// Run: node src/economy/sustain.check.ts   (14 market days of the shared rules under three player strategies)
// The economy must hold without a scripted rescue: an unhelped Pema is under real pressure but can recover, steady
// supply keeps her open, the more lucrative buyer (Arin) pays the player more, and no stall ever sells under cost.
import assert from "node:assert/strict";
import { initialEconomy, MERCHANT_IDS, type MerchantId } from "./state.ts";
import { advance, recordRestock, tryReopen } from "./sim.ts";
import { bidFor, quote, restockCost } from "./pricing.ts";

type Strat = "none" | "pema3" | "arin3";
const DAYS = 14;
export function run(strat: Strat) {
  const s = initialEconomy();
  const closedDays: Record<MerchantId, number> = { pema: 0, tomas: 0, mira: 0, arin: 0 };
  let earned = 0;
  const asks: number[] = [], bids: number[] = [], line: string[] = [];
  for (let d = 0; d < DAYS; d++) {
    advance(s, (d * 1440 + 9 * 60 + 30) - s.minute); // 09:30 each day
    asks.push(quote(s, "pema", "mango", false).price); bids.push(bidFor(s, "pema", "mango")?.price ?? 0);
    for (const id of MERCHANT_IDS) for (const g of s.merchants[id].sells) if (g !== "lassi" && s.merchants[id].status === "open")
      assert.ok(quote(s, id, g, false).price >= restockCost(s.merchants[id], g), `day ${d}: ${id} sells ${g} under restock cost`);
    const to: MerchantId | null = strat === "pema3" ? "pema" : strat === "arin3" ? "arin" : null;
    if (to) { // the day's 3 free orchard mangoes, sold at the stall's posted bid as far as its till pays
      const b = bidFor(s, to, "mango"), m = s.merchants[to];
      const q = b ? Math.min(3, Math.floor(m.cash / b.price)) : 0;
      if (q > 0) { m.cash -= q * b!.price; m.stock.mango += q; earned += q * b!.price; recordRestock(s, to, q); tryReopen(s, to); }
    }
    advance(s, (d * 1440 + 23 * 60) - s.minute);
    for (const id of MERCHANT_IDS) if (s.merchants[id].status !== "open") closedDays[id]++;
    line.push(`${s.merchants.pema.status === "open" ? "o" : "X"}${Math.round(s.merchants.pema.cash)}`);
  }
  return { s, closedDays, earned, asks, bids, line };
}
const res = Object.fromEntries((["none", "pema3", "arin3"] as Strat[]).map((k) => [k, run(k)])) as Record<Strat, ReturnType<typeof run>>;
assert.ok(res.none.closedDays.pema > 0, "an unhelped Pema feels rent pressure");
assert.ok(res.none.closedDays.pema < DAYS / 2, "an unhelped Pema can still recover on street trade");
assert.ok(res.pema3.closedDays.pema < res.none.closedDays.pema, "supplying Pema keeps her open more");
assert.ok(res.arin3.earned > res.pema3.earned, "supplying Pema is a choice: Arin pays the player more");
assert.equal(res.none.closedDays.tomas + res.none.closedDays.arin, 0, "the rich stalls stay open");
for (const strat of ["none", "pema3", "arin3"] as Strat[]) {
  const { s, closedDays, earned, asks, bids, line } = res[strat];
  console.log(strat.padEnd(6), "closed-days", JSON.stringify(closedDays), "player +", earned,
    "| pema ask", asks.slice(0, 7).join(","), "bid", bids.slice(0, 7).join(","),
    "| tills", MERCHANT_IDS.map((id) => Math.round(s.merchants[id].cash)).join("/"), "| pema 23:00", line.join(" "));
}
console.log("sustain checks passed");
