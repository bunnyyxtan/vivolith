// Run: node src/economy/recovery.check.ts
// Many market days on the market model (turn.ts, a step-for-step replay of the relayer's turn) under adverse conditions.
// Every run checks coin conservation: coins now = coins at start + minted (street shoppers) - burned (rent, freight).
// The printed numbers are what the rules produced; assertions check conservation, idempotency and the claims the
// report makes, not hoped-for outcomes.
import assert from "node:assert/strict";
import { initialEconomy, MERCHANT_IDS, type EconomyState, type MerchantId } from "./state.ts";
import { bidFor } from "./pricing.ts";
import { invest } from "./sim.ts";
import { DEBT_CAP, REPAY_CAP } from "./recovery.ts";
import { coinsIn, marketTurn, newTown, runDays, type Town } from "./turn.ts";

const TURNS = 10; // a market day is 10 real minutes; a turn runs at most once a minute while someone plays
const conserved = (t: Town, start: number, why: string): void => assert.equal(coinsIn(t), start + t.ledger.minted - t.ledger.burned, `coin conservation: ${why}`);
const summary = (t: Town): string => MERCHANT_IDS.map((id) => { const m = t.st.merchants[id]; return `${id} ${m.status === "open" ? "open" : "SHUT"} ${Math.floor(m.cash)}c/${m.stock.mango}m d${Number(t.st.flags[`debt.${id}`] ?? 0)}`; }).join(" | ") + ` | guild ${t.guild}c`;
const purse = () => ({ picker: { coin: 0, mango: 0, lemon: 0, lassi: 0 }, porter: { coin: 0, mango: 0, lemon: 0, lassi: 0 } });

/** The testnet market as the read-only preflight found it (2026-11-13): three stalls closed, the Guild empty.
 *  Values not read from chain (lemons, lassi, reopen counts of Tomas and Mira) keep the opening state. */
function testnetNow(): EconomyState {
  const st = initialEconomy();
  const set = (id: MerchantId, status: "open" | "closed", cash: number, mango: number, debt: number, need?: number): void => {
    Object.assign(st.merchants[id], { status, cash }); st.merchants[id].stock.mango = mango; st.flags[`debt.${id}`] = debt;
    if (status === "closed") st.flags[`reopenNeed.${id}`] = need ?? 1;
  };
  set("pema", "closed", 1, 13, 163, 1); set("tomas", "closed", 13, 34, 10, 3); set("mira", "closed", 14, 8, 48, 3); set("arin", "open", 19, 5, 0);
  return st;
}

// ---------------------------------------------------------------- 1. diagnosis: a healthy market under the old rules ----
const fruitSales = (rules: "old" | "new"): { fruit: number; lassi: number; t: Town } => {
  const t = newTown(initialEconomy(), 200, purse());
  runDays(t, 2, 6, TURNS, rules);
  return { fruit: (t.sold.mango ?? 0) + (t.sold.lemon ?? 0), lassi: t.sold.lassi ?? 0, t };
};
const oldMarket = fruitSales("old"), newMarket = fruitSales("new");
console.log(`1. healthy start, 6 market days x ${TURNS} turns`);
console.log(`   old rules: shoppers took ${oldMarket.fruit} fruit, ${oldMarket.lassi} lassi | ${summary(oldMarket.t)}`);
console.log(`   new rules: shoppers took ${newMarket.fruit} fruit, ${newMarket.lassi} lassi | ${summary(newMarket.t)}`);
// measured (not assumed): the old per-turn floor dropped most fruit demand, because a fruit stall's demand per turn is
// usually under one unit; carrying the fraction serves those shoppers
assert.ok(newMarket.fruit > oldMarket.fruit * 2, "carrying the fraction serves the shoppers the old floor dropped");

