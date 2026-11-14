// The two halves of a player's value move that decide correctness, kept free of the browser and of near-api-js so
// moves.check.ts can drive every outcome: relaying one signed meta-transaction until NEAR gives a final answer, and the
// game's bookkeeping of moves still waiting for one.
import type { TxOutcome } from "./chain.ts";

export type Post = (route: string, body: unknown) => Promise<Record<string, unknown>>;

/** Sends one signed delegate (base64) through the relayer. Every attempt resends the same bytes, which NEAR accepts at
 *  most once (the delegate nonce), so a retry can never pay twice. Outcomes:
 *  onchain (tx hash) · failed (a final refusal, nothing moved) · unknown (it may have landed: re-read the chain). */
export async function relaySigned(delegate: string, post: Post, sleep: (ms: number) => Promise<void>, tries = 4, retryMs = 1500): Promise<TxOutcome> {
  let sent = false; // an earlier attempt may have reached NEAR
  for (let attempt = 0; attempt < tries; attempt++) {
    if (attempt > 0) await sleep(retryMs * attempt);
    let r: Record<string, unknown>;
    try { r = await post("relay", { signedDelegate: delegate }); } catch { sent = true; continue; } // network: resend
    if (r.status === "onchain" && typeof r.txHash === "string") return { status: "onchain", txHash: r.txHash };
    if (r.status === "duplicate") return sent ? { status: "unknown", message: "sent earlier; checking NEAR" } : { status: "failed", message: "already submitted" };
    if (r.status === "unknown" || (Number(r.httpStatus) >= 500 && r.status !== "error")) { sent = true; continue; }
    return { status: "failed", txHash: typeof r.txHash === "string" && r.txHash ? r.txHash : undefined, message: String(r.message ?? "not recorded") };
  }
  return sent ? { status: "unknown", message: "no answer from NEAR; checking your balance" } : { status: "failed", message: "relay unreachable" };
}

/** Value moves sent and not yet answered. `epoch` changes when a move is sent and when it is answered, so a chain read
 *  that started before either is stale and must be dropped. `settling(who)`: a move with that stall is unanswered.
 *  `send` always answers exactly once: a rejected promise counts as "unknown", never as a move that waits forever. */
export interface Moves {
  send(who: string, tx: Promise<TxOutcome>): Promise<TxOutcome>;
  settling(who: string): boolean;
  readonly inFlight: number;
  readonly epoch: number;
}

export function moves(): Moves {
  let inFlight = 0, epoch = 0;
  const per = new Map<string, number>();
  const add = (who: string, d: number): void => { per.set(who, Math.max(0, (per.get(who) ?? 0) + d)); };
  return {
    get inFlight() { return inFlight; },
    get epoch() { return epoch; },
    settling: (who) => (per.get(who) ?? 0) > 0,
    send(who, tx) {
      inFlight++; epoch++; add(who, 1);
      return tx.catch((): TxOutcome => ({ status: "unknown", message: "no answer" })).then((o) => { inFlight--; epoch++; add(who, -1); return o; });
    },
  };
}
