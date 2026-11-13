// Market Lane in v2: stall posts, merchant characters (toon + outline), and diegetic chalkboard price boards.
// Posts come from /models/v2/town.glb empties (NPC_<id> = merchant post, STALL_<id> = customer standing point).
// Until town.glb exists, FALLBACK_POSTS place the market on the plaza promenade (x -7..7, z -7..-41,
// benches along x = +-7.2) with Ines behind the Spire lobby desk (desk top at x -28.7..-23.7, z ~-60).
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { loadGLB, prepareModel } from "../assets";
import { loadCharacter, type AnimatedCharacter } from "../character";
import { groundHeightAt, type Box } from "../physics/collision";
import { applyToon, setGlowBase, smoothHull, trackGlow } from "./toon";
import { installProps } from "./props";
import { createLife, type FolkChar, type Life } from "./npc";
import { audio } from "./audio";
import type { Mood } from "./audio-manifest";
import { createFloor, type FloorHeight } from "./floor";
import type { Body } from "../physics/collision";

export type NpcId = "pema" | "tomas" | "mira" | "arin" | "harbor" | "engineer";
export const NPC_IDS: readonly NpcId[] = ["pema", "tomas", "mira", "arin", "harbor", "engineer"];

interface Post { npc: THREE.Vector3; stall: THREE.Vector3 }
const v = (x: number, z: number): THREE.Vector3 => new THREE.Vector3(x, 0, z);
/** Temporary plaza layout (documented above). Merchants alternate sides of the promenade. */
const FALLBACK_POSTS: Record<NpcId, Post> = {
  pema: { npc: v(-5.4, -14), stall: v(-3.4, -14) },
  tomas: { npc: v(5.4, -19), stall: v(3.4, -19) },
  mira: { npc: v(5.4, -24), stall: v(3.4, -24) },
  arin: { npc: v(-5.4, -27), stall: v(-3.4, -27) },
  harbor: { npc: v(5.4, -33), stall: v(3.4, -33) },
  engineer: { npc: v(-26.2, -61.3), stall: v(-26.2, -58.2) },
};
/** Anime cast file per role (public/models/v2/cast/<name>.glb). */
const CAST: Record<NpcId, string> = { pema: "merchant_fruit", tomas: "tomas", mira: "mira", arin: "arin", harbor: "bram", engineer: "ines" }; // all Tripo models
/** Town posts by role; Harbor Dispatch takes the v3 stall at the gate end of the square. */
const TOWN_POST: Record<NpcId, string> = { pema: "pema", tomas: "tomas", mira: "v2", arin: "teahouse", harbor: "v3", engineer: "engineer" };
const CAST_HEIGHT = 1.7;
const HEIGHT: Record<NpcId, number> = { pema: CAST_HEIGHT, tomas: CAST_HEIGHT * 1.06, mira: CAST_HEIGHT * 0.98, arin: CAST_HEIGHT, harbor: CAST_HEIGHT, engineer: CAST_HEIGHT };
const FOLK = 24;
const INTERACT_RADIUS = 2.4;
const NOTICE_RADIUS = 7;
const MERCHANT_TURN_RATE = 3.2; // rad/s
const WAVE_GAP_SEC = 90; // a merchant waves hello at most this often (reopening the panel is not a new hello)
const NOD_EVERY_SEC = 6; // a listening merchant nods (Agree) about this often while the player reads or types

export interface Board {
  readonly mesh: THREE.Mesh;
  draw(lines: { title: string; price: string; sub: string; closed: boolean; rent?: { text: string; ok: boolean } }): void;
}

export interface Npc {
  readonly id: NpcId;
  readonly root: THREE.Group;
  readonly character: AnimatedCharacter;
  readonly post: Post;
  readonly board: Board | null;
  readonly head: THREE.Vector3;
  talking: boolean;
  /** Set by the townsfolk brain: customer being served, merchant turns to face them. */
  serving: boolean;
  /** While serving: the merchant's turn to speak (customer and merchant alternate). */
  serveTalk: boolean;
  attend: THREE.Vector3 | null;
  /** Set by play.ts while the player is in conversation (talk or trade) with this merchant: they face the player,
   *  stop serving and listen; their mouth still moves only while their voice plays (talking). */
  listening: boolean;
  /** Seconds left on a one-shot gesture (Wave, Agree). */
  gest: number;
}

