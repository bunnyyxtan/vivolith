// Tripo-generated props (EVs, fruit stalls, corner shops) placed on PROP_<asset>__<id> empties of town.glb.
// GLBs come from blender/build_tripo_props.py (forward = -Z in three, on the ground, own COL_ box hidden;
// the town already holds the matching colliders).
import * as THREE from "three";
import { loadGLB, prepareModel } from "../assets";
import { applyToon } from "./toon";
import { installLandmarks } from "./landmarks";
import type { Box } from "../physics/collision";
import { loadBrandAssets, makeSignTexture, type SignLine } from "./brand";

const PROP = /^PROP_(.+)__(.+)$/;
const OUTLINE = 0.02; // metres: props sit further from the camera than characters

/** Readable lettering for the blank boards Tripo left on the models (fictional NEAR City businesses). */
const SHOP_NAMES: Record<string, SignLine[]> = {
  av_e0: [{ text: "NEAR Mart", size: 0.5, weight: 700 }, { text: "Groceries · open 24/7", size: 0.24, dim: true }],
  av_e1: [{ text: "Agent Supply", size: 0.5, weight: 700 }, { text: "Bots · parts · repairs", size: 0.24, dim: true }],
};
const STALL_NAMES: Record<string, string> = {
  pema: "Pema's Mangoes", tomas: "Tomas & Sons", v1: "Orchard Row", v2: "Mira's Exchange", v3: "Harbor Dispatch",
};
/** Board placement in each model's local frame (front = +Z), measured by raycasts against the GLBs. */
const BOARDS: Record<string, { w: number; h: number; x: number; y: number; z: number }> = {
  shop_corner: { w: 2.4, h: 0.55, x: -0.5, y: 3.45, z: 3.1 }, // the blank fascia above the awning
  stall_fruit: { w: 2.2, h: 0.42, x: 0, y: 1.95, z: 1.2 },     // hung from the canopy's front edge
};

function decor(asset: string, id: string): THREE.Object3D | null {
  const b = BOARDS[asset];
  let lines: SignLine[] | undefined;
  if (asset === "shop_corner") lines = SHOP_NAMES[id];
  if (asset === "stall_fruit" && STALL_NAMES[id]) {
    lines = [{ text: STALL_NAMES[id], size: 0.5, weight: 700 }, { text: "Mango crates · NEP-245", size: 0.26, dim: true }];
  }
  if (!b || !lines) return null;
  const map = makeSignTexture({ lines, style: "civic", logo: "tile", aspect: b.w / b.h, px: 1024 });
  const face = new THREE.Mesh(new THREE.PlaneGeometry(b.w, b.h), new THREE.MeshBasicMaterial({ map, toneMapped: false }));
  face.position.set(b.x, b.y, b.z);
  face.name = `sign_${asset}_${id}`;
  return face;
}

async function loadTemplate(asset: string): Promise<THREE.Object3D> {
  const gltf = await loadGLB(`/models/v2/props/${asset}.glb`);
  prepareModel(gltf.scene); // hides COL_*; the colliders are already in the town
  applyToon(gltf.scene, OUTLINE, undefined, true);
  gltf.scene.traverse((o) => { o.frustumCulled = true; }); // static: let three cull them (applyToon disables it)
  return gltf.scene;
}

/** Clones each prop under its empty. Missing GLBs leave the slot empty and are reported once. */
export async function installProps(town: THREE.Object3D, colliders?: Box[]): Promise<number> {
  void installLandmarks(town, colliders); // NEAR AI Lab + Intents Exchange on their LANDMARK_ empties
  const slots: { node: THREE.Object3D; asset: string; id: string }[] = [];
  town.traverse((o) => {
    const m = PROP.exec(o.name);
    if (m) slots.push({ node: o, asset: m[1], id: m[2] });
  });
  const brand = loadBrandAssets().catch((e: unknown) => console.warn("brand assets", e));
  const templates = new Map<string, Promise<THREE.Object3D | null>>();
  for (const { asset } of slots) {
    if (!templates.has(asset)) {
      templates.set(asset, loadTemplate(asset).catch((e: unknown) => {
        console.warn(`prop ${asset} missing`, e);
        return null;
      }));
    }
  }
  let placed = 0;
  await brand;
  await Promise.all(slots.map(async ({ node, asset, id }) => {
    const t = await templates.get(asset);
    if (!t) return;
    const inst = t.clone(true);
    const sign = decor(asset, id);
    if (sign) inst.add(sign);
    node.add(inst);
    placed++;
  }));
  return placed;
}
