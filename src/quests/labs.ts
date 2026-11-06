// NEAR Labs (Spire) + the two other named merchants on Market Lane, as data.
// Ines's agent spotted why Pema's crates sit at the harbor: T. Vell's standing berth contract gives his
// cargo cold-storage priority. The player decides what to do with that insight; every choice is a
// tracked economy action in src/economy/sim.ts.
import type { EconomyState } from "../economy/state.ts";
import { clockOf } from "../economy/state.ts";
import { quote } from "../economy/pricing.ts";
import { adjustRep, challengeStandingContract, note, playerBuy, sellInsightToTomas, teahouseForwardBuy } from "../economy/sim.ts";
import type { Choice, Conversation } from "./dialogue.ts";

const shipment = (s: EconomyState) => s.shipments.find((x) => x.id === "pema-mangoes")!;
const held = (s: EconomyState) => shipment(s).status === "held";
const INSIGHT_FEE = 12;
const FORWARD_CRATES = 10;

export const engineer: Conversation = {
  npcId: "engineer",
  name: "Ines Varga",
  role: "Protocol engineer · NEAR Labs",
  accent: "#83dcff",
  entry: (s) => {
    if (s.flags.contract || s.flags.labs === "forward") return "after";
    return held(s) ? "intro" : "quiet";
  },
  nodes: {
    intro: {
      speaker: "Ines Varga",
      text: () =>
        "You're the one running errands for the fruit stall? Look at the feed. Our harbor agent reads every berth " +
        "ledger on the Row. Pema's crates aren't held for a fee. They're queued behind T. Vell's cargo.",
      next: "insight",
    },
    insight: {
      speaker: "Ines Varga",
      text: (s) =>
        `Vell holds the standing contract for that berth. His crates get cold storage first, every morning at 06:00. ` +
        `Pema's wait until ${clockOf(shipment(s).autoReleaseAt)}. Nobody broke a rule. The contract just never expires. What do you want to do with it?`,
      choices: [
        {
          label: "File it with the harbor. Contracts like that should be public.",
          detail: () => "Harbor suspends Vell's berth priority · Pema's hold clears next 06:00 · Vell loses his free restock",
          effect: (ctx) => {
            const r = challengeStandingContract(ctx.econ);
            ctx.toast(r.message);
            if (r.ok) {
              adjustRep(ctx.econ, "tomas", -8);
              adjustRep(ctx.econ, "pema", 4);
              ctx.settle("labs-contract-report", { contract: "T.Vell-berth-2", release: clockOf(shipment(ctx.econ).autoReleaseAt) });
            }
          },
          next: "filed",
        },
        {
          label: "Can your agent find Pema a buyer instead?",
          detail: () => `Tea House pre-pays Pema for ${FORWARD_CRATES} crates at cost · she makes rent tonight · crates go to the Tea House on arrival`,
          available: (s) => Number(s.flags.forwardQty ?? 0) === 0,
          effect: (ctx) => {
            const r = teahouseForwardBuy(ctx.econ, FORWARD_CRATES);
            ctx.toast(r.message);
            if (r.ok) {
              ctx.econ.flags.labs = "forward";
              adjustRep(ctx.econ, "pema", 3);
              adjustRep(ctx.econ, "teahouse", 4);
              note(ctx.econ, "NEAR Labs matched the Tea House's mango order to Pema's held crates.");
            }
          },
          next: "forward",
        },
        {
          label: "Vell would pay to keep this quiet. I'll sell it to him.",
          detail: () => `+${INSIGHT_FEE} c from Tomas · Pema keeps waiting · Ines will remember`,
          effect: (ctx) => {
            const r = sellInsightToTomas(ctx.econ, INSIGHT_FEE);
            ctx.toast(r.message);
            if (r.ok) adjustRep(ctx.econ, "tomas", 5);
          },
          next: "sold",
        },
        { label: "Let me think about it.", next: null },
      ],
    },
    filed: {
      speaker: "Ines Varga",
      text: (s) => `Filed. The harbor master already suspended it. Pema's crates move at ${clockOf(shipment(s).autoReleaseAt)}, and Vell is about to have a very loud morning.`,
      next: null,
    },
    forward: {
      speaker: "Ines Varga",
      text: () => "Done. The agent matched the Tea House's morning order to Pema's crates. She gets paid now, they get mangoes when the cart lands. Nobody waits on Vell.",
      next: null,
    },
    sold: {
      speaker: "Ines Varga",
      text: () => "Your call. The feed keeps a record either way. That's rather the point of this building.",
      next: null,
    },
    after: {
      speaker: "Ines Varga",
      text: (s) =>
        s.flags.contract === "sold"
          ? "The agent logged Vell's payment to you. Funny how a ledger remembers."
          : "Feed's quiet now. Come back when the Row does something strange. It always does.",
      next: null,
    },
    quiet: {
      speaker: "Ines Varga",
      text: () => "No holds on the harbor ledger today. Pema's crates landed. The agent's watching rent day instead.",
      next: null,
    },
  },
};