export interface Market {
  readonly npcs: readonly Npc[];
  /** SPAWN_TOWN from town.glb (south gate, facing the Spire), or null without the town. */
  readonly townSpawn: THREE.Vector3 | null;
  readonly boards: readonly THREE.Mesh[];
  /** Closest NPC whose stall point the player stands at, or null. */
  nearest(p: THREE.Vector3): Npc | null;
  update(dt: number, player: THREE.Vector3): void;
  /** Wire Kavi's body (contact pushes) and the camera (speech bubbles). */
  bind(body: Body, camera: THREE.Camera): void;
  /** Visible walkway height at a point (used to stand Kavi on the pavement). */
  readonly floor: FloorHeight;
  /** Every merchant and townsfolk character (for the one-time sole calibration). */
  readonly cast: readonly AnimatedCharacter[];
  /** Shows a stall's economic state in the world: crate pile = stock, closed shutter, upgrade, shopper pull. */
  setStall(id: string, s: StallState): void;
  /** A bubble over a character's head, spoken in their voice (mood: delivery chosen from real events). */
  say(id: string, text: string, sec?: number, mood?: Mood): void;
  /** Townsfolk rhythm, gossip and harbor deliveries (see npc.ts Life). */
  readonly life: Pick<Life, "setHour" | "setGossip" | "deliver" | "errand">;
}

export interface StallState {
  readonly stock: number;
  readonly open: boolean;
  readonly upgraded: boolean;
  /** 0..2 from pricing.ts stallPull. */
  readonly pull: number;
  /** struggling: open but the till is short of rent; recovering: reopened within the last day. */
  readonly mood?: "struggling" | "recovering" | null;
}

const CRATE_UNITS = 4; // one crate on the pile per 4 units of stock
const LANTERN_GLOW = 2.6; // full-night strength: above the bloom threshold, so open stalls glow after dark
const MAX_CRATES = 9;

const SHUTTER_TOP = 1.6, SHUTTER_BOTTOM = 0.55, SLAT_M = 0.1;
const SHUTTER_EASE = 6; // 1/s: how quickly a shutter rolls to its new height
/** Counter width each stall's shutter spans (the tea house counter is wider than the fruit stalls'). */
const SHUTTER_W: Record<string, number> = { arin: 4.2 };
const SHUTTER_W_DEFAULT = 3.0;
const NAVY = 0x2c3446;

/** A stylised roller shutter in the stall's local frame (x along the counter, +z toward customers). set(level): 0 rolled
 *  up into the housing, 1 down to the counter base with the "Closed" card. */
