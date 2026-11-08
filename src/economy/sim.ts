// Deterministic market simulation (no randomness): the same choices always give the same city.
// Time advances in game minutes; rules fire on hour boundaries. Called every frame with real dt,
// and by fast-forward with large spans. ponytail: mutates state in place (one owner, hot loop).
import { clockOf, dayOf, MERCHANT_IDS, MINUTES_PER_DAY, type EconomyState, type Good, type Merchant, type MerchantId } from "./state.ts";
import { DIVIDEND_SHARE, SHARES_PER_STALL, lassiPrice, planMerchantTrades, quote, type MerchantTrade } from "./pricing.ts";

/** Shoppers per open hour wanting each good across the whole market, at a fair price. */
const HOURLY_DEMAND: Record<Good, number> = { mango: 1.6, lemon: 1.2, lassi: 2.4 };
const ELASTICITY = 1.3;
const OPEN_FROM = 8;
const OPEN_UNTIL = 20;
const RENT_HOUR = 21;
const LOG_LIMIT = 60;
/** Tomas's harbor contract lands 140% of his normal stock each morning: the surplus Mira buys up. */
const TOMAS_CONTRACT_FILL = 1.4;

function log(state: EconomyState, kind: EconomyState["log"][number]["kind"], text: string): void {
  state.log.push({ minute: state.minute, kind, text });
  if (state.log.length > LOG_LIMIT) state.log.splice(0, state.log.length - LOG_LIMIT);
}

/** Integer units out of a fractional demand stream (carry keeps it exact over time). */
function take(state: EconomyState, key: string, amount: number): number {
  const total = (state.carry[key] ?? 0) + amount;
  const units = Math.floor(total);
  state.carry[key] = total - units;
  return units;
}

function sell(state: EconomyState, id: MerchantId, good: Good, wanted: number, price: number): number {
  const m = state.merchants[id];
  const units = Math.min(wanted, m.stock[good]);
  m.stock[good] -= units;
  m.cash += units * price;
  if (good !== "lassi" || id === "arin") state.flags[`rev.${id}`] = Number(state.flags[`rev.${id}`] ?? 0) + units * price;
  return units;
}

/** Applies merchant-to-merchant trades (the same plan the merchants' NEAR agents execute on chain). */
export function applyMerchantTrades(state: EconomyState, trades: readonly MerchantTrade[]): void {
  for (const t of trades) {
    const units = sell(state, t.seller, t.good, t.qty, t.price);
    state.merchants[t.buyer].stock[t.good] += units;
    state.merchants[t.buyer].cash -= units * t.price;
    if (units > 0) log(state, "trade", `${state.merchants[t.buyer].name} bought ${units} ${t.good === "mango" ? (units > 1 ? "mangoes" : "mango") : `${t.good}${units > 1 ? "s" : ""}`} from ${state.merchants[t.seller].name} at ${t.price} c (${t.reason.toLowerCase()}).`);
  }
}

const FRUIT_SELLERS = MERCHANT_IDS.filter((id) => id !== "arin");

/** Street shoppers per open hour wanting `good` from stall `id` at its current price (fractional units).
 *  The cheaper a stall is against a fair price, the more of them it draws. Also used by the merchants' NEAR agents. */
export function shopperWant(state: EconomyState, id: MerchantId, good: Good): number {
  const m = state.merchants[id];
  if (m.status !== "open" || !m.sells.includes(good)) return 0;
  const price = quote(state, id, good, false).price;
  if (good === "lassi") return HOURLY_DEMAND.lassi * Math.pow((m.baseCost.lassi * 1.5) / price, ELASTICITY);
  return (HOURLY_DEMAND[good] / FRUIT_SELLERS.length) * Math.pow((m.baseCost[good] * 1.2) / price, ELASTICITY);
}

function shoppers(state: EconomyState): void {
  const sold = Object.fromEntries(MERCHANT_IDS.map((id) => [id, { mango: 0, lemon: 0, lassi: 0 }])) as Record<MerchantId, Record<Good, number>>;
  for (const good of ["mango", "lemon"] as const) {
    for (const id of FRUIT_SELLERS) {
      const m = state.merchants[id];
      if (m.status !== "open") continue;
      const price = quote(state, id, good, false).price;
      sold[id][good] = sell(state, id, good, take(state, `${id}.${good}`, shopperWant(state, id, good)), price);
    }
  }
  const t = state.merchants.arin;
  if (t.status === "open") {
    const price = lassiPrice(state).price;
    const want = shopperWant(state, "arin", "lassi");
    sold.arin.lassi = sell(state, "arin", "lassi", take(state, "arin.lassi", want), price);
    // The kitchen turns mangoes into lassi as glasses run out.
    while (t.stock.lassi < 8 && t.stock.mango > 0) {
      t.stock.mango -= 1;
      t.stock.lassi += 4;
    }
  }
  for (const id of MERCHANT_IDS) {
    const m = state.merchants[id];
    for (const g of ["mango", "lemon", "lassi"] as const) m.recentSales[g] = m.recentSales[g] * 0.7 + sold[id][g] * 0.3;
  }
}

