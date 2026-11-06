// Keyboard + mouse state. Listens on window so synthetic KeyboardEvents (tests) work.
export interface Input {
  down(code: string): boolean;
  /** true once per press */
  consumePress(code: string): boolean;
  /** accumulated mouse delta since last call */
  takeLook(): { dx: number; dy: number };
  takeWheel(): number;
  readonly locked: boolean;
}

export function createInput(canvas: HTMLCanvasElement): Input {
  const held = new Set<string>();
  const pressed = new Set<string>();
  let dx = 0, dy = 0, wheel = 0, rightDrag = false;
  const isLocked = () => document.pointerLockElement === canvas;

  window.addEventListener("keydown", (e) => {
    if (!held.has(e.code)) pressed.add(e.code);
    held.add(e.code);
    if (e.code === "Space") e.preventDefault();
  });
  window.addEventListener("keyup", (e) => held.delete(e.code));
  window.addEventListener("blur", () => { held.clear(); rightDrag = false; });
  canvas.addEventListener("click", () => { if (!isLocked()) void canvas.requestPointerLock?.(); });
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  canvas.addEventListener("pointerdown", (e) => { if (e.button === 2) rightDrag = true; });
  window.addEventListener("pointerup", (e) => { if (e.button === 2) rightDrag = false; });
  window.addEventListener("mousemove", (e) => {
    if (isLocked() || rightDrag) { dx += e.movementX; dy += e.movementY; }
  });
  canvas.addEventListener("wheel", (e) => { wheel += e.deltaY; e.preventDefault(); }, { passive: false });

  return {
    down: (c) => held.has(c),
    consumePress: (c) => pressed.delete(c),
    takeLook() { const r = { dx, dy }; dx = dy = 0; return r; },
    takeWheel() { const w = wheel; wheel = 0; return w; },
    get locked() { return isLocked(); },
  };
}
