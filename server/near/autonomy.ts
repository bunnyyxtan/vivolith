// The agents' side of a market turn, shared by every driver (browser-driven turns and the scheduler route):
// snapshot each agent from chain, keep its economic memory (memory.ts) and advance pending signature checks (verify.ts).
// Nothing here moves coin or signs a transaction; the market turn in handlers.ts does that.
import { decisionFor, verifyStored, type Decision, type DecisionStore } from "./agent.ts";
import { readMemory, updateRows, memoryKey, MEMORY_TTL, type ChainReceipt, type MemoryRow, type RememberedDecision, type Snapshot } from "./memory.ts";
import type { Evidence, VerifyResult } from "./verify.ts";
import { settleVerification } from "./ledger.ts";

/** The six economic agents: four merchants and two residents. */
export const AGENTS = ["pema", "tomas", "mira", "arin", "picker", "porter"] as const;
export type AgentId = typeof AGENTS[number];

export const remembered = (d: Decision | null): RememberedDecision | null => d
  ? { action: d.action, source: d.source, price: d.price, basePrice: d.basePrice, txHash: d.txHash, verification: d.receipt.status }
  : null;

/** Every agent's memory, or [] for one the store cannot read (the model then simply sees no history). */
export async function memoriesFor(store: DecisionStore): Promise<Record<string, MemoryRow[]>> {
  const out: Record<string, MemoryRow[]> = {};
  await Promise.all(AGENTS.map(async (id) => { out[id] = await readMemory(store, id).catch(() => []); }));
  return out;
}

/** Records this turn in each agent's memory: today's opening snapshot (kept from the first turn of the day), the
 *  day's decision as stored, and the outcome of any earlier day that is still open. Writes only when a row changed.
 *  Receipts are read only when an earlier day needs closing. A failure for one agent is logged and skipped. */
export async function recordMemories(store: DecisionStore, day: number, snaps: ReadonlyMap<string, Snapshot>, receiptsOf: (id: string) => Promise<ChainReceipt[]>, log: string[]): Promise<void> {
  for (const id of AGENTS) {
    const snap = snaps.get(id);
    if (!snap) continue;
    try {
      const rows = await readMemory(store, id);
      const closing = rows.some((r) => r.day < day && r.outcome === null);
      const receipts = closing ? await receiptsOf(id) : [];
      const next = updateRows(rows, snap, receipts, remembered(await decisionFor(store, id, day)));
      if (JSON.stringify(next) !== JSON.stringify(rows)) await store.set(memoryKey(id), JSON.stringify(next), MEMORY_TTL);
      if (closing) log.push(`${id} memory: closed ${rows.filter((r) => r.day < day && r.outcome === null).length} day(s) from chain`);
    } catch (e) {
      log.push(`${id} memory not updated (${e instanceof Error ? e.message.slice(0, 60) : "store error"})`);
    }
  }
}

/** One signature-check attempt per pending decision of today and yesterday, each taking one call from the budget. */
export async function verifyPass(store: DecisionStore, day: number, check: (decisionId: string, ev: Evidence) => Promise<VerifyResult>, budget: () => Promise<boolean>, log: string[]): Promise<void> {
  for (const id of AGENTS) {
    for (const d of [day, day - 1]) {
      const cur = await decisionFor(store, id, d).catch(() => null);
      if (!cur || cur.receipt.status !== "pending") continue;
      if (!(await budget())) { log.push("signature checks paused: today's verification limit is reached"); return; }
      const next = await verifyStored(store, id, d, check).catch(() => null);
      if (next) log.push(`${id} decision for day ${d}: ${next.receipt.status} (${next.receipt.note.slice(0, 80)})`);
      // the Chronicle's copy of the status follows once the check is over (a lost write leaves it "pending", never wrong)
      if (next?.receipt.id && next.receipt.status !== "pending") await settleVerification(store, next.receipt.id, next.receipt.status).catch(() => false);
    }
  }
}