// ---------------------------------------------------------------- 2. the live deadlock ----
for (const rules of ["old", "new"] as const) {
  const t = newTown(testnetNow(), 0, purse());
  const start = coinsIn(t);
  const days: string[] = [];
  runDays(t, 2990928, 8, TURNS, rules, (d) => { if ((d - 2990928) % 2 === 0) days.push(`   day +${d - 2990928}: ${summary(t)}`); });
  conserved(t, start, `deadlock run (${rules})`);
  console.log(`\n2. testnet state now (3 closed, Guild 0), 8 market days, ${rules} rules\n${days.join("\n")}\n   end:    ${summary(t)}\n   ${t.log.slice(0, 8).join("; ")}`);
  if (rules === "old") assert.ok(["pema", "tomas", "mira"].every((id) => t.st.merchants[id as MerchantId].status === "closed"), "diagnosis: under the old rules nobody reopens");
  else assert.ok(t.log.some((l) => /reopened/.test(l)), "under the new rules closed stalls reopen through residents' deliveries");
}

// ---------------------------------------------------------------- 3. a zero-cash closed stall, empty Guild ----
{
  const mk = (): Town => { const st = testnetNow(); st.merchants.pema.cash = 0; return newTown(st, 0, purse()); };
  const alone = mk(); const s0 = coinsIn(alone);
  assert.equal(bidFor(alone.st, "pema", "mango"), null, "a closed stall with an empty till cannot bid");
  runDays(alone, 2990928, 8, TURNS);
  conserved(alone, s0, "zero-cash alone");
  // the player recapitalises Pema with shares (the contract's invest: price to the stall, backing into its reserve)
  const helped = mk(); helped.st.player.coins = 40; const s1 = coinsIn(helped);
  assert.ok(invest(helped.st, "pema", 15 * 5).ok); // 5 packs: 25 c paid, 20 c reserve, 5 c working capital
  assert.equal(helped.st.merchants.pema.cash, 5);
  runDays(helped, 2990928, 8, TURNS);
  conserved(helped, s1, "zero-cash with investment");
  console.log(`\n3. Pema with 0 c and an empty Guild, 8 days\n   nobody helps:        ${alone.st.merchants.pema.status}, ${Math.floor(alone.st.merchants.pema.cash)} c | ${alone.log.filter((l) => /pema/.test(l)).join("; ") || "no event"}\n   player invests 25 c: ${helped.st.merchants.pema.status}, ${Math.floor(helped.st.merchants.pema.cash)} c, player ${helped.st.player.coins} c, ${helped.st.player.shares.pema} shares | ${helped.log.filter((l) => /pema/.test(l)).join("; ")}`);
}

// ---------------------------------------------------------------- 4. failure after recovery (little play) ----
{
  const t = newTown(testnetNow(), 0, purse()); const s = coinsIn(t);
  runDays(t, 2990928, 10, 2); // two turns a market day: almost nobody playing
  conserved(t, s, "low activity");
  console.log(`\n4. same deadlock, only 2 turns a market day, 10 days: ${summary(t)}\n   ${t.log.join("; ")}`);
}

// ---------------------------------------------------------------- 5. repeated turns and duplicate attempts ----
{
  const a = newTown(testnetNow(), 0, purse()), b = newTown(testnetNow(), 0, purse());
  marketTurn(a, 2990928); marketTurn(b, 2990928); marketTurn(b, 2990928); marketTurn(b, 2990928);
  const daily = (t: Town) => ({ rent: t.ledger.byReason.rent ?? 0, residents: t.residents.picker.coin + t.residents.picker.mango, debt: MERCHANT_IDS.map((id) => t.st.flags[`debt.${id}`]) });
  assert.deepEqual(daily(b), daily(a), "rent, residents' day and Guild collection happen once per market day however many turns run");
}

