// Deterministic market simulation (no randomness): the same choices always give the same city.
// Time advances in game minutes; rules fire on hour boundaries. Called every frame with real dt,
// and by fast-forward with large spans. ponytail: mutates state in place (one owner, hot loop).
import { clockOf, dayOf, MINUTES_PER_DAY, type EconomyState, type Good, type MerchantId } from "./state.ts";
import { cheapestMango, lassiPrice, quote } from "./pricing.ts";

/** Shoppers per open hour wanting each good across the whole market, at a fair price. */
const HOURLY_DEMAND: Record<Good, number> = { mango: 1.6, lemon: 1.2, lassi: 2.4 };
const ELASTICITY = 1.3;
const OPEN_FROM = 8;
const OPEN_UNTIL = 20;
const RENT_HOUR = 21;
const LOG_LIMIT = 60;

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
  return units;
}

function shoppers(state: EconomyState): void {
  const sold: Record<MerchantId, Record<Good, number>> = {
    pema: { mango: 0, lemon: 0, lassi: 0 }, tomas: { mango: 0, lemon: 0, lassi: 0 }, teahouse: { mango: 0, lemon: 0, lassi: 0 },
  };
  for (const good of ["mango", "lemon"] as const) {
    for (const id of ["pema", "tomas"] as const) {
      const m = state.merchants[id];
      if (m.status !== "open") continue;
      const price = quote(state, id, good, false).price;
      const fair = m.baseCost[good] * 1.2;
      // Shoppers split between the two fruit sellers; the cheaper one draws more of them.
      const want = (HOURLY_DEMAND[good] / 2) * Math.pow(fair / price, ELASTICITY);
      sold[id][good] = sell(state, id, good, take(state, `${id}.${good}`, want), price);
    }
  }
  const t = state.merchants.teahouse;
  if (t.status === "open") {
    const price = lassiPrice(state).price;
    const want = HOURLY_DEMAND.lassi * Math.pow((t.baseCost.lassi * 1.5) / price, ELASTICITY);
    sold.teahouse.lassi = sell(state, "teahouse", "lassi", take(state, "teahouse.lassi", want), price);
    // The kitchen turns mangoes into lassi as glasses run out.
    while (t.stock.lassi < 8 && t.stock.mango > 0) {
      t.stock.mango -= 1;
      t.stock.lassi += 4;
    }
  }
  for (const id of ["pema", "tomas", "teahouse"] as const) {
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
        state.merchants.teahouse.stock.mango += units;
        state.flags.forwardQty = 0;
        log(state, "trade", `${units} pre-paid crates went from ${state.merchants[s.to].name} to the Tea House.`);
      }
    }
  }
}

function hourTick(state: EconomyState, hour: number): void {
  const day = dayOf(state.minute);
  shipments(state);
  if (hour === 6 && state.flags.contract !== "challenged") {
    // Tomas holds the harbor's standing supply contract: he restocks every morning.
    const t = state.merchants.tomas;
    const need = Math.max(0, t.target.mango - t.stock.mango);
    t.stock.mango += need;
    t.cash -= need * 2;
  }
  if (hour === 7) {
    const tea = state.merchants.teahouse;
    const need = Math.max(0, tea.target.mango - tea.stock.mango);
    const best = cheapestMango(state);
    if (need > 0 && best) {
      const qty = Math.min(need, state.merchants[best.seller].stock.mango, Math.floor(tea.cash / best.price));
      sell(state, best.seller, "mango", qty, best.price);
      tea.stock.mango += qty;
      tea.cash -= qty * best.price;
      if (qty > 0) log(state, "trade", `Tea House bought ${qty} mangoes from ${state.merchants[best.seller].name} at ${best.price} c.`);
    }
  }
  if (hour === OPEN_FROM) {
    for (const m of Object.values(state.merchants)) {
      const stockValue = m.sells.reduce((v, g) => v + m.stock[g] * m.baseCost[g], 0);
      if (m.status === "closed" && stockValue >= m.rent * 0.75) {
        m.status = "open";
        log(state, "reopened", `${m.shop} reopened with fresh stock.`);
      }
    }
  }
  if (hour >= OPEN_FROM && hour < OPEN_UNTIL) shoppers(state);
  if (hour === RENT_HOUR) {
    for (const m of Object.values(state.merchants)) {
      if ((day - 1) % m.rentEveryDays !== 0 || m.status === "closed") continue;
      if (m.cash >= m.rent) {
        m.cash -= m.rent;
        log(state, "rent", `${m.name} paid ${m.rent} c rent.`);
      } else {
        m.status = "closed";
        log(state, "closed", `${m.shop} could not pay rent and pulled the shutters down.`);
      }
    }
  }
  if (hour === 0) {
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

/** Player pays the harbor's storage fee: the held shipment departs now and arrives in 90 minutes. */
export function payReleaseFee(state: EconomyState, shipmentId: string): ActionResult {
  const s = state.shipments.find((x) => x.id === shipmentId);
  if (!s || s.status !== "held") return { ok: false, message: "Nothing is held." };
  if (state.player.coins < s.releaseFee) return { ok: false, message: `The fee is ${s.releaseFee} c.` };
  state.player.coins -= s.releaseFee;
  s.status = "transit";
  s.arriveAt = state.minute + 90;
  log(state, "player", `You paid the ${s.releaseFee} c storage fee. Mangoes are on their way (${clockOf(s.arriveAt)}).`);
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
  const tea = state.merchants.teahouse;
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