function shipments(state: EconomyState): void {
  for (const s of state.shipments) {
    if (s.status === "held" && state.minute >= s.autoReleaseAt) {
      s.status = "transit";
      s.arriveAt = state.minute + 120;
      log(state, "shipment", "The harbor finally released Pema's mangoes.");
    }
    if (s.status === "transit" && s.arriveAt !== null && state.minute >= s.arriveAt) {
      s.status = "delivered";
      state.merchants[s.to].stock[s.good] += s.qty;
      log(state, "shipment", `${s.qty} ${s.good === "mango" ? "mangoes" : `${s.good}s`} delivered to ${state.merchants[s.to].shop}.`);
      const forward = Number(state.flags.forwardQty ?? 0);
      if (forward > 0 && s.good === "mango") { // pre-paid crates (NEAR Labs forward order) go straight on
        const units = Math.min(forward, state.merchants[s.to].stock.mango);
        state.merchants[s.to].stock.mango -= units;
        state.merchants.arin.stock.mango += units;
        state.flags.forwardQty = 0;
        log(state, "trade", `${units} pre-paid crates went from ${state.merchants[s.to].name} to the Tea House.`);
      }
    }
  }
}

/** Stock a closed stall needs before it can open again: goods worth three quarters of its rent. */
export const REOPEN_SHARE = 0.75;
const stockValue = (m: Merchant): number => m.sells.reduce((v, g) => v + m.stock[g] * m.baseCost[g], 0);
const shelfGap = (m: Merchant): number =>
  Math.max(0, Math.ceil((m.rent * REOPEN_SHARE - stockValue(m)) / Math.max(1, m.baseCost.mango)));
/** Mangoes still missing before a closed stall can reopen (0 when it is open or ready). The target is fixed when
 *  the stall closes and counts deliveries, so street sales of the restocked shelves never move it away. */
export function reopenGap(state: EconomyState, id: MerchantId): number {
  const m = state.merchants[id];
  if (m.status === "open") return 0;
  const left = state.flags[`reopenNeed.${id}`];
  return typeof left === "number" ? Math.max(0, Math.min(left, shelfGap(m))) : shelfGap(m);
}
/** Counts mangoes delivered to a closed stall toward its reopening. Call after the delivery landed. */
export function recordRestock(state: EconomyState, id: MerchantId, qty: number): void {
  const m = state.merchants[id];
  if (m.status === "open") return;
  const left = state.flags[`reopenNeed.${id}`];
  state.flags[`reopenNeed.${id}`] = (typeof left === "number" ? left : shelfGap(m) + qty) - qty;
}
/** Reopens a closed stall whose shelves are stocked again; true if it just reopened. */
export function tryReopen(state: EconomyState, id: MerchantId): boolean {
  const m = state.merchants[id];
  if (m.status !== "closed" || reopenGap(state, id) > 0) return false;
  m.status = "open";
  delete state.flags[`reopenNeed.${id}`];
  log(state, "reopened", `${m.shop} reopened with fresh stock.`);
  return true;
}

function hourTick(state: EconomyState, hour: number): void {
  const day = dayOf(state.minute);
  shipments(state);
  if (hour === 6 && state.flags.contract !== "challenged") {
    // Tomas holds the harbor's standing supply contract: every morning it lands more than he can sell.
    const t = state.merchants.tomas;
    const need = Math.max(0, Math.round(t.target.mango * TOMAS_CONTRACT_FILL) - t.stock.mango);
    t.stock.mango += need;
    t.cash -= need * 2;
  }
  if (hour === 7 || hour === 14) applyMerchantTrades(state, planMerchantTrades(state));
  if (hour === OPEN_FROM) for (const id of MERCHANT_IDS) tryReopen(state, id);
  if (hour >= OPEN_FROM && hour < OPEN_UNTIL) shoppers(state);
  if (hour === RENT_HOUR) {
    for (const m of Object.values(state.merchants)) {
      if ((day - 1) % m.rentEveryDays !== 0 || m.status === "closed") continue;
      if (m.cash >= m.rent) {
        m.cash -= m.rent;
        log(state, "rent", `${m.name} paid ${m.rent} c rent.`);
      } else {
        m.status = "closed";
        state.flags[`reopenNeed.${m.id}`] = shelfGap(m);
        log(state, "closed", `${m.shop} could not pay rent and pulled the shutters down.`);
      }
    }
  }
  if (hour === 0) {
    payDividends(state, day - 1);
    state.history.push({
      day: day - 1,
      pemaMango: quote(state, "pema", "mango", false).price,
      tomasMango: quote(state, "tomas", "mango", false).price,
      lassi: lassiPrice(state).price,
      pemaCash: Math.round(state.merchants.pema.cash),
      pemaOpen: state.merchants.pema.status === "open",
    });
    if (state.history.length > 30) state.history.shift();
  }
}

