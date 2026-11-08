// Visible walking surface height. The collision ground is flat at the street level, but sidewalks, pavers and
// curbs are modelled ~0.14 m higher, so characters standing on the collision ground looked sunk into them.
// One downward ray per 0.5 m cell onto the walkway meshes, cached: cheap after the first visit to an area.
import * as THREE from "three";
import type { Footprint } from "../character";

/** Meshes people walk on (by name), and never furniture or awnings. */
const WALKWAY = /(brick|paver|curb|paint|asphalt|promenade|floor|walk|deck|plaza|lawn|grass|step|tile|road|path)/i;
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
  const ray = new THREE.Raycaster();
  const from = new THREE.Vector3(), down = new THREE.Vector3(0, -1, 0);
  const sample = (x: number, z: number, ground: number): number => {
    from.set(x, ground + MAX_STEP + 0.5, z);
    ray.set(from, down);
    ray.far = MAX_STEP + 0.6;
    const hit = ray.intersectObjects(meshes, false)[0];
    return hit && hit.point.y <= ground + MAX_STEP ? hit.point.y : -Infinity;
  };
  // A 0.5 m cell is one height unless a curb or step crosses it; then it holds 5 x 5 sub-cells of 0.1 m, so a foot
  // near an edge stands on the side it is really on (a whole-cell value put it 14 cm up or down at every curb).
  const SUB = 5;
  const cache = new Map<string, number | Float32Array>();
  return (x, z, ground) => {
    const cx = Math.round(x * 2) / 2, cz = Math.round(z * 2) / 2;
    const key = `${cx},${cz},${Math.round(ground * 4)}`;
    let cell = cache.get(key);
    if (cell === undefined) {
      const h = 0.24;
      const probes = [sample(cx, cz, ground), sample(cx - h, cz - h, ground), sample(cx + h, cz - h, ground), sample(cx - h, cz + h, ground), sample(cx + h, cz + h, ground)];
      if (probes.every((p) => p === probes[0] || Math.abs(p - probes[0]) < 0.01)) cell = probes[0];
      else {
        const sub = new Float32Array(SUB * SUB);
        for (let i = 0; i < SUB; i++) for (let j = 0; j < SUB; j++) sub[i * SUB + j] = sample(cx - 0.2 + i * 0.1, cz - 0.2 + j * 0.1, ground);
        cell = sub;
      }
      cache.set(key, cell);
    }
    if (typeof cell === "number") return Math.max(ground, cell);
    const i = Math.min(SUB - 1, Math.max(0, Math.round((x - cx + 0.2) * 10))), j = Math.min(SUB - 1, Math.max(0, Math.round((z - cz + 0.2) * 10)));
    return Math.max(ground, cell[i * SUB + j]);
  };
}
