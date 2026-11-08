// MERCHANT RULES: the one readable file. The game client and the merchants' server agents (which trade on NEAR
// from the merchants' own accounts) run exactly these functions. Every price factor returns a multiplier and a
// human reason, which the price tooltip shows verbatim.
//
//   price = baseCost x scarcity x demand x cashPressure x greed x relationship   (rounded, min 1 coin)
//
// Personalities:
//   Pema  (loyal)      scarcity barely moves her price; she never gouges; restocks when shelves run low.
//   Tomas (gouger)     price climbs steeply with scarcity; holds stock; never buys from rivals (harbor contract).
//   Mira  (arbitrage)  undercuts the cheapest rival by 1 c; buys other stalls' surplus cheap to resell.
//   Arin  (steady)     lassi priced from mango cost; pays a fixed fair bid for reliable mango supply.
import type { EconomyState, Good, Merchant, MerchantId, Style } from "./state.ts";
import { MERCHANT_IDS } from "./state.ts";

export interface PriceFactor {
  readonly label: string;
  readonly multiplier: number;
}

export interface Quote {
  readonly price: number;
  readonly factors: readonly PriceFactor[];
}

/** Share of a day's goods revenue a stall pays its shareholders (the contract uses the same 50%). */
export const DIVIDEND_SHARE = 0.5;
export const SHARES_PER_STALL = 20;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const pct = (m: number): string => `${m >= 1 ? "+" : ""}${Math.round((m - 1) * 100)}%`;

/** How hard each personality reacts to its own stock level: [slope, min multiplier, max multiplier]. */
const SCARCITY: Record<Style, readonly [number, number, number]> = {
  loyal: [0.5, 0.85, 1.4],
  gouger: [2.2, 0.7, 3.4],
  arbitrage: [1.1, 0.7, 1.8],
  steady: [0.3, 0.9, 1.15],
};

/** Fewer items than normal cost more; a glut is discounted. How much depends on the personality. */
function scarcity(m: Merchant, good: Good): PriceFactor {
  const [slope, lo, hi] = SCARCITY[m.style];
  const ratio = m.stock[good] / Math.max(1, m.target[good]);
  const mult = clamp(1 + slope * (1 - ratio), lo, hi);
  const level = m.stock[good] === 0 ? "Sold out" : ratio < 0.5 ? `Only ${m.stock[good]} left` : ratio > 1.2 ? "Overstocked" : "Normal stock";
  const why = m.style === "loyal" && ratio < 0.5 ? ", won't gouge regulars" : m.style === "gouger" && ratio < 0.5 ? ", charges what the shortage allows" : "";
  return { label: `${level}${why} (${pct(mult)})`, multiplier: mult };
}

/** Recent sales above the usual pace push prices up. */
function demand(m: Merchant, good: Good): PriceFactor {
  const usual = m.target[good] / 24; // a full target stock lasts roughly a day
  const heat = usual > 0 ? m.recentSales[good] / usual : 0;
  const mult = clamp(1 + 0.25 * (heat - 1), 0.88, 1.35);
  return { label: `${heat > 1.2 ? "Selling fast" : heat < 0.6 ? "Slow day" : "Steady demand"} (${pct(mult)})`, multiplier: mult };
}

/** A merchant short of rent money discounts to raise cash; a rich one holds firm. */
function cashPressure(m: Merchant): PriceFactor {
  if (m.cash < m.rent) return { label: `Rent due, needs cash (${pct(0.85)})`, multiplier: 0.85 };
  if (m.cash > m.rent * 4) return { label: `Comfortable, won't haggle (${pct(1.08)})`, multiplier: 1.08 };
  return { label: "Cash okay (+0%)", multiplier: 1 };
}

function greed(m: Merchant): PriceFactor {
  const mult = 1 + m.greed * 0.35;
  return { label: `${m.greed > 0.5 ? "Drives a hard bargain" : "Fair dealer"} (${pct(mult)})`, multiplier: mult };
}

