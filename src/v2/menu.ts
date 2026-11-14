// Boot loader and main menu.
// Loader: index.html paints the N Spire as an architect's line drawing before any script runs; this module draws it
// stroke by stroke from the bytes that really arrived (src/assets.ts), names the part of the city in flight, then
// lights the towers' windows while the market is assembled, and hands over to the same Spire in 3D.
// Menu: the live city is the backdrop. The camera settles from a high, wide shot onto Kavi looking up at the N Spire
// and keeps drifting; the type sits in the shade on the left: a small overline, the wordmark, one line of where you
// are, the actions (the first one large), and along the bottom the market's four stalls as the chain last showed them.
import * as THREE from "three";
import type { Game } from "./game";
import type { Play } from "./play";
import { clockOf, MERCHANT_IDS } from "../economy/state";
import { shareSupply } from "../economy/sim";
import { audio } from "./audio";
import { ledgerView } from "../near/inspect";
import { downloadDone, downloadProgress } from "../assets";

const CSS = /* css */ `
#menu { position:fixed; inset:0; z-index:25; font-family:"Inter Tight",system-ui,sans-serif; color:#fff; display:none; user-select:none;
  --mint:#00ec97; --ink:6,10,22; --pad:clamp(18px, 7vw, 136px);
  background:
    linear-gradient(90deg, rgba(var(--ink),.76) 0%, rgba(var(--ink),.56) 26%, rgba(var(--ink),.24) 46%, rgba(var(--ink),0) 64%),
    linear-gradient(0deg, rgba(var(--ink),.62) 0%, rgba(var(--ink),.18) 16%, rgba(var(--ink),0) 30%),
    linear-gradient(180deg, rgba(var(--ink),.38) 0%, rgba(var(--ink),0) 18%); }
#menu.show { display:block; }
#menu.leaving { pointer-events:none; }
#menu .col { position:absolute; left:var(--pad); top:clamp(22px, 10vh, 120px); bottom:clamp(64px, 12vh, 132px); width:min(900px, calc(100vw - var(--pad) - 18px));
  display:flex; flex-direction:column; justify-content:space-between; gap:clamp(14px, 4vh, 48px); overflow-x:hidden; overflow-y:auto; overscroll-behavior:contain;
  scrollbar-width:thin; scrollbar-color:rgba(255,255,255,.3) transparent; padding-right:8px; }
#menu .mark { display:block; width:clamp(44px, 6.4vh, 64px); height:auto; margin:0 0 clamp(12px, 2.4vh, 22px) -4px; filter:drop-shadow(0 6px 24px rgba(0,16,40,.45)); }
#menu .over { margin:0 0 clamp(10px, 2vh, 18px); font-size:clamp(10px, 1.5vh, 12px); font-weight:600; letter-spacing:.34em; text-transform:uppercase; color:#9ff7d4;
  display:flex; align-items:center; gap:14px; }
#menu .over::after { content:""; width:56px; height:1px; background:currentColor; opacity:.6; transform-origin:left; }
#menu h1 { margin:0; font-weight:700; font-size:clamp(36px, min(6vw, 11vh), 118px); line-height:.92; letter-spacing:.16em; white-space:nowrap;
  text-shadow:0 2px 2px rgba(0,16,40,.18), 0 8px 48px rgba(0,16,40,.45); }
#menu .where { margin:clamp(12px, 2.6vh, 22px) 0 0; max-width:440px; font-size:clamp(13px, min(1.15vw, 2.3vh), 16px); line-height:1.45; color:rgba(255,255,255,.82);
  text-shadow:0 1px 10px rgba(0,16,40,.55); overflow-wrap:anywhere; }
#menu ul { list-style:none; margin:0; padding:0; max-width:560px; }
#menu li { position:relative; padding:clamp(4px, .8vh, 8px) 0 clamp(4px, .8vh, 8px) 30px; cursor:pointer; color:rgba(255,255,255,.62);
  font-size:clamp(16px, min(1.5vw, 3.1vh), 21px); font-weight:500; letter-spacing:.02em; text-shadow:0 1px 12px rgba(0,16,40,.6);
  transition:color .2s ease, transform .35s cubic-bezier(.2,.8,.2,1); }
#menu li.primary { font-size:clamp(26px, min(2.9vw, 5.6vh), 42px); font-weight:600; letter-spacing:.005em; color:rgba(255,255,255,.86); margin-bottom:clamp(4px, 1.4vh, 14px); }
#menu li::before { content:""; position:absolute; left:0; top:calc(clamp(4px, .8vh, 8px) + .62em); width:18px; height:2px; background:var(--mint);
  transform:scaleX(0); transform-origin:left; transition:transform .3s cubic-bezier(.2,.8,.2,1); }
#menu li.primary::before { height:3px; width:20px; }
#menu li.on { color:#fff; transform:translateX(8px); }
#menu li.on::before { transform:scaleX(1); }
#menu li .key { display:inline-block; margin-left:14px; vertical-align:middle; font-size:11px; font-weight:600; letter-spacing:.12em; color:rgba(255,255,255,.75);
  border:1px solid rgba(255,255,255,.45); padding:2px 6px 1px; opacity:0; transform:translateX(-6px); transition:opacity .2s, transform .3s cubic-bezier(.2,.8,.2,1); }
#menu li.on .key { opacity:1; transform:none; }
@media (hover:none) { #menu li .key { display:none; } }
#menu li small { display:block; font-size:13px; font-weight:400; letter-spacing:.02em; color:rgba(255,255,255,.66); margin-top:3px; overflow-wrap:anywhere; }
#menu li.primary small { font-size:14px; margin-top:4px; }
#menu .sheet { margin-top:clamp(12px, 2.6vh, 24px); max-width:460px; padding:14px 0 0; border-top:1px solid rgba(255,255,255,.22); font-size:clamp(13px, 2.3vh, 15px); line-height:1.55;
  color:rgba(255,255,255,.9); text-shadow:0 1px 8px rgba(0,16,40,.6); animation:sheetIn .35s cubic-bezier(.2,.8,.2,1) both; }
@keyframes sheetIn { from { opacity:0; transform:translateY(6px); } }
#menu .sheet b { color:#fff; } #menu .sheet kbd { font:700 11px "Inter Tight",system-ui,sans-serif; background:#fff; color:#0c1220; padding:1px 6px; border-radius:2px; margin-right:7px; }
#menu .sheet .confirm { display:flex; flex-wrap:wrap; gap:10px; }
#menu .sheet .judge { margin-top:14px; padding-top:10px; border-top:1px solid rgba(255,255,255,.22); font-size:.92em; }
#menu .sheet .judge a { color:#fff; font-weight:600; text-underline-offset:3px; }
#menu .sheet button { font:600 14px "Inter Tight",system-ui,sans-serif; color:#fff; background:rgba(var(--ink),.35); border:1px solid rgba(255,255,255,.6); padding:7px 12px 7px 8px; cursor:pointer;
  transition:background .2s, color .2s; }
#menu .sheet button:hover, #menu .sheet button:focus-visible { background:#fff; color:#0c1220; outline:none; }
#menu .sheet table { border-collapse:collapse; } #menu .sheet td { padding:3px 18px 3px 0; vertical-align:top; }
#menu .sheet input[type=range] { accent-color:var(--mint); width:min(200px, 40vw); }
#menu .name { display:flex; align-items:stretch; gap:0; margin-top:clamp(8px, 1.6vh, 14px); max-width:380px; }
#menu .name input { flex:1; min-width:0; font:500 clamp(17px, min(1.6vw, 3.4vh), 22px) "Inter Tight",system-ui,sans-serif; color:#fff; caret-color:var(--mint);
  background:rgba(var(--ink),.38); border:0; border-bottom:1px solid rgba(255,255,255,.55); padding:9px 12px; outline:none; transition:border-color .2s, background .2s; }
#menu .name input::placeholder { color:rgba(255,255,255,.42); }
#menu .name input:focus { border-bottom-color:var(--mint); background:rgba(var(--ink),.55); }
#menu .name button { font:700 13px "Inter Tight",system-ui,sans-serif; letter-spacing:.14em; text-transform:uppercase; color:#06140e; background:var(--mint); border:0; padding:0 18px; cursor:pointer;
  transition:background .2s, letter-spacing .3s; }
#menu .name button:hover, #menu .name button:focus-visible { background:#fff; letter-spacing:.2em; outline:none; }
#menu li .err { color:#ffb4a8; }
#menu .foot { position:absolute; left:var(--pad); right:clamp(18px, 4vw, 64px); bottom:clamp(16px, 4vh, 40px); display:flex; align-items:center; gap:clamp(14px, 3vw, 40px); flex-wrap:wrap;
  font-size:11px; font-weight:600; letter-spacing:.2em; text-transform:uppercase; color:rgba(255,255,255,.66); text-shadow:0 1px 6px rgba(0,16,40,.7); }
#menu .foot .market { display:flex; align-items:baseline; gap:14px; padding-left:clamp(14px, 3vw, 40px); border-left:1px solid rgba(255,255,255,.3); color:rgba(255,255,255,.82); }
#menu .foot .market:empty { display:none; }
#menu .foot .market .label { color:rgba(255,255,255,.46); }
#menu .foot .acct { margin-left:auto; letter-spacing:.12em; color:rgba(255,255,255,.58); text-transform:none; font-weight:500; font-size:12px; }
/* entrance: the loader fades over this; each part arrives in turn, the camera settles behind it */
#menu.show .mark, #menu.show .over, #menu.show h1, #menu.show .where, #menu.show li, #menu.show .foot { animation:rise .9s cubic-bezier(.2,.8,.2,1) both; animation-delay:calc(var(--i, 0) * 70ms + 380ms); }
#menu.show h1 { animation-name:reveal; animation-duration:1.3s; }
#menu.show .over::after { animation:draw 1.2s cubic-bezier(.2,.8,.2,1) .5s both; }
@keyframes rise { from { opacity:0; transform:translateY(14px); } }
@keyframes reveal { from { opacity:0; letter-spacing:.3em; clip-path:inset(0 0 100% 0); } to { clip-path:inset(0 0 -10% 0); } }
@keyframes draw { from { transform:scaleX(0); } }
#menu.settled .mark, #menu.settled .over, #menu.settled h1, #menu.settled .where, #menu.settled li, #menu.settled .foot, #menu.settled .over::after { animation:none; }
#menu.reopen .mark, #menu.reopen .over, #menu.reopen h1, #menu.reopen .where, #menu.reopen li, #menu.reopen .foot { animation-delay:calc(var(--i, 0) * 40ms); animation-duration:.5s; }
#menu.leaving .col, #menu.leaving .foot { transition:opacity .45s ease, transform .6s cubic-bezier(.4,0,.2,1); opacity:0; transform:translateX(-18px); }
#menu.leaving { transition:background-color .6s; background:none; }
body.in-menu .hud, body.in-menu #hint { display:none !important; }
@media (max-width:720px), (max-height:520px) {
  #menu { background:linear-gradient(180deg, rgba(var(--ink),.5) 0%, rgba(var(--ink),.15) 40%, rgba(var(--ink),.7) 100%); }
  #menu .col { bottom:clamp(86px, 16vh, 140px); }
  #menu .foot .acct { margin-left:0; width:100%; }
}
@media (prefers-reduced-motion: reduce) {
  #menu.show *, #menu.show .over::after { animation:none !important; }
  #menu li, #menu li::before, #menu li .key, #menu.leaving .col, #menu.leaving .foot { transition:none; }
}
`;

