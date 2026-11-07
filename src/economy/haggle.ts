// HAGGLING RULES: the 30-second skill game, as readable data. Deterministic: the same state and the same
// tactics always give the same price. The merchant's live quote() is the opening ask; their personality
// decides which tactic works in which situation, and the situation is exactly what the thought line shows.
//
//   buy:  the merchant sells to you  -> tactics push the unit price DOWN toward their floor
//   sell: the merchant buys from you -> tactics push their offer UP toward their ceiling
import { bidFor, quote, cheapestMango } from "./pricing.ts";
import type { EconomyState, Good, MerchantId } from "./state.ts";
import { dayOf } from "./state.ts";
import { adjustRep } from "./sim.ts";

export type Tactic = "fair" | "lowball" | "flatter" | "rival" | "bundle";
export const TACTICS: readonly Tactic[] = ["fair", "lowball", "flatter", "rival", "bundle"];
export type Mode = "buy" | "sell";

export interface Personality {
  readonly name: string;
  readonly trait: string;
  /** Patience at the start of a haggle (0..100). */
  readonly patience: number;
}

export const PERSONALITY: Record<MerchantId, Personality> = {
  pema: { name: "Auntie Pema", trait: "Loyal", patience: 90 },
  tomas: { name: "Tomas Vell", trait: "Greedy", patience: 75 },
  mira: { name: "Mira Sol", trait: "Arbitrageur", patience: 60 },
  arin: { name: "Arin Okoye", trait: "Steady", patience: 100 },
};

export interface HaggleSession {
  readonly merchant: MerchantId;
  readonly good: Good;
  readonly mode: Mode;
  readonly qty: number;
  /** Current unit price on the table (fractional; the deal total is rounded). */
  readonly unit: number;
  readonly open: number;
  /** Best price the merchant will ever accept (floor when buying, ceiling when selling). */
  readonly limit: number;
  readonly patience: number;
  readonly used: Readonly<Record<string, number>>;
  readonly moves: number;
  readonly over: "deal" | "walked" | null;
}

export interface Context {
  readonly needsCash: boolean;
  readonly comfortable: boolean;
  readonly scarce: boolean;
  readonly overstocked: boolean;
  readonly rivalName: string;
  /** Rival's unit price for the same good (what you could pay / they could buy elsewhere). */
  readonly rivalPrice: number | null;
}

export interface MoveResult {
  readonly session: HaggleSession;
  readonly success: boolean;
  readonly line: string;
}

const PATIENCE_HIT = 14;
const PATIENCE_FAIL = 34;
export const PATIENCE_DRAIN_PER_SEC = 3.5;
const LOT = 3;
const log = (s: EconomyState, text: string): void => {
  s.log.push({ minute: s.minute, kind: "player", text });
  if (s.log.length > 60) s.log.splice(0, s.log.length - 60);
};

export const lockKey = (id: MerchantId): string => `haggleLock.${id}`;
export const isLocked = (s: EconomyState, id: MerchantId): boolean => s.flags[lockKey(id)] === dayOf(s.minute);

/** Kavi sells when he carries mangoes and the merchant is bidding for them (Pema restocking, Arin's kitchen,
 *  Mira buying surplus); otherwise he buys. Arin only ever buys mangoes. */
export function modeFor(s: EconomyState, id: MerchantId): Mode {
  if (id === "arin") return "sell";
  return s.player.inventory.mango > 0 && bidFor(s, id, "mango") ? "sell" : "buy";
}

export function context(s: EconomyState, id: MerchantId, good: Good): Context {
  const m = s.merchants[id];
  const ratio = m.stock[good] / Math.max(1, m.target[good]);
  let rivalName = "Tomas", rivalPrice: number | null = null;
  if (id === "pema" || id === "tomas") {
    const r: MerchantId = id === "pema" ? "tomas" : "pema";
    rivalName = s.merchants[r].name;
    if (s.merchants[r].status === "open" && s.merchants[r].stock[good] > 0) rivalPrice = quote(s, r, good).price;
  } else {
    const best = cheapestMango(s);
    if (best) { rivalName = s.merchants[best.seller].name; rivalPrice = best.price; }
  }
  return {
    needsCash: m.cash < m.rent, comfortable: m.cash > m.rent * 4,
    scarce: ratio < 0.5, overstocked: ratio > 1.2, rivalName, rivalPrice,
  };
}