/** Reputation with the buyer: -50..+50 maps to +20%..-20%. Pema's loyalty doubles the effect. */
function relationship(m: Merchant, rep: number): PriceFactor {
  const weight = m.style === "loyal" ? 2 : 1;
  const mult = clamp(1 - (rep * weight) / 250, 0.75, 1.2);
  const label = rep >= 15 ? (m.style === "loyal" ? "Regular, gets the family price" : "Trusts you") : rep <= -15 ? "Remembers you badly" : "Knows you a little";
  return { label: `${label} (${pct(mult)})`, multiplier: mult };
}

/** Cheapest posted price among the other open sellers of `good` with stock. */
function rivalBest(state: EconomyState, self: MerchantId, good: Good): { id: MerchantId; price: number } | null {
  let best: { id: MerchantId; price: number } | null = null;
  for (const id of MERCHANT_IDS) {
    const m = state.merchants[id];
    if (id === self || m.style === "arbitrage" || m.status !== "open" || !m.sells.includes(good) || m.stock[good] <= 0) continue;
    const price = quote(state, id, good, false).price;
    if (!best || price < best.price) best = { id, price };
  }
  return best;
}

/** Price per unit `merchant` asks from the player (or from another NPC when forPlayer is false). */
export function quote(state: EconomyState, merchantId: MerchantId, good: Good, forPlayer = true): Quote {
  const m = state.merchants[merchantId];
  if (merchantId === "arin" && good === "lassi") return lassiPrice(state);
  const factors: PriceFactor[] = [scarcity(m, good), demand(m, good), cashPressure(m), greed(m)];
  if (forPlayer) factors.push(relationship(m, state.player.rep[merchantId]));
  let raw = factors.reduce((p, f) => p * f.multiplier, m.baseCost[good]);
  if (m.style === "arbitrage") {
    const rival = rivalBest(state, merchantId, good);
    const floor = m.baseCost[good] * 1.1; // never sells below what surplus costs her
    if (rival && rival.price - 1 < raw && rival.price - 1 >= floor) {
      factors.push({ label: `Undercuts ${state.merchants[rival.id].name} by 1 c`, multiplier: (rival.price - 1) / raw });
      raw = rival.price - 1;
    }
  }
  return { price: Math.max(1, Math.round(raw)), factors };
}

/** Arin sets his lassi price from what mangoes cost him (cost pass-through), with steady scarcity. */
export function lassiPrice(state: EconomyState): Quote {
  const t = state.merchants.arin;
  const mangoCost = cheapestMango(state)?.price ?? t.baseCost.mango * 2.4;
  const base: PriceFactor = { label: `Mango costs ${Math.round(mangoCost)} c (pass-through)`, multiplier: 1 };
  const s = scarcity(t, "lassi");
  const raw = (1 + mangoCost / 3) * s.multiplier;
  return { price: Math.max(1, Math.round(raw)), factors: [base, s] };
}

/** Cheapest open mango seller for an NPC buyer. */
export function cheapestMango(state: EconomyState): { seller: MerchantId; price: number } | null {
  let best: { seller: MerchantId; price: number } | null = null;
  for (const id of MERCHANT_IDS) {
    const m = state.merchants[id];
    if (!m.sells.includes("mango") || m.status !== "open" || m.stock.mango <= 0) continue;
    const price = quote(state, id, "mango", false).price;
    if (!best || price < best.price) best = { seller: id, price };
  }
  return best;
}

// ------------------------------------------------------------ merchants buying from each other ----

export interface Bid {
  readonly price: number;
  readonly qty: number;
  readonly reason: string;
}