/** Midnight: each stall pays DIVIDEND_SHARE of the day's revenue to its shareholders, pro rata and rounded
 *  down (the same integer rule as the contract's settle_day); the player's cut lands in their purse. */
function payDividends(state: EconomyState, day: number): void {
  for (const id of MERCHANT_IDS) {
    const m = state.merchants[id];
    const revenue = Math.floor(Number(state.flags[`rev.${id}`] ?? 0));
    state.flags[`rev.${id}`] = 0;
    const pool = Math.min(Math.floor(revenue * DIVIDEND_SHARE), Math.floor(m.cash));
    const paid = Math.floor((pool * state.player.shares[id]) / SHARES_PER_STALL);
    if (paid <= 0) continue;
    m.cash -= paid;
    state.player.coins += paid;
    state.flags[`div.${id}`] = Number(state.flags[`div.${id}`] ?? 0) + paid;
    log(state, "player", `+${paid} c dividend from ${m.shop} (day ${day}: ${revenue} c sales, ${state.player.shares[id]}/${SHARES_PER_STALL} shares).`);
  }
}

/** Advance the city by `minutes` of game time. Returns how many hour ticks ran. */
export function advance(state: EconomyState, minutes: number): number {
  let remaining = minutes;
  let ticks = 0;
  while (remaining > 1e-9) {
    const toHour = 60 - (state.minute % 60);
    const step = Math.min(remaining, toHour);
    state.minute += step;
    remaining -= step;
    if (Math.abs(state.minute % 60) < 1e-9 || state.minute % 60 > 59.999999) {
      state.minute = Math.round(state.minute);
      hourTick(state, Math.floor((state.minute % MINUTES_PER_DAY) / 60));
      ticks++;
    }
  }
  return ticks;
}

// ------------------------------------------------------------------ actions ----

export interface ActionResult {
  readonly ok: boolean;
  readonly message: string;
}

export function playerBuy(state: EconomyState, id: MerchantId, good: Good, qty: number): ActionResult {
  const m = state.merchants[id];
  if (m.status !== "open") return { ok: false, message: `${m.shop} is closed.` };
  const price = quote(state, id, good).price;
  const units = Math.min(qty, m.stock[good], Math.floor(state.player.coins / price));
  if (units <= 0) return { ok: false, message: m.stock[good] <= 0 ? "Sold out." : "Not enough coins." };
  sell(state, id, good, units, price);
  state.player.coins -= units * price;
  state.player.inventory[good] += units;
  log(state, "player", `You bought ${units} ${good}${units > 1 ? "s" : ""} from ${m.name} for ${units * price} c.`);
  return { ok: true, message: `Bought ${units} for ${units * price} c.` };
}

/** The player (or the receiving merchant, e.g. with a new partner's money) pays the harbor's storage fee: the held
 *  shipment departs now and arrives in 90 minutes. */
export function payReleaseFee(state: EconomyState, shipmentId: string, payer: "player" | "merchant" = "player"): ActionResult {
  const s = state.shipments.find((x) => x.id === shipmentId);
  if (!s || s.status !== "held") return { ok: false, message: "Nothing is held." };
  const m = state.merchants[s.to];
  const purse = payer === "player" ? state.player.coins : m.cash;
  if (purse < s.releaseFee) return { ok: false, message: `The fee is ${s.releaseFee} c.` };
  if (payer === "player") state.player.coins -= s.releaseFee; else m.cash -= s.releaseFee;
  s.status = "transit";
  s.arriveAt = state.minute + 90;
  log(state, "player", `${payer === "player" ? "You" : m.name} paid the ${s.releaseFee} c storage fee. Mangoes are on their way (${clockOf(s.arriveAt)}).`);
  return { ok: true, message: "Shipment released." };
}

/** Pema buys what she can afford from her rival, at his NPC price plus a spite markup. */
export function pemaBuysFromTomas(state: EconomyState, wanted: number): ActionResult {
  const p = state.merchants.pema;
  const price = Math.round(quote(state, "tomas", "mango", false).price * 1.15);
  const qty = Math.min(wanted, state.merchants.tomas.stock.mango, Math.floor(p.cash / price));
  if (qty <= 0) return { ok: false, message: "Pema cannot afford a single crate from Tomas." };
  sell(state, "tomas", "mango", qty, price);
  p.cash -= qty * price;
  p.stock.mango += qty;
  log(state, "trade", `Pema bought ${qty} mangoes from Tomas Vell at ${price} c each.`);
  return { ok: true, message: `Pema bought ${qty} at ${price} c.` };
}

