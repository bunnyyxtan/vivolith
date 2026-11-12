// Economic decision service: bounded choices made by NEAR AI's decision model (typesafe/jev-1.13 on
// cloud-api.near.ai/v1/systemone), validated here, and applied through the existing market tick. One engine serves
// every agent: the four merchants (one price lever each) and the two economic residents (a sell/meal plan).
//
// Schema (verified against docs.near.ai/cloud/inference-sdk, OpenRouter's TypeSafe-compatible OpenAPI, and one live probe):
//   request  { model, state: any, questions: { <name>: { type: "choice", instructions?, criteria: { <option>: <text> } } } }
//   response { id, model, answers: { <name>: { type: "choice", choice, confidence?, probabilities? } | { type: "refusal" } } }
//   The receipt id is the X-Generation-Id header / `id` field; NEAR AI's SDK checks it with verifyResponse(decisionId).
// Jev returns no prose. Every number the model sees is read from chain state; the model can only pick one of the named
// options, built from orders that really exist; each option maps to an action the economy already supports and is
// validated before anything is sent. No key, timeout, refusal, bad option, low confidence or a down store all fall back to
// the deterministic rule. Receipt verification (needs @nearai/inference-sdk) is not done here: receipts are "unverified".
import { agentPrice, agentPriceKey, bidFor, quote } from "../../src/economy/pricing.ts";
import { planResident, type Offer as ResOffer, type Plan, type Resident } from "../../src/economy/residents.ts";
import type { EconomyState, Good, MerchantId } from "../../src/economy/state.ts";

export type Action = "raise" | "hold" | "lower";
export const ACTIONS: readonly Action[] = ["raise", "hold", "lower"];
export const DEFAULT_URL = "https://cloud-api.near.ai/v1/systemone";
export const DEFAULT_MODEL = "typesafe/jev-1.13";
/** Below this confidence in the chosen option the agent uses its deterministic choice instead. */
export const MIN_CONFIDENCE = 0.5;
const STEP = 1; // coins a price may move per market day

export interface AgentConfig {
  /** Agents the service may decide for: merchant ids (pema, tomas, mira, arin) and resident ids (picker, porter). */
  readonly enabled: ReadonlySet<string>;
  readonly key: string | null;
  readonly url: string;
  readonly model: string;
  readonly timeoutMs: number;
  /** Extra attempts after a timeout, network error or 5xx. 4xx answers are never retried. */
  readonly retries: number;
}

