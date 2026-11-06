// THE MANGO CRISIS: Pema's conversation and the harbor dispatch ledger, as data.
// Every choice either changes the economy (stock, cash, rent outcome) or reputation, and is saved.
import type { EconomyState } from "../economy/state.ts";
import { quote } from "../economy/pricing.ts";
import { addCoins, adjustRep, note, payReleaseFee, pemaBuysFromTomas, playerBuy } from "../economy/sim.ts";
import { clockOf } from "../economy/state.ts";
import type { Choice, Conversation, DialogueContext } from "./dialogue.ts";
import { engineer, teahouse, tomas } from "./labs.ts";

type Stage = "accepted" | "accepted_hard" | "rival" | "refused" | "rewarded";
const stage = (s: EconomyState): Stage | undefined => s.flags.mango as Stage | undefined;
const shipment = (s: EconomyState) => s.shipments.find((x) => x.id === "pema-mangoes")!;
const reasons = (s: EconomyState, good: "mango" | "lemon") =>
  quote(s, "pema", good).factors.slice(0, 3).map((f) => f.label).join(" · ");

const buyChoices: readonly Choice[] = [
  {
    label: "Buy a mango",
    detail: (s) => `${quote(s, "pema", "mango").price} c  —  ${reasons(s, "mango")}`,
    available: (s) => s.merchants.pema.stock.mango > 0,
    effect: (ctx) => ctx.toast(playerBuy(ctx.econ, "pema", "mango", 1).message),
    next: "shop",
  },
  {
    label: "Buy a lemon",
    detail: (s) => `${quote(s, "pema", "lemon").price} c  —  ${reasons(s, "lemon")}`,
    available: (s) => s.merchants.pema.stock.lemon > 0,
    effect: (ctx) => ctx.toast(playerBuy(ctx.econ, "pema", "lemon", 1).message),
    next: "shop",
  },
  { label: "That's all, Auntie.", next: null },
];

export const pema: Conversation = {
  npcId: "pema",
  name: "Auntie Pema",
  role: "Fruit seller · Saltlight Market",
  accent: "#0091fd",
  entry: (s) => {
    const st = stage(s);
    if (s.merchants.pema.status === "closed") return "closed";
    if (!st) return "intro";
    if ((st === "accepted" || st === "accepted_hard") && shipment(s).status === "delivered") return "thanks";
    if (st === "accepted" || st === "accepted_hard") return "waiting";
    if (st === "rival") return "rival_after";
    if (st === "refused") return "refused_after";
    return "shop";
  },
  nodes: {
    intro: {
      speaker: "Auntie Pema",
      text: (s) =>
        `Three crates. That's all I have left, and rent is due tonight. My mangoes have been sitting at the harbor ` +
        `since dawn and nobody will tell me why. Meanwhile Tomas Vell sells his at ${quote(s, "tomas", "mango", false).price} coins and smiles about it.`,
      next: "ask",
    },
    ask: {
      speaker: "Auntie Pema",
      text: () => "You look like someone who walks fast. Will you go down to the pier for me?",
      choices: [
        {
          label: "I'll get your shipment from the harbor.",
          detail: () => "Quest: The Mango Crisis · reward 20 c · Pema will remember this",
          effect: (ctx) => {
            ctx.econ.flags.mango = "accepted";
            ctx.econ.flags.reward = 20;
            adjustRep(ctx.econ, "pema", 8);
            note(ctx.econ, "Quest started: get Pema's mangoes released at the harbor.");
          },
          next: "accept_kind",
        },
        {
          label: "I'll do it, but twenty coins won't cover my time. Forty.",
          detail: () => "Reward 40 c, paid from Pema's thin purse · reputation cost",
          effect: (ctx) => {
            ctx.econ.flags.mango = "accepted_hard";
            ctx.econ.flags.reward = 40;
            adjustRep(ctx.econ, "pema", -6);
            note(ctx.econ, "Quest started (hard bargain): 40 c for Pema's mangoes.");
          },
          next: "accept_hard",
        },
        {
          label: "Why not just buy from Tomas Vell?",
          detail: (s) => `Pema pays Tomas ~${Math.round(quote(s, "tomas", "mango", false).price * 1.15)} c a crate from her ${Math.round(s.merchants.pema.cash)} c · Tomas gains`,
          effect: (ctx) => {
            ctx.econ.flags.mango = "rival";
            const r = pemaBuysFromTomas(ctx.econ, 10);
            adjustRep(ctx.econ, "pema", -10);
            adjustRep(ctx.econ, "tomas", 6);
            ctx.toast(r.message);
          },
          next: "rival",
        },
        {
          label: "Sorry. Not my problem.",
          detail: () => "Pema is on her own tonight",
          effect: (ctx) => {
            ctx.econ.flags.mango = "refused";
            adjustRep(ctx.econ, "pema", -4);
          },
          next: "refused",
        },
      ],
    },
    accept_kind: {
      speaker: "Auntie Pema",
      text: () => "Pier Road, south of the plaza. Ask at the dispatch board for Pema's Fruit. Hurry, the sun sets at the harbor first.",
      next: null,
    },
    accept_hard: {
      speaker: "Auntie Pema",
      text: () => "Forty. You drive a bargain like Tomas. Fine. Bring the mangoes and the Row will see how a deal gets done.",
      next: null,
    },
    rival: {
      speaker: "Auntie Pema",
      text: (s) =>
        `Buy from Tomas. At his price. With what money? ... There. ${s.merchants.pema.stock.mango} crates, and my purse is lighter than my pride. ` +
        `Tomas will be laughing at the Tea House tonight.`,
      next: null,
    },
    refused: {
      speaker: "Auntie Pema",
      text: () => "Then go. The Row has seen newcomers like you before.",
      next: null,
    },
    waiting: {
      speaker: "Auntie Pema",
      text: (s) => {
        const sh = shipment(s);
        if (sh.status === "transit") return `They're coming? Arriving ${clockOf(sh.arriveAt ?? s.minute)}. I could kiss the harbor master.`;
        return "Any news from the pier? The dispatch board at the end of Pier Road. Please.";
      },
      choices: [{ label: "Let me see what you have.", next: "shop" }, { label: "On my way.", next: null }],
    },
    thanks: {
      speaker: "Auntie Pema",
      text: (s) =>
        `Thirty crates! Look at my table. Prices back down to ${quote(s, "pema", "mango").price} and the Tea House already sent a boy over. Here, as promised.`,
      onEnter: (ctx) => {
        const s = ctx.econ;
        const promised = Number(s.flags.reward ?? 20);
        const paid = Math.min(promised, Math.max(0, Math.floor(s.merchants.pema.cash)));
        s.merchants.pema.cash -= paid;
        addCoins(s, paid, paid < promised ? `Pema paid ${paid} of ${promised} c (all she had)` : "Pema's reward");
        adjustRep(s, "pema", s.flags.mango === "accepted" ? 10 : 3);
        s.flags.mango = "rewarded";
        ctx.toast(paid < promised ? `Pema could only pay ${paid} of ${promised} c` : `+${paid} c from Pema`);
      },
      next: "shop",
    },
    rival_after: {
      speaker: "Auntie Pema",
      text: (s) => `Tomas's mangoes. ${s.merchants.pema.stock.mango} left. Buy something or let me sulk.`,
      choices: buyChoices,
    },
    refused_after: {
      speaker: "Auntie Pema",
      text: () => "Oh. You again. Looking, or buying?",
      choices: buyChoices,
    },
    closed: {
      speaker: "Auntie Pema",
      text: () => "The shutters are down. Couldn't make rent. When the harbor lets my mangoes go, maybe I'll open again.",
      next: null,
    },
    shop: {
      speaker: "Auntie Pema",
      text: (s) => `Mangoes ${quote(s, "pema", "mango").price}, lemons ${quote(s, "pema", "lemon").price}. Prices change with the stock, dear, not my mood.`,
      choices: buyChoices,
    },
  },
};

