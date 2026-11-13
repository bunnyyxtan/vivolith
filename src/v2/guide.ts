// The guide: the first mission (Pema's empty stall) taught through play, then ongoing goals. Each step has one
// objective, an optional person to walk to (gold marker in the world, pinned to the screen edge when off-screen),
// and a completion test on the economy state. Progress lives in state.flags.tut (index into STEPS).
import * as THREE from "three";
import type { EconomyState, MerchantId } from "../economy/state";
import { MERCHANT_IDS } from "../economy/state";
import { chainLive, reopenGap, SHARE_PACK } from "../economy/sim";
import { bidFor, profitRun, quote } from "../economy/pricing";
import { el, type Hud } from "./hud";
import { night, type Clock, type Night } from "./story";

export interface Step {
  readonly id: string;
  readonly title: string | ((s: EconomyState) => string);
  readonly detail: (s: EconomyState) => string;
  /** Who to walk to, if anyone. */
  readonly target: MerchantId | null | ((s: EconomyState) => MerchantId);
  readonly done: (s: EconomyState) => boolean;
  /** Shown when the step completes. */
  readonly reward: string;
}

const f = (s: EconomyState, k: string): boolean => s.flags[k] === true;

/** The newcomer's price floor at the tutorial seller (the relayer's newcomerPrice allows a buy down to 4 c once).
 *  Pema's first delivery is paid at her real posted bid: a scripted price above what she resells for would sink her. */
export const NEWCOMER_FLOOR = 4;

/** Who sells the tutorial its mangoes: Tomas, unless the shared market has closed him or emptied his crates. */
export const tutorSeller = (s: EconomyState): MerchantId => {
  const ok = (id: MerchantId): boolean => s.merchants[id].status === "open" && s.merchants[id].stock.mango >= 3;
  return ok("tomas") || !ok("mira") ? "tomas" : "mira";
};
export const titleOf = (st: Step, s: EconomyState): string => (typeof st.title === "function" ? st.title(s) : st.title);

/** The stall the invest lesson points at: Pema, whose shares never sell out (the contract issues more on the same
 *  terms once the 300 floated are gone), so the lesson can always be completed. */
export const investTarget = (_s: EconomyState): MerchantId => "pema";
const ownsShares = (s: EconomyState): boolean => MERCHANT_IDS.some((id) => s.player.shares[id] > 0);

/** What the player can do right now about Pema's rent, from her till, shelf and price (offline and on NEAR alike). */
export function nightAdvice(s: EconomyState): string {
  const p = s.merchants.pema, till = Math.floor(p.cash), short = p.rent - till;
  if (p.status !== "open") return "Her shutters are already down: bring mangoes to reopen her.";
  if (short <= 0) return `Her till holds ${till} c for ${p.rent} c rent at 21:00. Paying for stock comes out of the till, so it can still slip.`;
  const price = quote(s, "pema", "mango").price, n = Math.ceil(short / Math.max(1, price));
  const mangoes = (k: number): string => `${k} ${k === 1 ? "mango" : "mangoes"}`;
  const coming = s.shipments.filter((x) => x.to === "pema" && x.good === "mango" && x.status === "transit").reduce((k, x) => k + x.qty, 0);
  if (coming > 0 && p.stock.mango < n + 3) return `Her harbor crates (${mangoes(coming)}) are on their way. Stock alone won't pay rent: she needs ${short} c by 21:00, from shoppers or from you buying ${mangoes(n)} at ${price} c.`;
  if (p.stock.mango >= n + 3) return `Her shelf has ${mangoes(p.stock.mango)}; what she lacks is coins. Buying ${mangoes(n)} from her at ${price} c puts ${n * price} c in her till. Or trust street shoppers to buy enough before rent at 21:00.`;
  return `Her shelf is nearly bare (${mangoes(p.stock.mango)}), so shoppers have little to buy. Bring her mangoes (free at the Orchard in the morning, cheap at Tomas) and buy from her if you can spare coins.`;
}

