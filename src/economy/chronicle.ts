// Town Chronicle: what happened in the market, who took part, what changed, whether an AI decision was involved and what
// evidence exists. Shared by the relayer (which records confirmed events) and the game (which shows them). Pure: no I/O.
//
// Causality rule: an event never says one thing happened *because* of another. A decision event lists the facts its
// decider saw and, separately, the recorded events that changed that decider's goods or till since its previous
// decision ("since"). Readers can see both; the Chronicle does not claim the link was the reason.

/** confirmed: a transaction NEAR executed; recorded: the market recorded a decision that needed no transaction;
 *  failed: NEAR refused it (nothing moved); pending: sent, no final answer yet; offline: the local simulation. */
export type ChronicleStatus = "confirmed" | "recorded" | "failed" | "pending" | "offline";
export type ChronicleKind = "trade" | "decision" | "resident" | "rent" | "closed" | "reopened" | "loan";

/** A balance change one event caused, read from the transaction it records (or the offline simulation). */
export interface Change { readonly who: string; readonly good: string; readonly delta: number }

export interface ChronicleDecision {
  /** "ai": the NEAR AI model chose; "rule": the deterministic rule (never labelled AI). */
  readonly source: "ai" | "rule";
  readonly action: string;
  readonly from: number | null;
  readonly to: number | null;
  readonly model: string | null;
  readonly decisionId: string | null;
  /** Signature check of the inference (server/near/verify.ts): none, pending, signed, unverified, failed. */
  readonly verification: string;
  /** Facts the decider saw (from chain state), as plain sentences. */
  readonly inputs: readonly string[];
}

export interface ChronicleEvent {
  readonly id: string;
  readonly at: number;
  readonly day: number;
  readonly kind: ChronicleKind;
  /** Agent ids (pema, tomas, mira, arin, picker, porter); the player appears in `player`. */
  readonly actors: readonly string[];
  /** One plain sentence of fact. */
  readonly text: string;
  readonly changes: readonly Change[];
  readonly status: ChronicleStatus;
  readonly txHash: string | null;
  readonly decision: ChronicleDecision | null;
  /** Earlier events that changed this decider's goods or till since its previous decision (never "the cause"). */
  readonly since: readonly string[];
  /** Account of the player, when a player took part (public chain data). */
  readonly player: string | null;
}

export const CHRONICLE_MAX = 60;

/** A count and its noun as English: "1 mango", "0 mangoes", "2 mangoes", "3 lemons", "1 crate", "5 shares". */
export const countOf = (n: number, noun: string): string => `${n} ${n === 1 ? noun : noun === "mango" ? "mangoes" : `${noun}s`}`;

/** Town news as it reads, for entries recorded before their wording was fixed ("2 mangos", "3 mango", "1 mangoes are
 *  delivered"). Display only: the stored event, its figures and its transaction stay as recorded. Only a number directly
 *  followed by one of the market's goods is touched, and never when the good names something else ("5 mango crates"). */
// a regex literal, not a string: scripts/audio/lines.ts must not read its fragments as spoken sentences
const NEWS_COUNT = /\b(\d+) (pre-paid )?(mango|lemon|lassi|crate|share)(?:es|s)?\b(?! (?:bids?|prices?|crates?|stalls?|stock|shelf|shelves|asks?|offers?)\b)( (?:are|is|were|was)\b)?/g;
export const readableNews = (text: string): string => text.replace(NEWS_COUNT, (_all, num: string, pre: string | undefined, noun: string, verb: string | undefined) => {
  const n = Number(num), one = n === 1;
  const v = verb ? ` ${one ? (/were|was/.test(verb) ? "was" : "is") : (/were|was/.test(verb) ? "were" : "are")}` : "";
  return countOf(n, `${pre ?? ""}${noun}`) + v;
});

let seq = 0;
export const eventId = (at: number, kind: string): string => `${at.toString(36)}-${kind}-${(seq++ % 1296).toString(36)}`;