/** What the first screen needs, downloaded in parallel from the first moment, and what the loader calls each part. */
export const BOOT_GROUPS: readonly { label: string; urls: readonly string[] }[] = [
  { label: "Raising Saltlight and the N Spire", urls: ["/models/v2/plaza.glb", "/models/v2/kavi.glb"] },
  { label: "Setting out the market", urls: ["/models/v2/town.glb", "/models/v2/landmarks/intents_exchange.glb", "/models/v2/landmarks/ai_lab.glb"] },
  { label: "Bringing in the townsfolk", urls: [1, 2, 3, 4, 5, 6].map((n) => `/models/v2/cast/folk${n}.glb`) },
  { label: "Waking the merchants", urls: ["merchant_fruit", "tomas", "mira", "arin", "bram", "ines"].map((f) => `/models/v2/cast/${f}.glb`) },
];

/** One line each, while it loads: what this town is. */
const LINES = [
  "Every merchant keeps their own till.",
  "Rent is due at nine. Not every stall will make it.",
  "Save a stall, and it stays saved.",
  "Every trade settles on NEAR. You never see a wallet.",
];

export interface Boot {
  /** A milestone after the downloads: the city is built ("city"), or everything is ready ("ready"). */
  reached(m: "city" | "ready"): void;
  fail(message: string): void;
  hide(): void;
}

