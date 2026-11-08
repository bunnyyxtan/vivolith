// The guide: the first mission (Pema's empty stall) taught through play, then ongoing goals. Each step has one
// objective, an optional person to walk to (gold marker in the world, pinned to the screen edge when off-screen),
// and a completion test on the economy state. Progress lives in state.flags.tut (index into STEPS).
import * as THREE from "three";
import type { EconomyState, MerchantId } from "../economy/state";
import { MERCHANT_IDS } from "../economy/state";
import { el, type Hud } from "./hud";

export interface Step {
  readonly id: string;
  readonly title: string;
  readonly detail: (s: EconomyState) => string;
  /** Who to walk to, if anyone. */
  readonly target: MerchantId | null;
  readonly done: (s: EconomyState) => boolean;
  /** Shown when the step completes. */
  readonly reward: string;
}

const f = (s: EconomyState, k: string): boolean => s.flags[k] === true;

/** Price Pema pays for the first delivery: she is desperate and generous (the relayer caps deals server-side). */
export const DELIVERY_PRICE = 6;
export const SHARE_COST = 20;

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
    id: "buy", title: "Buy 3 mangoes from Tomas", target: "tomas",
    detail: () => "Tomas has more mangoes than he can sell. His stall is across the square.",
    done: (s) => f(s, "boughtTomas"), reward: "The mangoes are in your bag. Press B to look.",
  },
  {
    id: "deliver", title: "Bring the mangoes to Pema", target: "pema",
    detail: () => `She pays ${DELIVERY_PRICE} c a mango. Buy where it is cheap, sell where it is needed: that is how you earn here.`,
    done: (s) => f(s, "deliveredPema"), reward: "Pema's shelves are full again.",
  },
  {
    id: "haggle", title: "Haggle with Tomas", target: "tomas",
    detail: () => "Buy again, but press Haggle and try a tactic. Watch his patience.",
    done: (s) => f(s, "haggled"), reward: "You can haggle with every merchant now.",
  },
  {
    id: "invest", title: "Become Pema's partner", target: "pema",
    detail: (s) => s.player.coins >= SHARE_COST
      ? `Open the Invest tab at her stall: 4 of her 20 shares cost ${SHARE_COST} c. You earn part of her sales every day.`
      : `Shares cost ${SHARE_COST} c and you have ${s.player.coins} c. Trade a little more: buy from Tomas, sell to Pema or Arin.`,
    done: (s) => s.player.shares.pema >= 4, reward: "You own 20% of Pema's Fruit, and her stall is upgraded.",
  },
  {
    id: "week", title: "Fast-forward a week", target: null,
    detail: () => "Press T. Stalls pay rent every second evening. Watch the city trade and see what your shares earn.",
    done: (s) => f(s, "weekSeen"), reward: "",
  },
];

/** Goals after the first mission: the first unfinished one is the current objective. */
export const GOALS: readonly { id: string; title: string; detail: string; done: (s: EconomyState) => boolean }[] = [
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

export interface Objective { title: string; detail: string; target: MerchantId | null; label: string }

export interface Guide {
  /** Re-check completion; returns the reward line of a step that just completed (or null). */
  update(s: EconomyState): string | null;
  /** Objective tracker + world marker, every frame. */
  draw(s: EconomyState, camera: THREE.Camera, targetPos: (id: MerchantId) => THREE.Vector3 | null, player: THREE.Vector3): void;
  current(s: EconomyState): Objective | null;
}

const NAMES: Record<MerchantId, string> = { pema: "Pema", tomas: "Tomas", mira: "Mira", arin: "Arin" };

export function createGuide(hud: Hud): Guide {
  const v = new THREE.Vector3();
  let lastKey = "", lastMark = "";
  const current: Guide["current"] = (s) => {
    const i = stepIndex(s);
    if (i < STEPS.length) {
      const st = STEPS[i];
      return { title: st.title, detail: st.detail(s), target: st.target, label: `First day · ${i + 1} of ${STEPS.length}` };
    }
    const g = GOALS.find((x) => !x.done(s));
    return g ? { title: g.title, detail: g.detail, target: null, label: "Goal" } : null;
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
      const key = `${c.label}|${c.title}|${c.detail}`;
      if (key !== lastKey) {
        lastKey = key;
        hud.obj.innerHTML = "";
        const lab = el("div", "lab");
        lab.append(document.createTextNode("Objective"), el("i", "", c.label));
        hud.obj.append(lab, el("b", "", c.title), el("p", "", c.detail));
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
      const label = off ? `${NAMES[c.target!]} · ${Math.round(dist)} m` : `${Math.round(dist)} m`;
      if (label !== lastMark) { lastMark = label; hud.mark.innerHTML = ""; hud.mark.append(el("span", "", label)); }
    },
  };
}
