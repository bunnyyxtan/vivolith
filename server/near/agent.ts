// Merchant decision service: a bounded economic choice made by NEAR AI's decision model (typesafe/jev-1.13 on
// cloud-api.near.ai/v1/systemone), validated here, and applied through the existing merchant tick.
//
// Schema (verified against docs.near.ai/cloud/inference-sdk and OpenRouter's TypeSafe-compatible OpenAPI, 2026-11-12):
//   request  { model, state: any, questions: { <name>: { type: "choice", instructions?, criteria: { <option>: <text> } } } }
//   response { id, model, answers: { <name>: { type: "choice", choice, confidence?, probabilities? } | { type: "refusal" } } }
//   The receipt id is the X-Generation-Id response header; NEAR AI's SDK checks it with verifyResponse(decisionId).
// Jev returns no prose. Every number the model sees is read from chain state, the model can only pick one of three
// named actions, and each action maps to a price step inside a band computed from the economy's own rules. Anything
// else (no key, timeout, bad answer, refusal, out of band, funds) falls back to the deterministic price.
// Not done here: verifying the inference receipt (needs @nearai/inference-sdk); it is recorded as "unverified".
import { bidFor } from "../../src/economy/pricing.ts";
import type { EconomyState, MerchantId } from "../../src/economy/state.ts";

export type Action = "raise" | "hold" | "lower";
export const ACTIONS: readonly Action[] = ["raise", "hold", "lower"];
export const DEFAULT_URL = "https://cloud-api.near.ai/v1/systemone";
export const DEFAULT_MODEL = "typesafe/jev-1.13";
/** Below this confidence in the chosen option the merchant simply holds. */
export const MIN_CONFIDENCE = 0.5;
const STEP = 1; // coins a bid may move per market day

export interface AgentConfig {
  /** Merchants the service may decide for (only Pema at first). */
  readonly enabled: ReadonlySet<MerchantId>;
  readonly key: string | null;
  readonly url: string;
  readonly model: string;
  readonly timeoutMs: number;
  /** Extra attempts after a timeout, network error or 5xx. 4xx answers are never retried. */
  readonly retries: number;
}

/** Reads the service's settings; it stays off unless NEAR_AGENT_MERCHANTS lists a merchant and NEAR_AI_KEY is set. */
export function agentConfig(env: Record<string, string | undefined>): AgentConfig {
  const ids = (env.NEAR_AGENT_MERCHANTS ?? "").split(",").map((s) => s.trim()).filter(Boolean) as MerchantId[];
  return {
    enabled: new Set(ids),
    key: (env.NEAR_AI_KEY ?? "").trim() || null,
    url: (env.NEAR_AI_SYSTEMONE_URL ?? "").trim() || DEFAULT_URL,
    model: (env.NEAR_AI_DECISION_MODEL ?? "").trim() || DEFAULT_MODEL,
    timeoutMs: 6000,
    retries: 1,
  };
}

export interface BookOffer { readonly merchant: string; readonly token_id: string; readonly side: string; readonly qty: string; readonly price: string }

export interface Band {
  /** The deterministic price (the economy's own bid rule): what happens without the model. */
  readonly base: number;
  readonly lower: number | null;
  readonly raise: number | null;
  readonly min: number;
  readonly max: number;
}

/** Cheapest mango ask other stalls have posted (the competing offer), or null. */
export function rivalAsk(offers: readonly BookOffer[], id: MerchantId): number | null {
  let best: number | null = null;
  for (const o of offers) {
    if (o.side !== "ask" || o.token_id !== "mango" || Number(o.qty) <= 0 || o.merchant === id) continue;
    const p = Number(o.price);
    if (Number.isFinite(p) && (best === null || p < best)) best = p;
  }
  return best;
}

/** The permitted prices. lower/raise are null when the step would break a limit: never below half the stall's normal
 *  cost, never above 3x it, never above the cheapest rival ask (no point paying more than the street sells for), and a
 *  raise must leave at least one unit affordable from the till. */
