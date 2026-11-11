// v2 gameplay: the first mission and goals (guide.ts), trading at stalls, conversations, the market clock, rent
// and weekly reports, investing, saves, and the NEAR record of every value move.
// Keys: F interact · 1 confirm · Esc close · B bag · J goals · N NEAR · H help · T fast-forward (once unlocked).
import * as THREE from "three";
import type { Game } from "./game";
import { createMarket, type Market, type Npc } from "./market";
import { createHud, el, type Hud } from "./hud";
import { createGuide, DELIVERY_PRICE, GOALS, inTutorial, investTarget, STEPS, stepIndex, titleOf, tutorSeller, unlocked, type Target } from "./guide";
import { loadGame, saveGame, clearSave } from "../economy/save";
import { calibrateSoles } from "./soles";
import { advance, invest, MAX_PACKS, payReleaseFee, recordRestock, REOPEN_SHARE, reopenGap, sellShares, SHARE_PACK, shareCost, shareRefund, shareSupply, tryReopen, UPGRADE_AT } from "../economy/sim";
import { bidFor, quote, lassiPrice, stallPull, ORCHARD_PICK, ORCHARD_HOURS, type Quote } from "../economy/pricing";
import { clockOf, dayOf, MERCHANT_IDS, MINUTES_PER_DAY, STARTER_COINS, type EconomyState, type Good, type MerchantId, type Receipt } from "../economy/state";
import { RESIDENTS } from "../economy/residents";
import { audio } from "./audio";
import { createCityMap } from "./map";
import { VOICES, type LineId } from "./audio-manifest";

/** Metres per footstep sound, and how close to the stalls the market music and murmur take over. */
const ORCHARD_REACH_M = 4;
/** Money trail: how many payments the proof screen lists, and how long the gold arc stays up. */
const TRAIL_ROWS = 10, TRAIL_SEC = 10;
const STEP_EVERY_M = 1.4, MARKET_SOUND_M = 24, CAR_SOUND_M = 9, CAR_QUIET_SEC = 5;
import { applyTactic, closeDeal, dealTotal, dealUnit, isLocked, lockKey, openHaggle, thoughts, tickPatience, modeFor, PERSONALITY, TACTICS, type HaggleSession, type Tactic } from "../economy/haggle";
import { CONVERSATIONS } from "../quests/mango";
import type { Conversation, DialogueContext } from "../quests/dialogue";
import {
  EXPLORER_ACCOUNT, EXPLORER_TX, balances, buyPosted, sellPosted, connectGuest, haggleDeal, marketTick, merchantAccount, playerId, playerLabel, receipts as chainReceipts,
  settleDay, claimDividends, lastMarketTurn, askMerchant, pickOrchard, marketDay, isOffline, onAccountChange, chooseSignIn, cloudGet, cloudPut, socialAvailable, type SignInResult, type SignInConflict, finishSocialRedirect, signInSocial, signOutSocial, view, type TxOutcome,
} from "../near/chain";

const GAME_MIN_PER_SEC = 2.4; // 09:00 -> 21:00 in five real minutes
const TUTORIAL_CLOCK = 0.25; // the first mission is not rushed by the clock
const FF_MIN_PER_SEC = (7 * MINUTES_PER_DAY) / 60; // a week in a minute
const FF_MAX_DAYS = 7;
const RENT_MINUTE = 21 * 60;
const RESULT_HOLD = 2.6; // seconds the deal result stays on the panel
const TUTORIAL_PATIENCE = 0.4; // the first haggle drains slower: a new player is still reading the tactics
const TRADERS: readonly MerchantId[] = MERCHANT_IDS;
const AUTOSAVE_SEC = 10;
const TICK_EVERY_SEC = 60;
/** Index of "Haggle with Tomas" in guide.ts STEPS. */
const HAGGLE_STEP = STEPS.findIndex((s) => s.id === "haggle");
/** Plain-language reason for a trade the chain refused (raw message stays in the notebook's receipts). */
/** What a refusal means for the player. The contract says "not enough <token>" for whichever side is short, so
 *  `side` (the player's) tells whose coins or goods ran out. */
const refusal = (msg = "", side: "buy" | "sell" = "buy"): string =>
  /not enough coin/i.test(msg) ? (side === "buy" ? "You don't have enough coins for that." : "They can't pay that much right now.")
    : /not enough (mango|lemon|lassi)/i.test(msg) ? (side === "buy" ? "They don't have that many left." : "You don't have that many to sell.")
    : /sold out|only \d+ on offer/i.test(msg) ? "They don't have that many left."
    : /not buying/i.test(msg) ? "They're fully stocked and not buying right now."
    : /doesn't sell/i.test(msg) ? "They don't sell that."
    : /won't go below|won't pay more/i.test(msg) ? `They won't take that price (${msg}).`
    : /slow down|429/i.test(msg) ? "Too many trades at once. Wait a moment."
    : /expired/i.test(msg) ? "The handshake took too long. Try again."
    : /unreachable|offline|could not sign/i.test(msg) ? "Couldn't reach the market. Check your connection and try again."
    : `The trade didn't go through${msg ? `: ${msg}` : "."}`;
const MAX_QTY = 10;

const TACTIC_LABEL: Record<"buy" | "sell", Record<Tactic, [string, string]>> = {
  buy: { fair: ["Deal", "pay this price"], lowball: ["Lowball", "offer much less"], flatter: ["Flatter", "kind words, small discount"], rival: ["Mention a rival", "works if a rival is cheaper"], bundle: ["Buy double", "more for less each"] },
  sell: { fair: ["Deal", "take this price"], lowball: ["Ask more", "push the price up"], flatter: ["Flatter", "kind words, small bonus"], rival: ["Mention a rival", "works if a rival pays more"], bundle: ["Sell double", "more at a better rate"] },
};

