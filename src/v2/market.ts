// Market Lane in v2: stall posts, merchant characters (toon + outline), and diegetic chalkboard price boards.
// Posts come from /models/v2/town.glb empties (NPC_<id> = merchant post, STALL_<id> = customer standing point).
// Until town.glb exists, FALLBACK_POSTS place the market on the plaza promenade (x -7..7, z -7..-41,
// benches along x = +-7.2) with Ines behind the Spire lobby desk (desk top at x -28.7..-23.7, z ~-60).
import * as THREE from "three";
import { loadGLB, prepareModel } from "../assets";
import { loadCharacter, type AnimatedCharacter } from "../character";
import { groundHeightAt, type Box } from "../physics/collision";
import { applyToon } from "./toon";
import { installProps } from "./props";
import { createLife, type FolkChar, type Life } from "./npc";
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
const MODEL_FALLBACK: Record<NpcId, string> = {
  pema: "/models/pema.glb", tomas: "/models/npc_tomas.glb", mira: "/models/pema.glb", arin: "/models/npc_teahouse.glb",
  harbor: "/models/vendor_lewis.glb", engineer: "/models/npc_engineer.glb",
};
/** Anime cast file per role (public/models/v2/cast/<name>.glb). Harbor Dispatch has no cast model yet. */
const CAST: Partial<Record<NpcId, string>> = { pema: "merchant_fruit", tomas: "tomas", mira: "pema", arin: "marta", engineer: "ines" }; // pema: Tripo model
/** Town posts by role; Harbor Dispatch takes the v3 stall at the gate end of the square. */
const TOWN_POST: Record<NpcId, string> = { pema: "pema", tomas: "tomas", mira: "v2", arin: "teahouse", harbor: "v3", engineer: "engineer" };
const CAST_HEIGHT = 1.7;
const HEIGHT: Record<NpcId, number> = { pema: CAST_HEIGHT, tomas: CAST_HEIGHT * 1.06, mira: CAST_HEIGHT * 0.98, arin: CAST_HEIGHT, harbor: CAST_HEIGHT, engineer: CAST_HEIGHT };
const FOLK = 24;
const INTERACT_RADIUS = 2.4;
const NOTICE_RADIUS = 7;

export interface Board {
  readonly mesh: THREE.Mesh;
  draw(lines: { title: string; price: string; sub: string; closed: boolean }): void;
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
  attend: THREE.Vector3 | null;
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
  /** A merchant says a line (speech bubble above their head). */
  say(id: string, text: string, sec?: number): void;
}

export interface StallState {
  readonly stock: number;
  readonly open: boolean;
  readonly upgraded: boolean;
  /** 0..2 from pricing.ts stallPull. */
  readonly pull: number;
}

const CRATE_UNITS = 4; // one crate on the pile per 4 units of stock
const MAX_CRATES = 9;

/** Crate pile, closed shutter and upgrade dressing beside a stall; meshes are created once and toggled. */
function makeStallDressing(scene: THREE.Scene, post: Post, y: number): (s: StallState) => void {
  const side = Math.sign(post.stall.x - post.npc.x) || 1; // +1: customers stand on +X of the counter
  const front = (post.npc.x + post.stall.x) / 2; // the canopy's customer-facing edge
  const face = side > 0 ? Math.PI / 2 : -Math.PI / 2;
  const g = new THREE.Group(); // crate pile beside the stall, on the customer side
  g.position.set(front + side * 0.3, y, post.npc.z - 2.3);
  g.rotation.y = face;
  scene.add(g);
  const wood = new THREE.MeshToonMaterial({ color: 0x9c6a3c });
  const slat = new THREE.MeshToonMaterial({ color: 0x6e4524 });
  const fruit = new THREE.MeshToonMaterial({ color: 0xffa21a });
  const mangoGeo = new THREE.IcosahedronGeometry(0.075, 1);
  const crates = Array.from({ length: MAX_CRATES }, (_, i) => {
    const c = new THREE.Group();
    c.add(new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.26, 0.38), wood));
    for (const sy of [-0.06, 0.06]) { // dark slat lines on the long faces
      const band = new THREE.Mesh(new THREE.BoxGeometry(0.51, 0.03, 0.39), slat);
      band.position.y = sy;
      c.add(band);
    }
    for (let k = 0; k < 6; k++) { // mangoes heaped in the crate
      const m = new THREE.Mesh(mangoGeo, fruit);
      m.position.set(-0.15 + (k % 3) * 0.15, 0.15 + (k > 2 ? 0.03 : 0), k > 2 ? 0.07 : -0.07);
      m.scale.set(1, 0.85, 1.25);
      c.add(m);
    }
    const row = Math.floor(i / 3);
    c.position.set((i % 3) * 0.52 - 0.52 + row * 0.26, 0.13 + row * 0.3, 0);
    g.add(c);
    return c;
  });
  const shutter = new THREE.Mesh(new THREE.PlaneGeometry(3.0, 1.0), new THREE.MeshToonMaterial({ color: 0x5b6470, side: THREE.DoubleSide }));
  shutter.position.set(front + side * 0.15, y + 1.05, post.npc.z);
  shutter.rotation.y = face;
  scene.add(shutter);
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
  applyToon(g, 0.008, undefined, true);
  return (s) => {
    const n = Math.min(MAX_CRATES, Math.ceil(s.stock / CRATE_UNITS));
    crates.forEach((c, i) => { c.visible = i < n; });
    shutter.visible = !s.open;
    up.visible = s.upgraded;
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
  const draw: Board["draw"] = ({ title, price, sub, closed }) => {
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
    ctx.fillText(sub, 256, 320);
    tex.needsUpdate = true;
  };
  return { mesh: frame as THREE.Mesh, draw };
}

