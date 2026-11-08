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
/** What each stall is known for, in plain words (the second line under the stall name). */
const STALL_TAGS: Record<string, string> = {
  pema: "Fruit at fair prices", tomas: "Mangoes by the crate", v1: "Fruit and greens", v2: "Always a coin cheaper", v3: "Harbor crates",
};
/** Board placement in each model's local frame (front = +Z), measured by raycasts against the GLBs. */
const BOARDS: Record<string, { w: number; h: number; x: number; y: number; z: number }> = {
  shop_corner: { w: 2.4, h: 0.55, x: -0.5, y: 3.45, z: 3.1 }, // the blank fascia above the awning
  stall_fruit: { w: 2.2, h: 0.42, x: 0, y: 1.95, z: 1.2 },     // hung from the canopy's front edge
};

/** Lettered signs on PLACARD_<id> empties of town.glb (blender/build_v2_spire_district.py): name the places and
 *  point the way around the Spire district. Face size in metres; the empty sits at the face centre. */
const PLACARDS: Record<string, { w: number; h: number; style: "civic" | "dark" | "mint"; lines: SignLine[]; logo?: "tile" | "none" }> = {
  depot: { w: 5.6, h: 0.62, style: "civic", lines: [{ text: "Harbor Depot", size: 0.52, weight: 700 }, { text: "Crates for the market stalls", size: 0.26, dim: true }] },
  station: { w: 3.4, h: 0.62, style: "dark", lines: [{ text: "Spire Station", size: 0.5, weight: 700 }, { text: "Trams · taxis · city bikes", size: 0.26, dim: true }] },
  yard: { w: 4.6, h: 0.62, style: "mint", lines: [{ text: "Builders' Yard", size: 0.52, weight: 700 }, { text: "NEAR Labs outdoor desks · food trucks", size: 0.24 }] },
  orchard: { w: 1.9, h: 0.75, style: "civic", lines: [{ text: "Mango Orchard", size: 0.36, weight: 700 }, { text: "Picked every morning", size: 0.22, dim: true }, { text: "for the market", size: 0.22, dim: true }] },
  way_w: { w: 2.2, h: 0.8, style: "civic", logo: "none", lines: [{ text: "← Builders' Yard", size: 0.3, weight: 700 }, { text: "← Mango Orchard", size: 0.3, weight: 700 }] },
  way_e: { w: 2.2, h: 0.8, style: "civic", logo: "none", lines: [{ text: "Spire Station →", size: 0.3, weight: 700 }, { text: "Harbor Depot →", size: 0.3, weight: 700 }] },
  way_gw: { w: 2.2, h: 0.8, style: "civic", logo: "none", lines: [{ text: "↑ Builders' Yard", size: 0.3, weight: 700 }, { text: "↗ Demo Day Lawn", size: 0.3, weight: 700 }] },
  way_ge: { w: 2.2, h: 0.8, style: "civic", logo: "none", lines: [{ text: "↑ Spire Station", size: 0.3, weight: 700 }, { text: "↖ Demo Day Lawn", size: 0.3, weight: 700 }] },
};

function placard(id: string): THREE.Object3D | null {
  const p = PLACARDS[id];
  if (!p) return null;
  const map = makeSignTexture({ lines: p.lines, style: p.style, logo: p.logo ?? "tile", aspect: p.w / p.h, px: 1024 });
  const face = new THREE.Mesh(new THREE.PlaneGeometry(p.w, p.h), new THREE.MeshBasicMaterial({ map, toneMapped: false }));
  const back = new THREE.Mesh(new THREE.BoxGeometry(p.w + 0.08, p.h + 0.08, 0.06), new THREE.MeshToonMaterial({ color: "#1a2238" }));
  back.position.z = -0.035;
  const g = new THREE.Group();
  g.add(back, face);
  g.name = `placard_${id}`;
  return g;
}

function decor(asset: string, id: string): THREE.Object3D | null {
  const b = BOARDS[asset];
  let lines: SignLine[] | undefined;
  if (asset === "shop_corner") lines = SHOP_NAMES[id];
  if (asset === "stall_fruit" && STALL_NAMES[id]) {
    lines = [{ text: STALL_NAMES[id], size: 0.5, weight: 700 }, { text: STALL_TAGS[id] ?? "Fresh fruit daily", size: 0.26, dim: true }];
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
  const boards: THREE.Object3D[] = [];
  town.traverse((o) => { if (o.name.startsWith("PLACARD_")) boards.push(o); });
  for (const o of boards) {
    const sign = placard(o.name.slice("PLACARD_".length));
    if (sign) { o.add(sign); placed++; }
  }
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