/** Reads the service's settings; it stays off unless NEAR_AGENT_MERCHANTS lists an agent and NEAR_AI_KEY is set. */
export function agentConfig(env: Record<string, string | undefined>): AgentConfig {
  const ids = (env.NEAR_AGENT_MERCHANTS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
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

// ------------------------------------------------------------------ merchants: one price lever each ----

export interface Lever { readonly side: "bid" | "ask"; readonly good: Good; readonly goal: string }
/** The one price each merchant may move, using only orders the contract already supports (`bid` / `list`). */
export const LEVERS: Readonly<Record<string, Lever>> = {
  pema: { side: "bid", good: "mango", goal: "Keep the shelves stocked so customers can buy, and keep enough coin in the till for the rent. You buy mangoes from other stalls and from pickers." },
  tomas: { side: "ask", good: "mango", goal: "Earn the best margin on the mangoes you hold without letting stock sit unsold: raise your price when mangoes are scarce on the street, lower it when you hold far more than the street wants." },
  mira: { side: "bid", good: "mango", goal: "Buy surplus mangoes cheaply and resell them where they are scarce. Do not overpay and do not empty the till." },
  arin: { side: "bid", good: "mango", goal: "Keep enough mangoes coming in for the lassi kitchen, at a price the tea house can afford." },
};
export const leverName = (id: string): string => { const l = LEVERS[id]; return l ? `${l.side}:${l.good}` : "plan"; };

export interface Band {
  /** The deterministic price (the economy's own rule): what happens without the model. */
  readonly base: number;
  readonly lower: number | null;
  readonly raise: number | null;
  readonly min: number;
  readonly max: number;
}

/** Cheapest ask for `good` that other stalls have posted (the competing offer), or null. */
export function rivalAsk(offers: readonly BookOffer[], id: string, good: string = "mango"): number | null {
  let best: number | null = null;
  for (const o of offers) {
    if (o.side !== "ask" || o.token_id !== good || Number(o.qty) <= 0 || o.merchant === id) continue;
    const p = Number(o.price);
    if (Number.isFinite(p) && (best === null || p < best)) best = p;
  }
  return best;
}

/** The permitted prices for the merchant's lever. lower/raise are null when the step would break a limit.
 *  Bid: never below half the normal cost, never above 3x it or the cheapest rival ask, and a raise must leave one unit
 *  affordable from the till. Ask: never below 0.8x the normal cost or above 4x it, and only with stock to sell. */
export function bandFor(st: EconomyState, id: MerchantId, offers: readonly BookOffer[]): Band | null {
  const l = LEVERS[id];
  const m = st.merchants[id];
  if (!l || !m || m.status !== "open") return null; // a closed stall's bid is the reopen rule, not a judgement call
  const cost = m.baseCost[l.good];
  if (l.side === "bid") {
    const b = bidFor(st, id, l.good);
    if (!b) return null;
    const min = Math.max(1, Math.floor(cost * 0.5));
    const rival = rivalAsk(offers, id, l.good);
    const cap = Math.ceil(cost * 3);
    const max = rival === null ? cap : Math.min(cap, rival);
    const lower = b.price - STEP >= min ? b.price - STEP : null;
    const up = b.price + STEP;
    const raise = up <= max && Math.floor(m.cash / up) >= 1 ? up : null;
    return { base: b.price, lower, raise, min, max };
  }
  if (!m.sells.includes(l.good) || m.stock[l.good] <= 0) return null; // nothing to sell: no price to set
  const base = quote(st, id, l.good, false).price;
  const min = Math.max(1, Math.ceil(cost * 0.8)), max = Math.ceil(cost * 4);
  return { base, lower: base - STEP >= min ? base - STEP : null, raise: base + STEP <= max ? base + STEP : null, min, max };
}

/** Everything the model is shown about a merchant: facts read from chain state, nothing else. */
export function stateFor(st: EconomyState, id: MerchantId, offers: readonly BookOffer[], band: Band, day: number): Record<string, unknown> {
  const m = st.merchants[id];
  const l = LEVERS[id];
  const mine = offers.find((o) => o.merchant === id && o.side === (l.side === "bid" ? "bid" : "ask") && o.token_id === l.good);
  return {
    merchant: m.name, shop: m.shop, market_day: day,
    role_goal: l.goal, lever: l.side === "bid" ? `your ${l.good}-buying bid` : `your ${l.good} selling price`,
    mangoes_on_shelf: m.stock.mango, mangoes_normally_stocked: m.target.mango,
    till_coins: Math.floor(m.cash), rent_coins: m.rent, rent_every_market_days: m.rentEveryDays,
    rent_due_today: day % m.rentEveryDays === 0,
    normal_mango_cost_coins: m.baseCost.mango,
    standing_mango_bid_coins: band.base,
    posted_bid_coins: mine ? Number(mine.price) : null,
    cheapest_rival_mango_ask_coins: rivalAsk(offers, id, "mango"),
    allowed_bid_range_coins: { min: band.min, max: band.max },
    raise_would_be_coins: band.raise, lower_would_be_coins: band.lower,
    recent_market_events: st.log.slice(-5).map((e) => e.text),
  };
}

export function questionsFor(id: MerchantId, band: Band): Record<string, unknown> {
  const l = LEVERS[id];
  const what = l.side === "bid" ? `${l.good}-buying bid` : `${l.good} selling price`;
  return {
    bid_action: {
      type: "choice",
      instructions: `You manage the ${what} of ${id}, a small market stall. ${l.goal} Decide what it should do today.`,
      criteria: {
        raise: `Raise the ${what} by ${STEP} coin${band.raise === null ? " (not permitted today)" : ""}: ${l.side === "bid" ? "stock is low or rent is near and the till can afford it." : "mangoes are scarce on the street and your stock is selling."}`,
        hold: `Keep the current ${what}: stock, till and rent are in balance.`,
        lower: `Lower the ${what} by ${STEP} coin${band.lower === null ? " (not permitted today)" : ""}: ${l.side === "bid" ? "the shelves are full or the till is thin." : "you hold more than the street wants and stock is not moving."}`,
      },
    },
  };
}

// ------------------------------------------------------------------ transport and parsing ----

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

export interface RawAnswer { readonly confidence: number | null; readonly probabilities: Record<string, number> | null; readonly choice: string }

/** One question's answer: a clean choice of one of `valid`, else an AgentError (the caller falls back for that question). */
export function parseChoice(a: unknown, valid: readonly string[]): RawAnswer {
  const x = a as { type?: unknown; choice?: unknown; confidence?: unknown; probabilities?: unknown } | undefined | null;
  if (!x || typeof x !== "object") throw new AgentError("malformed", "no answer");
  if (x.type === "refusal") throw new AgentError("refused", "the model declined to answer");
  if (x.type !== "choice" || typeof x.choice !== "string") throw new AgentError("malformed", "answer is not a choice");
  if (!valid.includes(x.choice)) throw new AgentError("invalid_action", `unknown option "${x.choice}"`);
  const conf = typeof x.confidence === "number" && Number.isFinite(x.confidence) && x.confidence >= 0 && x.confidence <= 1 ? x.confidence : null;
  const probs = x.probabilities && typeof x.probabilities === "object"
    ? Object.fromEntries(Object.entries(x.probabilities as Record<string, unknown>).filter(([, v]) => typeof v === "number" && Number.isFinite(v)) as [string, number][])
    : null;
  return { choice: x.choice, confidence: conf, probabilities: probs && Object.keys(probs).length ? probs : null };
}

/** Reads `answers.bid_action` (a merchant's price lever). */
export function parseAnswer(json: unknown, decisionId: string | null, requested: string): AiAnswer {
  const j = json as { model?: unknown; answers?: Record<string, unknown> } | null;
  const r = parseChoice(j && typeof j === "object" ? j.answers?.bid_action : undefined, ACTIONS);
  return { action: r.choice as Action, confidence: r.confidence, probabilities: r.probabilities, decisionId: decisionId && decisionId.length <= 200 ? decisionId : null, model: typeof j?.model === "string" ? j.model : requested };
}

export interface RawResponse { readonly json: unknown; readonly decisionId: string | null }

/** One request to the decision model, with timeout and bounded retries on transient failures. */
export async function askRaw(cfg: AgentConfig, body: { state: unknown; questions: unknown }, fetchImpl: FetchLike): Promise<RawResponse> {
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
      const json = await r.json();
      const bodyId = (json as { id?: unknown } | null)?.id;
      return { json, decisionId: r.headers.get("x-generation-id") ?? (typeof bodyId === "string" ? bodyId : null) };
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

export async function askModel(cfg: AgentConfig, body: { state: unknown; questions: unknown }, fetchImpl: FetchLike): Promise<AiAnswer> {
  const r = await askRaw(cfg, body, fetchImpl);
  return parseAnswer(r.json, r.decisionId, cfg.model);
}

// ------------------------------------------------------------------ the decision record ----

export interface Receipt { readonly id: string | null; readonly status: "unverified" | "none"; readonly note: string }

/** One answered question of a resident plan: what was chosen, and whether the model or the rule chose it. */
export interface ChoiceRecord { readonly question: string; readonly chosen: string; readonly source: "ai" | "fallback"; readonly confidence: number | null; readonly note: string | null }

export interface Decision {
  /** Merchant id (pema, tomas, mira, arin) or resident id (picker, porter). */
  readonly merchant: string;
  readonly lever: string;
  readonly kind: "price" | "plan";
  readonly day: number;
  /** "ai" only when the model answered and its choice was used; a plan is "ai" when any question was. */
  readonly source: "ai" | "fallback";
  /** The model that answered; null for a fallback. Never filled in unless the model really answered. */
  readonly model: string | null;
  readonly action: string;
  readonly basePrice: number;
  readonly price: number;
  readonly confidence: number | null;
  readonly probabilities: Record<string, number> | null;
  readonly choices: readonly ChoiceRecord[] | null;
  readonly receipt: Receipt;
  /** Facts that were true when the choice was made (from chain state, not model prose: Jev returns none). */
  readonly justification: readonly string[];
  /** What the agent says about it, only used once the decision is confirmed on chain. */
  readonly line: string;
  readonly fallbackReason: string | null;
  readonly txHash: string | null;
  readonly at: number;
}

const receiptOf = (id: string | null): Receipt => id
  ? { id, status: "unverified", note: "receipt id captured from the gateway; NEAR AI verification not run" }
  : { id: null, status: "none", note: "no inference receipt" };

/** Plain facts that explain the price step, picked from the state the model saw. */
export function justify(action: Action, s: Record<string, unknown>): string[] {
  const out: string[] = [`${s.mangoes_on_shelf} of ${s.mangoes_normally_stocked} mangoes on the shelf`, `${s.till_coins} c in the till`];
  if (s.rent_due_today) out.push(`rent of ${s.rent_coins} c is due today`);
  if (s.cheapest_rival_mango_ask_coins !== null) out.push(`the cheapest rival ask is ${s.cheapest_rival_mango_ask_coins} c`);
  out.push(action === "raise" ? "so a slightly higher price suits today" : action === "lower" ? "so a slightly lower price suits today" : "so the price stays where it is");
  return out;
}

const TAIL: Record<string, { up: string; down: string; keep: string }> = {
  pema: { up: ", dear.", down: ", dear.", keep: ", dear." },
  tomas: { up: ". Take it or leave it.", down: ". Don't get used to it.", keep: ". Not a coin less." },
  mira: { up: ". Keep up!", down: ". Catch me if you can!", keep: ". Nice and steady." },
  arin: { up: ". The kitchen is hungry.", down: ". We're well stocked.", keep: ". It's working." },
};

/** What the merchant says about their own confirmed decision, in their own manner. Only facts from the decision. */
export function lineFor(action: Action, from: number, to: number, s: Record<string, unknown>, id = "pema"): string {
  const l = LEVERS[id];
  const what = !l || l.side === "bid" ? "bidding" : "asking";
  const unit = !l ? "mango" : l.good;
  const t = TAIL[id] ?? TAIL.pema;
  const stock = Number(s.mangoes_on_shelf) < Number(s.mangoes_normally_stocked) / 2 ? "My shelves are getting bare" : "My shelves could be fuller";
  if (action === "raise") return `I'm ${what} ${to} coins a ${unit} today, up from ${from}${l?.side === "ask" ? "" : `. ${stock}`}${t.up}`;
  if (action === "lower") return `I'm ${what} ${to} coins a ${unit} today, down from ${from}${l?.side === "ask" ? ". The stock needs to move" : ". The till needs care"}${t.down}`;
  return `I'm keeping my ${unit} ${l?.side === "ask" ? "price" : "bid"} at ${to} coins today${t.keep}`;
}

// ------------------------------------------------------------------ persistence ----

/** Persistent key-value store the guard lives in: Upstash Redis in production (handlers.ts), a Map in dev and tests. */
export interface DecisionStore {
  get(key: string): Promise<string | null>;
  /** SET key value NX EX ttl: true only for the one caller that created it. */
  setNx(key: string, value: string, ttlSec: number): Promise<boolean>;
  set(key: string, value: string, ttlSec: number): Promise<void>;
  del(key: string): Promise<void>;
}

const DAY_SEC = 600; // one market day (handlers.ts MARKET_DAY_MS = 10 min)
const DECISION_TTL = DAY_SEC * 3; // kept past the day so the board can still show it
const LOCK_TTL = 30; // a crashed tick frees the lock after this
export const decisionKey = (id: string, day: number): string => `vivolith:agent:${id}:${leverName(id)}:${day}`;
const keyOf = decisionKey;

export async function decisionFor(store: DecisionStore, id: string, day: number): Promise<Decision | null> {
  const raw = await store.get(keyOf(id, day));
  if (!raw) return null;
  try { return JSON.parse(raw) as Decision; } catch { return null; }
}

/** An agent's decisions for this market day and the one before, newest first (read-only, for the board). */
export async function recentDecisions(store: DecisionStore, id: string, day: number): Promise<Decision[]> {
  const out: Decision[] = [];
  for (const d of [day, day - 1]) { const x = await decisionFor(store, id, d); if (x) out.push(x); }
  return out;
}

/** Claims the one right to send this agent's transaction for the market day. Concurrent ticks: exactly one true.
 *  Release it when the transaction fails so the next tick may retry. */
export async function claimBidSend(store: DecisionStore, id: string, day: number): Promise<boolean> {
  return store.setNx(`${keyOf(id, day)}:send`, String(Date.now()), DECISION_TTL);
}
export const releaseBidSend = (store: DecisionStore, id: string, day: number): Promise<void> => store.del(`${keyOf(id, day)}:send`);

/** Records the transaction that carried a decision out (called after it is confirmed). */
export async function attachTx(store: DecisionStore, id: string, day: number, txHash: string | null): Promise<Decision | null> {
  const d = await decisionFor(store, id, day);
  if (!d) return null;
  const next: Decision = { ...d, txHash };
  await store.set(keyOf(id, day), JSON.stringify(next), DECISION_TTL);
  return next;
}

export interface LivePrice { readonly id: MerchantId; readonly side: "ask" | "bid"; readonly good: Good; readonly price: number }

/** Prices a NEAR AI decision is setting right now: a real (not fallback) decision for this market day whose transaction
 *  is confirmed AND whose order is still posted on chain at that price. The contract stays authoritative: if the order
 *  moved or was withdrawn, the decision no longer prices anything and the rule price applies. */
export async function livePrices(store: DecisionStore, offers: readonly BookOffer[], day: number): Promise<LivePrice[]> {
  const out: LivePrice[] = [];
  for (const id of Object.keys(LEVERS)) {
    const l = LEVERS[id];
    const d = await decisionFor(store, id, day).catch(() => null);
    if (!d || d.kind !== "price" || d.source !== "ai" || !d.txHash) continue;
    if (offers.some((o) => o.merchant === id && o.token_id === l.good && o.side === l.side && Number(o.price) === d.price && Number(o.qty) > 0)) out.push({ id: id as MerchantId, side: l.side, good: l.good, price: d.price });
  }
  return out;
}

/** Writes live prices into an economy state's flags, so pricing.ts quote()/bidFor() use them (server `deal`, client). */
export function applyLivePrices(st: EconomyState, live: readonly LivePrice[]): void {
  for (const k of Object.keys(st.flags)) if (k.startsWith("agentPrice.")) delete st.flags[k]; // stale ones never linger
  for (const p of live) st.flags[agentPriceKey(p.id, p.side, p.good)] = p.price;
}

/** The current agent price when the buyer's reference (the raw decision price their screen was built on) is not it.
 *  null = nothing to refuse: no live decision for this lever, or the reference matches. */
export function priceMoved(st: EconomyState, id: MerchantId, tradeSide: "buy" | "sell", good: Good, ref: number | null): number | null {
  const live = agentPrice(st, id, tradeSide === "buy" ? "ask" : "bid", good);
  if (live === null || ref === null) return null; // an older client sends no reference: the existing bounds apply
  return Math.round(ref) === live ? null : live;
}

interface Common {
  readonly store: DecisionStore;
  readonly cfg: AgentConfig;
  readonly day: number;
  readonly fetchImpl: FetchLike;
  readonly now?: () => number;
  /** Test hooks for the wait on a concurrent tick. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly waitSteps?: number;
}

/** Runs `fresh` at most once per agent per market day across every instance (store lock), returning the stored
 *  decision otherwise. null means "no decision": off, or the store is down (no idempotency, so no model call). */
async function once(c: Common, id: string, fresh: () => Promise<Decision>): Promise<{ decision: Decision | null; duplicate: boolean; skip: boolean }> {
  const { store, day } = c;
  try {
    const prior = await decisionFor(store, id, day);
    if (prior) return { decision: prior, duplicate: true, skip: false };
    if (!(await store.setNx(`${keyOf(id, day)}:lock`, "1", LOCK_TTL))) { // another tick owns this decision
      for (let k = 0; k < (c.waitSteps ?? 8); k++) {
        await (c.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(500);
        const d = await decisionFor(store, id, day);
        if (d) return { decision: d, duplicate: true, skip: true }; // that tick carries it out
      }
      return { decision: null, duplicate: true, skip: true };
    }
    try {
      const d = await fresh();
      await store.set(keyOf(id, day), JSON.stringify(d), DECISION_TTL);
      return { decision: d, duplicate: false, skip: false };
    } finally {
      await store.del(`${keyOf(id, day)}:lock`).catch(() => undefined);
    }
  } catch {
    return { decision: null, duplicate: false, skip: false };
  }
}

// ------------------------------------------------------------------ merchants ----

export interface DecideInput extends Common {
  readonly st: EconomyState;
  readonly id: MerchantId;
  readonly offers: readonly BookOffer[];
}

export interface Outcome {
  /** The price the tick must post for the lever. Always inside the band; the deterministic price when anything is wrong. */
  readonly price: number;
  /** null when the service is off for this merchant or the stall is closed: the tick behaves exactly as before. */
  readonly decision: Decision | null;
  /** True when this market day already had a decision (nothing was asked of the model again). */
  readonly duplicate: boolean;
  /** True when another tick is deciding right now: this tick must not post this merchant's lever order at all. */
  readonly skipBid: boolean;
}

/** One effective decision per merchant per market day, shared by every serverless instance through the store.
 *  If the store itself is down nothing is decided and the plain rule price is used, as before the agent existed. */
export async function decideBid(i: DecideInput): Promise<Outcome> {
  const { cfg, st, id, offers, day } = i;
  const l = LEVERS[id];
  const rule = (): Outcome => ({ price: l ? (l.side === "bid" ? bidFor(st, id, l.good)?.price : quote(st, id, l.good, false).price) ?? 1 : 1, decision: null, duplicate: false, skipBid: false });
  const band = l && cfg.enabled.has(id) ? bandFor(st, id, offers) : null;
  if (!band) return rule();
  const r = await once(i, id, () => decideFresh(i, band));
  if (!r.decision) return r.skip ? { price: band.base, decision: null, duplicate: true, skipBid: true } : rule();
  return { price: r.decision.price, decision: r.decision, duplicate: r.duplicate, skipBid: r.skip };
}

async function decideFresh(i: DecideInput, band: Band): Promise<Decision> {
  const { cfg, st, id, offers, day } = i;
  const state = stateFor(st, id, offers, band, day);
  const at = (i.now ?? Date.now)();
  const make = (action: Action, source: "ai" | "fallback", price: number, ai: AiAnswer | null, why: string | null): Decision => ({
    merchant: id, lever: leverName(id), kind: "price", day, source, model: ai?.model ?? null, action, basePrice: band.base, price,
    confidence: ai?.confidence ?? null, probabilities: ai?.probabilities ?? null, choices: null,
    receipt: receiptOf(ai?.decisionId ?? null),
    justification: justify(action, state), line: lineFor(action, band.base, price, state, id), fallbackReason: why, txHash: null, at,
  });
  let ai: AiAnswer;
  try {
    ai = await askModel(cfg, { state, questions: questionsFor(id, band) }, i.fetchImpl);
  } catch (e) {
    return make("hold", "fallback", band.base, null, e instanceof AgentError ? `${e.kind}: ${e.message}` : "unexpected error");
  }
  if (ai.confidence !== null && ai.confidence < MIN_CONFIDENCE) return make("hold", "ai", band.base, ai, `confidence ${ai.confidence} under ${MIN_CONFIDENCE}: held`);
  if (ai.action === "raise" && band.raise === null) return make("hold", "fallback", band.base, null, "invalid: raise is not permitted (limit or funds)");
  if (ai.action === "lower" && band.lower === null) return make("hold", "fallback", band.base, null, "invalid: lower is not permitted (limit)");
  const price = ai.action === "raise" ? band.raise! : ai.action === "lower" ? band.lower! : band.base;
  return make(ai.action, "ai", price, ai, null);
}

// ------------------------------------------------------------------ residents: where to sell, where to eat ----

export interface ResidentInput extends Common {
  readonly res: Resident;
  readonly offers: readonly ResOffer[];
  /** What the resident holds after the day's work was minted. */
  readonly coin: number;
  readonly holding: number;
}

export interface ResidentOutcome {
  /** The plan the tick executes: validated choices, else exactly planResident's deterministic plan. */
  readonly plan: Plan;
  readonly decision: Decision | null;
  readonly duplicate: boolean;
  /** Another tick holds this resident's decision: do nothing this turn. */
  readonly skip: boolean;
}

interface Cand { readonly merchant: string; readonly account: string; readonly price: number; readonly qty: number }
const bestPerMerchant = (offers: readonly ResOffer[], side: "bid" | "ask", token: string): Map<string, Cand> => {
  const out = new Map<string, Cand>();
  for (const o of offers) {
    if (o.side !== side || o.token_id !== token || !(Number(o.qty) > 0) || !(Number(o.price) > 0)) continue;
    const c: Cand = { merchant: o.merchant, account: o.account_id, price: Number(o.price), qty: Number(o.qty) };
    const cur = out.get(o.merchant);
    if (!cur || (side === "bid" ? c.price > cur.price : c.price < cur.price)) out.set(o.merchant, c);
  }
  return out;
};

/** Builds a plan from two choices, validating both against the posted orders and the purse. Returns null when a choice
 *  names something that does not exist or cannot be afforded (the caller falls back for that question). */
function assemble(res: Resident, bids: Map<string, Cand>, asks: Map<string, Cand>, holding: number, coin: number, sellTo: string, mealFrom: string): { plan: Plan; sellOk: boolean; mealOk: boolean } {
  const b = sellTo === "hold" ? null : bids.get(sellTo) ?? null;
  const qty = b ? Math.min(holding, b.qty) : 0;
  const sell = b && qty > 0 ? { buyer: b.account, merchant: b.merchant, qty, price: b.price } : null;
  const sellOk = sellTo === "hold" || sell !== null;
  const purse = coin + (sell ? sell.qty * sell.price : 0);
  const a = mealFrom === "skip" ? null : asks.get(mealFrom) ?? null;
  const eat = a && purse >= a.price ? { seller: a.account, merchant: a.merchant, price: a.price } : null;
  const mealOk = mealFrom === "skip" || eat !== null;
  const cheapest = [...asks.values()].sort((x, y) => x.price - y.price)[0];
  const hungry = !eat && mealFrom !== "skip" && cheapest && purse < cheapest.price ? cheapest.price : null;
  return { plan: { sell, eat, hungry }, sellOk, mealOk };
}

/** One effective decision per resident per market day (same store, lock and fallbacks as the merchants). */
export async function decideResident(i: ResidentInput): Promise<ResidentOutcome> {
  const { cfg, res, offers, coin, holding } = i;
  const rule = planResident(res, offers, coin, holding);
  const off: ResidentOutcome = { plan: rule, decision: null, duplicate: false, skip: false };
  if (!cfg.enabled.has(res.id)) return off;
  const bids = bestPerMerchant(offers, "bid", res.good), asks = bestPerMerchant(offers, "ask", res.food);
  if (!bids.size && !asks.size) return off; // nothing posted: nothing to decide
  const fb = { sell: rule.sell?.merchant ?? "hold", meal: rule.eat?.merchant ?? "skip" };
  const r = await once(i, res.id, () => residentFresh(i, bids, asks, fb));
  if (!r.decision) return r.skip ? { ...off, duplicate: true, skip: true } : off;
  // rebuild the plan from the stored choices against today's orders; anything that no longer holds uses the rule's choice
  const pick = (q: string, fallback: string): string => r.decision!.choices?.find((c) => c.question === q)?.chosen ?? fallback;
  let built = assemble(res, bids, asks, holding, coin, pick("sell_to", fb.sell), pick("meal_from", fb.meal));
  if (!built.sellOk || !built.mealOk) built = assemble(res, bids, asks, holding, coin, built.sellOk ? pick("sell_to", fb.sell) : fb.sell, built.mealOk ? pick("meal_from", fb.meal) : fb.meal);
  return { plan: built.plan, decision: r.decision, duplicate: r.duplicate, skip: r.skip };
}

async function residentFresh(i: ResidentInput, bids: Map<string, Cand>, asks: Map<string, Cand>, fb: { sell: string; meal: string }): Promise<Decision> {
  const { cfg, res, coin, holding, day } = i;
  const at = (i.now ?? Date.now)();
  const sellOpts = [...bids.keys(), "hold"], mealOpts = [...asks.keys(), "skip"];
  const state = {
    name: res.name, job: res.job, market_day: day,
    role_goal: `You are ${res.name}, a ${res.job}. Earn as much coin as you can for today's ${res.good}, then eat one ${res.food} as cheaply as you can. You can only sell what you hold and only spend what you have.`,
    goods_held: { [res.good]: holding }, coin, daily_output: res.perDay,
    stalls_buying_what_you_sell: [...bids.values()].map((c) => ({ stall: c.merchant, pays_coins_each: c.price, buys_up_to: c.qty })),
    stalls_selling_your_meal: [...asks.values()].map((c) => ({ stall: c.merchant, price_coins: c.price, in_stock: c.qty })),
  };
  const questions = {
    sell_to: {
      type: "choice", instructions: `Which stall should ${res.name} sell today's ${res.good} to? Prefer the best price; "hold" keeps the goods unsold today.`,
      criteria: { ...Object.fromEntries([...bids.values()].map((c) => [c.merchant, `Sell to ${c.merchant}: pays ${c.price} c each for up to ${c.qty}.`])), hold: "Keep the goods and sell nothing today." },
    },
    meal_from: {
      type: "choice", instructions: `Where should ${res.name} buy one ${res.food} to eat? Choose the cheapest stall the purse can pay; "skip" buys no meal.`,
      criteria: { ...Object.fromEntries([...asks.values()].map((c) => [c.merchant, `Buy from ${c.merchant}: ${c.price} c.`])), skip: "Do not buy a meal today." },
    },
  };
  const rec = (question: string, chosen: string, source: "ai" | "fallback", confidence: number | null, note: string | null): ChoiceRecord => ({ question, chosen, source, confidence, note });
  const wrap = (choices: ChoiceRecord[], model: string | null, receipt: string | null, why: string | null): Decision => {
    const sell = choices.find((c) => c.question === "sell_to")!.chosen, meal = choices.find((c) => c.question === "meal_from")!.chosen;
    const b = sell === "hold" ? null : bids.get(sell);
    const aiUsed = choices.some((c) => c.source === "ai");
    return {
      merchant: res.id, lever: "plan", kind: "plan", day, source: aiUsed ? "ai" : "fallback", model: aiUsed ? model : null,
      action: `sell_to ${sell}; meal_from ${meal}`, basePrice: Math.max(0, ...[...bids.values()].map((c) => c.price)), price: b?.price ?? 0,
      confidence: choices.find((c) => c.source === "ai")?.confidence ?? null, probabilities: null, choices,
      receipt: receiptOf(aiUsed ? receipt : null),
      justification: [`${holding} ${res.good} held, ${coin} c in the purse`, ...[...bids.values()].map((c) => `${c.merchant} bids ${c.price} c`), ...[...asks.values()].map((c) => `${c.merchant} sells ${res.food} at ${c.price} c`)],
      line: sell === "hold" ? `${res.name}: keeping the ${res.good} today.` : `${res.name}: selling ${res.good} to ${sell}${meal === "skip" ? "" : `, then a ${res.food} from ${meal}`}.`,
      fallbackReason: why, txHash: null, at,
    };
  };
  let raw: RawResponse;
  try {
    raw = await askRaw(cfg, { state, questions }, i.fetchImpl);
  } catch (e) {
    const why = e instanceof AgentError ? `${e.kind}: ${e.message}` : "unexpected error";
    return wrap([rec("sell_to", fb.sell, "fallback", null, why), rec("meal_from", fb.meal, "fallback", null, why)], null, null, why);
  }
  const answers = (raw.json as { answers?: Record<string, unknown>; model?: unknown } | null)?.answers ?? {};
  const model = typeof (raw.json as { model?: unknown } | null)?.model === "string" ? String((raw.json as { model: string }).model) : cfg.model;
  const choose = (q: string, valid: string[], fallback: string): ChoiceRecord => {
    try {
      const a = parseChoice(answers[q], valid);
      if (a.confidence !== null && a.confidence < MIN_CONFIDENCE) return rec(q, fallback, "fallback", a.confidence, `confidence ${a.confidence} under ${MIN_CONFIDENCE}: rule choice used`);
      return rec(q, a.choice, "ai", a.confidence, null);
    } catch (e) { return rec(q, fallback, "fallback", null, e instanceof AgentError ? `${e.kind}: ${e.message}` : "invalid"); }
  };
  let sell = choose("sell_to", sellOpts, fb.sell);
  const built = assemble(res, bids, asks, holding, coin, sell.chosen, "skip");
  if (!built.sellOk) sell = rec("sell_to", fb.sell, "fallback", null, "invalid: nothing to sell to that stall");
  let meal = choose("meal_from", mealOpts, fb.meal);
  const withSell = assemble(res, bids, asks, holding, coin, sell.chosen, meal.chosen);
  if (!withSell.mealOk) { // rule choice if the purse covers it after this sale, else no meal
    const alt = assemble(res, bids, asks, holding, coin, sell.chosen, fb.meal);
    meal = rec("meal_from", alt.mealOk ? fb.meal : "skip", "fallback", null, "invalid: the purse cannot pay that price");
  }
  return wrap([sell, meal], model, raw.decisionId, null);
}
