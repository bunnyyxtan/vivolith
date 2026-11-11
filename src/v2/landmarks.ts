// Hand-built landmarks (blender/build_landmarks.py): NEAR AI Lab and NEAR Intents Exchange.
// Each GLB hangs under its LANDMARK_<id> empty of town.glb (origin = footprint centre, front = +Z).
import * as THREE from "three";
import { loadGLB, prepareModel } from "../assets";
import type { Box } from "../physics/collision";
import { applyToon } from "./toon";

const OUTLINE = 0.02; // metres, same as props
const SLOTS: ReadonlyArray<{ id: string; file: string }> = [
  { id: "intents_exchange", file: "intents_exchange" },
  { id: "ai_lab", file: "ai_lab" },
];

/** Loads both landmarks and pushes their world-space colliders. Missing files or empties are reported once. */
export async function installLandmarks(town: THREE.Object3D, colliders?: Box[]): Promise<number> {
  let placed = 0;
  await Promise.all(SLOTS.map(async ({ id, file }) => {
    const slot = town.getObjectByName(`LANDMARK_${id}`);
    if (!slot) { console.warn(`landmark slot LANDMARK_${id} missing`); return; }
    try {
      const gltf = await loadGLB(`/models/v2/landmarks/${file}.glb`);
      slot.add(gltf.scene);
      town.updateMatrixWorld(true);
      const m = prepareModel(gltf.scene); // colliders in world space (the empties are rotated by 90 degrees)
      colliders?.push(...m.colliders);
      // Leaf-card foliage keeps its alpha-tested look (an ink hull would fill the cards): outline everything else.
      const leaves: Array<{ node: THREE.Object3D; parent: THREE.Object3D }> = [];
      gltf.scene.traverse((o) => { if (/^(FOLIAGE|HT_)/.test(o.name) && o.parent) leaves.push({ node: o, parent: o.parent }); });
      for (const l of leaves) l.parent.remove(l.node);
      applyToon(gltf.scene, OUTLINE, undefined, true, false); // buildings: no ink line (WP3)
      for (const l of leaves) l.parent.add(l.node);
      gltf.scene.traverse((o) => { o.frustumCulled = true; });
      placed++;
    } catch (e: unknown) {
      console.warn(`landmark ${file} failed`, e);
    }
  }));
  return placed;
}
