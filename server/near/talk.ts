// Conversations: a merchant or resident answers the player's own question in their own voice, from facts read on NEAR
// (balances, posted orders, the contract's receipts), their confirmed decisions (agent.ts) and their economic memory
// (memory.ts). A fast NEAR AI chat model (OpenAI-compatible, cloud-api.near.ai) only phrases the answer; it decides
// nothing and moves no coin. Jev decisions and this dialogue are separate services: talk never asks Jev, and nothing
// said here changes a price.
// Guards: every number in the reply must appear in the facts; no mention of chains, tokens, wallets or AI; a length cap.
// Any failure (no key or model, kill switch, budget, timeout, a guard) gives a scripted line chosen by topic from the
// same facts, labelled "script" so the game never presents it as AI. Output is plain text split into sentences, ready
// for a streaming voice (Phase 3).
import { quote } from "../../src/economy/pricing.ts";
import { PERSONALITY } from "../../src/economy/haggle.ts";
import type { Resident } from "../../src/economy/residents.ts";
import type { EconomyState, MerchantId } from "../../src/economy/state.ts";
import type { Decision } from "./agent.ts";
import { memoryFacts, type MemoryRow } from "./memory.ts";

export interface TalkReply {
  readonly source: "ai" | "script";
  readonly line: string;
  readonly speaker: string;
  /** The line split into sentences, for a voice that streams sentence by sentence. */
  readonly sentences: readonly string[];
}
export interface Offer { readonly merchant: string; readonly token_id: string; readonly side: string; readonly qty: string; readonly price: string }
export interface Receipt { readonly kind: string; readonly token_id: string; readonly qty: string; readonly price: string; readonly counterparty: string }
/** One earlier exchange in this conversation, as the server itself stored it (never taken from the client). */
export interface Exchange { readonly q: string; readonly a: string }

export const AI_URL = "https://cloud-api.near.ai/v1/chat/completions";
const AI_TIMEOUT_MS = 4000;
const MAX_LINE = 280;
export const MAX_QUESTION = 200;

/** Who is speaking: name, how they talk, and what they care about. Consistent across every reply. */
export const PERSONA: Readonly<Record<string, { readonly name: string; readonly voice: string }>> = {
  pema: { name: "Auntie Pema", voice: "warm, motherly and a little worried about rent; calls people 'dear'; proud of her regulars; never brags" },
  tomas: { name: "Tomas Vell", voice: "brisk, greedy and blunt; talks margins and harbor freight; short sentences; never apologises for a price" },
  mira: { name: "Mira Sol", voice: "quick, playful arbitrageur; talks spreads and timing; teases a little; always on the move" },
  arin: { name: "Arin Okoye", voice: "calm and steady tea-house owner; thinks about the lassi kitchen; measured, kind, practical" },
  picker: { name: "Lin", voice: "cheerful orchard picker; practical about every coin; talks about the trees, the morning pick and lunch" },
  porter: { name: "Dev", voice: "laconic harbor porter; few words, dry humour; talks about crates, lemons and the day's pay" },
};

/** Plain sentences describing today's decision without technical words (the UI shows the proof separately). */
export function decisionFacts(d: Decision | null): string[] {
  if (!d) return [];
  if (d.kind === "plan") {
    const sell = d.choices?.find((c) => c.question === "sell_to")?.chosen, meal = d.choices?.find((c) => c.question === "meal_from")?.chosen;
    return [
      `Today you planned to ${!sell || sell === "hold" ? "keep your goods" : `sell to ${sell}${d.price ? ` at ${d.price} coins each` : ""}`}${meal && meal !== "skip" ? ` and buy your meal from ${meal}` : ""}${d.source === "ai" ? ", by your own choice" : ", the usual way"}.`,
      ...(d.txHash ? ["You carried the plan out today."] : []),
    ];
  }
  const [side, good] = d.lever.split(":");
  const what = side === "ask" ? `${good} price` : `${good} buying price`;
  const move = d.action === "hold" ? `kept your ${what} at ${d.price} coins` : `${d.action === "raise" ? "raised" : "lowered"} your ${what} from ${d.basePrice} to ${d.price} coins`;
  return [
    `Today you ${move}${d.source === "ai" ? " on your own judgement" : " by the usual rule"}${d.txHash ? ", and the new order is posted" : ""}.`,
    ...(d.source === "ai" ? [`What you weighed: ${d.justification.slice(0, -1).join("; ")}.`] : []),
  ];
}

