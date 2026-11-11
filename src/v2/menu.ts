// Boot loader and main menu. The loader is a quiet ink screen with a status line and a thin progress rule; the
// menu sits over the live city: Kavi seen from behind on the plaza, looking up at the N Spire, the camera drifting.
// One type family (Inter Tight), no cards: a title, one line of where you are, and a list.
import * as THREE from "three";
import type { Game } from "./game";
import type { Play } from "./play";
import { clockOf, MERCHANT_IDS } from "../economy/state";
import { shareSupply } from "../economy/sim";

const CSS = /* css */ `
#boot { position:fixed; inset:0; z-index:30; background:#0e1520; color:#eef2f0; display:flex; flex-direction:column; align-items:center; justify-content:center;
  font-family:"Inter Tight",system-ui,sans-serif; transition:opacity .8s ease; user-select:none; }
#boot.gone { opacity:0; pointer-events:none; }
#boot h1 { margin:0; font-weight:700; font-size:30px; letter-spacing:.42em; padding-left:.42em; }
#boot p { margin:12px 0 18px; font-size:13px; letter-spacing:.16em; color:#93a3b0; min-height:1.2em; }
#boot .rule { width:180px; height:1px; background:#2a3344; position:relative; overflow:hidden; }
#boot .rule i { position:absolute; left:0; top:0; bottom:0; width:0; background:#00ec97; transition:width .35s ease; }
#boot.err .rule i { background:#ff7a6b; }

#menu { position:fixed; inset:0; z-index:25; font-family:"Inter Tight",system-ui,sans-serif; color:#fff; display:none; user-select:none;
  background:linear-gradient(90deg, rgba(8,14,26,.86) 0%, rgba(8,14,26,.72) 30%, rgba(8,14,26,.28) 52%, rgba(8,14,26,0) 66%); }
#menu.show { display:block; animation:menuIn .9s ease both; }
@keyframes menuIn { from { opacity:0 } to { opacity:1 } }
#menu .col { position:absolute; left:clamp(16px, 7.5vw, 144px); top:clamp(16px, 11vh, 128px); right:16px; max-width:560px;
  bottom:calc(var(--foot-h) + clamp(10px, 3vh, 28px)); overflow-y:auto; overscroll-behavior:contain; padding:4px 8px 8px 0;
  scrollbar-width:thin; scrollbar-color:rgba(255,255,255,.35) transparent; }
#menu { --foot-h:28px; }
#menu h1 { margin:0; font-weight:700; font-size:clamp(28px, min(6.6vw, 11vh), 96px); letter-spacing:.14em; line-height:1.05; text-shadow:0 2px 24px rgba(0,20,50,.35); overflow-wrap:anywhere; }
#menu .where { margin:clamp(8px, 2.2vh, 18px) 0 clamp(10px, 4vh, 34px); font-size:clamp(13px, min(1.25vw, 2.6vh), 17px); color:rgba(255,255,255,.86); letter-spacing:.02em; text-shadow:0 1px 8px rgba(0,20,50,.5); overflow-wrap:anywhere; }
#menu ul { list-style:none; margin:0; padding:0; }
#menu li { position:relative; padding:clamp(3px, .9vh, 7px) 0 clamp(3px, .9vh, 7px) 34px; font-size:clamp(17px, min(2vw, 4.4vh), 28px); font-weight:600; color:rgba(255,255,255,.72); cursor:pointer;
  text-shadow:0 1px 10px rgba(0,20,50,.55); transition:color .15s, transform .15s; }
#menu li::before { content:""; position:absolute; left:0; top:calc(clamp(3px, .9vh, 7px) + .6em); width:18px; height:4px; background:#00ec97; transform:scaleX(0); transform-origin:left; transition:transform .18s ease; }
#menu li.on { color:#fff; transform:translateX(4px); }
#menu li.on::before { transform:scaleX(1); }
#menu li small { display:block; font-size:13px; font-weight:400; color:rgba(255,255,255,.7); margin-top:2px; letter-spacing:.02em; overflow-wrap:anywhere; }
#menu .sheet { margin-top:clamp(12px, 3vh, 26px); max-width:440px; font-size:clamp(13px, 2.4vh, 15px); line-height:1.5; color:rgba(255,255,255,.92); text-shadow:0 1px 8px rgba(0,20,50,.6); }
#menu .sheet b { color:#fff; } #menu .sheet kbd { font:700 12px "Inter Tight",system-ui,sans-serif; background:#fff; color:#10151f; padding:1px 6px; border-radius:2px; margin-right:6px; }
#menu .sheet .confirm { display:flex; flex-wrap:wrap; gap:10px; }
#menu .sheet button { font:600 14px "Inter Tight",system-ui,sans-serif; color:#fff; background:rgba(10,20,40,.35); border:1px solid rgba(255,255,255,.7); padding:7px 12px 7px 8px; cursor:pointer; }
#menu .sheet button:hover { background:#fff; color:#10151f; }
#menu .sheet table { border-collapse:collapse; } #menu .sheet td { padding:3px 18px 3px 0; vertical-align:top; }
#menu .name { display:flex; align-items:center; gap:10px; margin-top:clamp(4px, 1vh, 8px); max-width:360px; }
#menu .name input { flex:1; min-width:0; font:600 clamp(16px, min(1.7vw, 3.6vh), 22px) "Inter Tight",system-ui,sans-serif; color:#fff; caret-color:#00ec97;
  background:rgba(8,14,26,.35); border:0; border-bottom:2px solid rgba(255,255,255,.55); padding:6px 8px; outline:none; transition:border-color .15s, background .15s; }
#menu .name input::placeholder { color:rgba(255,255,255,.45); }
#menu .name input:focus { border-bottom-color:#00ec97; background:rgba(8,14,26,.55); }
#menu .name button { font:700 14px "Inter Tight",system-ui,sans-serif; color:#0b1a14; background:#00ec97; border:0; padding:8px 14px; cursor:pointer; }
#menu .name button:hover { background:#fff; }
#menu li .err { color:#ffb4a8; }
#menu .foot { position:absolute; left:clamp(16px, 7.5vw, 144px); bottom:clamp(10px, 3vh, 28px); right:16px; height:var(--foot-h); line-height:var(--foot-h); font-size:12px; letter-spacing:.14em; text-transform:uppercase; color:rgba(255,255,255,.7); text-shadow:0 1px 6px rgba(0,20,50,.6); }
body.in-menu .hud, body.in-menu #hint { display:none !important; }
@media (max-width:640px) { #menu { background:linear-gradient(180deg, rgba(8,14,26,.6) 0%, rgba(8,14,26,.3) 55%, rgba(8,14,26,0) 80%); } }
`;