function makeShutter(width: number, glow: THREE.Material, withCard = true): { group: THREE.Group; set(level: number): void } {
  const group = new THREE.Group();
  const navy = new THREE.MeshToonMaterial({ color: NAVY });
  const housing = new THREE.Mesh(new THREE.BoxGeometry(width + 0.14, 0.2, 0.22), navy);
  housing.position.y = SHUTTER_TOP + 0.1;
  const trim = new THREE.Mesh(new THREE.BoxGeometry(width + 0.14, 0.035, 0.012), new THREE.MeshBasicMaterial({ color: 0x00c98a }));
  trim.position.set(0, SHUTTER_TOP + 0.04, 0.116);
  // the stall's light: a warm strip under the housing, over the counter (lit at dusk while trading, dark when shut)
  const strip = new THREE.Mesh(new THREE.BoxGeometry(width - 0.1, 0.03, 0.06), glow);
  strip.position.set(0, SHUTTER_TOP - 0.01, 0.06);
  group.add(housing, trim, strip);
  for (const x of [-1, 1]) {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(0.06, SHUTTER_TOP - SHUTTER_BOTTOM + 0.04, 0.08), navy);
    rail.position.set(x * (width / 2 + 0.03), (SHUTTER_TOP + SHUTTER_BOTTOM) / 2, 0);
    group.add(rail);
  }
  // slats: a lit top edge, the face, a dark groove: one canvas, repeated so each slat stays SLAT_M tall at any height
  const c = document.createElement("canvas");
  c.width = 4; c.height = 64;
  const x = c.getContext("2d")!;
  const grad = x.createLinearGradient(0, 0, 0, 64);
  grad.addColorStop(0, "#b9c2cc"); grad.addColorStop(0.2, "#98a2ae"); grad.addColorStop(0.85, "#7b8593"); grad.addColorStop(1, "#56606e");
  x.fillStyle = grad; x.fillRect(0, 0, 4, 64);
  x.fillStyle = "#3f4855"; x.fillRect(0, 58, 4, 6);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  const curtainGeo = new THREE.BoxGeometry(width, 1, 0.025);
  curtainGeo.translate(0, -0.5, 0); // hangs from its top edge
  const curtain = new THREE.Mesh(curtainGeo, new THREE.MeshToonMaterial({ color: 0xffffff, map: tex }));
  curtain.position.y = SHUTTER_TOP;
  const bar = new THREE.Mesh(new THREE.BoxGeometry(width + 0.02, 0.06, 0.05), navy);
  const handle = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.035, 0.04), new THREE.MeshToonMaterial({ color: 0xc9a227 }));
  // "Closed" card fixed to the curtain, painted once
  const cc = document.createElement("canvas");
  cc.width = 320; cc.height = 140;
  const cx = cc.getContext("2d")!;
  cx.fillStyle = "#1d2433"; cx.fillRect(0, 0, 320, 140);
  cx.fillStyle = "#fffaf1"; cx.fillRect(8, 8, 304, 124);
  cx.fillStyle = "#e2604a"; cx.fillRect(8, 8, 304, 14);
  cx.fillStyle = "#1d2433"; cx.font = "700 62px Inter Tight, Inter, system-ui, sans-serif"; cx.textAlign = "center"; cx.textBaseline = "middle";
  cx.fillText("Closed", 160, 80);
  const ctex = new THREE.CanvasTexture(cc);
  ctex.colorSpace = THREE.SRGBColorSpace;
  const card = new THREE.Mesh(new THREE.PlaneGeometry(0.64, 0.28), new THREE.MeshBasicMaterial({ map: ctex, toneMapped: false }));
  card.position.set(0, 1.12, 0.03);
  group.add(curtain, bar, handle, card);
  const set = (level: number): void => {
    const h = Math.max(0.001, (SHUTTER_TOP - SHUTTER_BOTTOM) * level);
    curtain.visible = bar.visible = handle.visible = level > 0;
    curtain.scale.y = h;
    tex.repeat.set(1, Math.max(1, Math.round(h / SLAT_M)));
    bar.position.y = SHUTTER_TOP - h;
    handle.position.set(0, SHUTTER_TOP - h, 0.045);
    card.visible = withCard && level >= 1;
  };
  // rolled up from the start: the dressing only calls set() when the level changes, so an open stall that never changes
  // kept the default full curtain and its "Closed" card (Tomas looked shut while he traded)
  set(0);
  return { group, set };
}

/** The counter display (crates and fruit on the counter's customer half, 0.84-1.4 m) is baked into the stall model.
 *  It is cut out into its own mesh (same material) so it can follow the stall's real stock; the rest of the stall keeps
 *  its shelves and posts. The triangles are moved, not duplicated: the stall mesh draws everything else as before. */
function splitDisplayGoods(stall: THREE.Mesh, customer: THREE.Vector3): THREE.Mesh {
  const src = stall.geometry.index ? stall.geometry.toNonIndexed() : stall.geometry.clone();
  const p = src.attributes.position, attrs = Object.keys(src.attributes);
  const front = Math.sign(stall.worldToLocal(customer.clone()).x) || 1;
  const keep: number[] = [], take: number[] = [];
  for (let t = 0; t < p.count / 3; t++) {
    let lo = Infinity, hi = -Infinity, cx = 0;
    for (let k = 0; k < 3; k++) { const yv = p.getY(t * 3 + k); lo = Math.min(lo, yv); hi = Math.max(hi, yv); cx += p.getX(t * 3 + k) / 3; }
    (lo > 0.84 && hi < 1.4 && cx * front > -0.35 ? take : keep).push(t);
  }
  const build = (tris: number[]): THREE.BufferGeometry => {
    const g = new THREE.BufferGeometry();
    for (const a of attrs) {
      const at = src.attributes[a] as THREE.BufferAttribute, n = at.itemSize, out = new Float32Array(tris.length * 3 * n);
      tris.forEach((t, i) => { for (let k = 0; k < 3 * n; k++) out[i * 3 * n + k] = at.array[t * 3 * n + k] as number; });
      g.setAttribute(a, new THREE.BufferAttribute(out, n));
    }
    g.computeBoundingSphere();
    return g;
  };
  const before = stall.geometry, kept = build(keep), cut = build(take);
  stall.geometry = kept;
  const goods = new THREE.Mesh(cut, stall.material);
  // the ink outline is a child hull built from the stall geometry: split it the same way (else the cut-out crates
  // would leave their dark outlines behind)
  const hull = stall.children.find((c) => c.name === `${stall.name}_outline`) as THREE.Mesh | undefined;
  if (hull) {
    const hard = hull.geometry !== before;
    hull.geometry = hard ? smoothHull(kept) : kept;
    const gh = new THREE.Mesh(hard ? smoothHull(cut) : cut, hull.material);
    gh.name = "goods_outline"; gh.castShadow = false; gh.receiveShadow = false;
    goods.add(gh);
  }
  goods.castShadow = stall.castShadow; goods.receiveShadow = stall.receiveShadow;
  stall.add(goods);
  return goods;
}