/** Labs insight A: the player files the agent's finding that T. Vell's standing berth contract gives his
 *  cargo cold-storage priority. The harbor suspends it: Pema's hold clears at the next 06:00 and Tomas
 *  loses his free morning restock. */
export function challengeStandingContract(state: EconomyState): ActionResult {
  if (state.flags.contract) return { ok: false, message: "The contract has already been dealt with." };
  state.flags.contract = "challenged";
  const s = state.shipments.find((x) => x.id === "pema-mangoes");
  if (s && s.status === "held") {
    const dayStart = Math.floor(state.minute / MINUTES_PER_DAY) * MINUTES_PER_DAY;
    const next6 = dayStart + 6 * 60 > state.minute ? dayStart + 6 * 60 : dayStart + MINUTES_PER_DAY + 6 * 60;
    (s as { autoReleaseAt: number }).autoReleaseAt = Math.min(s.autoReleaseAt, next6);
  }
  log(state, "quest", "Harbor suspended T. Vell's standing berth contract after a NEAR Labs report.");
  return { ok: true, message: s?.status === "held" ? `Pema's hold now clears ${clockOf(s.autoReleaseAt)}.` : "Contract suspended." };
}

/** Labs insight B: the agent matches the Tea House's mango need to Pema's held crates. The Tea House
 *  pre-pays at cost now; the crates go to it when the shipment lands. */
export function teahouseForwardBuy(state: EconomyState, qty: number): ActionResult {
  const tea = state.merchants.arin;
  const price = state.merchants.pema.baseCost.mango;
  const s = state.shipments.find((x) => x.id === "pema-mangoes");
  if (!s || s.status === "delivered") return { ok: false, message: "The shipment already landed." };
  if (Number(state.flags.forwardQty ?? 0) > 0) return { ok: false, message: "A forward order is already booked." };
  const units = Math.min(qty, Math.floor(tea.cash / price));
  if (units <= 0) return { ok: false, message: "The Tea House cannot pre-pay." };
  tea.cash -= units * price;
  state.merchants.pema.cash += units * price;
  state.flags.forwardQty = units;
  log(state, "trade", `Tea House pre-paid Pema ${units * price} c for ${units} crates on the held shipment.`);
  return { ok: true, message: `Tea House pre-paid ${units * price} c to Pema.` };
}

/** Insight C: the player sells the finding to Tomas, who pays to keep his contract quiet. */
export function sellInsightToTomas(state: EconomyState, fee: number): ActionResult {
  if (state.flags.contract) return { ok: false, message: "The contract has already been dealt with." };
  const t = state.merchants.tomas;
  const paid = Math.min(fee, Math.floor(t.cash));
  t.cash -= paid;
  state.player.coins += paid;
  state.flags.contract = "sold";
  log(state, "player", `+${paid} c: Tomas Vell paid you to forget his harbor contract.`);
  return { ok: true, message: `+${paid} c from Tomas.` };
}

export function adjustRep(state: EconomyState, id: MerchantId, delta: number): void {
  state.player.rep[id] = Math.max(-50, Math.min(50, state.player.rep[id] + delta));
}

export function addCoins(state: EconomyState, amount: number, why: string): void {
  state.player.coins += amount;
  log(state, "player", `${amount >= 0 ? "+" : ""}${amount} c: ${why}`);
}

export function note(state: EconomyState, text: string): void {
  log(state, "quest", text);
}

/** The posted price of one stall share (each stall floats 100; the contract's opening asks use the same numbers). */
export const SHARE_PRICE: Record<MerchantId, number> = { pema: 5, tomas: 9, mira: 7, arin: 6 };
/** Shares at which a stall is upgraded (awning, lights, fuller shelves). */
export const UPGRADE_AT = 4;

/** The player buys stall shares: coins go to the merchant (capital, not revenue). */
export function invest(state: EconomyState, id: MerchantId, shares: number): ActionResult {
  const m = state.merchants[id];
  const cost = SHARE_PRICE[id] * shares;
  if (shares <= 0) return { ok: false, message: "Pick how many shares." };
  if (state.player.coins < cost) return { ok: false, message: `${shares} shares cost ${cost} c.` };
  state.player.coins -= cost;
  m.cash += cost;
  const before = state.player.shares[id];
  state.player.shares[id] += shares;
  log(state, "player", `You bought ${shares} shares of ${m.shop} for ${cost} c.`);
  if (before < UPGRADE_AT && state.player.shares[id] >= UPGRADE_AT) log(state, "trade", `${m.shop} used the investment to upgrade the stall.`);
  return { ok: true, message: `Bought ${shares} shares for ${cost} c.` };
}