export function bandFor(st: EconomyState, id: MerchantId, offers: readonly BookOffer[]): Band | null {
  const m = st.merchants[id];
  const b = bidFor(st, id, "mango");
  if (!b || m.status !== "open") return null; // a closed stall's bid is the reopen rule, not a judgement call
  const min = Math.max(1, Math.floor(m.baseCost.mango * 0.5));
  const rival = rivalAsk(offers, id);
  const cap = Math.ceil(m.baseCost.mango * 3);
  const max = rival === null ? cap : Math.min(cap, rival);
  const lower = b.price - STEP >= min ? b.price - STEP : null;
  const up = b.price + STEP;
  const raise = up <= max && Math.floor(m.cash / up) >= 1 ? up : null;
  return { base: b.price, lower, raise, min, max };
}

/** Everything the model is shown: facts read from chain state, nothing else. */
export function stateFor(st: EconomyState, id: MerchantId, offers: readonly BookOffer[], band: Band, day: number): Record<string, unknown> {
  const m = st.merchants[id];
  const mine = offers.find((o) => o.merchant === id && o.side === "bid" && o.token_id === "mango");
  return {
    merchant: m.name, shop: m.shop, market_day: day,
    mangoes_on_shelf: m.stock.mango, mangoes_normally_stocked: m.target.mango,
    till_coins: Math.floor(m.cash), rent_coins: m.rent, rent_every_market_days: m.rentEveryDays,
    rent_due_today: day % m.rentEveryDays === 0,
    normal_mango_cost_coins: m.baseCost.mango,
    standing_mango_bid_coins: band.base,
    posted_bid_coins: mine ? Number(mine.price) : null,
    cheapest_rival_mango_ask_coins: rivalAsk(offers, id),
    allowed_bid_range_coins: { min: band.min, max: band.max },
    raise_would_be_coins: band.raise, lower_would_be_coins: band.lower,
    recent_market_events: st.log.slice(-5).map((e) => e.text),
  };
}

export function questionsFor(id: MerchantId, band: Band): Record<string, unknown> {
  return {
    bid_action: {
      type: "choice",
      instructions: `You manage the mango-buying bid of ${id}, a small market stall. Decide what the bid should do today so the stall keeps enough stock to sell, can still pay its rent, and does not overpay.`,
      criteria: {
        raise: `Raise the mango bid by ${STEP} coin${band.raise === null ? " (not permitted today)" : ""}: stock is low or rent is near and the till can afford it.`,
        hold: "Keep the current mango bid: stock, till and rent are in balance.",
        lower: `Lower the mango bid by ${STEP} coin${band.lower === null ? " (not permitted today)" : ""}: the shelves are full or the till is thin.`,
      },
    },
  };
}

export interface AiAnswer {
  readonly action: Action;
  readonly confidence: number | null;
  readonly probabilities: Record<string, number> | null;
  readonly decisionId: string | null;
  readonly model: string | null;
}

export type AgentErrorKind = "no_key" | "timeout" | "network" | "http" | "malformed" | "refused" | "invalid_action";
export class AgentError extends Error {
  readonly kind: AgentErrorKind;
  readonly retryable: boolean;
  constructor(kind: AgentErrorKind, message: string, retryable = false) { super(message); this.kind = kind; this.retryable = retryable; }
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; headers: { get(k: string): string | null }; json(): Promise<unknown> }>;

/** Reads `answers.bid_action`; anything that is not a clean choice of one of the three actions is rejected. */
export function parseAnswer(json: unknown, decisionId: string | null, requested: string): AiAnswer {
  const j = json as { model?: unknown; answers?: Record<string, unknown> } | null;
  const a = j && typeof j === "object" ? (j.answers?.bid_action as { type?: unknown; choice?: unknown; confidence?: unknown; probabilities?: unknown } | undefined) : undefined;
  if (!a || typeof a !== "object") throw new AgentError("malformed", "no bid_action answer");
  if (a.type === "refusal") throw new AgentError("refused", "the model declined to answer");
  if (a.type !== "choice" || typeof a.choice !== "string") throw new AgentError("malformed", "answer is not a choice");
  if (!(ACTIONS as readonly string[]).includes(a.choice)) throw new AgentError("invalid_action", `unknown action "${a.choice}"`);
  const conf = typeof a.confidence === "number" && Number.isFinite(a.confidence) && a.confidence >= 0 && a.confidence <= 1 ? a.confidence : null;
  const probs = a.probabilities && typeof a.probabilities === "object"
    ? Object.fromEntries(Object.entries(a.probabilities as Record<string, unknown>).filter(([, v]) => typeof v === "number" && Number.isFinite(v)) as [string, number][])
    : null;
  return { action: a.choice as Action, confidence: conf, probabilities: probs && Object.keys(probs).length ? probs : null, decisionId: decisionId && decisionId.length <= 200 ? decisionId : null, model: typeof j?.model === "string" ? j.model : requested };
}