let CRATE_GEO: THREE.BufferGeometry | null = null;
function makeCrateGeometry(): THREE.BufferGeometry {
  const part = (geo: THREE.BufferGeometry, color: number, m: THREE.Matrix4): THREE.BufferGeometry => {
    const g = geo.index ? geo.toNonIndexed() : geo;
    g.applyMatrix4(m);
    const c = new THREE.Color(color), n = g.attributes.position.count, col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    return g;
  };
  const at = (x: number, y: number, z: number, sx = 1, sy = 1, sz = 1): THREE.Matrix4 => new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion(), new THREE.Vector3(sx, sy, sz));
  const parts = [part(new THREE.BoxGeometry(0.5, 0.26, 0.38), 0x9c6a3c, at(0, 0, 0))];
  for (const sy of [-0.06, 0.06]) parts.push(part(new THREE.BoxGeometry(0.51, 0.03, 0.39), 0x6e4524, at(0, sy, 0))); // dark slat lines
  for (let k = 0; k < 6; k++) parts.push(part(new THREE.IcosahedronGeometry(0.075, 1), 0xffa21a, // mangoes heaped in the crate
    at(-0.15 + (k % 3) * 0.15, 0.15 + (k > 2 ? 0.03 : 0), k > 2 ? 0.07 : -0.07, 1, 0.85, 1.25)));
  const merged = mergeGeometries(parts.map((g) => { for (const k of Object.keys(g.attributes)) if (!["position", "normal", "color"].includes(k)) g.deleteAttribute(k); return g; }));
  if (!merged) throw new Error("crate geometry could not be merged");
  merged.computeBoundingSphere();
  return merged;
}

