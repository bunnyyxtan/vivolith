// Keyboard + mouse state. Listens on window so synthetic KeyboardEvents (tests) work.
//
// The cursor follows one state machine, so it is never in the wrong place:
//   look  exploring: cursor hidden, the mouse turns the camera (pointer lock; until the browser grants it, a "soft"
//         look hides the cursor and reads raw mouse motion, and the next key or click upgrades it to the lock)
//   ui    a panel or menu is up: cursor visible, camera parked. Closing it returns to look, by itself.
//   free  the player pressed Esc while exploring: cursor visible, camera parked. Clicking the game returns to look.
export interface Input {
  down(code: string): boolean;
  /** true once per press */
  consumePress(code: string): boolean;
  /** accumulated mouse delta since last call */
  takeLook(): { dx: number; dy: number };
  takeWheel(): number;
  /** Drops queued presses and mouse motion (e.g. keys used in the menu must not act in the game). */
  flush(): void;
  readonly locked: boolean;
  /** A panel or menu is up: the cursor is free for its buttons and the mouse does not turn the camera. */
  readonly ui: boolean;
  /** The player released the cursor with Esc while exploring (a click on the game takes it back). */
  readonly free: boolean;
  /** Enter or leave UI mode. Entering frees the cursor; leaving returns to mouse-look. */
  setUi(on: boolean): void;
  /** The Escape key of the current (or last) keydown only released the cursor: it must not close or open anything. */
  readonly escapeReleasedLock: boolean;
}

/** An Escape this soon after the browser drops pointer lock is the same press (the keydown can land either side). */
const ESC_UNLOCK_MS = 250;
/** Soft look without the lock: the hidden cursor stops at the screen edge, so holding it in this edge band keeps
 *  turning the camera (full 360), up to EDGE_TURN mouse pixels a second at the very edge. */
const EDGE_BAND = 0.06; // of the window width
const EDGE_TURN = 1400;
const LOOK_CLASS = "vv-look";

export function createInput(canvas: HTMLCanvasElement): Input {
  const held = new Set<string>();
  const pressed = new Set<string>();
  let dx = 0, dy = 0, wheel = 0, drag = false;
  let ui = true; // until the game says otherwise (the loading screen and title menu keep the cursor)
  let free = false; // Esc released the cursor during exploration
  let releasingForUi = false; // our own exitPointerLock: not the player asking for the cursor
  let unlockedAt = -Infinity, escReleased = false;
  const isLocked = (): boolean => document.pointerLockElement === canvas;
  /** Exploring without the lock yet: the cursor is hidden and raw motion turns the camera. */
  const soft = (): boolean => !ui && !free && !isLocked();

  const style = document.createElement("style");
  // Soft look behaves like the lock: no cursor, and the HUD is click-through (a blind click lands on the game and
  // takes the lock instead of opening a pill the player cannot see).
  style.textContent = `body.${LOOK_CLASS}, body.${LOOK_CLASS} * { cursor: none !important; }
body.${LOOK_CLASS} .hud, body.${LOOK_CLASS} .hud * { pointer-events: none !important; }`;
  document.head.append(style);
  const refresh = (): void => { document.body.classList.toggle(LOOK_CLASS, soft()); };

  const lock = (): void => {
    // Browsers grant the lock only during a user gesture (and never on an Escape keydown). A refusal is fine: soft
    // look covers it, and the next key or click asks again.
    try { void Promise.resolve(canvas.requestPointerLock?.()).catch(() => undefined); } catch { /* not allowed now */ }
  };
  const releaseForUi = (): void => { releasingForUi = true; document.exitPointerLock(); };

  let lockSeen = false; // lock state as of the last pointerlockchange: an Esc keydown can beat the event
  document.addEventListener("pointerlockchange", () => {
    lockSeen = isLocked();
    if (isLocked()) {
      free = false;
      if (ui) releaseForUi(); // a lock granted late (requested just before a panel opened) must not hide the cursor
    } else {
      if (!releasingForUi) { unlockedAt = performance.now(); if (!ui) free = true; } // the player's Esc (or the browser)
      releasingForUi = false;
    }
    refresh();
  });
  window.addEventListener("keydown", (e) => {
    // typing into a panel field (the share count) is not a hotkey: digits would press buttons, "-" change amounts
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable) && e.code !== "Escape") return;
    if (e.code === "Escape") {
      // Esc while exploring only releases the cursor: locked (the browser unlocks), just unlocked, or in soft look
      escReleased = isLocked() || lockSeen || performance.now() - unlockedAt < ESC_UNLOCK_MS || soft();
      if (soft()) { free = true; refresh(); }
      if (escReleased) return;
    } else if (soft() && !e.repeat) lock(); // any key is a gesture: upgrade soft look to the real lock
    if (!held.has(e.code)) pressed.add(e.code);
    held.add(e.code);
    if (e.code === "Space") e.preventDefault();
  });
  window.addEventListener("keyup", (e) => held.delete(e.code));
  window.addEventListener("blur", () => { held.clear(); drag = false; });
  // Clicking the game takes the cursor back (after Esc) or upgrades soft look; never while a panel is up.
  canvas.addEventListener("click", () => {
    if (ui || isLocked()) return;
    free = false;
    refresh();
    lock();
  });
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  // Embedded panes may refuse pointer lock for good: a held mouse button still drags the view.
  canvas.addEventListener("pointerdown", (e) => { if (ui) return; drag = true; canvas.setPointerCapture?.(e.pointerId); });
  // Any button pressed in the game while the cursor is hidden is a gesture: ask for the real lock (unlimited turning).
  window.addEventListener("pointerdown", () => { if (soft()) lock(); }, true);
  window.addEventListener("pointerup", () => { drag = false; });
  let mx = -1, lastTake = performance.now(); // cursor x for the edge band; -1 when it left the window
  window.addEventListener("mousemove", (e) => {
    mx = e.clientX;
    if (!ui && (isLocked() || drag || soft())) { dx += e.movementX; dy += e.movementY; }
  });
  document.documentElement.addEventListener("mouseleave", () => { mx = -1; });
  /** Edge turning in soft look: how far into the left (-1) or right (+1) band the hidden cursor sits. */
  const edge = (): number => {
    if (!soft() || mx < 0) return 0;
    const band = Math.max(24, innerWidth * EDGE_BAND);
    if (mx < band) return -(1 - mx / band);
    if (mx > innerWidth - band) return (mx - (innerWidth - band)) / band;
    return 0;
  };
  canvas.addEventListener("wheel", (e) => { if (!ui) wheel += e.deltaY; e.preventDefault(); }, { passive: false });

  return {
    down: (c) => held.has(c),
    consumePress: (c) => pressed.delete(c),
    takeLook() {
      const now = performance.now(), dt = Math.min(0.1, (now - lastTake) / 1000);
      lastTake = now;
      dx += edge() * EDGE_TURN * dt;
      const r = { dx, dy }; dx = dy = 0; return r;
    },
    takeWheel() { const w = wheel; wheel = 0; return w; },
    flush() { pressed.clear(); dx = dy = 0; wheel = 0; },
    get locked() { return isLocked(); },
    get ui() { return ui; },
    get free() { return free; },
    get escapeReleasedLock() { return escReleased; },
    setUi(on) {
      if (on === ui) return;
      ui = on;
      drag = false;
      dx = dy = wheel = 0;
      if (on) { if (isLocked()) releaseForUi(); }
      else { free = false; if (!isLocked()) lock(); } // closing any panel returns to mouse-look by itself
      refresh();
    },
  };
}