/** The merchant's thoughts: the live pricing reasons, short enough to read in a second. */
export function thoughts(s: EconomyState, h: HaggleSession): string[] {
  const m = s.merchants[h.merchant];
  const c = context(s, h.merchant, h.good);
  const out: string[] = [];
  if (h.mode === "buy") {
    out.push(m.stock[h.good] <= 5 ? `${m.stock[h.good]} ${h.good === "mango" ? "mangoes" : h.good + "s"} left` : c.overstocked ? "Too many crates" : `${m.stock[h.good]} in stock`);
  } else {
    out.push(h.merchant === "arin" ? (c.scarce ? "Kitchen almost out of mangoes" : "Kitchen has mangoes") : c.scarce ? "Shelves almost empty" : "Shelves stocked");
  }
  out.push(c.needsCash ? `Rent due, ${Math.floor(m.cash)} of ${m.rent} c` : c.comfortable ? "Cash box full" : "Rent covered");
  if (c.rivalPrice !== null) {
    const mine = h.mode === "buy" ? quote(s, h.merchant, h.good).price : h.unit;
    out.push(h.mode === "buy"
      ? (c.rivalPrice < mine ? `${c.rivalName.split(" ").pop()} sells at ${c.rivalPrice} c` : `${c.rivalName.split(" ").pop()} asks ${c.rivalPrice} c`)
      : `${c.rivalName.split(" ").pop()} sells at ${c.rivalPrice} c`);
  }
  const rep = s.player.rep[h.merchant];
  if (rep >= 10) out.push("Likes you");
  else if (rep <= -10) out.push("Remembers you badly");
  return out;
}

export function openHaggle(s: EconomyState, id: MerchantId): HaggleSession | { error: string } {
  const m = s.merchants[id];
  if (m.status !== "open") return { error: `${m.shop} is closed.` };
  if (isLocked(s, id)) return { error: `${PERSONALITY[id].name} won't haggle with you again today.` };
  const good: Good = "mango";
  const mode = modeFor(s, id);
  if (mode === "buy") {
    const q = quote(s, id, good);
    const qty = Math.min(LOT, m.stock[good], Math.floor(s.player.coins / q.price));
    if (m.stock[good] <= 0) return { error: "Sold out." };
    if (qty <= 0) return { error: `Not enough coins (${q.price} c each).` };
    const floor = Math.min(q.price, m.baseCost[good] * (1 + m.greed * 0.3) * (m.cash < m.rent ? 0.9 : 1));
    return { merchant: id, good, mode, qty, unit: q.price, open: q.price, limit: floor, patience: PERSONALITY[id].patience, used: {}, moves: 0, over: null };
  }
  const have = s.player.inventory[good];
  if (have <= 0) return { error: `${m.name} buys mangoes. You have none to sell.` };
  const c = context(s, id, good);
  const scarcity = Math.min(2.2, Math.max(0.8, 1 + 1.1 * (1 - m.stock[good] / Math.max(1, m.target[good]))));
  const ceiling = Math.max(m.baseCost[good] * scarcity, (c.rivalPrice ?? m.baseCost[good]) * 1.15);
  const qty = Math.min(LOT, have, Math.floor(m.cash / ceiling));
  if (qty <= 0) return { error: `${m.name} can't afford mangoes right now.` };
  const offer = Math.max(1, Math.round(ceiling * 0.62));
  return { merchant: id, good, mode, qty, unit: offer, open: offer, limit: ceiling, patience: PERSONALITY[id].patience, used: {}, moves: 0, over: null };
}