/** Crate pile, closed shutter and upgrade dressing beside a stall; meshes are created once and toggled. */
interface Dressing { set(s: StallState): void; tick(dt: number): void }
function makeStallDressing(scene: THREE.Scene, post: Post, y: number, id: string, goods: THREE.Mesh | null): Dressing {
  const side = Math.sign(post.stall.x - post.npc.x) || 1; // +1: customers stand on +X of the counter
  const front = (post.npc.x + post.stall.x) / 2; // the canopy's customer-facing edge
  const face = side > 0 ? Math.PI / 2 : -Math.PI / 2;
  const g = new THREE.Group(); // crate pile beside the stall, on the customer side
  g.position.set(front + side * 0.3, y, post.npc.z - 2.3);
  g.rotation.y = face;
  scene.add(g);
  // One crate is one mesh: box, two slat bands and six mangoes merged with vertex colours (was 9 meshes, each with
  // its own ink hull: 648 draw calls across the four stalls, 45% of the frame). Geometry and material are shared.
  const crateGeo = CRATE_GEO ??= makeCrateGeometry();
  const crateMat = new THREE.MeshToonMaterial({ color: 0xffffff, vertexColors: true });
  const crates = Array.from({ length: MAX_CRATES }, (_, i) => {
    const c = new THREE.Mesh(crateGeo, crateMat);
    const row = Math.floor(i / 3);
    c.position.set((i % 3) * 0.52 - 0.52 + row * 0.26, 0.13 + row * 0.3, 0);
    g.add(c);
    return c;
  });
  // Roller shutter, built like a real one: a housing box under the canopy edge, two guide rails, a slatted curtain that
  // rolls down from the housing to the counter base, a bottom bar with a pull handle, and a hanging card once it is shut.
  // Upgrade: a NEAR-green valance along the canopy front and a string of warm bulbs under it.
  const up = new THREE.Group();
  up.position.set(front + side * 0.45, y, post.npc.z);
  up.rotation.y = face;
  const valance = new THREE.Mesh(new THREE.BoxGeometry(3.4, 0.22, 0.05), new THREE.MeshToonMaterial({ color: 0x00ec97 }));
  valance.position.y = 2.42;
  up.add(valance);
  const bulb = new THREE.MeshBasicMaterial({ color: 0xffe08a });
  for (let i = 0; i < 9; i++) {
    const b = new THREE.Mesh(new THREE.SphereGeometry(0.06, 8, 6), bulb);
    b.position.set(-1.6 + i * 0.4, 2.22 - Math.sin((i / 8) * Math.PI) * 0.16, 0.06);
    up.add(b);
  }
  scene.add(up);
  // Light under the shutter housing: lit at dusk while the stall trades, dark once the shutters come down.
  const lampMat = new THREE.MeshStandardMaterial({ color: "#3a2a18", emissive: "#ffc46b", emissiveIntensity: LANTERN_GLOW, roughness: 0.6 });
  trackGlow(lampMat);
  const shutter = makeShutter(SHUTTER_W[id] ?? SHUTTER_W_DEFAULT, lampMat);
  shutter.group.position.set(front + side * 0.15, y, post.npc.z);
  shutter.group.rotation.y = face;
  scene.add(shutter.group);
  // Reopening shows itself in the world: the shutter rolls up and the merchant is back at the counter (no extra board:
  // the old "Open again" banner hung over the stall's own sign)
  applyToon(g, 0.008, undefined, true);
  let mood: StallState["mood"] = null, open = true, t = 0;
  window.setInterval(() => { // a struggling stall's light gutters: cheap, and only this one material
    if (!open || mood !== "struggling") return;
    t += 1;
    setGlowBase(lampMat, LANTERN_GLOW * (t % 7 === 0 || t % 11 === 0 ? 0.25 : 0.7));
  }, 140);
  let level = 0, base = 0;
  const set = (s: StallState): void => {
    // goods follow the real stock: the pile beside the stall and the counter display; a shut stall has them inside
    const n = s.open ? Math.min(MAX_CRATES, Math.ceil(s.stock / CRATE_UNITS)) : 0;
    crates.forEach((c, i) => { c.visible = i < n; });
    if (goods) goods.visible = s.open && s.stock > 0;
    mood = s.open ? s.mood ?? null : null; open = s.open;
    // closed: rolled all the way down; open (struggling or not): rolled up. A half shutter on a stall that trades read
    // as closed (residents seemed to hand goods through it); a struggling till shows in its guttering lantern instead
    base = !s.open ? 1 : 0;
    up.visible = s.upgraded;
    setGlowBase(lampMat, s.open ? LANTERN_GLOW : 0);
  };
  return {
    set,
    // eased, about half a second: the shutter rolls down when the stall closes and up when it reopens
    tick(dt) {
      const want = base;
      if (Math.abs(want - level) < 1e-3) { if (level !== want) { level = want; shutter.set(level); } return; }
      level += (want - level) * (1 - Math.exp(-SHUTTER_EASE * dt));
      shutter.set(level);
    },
  };
}

/** Chalkboard on an easel: canvas texture, redrawn when prices change. */
function makeBoard(): Board {
  const canvas = document.createElement("canvas");
  canvas.width = 512; canvas.height = 384;
  const ctx = canvas.getContext("2d")!;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const face = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.675), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }));
  const frame = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.77, 0.05), new THREE.MeshStandardMaterial({ color: "#6b4a2e", roughness: 0.8 }));
  const leg = new THREE.Mesh(new THREE.BoxGeometry(0.06, 1.2, 0.06), frame.material);
  leg.position.set(0, -0.6, -0.05);
  face.position.z = 0.028;
  frame.add(face, leg);
  frame.castShadow = true;
  const draw: Board["draw"] = ({ title, price, sub, closed, rent }) => {
    ctx.fillStyle = "#1f2a26";
    ctx.fillRect(0, 0, 512, 384);
    ctx.fillStyle = "#e9efe6";
    ctx.textAlign = "center";
    ctx.font = "600 38px 'Inter Tight', system-ui, sans-serif";
    ctx.fillText(title.toUpperCase(), 256, 70);
    ctx.fillRect(96, 92, 320, 3);
    if (closed) {
      ctx.fillStyle = "#ff7a6b";
      ctx.font = "700 92px 'Inter Tight', system-ui, sans-serif";
      ctx.fillText("CLOSED", 256, 230);
    } else {
      ctx.font = "700 120px 'Inter Tight', system-ui, sans-serif";
      ctx.fillText(price, 256, 238);
    }
    ctx.fillStyle = "#b8c7bd";
    ctx.font = "400 30px 'Inter Tight', system-ui, sans-serif";
    ctx.fillText(sub, 256, rent ? 300 : 320);
    if (rent) { // rent strip: can this stall pay what it owes? (its real till against its real rent)
      ctx.fillStyle = rent.ok ? "#2f6b4c" : "#8a2f2a";
      ctx.fillRect(0, 326, 512, 58);
      ctx.fillStyle = "#ffffff";
      ctx.font = "600 28px 'Inter Tight', system-ui, sans-serif";
      ctx.fillText(rent.text, 256, 365);
    }
    tex.needsUpdate = true;
  };
  return { mesh: frame as THREE.Mesh, draw };
}

