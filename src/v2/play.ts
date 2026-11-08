// v2 gameplay: market-day clock, haggling, conversations, rent night results, fast-forward, receipts, saves.
// Keys: F interact · 1-5 tactics · 6 talk · Esc leave · T fast-forward (a week in a minute) · Enter continue
// · I invest in the nearest stall · N show what is on NEAR.
import * as THREE from "three";
import type { Game } from "./game";
import { createMarket, type Market, type Npc } from "./market";
import { createHud, el, type Hud } from "./hud";
import { loadGame, saveGame, clearSave } from "../economy/save";
import { advance, invest, SHARE_PRICE, UPGRADE_AT } from "../economy/sim";
import { bidFor, quote, lassiPrice, stallPull, type Quote } from "../economy/pricing";
import { clockOf, dayOf, MERCHANT_IDS, MINUTES_PER_DAY, type EconomyState, type MerchantId, type Receipt } from "../economy/state";
import {
  applyTactic, closeDeal, dealTotal, openHaggle, thoughts, tickPatience, PERSONALITY, TACTICS,
  type HaggleSession, type Tactic,
} from "../economy/haggle";
import { CONVERSATIONS } from "../quests/mango";
import type { Conversation, DialogueContext } from "../quests/dialogue";
import { EXPLORER_ACCOUNT, EXPLORER_TX, balances, buyPosted, connectGuest, haggleDeal, marketTick, playerId, playerLabel, receipts as chainReceipts, settleDay, socialAvailable, finishSocialRedirect, signInSocial, signOutSocial, type TxOutcome } from "../near/chain";

const GAME_MIN_PER_SEC = 2.4; // 09:00 -> 21:00 in five real minutes
const FF_MIN_PER_SEC = (7 * MINUTES_PER_DAY) / 60; // a week in a minute
const FF_MAX_DAYS = 7;
const RENT_MINUTE = 21 * 60;
const RESULT_HOLD = 1.8; // seconds the deal result stays on the panel
const TRADERS: readonly MerchantId[] = MERCHANT_IDS;
const SHARE_LOT = 4;
const AUTOSAVE_SEC = 10;
const TICK_EVERY_SEC = 60;

const TACTIC_LABEL: Record<"buy" | "sell", Record<Tactic, string>> = {
  buy: { fair: "Pay the asking price", lowball: "Lowball", flatter: "Flatter", rival: "Mention the rival", bundle: "Bundle, buy double" },
  sell: { fair: "Accept the offer", lowball: "Ask high", flatter: "Flatter", rival: "Mention the rival", bundle: "Bundle, sell double" },
};

interface Snapshot {
  readonly minute: number;
  readonly coins: number;
  readonly cash: Record<MerchantId, number>;
  readonly price: Record<MerchantId, number>;
  readonly open: Record<MerchantId, boolean>;
  readonly receipts: number;
}

const priceOf = (s: EconomyState, id: MerchantId): Quote => (id === "arin" ? lassiPrice(s) : quote(s, id, "mango"));
const per = <T,>(f: (id: MerchantId) => T): Record<MerchantId, T> => Object.fromEntries(MERCHANT_IDS.map((id) => [id, f(id)])) as Record<MerchantId, T>;
const snap = (s: EconomyState): Snapshot => ({
  minute: s.minute, coins: s.player.coins, receipts: s.receipts.length,
  cash: per((id) => s.merchants[id].cash),
  price: per((id) => priceOf(s, id).price),
  open: per((id) => s.merchants[id].status === "open"),
});
const stripPct = (label: string): string => label.replace(/\s*\([^)]*\)\s*$/, "");
const nextRent = (minute: number): number => {
  const day = Math.floor(minute / MINUTES_PER_DAY) * MINUTES_PER_DAY;
  return minute < day + RENT_MINUTE ? day + RENT_MINUTE : day + MINUTES_PER_DAY + RENT_MINUTE;
};

