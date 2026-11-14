// Run: node src/v2/advice.check.ts   (the objective's next move is always possible and never loses money)
import assert from "node:assert/strict";
import { initialEconomy, MERCHANT_IDS, type EconomyState } from "../economy/state.ts";
import { bidFor, quote } from "../economy/pricing.ts";
import { advance } from "../economy/sim.ts";
import { nextMove, orchardCard } from "./advice.ts";

const fresh = (): EconomyState => initialEconomy();

// Carrying mangoes: sell them to the stall that pays most and can pay.
{
  const s = fresh(); s.player.inventory.mango = 3;
  const m = nextMove(s);
  assert.match(m.title, /^Sell your 3 mangoes to /);
  const top = Math.max(...MERCHANT_IDS.map((id) => bidFor(s, id, "mango")?.price ?? 0));
  assert.match(m.text, new RegExp(`${top} c each`), "the best bid on the market");
}
// Nobody can pay (every till empty): hold, never "sell to".
{
  const s = fresh(); s.player.inventory.mango = 2;
  for (const id of MERCHANT_IDS) s.merchants[id].cash = 0;
  const m = nextMove(s);
  assert.match(m.title, /^Hold your 2 mangoes/); assert.equal(m.target, null);
}
// Orchard open and today's share waiting: the free pick comes first.
{
  const s = fresh(); s.flags.orchardReady = true;
  assert.equal(nextMove(s).target, "orchard");
}
// Broke: never told to buy; told the real cheapest price and when free mangoes come.
{
  const s = fresh(); s.player.coins = 0;
  const m = nextMove(s);
  assert.equal(m.title, "Wait for a better price");
  assert.match(m.text, /you have 0 c/); assert.match(m.text, /Orchard/);
}
// A buy-sell pair is only offered when it is affordable and profitable, and its numbers are the live ones.
for (let day = 0; day < 6; day++) {
  const s = fresh(); advance(s, day * 300);
  const m = nextMove(s);
  const pair = /^Buy from (\w+), sell to (\w+)$/.exec(m.title);
  if (!pair) continue;
  const [, a, b] = pair.map((x) => x.toLowerCase()) as [string, typeof MERCHANT_IDS[number], typeof MERCHANT_IDS[number]];
  const ask = quote(s, a, "mango").price, bid = bidFor(s, b, "mango")!.price;
  assert.ok(bid > ask, "only a profitable run"); assert.ok(s.player.coins >= ask, "only an affordable one");
}
// The Orchard goal when the pickers have gone home (live 2026-11-14 20:10): the card leads with the move the player can
// make now, so its title, its text and the gold marker name the same stall; the goal stays as one closing line.
{
  const s = fresh(); s.player.inventory.mango = 2; s.flags.orchardReady = false;
  s.minute = Math.floor(s.minute / 1440) * 1440 + 20 * 60 + 10;
  const c = orchardCard(s, "20:10"), m = nextMove(s);
  assert.ok(m.target && m.target !== "orchard", "a stall is buying: there is a move to make now");
  assert.equal(c.target, m.target, "the marker points where the card says to go");
  assert.equal(c.title, m.title, "the title is that move, not the closed Orchard");
  assert.match(c.title, /^Sell your 2 mangoes to /);
  assert.equal(c.label, "Meanwhile");
  assert.match(c.text, /Goal: free mangoes at the Orchard, tomorrow from 06:00 \(now 20:10\)\.$/);
  // nothing to do now: the goal leads again, and the marker points to the Orchard it names
  for (const id of MERCHANT_IDS) s.merchants[id].cash = 0;
  s.player.inventory.mango = 0; s.player.coins = 0;
  const w = orchardCard(s, "20:10");
  assert.equal(w.title, "Pick free mangoes at the Orchard"); assert.equal(w.target, "orchard"); assert.equal(w.label, "Goal");
  // pickers at work: the goal is the move
  s.flags.orchardReady = true;
  assert.deepEqual([orchardCard(s, "07:00").title, orchardCard(s, "07:00").target], ["Pick free mangoes at the Orchard", "orchard"]);
}
console.log("advice checks passed");
