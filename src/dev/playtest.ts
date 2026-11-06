// Dev-only automated playtest helpers (loaded by main.ts only under `vite dev`). They step the game
// deterministically (the browser pane throttles rAF when hidden), drive input, time the full render
// pipeline, and save frames to docs/evidence through the dev-server endpoint (server/evidence.ts).
// Use from the console / browser tools:  await __pt.enter(); __pt.tp(x, z, yaw); __pt.sim(2); await __pt.shot("name")
import type * as THREE from "three";
import type { Box } from "../physics/collision";

interface Hooks {
  readonly player: { body: { x: number; y: number; z: number; vy: number }; mesh: THREE.Object3D; update(...a: never[]): void };
  readonly rig: { camera: THREE.PerspectiveCamera; yaw(): number; setView(y: number, p: number): void; update(...a: never[]): void };
  readonly world: { colliders: Box[]; update(t: number, focus: THREE.Vector3): void };
  readonly renderer: THREE.WebGLRenderer;
  readonly input: unknown;
  readonly gameplay: { frozen(): boolean; update(dt: number, started: boolean): void };
  readonly pipeline: { render(): void; resize(w: number, h: number): void };
  crowd?: { bodies: readonly Box[]; update(dt: number, p: THREE.Vector3): void };
}

type Call = (...a: unknown[]) => void;

export function installPlaytest(nw: Hooks): void {
  let t = 0; // world.update clamps dt, so interleaving with the live loop's clock is safe
  const key = (code: string, down: boolean) => window.dispatchEvent(new KeyboardEvent(down ? "keydown" : "keyup", { code }));
  const pt = {
    size(w: number, h: number) {
      nw.pipeline.resize(w, h);
      nw.rig.camera.aspect = w / h;
      nw.rig.camera.updateProjectionMatrix();
    },
    sim(seconds: number, step = 1 / 30) {
      for (let s = 0; s < seconds; s += step) {
        const solids = nw.world.colliders.concat(nw.crowd?.bodies ?? []);
        (nw.player.update as Call)(step, nw.input, nw.rig.yaw(), solids, nw.gameplay.frozen());
        (nw.rig.update as Call)(step, nw.input, nw.player.mesh.position, nw.world.colliders);
        nw.gameplay.update(step, true);
        nw.crowd?.update(step, nw.player.mesh.position);
        t += step;
        nw.world.update(t, nw.player.mesh.position);
      }
    },
    tp(x: number, z: number, yaw = 0, pitch = 0.15) {
      Object.assign(nw.player.body, { x, z, y: 0, vy: 0 });
      nw.player.mesh.position.set(x, 0, z);
      nw.rig.setView(yaw, pitch);
    },
    /** Hold a key for `seconds` of game time; returns the player's feet "x,z,y". */
    hold(code: string, seconds: number): string {
      key(code, true);
      pt.sim(seconds);
      key(code, false);
      pt.sim(0.3);
      const b = nw.player.body;
      return [b.x, b.z, b.y].map((v) => v.toFixed(2)).join(",");
    },
    press(code: string) {
      key(code, true);
      pt.sim(1 / 30);
      key(code, false);
      pt.sim(1 / 30);
    },
    async enter() {
      const play = document.querySelector<HTMLButtonElement>("#play");
      for (let i = 0; i < 90 && (!nw.crowd || play?.disabled); i++) await new Promise((r) => setTimeout(r, 1000));
      play?.click();
      pt.size(1280, 720);
    },
    /** Render one frame (optionally from a free camera) and save it as docs/evidence/<name>.jpg. */
    async shot(name: string, cam?: { pos: [number, number, number]; at: [number, number, number] }) {
      if (cam) {
        nw.rig.camera.position.set(...cam.pos);
        nw.rig.camera.lookAt(...cam.at);
        nw.rig.camera.updateMatrixWorld();
      }
      nw.pipeline.render();
      const blob = await new Promise<Blob | null>((r) => nw.renderer.domElement.toBlob(r, "image/jpeg", 0.88));
      if (!blob) throw new Error("canvas capture failed");
      const res = await fetch(`/__evidence?name=${encodeURIComponent(name)}`, { method: "POST", body: blob });
      return `${res.status} ${await res.text()}`;
    },
    /** Median full-pipeline frame time (ms), synchronised with gl.finish() like the existing audit. */
    frameTime(frames = 60): { medianMs: number; calls: number; triangles: number } {
      const gl = nw.renderer.getContext();
      const times: number[] = [];
      for (let i = 0; i < frames; i++) {
        gl.finish();
        const t0 = performance.now();
        nw.pipeline.render();
        gl.finish();
        times.push(performance.now() - t0);
      }
      times.sort((a, b) => a - b);
      const info = nw.renderer.info.render;
      return { medianMs: Number(times[Math.floor(frames / 2)].toFixed(2)), calls: info.calls, triangles: info.triangles };
    },
  };
  (window as unknown as { __pt: typeof pt }).__pt = pt;
}