/** Trades the player made with this speaker, from the player's own receipts on the contract. */
export function playerFacts(receipts: readonly Receipt[], npcAccount: string): string[] {
  const mine = receipts.filter((r) => r.counterparty === npcAccount && (r.kind === "bought" || r.kind === "sold")).slice(-3);
  if (!mine.length) return ["You have not traded with this customer before."];
  return mine.map((r) => `This customer ${r.kind} ${r.qty} ${r.token_id} ${r.kind === "bought" ? "from" : "to"} you at ${r.price} coins each.`);
}

/** Facts for a merchant: the chain, the readable pricing rules (src/economy/pricing.ts), decision, memory, the player. */
export function factsFor(st: EconomyState, id: MerchantId, offers: readonly Offer[], receipts: readonly Receipt[], extra: { decision?: Decision | null; memory?: readonly MemoryRow[]; player?: readonly string[] } = {}): { facts: string[]; script: string; topics: Record<string, string>; ledger: Ledger } {
  const m = st.merchants[id];
  const good = id === "arin" ? "lassi" : "mango";
  const q = quote(st, id, good, true);
  const reasons = q.factors.filter((f) => Math.abs(f.multiplier - 1) > 0.015).map((f) => f.label);
  const mine = offers.filter((o) => o.merchant === id && Number(o.qty) > 0);
  const dFacts = decisionFacts(extra.decision ?? null);
  const mFacts = memoryFacts(extra.memory ?? [], "mango", 2);
  const facts = [
    `You are ${m.name} and you run ${m.shop} in Saltlight Market.`,
    `Your stall is ${m.status === "open" ? "open" : "closed because rent went unpaid"}.`,
    `Your till holds ${Math.floor(m.cash)} coins. Rent is ${m.rent} coins every ${m.rentEveryDays} market days.`,
    `On your shelves: ${m.stock.mango} mangoes, ${m.stock.lemon} lemons, ${m.stock.lassi} lassi.`,
    ...(Number(st.flags[`debt.${id}`] ?? 0) > 0 ? [`You owe the Market Guild ${Number(st.flags[`debt.${id}`])} coins and repay it a little at a time from what you earn above your rent.`] : []),
    `Your price for a ${good} today is ${q.price} coins.${reasons.length ? ` Why: ${reasons.join("; ")}.` : " It is a normal day."}`,
    ...mine.map((o) => `You ${o.side === "ask" ? "sell" : "buy"} ${o.token_id} at ${o.price} coins, up to ${o.qty}.`),
    ...receipts.slice(-3).map((r) => `Recently you ${r.kind} ${r.qty} ${r.token_id} at ${r.price} coins with ${r.counterparty.split(".")[0]}.`),
    ...dFacts, ...mFacts, ...(extra.player ?? []),
  ];
  const price = m.status !== "open"
    ? `My shutters are down until rent is sorted. My till holds ${Math.floor(m.cash)} coins.`
    : `${q.price} coins a ${good} today${reasons.length ? `: ${reasons[0].toLowerCase()}` : ", a normal day"}. My till holds ${Math.floor(m.cash)} coins and rent is ${m.rent}.`;
  const topics: Record<string, string> = {
    price,
    rent: m.cash >= m.rent ? `Rent is ${m.rent} coins and my till holds ${Math.floor(m.cash)}, so I can pay it.` : `Rent is ${m.rent} coins and my till holds only ${Math.floor(m.cash)}. I need to sell.`,
    stock: `I have ${m.stock.mango} mangoes, ${m.stock.lemon} lemons and ${m.stock.lassi} lassi right now.`,
  };
  if (dFacts.length) topics.decision = firstPerson(dFacts[0]);
  if (mFacts.length) topics.past = firstPerson(mFacts[0]);
  const traded = (extra.player ?? []).filter((f) => f.startsWith("This customer"));
  if (traded.length) topics.you = traded[traded.length - 1].replace(/^This customer (\w+) (.+) (from|to) you/, (_, k: string, what: string, dir: string) => `You ${k} ${what} ${dir} me`);
  return { facts, script: price, topics, ledger: { held: { mango: m.stock.mango, lemon: m.stock.lemon, lassi: m.stock.lassi } } };
}