// ---------------------------------------------------------------- 6. debt is repaid from earnings, never swept ----
{
  const t = newTown(initialEconomy(), 0, purse());
  t.st.flags["debt.pema"] = 60; const s = coinsIn(t);
  const seen: number[] = [];
  runDays(t, 2990928, 12, TURNS, "new", () => seen.push(Number(t.st.flags["debt.pema"])));
  conserved(t, s, "repayment");
  const steps = seen.slice(1).map((d, i) => seen[i] - d);
  console.log(`\n6. Pema owes 60 c, healthy market, 12 days: debt by day ${seen.join(" ")} | guild ${t.guild} c | Pema ${t.st.merchants.pema.status} ${Math.floor(t.st.merchants.pema.cash)} c`);
  // measured: she repays while she earns, and borrows again when her till runs low; both are bounded
  assert.ok(steps.every((x) => x <= REPAY_CAP), "never repays more than REPAY_CAP a day");
  assert.ok(seen.every((x) => x <= DEBT_CAP), "new loans stop at DEBT_CAP");
}

// ---------------------------------------------------------------- 7. the player maximises profit instead ----
{
  const rescue = newTown(testnetNow(), 0, purse()), greedy = newTown(testnetNow(), 0, purse());
  for (const t of [rescue, greedy]) { t.st.player.coins = 40; t.st.player.inventory.mango = 3; }
  // rescue: 1 mango into Pema's 1 c reopen bid (all she can pay); greedy: all 3 to Arin's 6 c bid
  const pb = bidFor(rescue.st, "pema", "mango")!, ab = bidFor(greedy.st, "arin", "mango")!;
  rescue.st.player.inventory.mango -= 1; rescue.st.player.coins += pb.price; rescue.st.merchants.pema.cash -= pb.price; rescue.st.merchants.pema.stock.mango += 1; rescue.st.merchants.pema.status = "open"; delete rescue.st.flags["reopenNeed.pema"]; rescue.reopened.pema = 2990928;
  const sold = Math.min(3, ab.qty, Math.floor(greedy.st.merchants.arin.cash / ab.price));
  greedy.st.player.inventory.mango -= sold; greedy.st.player.coins += sold * ab.price; greedy.st.merchants.arin.cash -= sold * ab.price; greedy.st.merchants.arin.stock.mango += sold;
  // when does the rescued Pema next have a funded mango bid (an order the decision engine could price)?
  const probe = structuredClone(rescue);
  let firstBid: string | null = null;
  for (let d = 2990928; d < 2990934 && firstBid === null; d++) for (let k = 0; k < TURNS && firstBid === null; k++) {
    marketTurn(probe, d);
    const b = bidFor(probe.st, "pema", "mango"), m = probe.st.merchants.pema;
    if (m.status === "open" && b && m.cash >= b.price) firstBid = `day +${d - 2990928}, turn ${k + 1}: bid ${b.price} c for ${b.qty}, till ${Math.floor(m.cash)} c, ${m.stock.mango} mangoes`;
  }
  console.log(`\n7a. rescued Pema's first funded bid (what a Jev decision needs): ${firstBid ?? "none within 6 market days"}`);
  runDays(rescue, 2990928, 6, TURNS); runDays(greedy, 2990928, 6, TURNS);
  console.log(`\n7. the player's choice on the deadlocked market, then 6 days\n   rescue Pema (1 at ${pb.price} c): player ${rescue.st.player.coins} c | ${summary(rescue)}\n   sell ${sold} to Arin at ${ab.price} c: player ${greedy.st.player.coins} c | ${summary(greedy)}`);
  assert.ok(greedy.st.player.coins > rescue.st.player.coins, "profit pays the player more right away");
}

// ---------------------------------------------------------------- 8. limited resident purchasing power ----
{
  const t = newTown(testnetNow(), 0, purse(), ["picker", "porter"]);
  const meals: string[] = [];
  runDays(t, 2990928, 6, TURNS, "new", (d) => meals.push(`${d - 2990928}:${t.residents.picker.coin}c/${t.residents.porter.coin}c`));
  console.log(`\n8. Lin and Dev both working, 6 days: purses by day (Lin/Dev) ${meals.join(" ")} | ${summary(t)}`);
  assert.ok(t.residents.picker.coin >= 0 && t.residents.porter.coin >= 0, "nobody spends what they do not have");
}

assert.ok(DEBT_CAP > 0);
console.log("\nrecovery checks passed");