export const STEPS: readonly Step[] = [
  {
    id: "find", title: "Find Auntie Pema", target: "pema",
    detail: () => "Her fruit stall is up the avenue, on your left. Follow the gold marker.",
    done: (s) => f(s, "nearPema"), reward: "",
  },
  {
    id: "talk", title: "Talk to Pema", target: "pema",
    detail: () => "Stand at her stall and press F.",
    done: (s) => f(s, "talkedPema"), reward: "",
  },
  {
    id: "buy", title: (s) => `Buy 3 mangoes from ${NAMES[tutorSeller(s)]}`, target: tutorSeller,
    detail: (s) => tutorSeller(s) === "tomas" ? "Tomas has more mangoes than he can sell. His stall is across the square." : "Tomas has none to spare today, but Mira undercuts him anyway. Her stall is up the row.",
    done: (s) => f(s, "boughtTomas"), reward: "The mangoes are in your bag. Press B to look.",
  },
  {
    id: "deliver", title: "Sell your mangoes: Pema needs them", target: "pema",
    detail: (s) => { const b = bidFor(s, "pema", "mango")?.price; return `${b ? `Pema bids ${b} c a mango` : "Pema isn't bidding this minute"} and needs stock to sell before rent. Other stalls post their own bids: the trade panel compares them. Your call.`; },
    done: (s) => f(s, "deliveredPema") || f(s, "soldElsewhere"),
    reward: "",
  },
  {
    id: "haggle", title: (s) => `Haggle with ${NAMES[tutorSeller(s)]}`, target: tutorSeller,
    detail: () => "Buy again, but press Haggle and try a tactic. Watch his patience.",
    done: (s) => f(s, "haggled"), reward: "You can haggle with every merchant now.",
  },
  {
    id: "invest", title: "Become a stall partner", target: investTarget,
    detail: (s) => {
      const t = investTarget(s), { price, per } = SHARE_PACK[t];
      return s.player.coins >= price
        ? `Open the Invest tab at ${NAMES[t]}'s stall and buy a pack of shares (${per} for ${price} c). You earn part of every sale the stall makes from then on.`
        : `A pack of ${NAMES[t]}'s shares costs ${price} c and you have ${s.player.coins} c. Trade a little more: buy from Tomas, sell to Pema or Arin.`;
    },
    done: (s) => ownsShares(s),
    reward: "You're a partner now: part of every sale that stall makes comes to you.",
  },
  {
    // Rent Night is the first day's climax: fast-forward stays locked until the player has seen how it ends.
    id: "night", target: "pema",
    title: (s) => {
      const out = s.flags["night.outcome"];
      if (out) return out === "kept" ? "Pema made rent. Go and see her" : "Pema's stall closed. Go and see her";
      const short = s.merchants.pema.rent - Math.floor(s.merchants.pema.cash);
      return short > 0 ? `Rent night: Pema is ${short} c short` : "Rent night: keep Pema's till above rent";
    },
    detail: (s) => s.flags["night.outcome"] ? "Hear how her night went at her stall." : nightAdvice(s),
    done: (s) => f(s, "night.heard") || s.flags["night.start"] === undefined,
    reward: "",
  },
  {
    id: "week", title: "Fast-forward a week", target: null,
    detail: (s) => chainLive(s)
      ? "Press T for a forecast: a week of the city in a minute, run from today's real market. See what your shares could earn."
      : "Press T. Stalls pay rent every second evening. Watch the city trade and see what your shares earn.",
    done: (s) => f(s, "weekSeen"), reward: "",
  },
];

/** Goals after the first mission: the first unfinished one is the current objective. */
/** Where a goal sends the player: a merchant or the Mango Orchard (gold marker in the world and on the map). */
export type Target = MerchantId | "orchard";
export const GOALS: readonly { id: string; title: string; detail: string; target?: Target; done: (s: EconomyState) => boolean }[] = [
  { id: "orchard", title: "Pick free mangoes at the Orchard", detail: "Follow the gold marker to the Mango Orchard sign. Press F there between 06:00 and 11:00 for 3 free mangoes, then sell them where the price is best.", target: "orchard", done: (s) => f(s, "pickedOrchard") },
  { id: "arin", title: "Supply Arin's tea house", detail: "Arin buys mangoes for his lassi. Buy from Tomas or Mira and sell to him.", done: (s) => f(s, "soldArin") },
  { id: "two", title: "Own shares in two stalls", detail: "Every partner earns from that stall's daily sales.", done: (s) => MERCHANT_IDS.filter((id) => s.player.shares[id] > 0).length >= 2 },
  { id: "hundred", title: "Reach 100 coins", detail: "Buy where goods are cheap, sell where they are missing.", done: (s) => s.player.coins >= 100 },
  { id: "open", title: "Keep all four stalls open for a week", detail: "Merchants who miss rent close. Deliveries and shares keep them going.", done: (s) => f(s, "allOpenWeek") },
];

export const stepIndex = (s: EconomyState): number => Number(s.flags.tut ?? 0);
export const inTutorial = (s: EconomyState): boolean => stepIndex(s) < STEPS.length;
/** Feature gates: things a new player meets one at a time. */
export const unlocked = (s: EconomyState, what: "haggle" | "invest" | "week" | "rent"): boolean => {
  const i = stepIndex(s);
  return what === "haggle" ? i >= 4 : what === "invest" ? i >= 5 : what === "week" ? i >= 7 : i >= 6;
};

