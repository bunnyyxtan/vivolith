// Keyboard + mouse state. Listens on window so synthetic KeyboardEvents (tests) work.
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
  /** Enter or leave UI mode. Entering frees the cursor; leaving returns to mouse-look. */
  setUi(on: boolean): void;
  /** The Escape key of the current (or last) keydown only released pointer lock: it must not close anything. */
  readonly escapeReleasedLock: boolean;
}

/** An Escape this soon after the browser drops pointer lock is the same press (the keydown can land either side). */
const ESC_UNLOCK_MS = 250;

export function createInput(canvas: HTMLCanvasElement): Input {
  const held = new Set<string>();
  const pressed = new Set<string>();
  let dx = 0, dy = 0, wheel = 0, drag = false;
  let ui = false;
  let releasingForUi = false; // our own exitPointerLock: not the player asking for the cursor
  let unlockedAt = -Infinity, escReleased = false;
  const isLocked = () => document.pointerLockElement === canvas;
  const lock = (): void => {
    // Browsers refuse without a recent gesture or right after an Esc release: the next canvas click locks instead.
    try { void Promise.resolve(canvas.requestPointerLock?.()).catch(() => undefined); } catch { /* not allowed now */ }
  };

  const releaseForUi = (): void => { releasingForUi = true; document.exitPointerLock(); };
  let lockSeen = false; // lock state as of the last pointerlockchange: an Esc keydown can beat the event
  document.addEventListener("pointerlockchange", () => {
    lockSeen = isLocked();
    // a lock granted late (requested just before a panel opened) must not hide the cursor over the panel
    if (isLocked()) { if (ui) releaseForUi(); return; }
    if (!releasingForUi) unlockedAt = performance.now();
    releasingForUi = false;
  });
  window.addEventListener("keydown", (e) => {
    // typing into a panel field (the share count) is not a hotkey: digits would press buttons, "-" change amounts
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable) && e.code !== "Escape") return;
    if (e.code === "Escape") {
      escReleased = isLocked() || lockSeen || performance.now() - unlockedAt < ESC_UNLOCK_MS;
      if (escReleased) return;
    }
    if (!held.has(e.code)) pressed.add(e.code);
    held.add(e.code);
    if (e.code === "Space") e.preventDefault();
  });
  window.addEventListener("keyup", (e) => held.delete(e.code));
  window.addEventListener("blur", () => { held.clear(); drag = false; });
  canvas.addEventListener("click", () => { if (!ui && !isLocked()) lock(); });
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  // Look: pointer lock when the browser grants it; otherwise any held mouse button drags the view
  // (embedded panes often refuse pointer lock, which made the camera feel stuck).
  canvas.addEventListener("pointerdown", (e) => { if (ui) return; drag = true; canvas.setPointerCapture?.(e.pointerId); });
  window.addEventListener("pointerup", () => { drag = false; });
  window.addEventListener("mousemove", (e) => {
    if (!ui && (isLocked() || drag)) { dx += e.movementX; dy += e.movementY; }
  });
  canvas.addEventListener("wheel", (e) => { if (!ui) wheel += e.deltaY; e.preventDefault(); }, { passive: false });

  return {
    down: (c) => held.has(c),
    consumePress: (c) => pressed.delete(c),
    takeLook() { const r = { dx, dy }; dx = dy = 0; return r; },
    takeWheel() { const w = wheel; wheel = 0; return w; },
    flush() { pressed.clear(); dx = dy = 0; wheel = 0; },
    get locked() { return isLocked(); },
    get ui() { return ui; },
    get escapeReleasedLock() { return escReleased; },
    setUi(on) {
      if (on === ui) return;
      ui = on;
      drag = false;
      dx = dy = wheel = 0;
      // closing any panel returns to mouse-look, even after an Esc release (a refusal leaves the next click to lock)
      if (on && isLocked()) releaseForUi();
      else if (!on && !isLocked()) lock();
    },
  };
}