/** "1 mango", "65 mangoes", "2 lemons", "5 lassi". */
export const goodsOf = (good: string, n: number): string => `${n} ${n === 1 || good === "lassi" ? good : good === "mango" ? "mangoes" : `${good}s`}`;

/** Facts for a resident (Lin, Dev): purse and goods on chain, the bids for their work, their meal, their plan, memory.
 *  Each quantity is labelled with its role (held now, picked per day, what one order takes) so the chat model cannot
 *  swap them; `ledger` lets `grounded` check the same roles in the reply. */
export function residentFacts(r: Resident, held: Readonly<Record<string, number>>, offers: readonly Offer[], names: Readonly<Record<string, string>>, extra: { decision?: Decision | null; memory?: readonly MemoryRow[] } = {}): { facts: string[]; script: string; topics: Record<string, string>; ledger: Ledger } {
  const bids = offers.filter((o) => o.side === "bid" && o.token_id === r.good && Number(o.qty) > 0).sort((a, b) => Number(b.price) - Number(a.price));
  const meals = offers.filter((o) => o.side === "ask" && o.token_id === r.food && Number(o.qty) > 0).sort((a, b) => Number(a.price) - Number(b.price));
  const who = (id: string): string => names[id] ?? id;
  const dFacts = decisionFacts(extra.decision ?? null), mFacts = memoryFacts(extra.memory ?? [], r.good, 2);
  const have = held[r.good] ?? 0, shown = bids.slice(0, 3);
  const takes = shown.reduce((n, o) => n + Number(o.qty), 0);
  const facts = [
    `You are ${r.name}, ${/^[aeiou]/i.test(r.job) ? "an" : "a"} ${r.job} in Saltlight Market. You sell what you gather to the stalls, then buy a ${r.food} to eat.`,
    `Your daily work: each market day you gather ${goodsOf(r.good, r.perDay)} from ${r.reason}. That is what you add each day, not what you have.`,
    `What you hold right now, in total: ${goodsOf(r.good, have)}, ${held.coin ?? 0} coins and ${goodsOf(r.food, held[r.food] ?? 0)}.`,
    ...shown.map((o) => `${who(o.merchant)} has an order to buy at most ${goodsOf(r.good, Number(o.qty))} from you, at ${o.price} coins each.`),
    ...(shown.length && takes < have ? [`Together these orders take at most ${goodsOf(r.good, takes)} of your ${goodsOf(r.good, have)}; nobody buys your whole stock today.`] : []),
    ...meals.slice(0, 2).map((o) => `${who(o.merchant)} sells a ${r.food} for ${o.price} coins.`),
    ...dFacts, ...mFacts,
  ];
  const best = bids[0], meal = meals[0];
  const script = best ? `${who(best.merchant)} pays best today, ${best.price} coins a ${r.good}.${meal ? ` Lunch is a ${r.food} at ${meal.price}.` : ""}` : `Nobody is buying ${r.good}s right now, so I'm holding mine.`;
  const topics: Record<string, string> = { price: script, stock: `I've got ${goodsOf(r.good, have)} and ${held.coin ?? 0} coins.` };
  if (dFacts.length) topics.decision = firstPerson(dFacts[0]);
  if (mFacts.length) topics.past = firstPerson(mFacts[0]);
  const ledger: Ledger = { held: { [r.good]: have, [r.food]: held[r.food] ?? 0 }, perDay: { [r.good]: r.perDay }, takes: { [r.good]: takes }, each: { [r.good]: Math.max(0, ...shown.map((o) => Number(o.qty))) } };
  return { facts, script, topics, ledger };
}

/** "Today you raised your ..." -> "Today I raised my ...": the scripted answer reads in the speaker's own voice. */
export function firstPerson(s: string): string {
  return s.replace(/\byou are\b/gi, "I am").replace(/\bYour\b/g, "My").replace(/\byour\b/g, "my").replace(/\bYou\b/g, "I").replace(/\byou\b/g, "I");
}

