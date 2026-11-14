// A market model that replays the relayer's on-chain market turn (server/near/handlers.ts `tick`) on an EconomyState,
// step for step: rent, Guild, merchants' bids, merchant trades, residents, street shoppers, the harbor and the kitchen.
// Used by the recovery simulations so many market days can be tested without a chain. Coin is tracked like the
// contract: it enters only through street shoppers and starter purses, and leaves only as rent and harbor freight;
// every other move is a transfer. `rules: "old"` replays the turn as it was before the recovery fixes (diagnosis).
// ponytail: rule prices only (no NEAR AI in the model); dividends via accrueSale as offline.
import { RESIDENTS, executableOffers, planResident, type Offer } from "./residents.ts";
import { bidFor, planMerchantTrades, quote } from "./pricing.ts";
import { accrueSale, applyMerchantTrades, closingNeed, shopperWant } from "./sim.ts";
import { MERCHANT_IDS, type EconomyState, type MerchantId } from "./state.ts";
import { GUILD_DUES, GUILD_FLOAT, GUILD_FUND, GUILD_HEALTHY, debtOf, guildPlan, harborDue, harborQty, rentToCharge, touristUnits, type GuildMove } from "./recovery.ts";

/** Game hours of street trade one turn represents (handlers.ts TICK_HOURS). */
export const TICK_HOURS = 2;
const HARBOR_COST = 2;

export interface Purse { coin: number; mango: number; lemon: number; lassi: number }
export interface Town {
  readonly st: EconomyState;
  guild: number;
  readonly residents: Record<string, Purse>;
  /** Which residents have NEAR accounts (residentTurn skips unregistered ones). */
  readonly registered: ReadonlySet<string>;
  readonly carry: Record<string, number>;
  readonly reopened: Record<string, number>;
  readonly once: Set<string>;
  readonly ledger: { minted: number; burned: number; byReason: Record<string, number> };
  /** Units street shoppers bought, by good (the demand the turn actually served). */
  readonly sold: Record<string, number>;
  readonly log: string[];
}

export const newTown = (st: EconomyState, guild: number, residents: Record<string, Purse>, registered: readonly string[] = ["picker"]): Town =>
  ({ st, guild, residents, registered: new Set(registered), carry: {}, reopened: {}, once: new Set(), sold: {}, ledger: { minted: 0, burned: 0, byReason: {} }, log: [] });

/** Every coin in the town: tills, the player, the Guild, residents and share reserves. */
export const coinsIn = (t: Town): number => MERCHANT_IDS.reduce((n, id) => n + t.st.merchants[id].cash + Number(t.st.flags[`reserve.${id}`] ?? 0), 0) + t.st.player.coins + t.guild + Object.values(t.residents).reduce((n, r) => n + r.coin, 0);

const mint = (t: Town, n: number, why: string): void => { t.ledger.minted += n; t.ledger.byReason[why] = (t.ledger.byReason[why] ?? 0) + n; };
const burn = (t: Town, n: number, why: string): void => { t.ledger.burned += n; t.ledger.byReason[why] = (t.ledger.byReason[why] ?? 0) - n; };
const once = (t: Town, key: string): boolean => (t.once.has(key) ? false : (t.once.add(key), true));

/** A delivery into a stall's bid: the contract moves coin and goods and counts mangoes toward a closed stall's reopening. */
function deliver(t: Town, id: MerchantId, qty: number, price: number, day: number): void {
  const m = t.st.merchants[id];
  m.cash -= qty * price; m.stock.mango += qty;
  if (m.status !== "open") {
    const left = Number(t.st.flags[`reopenNeed.${id}`] ?? 1) - qty;
    if (left <= 0) { m.status = "open"; delete t.st.flags[`reopenNeed.${id}`]; t.reopened[id] = day; t.log.push(`day ${day}: ${id} reopened`); }
    else t.st.flags[`reopenNeed.${id}`] = left;
  }
}

