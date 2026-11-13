// The objective card's "what to do next": one move the player can make right now, read from the real market (bids,
// prices, tills, stock, the player's purse and bag, the Orchard's hours). Never a trade that is unavailable,
// unaffordable or loses money; when nothing pays, it says so and when that changes. Pure: economy state in, words out.
import type { EconomyState, MerchantId } from "../economy/state.ts";
import { MERCHANT_IDS, MINUTES_PER_DAY } from "../economy/state.ts";
import { bidFor, quote, ORCHARD_HOURS, ORCHARD_PICK } from "../economy/pricing.ts";

export type Target = MerchantId | "orchard";
export interface Move { readonly title: string; readonly text: string; readonly target: Target | null }

export const NAMES: Record<MerchantId, string> = { pema: "Pema", tomas: "Tomas", mira: "Mira", arin: "Arin" };
export const mangoes = (k: number): string => `${k} ${k === 1 ? "mango" : "mangoes"}`;

interface Offer { readonly id: MerchantId; readonly price: number; readonly qty: number }

/** Who pays most for mangoes right now, and how many it takes: its posted lot, capped by what its till can pay. */
export function bestBuyer(s: EconomyState, except?: MerchantId): Offer | null {
  let best: Offer | null = null;
  for (const id of MERCHANT_IDS) {
    if (id === except) continue;
    const b = bidFor(s, id, "mango");
    if (!b || b.price < 1) continue;
    const qty = Math.min(b.qty, Math.floor(s.merchants[id].cash / b.price));
    if (qty >= 1 && (!best || b.price > best.price)) best = { id, price: b.price, qty };
  }
  return best;
}

/** The cheapest open stall selling mangoes, and how many of them the player's purse buys there. */
export function cheapestSeller(s: EconomyState): Offer | null {
  let best: Offer | null = null;
  for (const id of MERCHANT_IDS) {
    const m = s.merchants[id];
    if (m.status !== "open" || !m.sells.includes("mango") || m.stock.mango < 1) continue;
    const price = quote(s, id, "mango").price;
    const qty = Math.min(m.stock.mango, Math.floor(s.player.coins / price));
    if (!best || price < best.price) best = { id, price, qty };
  }
  return best;
}

const hh = (h: number): string => `${String(h).padStart(2, "0")}:00`;

/** When the Orchard next gives its free mangoes: today if the pickers have not started yet, else tomorrow. */
export function orchardWhen(s: EconomyState): string {
  return (s.minute % MINUTES_PER_DAY) / 60 < ORCHARD_HOURS[0] ? `at ${hh(ORCHARD_HOURS[0])}` : `tomorrow from ${hh(ORCHARD_HOURS[0])}`;
}

/** The single best move right now. `orchardReady` is the game's own flag: the pickers are working and today's share is
 *  still in the crate. */
export function nextMove(s: EconomyState): Move {
  const held = s.player.inventory.mango, coins = s.player.coins;
  if (held > 0) {
    const b = bestBuyer(s);
    if (b) {
      const n = Math.min(held, b.qty);
      return {
        title: `Sell your ${mangoes(held)} to ${NAMES[b.id]}`, target: b.id,
        text: `${NAMES[b.id]} pays the most: ${b.price} c each, +${n * b.price} c${n < held ? ` for ${n} now (all the till can take)` : ""}. Press E at the stall.`,
      };
    }
    return { title: `Hold your ${mangoes(held)}`, target: null, text: "No stall is buying mangoes this minute. Bids change through the day: check the stall boards as you pass." };
  }
  if (s.flags.orchardReady === true) {
    return { title: "Pick free mangoes at the Orchard", target: "orchard", text: `Press F at the crate by the Mango Orchard sign: ${ORCHARD_PICK} free mangoes until ${hh(ORCHARD_HOURS[1])}.` };
  }
  const sell = cheapestSeller(s);
  if (sell && sell.qty >= 1) {
    const b = bestBuyer(s, sell.id);
    if (b && b.price > sell.price) {
      const n = Math.min(sell.qty, b.qty);
      return {
        title: `Buy from ${NAMES[sell.id]}, sell to ${NAMES[b.id]}`, target: sell.id,
        text: `Buy ${mangoes(n)} at ${NAMES[sell.id]}'s stall (${sell.price} c each), then sell them to ${NAMES[b.id]} (${b.price} c each): +${n * (b.price - sell.price)} c.`,
      };
    }
  }
  const why = sell && sell.qty < 1
    ? `The cheapest mango is ${sell.price} c at ${NAMES[sell.id]} and you have ${coins} c.`
    : "No stall pays more for mangoes than another sells them for right now.";
  return { title: "Wait for a better price", target: null, text: `${why} Free mangoes at the Orchard ${orchardWhen(s)}.` };
}