/** One request to the decision model, with timeout and bounded retries on transient failures. */
export async function askModel(cfg: AgentConfig, body: { state: unknown; questions: unknown }, fetchImpl: FetchLike): Promise<AiAnswer> {
  if (!cfg.key) throw new AgentError("no_key", "NEAR_AI_KEY is not set");
  let last: AgentError | null = null;
  for (let attempt = 0; attempt <= cfg.retries; attempt++) {
    try {
      const r = await fetchImpl(cfg.url, {
        method: "POST",
        headers: { authorization: `Bearer ${cfg.key}`, "content-type": "application/json" },
        body: JSON.stringify({ model: cfg.model, state: body.state, questions: body.questions }),
        signal: AbortSignal.timeout(cfg.timeoutMs),
      });
      if (!r.ok) throw new AgentError("http", `model answered ${r.status}`, r.status >= 500 || r.status === 429);
      return parseAnswer(await r.json(), r.headers.get("x-generation-id"), cfg.model);
    } catch (e) {
      const err = e instanceof AgentError ? e
        : e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError") ? new AgentError("timeout", "model timed out", true)
          : new AgentError("network", e instanceof Error ? e.message : "network error", true);
      last = err;
      if (!err.retryable) break;
    }
  }
  throw last ?? new AgentError("network", "no attempt made");
}

export interface Receipt { readonly id: string | null; readonly status: "unverified" | "none"; readonly note: string }

export interface Decision {
  readonly merchant: MerchantId;
  readonly day: number;
  readonly source: "ai" | "fallback";
  /** The model that answered; null for a fallback. Never filled in unless the model really answered. */
  readonly model: string | null;
  readonly action: Action;
  readonly basePrice: number;
  readonly price: number;
  readonly confidence: number | null;
  readonly probabilities: Record<string, number> | null;
  readonly receipt: Receipt;
  /** Facts that were true when the choice was made (from chain state, not model prose: Jev returns none). */
  readonly justification: readonly string[];
  /** What the merchant says about it, only used once the decision is confirmed on chain. */
  readonly line: string;
  readonly fallbackReason: string | null;
  readonly txHash: string | null;
  readonly at: number;
}

/** Plain facts that explain the price step, picked from the state the model saw. */
export function justify(action: Action, s: Record<string, unknown>): string[] {
  const out: string[] = [`${s.mangoes_on_shelf} of ${s.mangoes_normally_stocked} mangoes on the shelf`, `${s.till_coins} c in the till`];
  if (s.rent_due_today) out.push(`rent of ${s.rent_coins} c is due today`);
  if (s.cheapest_rival_mango_ask_coins !== null) out.push(`the cheapest rival ask is ${s.cheapest_rival_mango_ask_coins} c`);
  out.push(action === "raise" ? "so a slightly higher bid brings stock in faster" : action === "lower" ? "so a slightly lower bid saves coin" : "so the bid stays where it is");
  return out;
}

export function lineFor(action: Action, from: number, to: number, s: Record<string, unknown>): string {
  if (action === "raise") return `I'm bidding ${to} coins a mango today, up from ${from}. My shelves are ${Number(s.mangoes_on_shelf) < Number(s.mangoes_normally_stocked) / 2 ? "getting bare" : "not as full as I'd like"}, dear.`;
  if (action === "lower") return `I'm bidding ${to} coins a mango today, down from ${from}. My shelves are full enough and the till needs care.`;
  return `I'm keeping my mango bid at ${to} coins today. Everything is in balance, dear.`;
}

const decided = new Map<string, Decision>();
const history: Decision[] = [];
const HISTORY_MAX = 20;

