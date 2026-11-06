// MERCHANT PRICING RULES: the one readable file. Every factor returns a multiplier and a human reason,
// which the price tooltip / inspector shows verbatim.
//
//   price = baseCost x scarcity x demand x cashPressure x greed x relationship   (rounded, min 1 coin)
import type { EconomyState, Good, Merchant, MerchantId } from "./state.ts";

export interface PriceFactor {
  readonly label: string;
  readonly multiplier: number;
}

export interface Quote {
  readonly price: number;
  readonly factors: readonly PriceFactor[];
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const pct = (m: number): string => `${m >= 1 ? "+" : ""}${Math.round((m - 1) * 100)}%`;

/** Fewer items than normal cost more; a glut is discounted. */
function scarcity(m: Merchant, good: Good): PriceFactor {
  const target = Math.max(1, m.target[good]);
  const ratio = m.stock[good] / target;
  const mult = clamp(1 + 1.1 * (1 - ratio), 0.7, 2.4);
  const label = m.stock[good] === 0 ? "Sold out" : ratio < 0.5 ? `Only ${m.stock[good]} left` : ratio > 1.2 ? "Overstocked" : "Normal stock";
  return { label: `${label} (${pct(mult)})`, multiplier: mult };
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

/** Reputation with the buyer: -50..+50 maps to +20%..-20%. */
function relationship(rep: number): PriceFactor {
  const mult = clamp(1 - rep / 250, 0.8, 1.2);
  const label = rep >= 15 ? "Trusts you" : rep <= -15 ? "Remembers you badly" : "Knows you a little";
  return { label: `${label} (${pct(mult)})`, multiplier: mult };
}

/** Price per unit `merchant` asks from the player (or from another NPC when buyerRep is omitted). */
export function quote(state: EconomyState, merchantId: MerchantId, good: Good, forPlayer = true): Quote {
  const m = state.merchants[merchantId];
  const factors = [scarcity(m, good), demand(m, good), cashPressure(m), greed(m)];
  if (forPlayer) factors.push(relationship(state.player.rep[merchantId]));
  const raw = factors.reduce((p, f) => p * f.multiplier, m.baseCost[good]);
  return { price: Math.max(1, Math.round(raw)), factors };
}

/** Tea House sets its lassi price from what mangoes cost it (cost pass-through). */
export function lassiPrice(state: EconomyState): Quote {
  const t = state.merchants.teahouse;
  const mangoCost = cheapestMango(state)?.price ?? t.baseCost.mango * 2.4;
  const base: PriceFactor = { label: `Mango costs ${Math.round(mangoCost)} c (pass-through)`, multiplier: 1 };
  const s = scarcity(t, "lassi");
  const raw = (1 + mangoCost / 3) * s.multiplier;
  return { price: Math.max(1, Math.round(raw)), factors: [base, s] };
}

/** Cheapest open mango seller for an NPC buyer (the Tea House restocks here). */
export function cheapestMango(state: EconomyState): { seller: MerchantId; price: number } | null {
  let best: { seller: MerchantId; price: number } | null = null;
  for (const id of ["pema", "tomas"] as const) {
    const m = state.merchants[id];
    if (m.status !== "open" || m.stock.mango <= 0) continue;
    const price = quote(state, id, "mango", false).price;
    if (!best || price < best.price) best = { seller: id, price };
  }
  return best;
}