type Mode =
  | { kind: "walk" }
  | { kind: "haggle"; npc: Npc; h: HaggleSession; line: string; tone: "" | "good" | "bad"; done: number }
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

export async function createPlay(game: Game): Promise<Play> {
  const { state, restored } = loadGame();
  const market = await createMarket(game.look.scene, game.colliders);
  const hud = createHud();
  market.bind(game.player.body, game.rig.camera);
  game.player.floor = market.floor;
  const enterTown = (): void => {
    if (!market.townSpawn) return; // start at the south gate and walk up Market Avenue toward the Spire
    game.player.setSpawn(market.townSpawn.clone().setY(market.townSpawn.y + 1), Math.PI);
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
  const buyingSub = (id: MerchantId): string | null => {
    const b = bidFor(state, id, "mango");
    return b ? `Buying mangoes ${b.price} c` : null;
  };
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
      const q = priceOf(state, id);
      n.board.draw({
        title: id === "arin" ? "Lassi" : `${m.name.split(" ")[id === "pema" ? 1 : 0]}'s mangoes`,
        price: `${q.price} c`,
        sub: buyingSub(id) ?? (id === "arin" ? `${m.stock.lassi} glasses` : `${m.stock.mango} in stock`),
        closed: m.status !== "open",
      });
    }
  };

  const renderTop = (): void => {
    const toRent = nextRent(state.minute) - state.minute;
    hud.top.innerHTML = "";
    const cell = (cls: string, big: string, small: string): void => {
      const d = el("div", cls); d.append(el("b", "", big), el("span", "", small)); hud.top.append(d);
    };
    cell("", clockOf(state.minute).replace(/^Day (\d+) /, "Day $1 · "), "Saltlight Market");
    cell("rent", `${Math.floor(toRent / 60)}h ${String(Math.floor(toRent % 60)).padStart(2, "0")}m`, "to rent night");
    cell("coins", `${state.player.coins} c`, `${state.player.inventory.mango} mangoes`);
    if (ff) cell("ff", "FAST", `day ${dayOf(state.minute)} · T to stop`);
  };

  const renderReceipts = (): void => {
    hud.receipts.innerHTML = "";
    for (const r of state.receipts.slice(-3).reverse()) hud.receipts.append(receiptRow(r));
  };
  const receiptRow = (r: Receipt): HTMLDivElement => {
    const d = el("div", r.status);
    d.append(el("b", "", r.summary));
    const status = r.status === "onchain" ? "On NEAR testnet " : r.status === "pending" ? "Recording on NEAR..." : r.status === "local" ? "In this game only (offline)" : `Not recorded: ${r.message ?? "error"}`;
    d.append(document.createTextNode(status));
    if (r.status === "onchain" && r.txHash) {
      const a = el("a", "", "view tx");
      a.href = `${EXPLORER_TX}${r.txHash}`; a.target = "_blank"; a.rel = "noopener";
      d.append(a);
    }
    return d;
  };
  /** Records a value move: pending until the chain answers. A refused move is undone in the game too. */
  const record = (kind: string, summary: string, tx: Promise<TxOutcome>, undo: () => void): void => {
    const r: Receipt = { id: `${kind}-${state.minute}-${state.receipts.length}`, kind, minute: state.minute, summary, status: "pending" };
    state.receipts.push(r);
    renderReceipts();
    void tx.then((o) => {
      Object.assign(r, { status: o.status, txHash: o.txHash, message: o.message, accountId: playerId() ?? undefined });
      if (o.status === "failed") { undo(); hud.toast(`Not recorded on NEAR (${o.message ?? "error"}): deal undone`); drawBoards(); renderTop(); }
      renderReceipts();
      save();
    });
  };
  /** Quest beats are story events, not trades: they stay in the game and say so. */
  const settle = (kind: string, summary: string): void => {
    state.receipts.push({ id: `${kind}-${state.minute}`, kind, minute: state.minute, summary, status: "local", message: "story event" });
    renderReceipts();
    save();
  };

  // ---------------------------------------------------------------- price tooltip ----
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
    const m = state.merchants[id as MerchantId];
    hud.tip.innerHTML = "";
    hud.tip.append(el("h4", "", `Why ${q.price} c? · ${m.name}`));
    for (const f of q.factors) {
      const row = el("div", "row");
      row.append(el("span", "", stripPct(f.label)), el("i", "", `x${f.multiplier.toFixed(2)}`));
      hud.tip.append(row);
    }
    hud.tip.append(el("div", "eq", id === "arin" ? "lassi = (1 + mango cost / 3) x scarcity" : `base ${m.baseCost.mango} c x every factor above`));
    const p = hit.point.clone().project(rig.camera);
    hud.tip.style.left = `${Math.min(innerWidth - 300, ((p.x + 1) / 2) * innerWidth + 24)}px`;
    hud.tip.style.top = `${Math.max(16, ((1 - p.y) / 2) * innerHeight - 60)}px`;
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
    hud.panel.classList.add("show");
  };
  const hidePanel = (): void => { hud.panel.classList.remove("show"); hud.panel.style.display = "none"; };

  let lastUnit = 0;
  const renderHaggle = (): void => {
    if (mode.kind !== "haggle") return;
    const { h, npc } = mode;
    const p = PERSONALITY[h.merchant];
    hud.panel.innerHTML = "";
    const head = el("header");
    head.append(el("b", "", p.name), el("span", "", `${p.trait} · ${h.mode === "buy" ? "selling" : "buying"} mangoes`));
    const price = el("div", "hp-price");
    const big = el("b", h.unit < lastUnit - 0.01 ? (h.mode === "buy" ? "down" : "up") : h.unit > lastUnit + 0.01 ? (h.mode === "buy" ? "up" : "down") : "", `${dealTotal(h)} c`);
    lastUnit = h.unit;
    price.append(big, el("span", "", `${h.qty} mangoes · ${h.unit.toFixed(1)} c each · opened ${Math.round(h.open * h.qty)} c`));
    const th = el("div", "hp-thought");
    th.append(document.createTextNode("Thinking: "), el("i", "", thoughts(state, h).join(" · ")));
    const pat = el("div", "hp-pat");
    const fill = el("div", h.patience < 35 ? "low" : "");
    fill.style.width = `${h.patience}%`;
    pat.append(fill);
    const line = el("div", `hp-line ${mode.tone}`, mode.line || (h.mode === "buy" ? `${h.qty} mangoes, ${dealTotal(h)} coins.` : `I'll give you ${dealTotal(h)} for ${h.qty}.`));
    const acts = el("div", "hp-acts");
    if (!h.over) {
      TACTICS.forEach((t, i) => {
        const b = el("button", t === "fair" ? "primary" : (h.used[t] ? "used" : ""));
        const k = el("kbd", "", String(i + 1));
        b.append(k, document.createTextNode(TACTIC_LABEL[h.mode][t]));
        if (t === "fair") b.append(el("small", "", `${h.mode === "buy" ? "Pay" : "Get"} ${dealTotal(h)} c now`));
        b.onclick = () => play.tactic(t);
        acts.append(b);
      });
      const talk = el("button");
      talk.append(el("kbd", "", "6"), document.createTextNode("Just talk"));
      talk.onclick = () => openTalk(npc);
      acts.append(talk);
    }
    hud.panel.append(head, price, th, el("div", "hp-patl", "Patience"), pat, line, acts);
    void npc;
  };
  const tickHaggleBar = (): void => {
    if (mode.kind !== "haggle") return;
    const fill = hud.panel.querySelector<HTMLElement>(".hp-pat div");
    if (fill) { fill.style.width = `${mode.h.patience}%`; fill.classList.toggle("low", mode.h.patience < 35); }
  };

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
    const head = el("header");
    head.append(el("b", "", node.speaker), el("span", "", convo.role));
    const acts = el("div", "hp-acts");
    const go = (next: string | null): void => {
      if (mode.kind !== "talk") return;
      if (next === null) { endPanel(); return; }
      mode = { ...mode, node: next };
      convo.nodes[next].onEnter?.(ctx);
      drawBoards();
      renderTalk();
    };
    const choices = (node.choices ?? []).filter((c) => !c.available || c.available(state));
    choices.forEach((c, i) => {
      const b = el("button", i === 0 ? "primary" : "");
      b.append(el("kbd", "", String(i + 1)), document.createTextNode(c.label));
      if (c.detail) b.append(el("small", "", c.detail(state)));
      b.onclick = () => { c.effect?.(ctx); save(); go(c.next); };
      acts.append(b);
    });
    if (!choices.length) {
      const b = el("button", "primary");
      b.append(el("kbd", "", "1"), document.createTextNode(node.next ? "Continue" : "Leave"));
      b.onclick = () => go(node.next ?? null);
      acts.append(b);
    }
    hud.panel.append(head, el("div", "hp-text", node.text(state)), acts);
  };

  const frame = (npc: Npc): void => {
    // Kavi faces the merchant; the camera swings over his shoulder so the merchant sits right of centre.
    const dx = npc.root.position.x - player.root.position.x, dz = npc.root.position.z - player.root.position.z;
    player.heading = Math.atan2(dx, dz);
    player.frozen = true;
    npc.talking = true;
    if (document.pointerLockElement) document.exitPointerLock();
  };
  const openTalk = (npc: Npc): void => {
    const convo = CONVERSATIONS[npc.id];
    if (!convo) return;
    if (mode.kind !== "talk") frame(npc);
    mode = { kind: "talk", npc, convo, node: convo.entry(state) };
    renderTalk();
    showPanel(npc);
  };
  const endPanel = (): void => {
    if (mode.kind === "haggle" || mode.kind === "talk") mode.npc.talking = false;
    mode = { kind: "walk" };
    player.frozen = false;
    hidePanel();
    drawBoards();
    save();
  };

  /** Snapshot of everything a deal touches, so a deal the chain refuses can be undone exactly. */
  const keep = (id: MerchantId): (() => void) => {
    const p = structuredClone(state.player), m = structuredClone(state.merchants[id]);
    return () => { state.player = p; state.merchants[id] = m; };
  };
  const finishHaggle = (): void => {
    if (mode.kind !== "haggle") return;
    const { h } = mode;
    const undo = keep(h.merchant);
    const out = closeDeal(state, h);
    const pname = PERSONALITY[h.merchant].name;
    if (out.ok) {
      // The contract settles whole coins per unit: round the haggled total to unit x qty and square the purse.
      const unit = Math.max(1, Math.round(out.total / h.qty));
      const diff = unit * h.qty - out.total;
      state.player.coins -= h.mode === "buy" ? diff : -diff;
      state.merchants[h.merchant].cash += h.mode === "buy" ? diff : -diff;
      const total = unit * h.qty;
      const s = screenOf(mode.npc.head);
      hud.coins(s.x, s.y, Math.max(4, total));
      const units = `${h.qty} ${h.qty === 1 ? "mango" : "mangoes"}`;
      const verb = h.mode === "buy" ? `Bought ${units} from` : `Sold ${units} to`;
      record("haggle", `${verb} ${pname} for ${total} c`, haggleDeal(h.merchant, h.mode, h.good, h.qty, unit), undo);
      mode = { ...mode, line: `${out.message.replace(/\d+ c/, `${total} c`)}${out.gain > 0 ? ` · ${out.gain} c better than the opening` : ""} · rep ${out.repDelta >= 0 ? "+" : ""}${out.repDelta}`, tone: "good", done: RESULT_HOLD };
    } else {
      mode = { ...mode, line: out.message, tone: "bad", done: RESULT_HOLD };
    }
    drawBoards();
    renderTop();
    renderHaggle();
    save();
  };

  // ---------------------------------------------------------------- results card ----
  const showCard = (title: string, from: Snapshot): void => {
    mode = { kind: "card" };

    player.frozen = true;
    if (document.pointerLockElement) document.exitPointerLock();
    hud.card.innerHTML = "";
    const days = Math.max(1, Math.round((state.minute - from.minute) / MINUTES_PER_DAY));
    hud.card.append(el("h2", "", title), el("h3", "", `${clockOf(state.minute)} · ${days > 1 ? `${days} days` : "since the morning"}: what changed and why`));
    const t = el("table");
    const coinsD = state.player.coins - from.coins;
    const you = t.insertRow();
    you.insertCell().append(el("b", "", "You"), el("span", "why", `${state.player.inventory.mango} mangoes in your bag`));
    const yc = you.insertCell(); yc.className = "n"; yc.textContent = `${state.player.coins} c (${coinsD >= 0 ? "+" : ""}${coinsD})`;
    for (const id of TRADERS) {
      const m = state.merchants[id];
      const q = priceOf(state, id);
      const top = [...q.factors].sort((a, b) => Math.abs(b.multiplier - 1) - Math.abs(a.multiplier - 1))[0];
      const r = t.insertRow();
      const name = r.insertCell();
      name.append(el("b", "", PERSONALITY[id].name));
      const st = m.status === "open" ? (from.open[id] ? "stayed open" : "reopened") : from.open[id] ? "closed: couldn't pay rent" : "still closed";
      name.append(el("span", m.status === "open" ? "ok" : "bad", ` ${st}`));
      name.append(el("span", "why", `${id === "arin" ? "Lassi" : "Mango"} ${from.price[id]} c -> ${q.price} c · ${top ? stripPct(top.label) : ""}`));
      const c = r.insertCell(); c.className = "n";
      const d = Math.round(m.cash - from.cash[id]);
      c.textContent = `${Math.round(m.cash)} c (${d >= 0 ? "+" : ""}${d})`;
    }
    hud.card.append(t);
    const events = state.log.filter((e) => e.minute > from.minute && e.kind !== "player").slice(-7);
    if (events.length) {
      const ul = el("ul");
      for (const e of events) ul.append(el("li", "", `${clockOf(e.minute).replace(/^Day \d+ /, "")} ${e.text}`));
      hud.card.append(ul);
    }
    const rc = state.receipts.slice(from.receipts);
    if (rc.length) {
      const box = el("div", "hud-rc");
      box.style.cssText = "position:static;width:auto;padding:10px 24px 0";
      for (const r of rc.slice(-4)) box.append(receiptRow(r));
      hud.card.append(box);
    }
    if (days > 1 && playerId()) {
      // The week above is the simulation's projection; the dividend the contract really pays is settled now.
      const line = el("p", "why", "On NEAR: settling today's stall dividends...");
      line.style.cssText = "padding:10px 24px 0;margin:0";
      hud.card.append(line);
      void settleDay().then(async (r) => {
        const mine = (await chainReceipts(playerId()!).catch(() => [])).filter((x) => x.kind === "dividend");
        const got = mine.reduce((n, x) => n + Number(x.qty), 0);
        line.textContent = r.status === "onchain" ? `On NEAR: today's dividends settled for all four stalls · paid to you on chain so far: ${got} c ` : `On NEAR: ${String(r.message ?? "settlement not available")}`;
        if (r.status === "onchain" && typeof r.txHash === "string") {
          const a = el("a", "", "view tx"); a.href = `${EXPLORER_TX}${r.txHash}`; a.target = "_blank"; a.rel = "noopener"; line.append(a);
        }
      });
    }
    const f = el("footer");
    const b = el("button", "primary");
    b.append(el("kbd", "", "Enter"), document.createTextNode("Next morning"));
    b.onclick = () => closeCard();
    f.append(b);
    hud.card.append(f);
    hud.card.style.display = "block";
    save();
  };
  const closeCard = (): void => {
    hud.card.style.display = "none";
    mode = { kind: "walk" };
    player.frozen = false;
    // Overnight: jump to 08:00 so the next market day starts right away.
    const day0 = Math.floor(state.minute / MINUTES_PER_DAY) * MINUTES_PER_DAY;
    const morning = day0 + MINUTES_PER_DAY + 8 * 60;
    if (state.minute % MINUTES_PER_DAY >= RENT_MINUTE) advance(state, morning - state.minute);
    mark = snap(state);
    lastHour = Math.floor(state.minute / 60);
    drawBoards();
    renderTop();
    save();
  };

  // ---------------------------------------------------------------- clock ----
  const runClock = (minutes: number): void => {
    let left = minutes;
    while (left > 1e-9) {
      const rent = nextRent(state.minute);
      const stepMin = Math.min(left, rent - state.minute);
      advance(state, stepMin);
      left -= stepMin;
      if (state.minute >= rent - 1e-6) {
        if (!ff) { showCard(`Rent night · Day ${dayOf(state.minute)}`, mark); return; }
        if (state.minute >= ff.until) { const from = ff.from; ff = null; showCard(`A week on the Row`, from); return; }
      }
    }
  };

  const update = (dt: number): void => {
    market.update(dt, player.root.position);
    if (play.paused) return;
    autosaveIn -= dt;
    if (autosaveIn <= 0) { autosaveIn = AUTOSAVE_SEC; save(); }
    if (mode.kind === "walk") runClock(dt * (ff ? FF_MIN_PER_SEC : GAME_MIN_PER_SEC));
    const hour = Math.floor(state.minute / 60);
    if (hour !== lastHour) { lastHour = hour; drawBoards(); save(); }

    if (mode.kind === "haggle" || mode.kind === "talk") {
      const npc = mode.npc;
      const want = Math.atan2(npc.root.position.x - player.root.position.x, npc.root.position.z - player.root.position.z) + 0.65;
      let d = want - rig.yaw; d = Math.atan2(Math.sin(d), Math.cos(d));
      const k = 1 - Math.exp(-6 * dt);
      rig.yaw += d * k;
      rig.pitch += (0.1 - rig.pitch) * k;
      rig.dist += (3.1 - rig.dist) * k;
      sidePanel(npc);
    }
    if (mode.kind === "haggle") {
      if (mode.done > 0) {
        mode = { ...mode, done: mode.done - dt };
        if (mode.done <= 0) endPanel();
      } else {
        mode = { ...mode, h: tickPatience(mode.h, dt) };
        if (mode.h.over === "walked") { mode = { ...mode, line: "You took too long. Come back tomorrow." }; finishHaggle(); }
        else tickHaggleBar();
      }
    }

    // keys
    if (input.consumePress("KeyF")) play.interact();
    if (input.consumePress("KeyT")) play.fastForward();
    if (input.consumePress("KeyN") && mode.kind === "walk") void showProof();
    if (input.consumePress("KeyL") && mode.kind === "walk" && !playerLabel() && socialAvailable()) void signIn();
    if (input.consumePress("KeyI") && mode.kind === "walk" && !ff) {
      const n = market.nearest(player.root.position);
      if (n && TRADERS.includes(n.id as MerchantId)) investIn(n.id as MerchantId);
    }
    tickIn -= dt;
    if (tickIn <= 0 && playerId()) { tickIn = TICK_EVERY_SEC; void marketTick(); }
    if (input.consumePress("Escape") && (mode.kind === "haggle" || mode.kind === "talk")) endPanel();
    if (input.consumePress("Enter")) { if (mode.kind === "card") hud.card.querySelector<HTMLButtonElement>("footer button")?.click(); else if (mode.kind === "haggle") play.tactic("fair"); }
    for (let i = 0; i < 6; i++) {
      if (!input.consumePress(`Digit${i + 1}`)) continue;
      if (mode.kind === "haggle") { if (i < 5) play.tactic(TACTICS[i]); else openTalk(mode.npc); }
      else if (mode.kind === "talk") hud.panel.querySelectorAll<HTMLButtonElement>(".hp-acts button")[i]?.click();
    }

    const near = mode.kind === "walk" && !ff ? market.nearest(player.root.position) : null;
    if (near) {
      const trader = TRADERS.includes(near.id as MerchantId);
      const name = trader ? PERSONALITY[near.id as MerchantId].name : CONVERSATIONS[near.id]?.name ?? near.id;
      hud.prompt.innerHTML = "";
      hud.prompt.append(el("kbd", "", "F"), document.createTextNode(`${trader ? "Haggle with" : "Talk to"} ${name}`));
      if (trader) hud.prompt.append(el("kbd", "", "I"), document.createTextNode(`Invest ${SHARE_LOT * SHARE_PRICE[near.id as MerchantId]} c`));
      hud.prompt.style.display = "block";
    } else hud.prompt.style.display = "none";
    renderTip();
    renderTop();
  };
  game.onUpdate.push(update);

  // ---------------------------------------------------------------- invest + NEAR proof ----
  const investIn = (id: MerchantId): void => {
    const undo = keep(id);
    const r = invest(state, id, SHARE_LOT);
    if (!r.ok) { hud.toast(r.message); return; }
    const m = state.merchants[id];
    hud.toast(`${SHARE_LOT} shares of ${m.shop}: you own ${state.player.shares[id]} of 20${state.player.shares[id] >= UPGRADE_AT ? " · the stall upgrades" : ""}`);
    record("invest", `Bought ${SHARE_LOT} shares of ${m.shop} for ${SHARE_LOT * SHARE_PRICE[id]} c`, buyPosted(id, `share:${id}`, SHARE_LOT, SHARE_PRICE[id]), undo);
    drawBoards(); renderTop(); save();
  };

  /** "Show on NEAR": the player's real balances and receipts read back from the contract (not from the save). */
  const showProof = async (): Promise<void> => {
    const id = playerId();
    mode = { kind: "card" };
    player.frozen = true;
    if (document.pointerLockElement) document.exitPointerLock();
    hud.card.innerHTML = "";
    hud.card.append(el("h2", "", "On NEAR"), el("h3", "", id ? "Read live from the market contract on testnet" : "Offline: this session is not connected to NEAR"));
    hud.card.style.display = "block";
    if (id) {
      const [bal, rc] = await Promise.all([balances(id).catch(() => ({})), chainReceipts(id).catch(() => [])]);
      const t = el("table");
      const who = t.insertRow();
      who.insertCell().append(el("b", "", "Your account"), el("span", "why", id));
      const link = el("a", "", "explorer");
      link.href = `${EXPLORER_ACCOUNT}${id}`; link.target = "_blank"; link.rel = "noopener";
      who.insertCell().append(link);
      for (const [token, amount] of Object.entries(bal)) {
        const r = t.insertRow();
        r.insertCell().append(el("b", "", token === "coin" ? "Coins" : token.startsWith("share:") ? `Shares of ${token.slice(6)}'s stall` : token));
        const c = r.insertCell(); c.className = "n"; c.textContent = String(amount);
      }
      hud.card.append(t);
      const ul = el("ul");
      for (const r of [...rc].reverse().slice(0, 8)) ul.append(el("li", "", `${r.kind} ${r.qty} ${r.token_id} @ ${r.price} c · ${r.counterparty.split(".")[0]} · block ${r.block_height}`));
      if (rc.length) hud.card.append(ul);
    }
    const f = el("footer");
    const b = el("button", "primary");
    b.append(el("kbd", "", "Enter"), document.createTextNode("Back to the market"));
    b.onclick = () => { hud.card.style.display = "none"; mode = { kind: "walk" }; player.frozen = false; };
    f.append(b);
    hud.card.append(f);
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
    drawBoards(); renderTop(); save();
  };
  let signingIn = false;
  const renderAcct = (): void => {
    const id = playerId(), label = playerLabel();
    hud.acct.innerHTML = "";
    const who = el("div");
    who.append(el("b", "", !id ? "Offline" : label || "Guest"), el("span", "", id ? `${id.split(".")[0]} · NEAR testnet` : "moves stay in this game"));
    hud.acct.append(who);
    if (!id || (!label && !socialAvailable())) return; // sign-in appears once Google/email login is configured
    const b = el("button", label ? "" : "primary");
    if (!label) b.append(el("kbd", "", "L"));
    b.append(document.createTextNode(signingIn ? "Signing in..." : label ? "Sign out" : "Sign in with email or Google"));
    b.onclick = () => { void (label ? signOut() : signIn()); };
    hud.acct.append(b);
  };
  const signIn = async (): Promise<void> => {
    if (signingIn || playerLabel()) return;
    signingIn = true; renderAcct();
    save(); // a popup-blocked browser redirects to NEAR Auth and back: keep the market as it is
    try {
      const r = await signInSocial();
      hud.toast(`Signed in as ${r.label || r.accountId.split(".")[0]}${r.merged ? " · your guest progress moved with you" : ""}`);
      await syncPlayer(r.accountId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "cancelled";
      if (!/redirecting/.test(msg)) hud.toast(`Sign-in did not finish: ${msg.slice(0, 80)} · still playing as guest`);
    } finally {
      signingIn = false; renderAcct();
    }
  };
  const signOut = async (): Promise<void> => {
    const id = await signOutSocial();
    renderAcct();
    if (id) { hud.toast("Signed out · back to this browser's guest account"); await syncPlayer(id); }
  };

  let tickIn = 5;
  renderAcct();
  void finishSocialRedirect().then((r) => {
    if (r) hud.toast(`Signed in as ${r.label || r.accountId.split(".")[0]}${r.merged ? " · your guest progress moved with you" : ""}`);
    return r;
  }).catch((e: unknown) => {
    hud.toast(`Sign-in did not finish: ${e instanceof Error ? e.message.slice(0, 80) : "error"} · still playing as guest`);
    return null;
  }).then(() => connectGuest()).then(async (id) => {
    renderAcct();
    if (!id) return;
    hud.toast(playerLabel() ? `Welcome back, ${playerLabel()}` : `Playing as guest · ${id.split(".")[0]} on NEAR testnet`);
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
    },
    signIn: () => signIn(),
    signOut: () => signOut(),
    account: () => ({ id: playerId(), label: playerLabel(), canSignIn: socialAvailable() }),
    interact() {
      if (mode.kind !== "walk" || ff) return;
      const npc = market.nearest(player.root.position);
      if (!npc) return;
      if (!TRADERS.includes(npc.id as MerchantId)) { openTalk(npc); return; }
      const h = openHaggle(state, npc.id as MerchantId);
      if ("error" in h) { hud.toast(h.error); return; }
      frame(npc);
      lastUnit = h.unit;
      mode = { kind: "haggle", npc, h, line: "", tone: "", done: 0 };
      renderHaggle();
      showPanel(npc);
    },
    tactic(t) {
      if (mode.kind !== "haggle" || mode.h.over || mode.done > 0) return;
      const r = applyTactic(state, mode.h, t);
      mode = { ...mode, h: r.session, line: r.line, tone: t === "fair" ? "good" : r.success ? "good" : "bad" };
      if (r.session.over) finishHaggle(); else renderHaggle();
    },
    fastForward(on) {
      const want = on ?? !ff;
      if (want && !ff && mode.kind === "walk") ff = { from: snap(state), until: nextRent(state.minute + (FF_MAX_DAYS - 1) * MINUTES_PER_DAY) };
      else if (!want && ff) { const from = ff.from; ff = null; showCard("Fast-forward", from); }
    },
    reset() { clearSave(); location.reload(); },
  };

  drawBoards();
  renderReceipts();
  renderTop();


  return play;
}