/** Picks the scripted line for a free-form question by topic (no model): rent, stock, decisions, the past, the player. */
export function scriptFor(question: string, script: string, topics: Readonly<Record<string, string>>): string {
  const q = question.toLowerCase();
  const pick = (k: string): string | null => topics[k] ?? null;
  if (/\b(rent|close|closing|shutter)/.test(q)) return pick("rent") ?? script;
  if (/\b(me|my|i)\b/.test(q) && pick("you")) return pick("you")!; // about the player's own trades with this speaker
  if (/\b(yesterday|before|last|remember|earlier|ago|history)\b/.test(q)) return pick("past") ?? script;
  if (/\b(decid|change|raise|lower|today|plan|choose|choice)/.test(q)) return pick("decision") ?? script;
  if (/\b(stock|left|have|shelf|shelves|how many)\b/.test(q)) return pick("stock") ?? script;
  return script;
}

const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty"];
const TENS: Record<string, number> = { thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100, dozen: 12 };
/** Spelled-out numbers count as numbers ("ten coins" is a claim like "10 coins"). "zero" and "one" are left as words:
 *  "one of my regulars" is ordinary speech, not a price. */
const spelled = (s: string): string => s.replace(/\b[a-z]+\b/gi, (w) => { const k = w.toLowerCase(); const i = WORDS.indexOf(k); return i >= 2 ? String(i) : TENS[k] !== undefined ? String(TENS[k]) : w; });
const numbers = (s: string): string[] => spelled(s).match(/\d+(?:\.\d+)?/g) ?? [];

/** Goods quantities by role, from chain balances and posted orders, so a true number on the wrong thing is caught. */
export interface Ledger {
  /** goods the speaker holds now */
  readonly held: Readonly<Record<string, number>>;
  /** goods the speaker gathers each market day (residents) */
  readonly perDay?: Readonly<Record<string, number>>;
  /** at most this many of a good can be sold into today's shown orders, all together (residents) */
  readonly takes?: Readonly<Record<string, number>>;
  /** the largest quantity one of those orders takes (residents) */
  readonly each?: Readonly<Record<string, number>>;
}