/** The standing objective once every goal is done: carry mangoes from the cheap stall to the stall that pays most. */
function opportunity(s: EconomyState): Objective | null {
  if (s.player.inventory.mango === 0 && s.flags.orchardReady === true) return { title: "The Orchard is picking", target: "orchard", label: "Opportunity",
    detail: "Today's share of mangoes is waiting in the crate by the Orchard sign, free until 11:00. Sell them to whoever bids best." };
  const run = profitRun(s);
  if (!run) return null;
  const held = s.player.inventory.mango, gain = run.bid - run.ask;
  if (held > 0) {
    const sell = (() => { let best: { id: MerchantId; bid: number } | null = null; for (const id of MERCHANT_IDS) { const b = s.merchants[id].status === "open" ? bidFor(s, id, "mango") : null; if (b && (!best || b.price > best.bid)) best = { id, bid: b.price }; } return best; })();
    if (sell) return { title: `Sell your ${held} ${held === 1 ? "mango" : "mangoes"} to ${NAMES[sell.id]}`, target: sell.id, label: "Opportunity",
      detail: `${NAMES[sell.id]} pays ${sell.bid} c each right now. Press E at the stall and sell: that is ${held * sell.bid} c.` };
  }
  return { title: `Profit run: ${NAMES[run.buy]} to ${NAMES[run.sell]}`, target: run.buy, label: "Opportunity",
    detail: `${NAMES[run.buy]} sells mangoes at ${run.ask} c and ${NAMES[run.sell]} pays ${run.bid} c: about ${gain} c per mango. Buy what you can carry (you have ${s.player.coins} c), then walk them over.` };
}

export interface Objective {
  title: string; detail: string; target: Target | null; label: string;
  /** Live economic context (Pema's till against her rent, from story.ts): shown as its own panel, never as mission copy. */
  stake?: Night;
  /** Step i of n, for the first-day progress bar. */
  progress?: readonly [number, number];
}
const live = (n: Night): Night | undefined => (n.phase === "waiting" || n.phase === "charging" ? n : undefined);

export interface Guide {
  /** Re-check completion; returns the reward line of a step that just completed (or null). */
  update(s: EconomyState): string | null;
  /** Objective tracker + world marker, every frame. */
  draw(s: EconomyState, camera: THREE.Camera, targetPos: (id: Target) => THREE.Vector3 | null, player: THREE.Vector3): void;
  current(s: EconomyState): Objective | null;
}

const NAMES: Record<MerchantId, string> = { pema: "Pema", tomas: "Tomas", mira: "Mira", arin: "Arin" };

/** Pema's night (story.ts) as an objective: its stake while it runs, then "go and hear her" once it has a result. */
function nightObjective(s: EconomyState, c: Clock): Objective | null {
  const n = night(s, c);
  if (n.phase === "off") return null;
  if (n.phase === "kept" || n.phase === "closed") {
    if (f(s, "night.heard")) return null;
    return { title: n.phase === "kept" ? "Pema made rent. Go and see her" : "Pema's stall closed. Go and see her", target: "pema", label: "The night Pema almost closed",
      detail: (n.phase === "kept" ? (n.connected ? "Her rent was charged on NEAR and her till covered it." : "Her till covered the rent.") : (n.connected ? "NEAR charged her rent and her till came up short." : "Her till came up short at 21:00."))
        + (n.phase === "kept" && s.merchants.pema.status !== "open" ? " A later rent has closed her since." : "") };
  }
  const short = n.rent - n.till;
  return {
    title: short > 0 ? `Keep Pema open: ${short} c short of rent` : "Keep Pema open through rent", target: "pema", label: "The night Pema almost closed", stake: live(n),
    detail: short > 0
      ? `${nightAdvice(s)} Nothing is decided until the rent is charged.`
      : "Her till covers the rent today, if nothing drains it first. Nothing is decided until the rent is charged.",
  };
}

