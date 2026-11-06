// Gameplay orchestration: economy time, interactions, conversations, HUD, inspector, saves, NEAR receipts.
// Rendering/world code only receives views (StallView, talk/focus); rules live in economy/ and quests/.
import type { Input } from "./input";
import type { Player } from "./player";
import type { CameraRig } from "./camera";
import type { Interactable, ScreenView, World } from "./world";
import { advance } from "./economy/sim.ts";
import { quote } from "./economy/pricing.ts";
import { clearSave, loadGame, saveGame } from "./economy/save.ts";
import { clockOf, MINUTES_PER_DAY, type EconomyState } from "./economy/state.ts";
import { CONVERSATIONS } from "./quests/mango.ts";
import type { DialogueContext } from "./quests/dialogue.ts";
import { createDialogueUI } from "./ui/dialogue.ts";
import { createHud } from "./ui/hud.ts";
import { createInspector } from "./ui/inspector.ts";
import { nearStatus, settleReceipt } from "./near/receipts.ts";
import type { PortraitStudio } from "./render";

/** Game minutes per real second during normal play (a market day lasts 24 real minutes). */
const TIME_SCALE = 1;
/** Fast-forward speed: one week in ~40 seconds. */
const FF_MINUTES_PER_SECOND = (7 * MINUTES_PER_DAY) / 40;
const AUTOSAVE_SECONDS = 8;

export interface Gameplay {
  update(dt: number, started: boolean): void;
  /** True while the player should not move (conversation open). */
  frozen(): boolean;
  readonly state: () => EconomyState;
}

function objectiveFor(s: EconomyState): string | null {
  const st = s.flags.mango;
  const sh = s.shipments.find((x) => x.id === "pema-mangoes")!;
  if (!st) return "Talk to Auntie Pema at the blue-striped fruit stall.";
  if (st === "accepted" || st === "accepted_hard") {
    if (sh.status === "held") return "Go to the harbor dispatch board at the end of Pier Road (south of the plaza).";
    if (sh.status === "transit") return `The cart is on its way (${clockOf(sh.arriveAt ?? s.minute)}). Meet Pema at her stall.`;
    return "The mangoes arrived. Collect your reward from Pema.";
  }
  return null;
}