/** One market turn on market day `day`. Safe to call several times a day: once-per-day steps run once. */
export function marketTurn(t: Town, day: number, rules: "old" | "new" = "new"): void {
  const st = t.st, recovery = rules === "new";
  // rent (charge_rent: once per stall and day; a stall that cannot pay closes until `need` mangoes are delivered)
  for (const id of MERCHANT_IDS) {
    const m = st.merchants[id];
    if (m.status !== "open" || day % m.rentEveryDays !== 0 || !once(t, `rent:${id}:${day}`)) continue;
    const { rent, grace } = recovery ? rentToCharge(m, day, t.reopened[id] ?? null, () => once(t, `grace:${id}:${t.reopened[id]}`)) : { rent: m.rent, grace: false };
    if (grace) { t.log.push(`day ${day}: ${id} rent waived once (recovery grace)`); continue; }
    if (m.cash >= rent) { m.cash -= rent; burn(t, rent, "rent"); }
    else { m.status = "closed"; st.flags[`reopenNeed.${id}`] = Math.max(1, closingNeed(st, id)); t.log.push(`day ${day}: ${id} closed (rent ${rent}, till ${Math.floor(m.cash)})`); }
  }
  // the Guild (guild_lend / guild_collect)
  const debt = Object.fromEntries(MERCHANT_IDS.map((id) => [id, debtOf(st, id)]));
  const rescueOf = (id: MerchantId): number => st.merchants[id].status === "open" ? 0 : Number(st.flags[`reopenNeed.${id}`] ?? 0) * (bidFor(st, id, "mango")?.price ?? 0);
  const moves = recovery
    ? guildPlan(st, MERCHANT_IDS, t.guild, debt, rescueOf, (id) => once(t, `collect:${id}:${day}`))
    : MERCHANT_IDS.flatMap((id): GuildMove[] => { // the rules before the recovery fixes (handlers.ts guildTurn as committed)
      const m = st.merchants[id], float = Math.max(GUILD_FLOAT, rescueOf(id));
      if (m.cash < float && t.guild > 0) { const amount = Math.min(float - m.cash, t.guild); return [{ merchant: id, kind: "lend", amount, repaid: 0, dues: 0 }]; }
      if (m.cash <= GUILD_HEALTHY) return [];
      const lent = MERCHANT_IDS.reduce((n, x) => n + debtOf(st, x), 0), repaid = Math.min(debt[id], m.cash - GUILD_HEALTHY);
      const dues = Math.max(0, Math.min(m.cash - GUILD_HEALTHY - repaid, GUILD_DUES, GUILD_FUND - (t.guild + lent)));
      return repaid + dues > 0 && once(t, `collect:${id}:${day}`) ? [{ merchant: id, kind: "collect", amount: repaid + dues, repaid, dues }] : [];
    });
  for (const g of moves) {
    const m = st.merchants[g.merchant];
    if (g.kind === "lend") { const a = Math.min(g.amount, t.guild); t.guild -= a; m.cash += a; st.flags[`debt.${g.merchant}`] = debtOf(st, g.merchant) + a; }
    else { m.cash -= g.amount; t.guild += g.amount; st.flags[`debt.${g.merchant}`] = debtOf(st, g.merchant) - g.repaid; }
  }
  // merchants fill each other's bids (only open sellers; the contract's buy refuses a closed stall)
  applyMerchantTrades(st, planMerchantTrades(st).filter((x) => st.merchants[x.seller].status === "open"));
  // residents: once a market day, the day's work is minted, sold into the best fillable bid, and one meal bought
  const ate: Record<string, number> = {};
  const book: Offer[] = [];
  for (const id of MERCHANT_IDS) {
    const m = st.merchants[id];
    for (const good of ["mango", "lemon"] as const) { const b = bidFor(st, id, good); if (b) book.push({ merchant: id, account_id: id, token_id: good, side: "bid", qty: String(b.qty), price: String(b.price) }); }
    for (const good of m.sells) if (m.status === "open") book.push({ merchant: id, account_id: id, token_id: good, side: "ask", qty: String(m.stock[good]), price: String(quote(st, id, good, false).price) });
  }
  const fillable = recovery ? executableOffers(book, st.merchants) : executableOffers(book, st.merchants).filter((o) => st.merchants[o.merchant as MerchantId].status === "open");
  for (const r of RESIDENTS) {
    if (!t.registered.has(r.id) || !once(t, `resident:${r.id}:${day}`)) continue;
    const p = t.residents[r.id];
    p[r.good] += r.perDay; // operator_mint: goods, never coin
    const plan = planResident(r, fillable, p.coin, p[r.good]);
    if (plan.sell) { const id = plan.sell.merchant as MerchantId; deliver(t, id, plan.sell.qty, plan.sell.price, day); p[r.good] -= plan.sell.qty; p.coin += plan.sell.qty * plan.sell.price; }
    if (plan.eat) { const id = plan.eat.merchant as MerchantId; st.merchants[id].stock[r.food] -= 1; st.merchants[id].cash += plan.eat.price; accrueSale(st, id, plan.eat.price); p.coin -= plan.eat.price; ate[`${id}:${r.food}`] = (ate[`${id}:${r.food}`] ?? 0) + 1; }
  }
  // street shoppers (street_sale: goods leave, coin enters)
  for (const id of MERCHANT_IDS) {
    const m = st.merchants[id];
    if (m.status !== "open") continue;
    for (const good of m.sells) {
      const want = shopperWant(st, id, good) * TICK_HOURS - (ate[`${id}:${good}`] ?? 0);
      const key = `${id}.${good}`;
      const sold = recovery ? touristUnits(want, t.carry[key] ?? 0, m.stock[good]) : { units: Math.max(0, Math.min(m.stock[good], Math.floor(want))), carry: 0 };
      t.carry[key] = sold.carry;
      if (sold.units <= 0) continue;
      const price = quote(st, id, good, false).price;
      t.sold[good] = (t.sold[good] ?? 0) + sold.units;
      m.stock[good] -= sold.units; m.cash += sold.units * price; mint(t, sold.units * price, "street shoppers"); accrueSale(st, id, sold.units * price);
    }
  }
  // the harbor's standing contract for Tomas, and Arin's kitchen (goods only; freight coin is burned)
  const tom = st.merchants.tomas;
  if (harborDue(tom, () => once(t, `harbor:${day}`))) {
    const qty = harborQty(tom, Number(st.flags["reopenNeed.tomas"] ?? 1), HARBOR_COST);
    // freight is burned; the mangoes land like a delivery (price 0), so they count toward a closed stall's reopening
    if (qty > 0) { tom.cash -= qty * HARBOR_COST; burn(t, qty * HARBOR_COST, "harbor freight"); deliver(t, "tomas", qty, 0, day); }
  }
  const arin = st.merchants.arin, batches = Math.min(arin.stock.mango, Math.max(0, Math.ceil((8 - arin.stock.lassi) / 4)));
  if (batches > 0) { arin.stock.mango -= batches; arin.stock.lassi += batches * 4; }
}

/** Runs `days` market days of `turnsPerDay` turns each (a turn runs once a minute while someone plays). */
export function runDays(t: Town, fromDay: number, days: number, turnsPerDay: number, rules: "old" | "new" = "new", each?: (day: number) => void): void {
  for (let d = fromDay; d < fromDay + days; d++) {
    each?.(d);
    for (let k = 0; k < turnsPerDay; k++) marketTurn(t, d, rules);
  }
}