async function loadTown(colliders: Box[], scene: THREE.Scene): Promise<THREE.Object3D | null> {
  try {
    const gltf = await loadGLB("/models/v2/town.glb");
    const m = prepareModel(gltf.scene);
    colliders.push(...m.colliders);
    // Look fixes on the baked town (not rebuilt for them): the 26k-triangle grass tufts read as flat green blobs on
    // every lawn and tree pit; the cool asphalt went navy under the blue fill, a warm grey reads as slate in shade.
    gltf.scene.getObjectByName("TOWN_town_tuft")?.removeFromParent();
    const asphalt = gltf.scene.getObjectByName("TOWN_town_asphalt");
    if (asphalt instanceof THREE.Mesh && asphalt.material instanceof THREE.MeshStandardMaterial) asphalt.material.color.set("#625c58");
    // Some paver tops (the Harbor Depot yard, the south strips) were exported with v fixed near 0.9, smearing one texel
    // row into dark streaks; every top face now uses the market's mapping (one tile per metre: u = x, v = z + 1).
    const pavers = gltf.scene.getObjectByName("TOWN_v2_pavers__tint_f6eee6");
    if (pavers instanceof THREE.Mesh) {
      pavers.updateWorldMatrix(true, false);
      const g = pavers.geometry as THREE.BufferGeometry, pos = g.attributes.position, nor = g.attributes.normal, uv = g.attributes.uv;
      const w = new THREE.Vector3();
      for (let i = 0; i < pos.count; i++) {
        if (nor.getY(i) < 0.9) continue;
        w.fromBufferAttribute(pos, i).applyMatrix4(pavers.matrixWorld);
        uv.setXY(i, w.x, w.z + 1);
      }
      uv.needsUpdate = true;
    }
    // The roundabout island tree in front of the NEAR AI Lab stands on the lab's entrance axis and hid its wordmark from
    // the street; the island keeps its shrubs. All town trees are one merged mesh, so the cut is by triangle centroid
    // (360 bark + 252 leaf triangles; no other trunk within 16 m).
    const drop = { x: 58.13, z: 70.06, r: 4.5 };
    gltf.scene.getObjectByName("TOWN_trees")?.children.forEach((t) => {
      if (!(t instanceof THREE.Mesh) || !t.geometry.index) return;
      t.updateWorldMatrix(true, false);
      const g = t.geometry as THREE.BufferGeometry, ix = g.index!, pos = g.attributes.position, a = new THREE.Vector3(), keep: number[] = [];
      for (let i = 0; i < ix.count; i += 3) {
        let cx = 0, cz = 0;
        for (let k = 0; k < 3; k++) { a.fromBufferAttribute(pos, ix.getX(i + k)).applyMatrix4(t.matrixWorld); cx += a.x / 3; cz += a.z / 3; }
        if (Math.hypot(cx - drop.x, cz - drop.z) >= drop.r) keep.push(ix.getX(i), ix.getX(i + 1), ix.getX(i + 2));
      }
      g.setIndex(keep);
    });
    gltf.scene.traverse((o) => { // street lamps and lit windows follow the time of day (dim at noon)
      if (o instanceof THREE.Mesh) for (const mat of Array.isArray(o.material) ? o.material : [o.material]) trackGlow(mat);
    });
    scene.add(gltf.scene);
    void installProps(gltf.scene, colliders); // Tripo EVs, stalls and shops stream in on their PROP_ empties
    return gltf.scene;
  } catch {
    return null; // town.glb not built yet: plaza fallback posts
  }
}