/** What a merchant will pay other stalls (and the player) per unit of `good`, or null if not buying. */
export function bidFor(state: EconomyState, id: MerchantId, good: Good): Bid | null {
  const m = state.merchants[id];
  const short = m.target[good] - m.stock[good];
  if (m.status !== "open" || short <= 0) return null;
  switch (m.style) {
    case "loyal": // restocks once shelves fall under half, pays up to 1.8x cost
      return m.sells.includes(good) && m.stock[good] < m.target[good] * 0.5 ? { price: Math.round(m.baseCost[good] * 1.8), qty: short, reason: "Restocking her shelves" } : null;
    case "gouger": // supplied by his harbor contract; never helps a rival by buying
      return null;
    case "arbitrage": { // only buys when another stall is sitting on surplus
      const glut = MERCHANT_IDS.some((o) => o !== id && state.merchants[o].stock[good] > state.merchants[o].target[good] * 1.2);
      return m.sells.includes(good) && glut ? { price: Math.max(1, Math.round(m.baseCost[good] * 1.4)), qty: short, reason: "Buys surplus cheap to resell" } : null;
    }
    case "steady": // fixed fair price for the mangoes his lassi needs
      return good === "mango" ? { price: Math.round(m.baseCost.mango * 2), qty: short, reason: "Steady supply for lassi at a fixed fair price" } : null;
  }
}

export interface MerchantTrade {
  readonly buyer: MerchantId;
  readonly seller: MerchantId;
  readonly good: Good;
  readonly qty: number;
  readonly price: number;
  readonly reason: string;
}

/** Coins a merchant never spends on other merchants' goods: kept to pay players who bring deliveries
 *  (the tutorial's 3 mangoes at 6 c), so a stall's own restocking can't leave it unable to buy from Kavi. */
export const TILL_RESERVE = 18;

/** Units a seller keeps back from other merchants (Tomas sells his whole glut; others keep 30% for shoppers). */
const reserve = (s: Merchant, good: Good): number => (s.style === "gouger" ? s.target[good] : Math.ceil(s.target[good] * 0.3));

/** Trades the merchants agree among themselves right now: each bid is filled from the cheapest seller whose
 *  NPC price is at or under the bid. Pure: callers apply the trades (the sim locally, the agents on NEAR). */
export function planMerchantTrades(state: EconomyState): MerchantTrade[] {
  const out: MerchantTrade[] = [];
  for (const buyer of MERCHANT_IDS) {
    for (const good of ["mango", "lemon"] as const) {
      const bid = bidFor(state, buyer, good);
      if (!bid) continue;
      let best: { seller: MerchantId; price: number } | null = null;
      for (const seller of MERCHANT_IDS) {
        const s = state.merchants[seller];
        if (seller === buyer || s.status !== "open" || !s.sells.includes(good) || s.stock[good] <= reserve(s, good)) continue;
        if (s.style === "gouger" && buyer === "pema") continue; // Tomas won't sell to his rival
        const price = quote(state, seller, good, false).price;
        if (price <= bid.price && (!best || price < best.price)) best = { seller, price };
      }
      if (!best) continue;
      const s = state.merchants[best.seller];
      const spare = Math.max(0, state.merchants[buyer].cash - TILL_RESERVE);
      const qty = Math.min(bid.qty, s.stock[good] - reserve(s, good), Math.floor(spare / best.price));
      if (qty > 0) out.push({ buyer, seller: best.seller, good, qty, price: best.price, reason: bid.reason });
    }
  }
  return out;
}

/** 0..2: how strongly a stall pulls passing shoppers (cheap and stocked pulls; sold out or closed is 0). */
export function stallPull(state: EconomyState, id: MerchantId): number {
  const m = state.merchants[id];
  if (m.status !== "open") return 0;
  let best = 0;
  for (const good of m.sells) {
    if (m.stock[good] <= 0) continue;
    const fair = good === "lassi" ? m.baseCost.lassi * 1.5 : m.baseCost[good] * 1.2;
    best = Math.max(best, Math.pow(fair / quote(state, id, good, false).price, 1.3));
  }
  return clamp(best, 0, 2);
}