/** How well a tactic lands (-1..1) and what the merchant says. Personality x situation. */
function judge(s: EconomyState, h: HaggleSession, t: Exclude<Tactic, "fair">): { e: number; line: string } {
  const c = context(s, h.merchant, h.good);
  const m = s.merchants[h.merchant];
  const rivalCheaper = c.rivalPrice !== null && c.rivalPrice < Math.round(h.unit);
  const rival = c.rivalName.split(" ").pop();
  const repHigh = s.player.rep[h.merchant] >= 10;
  if (h.merchant === "pema") {
    switch (t) {
      case "flatter": return { e: 0.8, line: "Best mangoes on the Row, that's true. Fine, for you." };
      case "lowball": return c.needsCash ? { e: 0.55, line: "...Rent is rent. Take it before I change my mind." } : { e: -0.8, line: "You think I grow these in a bucket? No." };
      case "rival": return rivalCheaper && (c.needsCash || repHigh)
        ? { e: 0.35, line: `Vell's fruit is gas-ripened. But... alright, close to his.` }
        : { e: -0.9, line: `Then go and buy from ${rival}. I'll wait.` };
      case "bundle": return c.scarce || h.qty >= m.stock[h.good]
        ? { e: -0.5, line: "Bundle? I have " + m.stock[h.good] + " mangoes in the whole stall." }
        : { e: 0.5, line: "A big order! Now you're talking." };
    }
  }
  if (h.merchant === "tomas") {
    switch (t) {
      case "flatter": return { e: 0.12, line: "Compliments don't pay my berth fee. Maybe a coin." };
      case "lowball": return c.overstocked || !c.comfortable
        ? { e: 0.5, line: "Crates don't sell themselves. Fine." }
        : { e: -0.7, line: "Ha. My cart came in at six. I can wait, you can't." };
      case "rival": return rivalCheaper
        ? { e: 0.9, line: `Pema? She's three crates from closing. ...I'll match ${c.rivalPrice}.` }
        : { e: -0.5, line: `${rival} asks more than me and you know it.` };
      case "bundle": return c.scarce
        ? { e: -0.4, line: "I'm not dumping stock on one customer." }
        : { e: 0.7, line: "Volume I like. Volume gets a discount." };
    }
  }
  // Arin: cost-plus. He pays what the lassi can carry and not a coin of sentiment.
  switch (t) {
    case "flatter": return { e: -0.15, line: "Kind. My lassi still costs what the mangoes cost." };
    case "lowball": return c.scarce
      ? { e: 0.55, line: "My kitchen's nearly out. Alright, a little more." }
      : { e: -0.6, line: "I have mangoes. I don't need yours at that price." };
    case "rival": return c.rivalPrice !== null && c.rivalPrice > h.unit
      ? { e: 0.85, line: `${rival} charges ${c.rivalPrice}. Fine, I'll pay closer to that.` }
      : { e: -0.6, line: `${rival} sells cheaper than you're asking. Try again.` };
    case "bundle": return c.scarce
      ? { e: 0.6, line: "A full crate saves me the walk at seven. Deal-ish." }
      : { e: -0.3, line: "More than I can store. No." };
  }
}

/** Apply one tactic. Fair closes the deal at the current price (call closeDeal next). */
export function applyTactic(s: EconomyState, h: HaggleSession, t: Tactic): MoveResult {
  if (h.over) return { session: h, success: false, line: "" };
  if (t === "fair") return { session: { ...h, over: "deal" }, success: true, line: h.moves === 0 ? "A fair customer. Rare." : "Done." };
  const used = h.used[t] ?? 0;
  let { e, line } = judge(s, h, t);
  if (used > 0) { // the same trick twice is never as good, and a third time annoys everyone
    e = e > 0 ? e * 0.35 - 0.15 * used : e - 0.2;
    if (e <= 0) line = "You said that already.";
  }
  const range = Math.max(0.6, Math.abs(h.limit - h.open));
  const sign = h.mode === "buy" ? -1 : 1;
  const success = e > 0;
  let unit = success ? h.unit + sign * e * range * 0.55 : h.unit - sign * range * 0.18;
  let qty = h.qty;
  if (t === "bundle" && success) {
    const m = s.merchants[h.merchant];
    const cap = h.mode === "buy"
      ? Math.min(m.stock[h.good], Math.floor(s.player.coins / Math.max(unit, 0.01)))
      : Math.min(s.player.inventory[h.good], Math.floor(m.cash / Math.max(unit, 0.01)));
    qty = Math.max(h.qty, Math.min(h.qty * 2, cap));
  }
  // Clamp between the merchant's limit and 20% worse than the opening.
  const worst = h.mode === "buy" ? h.open * 1.2 : h.open * 0.8;
  unit = h.mode === "buy" ? Math.min(worst, Math.max(h.limit, unit)) : Math.max(worst, Math.min(h.limit, unit));
  const patience = Math.max(0, h.patience - (success ? PATIENCE_HIT : PATIENCE_FAIL));
  const over = patience <= 0 ? "walked" : null;
  if (over) line = h.mode === "buy" ? "Enough. Come back tomorrow." : "I have a kitchen to run. Tomorrow.";
  return { session: { ...h, unit, qty, patience, used: { ...h.used, [t]: used + 1 }, moves: h.moves + 1, over }, success, line };
}