/** Ids of events that changed `who`'s holdings after `afterAt` and before `beforeAt`, oldest first. */
export function changedSince(events: readonly ChronicleEvent[], who: string, afterAt: number, beforeAt: number): string[] {
  return events
    .filter((e) => e.at > afterAt && e.at < beforeAt && e.status !== "failed" && e.changes.some((c) => c.who === who && c.delta !== 0))
    .sort((a, b) => a.at - b.at)
    .map((e) => e.id);
}

/** Appends `e` (newest last), dropping the oldest past CHRONICLE_MAX and any repeat of the same id, or of the same
 *  transaction recorded twice for the same kind and actors (a retried write never doubles an event). */
export function appendEvent(list: readonly ChronicleEvent[], e: ChronicleEvent): ChronicleEvent[] {
  if (list.some((x) => x.id === e.id || (e.txHash !== null && x.txHash === e.txHash && x.kind === e.kind && x.actors.join() === e.actors.join()))) return [...list];
  return [...list, e].sort((a, b) => a.at - b.at).slice(-CHRONICLE_MAX);
}

/** Time of the most recent decision event of `who` before `at` (0 if none): it bounds the "since" window. */
export function lastDecisionAt(events: readonly ChronicleEvent[], who: string, at: number): number {
  return events.filter((e) => e.kind === "decision" && e.actors[0] === who && e.at < at).reduce((t, e) => Math.max(t, e.at), 0);
}

export interface DecisionFacts { readonly source: "ai" | "rule"; readonly action: string; readonly from: number; readonly to: number; readonly side: string; readonly good: string; readonly model: string | null; readonly decisionId: string | null; readonly verification: string; readonly inputs: readonly string[] }

/** A decision as a Chronicle event: what was decided, by whom (model or rule), on which facts, and which recorded events
 *  had changed the decider's goods or till since its previous decision. No claim that those events were the reason. */
export function decisionEvent(id: string, name: string, history: readonly ChronicleEvent[], d: DecisionFacts, tx: { hash: string; ok: boolean } | null, day: number, at = Date.now(), offline = false): ChronicleEvent {
  const what = d.side === "ask" ? `${d.good} price` : `${d.good} bid`;
  return {
    id: `decision-${id}-${day}-${d.source}-${d.to}`, at, day, kind: "decision", actors: [id], player: null,
    text: d.from === d.to ? `${name} kept the ${what} at ${d.to} c.` : `${name} ${d.to > d.from ? "raised" : "lowered"} the ${what} from ${d.from} to ${d.to} c.`,
    changes: [], status: offline ? "offline" : tx ? (tx.ok ? "confirmed" : "failed") : "recorded", txHash: tx?.hash || null,
    decision: { source: d.source, action: d.action, from: d.from, to: d.to, model: d.model, decisionId: d.decisionId, verification: d.verification, inputs: d.inputs },
    since: changedSince(history, id, lastDecisionAt(history, id, at), at),
  };
}

/** How an event is labelled for players: what kind of action, and how sure we are it happened. */
export function provenance(e: ChronicleEvent): string {
  const how = e.decision ? (e.decision.source === "ai" ? `NEAR AI decision${e.decision.model ? ` (${e.decision.model})` : ""}` : "Rule decision") : e.player ? "Player action" : "Town rule";
  const sure = e.status === "confirmed" ? "confirmed on NEAR" : e.status === "recorded" ? "recorded, no transaction needed" : e.status === "pending" ? "waiting for NEAR" : e.status === "failed" ? "refused, nothing moved" : "offline simulation, not on NEAR";
  return `${how} · ${sure}`;
}

/** Short line for street gossip: only confirmed or offline facts, never a causal claim. */
export function gossipLine(e: ChronicleEvent, name: (id: string) => string): string | null {
  if (e.status === "failed" || e.status === "pending") return null;
  if (e.kind === "decision" && e.decision && e.decision.from !== null && e.decision.to !== null && e.decision.from !== e.decision.to)
    return `${name(e.actors[0])} ${e.decision.to > e.decision.from ? "raised" : "lowered"} a price to ${e.decision.to} c.`;
  if (e.kind === "reopened") return `${name(e.actors[0])} is open again.`;
  if (e.kind === "closed") return `${name(e.actors[0])} pulled the shutters down.`;
  if (e.kind === "trade" || e.kind === "resident") return readableNews(e.text);
  return null;
}
