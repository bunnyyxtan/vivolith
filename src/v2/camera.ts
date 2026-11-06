// Over-the-shoulder follow camera with orbit, zoom and wall/ground collision.
import * as THREE from "three";
import { groundHeightAt, type Box } from "../physics/collision";
import type { Input } from "./input";

const SENS = 0.0022;
const MIN_DIST = 2.2, MAX_DIST = 9;
const SHOULDER = 0.65; // metres to the right of the character
const GROUND_CLEARANCE = 0.35;
const WALL_PAD = 0.3;

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
      rig.yaw += dx * SENS;
      rig.pitch = THREE.MathUtils.clamp(rig.pitch + dy * SENS, -0.12, 1.25);
      rig.dist = THREE.MathUtils.clamp(rig.dist + input.takeWheel() * 0.004, MIN_DIST, MAX_DIST);

      if (first) smooth.copy(focus); else smooth.lerp(focus, 1 - Math.exp(-12 * dt));

      const cp = Math.cos(rig.pitch), sp = Math.sin(rig.pitch);
      dir.set(Math.sin(rig.yaw) * cp, -sp, Math.cos(rig.yaw) * cp); // look direction
      right.set(Math.cos(rig.yaw), 0, -Math.sin(rig.yaw));
      pivot.copy(smooth).addScaledVector(right, SHOULDER);
      toCam.copy(pivot).addScaledVector(dir, -rig.dist).sub(smooth);
      const len = toCam.length();
      toCam.divideScalar(len);

      // cut in instantly when a wall is in the way, ease back out
      const free = Math.max(0.6, clipRay(smooth, toCam, len, colliders, WALL_PAD));
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

const NO_INPUT: Input = {
  down: () => false, consumePress: () => false, takeLook: () => ({ dx: 0, dy: 0 }), takeWheel: () => 0, locked: false,
};
