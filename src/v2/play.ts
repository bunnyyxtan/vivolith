// v2 gameplay: the first mission and goals (guide.ts), trading at stalls, conversations, the market clock, rent
// and weekly reports, investing, saves, and the NEAR record of every value move.
// Keys: F interact · 1 confirm · Esc close · B bag · J goals · N NEAR · H help · T fast-forward (once unlocked).
import * as THREE from "three";
import type { Game } from "./game";
import { createMarket, type Market, type Npc } from "./market";
import { createHud, el, type Hud } from "./hud";
import { createGuide, DELIVERY_PRICE, GOALS, STEPS, stepIndex, unlocked } from "./guide";
import { loadGame, saveGame, clearSave } from "../economy/save";
import { advance, invest, payReleaseFee, SHARE_PRICE, UPGRADE_AT } from "../economy/sim";
import { bidFor, quote, lassiPrice, stallPull, SHARES_PER_STALL, type Quote } from "../economy/pricing";
import { clockOf, dayOf, MERCHANT_IDS, MINUTES_PER_DAY, type EconomyState, type Good, type MerchantId, type Receipt } from "../economy/state";
import { applyTactic, closeDeal, dealTotal, dealUnit, lockKey, openHaggle, thoughts, tickPatience, modeFor, PERSONALITY, TACTICS, type HaggleSession, type Tactic } from "../economy/haggle";
import { CONVERSATIONS } from "../quests/mango";
import type { Conversation, DialogueContext } from "../quests/dialogue";
import {
  EXPLORER_ACCOUNT, EXPLORER_TX, balances, buyPosted, connectGuest, haggleDeal, marketTick, merchantAccount, playerId, playerLabel, receipts as chainReceipts,
  settleDay, socialAvailable, finishSocialRedirect, signInSocial, signOutSocial, type TxOutcome,
} from "../near/chain";

const GAME_MIN_PER_SEC = 2.4; // 09:00 -> 21:00 in five real minutes
const TUTORIAL_CLOCK = 0.25; // the first mission is not rushed by the clock
const FF_MIN_PER_SEC = (7 * MINUTES_PER_DAY) / 60; // a week in a minute
const FF_MAX_DAYS = 7;
const RENT_MINUTE = 21 * 60;
const RESULT_HOLD = 2.6; // seconds the deal result stays on the panel
const TRADERS: readonly MerchantId[] = MERCHANT_IDS;
const SHARE_LOT = 4;
const AUTOSAVE_SEC = 10;
const TICK_EVERY_SEC = 60;
/** Index of "Haggle with Tomas" in guide.ts STEPS. */
const HAGGLE_STEP = STEPS.findIndex((s) => s.id === "haggle");
/** Plain-language reason for a trade the chain refused (raw message stays in the notebook's receipts). */
const refusal = (msg = ""): string =>
  /not enough coin/i.test(msg) ? "They couldn't pay that much right now."
    : /not enough|sold out|only \d+ on offer/i.test(msg) ? "They don't have that many left."
    : /not buying/i.test(msg) ? "They aren't buying that today."
    : /slow down|429/i.test(msg) ? "Too many trades at once. Wait a moment."
    : "The market couldn't confirm that trade.";
/** Flags a trade can set; undone together with the trade when the chain refuses it. */
const PROGRESS_FLAGS = ["tut", "boughtTomas", "tutCost", "deliveredPema", "haggled", "soldArin"] as const;
const MAX_QTY = 10;

const TACTIC_LABEL: Record<"buy" | "sell", Record<Tactic, [string, string]>> = {
  buy: { fair: ["Deal", "pay this price"], lowball: ["Lowball", "offer much less"], flatter: ["Flatter", "kind words, small discount"], rival: ["Mention a rival", "works if a rival is cheaper"], bundle: ["Buy double", "more for less each"] },
  sell: { fair: ["Deal", "take this price"], lowball: ["Ask more", "push the price up"], flatter: ["Flatter", "kind words, small bonus"], rival: ["Mention a rival", "works if a rival pays more"], bundle: ["Sell double", "more at a better rate"] },
};

/** Who each merchant is, in one line, and how they greet you. */
const WHO: Record<MerchantId, { role: string; color: string; hello: string; thanks: string }> = {
  pema: { role: "Fruit seller · fair prices, loyal to regulars", color: "#f39a2c", hello: "Fresh mangoes, when the harbor lets me have them.", thanks: "Thank you, dear. Come back soon." },
  tomas: { role: "Fruit seller · charges what he can", color: "#5f7280", hello: "Mangoes! More than this street can eat.", thanks: "Pleasure. Bring more coin next time." },
  mira: { role: "Trader · buys surplus, sells for less", color: "#9b7fe0", hello: "Whatever Tomas charges, I'll do a coin cheaper.", thanks: "Good trade. Tell your friends." },
  arin: { role: "Tea house · buys mangoes for his lassi", color: "#2f9a85", hello: "Lassi's fresh. And I always need mangoes.", thanks: "That's the afternoon's lassi sorted." },
};

interface Snapshot {
  readonly minute: number;
  readonly coins: number;
  readonly divs: number;
  readonly cash: Record<MerchantId, number>;
  readonly price: Record<MerchantId, number>;
  readonly open: Record<MerchantId, boolean>;
  readonly receipts: number;
  readonly log: number;
}

const priceOf = (s: EconomyState, id: MerchantId): Quote => (id === "arin" ? lassiPrice(s) : quote(s, id, "mango"));
const per = <T,>(f: (id: MerchantId) => T): Record<MerchantId, T> => Object.fromEntries(MERCHANT_IDS.map((id) => [id, f(id)])) as Record<MerchantId, T>;
const divsOf = (s: EconomyState): number => MERCHANT_IDS.reduce((n, id) => n + Number(s.flags[`div.${id}`] ?? 0), 0);
const snap = (s: EconomyState): Snapshot => ({
  minute: s.minute, coins: s.player.coins, receipts: s.receipts.length, divs: divsOf(s), log: s.log.length,
  cash: per((id) => s.merchants[id].cash),
  price: per((id) => priceOf(s, id).price),
  open: per((id) => s.merchants[id].status === "open"),
});
const stripPct = (label: string): string => label.replace(/\s*\([^)]*\)\s*$/, "");
const pctOf = (label: string): string => /\(([^)]*)\)\s*$/.exec(label)?.[1] ?? "";
const nextRent = (minute: number): number => {
  const day = Math.floor(minute / MINUTES_PER_DAY) * MINUTES_PER_DAY;
  return minute < day + RENT_MINUTE ? day + RENT_MINUTE : day + MINUTES_PER_DAY + RENT_MINUTE;
};
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
const goodName = (g: Good, n: number): string => (g === "mango" ? plural(n, "mango", "mangoes") : g === "lemon" ? plural(n, "lemon", "lemons") : plural(n, "lassi", "lassis"));

type Tab = "buy" | "sell" | "invest";
type Mode =
  | { kind: "walk" }
  | { kind: "trade"; npc: Npc; id: MerchantId; tab: Tab; qty: number; say: string; tone: "" | "good" | "bad"; why: boolean; h: HaggleSession | null; done: number }
  | { kind: "talk"; npc: Npc; convo: Conversation; node: string }
  | { kind: "card" };

export interface Play {
  readonly state: EconomyState;
  readonly market: Market;
  readonly hud: Hud;
  interact(): void;
  tactic(t: Tactic): void;
  fastForward(on?: boolean): void;
  reset(): void;
  readonly mode: string;
  /** True on a restored save (the menu offers Continue). */
  readonly restored: boolean;
  /** While paused (main menu) the market clock and prompts stop; townsfolk keep living. */
  paused: boolean;
  /** Leaves the menu: Kavi starts at the south gate (first time) or where he was. */
  enterWorld(): void;
  signIn(): Promise<void>;
  signOut(): Promise<void>;
  account(): { id: string | null; label: string | null; canSignIn: boolean };
}