function postsFrom(town: THREE.Object3D | null): Record<NpcId, Post> {
  const out = { ...FALLBACK_POSTS };
  if (!town) return out;
  town.updateMatrixWorld(true);
  for (const id of NPC_IDS) {
    const n = town.getObjectByName(`NPC_${TOWN_POST[id]}`), s = town.getObjectByName(`STALL_${TOWN_POST[id]}`);
    if (n && s) out[id] = { npc: n.getWorldPosition(new THREE.Vector3()), stall: s.getWorldPosition(new THREE.Vector3()) };
  }
  return out;
}

/** Every cast GLB is a Tripo Studio character with its own clips (blender/build_studio_character.py). */
function loadNpcModel(id: NpcId): Promise<AnimatedCharacter> {
  return loadCharacter(`/models/v2/cast/${CAST[id]}.glb`, HEIGHT[id]);
}

async function loadFolk(scene: THREE.Scene): Promise<FolkChar[]> {
  const out = await Promise.all(Array.from({ length: FOLK }, async (_, i): Promise<FolkChar | null> => {
    try {
      const n = (i % 6) + 1;
      const c = await loadCharacter(`/models/v2/cast/folk${n}.glb`, CAST_HEIGHT * (0.94 + 0.06 * (i % 3)));
      applyToon(c.root, 0.011);
      c.autoGround = true;
      const root = new THREE.Group();
      root.add(c.root);
      scene.add(root);
      return { c, root };
    } catch {
      return null;
    }
  }));
  return out.filter((w): w is FolkChar => w !== null);
}