export function createGameplay(
  hudRoot: HTMLElement, world: World, player: Player, rig: CameraRig, input: Input, portrait: PortraitStudio,
): Gameplay {
  const loaded = loadGame();
  let econ = loaded.state;
  const hud = createHud(hudRoot);
  const dialogue = createDialogueUI(hudRoot);
  let ffRemaining = 0;
  let saveTimer = 0;
  let cooldown = 0;
  let seenLog = econ.log.length;

  const persist = () => saveGame(econ);
  const inspector = createInspector(hudRoot, {
    fastForward: (days) => {
      ffRemaining += days * MINUTES_PER_DAY;
      hud.toast(`Fast-forward: ${days} day${days > 1 ? "s" : ""} of trading (demo).`);
    },
    reset: () => {
      clearSave();
      econ = loadGame().state;
      seenLog = econ.log.length;
      ffRemaining = 0;
      hud.toast("New game: Saltlight Market reset to Day 1, 09:00.");
    },
  });

  const ctx = (): DialogueContext => ({
    econ,
    toast: (t) => hud.toast(t),
    settle: (kind, detail) => {
      const summary = Object.entries(detail).map(([k, v]) => `${k}=${v}`).join(" ").concat(` at ${clockOf(econ.minute)}`);
      void settleReceipt(econ, kind, summary).then((r) => {
        hud.receipt(r);
        persist();
      });
    },
  });

  window.addEventListener("keydown", (e) => {
    if (e.code === "Tab") {
      e.preventDefault();
      inspector.toggle();
    }
  });

  if (loaded.restored) hud.toast(`Save restored · ${clockOf(econ.minute)}`);
  void nearStatus().then((n) => {
    hud.toast(n.configured ? `NEAR testnet: receipts as ${n.accountId}` : "NEAR testnet not configured: receipts stay local (see README)");
  });

  function nearest(): Interactable | null {
    let best: Interactable | null = null;
    let bestD = Infinity;
    for (const it of world.interactables) {
      const d = Math.hypot(it.position.x - player.body.x, it.position.z - player.body.z);
      if (d < it.radius && d < bestD) { best = it; bestD = d; }
    }
    return best;
  }

  function reflectWorld(): void {
    const p = econ.merchants.pema;
    world.setStall("pema", {
      open: p.status === "open",
      hasGoods: p.stock.mango + p.stock.lemon > 0,
      title: "PEMA'S",
      rows: [
        ["Mangoes", p.stock.mango > 0 ? `${quote(econ, "pema", "mango").price} c` : "sold out"],
        ["Lemons", p.stock.lemon > 0 ? `${quote(econ, "pema", "lemon").price} c` : "sold out"],
      ],
    });
  }

  // Spire displays: repainted only when their text changes (canvas upload is not free).
  const lastScreens: Record<string, string> = {};
  function reflectScreens(): void {
    const sh = econ.shipments.find((x) => x.id === "pema-mangoes")!;
    const onchain = econ.receipts.filter((r) => r.status === "onchain");
    const last = onchain[onchain.length - 1];
    const contract = econ.flags.contract === "challenged" ? "[SUSPENDED]" : "[ACTIVE]";
    const views: Array<["spire_info" | "labs_board", ScreenView]> = [
      ["spire_info", {
        title: "NEAR SPIRE · LOBBY",
        lines: [
          clockOf(econ.minute).slice(0, -3) + ":00",
          "",
          "Saltlight Row ledger",
          `receipts ${econ.receipts.length} · on NEAR testnet ${onchain.length}`,
          last?.txHash ? `last tx ${last.txHash.slice(0, 14)}...` : "last tx: none yet",
          "",
          "NEAR Labs: door behind reception, right",
        ],
      }],
      ["labs_board", {
        title: "AGENT FEED · HARBOR LEDGER",
        lines: [
          `berth 2 standing contract  T. VELL ${contract}`,
          `pema-mangoes  30 crates  ${sh.status.toUpperCase()}`,
          sh.status === "held" ? `  queued behind contract cargo` : "",
          sh.status === "held" ? `  auto-release ${clockOf(sh.autoReleaseAt)}` : "",
          `tea house mango ${econ.merchants.teahouse.stock.mango} · forward order ${econ.flags.forwardQty ?? 0}`,
          `pema cash ${Math.round(econ.merchants.pema.cash)} c · rent ${econ.merchants.pema.rent} c at 21:00`,
          `vell restock 06:00 ${econ.flags.contract === "challenged" ? "BLOCKED" : "ok"}`,
        ],
      }],
    ];
    for (const [id, view] of views) {
      const key = view.lines.join("|");
      if (lastScreens[id] === key) continue;
      lastScreens[id] = key;
      world.setScreen(id, view);
    }
  }

  function announceNewEvents(): void {
    for (const e of econ.log.slice(seenLog)) {
      if (e.kind === "closed" || e.kind === "reopened" || e.kind === "shipment") hud.toast(e.text);
    }
    seenLog = econ.log.length;
  }

  return {
    state: () => econ,
    frozen: () => dialogue.isOpen(),
    update(dt, started) {
      const ffStep = Math.min(ffRemaining, FF_MINUTES_PER_SECOND * dt);
      ffRemaining -= ffStep;
      advance(econ, dt * TIME_SCALE + ffStep);
      reflectWorld();
      reflectScreens();
      announceNewEvents();
      dialogue.update(dt);
      inspector.update(econ);
      cooldown = Math.max(0, cooldown - dt);

      if (started && !dialogue.isOpen()) {
        const near = nearest();
        hud.prompt(near ? `Talk to ${near.name}` : null);
        if (near && cooldown === 0 && input.pressed("KeyE")) {
          const conv = CONVERSATIONS[near.id];
          if (conv) {
            hud.prompt(null);
            rig.setFocus(near.focus);
            world.talk(near.id);
            const eye = player.mesh.position.clone();
            eye.y += 1.5;
            dialogue.open(conv, ctx(), () => {
              rig.setFocus(null);
              world.talk(null);
              cooldown = 0.4;
              persist();
            }, portrait(near.focus, eye));
          }
        }
      } else {
        input.pressed("KeyE"); // drain presses consumed by the dialogue
      }

      hud.update(econ, objectiveFor(econ), ffRemaining > 0);
      saveTimer += dt;
      if (saveTimer > AUTOSAVE_SECONDS) {
        saveTimer = 0;
        persist();
      }
    },
  };
}
