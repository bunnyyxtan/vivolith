// Economic memory: what each agent decided and what actually happened afterwards, one row per market day.
// Every number is read from NEAR (balances, stall status, the contract's own receipts) or from the stored decision;
// nothing is written from model output or player claims, so the memory can only repeat what the chain recorded.
// Stored as one capped JSON list per agent in the same Redis store as the decision guard (bounded: MAX_DAYS rows,
// expiring after MEMORY_TTL). Only the market turn writes it, under the global tick lock, so read-modify-write is safe.
/** The shared key-value store (Upstash Redis REST in production, memory in checks): decisions, memory, budgets. */
export interface DecisionStore {
  get(key: string): Promise<string | null>;
  /** SET key value NX EX ttl: true only for the one caller that created it. */
  setNx(key: string, value: string, ttlSec: number): Promise<boolean>;
  set(key: string, value: string, ttlSec: number): Promise<void>;
  del(key: string): Promise<void>;
  /** INCRBY key by (default 1, may be negative), setting its expiry; returns the new count (budgets, ops.ts). */
  incr(key: string, ttlSec: number, by?: number): Promise<number>;
}

/** Rows kept per agent: enough for a week of market days (10 real minutes each) and a compact model prompt. */
export const MAX_DAYS = 12;
/** A memory row outlives a quiet night (no turns) but never lingers forever. */
export const MEMORY_TTL = 24 * 3600;
/** The contract keeps this many receipts per account (contracts/market MAX_RECEIPTS). */
export const RECEIPT_WINDOW = 20;

export const memoryKey = (id: string): string => `vivolith:mem:${id}`;

/** The agent's state at the first market turn of a day, read from chain. */
export interface Snapshot {
  readonly day: number;
  /** Final block height when the snapshot was read: receipts after it belong to this day. */
  readonly block: number;
  readonly coin: number;
  readonly goods: Readonly<Record<string, number>>;
  readonly open: boolean;
}

/** One trade line from the contract's receipt list (`get_receipts`). */
export interface ChainReceipt { readonly kind: string; readonly token_id: string; readonly qty: string | number; readonly price: string | number; readonly counterparty: string; readonly block_height: number }

/** A decision as remembered: only fields copied from the stored Decision (agent.ts), never model prose. */
export interface RememberedDecision {
  readonly action: string;
  readonly source: "ai" | "fallback";
  readonly price: number;
  readonly basePrice: number;
  readonly txHash: string | null;
  readonly verification: string;
}

export interface Trades { readonly count: number; readonly qty: number; readonly coins: number }

export interface Outcome {
  readonly coinChange: number;
  readonly goodsChange: Readonly<Record<string, number>>;
  readonly openAtEnd: boolean;
  /** Trades recorded by the contract during the day; null when the receipt window did not reach back that far. */
  readonly bought: Trades | null;
  readonly sold: Trades | null;
  /** The part of those trades made with players (guest or signed-in game accounts). */
  readonly withPlayers: Trades | null;
}

export interface MemoryRow {
  readonly day: number;
  readonly start: Snapshot;
  readonly decision: RememberedDecision | null;
  /** Filled in by the first turn of a later day; null while the day is still running. */
  readonly outcome: Outcome | null;
}

const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

/** Rejects anything that is not a well-formed row (a corrupt or hand-edited value is dropped, never trusted). */
export function validRow(x: unknown): x is MemoryRow {
  const r = x as MemoryRow | null;
  if (!r || typeof r !== "object" || !isNum(r.day)) return false;
  const s = r.start;
  if (!s || !isNum(s.day) || s.day !== r.day || !isNum(s.block) || !isNum(s.coin) || typeof s.open !== "boolean" || !s.goods || typeof s.goods !== "object") return false;
  if (r.decision !== null && (typeof r.decision !== "object" || typeof r.decision.action !== "string" || !isNum(r.decision.price))) return false;
  if (r.outcome !== null && (typeof r.outcome !== "object" || !isNum(r.outcome.coinChange))) return false;
  return true;
}

export async function readMemory(store: DecisionStore, id: string): Promise<MemoryRow[]> {
  const raw = await store.get(memoryKey(id));
  if (!raw) return [];
  try {
    const list = JSON.parse(raw) as unknown;
    return Array.isArray(list) ? list.filter(validRow).sort((a, b) => a.day - b.day).slice(-MAX_DAYS) : [];
  } catch { return []; }
}

/** Game accounts belonging to players: guests (`g…`) and signed-in players (`s…`), 16 hex characters. */
export const isPlayerAccount = (acct: string): boolean => /^[gs][0-9a-f]{16}\./.test(acct);

const sum = (rs: readonly ChainReceipt[]): Trades => ({ count: rs.length, qty: rs.reduce((n, r) => n + Number(r.qty), 0), coins: rs.reduce((n, r) => n + Number(r.qty) * Number(r.price), 0) });