const PER_DAY = /\b(a day|per day|each day|every day|daily|pick|picks|picked|picking|gather|gathered|this morning|each morning|every morning)\b/i;
const HAVE = /\b(i've got|i have|i've|i hold|i'm holding|i am holding|i'm carrying|i am carrying|i carry|i still have|on my shelves|in my basket|my stock|in stock)\b/i;
const BUY = /\b(buys?|buying|bought|takes?|taking|pays?|paying|wants?)\b/i;
const WHOLE = /\b(them|all of them|them all|all my|all of my|every one|everything|the lot|my whole)\b/i;
// "<n> [up to two describing words] <good>"; a price ("6 coins a mango") is not a count of goods
const COUNT = /\b(\d+)\s+((?:(?!coins?\b|c\b|for\b|at\b|a\b|an\b|per\b|each\b)[a-z'-]+\s+){0,2}?)(mango(?:e?s)?|lemons?|lassis?)\b/gi;
const goodWord = (w: string): string => (w.toLowerCase().startsWith("mango") ? "mango" : w.toLowerCase().startsWith("lemon") ? "lemon" : "lassi");

/** Role check for one clause: a count said with "I have" must be what is held, one said with "a day"/"picked" the daily
 *  amount, one a buyer takes no more than the orders take; "they'll buy them" cannot cover more than the orders take. */
function rolesOk(clause: string, ledger: Ledger): boolean {
  for (const m of clause.matchAll(COUNT)) {
    const n = Number(m[1]), good = goodWord(m[3]);
    if (PER_DAY.test(clause)) { if (ledger.perDay?.[good] !== n) return false; }
    else if (HAVE.test(clause)) { if ((ledger.held[good] ?? 0) !== n) return false; }
    else if (ledger.each && BUY.test(clause) && n > (ledger.each[good] ?? 0)) return false;
  }
  if (ledger.takes && BUY.test(clause) && WHOLE.test(clause)) {
    if (Object.entries(ledger.takes).some(([good, t]) => (ledger.held[good] ?? 0) > t)) return false;
  }
  return true;
}

/** True if every number in `line` (digits or words from two upward) is one of the facts' numbers: the model may not
 *  invent a price, stock or sum. With a ledger, every count of goods must also match its role (held, per day, orders). */
export function grounded(line: string, facts: readonly string[], ledger?: Ledger): boolean {
  const known = new Set(facts.flatMap(numbers));
  if (!numbers(line).every((n) => known.has(n))) return false;
  if (!ledger) return true;
  return spelled(line).split(/[.,;:!?]|\band\b|\bbut\b|\bor\b|\bwhile\b/i).every((c) => rolesOk(c, ledger));
}

const OFF_WORLD = /\b(blockchain|crypto|token|wallet|nft|smart contract|language model|as an ai|ai model|chatgpt|openai|llm)\b/i;

/** Plain speakable text: no markdown, emoji, stage directions or quotes around the whole line. */
export function clean(line: string): string {
  return line
    .replace(/\p{Extended_Pictographic}/gu, "")
    .replace(/[*_`#>~]/g, "")
    .replace(/\[[^\]]*\]|\([^)]*(?:smiles|laughs|sighs|nods|winks)[^)]*\)/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
    .trim();
}

export const sentencesOf = (line: string): string[] => (line.match(/[^.!?]+[.!?]+["')\]]*|[^.!?]+$/g) ?? [line]).map((s) => s.trim()).filter(Boolean);

const reply = (source: "ai" | "script", speaker: string, line: string): TalkReply => ({ source, speaker, line, sentences: sentencesOf(line) });

export interface AiEnv { readonly key: string | null; readonly model: string | null }

export interface AskInput {
  readonly ai: AiEnv;
  readonly id: string;
  readonly facts: readonly string[];
  readonly script: string;
  readonly topics?: Readonly<Record<string, string>>;
  readonly question: string;
  readonly history?: readonly Exchange[];
  /** Goods counts by role for the reply check (`grounded`); without it only the numbers themselves are checked. */
  readonly ledger?: Ledger;
  /** Kill switch and daily chat budget (ops.ts); false = the scripted line, no model call. */
  readonly allowed?: () => Promise<boolean>;
  readonly fetchImpl?: typeof fetch;
}

/** One short in-character answer to the player's own question. */
export async function answer(i: AskInput): Promise<TalkReply> {
  const question = i.question.replace(/\s+/g, " ").trim().slice(0, MAX_QUESTION) || "Why is your price what it is today?";
  const fallback = reply("script", i.id, scriptFor(question, i.script, i.topics ?? {}));
  if (!i.ai.key || !i.ai.model) return fallback;
  if (i.allowed && !(await i.allowed().catch(() => false))) return fallback;
  const p = PERSONA[i.id] ?? { name: PERSONALITY[i.id as MerchantId]?.name ?? i.id, voice: "friendly" };
  const system = [
    `You are ${p.name}, in Saltlight Market, a cosy anime city. How you talk: ${p.voice}.`,
    "Answer the customer's question in one to three short spoken sentences, in character, in plain words.",
    "Use only the facts below. Never state a number that is not in them. Keep each number with what it describes: what you hold now, what you gather each day and how many one order takes are different numbers. If the facts do not answer the question, say so in character and talk about what you do know.",
    "Never mention blockchains, wallets, tokens, contracts or AI. No lists, no markdown, no emoji, no stage directions.",
    "Facts:", ...i.facts.map((f) => `- ${f}`),
  ].join("\n");
  const history = (i.history ?? []).slice(-3).flatMap((x) => [{ role: "user", content: x.q }, { role: "assistant", content: x.a }]);
  try {
    const r = await (i.fetchImpl ?? fetch)(AI_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${i.ai.key}`, "content-type": "application/json" },
      body: JSON.stringify({ model: i.ai.model, max_tokens: 140, temperature: 0.6, messages: [{ role: "system", content: system }, ...history, { role: "user", content: question }] }),
      signal: AbortSignal.timeout(AI_TIMEOUT_MS),
    });
    if (!r.ok) return fallback;
    const j = (await r.json()) as { choices?: { message?: { content?: string } }[] };
    const line = clean(j.choices?.[0]?.message?.content ?? "");
    if (!line || line.length > MAX_LINE || OFF_WORLD.test(line) || !grounded(line, i.facts, i.ledger)) return fallback;
    return reply("ai", i.id, line);
  } catch {
    return fallback; // timeout or network: the game never waits on the model
  }
}