/** Test hook: forget every decision (the real service keeps them for the life of the server instance). */
export function resetDecisions(): void { decided.clear(); history.length = 0; }
export const recentDecisions = (merchant?: MerchantId): readonly Decision[] => history.filter((d) => !merchant || d.merchant === merchant).slice(-10).reverse();
export const decisionKey = (id: MerchantId, day: number): string => `${id}:${day}`;
export const decisionFor = (id: MerchantId, day: number): Decision | undefined => decided.get(decisionKey(id, day));

/** Records the transaction that carried a decision out (called after the bid is confirmed). */
export function attachTx(id: MerchantId, day: number, txHash: string | null): Decision | null {
  const d = decided.get(decisionKey(id, day));
  if (!d) return null;
  const next: Decision = { ...d, txHash };
  decided.set(decisionKey(id, day), next);
  const i = history.findIndex((h) => h.merchant === id && h.day === day);
  if (i >= 0) history[i] = next;
  return next;
}

export interface DecideInput {
  readonly cfg: AgentConfig;
  readonly st: EconomyState;
  readonly id: MerchantId;
  readonly offers: readonly BookOffer[];
  readonly day: number;
  readonly fetchImpl: FetchLike;
  readonly now?: () => number;
}

export interface Outcome {
  /** The bid price the tick must post. Always inside the band; the deterministic price when anything is wrong. */
  readonly price: number;
  /** null when the service is off for this merchant or the stall is closed: the tick behaves exactly as before. */
  readonly decision: Decision | null;
  /** True when this market day already had a decision (nothing was asked of the model again). */
  readonly duplicate: boolean;
}

/** One decision per merchant per market day. Idempotent: a second call for the same day returns the first. */
export async function decideBid(i: DecideInput): Promise<Outcome> {
  const { cfg, st, id, offers, day } = i;
  const band = cfg.enabled.has(id) ? bandFor(st, id, offers) : null;
  if (!band) return { price: bidFor(st, id, "mango")?.price ?? 1, decision: null, duplicate: false };
  const prior = decisionFor(id, day);
  if (prior) return { price: prior.price, decision: prior, duplicate: true };
  const state = stateFor(st, id, offers, band, day);
  const at = (i.now ?? Date.now)();
  const make = (action: Action, source: "ai" | "fallback", price: number, ai: AiAnswer | null, why: string | null): Decision => ({
    merchant: id, day, source, model: ai?.model ?? null, action, basePrice: band.base, price,
    confidence: ai?.confidence ?? null, probabilities: ai?.probabilities ?? null,
    receipt: ai?.decisionId ? { id: ai.decisionId, status: "unverified", note: "receipt id captured from X-Generation-Id; NEAR AI verification not run" } : { id: null, status: "none", note: "no inference receipt" },
    justification: justify(action, state), line: lineFor(action, band.base, price, state), fallbackReason: why, txHash: null, at,
  });
  const store = (d: Decision): Outcome => {
    decided.set(decisionKey(id, day), d);
    history.push(d);
    if (history.length > HISTORY_MAX) history.shift();
    return { price: d.price, decision: d, duplicate: false };
  };
  let ai: AiAnswer;
  try {
    ai = await askModel(cfg, { state, questions: questionsFor(id, band) }, i.fetchImpl);
  } catch (e) {
    return store(make("hold", "fallback", band.base, null, e instanceof AgentError ? `${e.kind}: ${e.message}` : "unexpected error"));
  }
  if (ai.confidence !== null && ai.confidence < MIN_CONFIDENCE) return store(make("hold", "ai", band.base, ai, `confidence ${ai.confidence} under ${MIN_CONFIDENCE}: held`));
  if (ai.action === "raise" && band.raise === null) return store(make("hold", "fallback", band.base, null, "invalid: raise is not permitted (limit or funds)"));
  if (ai.action === "lower" && band.lower === null) return store(make("hold", "fallback", band.base, null, "invalid: lower is not permitted (limit)"));
  const price = ai.action === "raise" ? band.raise! : ai.action === "lower" ? band.lower! : band.base;
  return store(make(ai.action, "ai", price, ai, null));
}
