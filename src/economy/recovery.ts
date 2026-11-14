// Economic recovery rules, shared by the relayer's market turn (server/near/handlers.ts) and the market model
// (src/economy/turn.ts) so the simulations test exactly what runs on chain. Pure: no I/O.
//
// What failed (docs/ECONOMY_RECOVERY.md has the measurements):
//  1. Street shoppers: each turn sold floor(demand per turn); a fruit stall's demand per turn is below one unit, so
//     on chain the fruit stalls never sold to shoppers and earned nothing. Fix: carry the fraction between turns.
//  2. The Guild collected only from tills over 80 c; tills that pay 30-40 c rent every two days rarely get there, so
//     loans were never repaid and the fund emptied. Fix: repay a capped amount from any till above rent + a reserve.
//  3. Rescue loans had no limit per stall. Fix: no new loan once a stall owes DEBT_CAP.
//  4. A reopened stall faced rent at once with an empty till and closed again. Fix: one rent grace per reopening.
//  5. Residents only sold to open stalls, although the contract lets anyone sell into a closed stall's (reopen) bid.
//     Fix: closed stalls' funded bids are real offers (residents.ts executableOffers).
import type { EconomyState, Merchant, MerchantId } from "./state.ts";

export const GUILD_FUND = 200;
/** A till under this borrows up to it (one tutorial delivery: 3 mangoes at 6 c). */
export const GUILD_FLOAT = 18;
/** Over this, a till also pays dues while the Guild is below its size. */
export const GUILD_HEALTHY = 80;
export const GUILD_DUES = 10;
/** A till keeps its rent plus this before repaying anything: repayment never pushes a stall into closing. */
export const OPERATING_RESERVE = 10;
/** Most a stall repays in one market day: debt is paid from earnings over time, not swept. */
export const REPAY_CAP = 10;
/** No new loan once a stall owes this much: the Guild cannot pour its whole fund into one failing stall. */
export const DEBT_CAP = 120;
/** Market days after a reopening during which one rent charge is waived (once per reopening). */
export const GRACE_DAYS = 2;

export interface GuildMove { readonly merchant: MerchantId; readonly kind: "lend" | "collect"; readonly amount: number; readonly repaid: number; readonly dues: number }

/** Loans owed by closed stalls: still on the books (never deleted), but not counted as the Guild's working size, so
 *  dues can rebuild a fund that bad loans emptied. Before this fix a Guild whose loans all went bad could never
 *  collect dues again (fund + loans >= its size), and stayed at 0 forever. */
export const impairedDebt = (st: EconomyState, ids: readonly MerchantId[], debt: Readonly<Record<string, number>>): number =>
  ids.reduce((n, id) => n + (st.merchants[id].status === "open" ? 0 : debt[id] ?? 0), 0);

/** The `fill_to` the contract's guild_collect is given: the Guild's size plus its impaired loans (see impairedDebt). */
export const guildFillTo = (st: EconomyState, ids: readonly MerchantId[], debt: Readonly<Record<string, number>>): number => GUILD_FUND + impairedDebt(st, ids, debt);

/** The Guild's moves for one turn, given the fund and each stall's debt. Mirrors the contract's guild_lend /
 *  guild_collect limits (it never lends more than it holds; repayment comes before dues; dues stop at the fund size).
 *  `collectToday(id)` must be true at most once per stall and market day (the caller's once-guard). */
export function guildPlan(st: EconomyState, ids: readonly MerchantId[], fund: number, debt: Readonly<Record<string, number>>, rescueOf: (id: MerchantId) => number, collectToday: (id: MerchantId) => boolean): GuildMove[] {
  const out: GuildMove[] = [];
  const fillTo = guildFillTo(st, ids, debt);
  let held = fund, lent = ids.reduce((n, id) => n + (debt[id] ?? 0), 0);
  for (const id of ids) {
    const m = st.merchants[id], owes = debt[id] ?? 0;
    const float = Math.max(GUILD_FLOAT, rescueOf(id));
    if (m.cash < float && held > 0 && owes < DEBT_CAP) {
      const amount = Math.min(float - m.cash, held, DEBT_CAP - owes);
      if (amount > 0) { out.push({ merchant: id, kind: "lend", amount, repaid: 0, dues: 0 }); held -= amount; lent += amount; }
      continue;
    }
    const spare = m.cash - (m.rent + OPERATING_RESERVE);
    if (m.status !== "open" || spare <= 0) continue;
    const repaid = Math.min(owes, spare, REPAY_CAP);
    const dues = m.cash > GUILD_HEALTHY ? Math.max(0, Math.min(m.cash - GUILD_HEALTHY - repaid, GUILD_DUES, fillTo - (held + lent))) : 0;
    if (repaid + dues <= 0 || !collectToday(id)) continue;
    out.push({ merchant: id, kind: "collect", amount: repaid + dues, repaid, dues });
    held += repaid + dues; lent -= repaid;
  }
  return out;
}

/** Rent to charge a stall today: the full rent, or 0 once as a recovery grace when it reopened within GRACE_DAYS and
 *  cannot pay. `graceUnused` must be true only once per reopening (the caller's once-guard). Never waives otherwise. */
export function rentToCharge(m: Merchant, day: number, reopenedDay: number | null, graceUnused: () => boolean): { rent: number; grace: boolean } {
  const recovering = reopenedDay !== null && day - reopenedDay >= 0 && day - reopenedDay <= GRACE_DAYS && m.cash < m.rent;
  return recovering && graceUnused() ? { rent: 0, grace: true } : { rent: m.rent, grace: false };
}

/** Whether the harbor's standing contract delivers to Tomas this turn: on any turn he is nearly out or his stall is
 *  closed, else once a market day (`claimDaily`, the caller's once-guard) when he is below his normal stock.
 *  A closed Tomas still receives, and pays for, his contract: the contract counts those mangoes toward his reopening.
 *  Before, the contract stopped with his shutters, so with every fruit stall closed no mango entered the market and a
 *  new player could not buy one until Orchard hours (live 2026-11-14: Pema, Tomas and Mira closed, each 1 mango short). */
export const harborDue = (m: Merchant, claimDaily: () => boolean): boolean =>
  m.status !== "open" || m.stock.mango < 6 || (m.stock.mango < m.target.mango && claimDaily());

/** Mangoes the harbor lands: up to 140% of his normal stock (at least what reopens a closed stall), as many as his till
 *  pays freight for at `cost` a mango. */
export const harborQty = (m: Merchant, reopenNeed: number, cost: number): number =>
  Math.max(0, Math.min(Math.max(m.status === "open" ? 0 : reopenNeed, Math.round(m.target.mango * 1.4) - m.stock.mango), Math.floor(m.cash / cost)));

/** Whole units street shoppers buy this turn from a fractional demand, carrying the remainder (exact over time).
 *  An empty shelf keeps at most one pending buyer, so demand never piles up while there is nothing to sell. */
export function touristUnits(want: number, carry: number, stock: number): { units: number; carry: number } {
  const total = Math.max(0, carry) + Math.max(0, want);
  const units = Math.min(Math.floor(total), Math.max(0, Math.floor(stock)));
  const left = total - units;
  return { units, carry: units < Math.floor(total) ? Math.min(left, 1) : left };
}

export const debtOf = (st: EconomyState, id: string): number => Number(st.flags[`debt.${id}`] ?? 0);