export function createBoot(): Boot {
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);
  const root = document.getElementById("boot")!;
  const stage = root.querySelector<HTMLElement>(".stage")!, count = root.querySelector<HTMLElement>(".count")!, line = root.querySelector<HTMLElement>(".line")!;
  const strokes = [...root.querySelectorAll<SVGPathElement>("svg path")].map((p) => ({ p, a: Number(p.dataset.a), b: Number(p.dataset.b) }));
  let shown = 0, milestone: "" | "city" | "ready" = "", failed = false;
  const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const mb = (n: number): string => (n / 1e6).toFixed(1);
  // Progress, never faked: 0-85 % is the share of bytes that arrived, 90 % the city built, 100 % ready.
  const tick = (): void => {
    if (failed) return;
    const d = downloadProgress();
    const p = milestone === "ready" ? 1 : Math.max(0.85 * d.share, milestone === "city" ? 0.9 : 0);
    // the drawing eases toward the real figure (never past it), so the line is drawn, not stepped
    shown = Math.min(p, shown + Math.max(0.0015, (p - shown) * (still ? 1 : 0.08)));
    for (const s of strokes) s.p.style.strokeDashoffset = String(1 - Math.min(1, Math.max(0, (shown - s.a) / (s.b - s.a))));
    const loading = d.finished < d.files;
    let label = "Opening Saltlight";
    if (milestone === "ready") label = "Saltlight is open";
    else if (loading) {
      const g = BOOT_GROUPS.find((x) => x.urls.some((u) => !downloadDone(u)));
      label = g?.label ?? label;
    } else label = "Assembling the market";
    if (stage.textContent !== label) stage.textContent = label;
    count.textContent = milestone === "ready" ? "" : d.loaded === 0 ? "Connecting" : `${mb(d.loaded)} MB · ${d.finished} of ${d.files} models`;
    root.classList.toggle("build", !loading && milestone !== "ready");
    if (milestone !== "ready" || shown < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  let li = 0;
  const rotate = window.setInterval(() => {
    line.classList.add("out");
    window.setTimeout(() => { li = (li + 1) % LINES.length; line.textContent = LINES[li]; line.classList.remove("out"); }, 700);
  }, 4200);
  return {
    reached(m) {
      milestone = m;
      if (m === "ready") { shown = still ? 1 : Math.max(shown, 0.9); root.classList.add("ready"); root.classList.remove("build"); window.clearInterval(rotate); }
    },
    fail(message) {
      failed = true;
      window.clearInterval(rotate);
      root.classList.add("err");
      stage.textContent = message;
      count.textContent = "";
    },
    hide() {
      root.classList.add("gone");
      window.setTimeout(() => root.remove(), 1200);
    },
  };
}

interface Item {
  label: string;
  note?: string;
  /** The item holds the name field (Enter or its button plays). */
  name?: boolean;
  run: () => void;
}

/** A display name is guest access only: it never names an account, a key or a wallet. */
export const NAME_MAX = 16;
export function cleanName(raw: string): string | null {
  const n = raw.replace(/\s+/g, " ").trim();
  return n.length >= 2 && n.length <= NAME_MAX && /^[\p{L}\p{N}][\p{L}\p{N} '._-]*$/u.test(n) ? n : null;
}

/** Main menu over the live scene. Opens after loading and again on Esc during play. */
/** How long the opening animation runs (CSS below): account changes wait for it, then re-render. */
const ENTRANCE_MS = 2200;

export function createMenu(game: Game, play: Play): { open(): void } {
  const root = document.getElementById("menu")!;
  const { player, rig } = game;
  const vantage = game.look.scene.getObjectByName("SPAWN")?.getWorldPosition(new THREE.Vector3()) ?? new THREE.Vector3(0, 0, -30);
  let isOpen = false, started = false, sel = 0, items: Item[] = [], sheet: "" | "how" | "new" | "signout" | "sound" = "", t = 0;
  let rendered = false, openedAt = 0; // one entrance per opening (see render)

  // Cinematic: runs after the rig each frame, so it owns the camera while the menu is open.
  const fwd = new THREE.Vector3(0, 0, -1), right = new THREE.Vector3(1, 0, 0);
  const cam = new THREE.Vector3(), look = new THREE.Vector3();
  const still = window.matchMedia("(prefers-reduced-motion: reduce)");
  // the first opening settles from a high, wide shot of the plaza onto Kavi under the Spire (once per page load)
  let settle = still.matches ? 1 : 0;
  const SETTLE_SEC = 6.5, SETTLE_AFTER = 0.5; // starts as the loader begins to fade, so the move is seen
  game.onUpdate.push((dt) => {
    if (!isOpen) return;
    t += dt;
    if (settle < 1 && t > SETTLE_AFTER) settle = Math.min(1, settle + dt / SETTLE_SEC);
    const k = 1 - (1 - settle) ** 3, far = 1 - k; // ease out: fast at first, then a long, quiet landing
    const p = player.root.position;
    const sway = still.matches ? 0 : Math.sin(t * 0.12) * 0.5;
    // Camera behind Kavi's left shoulder, aimed past him at the Spire: he stands right of centre, the N above him.
    cam.copy(p).addScaledVector(fwd, -5.4 - 13 * far).addScaledVector(right, -1.5 + sway - 4 * far).setY(p.y + 1.7 + 11 * far);
    look.copy(p).addScaledVector(fwd, 40).addScaledVector(right, -4 + sway * 2).setY(p.y + 10.5 + 13 * far);
    rig.camera.position.copy(cam);
    rig.camera.lookAt(look);
  });

  const esc = (t: string): string => t.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const cap = (s: string): string => s[0].toUpperCase() + s.slice(1);
  const savedName = (): string => (typeof play.state.flags.name === "string" ? play.state.flags.name : "");
  /** A brand-new player who is not signed in picks: a name (guest) or Google. */
  const firstVisit = (): boolean => !started && !play.restored && !play.account().label && !savedName();
  let nameDraft = "", nameErr = "";
  // who is playing and how they are connected: kept small, in the corner (the game leads, not the account)
  const who = (): string => {
    const a = play.account();
    return cap(a.problem ? "not connected to the market, retrying" : a.label ? `signed in as ${a.label}` : savedName() ? `${savedName()} · guest` : a.id ? "guest" : a.offline ? "playing offline" : "connecting to the market");
  };
  // the line under the title: what this place is for a newcomer, where you left off for a returning player
  const where = (): string => {
    if (!play.restored && !started) return "A market town where every merchant keeps a real till, and the stall you save stays saved.";
    const s = play.state;
    const shares = MERCHANT_IDS.filter((id) => s.player.shares[id] > 0).map((id) => `${s.player.shares[id]}/${shareSupply(s, id)} of ${s.merchants[id].shop}`);
    return `${clockOf(s.minute).replace(/^(Day \d+) /, "$1, ")} · ${s.player.coins} ${s.player.coins === 1 ? "coin" : "coins"}${shares.length ? ` · ${shares.join(", ")}` : ""}`;
  };

  let leaving = 0;
  const enter = (): void => {
    isOpen = false;
    // the type slides away while the world takes the camera back; the menu element goes once it has faded
    root.classList.add("leaving");
    window.clearTimeout(leaving);
    leaving = window.setTimeout(() => { if (!isOpen) root.classList.remove("show", "leaving", "reopen"); }, still.matches ? 0 : 650);
    document.body.classList.remove("in-menu");
    game.input.flush();
    play.enterWorld();
    started = true;
    rig.yaw = player.heading;
    rig.snap(player.focus, game.colliders);
    // inside the click: mouse-look straight away, unless a card (the welcome) opened with the world
    if (!player.frozen) game.input.setUi(false); // leaves UI mode now (not next frame) and locks
  };

  const playWithName = (): void => {
    const n = cleanName(nameDraft);
    if (!n) { nameErr = `2 to ${NAME_MAX} letters or numbers`; render(); return; }
    play.state.flags.name = n; // saved with the story by enterWorld; local to this browser unless signed in
    nameErr = "";
    enter();
  };
  // Google needs the guest account first (its progress moves into the Google account), so it waits for NEAR.
  const google = (): Item => {
    const ready = Boolean(play.account().id);
    return { label: "Continue with Google", note: ready ? "Keep your market on any device" : "Connecting…", run: () => { if (ready) void play.signIn().then(render); } };
  };

  const build = (): void => {
    const a = play.account();
    if (firstVisit()) {
      items = [{ label: "Play with a name", name: true, run: playWithName }];
      if (a.canSignIn) items.push(google());
    } else {
      items = [{ label: started ? "Resume" : play.restored ? "Continue" : "Play", run: enter }]; // who is playing: the corner
      if (play.restored || started) items.push({ label: "New Game", run: () => { sheet = "new"; render(); } });
      // Signing out asks first: it is the one item that changes whose account is playing.
      if (a.label) items.push({ label: "Sign out", note: a.label, run: () => { sheet = "signout"; render(); } });
      else if (a.canSignIn && a.id) items.push(google());
    }
    items.push({ label: "Sound", run: () => { sheet = sheet === "sound" ? "" : "sound"; render(); } });
    items.push({ label: "How to play", run: () => { sheet = sheet === "how" ? "" : "how"; render(); } });
    sel = Math.min(sel, items.length - 1);
  };

  const sheetHtml = (): string => {
    if (sheet === "sound") {
      const l = audio.levels();
      const row = (k: "music" | "voice" | "sfx", label: string): string =>
        `<tr><td>${label}</td><td><input type="range" min="0" max="100" value="${Math.round(l[k] * 100)}" data-vol="${k}" aria-label="${label} volume"></td></tr>`;
      return `<div class="sheet"><table>${row("music", "Music")}${row("voice", "Voices")}${row("sfx", "Effects")}
        <tr><td>Mute all</td><td><input type="checkbox" data-mute ${l.muted ? "checked" : ""} aria-label="Mute all sound"></td></tr></table></div>`;
    }
    if (sheet === "how") return `<div class="sheet">
      <p><b>Trade with the four merchants.</b> Pema is loyal and never gouges. Tomas charges what a shortage allows. Mira buys surplus and undercuts. Arin pays a steady price for mangoes.</p>
      <table>
        <tr><td><kbd>WASD</kbd>move</td><td><kbd>Shift</kbd>run</td></tr>
        <tr><td><kbd>F</kbd>talk or trade</td><td><kbd>B</kbd>your bag</td></tr>
        <tr><td><kbd>J</kbd>goals</td><td><kbd>H</kbd>help</td></tr>
        <tr><td><kbd>C</kbd>town news</td><td><kbd>Esc</kbd>this menu</td></tr>
      </table>
      <p>Look at a chalkboard to see why a price is what it is.</p>
      ${ledgerView(location.search, location.pathname)
        ? `<p class="judge"><b>Ledger view is on.</b> In town, press <kbd>N</kbd> for your NEAR account and every receipt, each with its explorer link.</p>`
        : `<p class="judge">Judging VIVOLITH? <a href="/ledger">Open the ledger view</a>: in town, <kbd>N</kbd> shows your NEAR account and every receipt, each with its explorer link.</p>`}</div>`;
    if (sheet === "signout") return `<div class="sheet">
      <p><b>Sign out of ${esc(play.account().label ?? "")}?</b> Your coins, goods and shares stay with that account; sign in again on any device to get them back. This browser goes back to its guest game.</p>
      <p class="confirm"><button data-act="signout"><kbd>Y</kbd>Sign out</button><button data-act="keep"><kbd>Esc</kbd>Stay signed in</button></p></div>`;
    if (sheet === "new") return `<div class="sheet">
      <p><b>Start the story over?</b> The city resets to Day 1. You stay ${play.account().label ? `signed in as ${esc(play.account().label ?? "")}` : "on this browser's account"}, and the coins, goods and shares you hold on NEAR stay in it.</p>
      <p class="confirm"><button data-act="reset"><kbd>Enter</kbd>Start over</button><button data-act="keep"><kbd>Esc</kbd>Keep playing</button></p></div>`;
    return "";
  };

  const render = (): void => {
    const before = items.map((it) => it.label).join("|");
    const prev = root.querySelector<HTMLInputElement>(".name input");
    const typing = prev !== null && document.activeElement === prev; // re-renders (NEAR connecting) keep the caret
    const caret = prev?.selectionStart ?? nameDraft.length;
    build();
    if (items.map((it) => it.label).join("|") !== before) sel = 0; // the list changed: never leave a stale selection
    // the entrance plays once per opening; later renders (arrow keys, NEAR connecting) show the settled menu
    if (rendered) root.classList.add("settled");
    rendered = true;
    root.innerHTML = `<div class="col"><header><img class="mark" src="/brand/vivolith-logo-128.png" width="64" height="64" alt="" style="--i:0"><p class="over" style="--i:0">Saltlight · a market town on NEAR</p><h1 style="--i:1">VIVOLITH</h1><p class="where" style="--i:2"></p></header>`
      + `<nav aria-label="Main menu"><ul role="menu"></ul>${sheetHtml()}</nav></div>`
      + `<footer class="foot" style="--i:${3 + items.length}"><span>Built on NEAR</span><span class="market"></span><span class="acct"></span></footer>`;
    root.querySelector(".where")!.textContent = where();
    root.querySelector(".acct")!.textContent = who();
    // the four stalls as this game last read them from the chain (hidden offline: they would be the local model's)
    const market = root.querySelector<HTMLElement>(".market")!, a = play.account();
    // one line of words, like a notice by the square: "all four stalls open", or who is shut and how many trade on
    if (a.id && !a.offline) {
      const shut = MERCHANT_IDS.filter((id) => play.state.merchants[id].status !== "open");
      const n = ["no", "one", "two", "three", "four"][MERCHANT_IDS.length - shut.length] ?? String(MERCHANT_IDS.length - shut.length);
      const names = shut.map((id) => cap(id)).join(" and ");
      const label = document.createElement("span"), state = document.createElement("span");
      label.className = "label";
      label.textContent = "Saltlight market";
      state.textContent = shut.length === 0 ? "All four stalls open" : `${names} closed · ${n} open`;
      market.append(label, state);
    }
    const ul = root.querySelector("ul")!;
    items.forEach((it, i) => {
      const li = document.createElement("li");
      li.className = [i === 0 ? "primary" : "", i === sel ? "on" : ""].filter(Boolean).join(" ");
      li.style.setProperty("--i", String(3 + i));
      li.setAttribute("role", "menuitem");
      li.textContent = it.label;
      if (!it.name) { const k = document.createElement("span"); k.className = "key"; k.textContent = "Enter"; k.setAttribute("aria-hidden", "true"); li.append(k); }
      if (it.note) { const s = document.createElement("small"); s.textContent = it.note; li.append(s); }
      li.onmouseenter = () => { sel = i; [...ul.children].forEach((el, j) => el.classList.toggle("on", j === sel)); };
      if (it.name) {
        const row = document.createElement("div");
        row.className = "name";
        const input = document.createElement("input");
        Object.assign(input, { type: "text", value: nameDraft, maxLength: NAME_MAX, placeholder: "Your name", autocomplete: "nickname", spellcheck: false });
        input.setAttribute("aria-label", "Your name");
        input.oninput = () => { nameDraft = input.value; if (nameErr) { nameErr = ""; li.querySelector(".err")?.remove(); } };
        input.onfocus = () => { sel = i; [...ul.children].forEach((el, j) => el.classList.toggle("on", j === sel)); };
        const go = document.createElement("button");
        go.textContent = "Play";
        go.onclick = (e) => { e.stopPropagation(); it.run(); };
        row.append(input, go);
        li.append(row);
        if (nameErr) { const s = document.createElement("small"); s.className = "err"; s.textContent = nameErr; li.append(s); }
        li.onclick = () => input.focus();
      } else li.onclick = () => it.run();
      ul.append(li);
    });
    const field = root.querySelector<HTMLInputElement>(".name input");
    if (field && (typing || (sel === 0 && isOpen && !sheet))) { field.focus(); field.setSelectionRange(caret, caret); }
    root.querySelector<HTMLButtonElement>("[data-act=reset]")?.addEventListener("click", () => play.reset());
    root.querySelector<HTMLButtonElement>("[data-act=signout]")?.addEventListener("click", () => { sheet = ""; void play.signOut().then(render); });
    root.querySelector<HTMLButtonElement>("[data-act=keep]")?.addEventListener("click", () => { sheet = ""; render(); });
    root.querySelectorAll<HTMLInputElement>("[data-vol]").forEach((r) => {
      r.oninput = () => audio.set({ [r.dataset.vol as "music" | "voice" | "sfx"]: Number(r.value) / 100 });
    });
    const mute = root.querySelector<HTMLInputElement>("[data-mute]");
    if (mute) mute.onchange = () => audio.set({ muted: mute.checked });
  };

  // The guest account connects in the background: refresh the status line and items when it does.
  let lastAcct = "";
  window.setInterval(() => {
    if (!isOpen) return;
    const a = play.account(), key = `${a.id}|${a.label}|${a.canSignIn}`;
    if (performance.now() - openedAt < ENTRANCE_MS) return; // let the entrance finish; the change shows right after
    if (key !== lastAcct) { lastAcct = key; render(); }
  }, 800);

  window.addEventListener("keydown", (e) => {
    if (!isOpen) {
      if (e.code === "Escape" && started && play.mode === "walk" && !document.pointerLockElement && !game.input.escapeReleasedLock) menu.open();
      return;
    }
    const t = e.target as HTMLElement | null;
    if (t?.tagName === "INPUT") { // typing a name: only Enter (play), Esc (leave the field) and the arrows are ours
      if (e.code === "Enter") items[sel]?.run();
      else if (e.code === "Escape") t.blur();
      else if (e.code === "ArrowDown" || e.code === "ArrowUp") { t.blur(); sel = (sel + (e.code === "ArrowDown" ? 1 : -1) + items.length) % items.length; render(); }
      else return;
      e.preventDefault();
      return;
    }
    if (sheet === "new") {
      if (e.code === "Enter") play.reset();
      else if (e.code === "Escape") { sheet = ""; render(); }
      e.preventDefault();
      return;
    }
    if (sheet === "signout") { // only an explicit Y signs out: Enter or Space (aimed at another item) never do
      if (e.code === "KeyY") { sheet = ""; void play.signOut().then(render); }
      else if (e.code === "Escape" || e.code === "Enter" || e.code === "Space") { sheet = ""; render(); }
      e.preventDefault();
      return;
    }
    if (e.code === "ArrowDown" || e.code === "KeyS") { sel = (sel + 1) % items.length; render(); }
    else if (e.code === "ArrowUp" || e.code === "KeyW") { sel = (sel - 1 + items.length) % items.length; render(); }
    else if (e.code === "Enter" || e.code === "Space") items[sel]?.run();
    else if (e.code === "Escape" && sheet) { sheet = ""; render(); }
    else if (e.code === "Escape" && started) enter(); // the pause menu: Esc again resumes
    else return;
    e.preventDefault();
  });

  const menu = {
    open(): void {
      if (!started) player.setSpawn(vantage.clone().setY(vantage.y + 1), Math.PI);
      play.paused = true;
      player.frozen = true;
      isOpen = true;
      sheet = "";
      sel = 0;
      document.body.classList.add("in-menu");
      game.input.flush();
      game.input.setUi(true); // frees the cursor now, as our release (not the player's), so Resume re-locks
      window.clearTimeout(leaving);
      root.classList.remove("leaving", "settled");
      root.classList.toggle("reopen", started); // the pause menu comes back quickly; the first opening takes its time
      rendered = false;
      openedAt = performance.now();
      render();
      root.classList.add("show");
    },
  };
  return menu;
}