/** Who each merchant is, in one line, and how they greet you. */
const WHO: Record<MerchantId, { role: string; color: string; hello: string; thanks: string }> = {
  // hello/thanks come from the voice manifest: what a merchant says on screen is exactly what their clip says
  pema: { role: "Fruit seller · fair prices, loyal to regulars", color: "#f39a2c", hello: VOICES.pema.lines.hello, thanks: VOICES.pema.lines.thanks },
  tomas: { role: "Fruit seller · charges what he can", color: "#5f7280", hello: VOICES.tomas.lines.hello, thanks: VOICES.tomas.lines.thanks },
  mira: { role: "Trader · buys surplus, sells for less", color: "#9b7fe0", hello: VOICES.mira.lines.hello, thanks: VOICES.mira.lines.thanks },
  arin: { role: "Tea house · buys mangoes for his lassi", color: "#2f9a85", hello: VOICES.arin.lines.hello, thanks: VOICES.arin.lines.thanks },
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
  account(): { id: string | null; label: string | null; canSignIn: boolean; offline: boolean };
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
  calibrateSoles(game.look.renderer, market.cast);
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
  /** Fast-forward. Connected to NEAR it is a forecast: the week runs on a copy of the city, and `real` (the chain's
   *  state when it began) comes back afterwards, so nothing it shows is mistaken for what happened on NEAR. */
  let ff: { from: Snapshot; until: number; real: EconomyState | null } | null = null;
  let lastHour = Math.floor(state.minute / 60);
  let playTime = 0;

  const mouse = { x: -1, y: -1 };
  window.addEventListener("mousemove", (e) => { mouse.x = e.clientX; mouse.y = e.clientY; });
  let entered = false;
  /** Saves the market and, once the player is in the world, where Kavi stands and faces. */
  let resetting = false; // New Game: the reload's pagehide must not write the cleared save back
  const save = (): void => {
    if (resetting) return;
    if (entered) {
      const b = player.body; // the physics body is authoritative; the visual root lags a frame behind it
      Object.assign(state.flags, { px: Math.round(b.x * 100) / 100, py: Math.round(b.y * 100) / 100, pz: Math.round(b.z * 100) / 100, ph: Math.round(player.heading * 1000) / 1000 });
    }
    state.flags.savedAt = Date.now();
    saveGame(state);
    queueCloud();
  };
  /** Signed in: the story follows the account to any device (uploaded at most every 20 s, and on signing out). */
  let cloudTimer = 0, cloudDirty = false;
  const queueCloud = (): void => {
    if (!playerLabel()) return;
    cloudDirty = true;
    if (cloudTimer) return;
    cloudTimer = window.setTimeout(() => { cloudTimer = 0; if (cloudDirty) { cloudDirty = false; void cloudPut(JSON.stringify(state)); } }, 20_000);
  };
  /** Swap this browser's story for another one (a signed-in account's cloud save, or the guest's own again): reloads. */
  const GUEST_SAVE = "nearworld.save.guest";
  const adoptSave = (json: string): void => {
    resetting = true; // the reload's pagehide must not write the old story back
    try { localStorage.setItem("nearworld.save.v1", json); } catch { /* storage blocked */ }
    location.reload();
  };
  let autosaveIn = AUTOSAVE_SEC;
  const saveNow = (): void => { if (entered) save(); };
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") saveNow(); });
  window.addEventListener("pagehide", saveNow);

  /** Hourly: the townsfolk's rhythm, crates on the depot dock for shipments that landed, and what people talk about. */
  const townHour = (prevHour: number): void => {
    const hour = Math.floor(state.minute / 60);
    market.life.setHour(hour % 24);
    const landed = state.log.filter((e) => e.kind === "shipment" && e.minute >= prevHour * 60 && /delivered|released/.test(e.text)).length;
    if (landed) { market.life.deliver(3 * landed); void audio.sfx("harbor_horn"); }
    const lines: string[] = [];
    const cheapest = TRADERS.filter((id) => id !== "arin" && state.merchants[id].status === "open")
      .sort((a, b) => priceOf(state, a).price - priceOf(state, b).price)[0];
    if (cheapest) lines.push(`Mangoes are ${priceOf(state, cheapest).price} c at ${PERSONALITY[cheapest].name.split(" ")[0]}'s today.`);
    for (const id of TRADERS) if (state.merchants[id].status !== "open") lines.push(`${state.merchants[id].shop} is shut. I hope someone helps.`);
    if (state.shipments.some((s) => s.status === "held")) lines.push("Pema's crates are still stuck at the harbor.");
    if (landed) lines.push("The harbor crates just came in!");
    if ((dayOf(state.minute) - 1) % 2 === 0) lines.push("Rent is due tonight at nine.");
    if (state.player.shares.pema > 0) lines.push("Kavi owns part of Pema's stall now.");
    lines.push(hour % 24 >= 18 ? "Everyone's on the Spire lawn tonight." : hour % 24 < 11 ? "Busy morning at the Harbor Depot." : "Lunch at the food trucks by the Labs?");
    market.life.setGossip(lines);
  };
  townHour(lastHour);

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
        // the stall's real till against its real rent: green when it can pay, red when it is at risk of closing
        rent: m.status === "open" ? { ok: m.cash >= m.rent, text: m.cash >= m.rent ? `Rent ${m.rent} c · covered` : `Rent ${m.rent} c · till only ${m.cash} c` } : undefined,
      });
    }
  };

  // ---------------------------------------------------------------- wallet + NEAR status ----
  /** Something to grow into besides surviving rent: a rank from what the player is worth (coins, goods at what a
   *  merchant would pay, shares at their guaranteed buy-back value). */
  const RANKS: readonly [number, string][] = [[400, "Market patron"], [150, "Merchant"], [60, "Trader"], [0, "Newcomer"]];
  const traderRank = (): string => {
    const p = state.player;
    const goods = (p.inventory.mango + p.inventory.lemon) * 3 + p.inventory.lassi * 3;
    const shares = MERCHANT_IDS.reduce((n, id) => n + shareRefund(id, p.shares[id]), 0);
    const worth = p.coins + goods + shares;
    return RANKS.find(([min]) => worth >= min)![1];
  };
  let walletKey = "";
  let nearTimer = 0;
  const nearLine = el("div", "hud-near");
  const renderWallet = (): void => {
    const p = state.player;
    const showClock = unlocked(state, "rent");
    const day = dayOf(state.minute), rentDay = (day - 1) % 2 === 0;
    const clock = clockOf(state.minute).replace(/^Day (\d+) /, "Day $1 · ");
    const shares = MERCHANT_IDS.reduce((n, id) => n + p.shares[id], 0);
    const rank = traderRank();
    const key = `${p.coins}|${p.inventory.mango}|${p.inventory.lemon}|${p.inventory.lassi}|${shares}|${showClock ? clock : ""}|${ff ? 1 : 0}|${rank}`;
    if (key === walletKey) return;
    const prev = walletKey.split("|");
    walletKey = key;
    if (prev.length > 1) { // the purse changed: a coin chime up, a softer one down; goods into the bag thud
      if (p.coins > Number(prev[0])) audio.synth("coin"); else if (p.coins < Number(prev[0])) audio.synth("pay");
      if (p.inventory.mango > Number(prev[1])) void audio.sfx("goods");
    }
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
    const r = el("div", "hud-clock"); r.textContent = rank; r.title = "Your rank: coins, goods and the buy-back value of your shares"; hud.wallet.append(r);
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

  /** Sends a value move and changes nothing in the game until NEAR answers: `confirmed` moves the coins and goods
   *  once the chain has, `refused` explains a refusal (nothing was charged). Either way the wallet is then re-read
   *  from the chain, and an attempt with no final answer is settled by that re-read instead of a guess. */
  let inFlight = 0; // value moves sent this session and not yet answered
  /** Bumped when a value move is sent and when it is answered: a chain read that started before either is stale (it
   *  may predate the move) and is dropped, so a slow read can never undo a trade NEAR already confirmed. */
  let ledgerEpoch = 0;
  const record = (kind: string, summary: string, tx: Promise<TxOutcome>, confirmed: () => void, refused: (message: string | null) => void): void => {
    const r: Receipt = { id: `${kind}-${state.minute}-${state.receipts.length}`, kind, minute: state.minute, summary, status: "pending" };
    state.receipts.push(r);
    inFlight++;
    ledgerEpoch++;
    nearNote((n) => n.append(document.createTextNode("Saving the trade…")));
    void tx.then((o) => {
      inFlight--;
      ledgerEpoch++;
      Object.assign(r, { status: o.status === "unknown" ? "unconfirmed" : o.status, txHash: o.txHash, message: o.message, accountId: playerId() ?? undefined });
      if (o.status === "onchain" || o.status === "local") confirmed();
      if (o.status === "failed") {
        refused(o.message ?? "");
        nearNote((n) => n.append(el("i", "", "Not saved · nothing was charged")), true);
      } else if (o.status === "unknown") {
        refused(null);
        nearNote((n) => n.append(el("i", "", "Not confirmed yet · your purse was re-checked")), true);
      } else if (o.status === "onchain") {
        nearNote((n) => {
          n.append(el("i", "", "✓ "), document.createTextNode("Saved · see N for the record")); // the transaction link lives on the proof screen
        });
      }
      const id = playerId();
      if (id && o.status !== "local") { void syncPlayer(id); void syncMerchants(); } // the chain is the ledger
      drawBoards(); walletKey = "";
      save();
    });
  };
  /** A refusal lands on the merchant's panel if it is still open, else as a toast. null: no final answer came. */
  const refusedAt = (id: MerchantId, side: "buy" | "sell" = "buy") => (message: string | null): void => {
    const why = message === null ? "The market didn't confirm in time. Your purse was re-checked." : refusal(message, side);
    if (mode.kind === "trade" && mode.id === id) {
      mode = { ...mode, h: null, say: why, tone: "bad", done: RESULT_HOLD }; renderTrade();
      if (message !== null) void audio.line(id, why); // the merchant's refusal; a timeout notice is the game's, not theirs
    }
    else hud.toast(why);
  };
  /** The panel waits on the chain: inputs stay locked (done > 0) until record() answers. */
  const AWAITING = Number.POSITIVE_INFINITY;
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
    if (!input.free || mouse.x < 0) ndc.set(0, 0); // cursor hidden (locked or soft look): aim at the screen centre
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
  /** Talk sits centred under the speaker; trade sits left, away from the merchant (the talk camera always swings
   *  them right of centre, so the side is fixed instead of chasing the camera and jumping mid-swing). */
  const placePanel = (kind: "talk" | "trade"): void => {
    const p = hud.panel.classList;
    p.toggle("talk", kind === "talk"); p.toggle("trade", kind === "trade"); p.add("left");
    document.body.classList.add("panel-open");
  };
  const showPanel = (kind: "talk" | "trade"): void => {
    placePanel(kind);
    hud.panel.style.display = "block";
    hud.panel.scrollTop = 0;
    requestAnimationFrame(() => hud.panel.classList.add("show"));
    void audio.sfx("ui_open");
  };
  const hidePanel = (): void => {
    if (hud.panel.style.display !== "none") void audio.sfx("ui_close");
    hud.panel.classList.remove("show"); hud.panel.style.display = "none";
    document.body.classList.remove("panel-open");
  };
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
  /** What a merchant asks this player. On the first day's buying step the tutorial seller gives a newcomer's price
   *  (DELIVERY_PRICE - 2, never above his posted price and never below the 55% the relayer lets a merchant sign), so
   *  three mangoes always fit the starter purse and always sell to Pema at a profit, whatever the live market. */
  const buyUnit = (id: MerchantId): number => {
    const p = priceOf(state, id).price;
    return stepIndex(state) === 2 && id === tutorSeller(state) ? Math.min(p, Math.max(Math.ceil(p * 0.55), DELIVERY_PRICE - 2)) : p;
  };
  const sellPrice = (id: MerchantId): number | null => {
    if (id === "pema" && stepIndex(state) === 3) return DELIVERY_PRICE;
    return bidFor(state, id, "mango")?.price ?? null;
  };
  const tabsFor = (id: MerchantId): Tab[] => {
    const t: Tab[] = [];
    if ((stepIndex(state) !== 3 || id !== "pema") && state.merchants[id].status === "open") t.push("buy");
    if (sellPrice(id) !== null) t.push("sell");
    if (unlocked(state, "invest") || state.player.shares[id] > 0) t.push("invest");
    return t;
  };
  /** Shares never sell out: the stall's unsold shares go first, then the contract issues new ones on the same terms
   *  (at most MAX_PACKS packs a transaction). Selling back is always possible: the reserve pays the backing. */
  const wholePacks = (id: MerchantId, n: number): number => Math.floor(Math.max(0, n) / SHARE_PACK[id].per) * SHARE_PACK[id].per;
  const sharesForSale = (id: MerchantId): number => MAX_PACKS * SHARE_PACK[id].per;
  const sharesToSell = (id: MerchantId): number => Math.min(sharesForSale(id), wholePacks(id, state.player.shares[id]));
  const maxQty = (id: MerchantId, tab: Tab): number => {
    const m = state.merchants[id];
    if (tab === "buy") { const g = goodFor(id, tab); return Math.min(MAX_QTY, m.stock[g], Math.floor(state.player.coins / Math.max(1, buyUnit(id)))); }
    if (tab === "sell") { const p = sellPrice(id) ?? 1; return Math.min(MAX_QTY, state.player.inventory.mango, Math.floor(m.cash / p)); }
    const { price, per } = SHARE_PACK[id];
    return Math.min(sharesForSale(id), Math.floor(state.player.coins / price) * per);
  };
  const defaultTab = (id: MerchantId): Tab => {
    const tabs = tabsFor(id), i = stepIndex(state);
    if (id === investTarget(state) && i === 5 && tabs.includes("invest")) return "invest";
    if (tabs.includes("sell") && state.player.inventory.mango > 0 && (i === 3 || id !== "tomas")) return "sell";
    return tabs[0] ?? "buy";
  };
  const openTrade = (npc: Npc, id: MerchantId): void => {
    const tab = defaultTab(id);
    const q = Math.max(1, Math.min(3, maxQty(id, tab)));
    frame(npc);
    const closed = state.merchants[id].status !== "open";
    const newcomer = tab === "buy" && buyUnit(id) < priceOf(state, id).price;
    const say = id === "pema" && stepIndex(state) === 3 ? `Are those for me? ${DELIVERY_PRICE} coins each, as promised!`
      : newcomer ? `New in town? ${buyUnit(id)} c a mango, just this once. The board says ${priceOf(state, id).price}.`
      : closed ? VOICES[id].lines.closed : WHO[id].hello;
    mode = { kind: "trade", npc, id, tab, qty: q, say, tone: closed ? "bad" : "", why: false, h: null, done: 0 };
    speak(id, say);
    renderTrade();
    showPanel("trade");
    if (playerId()) void syncMerchants(); // offers follow the merchant's live wallet (re-renders when it lands)
  };
  const setTab = (tab: Tab): void => {
    if (mode.kind !== "trade" || mode.h) return;
    const pitch = tab === "invest" && mode.tab !== "invest" ? VOICES[mode.id].lines.invest_pitch : null;
    mode = { ...mode, tab, qty: Math.max(1, Math.min(3, maxQty(mode.id, tab))), why: false, ...(pitch ? { say: pitch, tone: "" as const } : {}) };
    if (pitch) void audio.line(mode.id, pitch); // one short pitch, no figures: the panel shows those
    renderTrade();
  };
  const setQty = (d: number): void => {
    if (mode.kind !== "trade" || mode.h || mode.done > 0) return;
    const step = mode.tab === "invest" ? SHARE_PACK[mode.id].per : 1;
    mode = { ...mode, qty: Math.max(step, Math.min(Math.max(step, maxQty(mode.id, mode.tab)), mode.qty + d * step)) };
    renderTrade();
  };

  const renderTrade = (): void => {
    if (mode.kind !== "trade") return;
    // an offer can vanish while the panel is open (a bid filled, a kitchen restocked): never show a dead tab
    if (!mode.h && mode.done <= 0 && !tabsFor(mode.id).includes(mode.tab)) mode = { ...mode, tab: defaultTab(mode.id), qty: 1 };
    const { id, tab, h } = mode;
    const m = state.merchants[id];
    hud.panel.innerHTML = "";
    hud.panel.append(head(PERSONALITY[id].name, WHO[id].role, WHO[id].color));
    hud.panel.append(el("div", `tp-say ${mode.tone}`, mode.say));
    if (h) { renderHaggleBody(h); return; }
    if (m.status !== "open") hud.panel.append(reopenMeter(id));
    const tabs = tabsFor(id);
    if (tabs.length > 1) {
      const t = el("div", "tp-tabs");
      for (const x of tabs) t.append(button(x === "buy" ? "Buy" : x === "sell" ? "Sell" : "Invest", tab === x ? "on" : "", () => setTab(x)));
      hud.panel.append(t);
    }
    if (tab === "invest") { renderInvestBody(id); return; }
    if (tab !== "sell" && state.player.inventory.mango > 0 && sellPrice(id) === null && (id === "arin" || id === "pema" || m.status !== "open")) {
      hud.panel.append(el("div", "tp-text tp-note", `${PERSONALITY[id].name.split(" ").pop()} isn't buying mangoes this minute: ${id === "arin" ? "the kitchen is stocked" : "the shelves are full"}. Bids come back as stock sells; try again in a few minutes or sell elsewhere.`));
    }
    const good = goodFor(id, tab);
    const unit = tab === "buy" ? buyUnit(id) : sellPrice(id) ?? 0;
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
        // The merchant says it in their own words, from facts read on NEAR (NEAR AI when available, else scripted).
        const first = PERSONALITY[id].name.split(" ").pop();
        if (asked?.id === id) {
          hud.panel.append(el("div", "tp-say", `“${asked.line}”`));
          if (asked.ai) hud.panel.append(el("div", "tp-text tp-note", "Answered by NEAR AI from the stall's live numbers."));
        } else if (playerId()) {
          const ask = button(asking ? `${first} is thinking…` : `Ask ${first}`, "tp-why", () => { void askWhy(id); });
          ask.disabled = asking;
          hud.panel.append(ask);
        }
      }
    }
    const total = unit * mode.qty;
    const after = tab === "buy" ? state.player.coins - total : state.player.coins + total;
    if (max > 0 && mode.done <= 0) { // hidden while a result shows: "coins after" would describe the next deal
      const q = el("div", "tp-qty");
      q.append(button("−", "", () => setQty(-1)), el("b", "", String(mode.qty)), button("+", "", () => setQty(1)));
      const note = el("span", "", `${tab === "buy" ? "Pay" : "Get"} ${total} c\nYour coins after: ${after} c`);
      note.style.whiteSpace = "pre-line";
      q.append(note);
      hud.panel.append(q);
    }
    const acts = el("div", "tp-acts");
    if (mode.done > 0) { /* the result line is showing */ }
    else if (max <= 0) acts.append(el("div", "tp-text full", tab === "buy" ? (m.stock[good] <= 0 ? "Sold out for now." : `You need ${unit} c for one. You have ${state.player.coins} c.`) : (state.player.inventory.mango <= 0 ? "You have no mangoes to sell. Buy some first." : `${PERSONALITY[id].name.split(" ").pop()} has ${Math.floor(m.cash)} c, not enough for one at ${unit} c. The Market Guild lends low tills coins within a minute or two: come back soon, or sell to another stall.`)));
    else {
      acts.append(button(`${tab === "buy" ? "Buy" : "Sell"} ${goodName(good, mode.qty)} for ${total} c`, "primary", () => simpleDeal(), "1"));
      if (unlocked(state, "haggle") && m.status === "open" && modeFor(state, id) === tab && good === "mango") {
        const shut = isLocked(state, id) && !(stepIndex(state) === HAGGLE_STEP && id === tutorSeller(state));
        const hb = button("Haggle", "full", () => startHaggle(), "2", shut ? "not again today: you pushed too hard" : "try for a better price");
        hb.disabled = shut;
        acts.append(hb);
      }
    }
    acts.append(button("Leave", "ghost full", () => endPanel(), "Esc"));
    hud.panel.append(acts);
  };

  let asked: { id: MerchantId; line: string; ai: boolean } | null = null, asking = false;
  const askWhy = async (id: MerchantId): Promise<void> => {
    if (asking) return;
    asking = true; renderTrade();
    const r = await askMerchant(id);
    asking = false;
    asked = r ? { id, ...r } : { id, line: "Not now, I'm busy with customers.", ai: false };
    if (mode.kind === "trade" && mode.id === id) { renderTrade(); void audio.line(id, asked.line); }
  };

  /** Closed stall: how far its shelves are from reopening (stock is the only thing that reopens it). */
  const reopenMeter = (id: MerchantId): HTMLDivElement => {
    const m = state.merchants[id], gap = reopenGap(state, id), total = state.flags[`reopenTotal.${id}`];
    // connected: the contract's own count of mangoes delivered since it closed; offline: the shelves' value
    const need = typeof total === "number" ? total : Math.ceil((m.rent * REOPEN_SHARE) / Math.max(1, m.baseCost.mango)), have = Math.max(0, need - gap);
    const d = el("div", "tp-pat");
    d.append(el("span", "", typeof total === "number" ? `Closed · ${have} of ${need} mangoes delivered: ${gap} more reopens the stall` : `Closed · restock to reopen: ${have} of ${need} mangoes' worth on the shelves`));
    const bar = el("i"), fill = el("b");
    fill.style.width = `${Math.round((have / need) * 100)}%`;
    bar.append(fill); d.append(bar);
    return d;
  };

  const renderInvestBody = (id: MerchantId): void => {
    if (mode.kind !== "trade") return;
    const m = state.merchants[id], { price, backing, per } = SHARE_PACK[id], own = state.player.shares[id], coins = state.player.coins;
    const max = maxQty(id, "invest"), canSell = sharesToSell(id), supply = shareSupply(state, id);
    const pct = (k: number, of = supply): string => `${((k / of) * 100).toFixed(1).replace(/\.0$/, "")}%`;
    const packs = (n: number): string => `${n} ${n === 1 ? "share" : "shares"}`;
    hud.panel.append(el("div", "tp-text", `Half of every sale ${m.shop} makes is shared out, at that moment, over all ${supply} shares: you earn only from sales made while you hold. A pack of ${per} costs ${price} c: ${backing} c is held in the stall's reserve, so you can always sell the pack back for ${backing} c, and ${price - backing} c goes into the till.`));
    const facts = el("div", "tp-facts");
    const fact = (label: string, value: string): void => { const d = el("div"); d.append(el("span", "", label), el("b", "", value)); facts.append(d); };
    fact("Price", `${price} c per ${per}`);
    fact("Sells back for", `${backing} c per ${per}`);
    fact("Your coins", `${coins} c`);
    fact("You own", `${own} of ${supply} · ${pct(own)}${own >= UPGRADE_AT ? " · upgraded" : ""}`);
    hud.panel.append(facts);
    const acts = el("div", "tp-acts");
    if (mode.done > 0) { /* the result line is showing */ }
    else if (max <= 0) acts.append(el("div", "tp-text full", `A pack of ${per} costs ${price} c and you have ${coins} c. Sell some goods first, then come back.`));
    else {
      const qty = Math.max(per, Math.min(max, wholePacks(id, mode.qty) || per));
      if (qty !== mode.qty) mode = { ...mode, qty };
      const q = el("div", "tp-qty tp-shares");
      const input = el("input") as HTMLInputElement;
      Object.assign(input, { type: "number", min: String(per), max: String(max), step: String(per), value: String(qty), inputMode: "numeric" });
      input.setAttribute("aria-label", "Number of shares");
      const total = el("b"), after = el("span"), stake = el("div", "tp-stake"), bar = el("i"), fill = el("b"), mine = el("b", "mine"), line = el("span");
      bar.append(mine, fill); stake.append(bar, line);
      const buy = button("", "primary", () => investIn(id, mode.kind === "trade" ? mode.qty : qty), "1");
      const label = document.createTextNode(""); buy.childNodes[1]?.replaceWith(label);
      const minus = button("−", "", () => setQty(-1)), plus = button("+", "", () => setQty(1));
      const show = (n: number): void => {
        minus.disabled = n <= per; plus.disabled = n >= max;
        total.textContent = `${shareCost(id, n)} c`;
        after.textContent = `${n / per} × ${price} c · your coins after: ${coins - shareCost(id, n)} c`;
        mine.style.width = pct(own);
        fill.style.width = pct(n);
        const next = Math.max(supply, own + n); // past the unsold float, new shares are issued
        line.textContent = `You'd own ${own + n} of ${next} shares: ${pct(own + n, next)} of every sale's payout.`;
        label.textContent = `Buy ${packs(n)} for ${shareCost(id, n)} c`;
      };
      const pick = (n: number): number => Math.max(per, Math.min(max, wholePacks(id, n) || per));
      input.oninput = () => {
        const n = Number(input.value);
        if (input.value === "" || !Number.isFinite(n)) return; // mid-edit: keep the last valid choice
        const v = pick(n);
        if (mode.kind === "trade") mode = { ...mode, qty: v };
        show(v);
      };
      input.onchange = () => { const v = pick(Number(input.value) || per); input.value = String(v); if (mode.kind === "trade") mode = { ...mode, qty: v }; show(v); };
      input.onkeydown = (e) => { if (e.key === "Enter") { input.blur(); buy.click(); } };
      const all = button(`Max ${max}`, "ghost tp-max", () => { if (mode.kind === "trade") { mode = { ...mode, qty: max }; renderTrade(); } });
      const sum = el("div", "tp-sum");
      sum.append(total, after);
      q.append(minus, input, plus, all, sum);
      hud.panel.append(q, stake);
      acts.append(buy);
      show(qty);

    }
    if (mode.done <= 0 && canSell > 0) acts.append(button(`Sell ${packs(canSell)} back for ${shareRefund(id, canSell)} c`, "full", () => cashOut(id, canSell), "2"));
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
    if (stepIndex(state) === HAGGLE_STEP && mode.id === tutorSeller(state)) delete state.flags[lockKey(mode.id)];
    const h = openHaggle(state, mode.id);
    if ("error" in h) { mode = { ...mode, say: h.error, tone: "bad" }; renderTrade(); return; }
    const qty = Math.max(1, Math.min(mode.qty, h.qty));
    mode = { ...mode, h: { ...h, qty }, say: "Let's talk, then. My patience runs out while you think.", tone: "" };
    void audio.line(mode.id, mode.say);
    renderTrade();
  };

  const simpleDeal = (): void => {
    if (mode.kind !== "trade" || mode.done > 0) return;
    const { id, tab } = mode;
    const unit = tab === "buy" ? buyUnit(id) : sellPrice(id);
    if (!unit || maxQty(id, tab) < 1) return;
    const qty = Math.min(mode.qty, maxQty(id, tab));
    settleDeal({ merchant: id, good: goodFor(id, tab), mode: tab === "buy" ? "buy" : "sell", qty, unit, open: unit, limit: unit, patience: 100, used: {}, moves: 0, over: "deal" });
  };

  /** A closed deal (simple or haggled): checked on a copy, sent to NEAR, and only applied once NEAR confirms it. */
  const settleDeal = (h: HaggleSession): void => {
    if (mode.kind !== "trade") return;
    const preview = closeDeal(structuredClone(state), h); // the game's own checks and totals, nothing moved yet
    if (!preview.ok) { mode = { ...mode, h: null, say: preview.message, tone: "bad", done: RESULT_HOLD }; renderTrade(); return; }
    const unit = dealUnit(h), total = preview.total; // whole coins per unit: exactly what the contract settles
    const name = PERSONALITY[h.merchant].name, npc = mode.npc;
    mode = { ...mode, h: null, say: `Shaking on it: ${total} c. Recording the deal…`, tone: "", done: AWAITING };
    renderTrade();
    record("trade", `${h.mode === "buy" ? "Bought" : "Sold"} ${goodName(h.good, h.qty)} ${h.mode === "buy" ? "from" : "to"} ${name} for ${total} c`,
      haggleDeal(h.merchant, h.mode, h.good, h.qty, unit), () => applyDeal(h, npc), refusedAt(h.merchant, h.mode));
  };
  /** NEAR settled the deal: move the goods and coins in the game, then react (story beats, reopened stalls). */
  const applyDeal = (h: HaggleSession, npc: Npc): void => {
    const out = closeDeal(state, h); // if the local copy was stale this moves nothing; the chain re-read fixes it
    const total = out.total;
    if (h.mode === "sell") { const s = screenOf(npc.head); hud.coins(s.x, s.y, Math.max(4, total)); }
    let say = WHO[h.merchant].thanks;
    const i = stepIndex(state);
    if (h.mode === "buy" && h.merchant === tutorSeller(state) && i === 2) { state.flags.boughtTomas = true; state.flags.tutCost = total; say = "There you go. Don't tell Pema where you got them."; }
    if (h.mode === "sell" && h.merchant === "pema" && i === 3) {
      state.flags.deliveredPema = true;
      const cost = Number(state.flags.tutCost ?? total);
      say = `Bought for ${cost} c, sold for ${total} c: you made ${total - cost} c. And look at my shelves!`;
      market.say("pema", "You saved my morning, Kavi!", 4);
    }
    if (h.mode === "buy" && h.moves > 0) { state.flags.haggled = true; if (out.gain > 0) say = `${out.gain} c cheaper than the first offer. Nicely done.`; }
    if (h.mode === "sell" && h.merchant === "arin") state.flags.soldArin = true;
    if (h.mode === "sell" && h.moves > 0 && out.gain > 0) say = `${out.gain} c more than the first offer.`;
    if (h.mode === "sell") recordRestock(state, h.merchant, h.qty);
    if (h.mode === "sell" && tryReopen(state, h.merchant)) {
      // the delivery put the shelves over the line: the stall opens again right now (undone with the trade if refused)
      say = "That's enough stock to open again. The shutters are going up!";
      market.say(h.merchant, "We're open again, thanks to you!", 4);
      hud.toast(`${state.merchants[h.merchant].shop} reopened`, true);
      state.player.rep[h.merchant] += 3;
      state.flags.reopenedStall = true;
    } else if (h.mode === "sell" && state.merchants[h.merchant].status !== "open") {
      const gap = reopenGap(state, h.merchant);
      say = `Thank you. ${gap} more ${gap === 1 ? "mango" : "mangoes"} and I can open again.`;
    }
    const reopened = say.startsWith("That's enough stock");
    void audio.sfx(reopened ? "reopen" : "deal");
    speak(h.merchant, reopened ? VOICES[h.merchant].lines.reopen : say);
    if (mode.kind === "trade" && mode.id === h.merchant) { mode = { ...mode, h: null, say, tone: "good", done: RESULT_HOLD }; renderTrade(); }
    drawBoards();
    afterProgress();
    save();
  };

  // ---------------------------------------------------------------- talking ----
  const ctx: DialogueContext = {
    econ: state,
    toast: (t) => hud.toast(t),
    settle: (kind, detail) => settle(kind, `${kind.replace(/-/g, " ")}: ${Object.entries(detail).map(([k, v]) => `${k} ${v}`).join(", ")}`),
  };
  let lastTalk = "";
  const renderTalk = (): void => {
    if (mode.kind !== "talk") return;
    const { convo } = mode;
    const node = convo.nodes[mode.node];
    hud.panel.innerHTML = "";
    hud.panel.append(head(node.speaker, convo.role, convo.accent || "#5f7280"));
    const said = node.text(state);
    hud.panel.append(el("div", "tp-say", said));
    if (said !== lastTalk) { lastTalk = said; void audio.line(mode.npc.id, said); } // each new line once, never on re-render
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
  };
  const openTalk = (npc: Npc, convo?: Conversation): void => {
    const c = convo ?? CONVERSATIONS[npc.id];
    if (!c) return;
    if (mode.kind !== "talk") frame(npc);
    mode = { kind: "talk", npc, convo: c, node: c.entry(state) };
    renderTalk();
    showPanel("talk");
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
    hud.card.innerHTML = "";
    document.body.classList.add("card-open");
    build(hud.card);
    hud.back.style.display = "block";
    hud.card.style.display = "block";
    hud.card.scrollTop = 0;
  };
  /** Runs once if the open card is closed any other way than its own buttons (Esc): a choice card counts it as cancel. */
  let onCardDismiss: (() => void) | null = null;
  const closeOverlay = (): void => {
    const dismissed = onCardDismiss;
    onCardDismiss = null;
    dismissed?.();
    hud.card.style.display = "none";
    hud.back.style.display = "none";
    document.body.classList.remove("card-open");
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
      STEPS.forEach((st, k) => { const g = el("div", `goal${k < i ? " done" : k === i ? " now" : ""}`); g.append(el("i"), el("span", "", titleOf(st, state))); sec.append(g); });
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
      for (const id of MERCHANT_IDS) if (p.shares[id]) slot("share", `${p.shares[id]}/${shareSupply(state, id)}`, `shares of ${state.merchants[id].shop}`);
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
        "Shares pay you part of every sale a stall makes while you hold them. Haggling can save a few coins, but impatient merchants walk away."]) tips.append(el("li", "", x));
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
      const [bal, turn] = await Promise.all([balances(id).catch(() => ({})), lastMarketTurn()]);
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
      if (turn) { // the city keeps trading on NEAR when nobody is playing
        const mins = Math.max(0, Math.round((Date.now() - turn.at) / 60000));
        sec.append(el("p", "", `Last market turn: ${mins < 1 ? "under a minute" : `${mins} min`} ago, market day ${turn.day} (${turn.txs} transactions${turn.failed ? `, ${turn.failed} refused` : ""}).`));
      }
      hud.card.append(sec);

      await moneyTrail(id);
    }
    yourMoves();
    footer(hud.card, "Back to the city", closeOverlay);
  };

  // ---------------------------------------------------------------- money trail ----
  /** Who's who on the trail: merchants and residents by name, this browser's account as "you". */
  const whoIs = (acct: string, me: string | null): string => {
    if (acct === me) return "You";
    const short = acct.split(".")[0];
    const r = RESIDENTS.find((x) => x.id === short);
    if (r) return `${r.name} (${r.job})`;
    return state.merchants[short as MerchantId]?.name ?? (acct.endsWith(".testnet") && short.startsWith("g") ? "another player" : short);
  };
  /** Payments recorded by the market contract (read-only, just now): every sale is someone paying someone, in the
   *  order NEAR recorded them. Coins are interchangeable, so this is a trail of payments, not of one coin. */
  const moneyTrail = async (me: string): Promise<void> => {
    const people = [me, ...TRADERS.map((m) => merchantAccount(m)), ...RESIDENTS.map((r) => merchantAccount(r.id))];
    const [lists, tills] = await Promise.all([
      Promise.all(people.map((a) => chainReceipts(a).then((l) => l.map((x) => ({ ...x, owner: a }))).catch(() => []))),
      Promise.all(TRADERS.map((m) => balances(merchantAccount(m)).catch(() => null))),
    ]);
    const seen = new Set<string>();
    const sales = lists.flat().filter((x) => x.kind === "sold").filter((x) => {
      const k = `${x.block_height}|${x.owner}|${x.counterparty}|${x.token_id}|${x.qty}`;
      return seen.has(k) ? false : (seen.add(k), true);
    }).sort((a, b) => b.block_height - a.block_height).slice(0, TRAIL_ROWS);
    const sec = el("section");
    sec.append(el("h4", "", "Money trail · verified on NEAR"));
    sec.append(el("p", "tp-note", "Who paid whom, read from the market contract just now, newest first. Coins are interchangeable, so this follows payments, not one coin."));
    if (!sales.length) sec.append(el("p", "", "No sales recorded yet."));
    const ul = el("ul");
    for (const x of sales) {
      const payer = whoIs(x.counterparty, me), payee = whoIs(x.owner, me), total = Number(x.qty) * Number(x.price);
      const li = el("li");
      li.append(document.createTextNode(`${payer} paid ${payee} ${total} c for ${x.qty} ${x.token_id}${Number(x.qty) === 1 ? "" : "s"} `), el("span", "tp-note", `(block ${x.block_height}) `));
      const show = button("Show", "tp-why", () => { closeOverlay(); drawTrail(x.counterparty, x.owner, me); });
      li.append(show);
      ul.append(li);
    }
    sec.append(ul);
    const t = el("p");
    t.textContent = `Tills on NEAR: ${TRADERS.map((m, i) => `${state.merchants[m].name.split(" ").pop()} ${tills[i]?.coin ?? "?"} c`).join(" · ")}`;
    sec.append(t);
    const links = el("p", "tp-note"); links.append(document.createTextNode("Check any account: "));
    const accounts: [string, string][] = [
      [`You (${me})`, me],
      ...TRADERS.map((m): [string, string] => [state.merchants[m].name.split(" ").pop() ?? m, merchantAccount(m)]),
      ...RESIDENTS.map((r): [string, string] => [`${r.name} the ${r.job}`, merchantAccount(r.id)]),
    ];
    accounts.forEach(([label, acct], i) => { const a = el("a", "", label); a.href = `${EXPLORER_ACCOUNT}${acct}`; a.target = "_blank"; a.rel = "noopener"; links.append(a, document.createTextNode(i < accounts.length - 1 ? " · " : "")); });
    sec.append(links);
    // honest about autonomy: say whether the city has been trading on its own (a recent turn nobody here triggered)
    sec.append(el("p", "tp-note", "Merchants and residents act in market turns. A turn runs while someone is playing; the 5-minute background schedule is not switched on yet."));
    hud.card.append(sec);
  };
  /** This session's own moves, each saying plainly whether NEAR has it. */
  const yourMoves = (): void => {
    const rows = [...state.receipts].reverse().slice(0, 6);
    if (!rows.length) return;
    const LABEL: Record<Receipt["status"], string> = { onchain: "Verified on NEAR", pending: "Waiting for NEAR", unconfirmed: "Not confirmed yet: re-reading NEAR", failed: "Refused by NEAR, nothing moved", local: "Offline only, not on NEAR" };
    const sec = el("section"); sec.append(el("h4", "", "Your recent moves"));
    const ul = el("ul");
    for (const r of rows) {
      const li = el("li"); li.append(document.createTextNode(`${r.summary} · ${r.message === "story event" ? "Story event, not a trade" : LABEL[r.status]} `));
      if (r.txHash) { const a = el("a", "", "view transaction"); a.href = `${EXPLORER_TX}${r.txHash}`; a.target = "_blank"; a.rel = "noopener"; li.append(a); }
      ul.append(li);
    }
    sec.append(ul); hud.card.append(sec);
  };
  /** A gold arc in the city from the payer to the payee (where both stand), fading after a few seconds. */
  let trail: THREE.Mesh | null = null, trailTimer = 0;
  const placeOf = (acct: string, me: string | null): THREE.Vector3 | null => {
    if (acct === me) return player.root.position.clone();
    const short = acct.split(".")[0];
    const mer = market.npcs.find((n) => n.id === short);
    if (mer) return mer.root.position.clone();
    const ri = RESIDENTS.findIndex((r) => r.id === short);
    const folk = (window as unknown as { __npcs?: { fixed: boolean; x: number; y: number; z: number }[] }).__npcs?.filter((e) => !e.fixed)[ri];
    return ri >= 0 && folk ? new THREE.Vector3(folk.x, folk.y, folk.z) : null;
  };
  const drawTrail = (payer: string, payee: string, me: string | null): void => {
    const a = placeOf(payer, me), b = placeOf(payee, me);
    if (trail) { trail.removeFromParent(); trail.geometry.dispose(); trail = null; }
    if (!a || !b) { hud.toast(`${whoIs(payer, me)} isn't in town right now, so there's nothing to point at.`); return; }
    a.y += 1.6; b.y += 1.6;
    const mid = a.clone().lerp(b, 0.5); mid.y += Math.max(2, a.distanceTo(b) * 0.3);
    const curve = new THREE.QuadraticBezierCurve3(a, mid, b);
    trail = new THREE.Mesh(new THREE.TubeGeometry(curve, 48, 0.06, 6), new THREE.MeshBasicMaterial({ color: "#ffd166", toneMapped: false }));
    game.look.scene.add(trail);
    trailTimer = TRAIL_SEC;
    hud.toast(`${whoIs(payer, me)} → ${whoIs(payee, me)}`, true);
  };
  game.onUpdate.push((dt) => {
    if (!trail) return;
    trailTimer -= dt;
    if (trailTimer <= 0) { trail.removeFromParent(); trail.geometry.dispose(); trail = null; }
  });

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
    const shut = TRADERS.filter((id) => state.merchants[id].status !== "open").map((id) => state.merchants[id].shop);
    if (!lines.length) lines.push(shut.length ? `A quiet stretch: prices held, and ${shut.join(" and ")} ${shut.length === 1 ? "is" : "are"} still closed.` : "A quiet stretch: every stall stayed open and prices held.");
    for (const l of lines.slice(0, 4)) city.append(el("p", "", l));
    card.append(city);
    // 2. your part
    const part = el("section"); part.append(el("h4", "", "Your part"));
    const owned = TRADERS.filter((id) => state.player.shares[id] > 0);
    if (owned.length) for (const id of owned) part.append(el("p", "", `You own ${state.player.shares[id]} of ${shareSupply(state, id)} shares in ${state.merchants[id].shop}${state.merchants[id].status === "open" ? ", which stayed open" : ", which is closed for now: it reopens once its shelves are stocked again"}.`));
    else part.append(el("p", "", "You don't own any stall shares yet. Partners earn from every sale the stall makes."));
    if (state.player.rep.pema >= 10) part.append(el("p", "", "Pema counts you as a regular: she gives you her family price."));
    card.append(part);
    // 3. your purse
    const purse = el("section"); purse.append(el("h4", "", "Your purse"));
    const d = state.player.coins - from.coins, div = divsOf(state) - from.divs;
    purse.append(el("div", `big ${d >= 0 ? "pos" : "neg"}`, `${d >= 0 ? "+" : ""}${d} c`));
    purse.append(el("p", "", `From ${from.coins} c to ${state.player.coins} c${div > 0 ? `, including ${div} c in dividends from your shares` : ""}.`));
    // the week ran on this device; the wallet is the chain's, which only pays for real market days
    const real = week && playerId() ? el("p", "why", "A forecast: this week ran on your device from today's real market. Checking your real purse…") : null;
    if (real) purse.append(real);
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
      const near = el("details"); near.append(el("summary", "", "Dividends"));
      const line = el("p", "why", "Paying out today's dividends…"); near.append(line); card.append(near);
      void settleDay().then(async (r) => {
        if (playerId()) await claimDividends(playerId()!);
        const got = (await chainReceipts(playerId()!).catch(() => [])).filter((x) => x.kind === "dividend").reduce((n, x) => n + Number(x.qty), 0);
        line.textContent = r.status === "onchain" ? `Dividends are paid sale by sale, and today's books are closed for all four stalls. Paid to you so far: ${got} c. ` : `Dividends: ${String(r.message ?? "not available right now")}`;
        const id = playerId();
        if (id) await syncPlayer(id);
        if (real) real.textContent = `A forecast: this week ran on your device from today's real market. Your purse holds ${state.player.coins} c right now; real dividends land there with every sale the stall makes (claimed each market turn).`;
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
    if (reward) { hud.toast(reward, true); void audio.sfx("step_done"); }
    if (Number(state.flags.tut ?? 0) >= STEPS.length && !state.flags.tutDone) {
      state.flags.tutDone = true;
      hud.toast("First day done. New goals are in your notebook (J).", true);
    }
    walletKey = "";
  };
  const showWelcome = (): void => openCard((card) => {
    card.append(el("h2", "", "Welcome to NEAR City"));
    const s = el("section");
    s.append(el("p", "", `You're ${typeof state.flags.name === "string" ? state.flags.name : "Kavi"}, new in town with ${STARTER_COINS} coins in your pocket.`));
    s.append(el("p", "", "The market square ahead runs on trade. Four merchants buy and sell all day, each with their own till. Prices move with every crate."));
    s.append(el("p", "", "Auntie Pema's fruit stall is in trouble. Go and see her."));
    card.append(s);
    footer(card, "Let's go", () => { state.flags.welcomed = true; closeOverlay(); save(); });
  });

  // ---------------------------------------------------------------- clock ----
  /** Ends a fast-forward with its report. A forecast puts the real (chain) city back once the report is drawn:
   *  only the clock and the lesson keep moving. */
  const endFastForward = (stopped: boolean): void => {
    if (!ff) return;
    const { from, real } = ff;
    ff = null;
    showReport(real ? (stopped ? "Forecast stopped" : "Your week ahead: a forecast") : stopped ? "Fast-forward stopped" : "Your week in NEAR City", from, true);
    if (!real) return;
    const keep = { tut: state.flags.tut, weekSeen: state.flags.weekSeen, welcomed: state.flags.welcomed };
    for (const id of TRADERS) Object.assign(state.merchants[id], real.merchants[id]);
    Object.assign(state.player, real.player);
    state.log.splice(0, state.log.length, ...real.log);
    state.shipments.splice(0, state.shipments.length, ...real.shipments);
    for (const k of Object.keys(state.flags)) delete state.flags[k];
    Object.assign(state.flags, real.flags, keep);
    mark = snap(state);
    drawBoards(); walletKey = ""; save();
  };
  /** Rent Night (21:00): before the evening report the camera holds on the market for a few seconds while each
   *  merchant says where they stand, from their actual till and rent (and the chain's open/closed when connected). */
  const RENT_HOLD_SEC = 5;
  let rentHold = 0, rentDone: (() => void) | null = null;
  /** Each line opens with the merchant's recorded phrase (rent_ok / rent_risk / rent_closed), then the live numbers. */
  const rentLine = (id: MerchantId): { line: LineId; text: string } => {
    const m = state.merchants[id], v = VOICES[id].lines;
    if (m.status !== "open") { // closed by unpaid rent; deliveries reopen it (the contract's rule)
      const need = Number(state.flags[`reopenNeed.${id}`] ?? 0);
      return { line: "rent_closed", text: `${v.rent_closed} Rent went unpaid.${need > 0 ? ` ${need} more mangoes and I can reopen.` : ""}` };
    }
    return m.cash >= m.rent
      ? { line: "rent_ok", text: `${v.rent_ok} ${m.cash} c in the till, the ${m.rent} c rent is covered.` }
      : { line: "rent_risk", text: `${v.rent_risk} Only ${m.cash} c in the till and rent is ${m.rent} c.` };
  };
  const rentNight = (done: () => void): void => {
    drawBoards();
    rentHold = RENT_HOLD_SEC; rentDone = done;
    player.frozen = true;
    const lines = TRADERS.map((id) => ({ id, ...rentLine(id) }));
    for (const l of lines) market.say(l.id, l.text, RENT_HOLD_SEC);
    // every merchant speaks their bubble in turn (market.say queues them), after the bell
    void audio.sfx("rent_bell");
  };
  const rentEye = new THREE.Vector3(), rentAt = new THREE.Vector3();
  game.onUpdate.push((dt) => { // runs after the rig: it owns the camera while the stalls are lit up
    if (rentHold <= 0) return;
    rentHold -= dt;
    const stalls = market.npcs.filter((n) => (TRADERS as readonly string[]).includes(n.id));
    rentAt.set(0, 0, 0);
    for (const n of stalls) rentAt.add(n.root.position);
    rentAt.divideScalar(Math.max(1, stalls.length)).setY(1.4);
    rentEye.copy(rentAt).add(new THREE.Vector3(0, 6.5, 15));
    rig.camera.position.copy(rentEye);
    rig.camera.lookAt(rentAt);
    if (rentHold <= 0 && rentDone) { const d = rentDone; rentDone = null; player.frozen = false; d(); }
  });
  /** Where an objective points: a merchant at their stall, or the Mango Orchard sign. */
  const targetAt = (id: Target): THREE.Vector3 | null => (id === "orchard" ? game.look.scene.getObjectByName("PLACARD_orchard")?.getWorldPosition(new THREE.Vector3()) ?? null : market.npcs.find((n) => n.id === id)?.root.position ?? null);

  // ---------------------------------------------------------------- city map ----
  const cityMap = createCityMap({
    scene: game.look.scene, colliders: game.colliders,
    player: () => ({ x: player.body.x, z: player.body.z, heading: player.heading }),
    objective: () => { const o = guide.current(state); return o?.target ? targetAt(o.target) : null; },
    merchants: () => TRADERS.flatMap((id) => { const n = market.npcs.find((x) => x.id === id); return n ? [{ name: state.merchants[id].name, at: n.root.position }] : []; }),
    allowed: () => mode.kind === "walk" && !play.paused && !ff,
    setFrozen: (on) => { player.frozen = on; game.input.setUi(on); },
  });

  // ---------------------------------------------------------------- orchard ----
  /** The Mango Orchard (west of the Spire): a few free mangoes each morning, minted on NEAR once per market day,
   *  to carry to whoever bids best. The rule lives in pricing.ts (ORCHARD_PICK, ORCHARD_HOURS). */
  let orchardAt: THREE.Vector3 | null = null, picking = false;
  const atOrchard = (): boolean => {
    orchardAt ??= game.look.scene.getObjectByName("PLACARD_orchard")?.getWorldPosition(new THREE.Vector3()) ?? null; // town loads async
    return orchardAt !== null && Math.hypot(player.body.x - orchardAt.x, player.body.z - orchardAt.z) < ORCHARD_REACH_M;
  };
  const orchardOpen = (): boolean => { const h = (state.minute % MINUTES_PER_DAY) / 60; return h >= ORCHARD_HOURS[0] && h < ORCHARD_HOURS[1]; };
  const pickAtOrchard = async (): Promise<void> => {
    if (picking) return;
    if (!orchardOpen()) { hud.toast(`The pickers have finished for today. Come back between ${String(ORCHARD_HOURS[0]).padStart(2, "0")}:00 and ${ORCHARD_HOURS[1]}:00.`); return; }
    const id = playerId();
    // One period, the same as the relayer's: connected, the on-chain market day; offline, the game day.
    const md = id ? marketDay() : null;
    const today = md !== null ? `m${md}` : `g${dayOf(state.minute)}`;
    if (state.flags.orchardDay === today) { hud.toast(`You've picked your share ${md !== null ? "this market day" : "today"}. The trees need a rest.`); return; }
    picking = true;
    const r = id ? await pickOrchard(id) : { status: "local" };
    picking = false;
    if (r.status === "picked") { state.flags.orchardDay = today; hud.toast("You've picked your share this market day. The trees need a rest."); return; }
    if (r.status !== "onchain" && r.status !== "local") { hud.toast("The orchard gate is stuck. Try again in a moment."); audio.synth("error"); return; }
    state.flags.orchardDay = today; state.flags.pickedOrchard = true;
    state.player.inventory.mango += ORCHARD_PICK; // NEAR minted them; the next wallet read confirms it
    const best = TRADERS.map((m) => ({ m, b: bidFor(state, m, "mango") })).filter((x) => x.b).sort((a, b) => b.b!.price - a.b!.price)[0];
    hud.toast(`+${ORCHARD_PICK} mangoes, picked fresh.${best ? ` ${state.merchants[best.m].name} pays the most for them: ${best.b!.price} c each.` : ""}`, true);
    const tx = typeof r.txHash === "string" ? r.txHash : undefined; // minted on NEAR (offline: a local pick, labelled so)
    state.receipts.push({ id: `orchard-${state.minute}`, kind: "orchard", minute: state.minute, summary: `Picked ${ORCHARD_PICK} mangoes at the orchard`, status: tx ? "onchain" : "local", txHash: tx });
    save();
    if (id) void syncPlayer(id);
  };

  // ---------------------------------------------------------------- sound ----
  /** Voice a merchant line only when the text on screen is one of their recorded lines (audio matches subtitles). */
  const speak = (id: MerchantId, text: string): void => { void audio.line(id, text); }; // recorded, or voiced by the server
  const marketAt = new THREE.Vector3();
  let soundIn = 0, stepDist = 0;
  /** Music and ambience by time and place (checked once a second), and footsteps by distance walked. */
  const ears = new THREE.Vector3();
  const soundscape = (dt: number): void => {
    rig.camera.getWorldDirection(ears);
    audio.listen(rig.camera.position.x, rig.camera.position.y, rig.camera.position.z, ears.x, ears.z);
    if (!play.paused && player.body.grounded && player.speed > 0.6) {
      stepDist += player.speed * dt;
      if (stepDist > STEP_EVERY_M) { stepDist = 0; audio.step(); }
    }
    soundIn -= dt;
    if (soundIn > 0) return;
    soundIn = 1;
    const traders = market.npcs.filter((n) => (TRADERS as readonly string[]).includes(n.id));
    marketAt.set(0, 0, 0);
    for (const n of traders) marketAt.add(n.root.position);
    marketAt.divideScalar(Math.max(1, traders.length));
    const h = (state.minute % MINUTES_PER_DAY) / 60;
    const night = h >= 21.5 || h < 5, sunset = h >= 17 && !night;
    const nearMarket = Math.hypot(player.body.x - marketAt.x, player.body.z - marketAt.z) < MARKET_SOUND_M;
    audio.music(!entered ? "title" : night ? "night" : sunset ? "sunset" : nearMarket ? "market" : "day");
    audio.ambience(night ? "night" : nearMarket ? "market" : "day");
    // a car passing close by (traffic.ts exposes its cars for playtests); one at a time, not every second
    carQuiet -= 1;
    const cars = (window as unknown as { __traffic?: { x: number; z: number; v: number; obj: THREE.Object3D }[] }).__traffic ?? [];
    if (entered && carQuiet <= 0 && cars.some((c) => c.obj.visible && c.v > 2 && Math.hypot(c.x - player.body.x, c.z - player.body.z) < CAR_SOUND_M)) {
      carQuiet = CAR_QUIET_SEC; void audio.sfx("car_pass");
    }
  };
  let carQuiet = 0;
  const runClock = (minutes: number): void => {
    let left = minutes;
    while (left > 1e-9) {
      const rent = nextRent(state.minute);
      const stepMin = Math.min(left, rent - state.minute);
      advance(state, stepMin);
      left -= stepMin;
      if (state.minute >= rent - 1e-6) {
        if (ff && state.minute >= ff.until) { endFastForward(false); return; }
        if (!ff && unlocked(state, "rent")) { const from = mark; rentNight(() => showReport(`Evening, Day ${dayOf(state.minute)}`, from, false)); return; }
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
    game.look.setTime(state.minute % MINUTES_PER_DAY); // day and night follow the game clock (the menu too)
    soundscape(dt);
    cityMap.update(dt);
    if (play.paused) return;
    playTime += dt;
    autosaveIn -= dt;
    if (autosaveIn <= 0) { autosaveIn = AUTOSAVE_SEC; save(); }
    state.flags.onchain = playerId() !== null && !ff; // connected: the chain runs the market (see chainLive)
    if (mode.kind === "walk" && rentHold <= 0) runClock(dt * (ff ? FF_MIN_PER_SEC : GAME_MIN_PER_SEC * (unlocked(state, "rent") ? 1 : TUTORIAL_CLOCK)));
    const hour = Math.floor(state.minute / 60);
    if (hour !== lastHour) { townHour(lastHour); lastHour = hour; drawBoards(); save(); }

    if (mode.kind === "trade" || mode.kind === "talk") {
      const npc = mode.npc;
      const want = Math.atan2(npc.root.position.x - player.root.position.x, npc.root.position.z - player.root.position.z) + 0.65;
      let d = want - rig.yaw; d = Math.atan2(Math.sin(d), Math.cos(d));
      const k = 1 - Math.exp(-6 * dt);
      rig.yaw += d * k;
      rig.pitch += (0.1 - rig.pitch) * k;
      rig.dist += (3.1 - rig.dist) * k;
    }
    if (mode.kind === "trade") {
      if (mode.done > 0) {
        mode = { ...mode, done: mode.done - dt };
        // a tutorial deal closes the panel so the next objective shows; a refusal stays open to try again
        if (mode.done <= 0) { mode = { ...mode, done: 0 }; if (inTutorial(state) && mode.tone !== "bad") endPanel(); else renderTrade(); }
      } else if (mode.h) {
        const h = tickPatience(mode.h, stepIndex(state) === HAGGLE_STEP ? dt * TUTORIAL_PATIENCE : dt);
        mode = { ...mode, h };
        if (h.over === "walked") {
          const out = closeDeal(state, h);
          mode = { ...mode, h: null, say: `${VOICES[mode.id].lines.refuse} ${out.message}`, tone: "bad", done: RESULT_HOLD };
          void audio.line(mode.id, mode.say);
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
    if (input.consumePress("KeyT") && unlocked(state, "week")) {
      if (mode.kind === "walk" || ff) play.fastForward();
      else if (mode.kind === "trade" || mode.kind === "talk") hud.toast("Step away from the stall first (Esc), then press T.");
    }
    if (mode.kind === "walk" && !ff) {
      if (input.consumePress("KeyB")) openNotebook("bag");
      else if (input.consumePress("KeyJ")) openNotebook("goals");
      else if (input.consumePress("KeyN")) openNotebook("near");
      else if (input.consumePress("KeyH")) openNotebook("help");
      else if (input.consumePress("KeyL") && !playerLabel() && socialAvailable()) void signIn();
    }
    tickIn -= dt;
    if (tickIn <= 0 && playerId()) {
      tickIn = TICK_EVERY_SEC;
      const me = playerId()!;
      void marketTick().then((t) => { hungry(t); return syncMerchants(); }).then(syncResidents).then(() => claimDividends(me)).then((r) => {
        if (Number(r.coins) > 0 && r.status === "onchain") { hud.toast(`+${String(r.coins)} c in dividends from your stall shares`, true); void audio.sfx("coin_big"); }
        return syncPlayer(me); // every turn re-reads the wallet, so the purse can never drift from the chain for long
      });
    }
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
    if (!near && mode.kind === "walk" && !ff && atOrchard()) {
      hud.prompt.innerHTML = "";
      hud.prompt.append(el("kbd", "", "F"), el("span", "", orchardOpen() ? `Pick mangoes (${ORCHARD_PICK} a day)` : `Orchard · picking ${String(ORCHARD_HOURS[0]).padStart(2, "0")}:00 to ${ORCHARD_HOURS[1]}:00`));
      hud.prompt.style.display = "block";
    } else if (near) {
      const trader = TRADERS.includes(near.id as MerchantId);
      const name = trader ? PERSONALITY[near.id as MerchantId].name : CONVERSATIONS[near.id]?.name ?? near.id;
      const talkFirst = near.id === "pema" && stepIndex(state) <= 1;
      hud.prompt.innerHTML = "";
      hud.prompt.append(el("kbd", "", "F"), el("span", "", `${!trader || talkFirst ? "Talk to" : "Trade with"} ${name}`));
      hud.prompt.style.display = "block";
    } else hud.prompt.style.display = "none";
    guide.draw(state, rig.camera, targetAt, player.root.position);
    renderTip();
    renderWallet();
    renderHint();
  };
  game.onUpdate.push(update);

  // ---------------------------------------------------------------- invest ----
  const investIn = (id: MerchantId, qty: number): void => {
    if (mode.kind === "trade" && mode.done > 0) return;
    const n = Math.floor(qty);
    if (!(n >= 1) || n > sharesForSale(id)) { hud.toast(n >= 1 ? "Not that many shares are for sale." : "Pick how many shares."); return; }
    const r = invest(structuredClone(state), id, n); // checks only: shares move once NEAR confirms
    if (!r.ok) { hud.toast(r.message); return; }
    const m = state.merchants[id];
    const cost = shareCost(id, n);
    if (mode.kind === "trade") { mode = { ...mode, say: `Buying ${n} ${n === 1 ? "share" : "shares"} for ${cost} c. Recording it…`, tone: "", done: AWAITING }; renderTrade(); }
    record("invest", `Bought ${n} ${n === 1 ? "share" : "shares"} of ${m.shop} for ${cost} c`, buyPosted(id, `share:${id}`, n, cost), () => applyInvest(id, n), refusedAt(id));
  };
  /** Sells shares back to the stall: its reserve pays exactly the backing. Coins and shares move once NEAR confirms. */
  const cashOut = (id: MerchantId, n: number): void => {
    if (mode.kind === "trade" && mode.done > 0) return;
    if (n <= 0 || n > sharesToSell(id)) { hud.toast("You don't own that many shares."); return; }
    const m = state.merchants[id], pay = shareRefund(id, n);
    if (mode.kind === "trade") { mode = { ...mode, say: `Selling ${n} shares back for ${pay} c. Recording it…`, tone: "", done: AWAITING }; renderTrade(); }
    record("invest", `Sold ${n} shares of ${m.shop} back for ${pay} c`, sellPosted(id, `share:${id}`, n, pay), () => {
      sellShares(state, id, n);
      const bye = VOICES[id].lines.shares_sold;
      if (mode.kind === "trade") { mode = { ...mode, say: `${bye} Done: ${pay} c for ${n} shares. You still own ${state.player.shares[id]}.`, tone: "good", done: RESULT_HOLD }; renderTrade(); }
      void audio.line(id, `${bye} Done`, { openerOnly: true }); // the merchant says it; the figures stay on screen
      drawBoards(); save();
    }, refusedAt(id));
  };
  const applyInvest = (id: MerchantId, n: number): void => {
    invest(state, id, n);
    // Pema spends part of her partner's money on the harbor's storage fee: her held crates are finally on the way.
    const released = id === "pema" && payReleaseFee(state, "pema-mangoes", "merchant").ok;
    market.say(id, released ? "A partner! I've paid the harbor. My crates are coming!" : VOICES[id].lines.invest_done, 4);
    if (mode.kind === "trade") { mode = { ...mode, say: `You now own ${state.player.shares[id]} of ${shareSupply(state, id)} shares.${state.player.shares[id] >= UPGRADE_AT ? " Look at the stall!" : ""}`, tone: "good", done: RESULT_HOLD }; renderTrade(); }
    drawBoards(); afterProgress(); save();
  };

  // ---------------------------------------------------------------- account: guest or social/email ----
  /** The chain is the truth for what the player owns: their purse, bag and shares follow the active account. */
  const syncPlayer = async (id: string): Promise<void> => {
    const epoch = ledgerEpoch;
    const b = await balances(id).catch(() => null);
    // a trade sent or answered while this read was in flight would be overwritten by older balances: drop the read
    if (!b || playerId() !== id || inFlight > 0 || epoch !== ledgerEpoch) return;
    state.player.coins = b.coin ?? 0;
    state.player.inventory = { mango: b.mango ?? 0, lemon: b.lemon ?? 0, lassi: b.lassi ?? 0 };
    for (const m of TRADERS) state.player.shares[m] = b[`share:${m}`] ?? 0;
    state.flags.account = id;
    drawBoards(); walletKey = ""; save();
  };
  /** Merchants' coins and goods follow the chain too, so a stall never offers a deal its wallet can't settle. */
  const syncMerchants = async (): Promise<void> => {
    const epoch = ledgerEpoch;
    const [all, stalls] = await Promise.all([
      Promise.all(TRADERS.map((id) => balances(merchantAccount(id)).catch(() => null))),
      view<{ merchant: string; open: boolean; need: string; delivered: string; supply: string }[]>("get_stalls").catch(() => null),
    ]);
    for (const s of stalls ?? []) if ((TRADERS as readonly string[]).includes(s.merchant)) state.flags[`supply.${s.merchant}`] = Number(s.supply);
    if (ff || epoch !== ledgerEpoch) return; // a forecast runs on the local model; a read older than a trade is stale
    TRADERS.forEach((id, i) => {
      const b = all[i];
      if (!b) return;
      const m = state.merchants[id];
      m.cash = b.coin ?? 0;
      m.stock = { mango: b.mango ?? 0, lemon: b.lemon ?? 0, lassi: b.lassi ?? 0 };
    });
    // Open or closed, and how far a closed stall is from reopening, is the contract's call (rent runs on chain).
    for (const s of stalls ?? []) {
      const id = s.merchant as MerchantId, m = state.merchants[id];
      if (!m) continue;
      const was = m.status;
      m.status = s.open ? "open" : "closed";
      if (s.open) { delete state.flags[`reopenNeed.${id}`]; delete state.flags[`reopenTotal.${id}`]; }
      else { state.flags[`reopenNeed.${id}`] = Math.max(0, Number(s.need) - Number(s.delivered)); state.flags[`reopenTotal.${id}`] = Number(s.need); }
      if (was !== m.status) {
        hud.toast(s.open ? `${m.shop} reopened.` : `${m.shop} couldn't pay rent and closed.`, s.open); void audio.sfx(s.open ? "reopen" : "closed");
        state.log.push({ minute: state.minute, kind: s.open ? "reopened" : "closed", text: s.open ? `${m.shop} reopened with fresh stock.` : `${m.shop} could not pay rent and pulled the shutters down.` });
      }
    }
    drawBoards();
    if (mode.kind === "trade") renderTrade();
  };
  /** Residents (src/economy/residents.ts) are acted out by the first townsfolk: a confirmed sale or meal on NEAR sends
   *  them to that stall to say it. Only receipts newer than the first look count, so history is not replayed. */
  const residentSeen: Record<string, number> = {};
  const nameOf = (acct: string): string => state.merchants[acct.split(".")[0] as MerchantId]?.name ?? acct.split(".")[0];
  const syncResidents = async (): Promise<void> => {
    await Promise.all(RESIDENTS.map(async (r, who) => {
      const rc = await chainReceipts(merchantAccount(r.id)).catch(() => null);
      if (!rc) return;
      const from = residentSeen[r.id];
      residentSeen[r.id] = Math.max(from ?? 0, ...rc.map((x) => x.block_height));
      if (from === undefined || ff) return;
      for (const x of rc.filter((y) => y.block_height > from).sort((a, b) => a.block_height - b.block_height)) {
        const mer = x.counterparty.split(".")[0], qty = Number(x.qty), price = Number(x.price);
        if (x.kind === "sold") market.life.errand(who, mer, `${r.name}: ${qty} ${x.token_id === "mango" ? "mangoes" : `${x.token_id}s`} for ${nameOf(x.counterparty)}. +${qty * price} c`);
        else if (x.kind === "bought") market.life.errand(who, mer, `${r.name}: one ${x.token_id}, ${price} c. Lunch!`);
      }
    }));
  };
  /** A market turn's log: a resident who could not afford food goes and stands at the stall, saying the real price. */
  const hungry = (t: Record<string, unknown>): void => {
    for (const line of Array.isArray(t.log) ? (t.log as string[]) : []) {
      const m = /^resident (\w+) could not afford (\w+) at (\d+) c$/.exec(line);
      const who = m ? RESIDENTS.findIndex((r) => r.id === m[1]) : -1;
      if (m && who >= 0) market.life.errand(who, "arin", `${RESIDENTS[who].name}: a ${m[2]} is ${m[3]} c and I can't afford it.`);
    }
  };
  let signingIn = false;
  const renderAcct = (): void => {
    const id = playerId(), label = playerLabel();
    hud.acct.innerHTML = "";
    const who = el("div", "who");
    const name = typeof state.flags.name === "string" ? state.flags.name : null; // display only, never an account
    who.append(el("b", "", !id ? name ?? "Offline" : label || name || "Guest"), el("span", "", id ? (label ? " · saved to your account" : " · saved in this browser") : " · trades stay here"));
    hud.acct.append(who);
    if (!id || (!label && !socialAvailable())) return; // sign-in appears once Google/email login is configured
    if (label) return; // signed in: sign-out is in the menu (Esc), behind a confirmation
    hud.acct.append(button(signingIn ? "Signing in…" : "Sign in", "primary", () => { void signIn(); }));
  };
  /** The verified email already has an account and this browser's guest has progress: the player decides. */
  const askConflict = (c: SignInConflict): Promise<"merge" | "separate" | "cancel"> => new Promise((done) => {
    const sum = (h: Record<string, number>): string => {
      const parts = [`${h.coin ?? 0} coins`];
      for (const g of ["mango", "lemon", "lassi"]) if (h[g]) parts.push(`${h[g]} ${g}`);
      const shares = Object.entries(h).filter(([t]) => t.startsWith("share:")).reduce((n, [, v]) => n + v, 0);
      if (shares) parts.push(`${shares} shares`);
      return parts.join(", ");
    };
    openCard((card) => {
      card.append(el("h2", "", "This email already has a VIVOLITH account"));
      const s = el("section");
      s.append(el("p", "", `That account holds ${sum(c.existing)}. The guest game in this browser holds ${sum(c.guestHoldings)}.`));
      s.append(el("p", "", "Nothing has moved. Choose what happens to the guest game:"));
      card.append(s);
      const pick = (v: "merge" | "separate" | "cancel"): void => { onCardDismiss = null; closeOverlay(); done(v); };
      const acts = el("div", "tp-acts");
      acts.append(
        button("Move the guest game into that account (one starter purse is kept)", "primary", () => pick("merge"), "1"),
        button("Sign in, and keep the guest game in this browser", "full", () => pick("separate"), "2"),
        button("Stay a guest for now", "ghost full", () => pick("cancel"), "Esc"),
      );
      card.append(acts);
    });
    onCardDismiss = () => done("cancel"); // Esc: nothing changes
  });
  /** After any sign-in: the story stays (it is uploaded to the account), or the account's own story is restored. */
  const afterSignIn = async (r: SignInResult): Promise<void> => {
    if ("conflict" in r) {
      const c = await askConflict(r);
      if (c === "cancel") { hud.toast("Still playing as a guest. Nothing changed."); return; }
      return afterSignIn(await chooseSignIn(c));
    }
    hud.toast(`Signed in as ${r.label}${r.merged ? ". Your guest progress came with you." : ""}`, true);
    await syncPlayer(r.accountId);
    renderAcct();
    if (r.merged) { save(); await cloudPut(JSON.stringify(state)); return; } // this story is the account's story now
    const cloud = await cloudGet();
    if (cloud && cloud.data !== JSON.stringify(state)) {
      try { localStorage.setItem(GUEST_SAVE, JSON.stringify(state)); } catch { /* storage blocked */ } // back on sign-out
      hud.toast("Restoring this account's saved game…", true);
      adoptSave(cloud.data);
      return;
    }
    save(); await cloudPut(JSON.stringify(state)); // a first save for an account with none yet
  };
  const signIn = async (): Promise<void> => {
    if (signingIn || playerLabel()) return;
    signingIn = true; renderAcct();
    save(); // a popup-blocked browser redirects to the login page and back: keep the market as it is
    try {
      await afterSignIn(await signInSocial());
    } catch (e) {
      const msg = e instanceof Error ? e.message : "cancelled";
      if (!/redirecting/.test(msg)) hud.toast("Sign-in didn't finish. You're still playing as a guest.");
    } finally {
      signingIn = false; renderAcct();
    }
  };
  const signOut = async (): Promise<void> => {
    if (cloudDirty) { cloudDirty = false; await cloudPut(JSON.stringify(state)); } // the account keeps its latest story
    const id = await signOutSocial();
    renderAcct();
    let parked: string | null = null;
    try { parked = localStorage.getItem(GUEST_SAVE); localStorage.removeItem(GUEST_SAVE); } catch { /* storage blocked */ }
    if (parked) { adoptSave(parked); return; } // this browser's own guest story, as it was before signing in
    if (id) { hud.toast("Signed out. Back to this browser's guest game."); await syncPlayer(id); }
  };

  let tickIn = 5;
  renderAcct();
  // Another tab signed in or out, or this sign-in expired: show it and follow the account that is now active.
  onAccountChange((why) => {
    renderAcct();
    if (why === "expired") hud.toast("Your sign-in expired. You're on this browser's guest game: sign in again to get back to your account.");
    const id = playerId();
    if (id) void syncPlayer(id);
  });
  // Boot: finish a returning sign-in redirect first, then restore whoever is signed in (never a new guest before that).
  void finishSocialRedirect().catch(() => {
    hud.toast("Sign-in didn't finish. You're still playing as a guest.");
    return null;
  }).then(async (redirected) => {
    const id = await connectGuest();
    renderAcct();
    if (!id) return;
    void syncMerchants();
    await syncPlayer(id); // NEAR is authoritative: the save only mirrors what the account holds
    if (redirected) { await afterSignIn(redirected); return; }
    if (!playerLabel() || entered) return;
    // Signed in on this device before, or on another one: the account's newest story wins (only before play starts).
    const cloud = await cloudGet();
    if (!cloud || entered) return;
    let cloudAt = 0;
    try { cloudAt = Number((JSON.parse(cloud.data) as EconomyState).flags.savedAt ?? 0); } catch { return; }
    const localAt = Number(state.flags.savedAt ?? 0);
    if (cloudAt > localAt || (state.flags.account !== id && state.flags.played !== true)) adoptSave(cloud.data);
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
        // saved during an evening report: show it again so the night ends with "Next morning", not a dark walk
        if (unlocked(state, "rent") && state.minute % MINUTES_PER_DAY >= RENT_MINUTE && mode.kind === "walk") showReport(`Evening, Day ${dayOf(state.minute)}`, mark, false);
      }
      play.paused = false;
      player.frozen = mode.kind !== "walk";
      renderAcct();
      walletKey = "";
      if (!state.flags.welcomed && stepIndex(state) === 0) showWelcome();
    },
    signIn: () => signIn(),
    signOut: () => signOut(),
    account: () => ({ id: playerId(), label: playerLabel(), canSignIn: socialAvailable(), offline: isOffline() }),
    interact() {
      if (mode.kind !== "walk" || ff) return;
      if (!market.nearest(player.root.position) && atOrchard()) { void pickAtOrchard(); return; }
      const npc = market.nearest(player.root.position);
      if (!npc) return;
      if (npc.id === "pema" && stepIndex(state) <= 1) { state.flags.nearPema = true; openTalk(npc, PEMA_INTRO); return; }
      if (!TRADERS.includes(npc.id as MerchantId)) { openTalk(npc); return; }
      const m = state.merchants[npc.id as MerchantId];
      if (m.status !== "open" && sellPrice(npc.id as MerchantId) === null && !tabsFor(npc.id as MerchantId).includes("invest")) {
        hud.toast(`${m.shop} is closed. ${m.name} couldn't pay the rent.`); return;
      }
      openTrade(npc, npc.id as MerchantId);
    },
    tactic(t) {
      if (mode.kind !== "trade" || !mode.h || mode.h.over || mode.done > 0) return;
      const r = applyTactic(state, mode.h, t);
      const id = mode.id, opener = (line: "haggle_ok" | "haggle_no" | "refuse"): string => VOICES[id].lines[line];
      // a recorded opener starts the subtitle and plays at once; the live line with the numbers is voiced after it
      const line = r.success || t === "fair" ? "haggle_ok" : "haggle_no";
      mode = { ...mode, h: r.session, say: `${opener(line)} ${r.line}`, tone: t === "fair" ? "good" : r.success ? "good" : "bad" };
      if (r.session.over === "deal") { void audio.line(id, mode.say); settleDeal(r.session); }
      else if (r.session.over === "walked") { const out = closeDeal(state, r.session); mode = { ...mode, h: null, say: `${opener("refuse")} ${out.message}`, tone: "bad", done: RESULT_HOLD }; void audio.line(id, mode.say); renderTrade(); }
      else { void audio.line(id, mode.say); renderTrade(); }
    },
    fastForward(on) {
      const want = on ?? !ff;
      if (want && !ff && mode.kind === "walk") { ff = { from: snap(state), until: nextRent(state.minute + (FF_MAX_DAYS - 1) * MINUTES_PER_DAY), real: playerId() ? structuredClone(state) : null }; walletKey = ""; }
      else if (!want && ff) endFastForward(true);
    },
    reset() { resetting = true; clearSave(); location.reload(); },
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