/** The mission card: section and step, title, one line of copy, then (when there is one) the live rent panel. */
const TONE: Record<string, string> = { Urgent: "urgent", Opportunity: "chance" };
function renderCardInto(card: HTMLElement, c: Objective): void {
  card.innerHTML = "";
  card.className = `hud hud-obj tone-${TONE[c.label] ?? "main"}`;
  const head = el("div", "oh");
  head.append(el("span", "sec", c.label));
  if (c.progress) head.append(el("span", "step", `${c.progress[0]} / ${c.progress[1]}`));
  card.append(head);
  if (c.progress) { const bar = el("div", "prog"), fill = el("i"); fill.style.width = `${(c.progress[0] / c.progress[1]) * 100}%`; bar.append(fill); card.append(bar); }
  card.append(el("div", "title", c.title), el("p", "desc", c.detail));
  const n = c.stake;
  if (!n) return;
  const short = n.rent - n.till;
  const panel = el("div", `stake${short > 0 ? " short" : ""}`);
  const top = el("div", "sh");
  top.append(el("span", "k", "Live · Pema's rent"), el("span", "when", `${n.connected ? "NEAR charges it" : "Charged"} ${n.when}`));
  const meter = el("div", "meter"), fill = el("i");
  fill.style.width = `${Math.max(2, Math.min(100, (n.till / Math.max(1, n.rent)) * 100))}%`;
  meter.append(fill);
  const nums = el("div", "nums");
  nums.append(el("b", "", `${n.till} c`), el("span", "", ` in her till · rent ${n.rent} c`), el("em", "", short > 0 ? `${short} c short` : "covered"));
  panel.append(top, meter, nums);
  card.append(panel);
}

export function createGuide(hud: Hud, clock: () => Clock): Guide {
  const renderCard = (c: Objective): void => renderCardInto(hud.obj, c);
  const v = new THREE.Vector3();
  let lastKey = "", lastMark = "";
  const current: Guide["current"] = (s) => {
    const i = stepIndex(s);
    if (i < STEPS.length) {
      const st = STEPS[i];
      const target = typeof st.target === "function" ? st.target(s) : st.target;
      return { title: titleOf(st, s), detail: st.detail(s), target, label: "First day", progress: [i + 1, STEPS.length], stake: live(night(s, clock())) };
    }
    const story = nightObjective(s, clock());
    if (story && (story.stake === undefined || s.merchants.pema.status === "open")) return story;
    // A closed stall comes first: it is the city's most urgent problem and the player can fix it.
    const shut = MERCHANT_IDS.find((id) => s.merchants[id].status !== "open");
    if (shut) {
      const m = s.merchants[shut], gap = reopenGap(s, shut);
      return {
        title: `Help ${NAMES[shut]} reopen`, target: shut, label: "Urgent",
        detail: `${m.shop} missed rent and closed. Bring ${gap} more ${gap === 1 ? "mango" : "mangoes"} to reopen it: it pays for every one${chainLive(s) ? " (the Market Guild lent it the coins)" : ""}.`
          + (m.cash < m.baseCost.mango ? ` ${NAMES[shut]}'s till is empty right now: the Market Guild lends it coins within a minute or two.` : ""),
      };
    }
    const g = GOALS.find((x) => !x.done(s));
    return g ? { title: g.title, detail: g.detail, target: g.target ?? null, label: "Goal" } : opportunity(s);
  };
  return {
    current,
    update(s) {
      let reward: string | null = null;
      while (stepIndex(s) < STEPS.length && STEPS[stepIndex(s)].done(s)) {
        reward = STEPS[stepIndex(s)].reward || reward;
        s.flags.tut = stepIndex(s) + 1;
        hud.obj.classList.remove("done");
        void hud.obj.offsetWidth;
        hud.obj.classList.add("done");
      }
      return reward;
    },
    draw(s, camera, targetPos, player) {
      const c = current(s);
      if (!c) { hud.obj.style.display = "none"; hud.mark.style.display = "none"; return; }
      const key = `${c.label}|${c.title}|${c.detail}|${c.progress?.join("/") ?? ""}|${c.stake ? `${c.stake.till}/${c.stake.rent}/${c.stake.when}` : ""}`;
      if (key !== lastKey) { lastKey = key; renderCard(c); }
      hud.obj.style.display = "block";
      const p = c.target ? targetPos(c.target) : null;
      if (!p) { hud.mark.style.display = "none"; return; }
      const dist = Math.hypot(p.x - player.x, p.z - player.z);
      v.copy(p).setY(p.y + 2.6).project(camera);
      const behind = v.z > 1;
      let x = ((v.x + 1) / 2) * innerWidth, y = ((1 - v.y) / 2) * innerHeight;
      if (behind) { x = innerWidth - x; y = innerHeight - 140; }
      const m = 50;
      const off = behind || x < m || x > innerWidth - m || y < 120 || y > innerHeight - m;
      x = Math.min(innerWidth - m, Math.max(m, x));
      y = Math.min(innerHeight - 140, Math.max(130, y));
      hud.mark.style.left = `${x}px`;
      hud.mark.style.top = `${y}px`;
      hud.mark.style.display = dist < 3.2 ? "none" : "block";
      const label = off ? `${(c.target === "orchard" ? "Orchard" : NAMES[c.target!])} · ${Math.round(dist)} m` : `${Math.round(dist)} m`;
      if (label !== lastMark) { lastMark = label; hud.mark.innerHTML = ""; hud.mark.append(el("span", "", label)); }
    },
  };
}
