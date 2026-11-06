// Keyboard + pointer-lock mouse state. Read once per frame by the player and camera.

export interface Input {
  readonly keys: ReadonlySet<string>;
  /** Mouse movement since the last call, then reset to zero. */
  takeLook(): { dx: number; dy: number };
  /** Mouse-wheel steps since the last call (positive = zoom out), then reset. */
  takeZoom(): number;
  /** True once per key press (edge-triggered). */
  pressed(code: string): boolean;
  locked(): boolean;
}

export function createInput(canvas: HTMLCanvasElement): Input {
  const keys = new Set<string>();
  const fresh = new Set<string>();
  let dx = 0;
  let dy = 0;

  window.addEventListener("keydown", (e) => {
    if (!keys.has(e.code)) fresh.add(e.code);
    keys.add(e.code);
    if (e.code === "Space") e.preventDefault();
  });
  window.addEventListener("keyup", (e) => keys.delete(e.code));
  window.addEventListener("blur", () => keys.clear());
  // Orbit with the mouse: free look when pointer-locked, or hold any button and drag
  // (pointer lock is unavailable in some embedded browsers).
  let dragging = false;
  let zoom = 0;
  canvas.addEventListener("pointerdown", (e) => {
    dragging = true;
    try { canvas.setPointerCapture(e.pointerId); } catch { /* capture is best-effort */ }
  });
  const endDrag = (e: PointerEvent) => {
    dragging = false;
    try { canvas.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
  };
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  document.addEventListener("pointermove", (e) => {
    if (document.pointerLockElement !== canvas && !dragging) return;
    dx += e.movementX;
    dy += e.movementY;
  });
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    zoom += Math.sign(e.deltaY);
  }, { passive: false });

  return {
    keys,
    takeLook() {
      const look = { dx, dy };
      dx = 0;
      dy = 0;
      return look;
    },
    takeZoom() {
      const z = zoom;
      zoom = 0;
      return z;
    },
    pressed(code) {
      const hit = fresh.has(code);
      fresh.delete(code);
      return hit;
    },
    locked: () => document.pointerLockElement === canvas,
  };
}
