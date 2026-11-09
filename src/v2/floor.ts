// Visible walking surface height. The collision ground is flat at the street level, but sidewalks, pavers and
// curbs are modelled ~0.14 m higher, so characters standing on the collision ground looked sunk into them.
// Exact height under any point from a 2 m grid index of the walkway triangles (built once at load).
import * as THREE from "three";
import type { Footprint } from "../character";

/** Meshes people walk on (by name), and never furniture or awnings. */
/** Soil and stone are the tops of tree pits and low flower beds: people crossing one stand on it, never sunk into it
 *  (MAX_STEP still ignores the raised planters, which have colliders). */
const WALKWAY = /(brick|paver|curb|paint|asphalt|promenade|floor|walk|deck|plaza|lawn|grass|step|tile|road|path|soil|stone)/i;
const NOT_WALKWAY = /(bench|fabric|stall|roof|wall|canopy|awning|planter|outline)/i;
/** A visible floor counts only this close above the collision ground (higher means a bench, a stall, a roof). */
const MAX_STEP = 0.35;

export type FloorHeight = (x: number, z: number, ground: number) => number;

/** Body height that keeps every foot on or above the pavement under it: the swing foot crossing onto a curb lifts
 *  the body only as much as that foot is not already raised, so neither foot cuts into the step. */
export function standHeight(floor: FloorHeight, x: number, z: number, ground: number, feet: readonly Footprint[]): number {
  let y = floor(x, z, ground);
  for (const f of feet) y = Math.max(y, floor(f.x, f.z, ground) - f.lift);
  return y;
}

export function createFloor(scene: THREE.Object3D): FloorHeight {
  const meshes: THREE.Mesh[] = [];
  scene.traverse((o) => {
    if ((o as THREE.Mesh).isMesh && !(o as THREE.SkinnedMesh).isSkinnedMesh && WALKWAY.test(o.name) && !NOT_WALKWAY.test(o.name)) meshes.push(o as THREE.Mesh);
  });
  scene.updateMatrixWorld(true);
  // Walkway triangles in world space, bucketed by their xz bounds on a 2 m grid: a query tests only its bucket.
  // (A raycast tested every triangle of the town-wide walkway meshes: ~0.5 ms each, and townsfolk walking into new
  // ground fired dozens per frame.) Vertical faces (curb sides) are skipped: they have no top to stand on.
  const tri: number[] = []; // x0 y0 z0 x1 y1 z1 x2 y2 z2 per triangle
  const v = new THREE.Vector3();
  for (const m of meshes) {
    const pos = m.geometry.getAttribute("position");
    const index = m.geometry.index;
    const n = index ? index.count : pos.count;
    for (let k = 0; k < n; k += 3) {
      const base = tri.length;
      for (let c = 0; c < 3; c++) {
        v.fromBufferAttribute(pos, index ? index.getX(k + c) : k + c).applyMatrix4(m.matrixWorld);
        tri.push(v.x, v.y, v.z);
      }
      const area = (tri[base + 3] - tri[base]) * (tri[base + 8] - tri[base + 2]) - (tri[base + 6] - tri[base]) * (tri[base + 5] - tri[base + 2]);
      if (Math.abs(area) < 1e-6) tri.length = base;
    }
  }
  const T = new Float32Array(tri);
  const CELL = 2;
  const grid = new Map<number, number[]>();
  const key = (i: number, j: number): number => (i + 4096) * 8192 + (j + 4096);
  for (let t = 0; t < T.length; t += 9) {
    const i0 = Math.floor(Math.min(T[t], T[t + 3], T[t + 6]) / CELL), i1 = Math.floor(Math.max(T[t], T[t + 3], T[t + 6]) / CELL);
    const j0 = Math.floor(Math.min(T[t + 2], T[t + 5], T[t + 8]) / CELL), j1 = Math.floor(Math.max(T[t + 2], T[t + 5], T[t + 8]) / CELL);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const k = key(i, j);
      const list = grid.get(k);
      if (list) list.push(t); else grid.set(k, [t]);
    }
  }
  /** Top of the walkway under (x, z): the highest surface no more than MAX_STEP above the collision ground. */
  return (x, z, ground) => {
    const list = grid.get(key(Math.floor(x / CELL), Math.floor(z / CELL)));
    let top = -Infinity;
    if (list) {
      const hi = ground + MAX_STEP, lo = ground - 0.1;
      for (const t of list) {
        const ax = T[t], az = T[t + 2], bx = T[t + 3], bz = T[t + 5], cx = T[t + 6], cz = T[t + 8];
        const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
        const l1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d;
        const l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d;
        const l3 = 1 - l1 - l2;
        if (l1 < -1e-5 || l2 < -1e-5 || l3 < -1e-5) continue;
        const y = l1 * T[t + 1] + l2 * T[t + 4] + l3 * T[t + 7];
        if (y <= hi && y >= lo && y > top) top = y;
      }
    }
    return Math.max(ground, top);
  };
}
