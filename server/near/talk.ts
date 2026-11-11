// "Ask why" (WP8): a merchant explains their prices and their day in their own voice, from facts read on NEAR.
// NEAR AI (OpenAI-compatible, cloud-api.near.ai) only phrases the answer; it decides nothing and moves no coin.
// Guard: every number in the reply must appear in the facts, else the scripted line is used. No key, a timeout or
// an error also give the scripted line, labelled "script" so the game never presents it as AI.
import { quote } from "../../src/economy/pricing.ts";
import { PERSONALITY } from "../../src/economy/haggle.ts";
import type { EconomyState, MerchantId } from "../../src/economy/state.ts";

export interface TalkReply { readonly source: "ai" | "script"; readonly line: string }
interface Offer { readonly merchant: string; readonly token_id: string; readonly side: string; readonly qty: string; readonly price: string }
interface Receipt { readonly kind: string; readonly token_id: string; readonly qty: string; readonly price: string; readonly counterparty: string }

const AI_URL = "https://cloud-api.near.ai/v1/chat/completions";
const AI_TIMEOUT_MS = 4000;
const MAX_LINE = 280;

/** Plain sentences, each a fact from the chain or the readable pricing rules (src/economy/pricing.ts). */
export function factsFor(st: EconomyState, id: MerchantId, offers: readonly Offer[], receipts: readonly Receipt[]): { facts: string[]; script: string } {
  const m = st.merchants[id];
  const good = id === "arin" ? "lassi" : "mango";
  const q = quote(st, id, good, true);
  const reasons = q.factors.filter((f) => Math.abs(f.multiplier - 1) > 0.015).map((f) => f.label);
  const mine = offers.filter((o) => o.merchant === id && Number(o.qty) > 0);
  const facts = [
    `You are ${m.name} and you run ${m.shop} in Saltlight Market.`,
    `Your stall is ${m.status === "open" ? "open" : "closed because rent went unpaid"}.`,
    `Your till holds ${Math.floor(m.cash)} coins. Rent is ${m.rent} coins every ${m.rentEveryDays} market days.`,
    `On your shelves: ${m.stock.mango} mangoes, ${m.stock.lemon} lemons, ${m.stock.lassi} lassi.`,
    `Your price for a ${good} today is ${q.price} coins.${reasons.length ? ` Why: ${reasons.join("; ")}.` : " It is a normal day."}`,
    ...mine.map((o) => `You ${o.side === "ask" ? "sell" : "buy"} ${o.token_id} at ${o.price} coins, up to ${o.qty}.`),
    ...receipts.slice(-3).map((r) => `Recently you ${r.kind} ${r.qty} ${r.token_id} at ${r.price} coins with ${r.counterparty.split(".")[0]}.`),
  ];
  const script = m.status !== "open"
    ? `My shutters are down until rent is sorted. My till holds ${Math.floor(m.cash)} coins.`
    : `${q.price} coins a ${good} today${reasons.length ? `: ${reasons[0].toLowerCase()}` : ", a normal day"}. My till holds ${Math.floor(m.cash)} coins and rent is ${m.rent}.`;
  return { facts, script };
}

const numbers = (s: string): string[] => s.match(/\d+(?:\.\d+)?/g) ?? [];

/** True if every number in `line` is one of the facts' numbers (the model may not invent a price, stock or sum). */
export function grounded(line: string, facts: readonly string[]): boolean {
  const known = new Set(facts.flatMap(numbers));
  return numbers(line).every((n) => known.has(n));
}

export interface AiEnv { readonly key: string | null; readonly model: string | null }

/** One short in-character answer. `fetchImpl` is swappable for the offline check (no network there). */
export async function answer(ai: AiEnv, id: MerchantId, facts: readonly string[], script: string, question: string, fetchImpl: typeof fetch = fetch): Promise<TalkReply> {
  if (!ai.key || !ai.model) return { source: "script", line: script };
  const voice = PERSONALITY[id];
  const system = [
    `You are ${voice.name}, a market merchant in a cosy anime city. Your trading style: ${voice.trait}.`,
    "Answer in one or two short sentences, warm and in character, in plain words a child understands.",
    "Use only the facts below. Never state a number that is not in them. Never mention blockchains, wallets, tokens or AI.",
    "Facts:", ...facts.map((f) => `- ${f}`),
  ].join("\n");
  try {
    const r = await fetchImpl(AI_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${ai.key}`, "content-type": "application/json" },
      body: JSON.stringify({ model: ai.model, max_tokens: 120, temperature: 0.6, messages: [{ role: "system", content: system }, { role: "user", content: question.slice(0, 160) || "Why is your price what it is today?" }] }),
      signal: AbortSignal.timeout(AI_TIMEOUT_MS),
    });
    if (!r.ok) return { source: "script", line: script };
    const j = (await r.json()) as { choices?: { message?: { content?: string } }[] };
    const line = (j.choices?.[0]?.message?.content ?? "").replace(/\s+/g, " ").trim();
    if (!line || line.length > MAX_LINE || !grounded(line, facts)) return { source: "script", line: script };
    return { source: "ai", line };
  } catch {
    return { source: "script", line: script }; // timeout or network: the game never waits on the model
  }
}