/** Status lines shown while the city loads, by progress. */
const STAGES: readonly [number, string][] = [
  [0, "laying the paving stones"],
  [0.3, "raising the N Spire"],
  [0.55, "stocking the stalls"],
  [0.8, "waking the merchants"],
  [0.95, "opening the market"],
];

export interface Boot {
  progress(p: number): void;
  fail(message: string): void;
  hide(): void;
}

export function createBoot(): Boot {
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);
  const root = document.getElementById("boot")!;
  const status = root.querySelector("p")!;
  const fill = root.querySelector<HTMLElement>(".rule i")!;
  let shown = 0;
  return {
    progress(p) {
      shown = Math.max(shown, Math.min(1, p));
      fill.style.width = `${Math.round(shown * 100)}%`;
      const line = [...STAGES].reverse().find(([at]) => shown >= at)?.[1] ?? "";
      if (status.textContent !== line) status.textContent = line;
    },
    fail(message) {
      root.classList.add("err");
      status.textContent = message;
    },
    hide() {
      root.classList.add("gone");
      window.setTimeout(() => root.remove(), 900);
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
export function createMenu(game: Game, play: Play): { open(): void } {
  const root = document.getElementById("menu")!;
  const { player, rig } = game;
  const vantage = game.look.scene.getObjectByName("SPAWN")?.getWorldPosition(new THREE.Vector3()) ?? new THREE.Vector3(0, 0, -30);
  let isOpen = false, started = false, sel = 0, items: Item[] = [], sheet: "" | "how" | "new" | "signout" = "", t = 0;

  // Cinematic: runs after the rig each frame, so it owns the camera while the menu is open.
  const fwd = new THREE.Vector3(0, 0, -1), right = new THREE.Vector3(1, 0, 0);
  const cam = new THREE.Vector3(), look = new THREE.Vector3();
  game.onUpdate.push((dt) => {
    if (!isOpen) return;
    t += dt;
    const p = player.root.position;
    const sway = Math.sin(t * 0.12) * 0.5;
    // Camera behind Kavi's left shoulder, aimed past him at the Spire: he stands right of centre, the N above him.
    cam.copy(p).addScaledVector(fwd, -5.4).addScaledVector(right, -1.5 + sway).setY(p.y + 1.7);
    look.copy(p).addScaledVector(fwd, 40).addScaledVector(right, -4 + sway * 2).setY(p.y + 10.5);
    rig.camera.position.copy(cam);
    rig.camera.lookAt(look);
  });

  const esc = (t: string): string => t.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const cap = (s: string): string => s[0].toUpperCase() + s.slice(1);
  const savedName = (): string => (typeof play.state.flags.name === "string" ? play.state.flags.name : "");
  /** A brand-new player who is not signed in picks: a name (guest) or Google. */
  const firstVisit = (): boolean => !started && !play.restored && !play.account().label && !savedName();
  let nameDraft = "", nameErr = "";
  const where = (): string => {
    const a = play.account();
    const who = cap(a.label ? `signed in as ${a.label}` : savedName() ? `playing as ${savedName()}` : a.id ? "playing as guest" : "connecting to NEAR");
    if (!play.restored && !started) return `Saltlight Market, a NEAR city where every merchant has a wallet. ${who}.`;
    const s = play.state;
    const shares = MERCHANT_IDS.filter((id) => s.player.shares[id] > 0).map((id) => `${s.player.shares[id]}/${shareSupply(s, id)} of ${s.merchants[id].shop}`);
    return `${clockOf(s.minute).replace(/^(Day \d+) /, "$1, ")}. ${s.player.coins} ${s.player.coins === 1 ? "coin" : "coins"}${shares.length ? `, ${shares.join(", ")}` : ""}. ${who}.`;
  };

  const enter = (): void => {
    isOpen = false;
    root.classList.remove("show");
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
    return { label: "Continue with Google", note: ready ? "Keep your market on any device" : "Connecting to NEAR…", run: () => { if (ready) void play.signIn().then(render); } };
  };

  const build = (): void => {
    const a = play.account();
    if (firstVisit()) {
      items = [{ label: "Play with a name", name: true, run: playWithName }];
      if (a.canSignIn) items.push(google());
    } else {
      const who = a.label ? undefined : savedName() || undefined;
      items = [{ label: started ? "Resume" : play.restored ? "Continue" : "Play", note: who, run: enter }];
      if (play.restored || started) items.push({ label: "New Game", run: () => { sheet = "new"; render(); } });
      // Signing out asks first: it is the one item that changes whose account is playing.
      if (a.label) items.push({ label: "Sign out", note: a.label, run: () => { sheet = "signout"; render(); } });
      else if (a.canSignIn && a.id) items.push(google());
    }
    items.push({ label: "How to play", run: () => { sheet = sheet === "how" ? "" : "how"; render(); } });
    sel = Math.min(sel, items.length - 1);
  };

  const sheetHtml = (): string => {
    if (sheet === "how") return `<div class="sheet">
      <p><b>Trade with the four merchants.</b> Pema is loyal and never gouges. Tomas charges what a shortage allows. Mira buys surplus and undercuts. Arin pays a steady price for mangoes.</p>
      <table>
        <tr><td><kbd>WASD</kbd>move</td><td><kbd>Shift</kbd>run</td></tr>
        <tr><td><kbd>F</kbd>talk or trade</td><td><kbd>B</kbd>your bag</td></tr>
        <tr><td><kbd>J</kbd>goals</td><td><kbd>H</kbd>help</td></tr>
        <tr><td><kbd>N</kbd>your NEAR account</td><td><kbd>Esc</kbd>this menu</td></tr>
      </table>
      <p>Look at a chalkboard to see why a price is what it is. Every deal and share is recorded on NEAR testnet, with no wallet popups.</p></div>`;
    if (sheet === "signout") return `<div class="sheet">
      <p><b>Sign out of ${esc(play.account().label ?? "")}?</b> Your coins, goods and shares stay in that NEAR account; sign in again on any device to get them back. This browser goes back to its guest game.</p>
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
    root.innerHTML = `<div class="col"><h1>VIVOLITH</h1><div class="where"></div><ul></ul>${sheetHtml()}</div><div class="foot">NEAR testnet</div>`;
    root.querySelector(".where")!.textContent = where();
    const ul = root.querySelector("ul")!;
    items.forEach((it, i) => {
      const li = document.createElement("li");
      li.className = i === sel ? "on" : "";
      li.textContent = it.label;
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
  };

  // The guest account connects in the background: refresh the status line and items when it does.
  let lastAcct = "";
  window.setInterval(() => {
    if (!isOpen) return;
    const a = play.account(), key = `${a.id}|${a.label}|${a.canSignIn}`;
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
      render();
      root.classList.add("show");
    },
  };
  return menu;
}
