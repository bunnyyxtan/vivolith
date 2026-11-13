// Over-the-shoulder follow camera with orbit, zoom and wall/ground collision.
import * as THREE from "three";
import { groundHeightAt, type Box } from "../physics/collision";
import type { Input } from "./input";

const SENS = 0.0022;
const KEY_RATE = 2.2; // rad/s for Q/E and arrow-key orbit
const MIN_PITCH = -0.85, MAX_PITCH = 1.3;
const MIN_DIST = 2.2, MAX_DIST = 9;
const SHOULDER = 0; // character centred on screen (was 0.65 m over-the-shoulder)
const GROUND_CLEARANCE = 0.35;
const WALL_PAD = 0.3;
const POLE = 0.5; // colliders thinner than this on both axes never pull the camera in

export interface CameraRig {
  readonly camera: THREE.PerspectiveCamera;
  yaw: number;
  pitch: number;
  dist: number;
  update(dt: number, input: Input, focus: THREE.Vector3, colliders: readonly Box[]): void;
  /** jump straight to the resting position (no easing) */
  snap(focus: THREE.Vector3, colliders: readonly Box[]): void;
  resize(aspect: number): void;
}

/** Slab test: distance along unit dir to the first box (inflated by pad) within maxT, else maxT. */
function clipRay(o: THREE.Vector3, d: THREE.Vector3, maxT: number, boxes: readonly Box[], pad: number): number {
  let best = maxT;
  for (const b of boxes) {
    // lamp posts, sign poles, bollards: they hide a sliver of the view; cutting the camera into Kavi's back for each one
    // the arm sweeps past (177 in town, lining the market walk) was far worse
    if (b.maxX - b.minX < POLE && b.maxZ - b.minZ < POLE) continue;
    let t0 = 0, t1 = best;
    const lo = [b.minX - pad, b.minY - pad, b.minZ - pad], hi = [b.maxX + pad, b.maxY + pad, b.maxZ + pad];
    const oo = [o.x, o.y, o.z], dd = [d.x, d.y, d.z];
    let hit = true;
    for (let i = 0; i < 3; i++) {
      if (Math.abs(dd[i]) < 1e-8) {
        if (oo[i] < lo[i] || oo[i] > hi[i]) { hit = false; break; }
        continue;
      }
      let a = (lo[i] - oo[i]) / dd[i], c = (hi[i] - oo[i]) / dd[i];
      if (a > c) [a, c] = [c, a];
      t0 = Math.max(t0, a);
      t1 = Math.min(t1, c);
      if (t0 > t1) { hit = false; break; }
    }
    if (hit && t0 < best) best = t0;
  }
  return best;
}

export function createCameraRig(aspect: number, yaw: number): CameraRig {
  const camera = new THREE.PerspectiveCamera(52, aspect, 0.1, 2500);
  const smooth = new THREE.Vector3();
  const dir = new THREE.Vector3();
  const right = new THREE.Vector3();
  const pivot = new THREE.Vector3();
  const toCam = new THREE.Vector3();
  const pos = new THREE.Vector3();
  const aim = new THREE.Vector3();
  let curDist = 5.2;
  let first = true;

  const rig: CameraRig = {
    camera, yaw, pitch: 0.26, dist: 5.2,
    resize(a) { camera.aspect = a; camera.updateProjectionMatrix(); },
    snap(focus, colliders) { first = true; rig.update(0, NO_INPUT, focus, colliders); },
    update(dt, input, focus, colliders) {
      const { dx, dy } = input.takeLook();
      // Keyboard orbit too (Q/E or arrows), so the view never depends on the mouse alone.
      const keyYaw = (input.down("KeyE") || input.down("ArrowRight") ? 1 : 0) - (input.down("KeyQ") || input.down("ArrowLeft") ? 1 : 0);
      const keyPitch = (input.down("ArrowDown") ? 1 : 0) - (input.down("ArrowUp") ? 1 : 0);
      rig.yaw -= dx * SENS + keyYaw * KEY_RATE * dt; // drag right / E turns the view right
      // Full 360 yaw; pitch from looking up at the sky (camera low) to looking down from above.
      rig.pitch = THREE.MathUtils.clamp(rig.pitch + dy * SENS + keyPitch * KEY_RATE * 0.6 * dt, MIN_PITCH, MAX_PITCH);
      rig.dist = THREE.MathUtils.clamp(rig.dist + input.takeWheel() * 0.004, MIN_DIST, MAX_DIST);

      if (first) smooth.copy(focus); else smooth.lerp(focus, 1 - Math.exp(-12 * dt));

      const cp = Math.cos(rig.pitch), sp = Math.sin(rig.pitch);
      dir.set(Math.sin(rig.yaw) * cp, -sp, Math.cos(rig.yaw) * cp); // look direction
      right.set(-Math.cos(rig.yaw), 0, Math.sin(rig.yaw)); // screen-right of the look direction
      pivot.copy(smooth).addScaledVector(right, SHOULDER);
      toCam.copy(pivot).addScaledVector(dir, -rig.dist).sub(smooth);
      const len = toCam.length();
      toCam.divideScalar(len);

      // cut in instantly when a wall is in the way, ease back out
      let free = Math.max(0.6, clipRay(smooth, toCam, len, colliders, WALL_PAD));
      // Never below the ground: when the arm points downward, shorten it so the camera stops at the floor
      // (it slides in toward Kavi, like ZZZ/Genshin) instead of sinking under the world.
      if (toCam.y < -1e-3) {
        const floorAt = groundHeightAt(colliders, smooth.x, smooth.z, smooth.y) + GROUND_CLEARANCE;
        free = Math.max(0.6, Math.min(free, (smooth.y - floorAt) / -toCam.y));
      }
      curDist = first || free < curDist ? free : curDist + (free - curDist) * (1 - Math.exp(-5 * dt));
      first = false;
      pos.copy(smooth).addScaledVector(toCam, Math.min(curDist, len));

      const floor = groundHeightAt(colliders, pos.x, pos.z, pos.y) + GROUND_CLEARANCE;
      if (pos.y < floor) pos.y = floor;
      camera.position.copy(pos);
      aim.copy(pivot).addScaledVector(dir, 8);
      camera.lookAt(aim);
    },
  };
  return rig;
}

/** Input that never moves the camera: snapping, and while a panel or menu has the cursor. */
export const NO_INPUT: Input = {
  down: () => false, consumePress: () => false, takeLook: () => ({ dx: 0, dy: 0 }), takeWheel: () => 0, flush: () => undefined, locked: false,
  ui: false, free: false, setUi: () => undefined, escapeReleasedLock: false,
};
