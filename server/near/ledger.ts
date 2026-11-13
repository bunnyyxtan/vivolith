// The town's recorded history, kept in the same Redis store as the agents' decisions:
//  - the Chronicle (src/economy/chronicle.ts): confirmed and failed market events, capped, 7 days;
//  - bonds: durable player <-> character economic history (deliveries, purchases, refused offers), capped, 30 days.
//    The 24-hour agent memory (memory.ts) is operational; bonds are what a character can still recall a week later.
//  - the deal reference: what the stall's own price was when the relayer signed a deal, so a confirmed sale can be
//    described truthfully ("accepted 2 c less than her bid") without trusting the client.
// Everything written here comes from a confirmed transaction or from the relayer's own decision; nothing from a model.
import { appendEvent, type ChronicleEvent } from "../../src/economy/chronicle.ts";
import type { DecisionStore } from "./agent.ts";

export const CHRONICLE_KEY = "vivolith:chronicle";
const CHRONICLE_TTL = 7 * 24 * 3600;
export const BOND_MAX = 20;
const BOND_TTL = 30 * 24 * 3600;
const DEAL_REF_TTL = 300; // a signed deal expires after 2 minutes (handlers.ts DEAL_TTL_MS)

export const bondKey = (npc: string, player: string): string => `vivolith:bond:${npc}:${player}`;
const dealRefKey = (player: string, nonce: string): string => `vivolith:dealref:${player}:${nonce}`;

// ------------------------------------------------------------------ chronicle ----

const validEvent = (x: unknown): x is ChronicleEvent => {
  const e = x as ChronicleEvent | null;
  return !!e && typeof e === "object" && typeof e.id === "string" && typeof e.at === "number" && typeof e.text === "string" && Array.isArray(e.actors) && Array.isArray(e.changes) && Array.isArray(e.since);
};

export async function readChronicle(store: DecisionStore): Promise<ChronicleEvent[]> {
  const raw = await store.get(CHRONICLE_KEY);
  if (!raw) return [];
  try { const l = JSON.parse(raw) as unknown; return Array.isArray(l) ? l.filter(validEvent) : []; } catch { return []; }
}

/** Appends events under a short lock (the market turn and players' relays both write). If the lock cannot be taken the
 *  events are not written and false is returned: the Chronicle may miss an entry, it never holds a wrong one.
 *  ponytail: one list and one lock; per-day lists if writes ever contend. */
export async function chronicle(store: DecisionStore, events: readonly ChronicleEvent[], sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))): Promise<boolean> {
  if (!events.length) return true;
  const lock = `${CHRONICLE_KEY}:lock`;
  for (let k = 0; k < 5; k++) {
    if (await store.setNx(lock, "1", 10)) {
      try {
        let list = await readChronicle(store);
        for (const e of events) list = appendEvent(list, e);
        await store.set(CHRONICLE_KEY, JSON.stringify(list), CHRONICLE_TTL);
        return true;
      } finally { await store.del(lock).catch(() => undefined); }
    }
    await sleep(120);
  }
  return false;
}

// ------------------------------------------------------------------ bonds ----

/** One economic fact between a player and a character. `evidence` says where it comes from: "chain" = a confirmed
 *  transaction (txHash set); "relayer" = the relayer refused to sign an offer (no trade happened). */
export interface Bond {
  readonly at: number;
  readonly day: number;
  readonly kind: "delivered" | "bought" | "refused";
  readonly good: string;
  readonly qty: number;
  readonly unit: number;
  /** The stall's own price for this side when the relayer signed (bid for a delivery, ask for a purchase); null unknown. */
  readonly reference: number | null;
  readonly evidence: "chain" | "relayer";
  readonly txHash: string | null;
  readonly note: string | null;
}

const validBond = (x: unknown): x is Bond => {
  const b = x as Bond | null;
  return !!b && typeof b === "object" && typeof b.at === "number" && ["delivered", "bought", "refused"].includes(b.kind) && typeof b.qty === "number" && typeof b.unit === "number";
};

export async function readBonds(store: DecisionStore, npc: string, player: string): Promise<Bond[]> {
  const raw = await store.get(bondKey(npc, player));
  if (!raw) return [];
  try { const l = JSON.parse(raw) as unknown; return Array.isArray(l) ? l.filter(validBond).slice(-BOND_MAX) : []; } catch { return []; }
}

/** Adds a bond, once per transaction (a retried relay never records a delivery twice). */
export async function addBond(store: DecisionStore, npc: string, player: string, b: Bond): Promise<void> {
  const list = await readBonds(store, npc, player);
  if (b.txHash && list.some((x) => x.txHash === b.txHash)) return;
  await store.set(bondKey(npc, player), JSON.stringify([...list, b].slice(-BOND_MAX)), BOND_TTL);
}

/** Plain sentences for a character's dialogue facts, keeping facts and interpretations apart. Never a promise. */
export function bondFacts(bonds: readonly Bond[], noun: (good: string, n: number) => string): string[] {
  const out: string[] = [];
  const confirmed = bonds.filter((b) => b.evidence === "chain");
  const delivered = confirmed.filter((b) => b.kind === "delivered");
  if (delivered.length) {
    const qty = delivered.reduce((n, b) => n + b.qty, 0);
    out.push(`Fact (recorded on NEAR): this customer has delivered ${noun("mango", qty)} to you in ${delivered.length} sale${delivered.length > 1 ? "s" : ""}.`);
    const under = delivered.filter((b) => b.reference !== null && b.unit < b.reference);
    if (under.length) {
      const kept = under.reduce((n, b) => n + (b.reference! - b.unit) * b.qty, 0);
      out.push(`Interpretation: in ${under.length} of those sales they accepted less than your own bid, which left ${kept} coins more in your till than your bid would have.`);
    }
  }
  const bought = confirmed.filter((b) => b.kind === "bought");
  if (bought.length) out.push(`Fact (recorded on NEAR): this customer has bought ${noun("mango", bought.reduce((n, b) => n + b.qty, 0))} from you.`);
  const refused = bonds.filter((b) => b.kind === "refused").slice(-2);
  for (const r of refused) out.push(`Fact (no trade happened): an offer of ${r.unit} coins each for ${noun(r.good, r.qty)} was refused${r.note ? `: ${r.note}` : ""}.`);
  return out;
}

// ------------------------------------------------------------------ deal reference ----

export interface DealRef { readonly merchant: string; readonly side: "buy" | "sell"; readonly token: string; readonly qty: number; readonly unit: number; readonly reference: number | null; readonly closed: boolean }

export const putDealRef = (store: DecisionStore, player: string, nonce: string, ref: DealRef): Promise<void> => store.set(dealRefKey(player, nonce), JSON.stringify(ref), DEAL_REF_TTL);

export async function takeDealRef(store: DecisionStore, player: string, nonce: string): Promise<DealRef | null> {
  const raw = await store.get(dealRefKey(player, nonce)).catch(() => null);
  if (!raw) return null;
  try { return JSON.parse(raw) as DealRef; } catch { return null; }
}
