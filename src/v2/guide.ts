// The guide: the first mission (Pema's empty stall) taught through play, then ongoing goals. Each step has one
// objective, an optional person to walk to (gold marker in the world, pinned to the screen edge when off-screen),
// and a completion test on the economy state. Progress lives in state.flags.tut (index into STEPS).
import * as THREE from "three";
import type { EconomyState, MerchantId } from "../economy/state";
import { MERCHANT_IDS } from "../economy/state";
import { chainLive, reopenGap, SHARE_PACK } from "../economy/sim";
import { bidFor, profitRun } from "../economy/pricing";
import { el, type Hud } from "./hud";
import { night, stakeLine, type Clock } from "./story";

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

/** Price Pema pays for the first delivery: she is desperate and generous (the relayer caps deals server-side). */
export const DELIVERY_PRICE = 6;

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
    detail: () => `Pema pays ${DELIVERY_PRICE} c a mango and needs stock to sell before rent. Other stalls post their own bids: the trade panel compares them. Your call.`,
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
  return what === "haggle" ? i >= 4 : what === "invest" ? i >= 5 : i >= 6;
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

export interface Objective { title: string; detail: string; target: Target | null; label: string; stake?: string }

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
      detail: n.phase === "kept" ? (n.connected ? "Her rent was charged on NEAR and her till covered it." : "Her till covered the rent.") : (n.connected ? "NEAR charged her rent and her till came up short." : "Her till came up short at 21:00.") };
  }
  const short = n.rent - n.till;
  return {
    title: short > 0 ? `Keep Pema open: ${short} c short of rent` : "Keep Pema open through rent", target: "pema", label: "The night Pema almost closed", stake: stakeLine(n),
    detail: short > 0
      ? "Coins reach her till when her mangoes sell: stock on her shelves for street shoppers (the Orchard gives free mangoes each morning), customers buying from her, partners buying share packs. Nothing is decided until the rent is charged."
      : "Her till covers the rent today, if nothing drains it first. Nothing is decided until the rent is charged.",
  };
}

export function createGuide(hud: Hud, clock: () => Clock): Guide {
  const v = new THREE.Vector3();
  let lastKey = "", lastMark = "";
  const current: Guide["current"] = (s) => {
    const i = stepIndex(s);
    if (i < STEPS.length) {
      const st = STEPS[i];
      const target = typeof st.target === "function" ? st.target(s) : st.target;
      return { title: titleOf(st, s), detail: st.detail(s), target, label: `First day · ${i + 1} of ${STEPS.length}`, stake: stakeLine(night(s, clock())) || undefined };
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
      const key = `${c.label}|${c.title}|${c.detail}|${c.stake ?? ""}`;
      if (key !== lastKey) {
        lastKey = key;
        hud.obj.innerHTML = "";
        const lab = el("div", "lab");
        lab.append(document.createTextNode("Objective"), el("i", "", c.label));
        hud.obj.append(lab, el("b", "", c.title), el("p", "", c.detail));
        if (c.stake) hud.obj.append(el("p", "stake", c.stake));
      }
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