/** Patience drains while you think. */
export function tickPatience(h: HaggleSession, seconds: number): HaggleSession {
  if (h.over) return h;
  const patience = Math.max(0, h.patience - PATIENCE_DRAIN_PER_SEC * seconds);
  return { ...h, patience, over: patience <= 0 ? "walked" : null };
}

export const dealTotal = (h: HaggleSession): number => Math.max(1, Math.round(h.unit * h.qty));

export interface DealOutcome {
  readonly ok: boolean;
  readonly message: string;
  readonly total: number;
  /** Coins saved (buy) or earned above the opening (sell) versus the opening price. */
  readonly gain: number;
  readonly repDelta: number;
}

/** Execute the deal (or the walk-out) against the economy. */
export function closeDeal(s: EconomyState, h: HaggleSession): DealOutcome {
  const m = s.merchants[h.merchant];
  const p = PERSONALITY[h.merchant];
  if (h.over === "walked") {
    s.flags[lockKey(h.merchant)] = dayOf(s.minute);
    adjustRep(s, h.merchant, -3);
    log(s, `${p.name} lost patience with you and closed the haggle.`);
    return { ok: false, message: `${p.name} walked away. -3 rep`, total: 0, gain: 0, repDelta: -3 };
  }
  const total = dealTotal(h);
  const openTotal = Math.round(h.open * h.qty);
  if (h.mode === "buy") {
    if (m.stock[h.good] < h.qty || s.player.coins < total) return { ok: false, message: "The deal fell through.", total, gain: 0, repDelta: 0 };
    m.stock[h.good] -= h.qty;
    m.cash += total;
    m.recentSales[h.good] += h.qty * 0.3;
    s.player.coins -= total;
    s.player.inventory[h.good] += h.qty;
  } else {
    if (s.player.inventory[h.good] < h.qty || m.cash < total) return { ok: false, message: "The deal fell through.", total, gain: 0, repDelta: 0 };
    s.player.inventory[h.good] -= h.qty;
    s.player.coins += total;
    m.cash -= total;
    m.stock[h.good] += h.qty;
  }
  const squeezed = Math.abs(h.unit - h.limit) < Math.abs(h.limit - h.open) * 0.2;
  let rep = h.moves === 0 ? 3 : 1;
  if (squeezed && h.merchant === "pema") rep = -1; // proud: she remembers being squeezed
  if (squeezed && h.merchant === "tomas") rep = 2; // greedy: respects a hard bargain
  adjustRep(s, h.merchant, rep);
  const gain = h.mode === "buy" ? openTotal - total : total - openTotal;
  const verb = h.mode === "buy" ? `bought ${h.qty} ${h.good}s from` : `sold ${h.qty} ${h.good}s to`;
  log(s, `You ${verb} ${p.name} for ${total} c (opened at ${openTotal} c).`);
  return { ok: true, message: `${h.mode === "buy" ? "Bought" : "Sold"} ${h.qty} for ${total} c`, total, gain, repDelta: rep };
}
