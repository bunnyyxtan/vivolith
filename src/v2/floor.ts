// Visible walking surface height. The collision ground is flat at the street level, but sidewalks, pavers and
// curbs are modelled ~0.14 m higher, so characters standing on the collision ground looked sunk into them.
// One downward ray per 0.5 m cell onto the walkway meshes, cached: cheap after the first visit to an area.
import * as THREE from "three";

/** Meshes people walk on (by name), and never furniture or awnings. */
const WALKWAY = /(brick|paver|curb|paint|asphalt|promenade|floor|walk|deck|plaza|lawn|grass|step|tile|road|path)/i;
const NOT_WALKWAY = /(bench|fabric|stall|roof|wall|canopy|awning|planter|outline)/i;
/** A visible floor counts only this close above the collision ground (higher means a bench, a stall, a roof). */
const MAX_STEP = 0.35;

export type FloorHeight = (x: number, z: number, ground: number) => number;

export function createFloor(scene: THREE.Object3D): FloorHeight {
  const meshes: THREE.Mesh[] = [];
  scene.traverse((o) => {
    if ((o as THREE.Mesh).isMesh && !(o as THREE.SkinnedMesh).isSkinnedMesh && WALKWAY.test(o.name) && !NOT_WALKWAY.test(o.name)) meshes.push(o as THREE.Mesh);
  });
  scene.updateMatrixWorld(true);
  const ray = new THREE.Raycaster();
  const from = new THREE.Vector3(), down = new THREE.Vector3(0, -1, 0);
  const cache = new Map<string, number>();
  return (x, z, ground) => {
    const cx = Math.round(x * 2) / 2, cz = Math.round(z * 2) / 2;
    const key = `${cx},${cz},${Math.round(ground * 4)}`;
    let top = cache.get(key);
    if (top === undefined) {
      from.set(cx, ground + MAX_STEP + 0.5, cz);
      ray.set(from, down);
      ray.far = MAX_STEP + 0.6;
      const hit = ray.intersectObjects(meshes, false)[0];
      top = hit && hit.point.y <= ground + MAX_STEP ? hit.point.y : -Infinity;
      cache.set(key, top);
    }
    return Math.max(ground, top);
  };
}
