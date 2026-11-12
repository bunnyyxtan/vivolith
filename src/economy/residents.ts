// Residents: townspeople with their own NEAR accounts who earn by piece work and spend on food (WP6).
// Pure planning, shared by the relayer's market turn (server/near/handlers.ts) and the self-check.
// Coin never appears from nowhere here: residents are paid by a merchant's standing bid and pay a merchant's ask.

export interface Resident {
  /** Account prefix (`<id>.<relayer>`) and the townsperson who acts it out in the street. */
  readonly id: "picker" | "porter";
  readonly name: string;
  readonly job: string;
  /** What a day's work yields (minted as goods with this reason) and what they eat. */
  readonly good: "mango" | "lemon";
  readonly perDay: number;
  readonly reason: string;
  readonly food: "lassi";
}

export const RESIDENTS: readonly Resident[] = [
  { id: "picker", name: "Lin", job: "orchard picker", good: "mango", perDay: 6, reason: "orchard picking", food: "lassi" },
  { id: "porter", name: "Dev", job: "harbor porter", good: "lemon", perDay: 4, reason: "harbor unloading", food: "lassi" },
];

/** A posted order as the contract's get_offers returns it. */
export interface Offer { readonly merchant: string; readonly account_id: string; readonly token_id: string; readonly side: string; readonly qty: string; readonly price: string }

export interface Plan {
  /** Sell the day's goods into the best standing bid. */
  readonly sell: { readonly buyer: string; readonly merchant: string; readonly qty: number; readonly price: number } | null;
  /** Buy one meal at the cheapest ask, if the purse covers it. */
  readonly eat: { readonly seller: string; readonly merchant: string; readonly price: number } | null;
  /** Could not afford food: the real price, for the street to say. */
  readonly hungry: number | null;
}

/** What a resident does today, from the posted orders and the coin they will hold after selling. */
export function planResident(r: Resident, offers: readonly Offer[], coin: number, holding: number): Plan {
  const bid = offers
    .filter((o) => o.side === "bid" && o.token_id === r.good && Number(o.qty) > 0)
    .sort((a, b) => Number(b.price) - Number(a.price))[0];
  const qty = bid ? Math.min(holding, Number(bid.qty)) : 0;
  const sell = bid && qty > 0 ? { buyer: bid.account_id, merchant: bid.merchant, qty, price: Number(bid.price) } : null;
  const purse = coin + (sell ? sell.qty * sell.price : 0);
  const ask = offers
    .filter((o) => o.side === "ask" && o.token_id === r.food && Number(o.qty) > 0)
    .sort((a, b) => Number(a.price) - Number(b.price))[0];
  if (!ask) return { sell, eat: null, hungry: null }; // nothing to buy: not hunger, an empty kitchen
  const price = Number(ask.price);
  return purse >= price ? { sell, eat: { seller: ask.account_id, merchant: ask.merchant, price }, hungry: null } : { sell, eat: null, hungry: price };
}

/** Only orders a resident could actually fill right now: the stall is open, a bid's till covers at least one unit, an ask has
 *  stock. Quantities are cut to what the till or the shelf holds. Closed stalls and stale orders never reach the planner or the model. */
export function executableOffers(offers: readonly Offer[], stalls: Readonly<Record<string, { status: string; cash: number; stock: Readonly<Record<string, number>> }>>): Offer[] {
  const out: Offer[] = [];
  for (const o of offers) {
    const m = stalls[o.merchant], price = Number(o.price), qty = Number(o.qty);
    if (!m || m.status !== "open" || !(price > 0) || !(qty > 0)) continue;
    const fill = o.side === "bid" ? Math.min(qty, Math.floor(m.cash / price)) : o.side === "ask" ? Math.min(qty, Math.floor(m.stock[o.token_id] ?? 0)) : 0;
    if (fill >= 1) out.push({ ...o, qty: String(fill) });
  }
  return out;
}