const tomasBuy: readonly Choice[] = [
  {
    label: "Buy a mango",
    detail: (s) => `${quote(s, "tomas", "mango").price} c`,
    available: (s) => s.merchants.tomas.stock.mango > 0,
    effect: (ctx) => ctx.toast(playerBuy(ctx.econ, "tomas", "mango", 1).message),
    next: "shop",
  },
  {
    label: "Buy a lemon",
    detail: (s) => `${quote(s, "tomas", "lemon").price} c`,
    available: (s) => s.merchants.tomas.stock.lemon > 0,
    effect: (ctx) => ctx.toast(playerBuy(ctx.econ, "tomas", "lemon", 1).message),
    next: "shop",
  },
  { label: "Just looking.", next: null },
];

export const tomas: Conversation = {
  npcId: "tomas",
  name: "Tomas Vell",
  role: "Vell's Fine Produce · stall 2",
  accent: "#d9572b",
  entry: (s) => (s.merchants.tomas.status === "closed" ? "closed" : s.flags.contract === "challenged" ? "angry" : "shop"),
  nodes: {
    shop: {
      speaker: "Tomas Vell",
      text: (s) =>
        `Mangoes ${quote(s, "tomas", "mango").price}, lemons ${quote(s, "tomas", "lemon").price}. Fresh off the 06:00 cart. Some of us plan ahead.`,
      choices: tomasBuy,
    },
    angry: {
      speaker: "Tomas Vell",
      text: () => "Someone took a ledger to the harbor master. My berth, suspended. No morning cart. Buy something, or stop smiling.",
      choices: tomasBuy,
    },
    closed: { speaker: "Tomas Vell", text: () => "Closed. Even I have rent days.", next: null },
  },
};

export const teahouse: Conversation = {
  npcId: "teahouse",
  name: "Marta Okoye",
  role: "Saltlight Tea House",
  accent: "#2f8f6b",
  entry: (s) => (s.merchants.teahouse.status === "closed" ? "closed" : "door"),
  nodes: {
    door: {
      speaker: "Marta Okoye",
      text: (s) =>
        `Mango lassi, ${quote(s, "teahouse", "lassi").price} coins for you. I buy my mangoes from whoever is cheapest at seven.` +
        (Number(s.flags.forwardQty ?? 0) > 0 ? " This week I pre-paid Pema for her held crates. Don't tell Tomas." : ""),
      choices: [
        {
          label: "One lassi, please.",
          detail: (s) => `${quote(s, "teahouse", "lassi").price} c`,
          available: (s) => s.merchants.teahouse.stock.lassi > 0,
          effect: (ctx) => ctx.toast(playerBuy(ctx.econ, "teahouse", "lassi", 1).message),
          next: "door",
        },
        { label: "Another time.", next: null },
      ],
    },
    closed: { speaker: "Marta Okoye", text: () => "We're closed tonight. No mangoes, no lassi.", next: null },
  },
};