async function loadTown(colliders: Box[], scene: THREE.Scene): Promise<THREE.Object3D | null> {
  try {
    const gltf = await loadGLB("/models/v2/town.glb");
    const m = prepareModel(gltf.scene);
    colliders.push(...m.colliders);
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

/** Cast GLB with the old Mixamo clips borrowed when the cast export's own clips are static
 *  (current cast files bake every clip as 2 identical keys = bind pose). Falls back to the old model. */
async function loadNpcModel(id: NpcId): Promise<AnimatedCharacter> {
  const cast = CAST[id];
  if (cast) {
    const url = `/models/v2/cast/${cast}.glb`;
    try {
      const idle = (await loadGLB(url)).animations.find((c) => /idle/i.test(c.name));
      const moves = idle?.tracks.some((t) => /quaternion/.test(t.name) && t.times.length > 2);
      // ponytail: loads the cast GLB twice (check + character); fold into loadCharacter if load time matters.
      return await loadCharacter(url, HEIGHT[id], moves ? undefined : MODEL_FALLBACK[id]);
    } catch { /* cast file missing: old model below */ }
  }
  return loadCharacter(MODEL_FALLBACK[id], HEIGHT[id]);
}

/** Townsfolk models (cast folk1..6; Idle/Walk/Run/Talking borrowed from old Mixamo characters, the cast clips are static). */
const FOLK_CLIPS = ["/models/ped_abe.glb", "/models/npc_teahouse.glb", "/models/player.glb"];
async function loadFolk(scene: THREE.Scene): Promise<FolkChar[]> {
  const out = await Promise.all(Array.from({ length: FOLK }, async (_, i): Promise<FolkChar | null> => {
    try {
      const c = await loadCharacter(`/models/v2/cast/folk${(i % 6) + 1}.glb`, CAST_HEIGHT * (0.94 + 0.06 * (i % 3)), FOLK_CLIPS);
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
  const dressing = new Map<string, (s: StallState) => void>();
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
    if (id !== "engineer" && id !== "harbor") dressing.set(id, makeStallDressing(scene, post, y));
    return { id, root, character, post, board, head: new THREE.Vector3(), talking: false, serving: false, attend: null };
  }));

  const life: Life = createLife(scene, colliders, town, npcs, folk, floor);
  const toP = new THREE.Vector3();
  return {
    npcs, townSpawn, floor,
    cast: [...npcs.map((n) => n.character), ...folk.map((f) => f.c)],
    boards: npcs.flatMap((n) => (n.board ? [n.board.mesh] : [])),
    bind: (body, camera) => life.bind(body, camera),
    setStall(id, st) { dressing.get(id)?.(st); life.setPull(id, st.pull); },
    say(id, text, sec) { const n = npcs.find((x) => x.id === id); if (n) life.say(n.head, text, sec); },
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
        const want = near ? Math.atan2(toP.x, toP.z) : at ? Math.atan2(at.x - n.root.position.x, at.z - n.root.position.z) : Math.atan2(n.post.stall.x - n.post.npc.x, n.post.stall.z - n.post.npc.z);
        let d = want - n.root.rotation.y;
        d = Math.atan2(Math.sin(d), Math.cos(d));
        n.root.rotation.y += d * (1 - Math.exp(-5 * dt));
        n.character.setAction(n.talking || n.serving ? "Talking" : null);
        n.character.setSpeed(0, 1, 2);
        n.character.update(dt);
        n.head.copy(n.root.position).setY(n.root.position.y + HEIGHT[n.id] * 0.92);
      }
      life.update(dt);
    },
  };
}