/** Pema's first conversation: the opening of the first mission. */
const PEMA_INTRO: Conversation = {
  npcId: "pema", name: "Auntie Pema", role: "Fruit seller", accent: "#f39a2c",
  entry: () => "hello",
  nodes: {
    hello: {
      speaker: "Auntie Pema",
      text: () => "Oh, a new face! I'm Pema. Don't look at my shelves, dear: three mangoes left, and rent is due tonight.",
      next: "why",
    },
    why: {
      speaker: "Auntie Pema",
      text: () => "My crates are stuck at the harbor. Tomas, across the square, sits on a whole pile of mangoes, but he won't sell a single one to me.",
      choices: [
        { label: "I'll buy some from Tomas and bring them to you.", next: "deal", effect: (ctx) => { ctx.econ.flags.talkedPema = true; } },
      ],
    },
    deal: {
      speaker: "Auntie Pema",
      text: () => `You would? Bless you. I'll pay ${DELIVERY_PRICE} coins a mango, more than Tomas charges you. Three would get me through today.`,
      next: null,
    },
  },
};

export async function createPlay(game: Game): Promise<Play> {
  const { state, restored } = loadGame();
  const market = await createMarket(game.look.scene, game.colliders);
  const hud = createHud();
  const guide = createGuide(hud);
  market.bind(game.player.body, game.rig.camera);
  game.player.floor = market.floor;
  const enterTown = (): void => {
    if (!market.townSpawn) return; // start at the south gate and walk up Market Avenue toward the Spire
    // 1.6 m east of the gate centre: town.glb has a wire pole at x=0 on the straight line north (z=85.2)
    game.player.setSpawn(market.townSpawn.clone().add(new THREE.Vector3(1.6, 1, 0)), Math.PI);
    game.rig.yaw = Math.PI;
    game.rig.pitch = 0.26;
    game.rig.dist = 5.2;
    game.rig.snap(game.player.focus, game.colliders);
  };
  const { rig, player, input } = game;
  let mode: Mode = { kind: "walk" };
  let mark = snap(state);
  let ff: { from: Snapshot; until: number } | null = null;
  let lastHour = Math.floor(state.minute / 60);
  let playTime = 0;

  const mouse = { x: -1, y: -1 };
  window.addEventListener("mousemove", (e) => { mouse.x = e.clientX; mouse.y = e.clientY; });
  let entered = false;
  /** Saves the market and, once the player is in the world, where Kavi stands and faces. */
  const save = (): void => {
    if (entered) {
      const b = player.body; // the physics body is authoritative; the visual root lags a frame behind it
      Object.assign(state.flags, { px: Math.round(b.x * 100) / 100, py: Math.round(b.y * 100) / 100, pz: Math.round(b.z * 100) / 100, ph: Math.round(player.heading * 1000) / 1000 });
    }
    saveGame(state);
  };
  let autosaveIn = AUTOSAVE_SEC;
  const saveNow = (): void => { if (entered) save(); };
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") saveNow(); });
  window.addEventListener("pagehide", saveNow);

  // ---------------------------------------------------------------- world readouts ----
  const drawBoards = (): void => {
    for (const id of TRADERS) market.setStall(id, { stock: id === "arin" ? state.merchants[id].stock.lassi : state.merchants[id].stock.mango, open: state.merchants[id].status === "open", upgraded: state.player.shares[id] >= UPGRADE_AT, pull: stallPull(state, id) });
    for (const n of market.npcs) {
      if (!n.board) continue;
      if (n.id === "harbor") {
        const s = state.shipments.find((x) => x.id === "pema-mangoes");
        n.board.draw({ title: "Pier 2 ledger", price: s?.status === "held" ? "HOLD" : s?.status === "transit" ? "CART" : "CLEAR", sub: "Pema's 30 crates", closed: false });
        continue;
      }
      const id = n.id as MerchantId;
      const m = state.merchants[id];
      const b = bidFor(state, id, "mango");
      n.board.draw({
        title: id === "arin" ? "Lassi" : `${m.name.split(" ")[id === "pema" ? 1 : 0]}'s mangoes`,
        price: `${priceOf(state, id).price} c`,
        sub: b ? `We buy mangoes · ${b.price} c` : id === "arin" ? `${m.stock.lassi} glasses` : `${m.stock.mango} in stock`,
        closed: m.status !== "open",
      });
    }
  };

  // ---------------------------------------------------------------- wallet + NEAR status ----
  let walletKey = "";
  let nearTimer = 0;
  const nearLine = el("div", "hud-near");
  const renderWallet = (): void => {
    const p = state.player;
    const showClock = unlocked(state, "rent");
    const day = dayOf(state.minute), rentDay = (day - 1) % 2 === 0;
    const clock = clockOf(state.minute).replace(/^Day (\d+) /, "Day $1 · ");
    const shares = MERCHANT_IDS.reduce((n, id) => n + p.shares[id], 0);
    const key = `${p.coins}|${p.inventory.mango}|${p.inventory.lemon}|${p.inventory.lassi}|${shares}|${showClock ? clock : ""}|${ff ? 1 : 0}`;
    if (key === walletKey) return;
    const prev = walletKey.split("|");
    walletKey = key;
    hud.wallet.innerHTML = "";
    const row = el("div", "row");
    const pill = (cls: string, ico: string, text: string, title: string, bumped: boolean, onClick: () => void): void => {
      const b = el("button", `hud-pill ${cls}${bumped ? " bump" : ""}`);
      b.title = title;
      b.append(el("i", `ico ${ico}`), document.createTextNode(text));
      b.onclick = onClick;
      row.append(b);
    };
    pill("coinpill", "coin", `${p.coins}`, "Coins", prev[0] !== String(p.coins) && prev.length > 1, () => openNotebook("bag"));
    pill("", "mango", `${p.inventory.mango}`, "Mangoes in your bag (B)", prev[1] !== String(p.inventory.mango) && prev.length > 1, () => openNotebook("bag"));
    if (p.inventory.lassi > 0) pill("", "lassi", `${p.inventory.lassi}`, "Lassi in your bag", false, () => openNotebook("bag"));
    if (shares > 0) pill("", "share", `${shares}`, "Stall shares you own", prev[4] !== String(shares) && prev.length > 1, () => openNotebook("bag"));
    hud.wallet.append(row);
    if (showClock) {
      const c = el("div", "hud-clock");
      c.append(document.createTextNode(ff ? `${clock} · fast-forward (T to stop)` : clock));
      if (!ff && rentDay && state.minute % MINUTES_PER_DAY < RENT_MINUTE) { c.append(document.createTextNode(" · ")); c.append(el("em", "", "rent at 21:00")); }
      hud.wallet.append(c);
    }
    hud.wallet.append(nearLine);
  };
  /** A quiet one-line note under the wallet; never a stack of transaction cards. */
  const nearNote = (html: (n: HTMLElement) => void, bad = false): void => {
    nearLine.innerHTML = "";
    html(nearLine);
    nearLine.className = `hud-near on${bad ? " bad" : ""}`;
    clearTimeout(nearTimer);
    nearTimer = window.setTimeout(() => { nearLine.className = "hud-near"; }, 5000);
  };

  /** Records a value move: pending until the chain answers. A refused move is undone in the game too. */
  const record = (kind: string, summary: string, tx: Promise<TxOutcome>, undo: () => void): void => {
    const r: Receipt = { id: `${kind}-${state.minute}-${state.receipts.length}`, kind, minute: state.minute, summary, status: "pending" };
    state.receipts.push(r);
    nearNote((n) => n.append(document.createTextNode("Saving to NEAR…")));
    void tx.then((o) => {
      Object.assign(r, { status: o.status, txHash: o.txHash, message: o.message, accountId: playerId() ?? undefined });
      if (o.status === "failed") {
        undo();
        hud.toast(`${refusal(o.message)} The trade was undone.`);
        void syncMerchants();
        nearNote((n) => n.append(el("i", "", "Not saved · trade undone")), true);
        drawBoards(); walletKey = "";
      } else if (o.status === "onchain") {
        nearNote((n) => {
          n.append(el("i", "", "✓ "), document.createTextNode("Saved on NEAR · "));
          const a = el("a", "", "view");
          a.href = `${EXPLORER_TX}${o.txHash}`; a.target = "_blank"; a.rel = "noopener";
          n.append(a);
        });
      }
      save();
    });
  };
  /** Quest beats are story events, not trades: they stay in the game and say so. */
  const settle = (kind: string, summary: string): void => {
    state.receipts.push({ id: `${kind}-${state.minute}`, kind, minute: state.minute, summary, status: "local", message: "story event" });
    save();
  };

  // ---------------------------------------------------------------- price tooltip ----
  const reasonsOf = (q: Quote): string[] => q.factors.filter((f) => Math.abs(f.multiplier - 1) > 0.015).map((f) => `${stripPct(f.label)}: ${pctOf(f.label)}`);
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const renderTip = (): void => {
    if (mode.kind !== "walk") { hud.tip.style.display = "none"; return; }
    if (input.locked || mouse.x < 0) ndc.set(0, 0);
    else ndc.set((mouse.x / innerWidth) * 2 - 1, -(mouse.y / innerHeight) * 2 + 1);
    ray.setFromCamera(ndc, rig.camera);
    ray.far = 14;
    const hit = ray.intersectObjects([...market.boards], true)[0];
    let obj: THREE.Object3D | null = hit?.object ?? null;
    while (obj && !obj.userData.npc) obj = obj.parent;
    const id = obj?.userData.npc as string | undefined;
    if (!id || id === "harbor") { hud.tip.style.display = "none"; return; }
    const q = priceOf(state, id as MerchantId);
    hud.tip.innerHTML = "";
    hud.tip.append(el("b", "", `Why ${q.price} c?`));
    const ul = el("ul");
    for (const r of reasonsOf(q)) ul.append(el("li", "", r));
    if (!ul.children.length) ul.append(el("li", "", "A normal day: the usual price."));
    hud.tip.append(ul);
    const p = hit.point.clone().project(rig.camera);
    hud.tip.style.left = `${Math.min(innerWidth - 280, ((p.x + 1) / 2) * innerWidth + 24)}px`;
    hud.tip.style.top = `${Math.max(120, ((1 - p.y) / 2) * innerHeight - 60)}px`;
    hud.tip.style.display = "block";
  };

  // ---------------------------------------------------------------- panels ----
  const screenOf = (v: THREE.Vector3): { x: number; y: number } => {
    const p = v.clone().project(rig.camera);
    return { x: ((p.x + 1) / 2) * innerWidth, y: ((1 - p.y) / 2) * innerHeight };
  };
  /** Keep the panel on the side of the screen away from the speaking character. */
  const sidePanel = (npc: Npc): void => {
    const s = screenOf(npc.head);
    hud.panel.classList.toggle("left", s.x > innerWidth * 0.5);
    hud.panel.classList.toggle("right", s.x <= innerWidth * 0.5);
  };
  const showPanel = (npc: Npc): void => {
    sidePanel(npc);
    hud.panel.style.display = "block";
    requestAnimationFrame(() => hud.panel.classList.add("show"));
  };
  const hidePanel = (): void => { hud.panel.classList.remove("show"); hud.panel.style.display = "none"; };
  const head = (name: string, role: string, color: string): HTMLDivElement => {
    const h = el("div", "tp-head");
    const ava = el("div", "tp-ava", name.replace(/^Auntie /, "")[0]);
    ava.style.background = color;
    const t = el("div");
    t.append(el("b", "", name), el("span", "", role));
    h.append(ava, t);
    return h;
  };
  const button = (label: string, cls: string, onClick: () => void, key?: string, small?: string): HTMLButtonElement => {
    const b = el("button", cls);
    if (key) b.append(el("kbd", "", key));
    b.append(document.createTextNode(label));
    if (small) b.append(el("small", "", small));
    b.onclick = onClick;
    return b;
  };

  // ---------------------------------------------------------------- trading ----
  const goodFor = (id: MerchantId, tab: Tab): Good => (tab === "buy" && id === "arin" ? "lassi" : "mango");
  const sellPrice = (id: MerchantId): number | null => {
    if (id === "pema" && stepIndex(state) === 3) return DELIVERY_PRICE;
    return bidFor(state, id, "mango")?.price ?? null;
  };
  const tabsFor = (id: MerchantId): Tab[] => {
    const t: Tab[] = [];
    if (stepIndex(state) !== 3 || id !== "pema") t.push("buy");
    if (sellPrice(id) !== null) t.push("sell");
    if (unlocked(state, "invest") || state.player.shares[id] > 0) t.push("invest");
    return t;
  };
  const maxQty = (id: MerchantId, tab: Tab): number => {
    const m = state.merchants[id];
    if (tab === "buy") { const g = goodFor(id, tab); return Math.min(MAX_QTY, m.stock[g], Math.floor(state.player.coins / Math.max(1, priceOf(state, id).price))); }
    if (tab === "sell") { const p = sellPrice(id) ?? 1; return Math.min(MAX_QTY, state.player.inventory.mango, Math.floor(m.cash / p)); }
    return 1;
  };
  const defaultTab = (id: MerchantId): Tab => {
    const tabs = tabsFor(id), i = stepIndex(state);
    if (id === "pema" && i === 5 && tabs.includes("invest")) return "invest";
    if (tabs.includes("sell") && state.player.inventory.mango > 0 && (i === 3 || id !== "tomas")) return "sell";
    return tabs[0] ?? "buy";
  };
  const openTrade = (npc: Npc, id: MerchantId): void => {
    const tab = defaultTab(id);
    const q = Math.max(1, Math.min(3, maxQty(id, tab)));
    frame(npc);
    mode = { kind: "trade", npc, id, tab, qty: q, say: id === "pema" && stepIndex(state) === 3 ? `Are those for me? ${DELIVERY_PRICE} coins each, as promised!` : WHO[id].hello, tone: "", why: false, h: null, done: 0 };
    renderTrade();
    showPanel(npc);
  };
  const setTab = (tab: Tab): void => {
    if (mode.kind !== "trade" || mode.h) return;
    mode = { ...mode, tab, qty: Math.max(1, Math.min(3, maxQty(mode.id, tab))), why: false };
    renderTrade();
  };
  const setQty = (d: number): void => {
    if (mode.kind !== "trade" || mode.h || mode.done > 0) return;
    mode = { ...mode, qty: Math.max(1, Math.min(Math.max(1, maxQty(mode.id, mode.tab)), mode.qty + d)) };
    renderTrade();
  };

  const renderTrade = (): void => {
    if (mode.kind !== "trade") return;
    const { id, tab, h } = mode;
    const m = state.merchants[id];
    hud.panel.innerHTML = "";
    hud.panel.append(head(PERSONALITY[id].name, WHO[id].role, WHO[id].color));
    hud.panel.append(el("div", `tp-say ${mode.tone}`, mode.say));
    if (h) { renderHaggleBody(h); return; }
    const tabs = tabsFor(id);
    if (tabs.length > 1) {
      const t = el("div", "tp-tabs");
      for (const x of tabs) t.append(button(x === "buy" ? "Buy" : x === "sell" ? "Sell" : "Invest", tab === x ? "on" : "", () => setTab(x)));
      hud.panel.append(t);
    }
    if (tab === "invest") { renderInvestBody(id); return; }
    const good = goodFor(id, tab);
    const unit = tab === "buy" ? priceOf(state, id).price : sellPrice(id) ?? 0;
    const max = maxQty(id, tab);
    const item = el("div", "tp-item");
    const left = el("div");
    left.append(el("b", "", good === "lassi" ? "Lassi" : "Mango"), el("span", "", tab === "buy" ? `${m.stock[good]} on the stall` : `You have ${state.player.inventory.mango} · ${PERSONALITY[id].name.split(" ").pop()} has ${Math.floor(m.cash)} c`));
    const price = el("div", "price");
    price.append(el("b", "", `${unit} c`), el("span", "", tab === "buy" ? "each" : "paid each"));
    item.append(el("i", `ico ${good}`), left, price);
    hud.panel.append(item);
    if (tab === "buy") {
      const why = button(mode.why ? "Hide the reasons" : `Why ${unit} c?`, "tp-why", () => { if (mode.kind === "trade") { mode = { ...mode, why: !mode.why }; renderTrade(); } });
      hud.panel.append(why);
      if (mode.why) {
        const ul = el("ul", "tp-reasons");
        for (const r of reasonsOf(priceOf(state, id))) ul.append(el("li", "", r));
        if (!ul.children.length) ul.append(el("li", "", "A normal day: the usual price."));
        hud.panel.append(ul);
      }
    }
    const total = unit * mode.qty;
    const after = tab === "buy" ? state.player.coins - total : state.player.coins + total;
    if (max > 0) {
      const q = el("div", "tp-qty");
      q.append(button("−", "", () => setQty(-1)), el("b", "", String(mode.qty)), button("+", "", () => setQty(1)));
      const note = el("span", "", `${tab === "buy" ? "Pay" : "Get"} ${total} c\nYour coins after: ${after} c`);
      note.style.whiteSpace = "pre-line";
      q.append(note);
      hud.panel.append(q);
    }
    const acts = el("div", "tp-acts");
    if (mode.done > 0) { /* the result line is showing */ }
    else if (max <= 0) acts.append(el("div", "tp-text full", tab === "buy" ? (m.stock[good] <= 0 ? "Sold out for now." : `You need ${unit} c for one. You have ${state.player.coins} c.`) : (state.player.inventory.mango <= 0 ? "You have no mangoes to sell. Buy some first." : `${PERSONALITY[id].name} can't afford any right now.`)));
    else {
      acts.append(button(`${tab === "buy" ? "Buy" : "Sell"} ${goodName(good, mode.qty)} for ${total} c`, "primary", () => simpleDeal(), "1"));
      if (unlocked(state, "haggle") && modeFor(state, id) === tab && good === "mango") acts.append(button("Haggle", "full", () => startHaggle(), "2", "try for a better price"));
    }
    acts.append(button("Leave", "ghost full", () => endPanel(), "Esc"));
    hud.panel.append(acts);
  };

  const renderInvestBody = (id: MerchantId): void => {
    const m = state.merchants[id];
    const own = state.player.shares[id], cost = SHARE_LOT * SHARE_PRICE[id];
    hud.panel.append(el("div", "tp-text", `${m.shop} is split into ${SHARES_PER_STALL} shares. Every evening, half of the day's sales is paid out to the shareholders. Your money goes into the stall: ${m.name.split(" ").pop()} gets cash to restock and pay rent.`));
    const item = el("div", "tp-item");
    const left = el("div");
    left.append(el("b", "", `${SHARE_LOT} shares`), el("span", "", `You own ${own} of ${SHARES_PER_STALL}${own >= UPGRADE_AT ? " · stall upgraded" : ""}`));
    const price = el("div", "price");
    price.append(el("b", "", `${cost} c`), el("span", "", `${SHARE_PRICE[id]} c each`));
    item.append(el("i", "ico share"), left, price);
    hud.panel.append(item);
    const acts = el("div", "tp-acts");
    if (mode.kind === "trade" && mode.done > 0) { /* the result line is showing */ }
    else if (state.player.coins >= cost) acts.append(button(`Buy ${SHARE_LOT} shares for ${cost} c`, "primary", () => investIn(id), "1", `you'd own ${own + SHARE_LOT} of ${SHARES_PER_STALL}: ${Math.round(((own + SHARE_LOT) / SHARES_PER_STALL) * 100)}% of the payout`));
    else acts.append(el("div", "tp-text full", `You need ${cost} c and have ${state.player.coins} c.`));
    acts.append(button("Leave", "ghost full", () => endPanel(), "Esc"));
    hud.panel.append(acts);
  };

  const renderHaggleBody = (h: HaggleSession): void => {
    const item = el("div", "tp-item");
    const left = el("div");
    left.append(el("b", "", goodName(h.good, h.qty)), el("span", "", `${dealUnit(h)} c each · first offer ${Math.round(h.open * h.qty)} c`));
    const price = el("div", "price");
    price.append(el("b", "", `${dealTotal(h)} c`), el("span", "", "on the table"));
    item.append(el("i", `ico ${h.good}`), left, price);
    hud.panel.append(item);
    hud.panel.append(el("div", "tp-text", `Thinking: ${thoughts(state, h).join(", ")}.`));
    const pat = el("div", "tp-pat");
    pat.append(el("span", "", "Patience"));
    const bar = el("i"), fill = el("b", h.patience < 35 ? "low" : "");
    fill.style.width = `${h.patience}%`;
    bar.append(fill); pat.append(bar);
    hud.panel.append(pat);
    const acts = el("div", "tp-acts");
    if (!h.over && mode.kind === "trade" && mode.done <= 0) {
      TACTICS.forEach((t, i) => {
        const [label, hint] = TACTIC_LABEL[h.mode][t];
        acts.append(button(t === "fair" ? `Deal at ${dealTotal(h)} c` : label, t === "fair" ? "primary" : "", () => play.tactic(t), String(i + 1), t === "fair" ? undefined : hint));
      });
    }
    hud.panel.append(acts);
  };
  const tickHaggleBar = (): void => {
    if (mode.kind !== "trade" || !mode.h) return;
    const fill = hud.panel.querySelector<HTMLElement>(".tp-pat b");
    if (fill) { fill.style.width = `${mode.h.patience}%`; fill.classList.toggle("low", mode.h.patience < 35); }
  };
  const startHaggle = (): void => {
    if (mode.kind !== "trade") return;
    // the tutorial's haggle lesson is never locked out: a walk-out there just means "try again"
    if (stepIndex(state) === HAGGLE_STEP && mode.id === "tomas") delete state.flags[lockKey("tomas")];
    const h = openHaggle(state, mode.id);
    if ("error" in h) { mode = { ...mode, say: h.error, tone: "bad" }; renderTrade(); return; }
    const qty = Math.max(1, Math.min(mode.qty, h.qty));
    mode = { ...mode, h: { ...h, qty }, say: "Let's talk, then. My patience runs out while you think.", tone: "" };
    renderTrade();
  };

  /** Snapshot of everything a deal touches, so a deal the chain refuses can be undone exactly. */
  const keep = (id: MerchantId): (() => void) => {
    const p = structuredClone(state.player), m = structuredClone(state.merchants[id]);
    // story progress a deal unlocks rolls back with it: a refused delivery must not finish the step
    const progress = PROGRESS_FLAGS.map((k) => [k, state.flags[k]] as const);
    return () => {
      state.player = p; state.merchants[id] = m;
      for (const [k, v] of progress) { if (v === undefined) delete state.flags[k]; else state.flags[k] = v; }
    };
  };
  const simpleDeal = (): void => {
    if (mode.kind !== "trade" || mode.done > 0) return;
    const { id, tab } = mode;
    const unit = tab === "buy" ? priceOf(state, id).price : sellPrice(id);
    if (!unit || maxQty(id, tab) < 1) return;
    const qty = Math.min(mode.qty, maxQty(id, tab));
    settleDeal({ merchant: id, good: goodFor(id, tab), mode: tab === "buy" ? "buy" : "sell", qty, unit, open: unit, limit: unit, patience: 100, used: {}, moves: 0, over: "deal" });
  };

  /** Executes a closed deal (simple or haggled) locally, records it on NEAR, and reacts. */
  const settleDeal = (h: HaggleSession): void => {
    if (mode.kind !== "trade") return;
    const undo = keep(h.merchant);
    const out = closeDeal(state, h);
    if (!out.ok) { mode = { ...mode, h: null, say: out.message, tone: "bad", done: RESULT_HOLD }; renderTrade(); return; }
    const unit = dealUnit(h), total = out.total; // whole coins per unit: exactly what the contract settles
    const s = screenOf(mode.npc.head);
    if (h.mode === "sell") hud.coins(s.x, s.y, Math.max(4, total));
    const name = PERSONALITY[h.merchant].name;
    record("trade", `${h.mode === "buy" ? "Bought" : "Sold"} ${goodName(h.good, h.qty)} ${h.mode === "buy" ? "from" : "to"} ${name} for ${total} c`, haggleDeal(h.merchant, h.mode, h.good, h.qty, unit), undo);
    let say = WHO[h.merchant].thanks;
    const i = stepIndex(state);
    if (h.mode === "buy" && h.merchant === "tomas" && i === 2) { state.flags.boughtTomas = true; state.flags.tutCost = total; say = "There you go. Don't tell Pema where you got them."; }
    if (h.mode === "sell" && h.merchant === "pema" && i === 3) {
      state.flags.deliveredPema = true;
      const cost = Number(state.flags.tutCost ?? total);
      say = `Bought for ${cost} c, sold for ${total} c: you made ${total - cost} c. And look at my shelves!`;
      market.say("pema", "You saved my morning, Kavi!", 4);
    }
    if (h.mode === "buy" && h.moves > 0) { state.flags.haggled = true; if (out.gain > 0) say = `${out.gain} c cheaper than the first offer. Nicely done.`; }
    if (h.mode === "sell" && h.merchant === "arin") state.flags.soldArin = true;
    if (h.mode === "sell" && h.moves > 0 && out.gain > 0) say = `${out.gain} c more than the first offer.`;
    mode = { ...mode, h: null, say, tone: "good", done: RESULT_HOLD };
    drawBoards();
    renderTrade();
    afterProgress();
    save();
  };

  // ---------------------------------------------------------------- talking ----
  const ctx: DialogueContext = {
    econ: state,
    toast: (t) => hud.toast(t),
    settle: (kind, detail) => settle(kind, `${kind.replace(/-/g, " ")}: ${Object.entries(detail).map(([k, v]) => `${k} ${v}`).join(", ")}`),
  };
  const renderTalk = (): void => {
    if (mode.kind !== "talk") return;
    const { convo } = mode;
    const node = convo.nodes[mode.node];
    hud.panel.innerHTML = "";
    hud.panel.append(head(node.speaker, convo.role, convo.accent || "#5f7280"));
    hud.panel.append(el("div", "tp-say", node.text(state)));
    const acts = el("div", "tp-acts");
    const go = (next: string | null): void => {
      if (mode.kind !== "talk") return;
      if (next === null) { endPanel(); return; }
      mode = { ...mode, node: next };
      convo.nodes[next].onEnter?.(ctx);
      drawBoards();
      renderTalk();
    };
    const choices = (node.choices ?? []).filter((c) => !c.available || c.available(state));
    choices.forEach((c, i) => acts.append(button(c.label, `${i === 0 ? "primary" : ""} full`, () => { c.effect?.(ctx); save(); go(c.next); }, String(i + 1), c.detail?.(state))));
    if (!choices.length) acts.append(button(node.next ? "Continue" : "Goodbye", "primary", () => go(node.next ?? null), "1"));
    hud.panel.append(acts);
  };

  const frame = (npc: Npc): void => {
    // Kavi faces the merchant; the camera swings over his shoulder so the merchant sits right of centre.
    const dx = npc.root.position.x - player.root.position.x, dz = npc.root.position.z - player.root.position.z;
    player.heading = Math.atan2(dx, dz);
    player.frozen = true;
    npc.talking = true;
    if (document.pointerLockElement) document.exitPointerLock();
  };
  const openTalk = (npc: Npc, convo?: Conversation): void => {
    const c = convo ?? CONVERSATIONS[npc.id];
    if (!c) return;
    if (mode.kind !== "talk") frame(npc);
    mode = { kind: "talk", npc, convo: c, node: c.entry(state) };
    renderTalk();
    showPanel(npc);
  };
  const endPanel = (): void => {
    if (mode.kind === "trade" || mode.kind === "talk") mode.npc.talking = false;
    mode = { kind: "walk" };
    player.frozen = false;
    hidePanel();
    drawBoards();
    afterProgress();
    save();
  };

  // ---------------------------------------------------------------- overlays: notebook and reports ----
  const openCard = (build: (card: HTMLDivElement) => void): void => {
    if (mode.kind === "trade" || mode.kind === "talk") { mode.npc.talking = false; hidePanel(); }
    mode = { kind: "card" };
    player.frozen = true;
    if (document.pointerLockElement) document.exitPointerLock();
    hud.card.innerHTML = "";
    build(hud.card);
    hud.back.style.display = "block";
    hud.card.style.display = "block";
    hud.card.scrollTop = 0;
  };
  const closeOverlay = (): void => {
    hud.card.style.display = "none";
    hud.back.style.display = "none";
    mode = { kind: "walk" };
    player.frozen = false;
  };
  const footer = (card: HTMLDivElement, label: string, onClick: () => void): void => {
    const f = el("footer");
    f.append(button(label, "primary", onClick, "Enter"));
    card.append(f);
  };

  type NoteTab = "goals" | "bag" | "near" | "help";
  const openNotebook = (tab: NoteTab): void => openCard((card) => {
    card.append(el("h2", "", "Notebook"));
    const tabs = el("div", "nb-tabs");
    for (const [t, label] of [["goals", "Goals"], ["bag", "Bag"], ["near", "On NEAR"], ["help", "How to play"]] as const) tabs.append(button(label, t === tab ? "on" : "", () => openNotebook(t)));
    card.append(tabs);
    const sec = el("section");
    if (tab === "goals") {
      const i = stepIndex(state);
      sec.append(el("h4", "", "First day"));
      STEPS.forEach((st, k) => { const g = el("div", `goal${k < i ? " done" : k === i ? " now" : ""}`); g.append(el("i"), el("span", "", st.title)); sec.append(g); });
      if (i >= STEPS.length) {
        const h = el("h4", "", "Goals"); h.style.marginTop = "14px"; sec.append(h);
        const cur = GOALS.find((x) => !x.done(state));
        for (const gl of GOALS) { const d = gl.done(state); const g = el("div", `goal${d ? " done" : gl === cur ? " now" : ""}`); const sp = el("span", "", gl.title); if (!d) sp.append(el("small", "", gl.detail)); g.append(el("i"), sp); sec.append(g); }
      }
    } else if (tab === "bag") {
      const p = state.player;
      const bag = el("div", "bag");
      const slot = (ico: string, n: string, label: string): void => { const d = el("div"); const t = el("div"); t.append(el("b", "", n), el("span", "", label)); d.append(el("i", `ico ${ico}`), t); bag.append(d); };
      slot("coin", String(p.coins), "coins");
      slot("mango", String(p.inventory.mango), "mangoes");
      if (p.inventory.lemon) slot("lemon", String(p.inventory.lemon), "lemons");
      if (p.inventory.lassi) slot("lassi", String(p.inventory.lassi), "lassi");
      for (const id of MERCHANT_IDS) if (p.shares[id]) slot("share", `${p.shares[id]}/${SHARES_PER_STALL}`, `shares of ${state.merchants[id].shop}`);
      sec.append(bag);
      const p2 = el("p", "why", "Mangoes in your bag sell to anyone who is buying: Pema when her shelves are low, Arin for his lassi, Mira when someone has too many.");
      p2.style.marginTop = "12px";
      sec.append(p2);
    } else if (tab === "near") {
      const id = playerId();
      sec.append(el("p", "", "Every coin, mango and stall share in VIVOLITH lives on NEAR, a public blockchain. Each trade you make is saved there as you play. You never sign anything or pay a fee: the game covers it."));
      sec.append(el("p", "why", id ? `Your account: ${id}` : "This session is offline: trades stay in this browser."));
      const recent = state.receipts.filter((r) => r.status === "onchain").slice(-6).reverse();
      if (recent.length) {
        const t = el("table");
        for (const r of recent) {
          const row = t.insertRow(); row.insertCell().textContent = r.summary;
          const c = row.insertCell(); c.className = "n";
          if (r.txHash) { const a = el("a", "", "view"); a.href = `${EXPLORER_TX}${r.txHash}`; a.target = "_blank"; a.rel = "noopener"; c.append(a); }
        }
        sec.append(t);
      }
      if (id) { const b = button("Check my account live on NEAR", "", () => { void showProof(); }); b.style.marginTop = "12px"; sec.append(b); }
    } else {
      const t = el("table");
      for (const [k, v] of [["W A S D", "walk (Shift to run, Space to jump)"], ["Mouse", "look around (click the game first)"], ["F", "talk or trade with the person in front of you"], ["B · J · N · H", "bag · goals · NEAR · this help"], ["T", "fast-forward a week (after the first day)"], ["Esc", "close a window, or open the menu"]]) {
        const row = t.insertRow(); const a = row.insertCell(); a.append(el("kbd", "", k)); const b = row.insertCell(); b.textContent = v;
      }
      sec.append(t);
      const tips = el("ul");
      for (const x of ["Buy where goods are cheap and sell where they are missing. Chalkboards show prices; point at one to see why.",
        "Merchants who can't pay rent close their stall. Deliveries and shares keep them open.",
        "Shares pay you part of a stall's sales every evening. Haggling can save a few coins, but impatient merchants walk away."]) tips.append(el("li", "", x));
      tips.style.marginTop = "12px";
      sec.append(tips);
    }
    card.append(sec);
    footer(card, "Back to the city", closeOverlay);
  });

  /** "On NEAR": the player's balances and receipts read back from the contract (not from the save). */
  const showProof = async (): Promise<void> => {
    const id = playerId();
    openCard((card) => {
      card.append(el("h2", "", "Your account on NEAR"), el("div", "sub", id ? "Read live from the market contract on NEAR testnet." : "Offline: this session is not connected to NEAR."));
    });
    if (id) {
      const [bal, rc] = await Promise.all([balances(id).catch(() => ({})), chainReceipts(id).catch(() => [])]);
      const sec = el("section");
      const t = el("table");
      for (const [token, amount] of Object.entries(bal)) {
        const r = t.insertRow();
        r.insertCell().textContent = token === "coin" ? "Coins" : token.startsWith("share:") ? `Shares of ${state.merchants[token.slice(6) as MerchantId]?.shop ?? token.slice(6)}` : token[0].toUpperCase() + token.slice(1);
        const c = r.insertCell(); c.className = "n"; c.textContent = String(amount);
      }
      sec.append(t);
      const a = el("a", "", "Open in the NEAR explorer"); a.href = `${EXPLORER_ACCOUNT}${id}`; a.target = "_blank"; a.rel = "noopener";
      const p = el("p"); p.style.marginTop = "10px"; p.append(a); sec.append(p);
      hud.card.append(sec);
      if (rc.length) {
        const d = el("details"); d.append(el("summary", "", `Last ${Math.min(8, rc.length)} entries in the contract`));
        const ul = el("ul");
        for (const r of [...rc].reverse().slice(0, 8)) ul.append(el("li", "", `${r.kind} ${r.qty} ${r.token_id}${Number(r.price) ? ` at ${r.price} c` : ""}, with ${r.counterparty.split(".")[0]}`));
        d.append(ul); hud.card.append(d);
      }
    }
    footer(hud.card, "Back to the city", closeOverlay);
  };

  /** Evening and weekly report: what happened in the city, what you did, what you earned. Details are optional. */
  const showReport = (title: string, from: Snapshot, week: boolean): void => openCard((card) => {
    const days = Math.max(1, Math.round((state.minute - from.minute) / MINUTES_PER_DAY));
    card.append(el("h2", "", title), el("div", "sub", week ? `${days} days of trading, Day ${dayOf(from.minute)} to Day ${dayOf(state.minute)}` : clockOf(state.minute)));
    // 1. the city
    const city = el("section"); city.append(el("h4", "", "In the city"));
    const lines: string[] = [];
    for (const id of TRADERS) {
      const m = state.merchants[id];
      if (from.open[id] && m.status !== "open") lines.push(`${m.shop} closed: ${m.name} couldn't pay the rent.`);
      if (!from.open[id] && m.status === "open") lines.push(`${m.shop} reopened.`);
    }
    const moves = TRADERS.map((id) => ({ id, d: priceOf(state, id).price - from.price[id] })).sort((a, b) => Math.abs(b.d) - Math.abs(a.d));
    if (moves[0] && moves[0].d !== 0) {
      const mv = moves[0], m = state.merchants[mv.id];
      lines.push(`${mv.id === "arin" ? "Lassi" : "Mangoes"} at ${m.shop} got ${mv.d < 0 ? "cheaper" : "dearer"}: ${from.price[mv.id]} c, now ${priceOf(state, mv.id).price} c.`);
    }
    const trades = state.log.slice(Math.max(0, from.log - (state.log.length > 60 ? 0 : 0))).filter((e) => e.kind === "trade" && e.minute > from.minute).length;
    if (trades) lines.push(`Merchants traded with each other ${plural(trades, "time", "times")}, moving surplus to where it was short.`);
    if (!lines.length) lines.push("A quiet stretch: every stall stayed open and prices held.");
    for (const l of lines.slice(0, 4)) city.append(el("p", "", l));
    card.append(city);
    // 2. your part
    const part = el("section"); part.append(el("h4", "", "Your part"));
    const owned = TRADERS.filter((id) => state.player.shares[id] > 0);
    if (owned.length) for (const id of owned) part.append(el("p", "", `You own ${state.player.shares[id]} of ${SHARES_PER_STALL} shares in ${state.merchants[id].shop}${state.merchants[id].status === "open" ? ", which stayed open" : ", which is closed for now: it reopens once its shelves are stocked again"}.`));
    else part.append(el("p", "", "You don't own any stall shares yet. Partners earn from every day's sales."));
    if (state.player.rep.pema >= 10) part.append(el("p", "", "Pema counts you as a regular: she gives you her family price."));
    card.append(part);
    // 3. your purse
    const purse = el("section"); purse.append(el("h4", "", "Your purse"));
    const d = state.player.coins - from.coins, div = divsOf(state) - from.divs;
    purse.append(el("div", `big ${d >= 0 ? "pos" : "neg"}`, `${d >= 0 ? "+" : ""}${d} c`));
    purse.append(el("p", "", `From ${from.coins} c to ${state.player.coins} c${div > 0 ? `, including ${div} c in dividends from your shares` : ""}.`));
    card.append(purse);
    // details
    const det = el("details"); det.append(el("summary", "", "The numbers, stall by stall"));
    const t = el("table");
    for (const id of TRADERS) {
      const m = state.merchants[id];
      const r = t.insertRow(); const a = r.insertCell(); a.append(document.createTextNode(m.shop), el("span", "why", `${id === "arin" ? "Lassi" : "Mango"} ${from.price[id]} c → ${priceOf(state, id).price} c · ${m.status === "open" ? "open" : "closed"}`));
      const c = r.insertCell(); c.className = "n"; const dc = Math.round(m.cash - from.cash[id]); c.textContent = `${Math.round(m.cash)} c (${dc >= 0 ? "+" : ""}${dc})`;
    }
    det.append(t); card.append(det);
    const events = state.log.filter((e) => e.minute > from.minute && e.kind !== "player").slice(-8);
    if (events.length) { const ev = el("details"); ev.append(el("summary", "", "What happened, hour by hour")); const ul = el("ul"); for (const e of events) ul.append(el("li", "", `${clockOf(e.minute)} · ${e.text}`)); ev.append(ul); card.append(ev); }
    if (week && playerId()) {
      const near = el("details"); near.append(el("summary", "", "Dividends on NEAR"));
      const line = el("p", "why", "Settling today's dividends on NEAR…"); near.append(line); card.append(near);
      void settleDay().then(async (r) => {
        const got = (await chainReceipts(playerId()!).catch(() => [])).filter((x) => x.kind === "dividend").reduce((n, x) => n + Number(x.qty), 0);
        line.textContent = r.status === "onchain" ? `Today's dividends were settled on NEAR for all four stalls. Paid to your account so far: ${got} c. ` : `NEAR settlement: ${String(r.message ?? "not available right now")}`;
        if (r.status === "onchain" && typeof r.txHash === "string") { const a = el("a", "", "view"); a.href = `${EXPLORER_TX}${r.txHash}`; a.target = "_blank"; a.rel = "noopener"; line.append(a); }
      });
    }
    footer(card, week ? "Back to the city" : "Next morning", () => closeReport(week, from));
    if (week) state.flags.weekSeen = true; // seeing the week is the step; a reload with the report open keeps it
    save();
  });
  const closeReport = (week: boolean, from: Snapshot): void => {
    closeOverlay();
    if (week) {
      state.flags.weekSeen = true;
      if (TRADERS.every((id) => from.open[id] && state.merchants[id].status === "open")) state.flags.allOpenWeek = true;
    }
    // Overnight: jump to 08:00 so the next market day starts right away.
    const day0 = Math.floor(state.minute / MINUTES_PER_DAY) * MINUTES_PER_DAY;
    if (state.minute % MINUTES_PER_DAY >= RENT_MINUTE) advance(state, day0 + MINUTES_PER_DAY + 8 * 60 - state.minute);
    mark = snap(state);
    lastHour = Math.floor(state.minute / 60);
    drawBoards();
    afterProgress();
    save();
  };

  // ---------------------------------------------------------------- progress ----
  const afterProgress = (): void => {
    const reward = guide.update(state);
    if (reward) hud.toast(reward, true);
    if (Number(state.flags.tut ?? 0) >= STEPS.length && !state.flags.tutDone) {
      state.flags.tutDone = true;
      hud.toast("First day done. New goals are in your notebook (J).", true);
    }
    walletKey = "";
  };
  const showWelcome = (): void => openCard((card) => {
    card.append(el("h2", "", "Welcome to NEAR City"));
    const s = el("section");
    s.append(el("p", "", "You're Kavi, new in town with 25 coins in your pocket."));
    s.append(el("p", "", "The market square ahead runs on trade. Four merchants buy and sell all day, and each keeps their own account on NEAR. Prices move with every crate."));
    s.append(el("p", "", "Auntie Pema's fruit stall is in trouble. Go and see her."));
    card.append(s);
    footer(card, "Let's go", () => { state.flags.welcomed = true; closeOverlay(); save(); });
  });

  // ---------------------------------------------------------------- clock ----
  const runClock = (minutes: number): void => {
    let left = minutes;
    while (left > 1e-9) {
      const rent = nextRent(state.minute);
      const stepMin = Math.min(left, rent - state.minute);
      advance(state, stepMin);
      left -= stepMin;
      if (state.minute >= rent - 1e-6) {
        if (ff && state.minute >= ff.until) { const from = ff.from; ff = null; showReport("Your week in NEAR City", from, true); return; }
        if (!ff && unlocked(state, "rent")) { showReport(`Evening, Day ${dayOf(state.minute)}`, mark, false); return; }
        if (!ff) mark = snap(state); // during the first mission evenings pass quietly
      }
    }
  };

  const hintFor = (): string | null => {
    const i = stepIndex(state);
    if (mode.kind !== "walk" || ff) return null;
    if (i === 0 && playTime < 25) return "W A S D to walk · Shift to run · drag the mouse to look around";
    if (i === 3 && Number(state.flags.bagHint ?? 0) > playTime) return "B opens your bag";
    if (i === 6) return "Press T to fast-forward a week";
    return null;
  };
  let hintKey = "";
  const renderHint = (): void => {
    const h = hintFor() ?? "";
    if (h === hintKey) return;
    hintKey = h;
    hud.hint.textContent = h;
    hud.hint.style.display = h ? "block" : "none";
  };

  const update = (dt: number): void => {
    market.update(dt, player.root.position);
    if (play.paused) return;
    playTime += dt;
    autosaveIn -= dt;
    if (autosaveIn <= 0) { autosaveIn = AUTOSAVE_SEC; save(); }
    if (mode.kind === "walk") runClock(dt * (ff ? FF_MIN_PER_SEC : GAME_MIN_PER_SEC * (unlocked(state, "rent") ? 1 : TUTORIAL_CLOCK)));
    const hour = Math.floor(state.minute / 60);
    if (hour !== lastHour) { lastHour = hour; drawBoards(); save(); }

    if (mode.kind === "trade" || mode.kind === "talk") {
      const npc = mode.npc;
      const want = Math.atan2(npc.root.position.x - player.root.position.x, npc.root.position.z - player.root.position.z) + 0.65;
      let d = want - rig.yaw; d = Math.atan2(Math.sin(d), Math.cos(d));
      const k = 1 - Math.exp(-6 * dt);
      rig.yaw += d * k;
      rig.pitch += (0.1 - rig.pitch) * k;
      rig.dist += (3.1 - rig.dist) * k;
      sidePanel(npc);
    }
    if (mode.kind === "trade") {
      if (mode.done > 0) {
        mode = { ...mode, done: mode.done - dt };
        if (mode.done <= 0) { mode = { ...mode, done: 0 }; if (stepIndex(state) <= 5) endPanel(); else renderTrade(); }
      } else if (mode.h) {
        const h = tickPatience(mode.h, dt);
        mode = { ...mode, h };
        if (h.over === "walked") {
          const out = closeDeal(state, h);
          mode = { ...mode, h: null, say: out.message, tone: "bad", done: RESULT_HOLD };
          renderTrade();
        } else tickHaggleBar();
      }
    }
    // tutorial: arriving at Pema counts as finding her
    if (stepIndex(state) === 0) {
      const pema = market.npcs.find((n) => n.id === "pema");
      if (pema && Math.hypot(pema.post.stall.x - player.root.position.x, pema.post.stall.z - player.root.position.z) < 4.5) { state.flags.nearPema = true; afterProgress(); }
    }
    if (state.flags.boughtTomas && !state.flags.bagHint) state.flags.bagHint = playTime + 8;

    // keys
    if (input.consumePress("KeyF")) play.interact();
    if (input.consumePress("KeyT") && unlocked(state, "week")) play.fastForward();
    if (mode.kind === "walk" && !ff) {
      if (input.consumePress("KeyB")) openNotebook("bag");
      else if (input.consumePress("KeyJ")) openNotebook("goals");
      else if (input.consumePress("KeyN")) openNotebook("near");
      else if (input.consumePress("KeyH")) openNotebook("help");
      else if (input.consumePress("KeyL") && !playerLabel() && socialAvailable()) void signIn();
    }
    tickIn -= dt;
    if (tickIn <= 0 && playerId()) { tickIn = TICK_EVERY_SEC; void marketTick().then(syncMerchants); }
    if (input.consumePress("Escape")) { if (mode.kind === "trade" || mode.kind === "talk") endPanel(); else if (mode.kind === "card") closeOverlay(); }
    if (input.consumePress("Enter") && mode.kind === "card") hud.card.querySelector<HTMLButtonElement>("footer button")?.click();
    if (input.consumePress("Minus")) setQty(-1);
    if (input.consumePress("Equal")) setQty(1);
    for (let i = 0; i < 6; i++) {
      if (!input.consumePress(`Digit${i + 1}`)) continue;
      if (mode.kind === "trade" && mode.h) { if (i < 5) play.tactic(TACTICS[i]); }
      else if (mode.kind === "trade" || mode.kind === "talk") hud.panel.querySelectorAll<HTMLButtonElement>(".tp-acts button")[i]?.click();
    }

    const near = mode.kind === "walk" && !ff ? market.nearest(player.root.position) : null;
    if (near) {
      const trader = TRADERS.includes(near.id as MerchantId);
      const name = trader ? PERSONALITY[near.id as MerchantId].name : CONVERSATIONS[near.id]?.name ?? near.id;
      const talkFirst = near.id === "pema" && stepIndex(state) <= 1;
      hud.prompt.innerHTML = "";
      hud.prompt.append(el("kbd", "", "F"), el("span", "", `${!trader || talkFirst ? "Talk to" : "Trade with"} ${name}`));
      hud.prompt.style.display = "block";
    } else hud.prompt.style.display = "none";
    guide.draw(state, rig.camera, (id) => market.npcs.find((n) => n.id === id)?.root.position ?? null, player.root.position);
    renderTip();
    renderWallet();
    renderHint();
  };
  game.onUpdate.push(update);

  // ---------------------------------------------------------------- invest ----
  const investIn = (id: MerchantId): void => {
    if (mode.kind === "trade" && mode.done > 0) return;
    const undo = keep(id);
    const r = invest(state, id, SHARE_LOT);
    if (!r.ok) { hud.toast(r.message); return; }
    const m = state.merchants[id];
    record("invest", `Bought ${SHARE_LOT} shares of ${m.shop} for ${SHARE_LOT * SHARE_PRICE[id]} c`, buyPosted(id, `share:${id}`, SHARE_LOT, SHARE_PRICE[id]), undo);
    // Pema spends part of her partner's money on the harbor's storage fee: her held crates are finally on the way.
    const released = id === "pema" && payReleaseFee(state, "pema-mangoes", "merchant").ok;
    market.say(id, released ? "A partner! I've paid the harbor. My crates are coming!" : id === "pema" ? "A partner! That's tonight's rent, and a new awning." : "Partner! Let's make it worth it.", 4);
    if (mode.kind === "trade") { mode = { ...mode, say: `You now own ${state.player.shares[id]} of ${SHARES_PER_STALL} shares.${state.player.shares[id] >= UPGRADE_AT ? " Look at the stall!" : ""}`, tone: "good", done: RESULT_HOLD }; renderTrade(); }
    drawBoards(); afterProgress(); save();
  };

  // ---------------------------------------------------------------- account: guest or social/email ----
  /** The chain is the truth for what the player owns: their purse, bag and shares follow the active account. */
  const syncPlayer = async (id: string): Promise<void> => {
    const b = await balances(id).catch(() => null);
    if (!b || playerId() !== id) return;
    state.player.coins = b.coin ?? 0;
    state.player.inventory = { mango: b.mango ?? 0, lemon: b.lemon ?? 0, lassi: b.lassi ?? 0 };
    for (const m of TRADERS) state.player.shares[m] = b[`share:${m}`] ?? 0;
    state.flags.account = id;
    drawBoards(); walletKey = ""; save();
  };
  /** Merchants' coins and goods follow the chain too, so a stall never offers a deal its wallet can't settle. */
  const syncMerchants = async (): Promise<void> => {
    const all = await Promise.all(TRADERS.map((id) => balances(merchantAccount(id)).catch(() => null)));
    if (ff) return; // a fast-forward week runs on the local model; the next sync after it catches up
    TRADERS.forEach((id, i) => {
      const b = all[i];
      if (!b) return;
      const m = state.merchants[id];
      m.cash = b.coin ?? 0;
      m.stock = { mango: b.mango ?? 0, lemon: b.lemon ?? 0, lassi: b.lassi ?? 0 };
    });
    drawBoards();
    if (mode.kind === "trade") renderTrade();
  };
  let signingIn = false;
  const renderAcct = (): void => {
    const id = playerId(), label = playerLabel();
    hud.acct.innerHTML = "";
    const who = el("div", "who");
    who.append(el("b", "", !id ? "Offline" : label || "Guest"), el("span", "", id ? (label ? " · saved on NEAR" : " · saved in this browser") : " · trades stay here"));
    hud.acct.append(who);
    if (!id || (!label && !socialAvailable())) return; // sign-in appears once Google/email login is configured
    hud.acct.append(button(signingIn ? "Signing in…" : label ? "Sign out" : "Sign in", label ? "" : "primary", () => { void (label ? signOut() : signIn()); }));
  };
  const signIn = async (): Promise<void> => {
    if (signingIn || playerLabel()) return;
    signingIn = true; renderAcct();
    save(); // a popup-blocked browser redirects to the login page and back: keep the market as it is
    try {
      const r = await signInSocial();
      hud.toast(`Signed in as ${r.label || r.accountId.split(".")[0]}${r.merged ? ". Your progress came with you." : ""}`, true);
      await syncPlayer(r.accountId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "cancelled";
      if (!/redirecting/.test(msg)) hud.toast("Sign-in didn't finish. You're still playing as a guest.");
    } finally {
      signingIn = false; renderAcct();
    }
  };
  const signOut = async (): Promise<void> => {
    const id = await signOutSocial();
    renderAcct();
    if (id) { hud.toast("Signed out. Back to this browser's guest game."); await syncPlayer(id); }
  };

  let tickIn = 5;
  renderAcct();
  void finishSocialRedirect().then((r) => {
    if (r) hud.toast(`Signed in as ${r.label || r.accountId.split(".")[0]}${r.merged ? ". Your progress came with you." : ""}`, true);
    return r;
  }).catch(() => {
    hud.toast("Sign-in didn't finish. You're still playing as a guest.");
    return null;
  }).then(() => connectGuest()).then(async (id) => {
    renderAcct();
    if (!id) return;
    void syncMerchants();
    if (state.flags.account !== id) await syncPlayer(id); // a different account than this save last played
  });

  const play: Play = {
    state, market, hud, paused: true,
    /** Continue is offered only to someone who actually played (entered the world) on this save. */
    get restored() { return restored && state.flags.played === true; },
    get mode() { return mode.kind; },
    enterWorld() {
      if (!entered) {
        const f = state.flags;
        if (f.played === true && typeof f.px === "number" && typeof f.pz === "number") {
          // Continue: back where Kavi stood when the game was last saved.
          player.setSpawn(new THREE.Vector3(f.px, Number(f.py ?? 0) + 0.5, f.pz), Number(f.ph ?? Math.PI));
          game.rig.yaw = Number(f.ph ?? Math.PI);
          game.rig.snap(player.focus, game.colliders);
        } else enterTown();
        entered = true;
        state.flags.played = true;
        save();
      }
      play.paused = false;
      player.frozen = mode.kind !== "walk";
      renderAcct();
      walletKey = "";
      if (!state.flags.welcomed && stepIndex(state) === 0) showWelcome();
    },
    signIn: () => signIn(),
    signOut: () => signOut(),
    account: () => ({ id: playerId(), label: playerLabel(), canSignIn: socialAvailable() }),
    interact() {
      if (mode.kind !== "walk" || ff) return;
      const npc = market.nearest(player.root.position);
      if (!npc) return;
      if (npc.id === "pema" && stepIndex(state) <= 1) { state.flags.nearPema = true; openTalk(npc, PEMA_INTRO); return; }
      if (!TRADERS.includes(npc.id as MerchantId)) { openTalk(npc); return; }
      const m = state.merchants[npc.id as MerchantId];
      if (m.status !== "open") { hud.toast(`${m.shop} is closed. ${m.name} couldn't pay the rent.`); return; }
      openTrade(npc, npc.id as MerchantId);
    },
    tactic(t) {
      if (mode.kind !== "trade" || !mode.h || mode.h.over || mode.done > 0) return;
      const r = applyTactic(state, mode.h, t);
      mode = { ...mode, h: r.session, say: r.line, tone: t === "fair" ? "good" : r.success ? "good" : "bad" };
      if (r.session.over === "deal") settleDeal(r.session);
      else if (r.session.over === "walked") { const out = closeDeal(state, r.session); mode = { ...mode, h: null, say: out.message, tone: "bad", done: RESULT_HOLD }; renderTrade(); }
      else renderTrade();
    },
    fastForward(on) {
      const want = on ?? !ff;
      if (want && !ff && mode.kind === "walk") { ff = { from: snap(state), until: nextRent(state.minute + (FF_MAX_DAYS - 1) * MINUTES_PER_DAY) }; walletKey = ""; }
      else if (!want && ff) { const from = ff.from; ff = null; showReport("Fast-forward stopped", from, true); }
    },
    reset() { clearSave(); location.reload(); },
  };

  window.addEventListener("keydown", (e) => {
    if (e.code !== "Tab" || mode.kind !== "trade" || mode.h || play.paused) return;
    e.preventDefault();
    const tabs = tabsFor(mode.id);
    setTab(tabs[(tabs.indexOf(mode.tab) + 1) % tabs.length]);
  });

  drawBoards();
  return play;
}