export async function createMarket(scene: THREE.Scene, colliders: Box[]): Promise<Market> {
  const town = await loadTown(colliders, scene);
  const posts = postsFrom(town);
  const spawnObj = town?.getObjectByName("SPAWN_TOWN");
  const townSpawn = spawnObj ? spawnObj.getWorldPosition(new THREE.Vector3()) : null;
  const folk = town ? await loadFolk(scene) : [];
  const floor: FloorHeight = createFloor(scene);
  const dressing = new Map<string, Dressing>();
  const stallMeshes: THREE.Mesh[] = [];
  town?.traverse((o) => { if ((o as THREE.Mesh).isMesh && o.name === "stall_fruit") stallMeshes.push(o as THREE.Mesh); });
  const stallAt = (x: number, z: number): THREE.Mesh | null => stallMeshes.find((m) => { const w = m.getWorldPosition(new THREE.Vector3()); return Math.hypot(w.x - x, w.z - z) < 1.2; }) ?? null;
  const npcs = await Promise.all(NPC_IDS.map(async (id): Promise<Npc> => {
    const post = posts[id];
    const character = await loadNpcModel(id);
    character.autoGround = true;
    applyToon(character.root, 0.011);
    const root = new THREE.Group();
    root.add(character.root);
    const y = floor(post.npc.x, post.npc.z, groundHeightAt(colliders, post.npc.x, post.npc.z, post.npc.y + 0.3));
    root.position.set(post.npc.x, y, post.npc.z);
    root.rotation.y = Math.atan2(post.stall.x - post.npc.x, post.stall.z - post.npc.z);
    scene.add(root);
    let board: Board | null = null;
    if (id !== "engineer") {
      board = makeBoard();
      // beside the merchant, angled toward the approaching customer (who walks in from +Z)
      const side = Math.sign(post.stall.x - post.npc.x) || 1;
      board.mesh.position.set((post.npc.x + post.stall.x) / 2, y + 1.25, post.npc.z + 2.1); // clear of the 3.4 m Tripo stall
      board.mesh.rotation.y = side > 0 ? 0.5 : -0.5;
      board.mesh.userData.npc = id;
      scene.add(board.mesh);
    }
    if (id !== "engineer" && id !== "harbor") {
      const stall = stallAt(post.npc.x, post.npc.z);
      dressing.set(id, makeStallDressing(scene, post, y, id, stall ? splitDisplayGoods(stall, post.stall) : null));
    }
    return { id, root, character, post, board, head: new THREE.Vector3(), talking: false, serving: false, serveTalk: false, attend: null, listening: false, gest: 0 };
  }));

  // A stall model with no merchant behind it (Orchard Row) is not a business: no goods, its shutter down without a
  // "Closed" card, and no shop sign advertising fruit nobody sells
  for (const m of stallMeshes) {
    const w = m.getWorldPosition(new THREE.Vector3());
    if (npcs.some((n) => Math.hypot(n.post.npc.x - w.x, n.post.npc.z - w.z) < 1.2)) continue;
    const toAisle = new THREE.Vector3(w.x > 0 ? w.x - 3 : w.x + 3, w.y, w.z);
    splitDisplayGoods(m, toAisle).visible = false;
    const side = Math.sign(toAisle.x - w.x) || 1;
    const sh = makeShutter(SHUTTER_W_DEFAULT, new THREE.MeshStandardMaterial({ color: "#3a2a18" }), false);
    sh.group.position.set(w.x + side * 1.15, w.y, w.z);
    sh.group.rotation.y = side > 0 ? Math.PI / 2 : -Math.PI / 2;
    sh.set(1);
    scene.add(sh.group);
    town?.traverse((o) => { if (/^sign_stall_fruit/.test(o.name)) { const p = o.getWorldPosition(new THREE.Vector3()); if (Math.hypot(p.x - w.x, p.z - w.z) < 2) o.visible = false; } });
  }
  const life: Life = createLife(scene, colliders, town, npcs, folk, floor);
  const toP = new THREE.Vector3();
  return {
    npcs, townSpawn, floor,
    cast: [...npcs.map((n) => n.character), ...folk.map((f) => f.c)],
    boards: npcs.flatMap((n) => (n.board ? [n.board.mesh] : [])),
    bind: (body, camera) => life.bind(body, camera),
    setStall(id, st) { dressing.get(id)?.set(st); life.setPull(id, st.pull); },
    say(id, text, sec, mood) {
      const n = npcs.find((x) => x.id === id);
      if (!n) return;
      life.say(n.head, text, sec);
      // the bubble is spoken too, in turn (several merchants at Rent Night queue up); the mouth moves while the voice
      // actually plays (play.ts listens to audio.onVoice)
      void audio.line(id, text, { at: n.head, queue: true, mood });
    },
    life,
    nearest(p) {
      let best: Npc | null = null, bd = INTERACT_RADIUS;
      for (const n of npcs) {
        const d = Math.hypot(p.x - n.post.stall.x, p.z - n.post.stall.z);
        if (d < bd) { bd = d; best = n; }
      }
      return best;
    },
    update(dt, player) {
      for (const n of npcs) {
        toP.subVectors(player, n.root.position);
        const near = toP.x * toP.x + toP.z * toP.z < NOTICE_RADIUS * NOTICE_RADIUS;
        const at = n.attend;
        // who they face: the player in conversation, else the customer being served, else a passer-by close to the
        // stall, else their counter
        const serving = n.serving && !n.listening;
        const want = n.listening || (near && !serving) ? Math.atan2(toP.x, toP.z) : at && serving ? Math.atan2(at.x - n.root.position.x, at.z - n.root.position.z) : Math.atan2(n.post.stall.x - n.post.npc.x, n.post.stall.z - n.post.npc.z);
        let d = want - n.root.rotation.y;
        d = Math.atan2(Math.sin(d), Math.cos(d)) * (1 - Math.exp(-5 * dt));
        const m = MERCHANT_TURN_RATE * dt;
        n.root.rotation.y += d > m ? m : d < -m ? -m : d;
        // gestures: a wave when a conversation opens, a nod now and then while listening; speech always wins
        if (n.gest > 0) n.gest -= dt;
        const wasListening = n.root.userData.listening === true;
        n.root.userData.listening = n.listening;
        const ud = n.root.userData as { sinceWave?: number };
        ud.sinceWave = (ud.sinceWave ?? WAVE_GAP_SEC) + dt;
        if (n.talking) n.gest = 0;
        else if (n.listening && !wasListening && ud.sinceWave >= WAVE_GAP_SEC && n.character.duration("Wave")) { ud.sinceWave = 0; n.character.setAction("Wave", true); n.gest = n.character.duration("Wave") - 0.2; }
        else if (n.listening && n.gest <= 0 && Math.random() < dt / NOD_EVERY_SEC && n.character.duration("Agree")) { n.character.setAction("Agree", true); n.gest = n.character.duration("Agree") - 0.2; }
        if (n.gest <= 0) n.character.setAction(n.talking || (serving && n.serveTalk) ? "Talking" : null);
        n.character.setSpeed(0, 1, 2);
        n.character.update(dt);
        n.head.copy(n.root.position).setY(n.root.position.y + HEIGHT[n.id] * 0.92);
        dressing.get(n.id)?.tick(dt);
      }
      life.update(dt);
    },
  };
}