/** Trades between two snapshots, from receipts; null when the 20-receipt window may have dropped some of them. */
export function tradesBetween(receipts: readonly ChainReceipt[], fromBlock: number, toBlock: number): { bought: Trades; sold: Trades; withPlayers: Trades } | null {
  const sorted = [...receipts].sort((a, b) => a.block_height - b.block_height);
  // a full window whose oldest receipt is inside the interval may have pushed older ones out: unknown, not zero
  if (sorted.length >= RECEIPT_WINDOW && sorted[0].block_height >= fromBlock) return null;
  const inDay = sorted.filter((r) => r.block_height >= fromBlock && r.block_height < toBlock && (r.kind === "bought" || r.kind === "sold"));
  return { bought: sum(inDay.filter((r) => r.kind === "bought")), sold: sum(inDay.filter((r) => r.kind === "sold")), withPlayers: sum(inDay.filter((r) => isPlayerAccount(r.counterparty))) };
}

export function outcomeOf(start: Snapshot, end: Snapshot, receipts: readonly ChainReceipt[]): Outcome {
  const goods = new Set([...Object.keys(start.goods), ...Object.keys(end.goods)]);
  const t = tradesBetween(receipts, start.block, end.block);
  return {
    coinChange: end.coin - start.coin,
    goodsChange: Object.fromEntries([...goods].map((g) => [g, (end.goods[g] ?? 0) - (start.goods[g] ?? 0)])),
    openAtEnd: end.open,
    bought: t?.bought ?? null, sold: t?.sold ?? null, withPlayers: t?.withPlayers ?? null,
  };
}

/** Pure update: closes every open earlier day against `snap`, adds (or refreshes) today's row, trims to MAX_DAYS.
 *  Idempotent: the same snapshot and decision give the same rows; a second turn on the same day never adds a row and
 *  never moves the day's starting snapshot. */
export function updateRows(rows: readonly MemoryRow[], snap: Snapshot, receipts: readonly ChainReceipt[], decision: RememberedDecision | null): MemoryRow[] {
  const out: MemoryRow[] = [];
  for (const r of rows) {
    if (r.day < snap.day && r.outcome === null && snap.block >= r.start.block) out.push({ ...r, outcome: outcomeOf(r.start, snap, receipts) });
    else if (r.day <= snap.day) out.push(r); // a row from the future (clock skew) is dropped
  }
  const today = out.findIndex((r) => r.day === snap.day);
  if (today < 0) out.push({ day: snap.day, start: snap, decision, outcome: null });
  else if (decision) out[today] = { ...out[today], decision }; // a later turn may carry the transaction or verification
  return out.sort((a, b) => a.day - b.day).slice(-MAX_DAYS);
}

/** Records this turn for one agent. Store errors propagate: the caller logs them and the market turn carries on. */
export async function remember(store: DecisionStore, id: string, snap: Snapshot, receipts: readonly ChainReceipt[], decision: RememberedDecision | null): Promise<MemoryRow[]> {
  const next = updateRows(await readMemory(store, id), snap, receipts, decision);
  await store.set(memoryKey(id), JSON.stringify(next), MEMORY_TTL);
  return next;
}

/** Compact rows for the decision model (Jev reads `state` as data): the last closed days, newest first. */
export function memoryForModel(rows: readonly MemoryRow[], good: string, limit = 5): Record<string, unknown>[] {
  return rows.filter((r) => r.outcome !== null).slice(-limit).reverse().map((r) => ({
    market_day: r.day,
    decision: r.decision ? `${r.decision.action} to ${r.decision.price} c (${r.decision.source === "ai" ? "your own call" : "rule price"})` : "no decision",
    till_change_coins: r.outcome!.coinChange,
    [`${good}_change`]: r.outcome!.goodsChange[good] ?? 0,
    units_bought: r.outcome!.bought?.qty ?? "unknown",
    units_sold: r.outcome!.sold?.qty ?? "unknown",
    trades_with_players: r.outcome!.withPlayers?.count ?? "unknown",
    stall_open_at_end: r.outcome!.openAtEnd,
  }));
}

/** Plain sentences about the past for conversation (every number is a memory number, so the grounding guard accepts it). */
export function memoryFacts(rows: readonly MemoryRow[], good: string, limit = 3): string[] {
  const out: string[] = [];
  const today = rows.reduce((d, r) => Math.max(d, r.day), 0);
  const when = (day: number): string => { const n = today - day; return n <= 0 ? "Today" : n === 1 ? "On the last market day" : n === 2 ? "Two market days ago" : `${n} market days ago`; };
  for (const r of rows.filter((x) => x.outcome !== null).slice(-limit).reverse()) {
    const o = r.outcome!;
    const d = r.decision ? `you ${r.decision.action === "hold" ? `kept your price at ${r.decision.price} coins` : `${r.decision.action === "raise" ? "raised" : "lowered"} your price from ${r.decision.basePrice} to ${r.decision.price} coins`}${r.decision.source === "ai" ? " on your own judgement" : " by the usual rule"}` : "you made no price change";
    const traded = o.bought && o.sold ? ` You bought ${o.bought.qty} and sold ${o.sold.qty} in trades${o.withPlayers && o.withPlayers.count ? `, ${o.withPlayers.count} of them with players` : ""}.` : "";
    const till = o.coinChange === 0 ? "your till did not change" : `your till went ${o.coinChange > 0 ? "up" : "down"} by ${Math.abs(o.coinChange)} coins`;
    const g = o.goodsChange[good] ?? 0;
    out.push(`${when(r.day)} ${d}; by the next day ${till} and your ${good} stock went ${g >= 0 ? "up" : "down"} by ${Math.abs(g)}.${traded}${o.openAtEnd ? "" : " Your stall ended that day closed."}`);
  }
  return out;
}
