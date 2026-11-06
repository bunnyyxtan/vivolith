// GLB loading for Blender exports (Draco-compressed geometry).
import * as THREE from "three";
import { GLTFLoader, type GLTF } from "three/addons/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";
import type { Box } from "./physics/collision";

const draco = new DRACOLoader().setDecoderPath("/draco/");
const loader = new GLTFLoader().setDRACOLoader(draco);

export function loadGLB(url: string): Promise<GLTF> {
  return loader.loadAsync(url);
}

/**
 * Window glass: the buildings are hollow shells, so transparent glass shows a black void.
 * Opaque, glossy glass reflects the sky instead; lit panes glow like occupied rooms at dusk.
 */
function dressGlass(m: THREE.MeshStandardMaterial, lit: boolean): void {
  m.transparent = false;
  m.opacity = 1;
  m.depthWrite = true;
  m.alphaMap = null;
  m.roughness = lit ? 0.35 : 0.06;
  m.metalness = lit ? 0 : 0.9;
  m.color.set(lit ? "#6b4a2e" : "#2a3442");
  m.envMapIntensity = lit ? 0.4 : 1.6;
  if (lit) {
    m.emissive.set("#ffb46b");
    m.emissiveIntensity = 1.6;
  }
  m.needsUpdate = true;
}

export interface PreparedModel {
  readonly colliders: Box[];
  readonly blockers: THREE.Mesh[];
}

/**
 * Applies the Blender export conventions (see blender/build_street.py):
 *  - COL_* meshes become collision boxes and are hidden
 *  - materials named "*__tint_rrggbb" get that base-colour multiplier
 *  - every visible mesh casts and receives shadows
 */
export function prepareModel(root: THREE.Object3D): PreparedModel {
  root.updateMatrixWorld(true);
  const colliders: Box[] = [];
  const blockers: THREE.Mesh[] = [];
  const bounds = new THREE.Box3();
  const hidden: THREE.Object3D[] = [];

  root.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    if (obj.name.startsWith("COL_")) {
      bounds.setFromObject(obj);
      colliders.push({
        minX: bounds.min.x, minY: bounds.min.y, minZ: bounds.min.z,
        maxX: bounds.max.x, maxY: bounds.max.y, maxZ: bounds.max.z,
      });
      hidden.push(obj);
      return;
    }
    obj.castShadow = true;
    obj.receiveShadow = true;
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (const m of mats) {
      if (!(m instanceof THREE.MeshStandardMaterial)) continue;
      const tint = /__tint_([0-9a-f]{6})/i.exec(m.name);
      if (tint) m.color.set(`#${tint[1]}`); // hex is sRGB; three converts
      if (m.name.startsWith("modular_urban_apartments_facade_glass")) dressGlass(m, false);
      if (m.name.startsWith("facade_glass_lit")) dressGlass(m, true);
    }
    if (obj.name.startsWith("BLD_")) blockers.push(obj);
  });
  for (const h of hidden) h.removeFromParent();
  return { colliders, blockers };
}