const releaseChoice: Choice = {
  label: "Pay the cold-storage fee",
  detail: (s) => `-${shipment(s).releaseFee} c · crates leave now, arrive in 90 min`,
  available: (s) => s.player.coins >= shipment(s).releaseFee,
  effect: (ctx: DialogueContext) => {
    const r = payReleaseFee(ctx.econ, "pema-mangoes");
    ctx.toast(r.message);
    if (r.ok) ctx.settle("harbor-release", { shipment: "pema-mangoes", fee: shipment(ctx.econ).releaseFee, crates: 30 });
  },
  next: "released",
};

export const harbor: Conversation = {
  npcId: "harbor",
  name: "Harbor Dispatch",
  role: "Pier 2 · cold storage ledger",
  accent: "#83dcff",
  entry: (s) => (shipment(s).status === "held" ? "held" : shipment(s).status === "transit" ? "transit" : "done"),
  nodes: {
    held: {
      speaker: "Harbor Dispatch",
      text: (s) =>
        `HOLD · 30 crates mango · consignee Pema's Fruit. Reason: cold-storage fee unpaid (${shipment(s).releaseFee} c). ` +
        `Automatic release ${clockOf(shipment(s).autoReleaseAt)}. Standing contract holder for this berth: T. Vell.`,
      choices: [releaseChoice, { label: "Leave it. The harbor will release it eventually.", detail: (s) => `Pema waits until ${clockOf(shipment(s).autoReleaseAt)}`, next: null }],
    },
    released: {
      speaker: "Harbor Dispatch",
      text: () => "RELEASED · fee received · cart dispatched to Saltlight Market.",
      next: null,
    },
    transit: { speaker: "Harbor Dispatch", text: (s) => `IN TRANSIT · arriving ${clockOf(shipment(s).arriveAt ?? s.minute)}.`, next: null },
    done: { speaker: "Harbor Dispatch", text: () => "DELIVERED · no holds on this berth.", next: null },
  },
};

export const CONVERSATIONS: Record<string, Conversation> = { pema, harbor, tomas, teahouse, engineer };
