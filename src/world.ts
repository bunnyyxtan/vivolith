// Saltlight Row. The district geometry (facades, street, stalls, props, Ledger Tower) is built in Blender
// by blender/build_street.py and loaded from public/models/saltlight_row.glb. This file adds lights,
// sea, pier, the NPC, and live game surfaces (price boards).
import * as THREE from "three";
import { box, type Box } from "./physics/collision";
import { loadGLB, prepareModel } from "./assets";
import { loadCharacter, showPlaceholderNotice, type AnimatedCharacter } from "./character";
import { NAMED_NPCS } from "./cast";

/** Low golden-hour sun from the west: it rakes down Market Lane from the plaza. The HDRI is rotated to match. */
export const SUN_DIR = new THREE.Vector3().setFromSphericalCoords(1, THREE.MathUtils.degToRad(80.5), THREE.MathUtils.degToRad(-100));

export const PALETTE = {
  blue: 0x0091fd,
  sky: 0x83dcff,
  ink: 0x272727,
  paper: 0xeeeeeb,
  sodium: 0xffb56b,
};

export interface Interactable {
  readonly id: string;
  readonly name: string;
  readonly position: THREE.Vector3;
  readonly radius: number;
  /** Where the camera looks during the conversation (NPC head / sign face). */
  readonly focus: THREE.Vector3;
  /** Prompt verb ("Talk" by default). */
  readonly verb?: string;
}

export interface StallView {
  readonly open: boolean;
  readonly hasGoods: boolean;
  readonly title: string;
  readonly rows: ReadonlyArray<[string, string]>;
}

/** A runtime-painted display in the Spire (info totem, Labs agent feed). */
export interface ScreenView {
  readonly title: string;
  readonly lines: readonly string[];
}

export interface World {
  readonly colliders: Box[];
  readonly interactables: Interactable[];
  readonly spawn: THREE.Vector3;
  readonly sun: THREE.DirectionalLight;
  /** Resolves when the Blender district is loaded and its colliders are active. */
  readonly ready: Promise<void>;
  /** Tell the world which NPC (by interactable id) the player is talking to, or null. */
  talk(id: string | null): void;
  /** Reflect a stall's economic state: goods on the table and the chalkboard prices. */
  setStall(id: "pema", view: StallView): void;
  /** Paint a Spire display ("spire_info" totem, "labs_board" agent feed). */
  setScreen(id: "spire_info" | "labs_board", view: ScreenView): void;
  update(time: number, focus: THREE.Vector3): void;
}

const mat = (color: number, roughness = 0.85, extra: THREE.MeshStandardMaterialParameters = {}) =>
  new THREE.MeshStandardMaterial({ color, roughness, ...extra });

/** Chalkboard price sign painted at runtime (the economy updates it in Milestone 3). */
function paintPriceBoard(mesh: THREE.Mesh, title: string, rows: ReadonlyArray<[string, string]>): void {
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = 350;
  const g = c.getContext("2d")!;
  g.fillStyle = "#1f2421";
  g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = "rgba(255,255,255,0.05)";
  for (let i = 0; i < 40; i++) g.fillRect(Math.random() * 512, Math.random() * 350, 60, 2);
  g.fillStyle = "#f3efe2";
  g.font = "600 54px 'Segoe Print', 'Comic Sans MS', cursive";
  g.fillText(title, 28, 74);
  g.font = "44px 'Segoe Print', 'Comic Sans MS', cursive";
  rows.forEach(([item, price], i) => {
    g.fillStyle = "#f3efe2";
    g.fillText(item, 28, 150 + i * 70);
    g.fillStyle = "#ffd27a";
    g.fillText(price, 360, 150 + i * 70);
  });
  const tex = new THREE.CanvasTexture(c);
  tex.flipY = false; // glTF UV convention
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  mesh.material = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.12 });
}

/** Dark-glass display painted at runtime: sky-blue title, monospace lines (glTF UVs, flipY off). */
function paintScreen(mesh: THREE.Mesh, view: ScreenView): void {
  const c = document.createElement("canvas");
  c.width = 1024;
  c.height = 512;
  const g = c.getContext("2d")!;
  g.fillStyle = "#07121d";
  g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = "#0091fd";
  g.fillRect(0, 0, c.width, 6);
  g.fillStyle = "#83dcff";
  g.font = "700 46px ui-monospace, Consolas, monospace";
  g.fillText(view.title, 40, 76);
  g.fillStyle = "#eeeeeb";
  g.font = "30px ui-monospace, Consolas, monospace";
  view.lines.slice(0, 10).forEach((line, i) => g.fillText(line.slice(0, 58), 40, 140 + i * 40));
  const tex = new THREE.CanvasTexture(c);
  tex.flipY = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const old = mesh.material as THREE.MeshStandardMaterial;
  old.map?.dispose();
  mesh.material = new THREE.MeshStandardMaterial({ map: tex, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.9, roughness: 0.35 });
}

export function buildWorld(scene: THREE.Scene): World {
  const colliders: Box[] = [];
  const interactables: Interactable[] = [];
  const animated: Array<(t: number) => void> = [];
  // Point lights are forward-shaded on every pixel (3 interior lights cost ~3.2 ms at 720p on an RTX 3050),
  // so each district's practical lights are only enabled while the player is in that district.
  const marketLights: THREE.PointLight[] = [];
  const spireLights: THREE.PointLight[] = [];

  // ---------- Sun + atmosphere (sky and image-based light come from the HDRI, see render.ts) ----------
  const sunDir = SUN_DIR;
  scene.background = new THREE.Color(0xc79a83);
  scene.environmentIntensity = 0.75;
  scene.fog = new THREE.FogExp2(0xb7917c, 0.0048);

  const sun = new THREE.DirectionalLight(0xffb27a, 3.2);
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  const sc = sun.shadow.camera;
  sc.left = -40; sc.right = 40; sc.top = 40; sc.bottom = -40; sc.near = 1; sc.far = 260;
  sun.shadow.bias = -0.00025;
  sun.shadow.normalBias = 0.035;
  scene.add(sun, sun.target);
  scene.add(new THREE.HemisphereLight(0xa9c6ff, 0x6a5440, 0.35));

  // Warm practical lights where the player spends time (market tables, tower lantern).
  // Placed in front of (not under) the awnings so they light faces without blowing out the canopy.
  for (const [x, z] of [[19, -3.2], [33, 3.2], [47.5, -3.2]]) {
    const l = new THREE.PointLight(PALETTE.sodium, 4, 8, 2);
    l.position.set(x, 2.0, z);
    scene.add(l);
    marketLights.push(l);
  }
  const towerGlow = new THREE.PointLight(PALETTE.sky, 40, 26, 1.6);
  towerGlow.position.set(-20, 36, -21.5); // Ledger Tower lantern (corner campanile)
  scene.add(towerGlow);
  animated.push((t) => { towerGlow.intensity = 34 + Math.sin(t * 1.3) * 8; });

  // ---------- Fallback ground and sea (the Blender slabs sit on top) ----------
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), mat(0x6f6458, 0.95));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.06;
  ground.receiveShadow = true;
  scene.add(ground);

  const water = new THREE.Mesh(new THREE.PlaneGeometry(600, 300), mat(0x1c4560, 0.08, { metalness: 0.3 }));
  water.rotation.x = -Math.PI / 2;
  water.position.set(0, -0.6, 196);
  scene.add(water);
  colliders.push(box(-53, 46.5, 94, 1, 4), box(53, 46.5, 94, 1, 4)); // sea edge, pier gap open
  // District bounds. North of the plaza the Ledger Tower gap opens onto the Spire precinct, whose own
  // walls come from spire.glb; this segment closes the yard behind Market Lane's north row.
  colliders.push(box(51.1, -42, 69.8, 2, 6), box(-32, 0, 2, 100, 6), box(86, 0, 2, 60, 6));

  const plank = mat(0x6e5236, 0.8);
  const deck = new THREE.Mesh(new THREE.BoxGeometry(6, 0.25, 18), plank);
  deck.position.set(0, 0.125, 54);
  deck.castShadow = deck.receiveShadow = true;
  scene.add(deck);
  colliders.push(box(0, 54, 6, 18, 0.25), box(-3.4, 54, 0.6, 18, 4), box(3.4, 54, 0.6, 18, 4), box(0, 63.4, 6, 0.6, 4));

  // ---------- Blender district ----------
  let pemaBoard: THREE.Mesh | null = null;
  let pemaGoods: THREE.Object3D | null = null;
  let pendingStall: StallView | null = null;
  let lastStallKey = "";
  const applyStall = (view: StallView) => {
    const key = JSON.stringify(view);
    if (key === lastStallKey || !pemaBoard) return;
    lastStallKey = key;
    if (pemaGoods) pemaGoods.visible = view.open && view.hasGoods;
    paintPriceBoard(pemaBoard, view.title, view.open ? view.rows : [["Shutters", "down"], ["Back", "soon?"]]);
  };
  const ready = loadGLB("/models/saltlight_row.glb").then((gltf) => {
    const prepared = prepareModel(gltf.scene);
    colliders.push(...prepared.colliders);
    scene.add(gltf.scene);
    const board = gltf.scene.getObjectByName("SIGN_pema");
    pemaBoard = board instanceof THREE.Mesh ? board : null;
    pemaGoods = gltf.scene.getObjectByName("GOODS_n0") ?? null;
    if (pendingStall) applyStall(pendingStall);
  });

  // ---------- Harbor dispatch board (stand-in until the Gate 4 harbor build) ----------
  const dispatch = new THREE.Group();
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 256;
  const g2 = canvas.getContext("2d")!;
  g2.fillStyle = "#1d2a33";
  g2.fillRect(0, 0, 512, 256);
  g2.fillStyle = "#83dcff";
  g2.font = "700 54px ui-monospace, Consolas, monospace";
  g2.fillText("DISPATCH", 32, 92);
  g2.fillStyle = "#eeeeeb";
  g2.font = "34px ui-monospace, Consolas, monospace";
  g2.fillText("PIER 2 · COLD STORAGE", 32, 160);
  g2.fillText("HOLDS & RELEASES", 32, 210);
  const signTex = new THREE.CanvasTexture(canvas);
  signTex.colorSpace = THREE.SRGBColorSpace;
  const face = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 0.8), new THREE.MeshStandardMaterial({ map: signTex, emissive: 0xffffff, emissiveMap: signTex, emissiveIntensity: 0.25, roughness: 0.6 }));
  face.position.set(0, 1.55, 0.06);
  const backing = new THREE.Mesh(new THREE.BoxGeometry(1.75, 0.95, 0.1), mat(0x2b2a28, 0.6, { metalness: 0.4 }));
  backing.position.set(0, 1.55, 0);
  const postMesh = new THREE.Mesh(new THREE.BoxGeometry(0.12, 1.1, 0.12), mat(0x2b2a28, 0.6, { metalness: 0.4 }));
  postMesh.position.set(0, 0.55, 0);
  for (const m of [face, backing, postMesh]) { m.castShadow = true; dispatch.add(m); }
  dispatch.position.set(2.4, 0.25, 47.2);
  dispatch.rotation.y = -0.5;
  scene.add(dispatch);
  colliders.push(box(2.4, 47.2, 0.5, 0.5, 2.0, 0.25));
  interactables.push({
    id: "harbor",
    name: "Dispatch board",
    verb: "Read",
    position: new THREE.Vector3(1.6, 0, 48.4),
    radius: 2.2,
    focus: new THREE.Vector3(2.4, 1.55, 47.2),
  });

  // ---------- Named NPCs from the cast registry (idle at their post, turn and talk in dialogue) ----------
  interface NamedNpc { readonly id: string; readonly group: THREE.Group; readonly yaw: number; char: AnimatedCharacter | null; pending: number }
  const npcs: NamedNpc[] = [];
  let talkingTo: string | null = null;
  for (const m of NAMED_NPCS) {
    if (!m.post || !m.talk) continue;
    const group = new THREE.Group();
    group.position.set(m.post.x, m.post.y, m.post.z);
    group.rotation.y = m.post.yaw;
    scene.add(group);
    colliders.push(box(m.post.x, m.post.z, m.radius * 2, m.radius * 2, 1.7, m.post.y));
    const npc: NamedNpc = { id: m.id, group, yaw: m.post.yaw, char: null, pending: 0 };
    npcs.push(npc);
    loadCharacter(m.url, m.height)
      .then((c) => {
        c.setSpeed(0, 1, 2);
        group.add(c.root);
        npc.char = c;
      })
      .catch(() => showPlaceholderNotice(`NPC model failed to load: ${m.url}`));
    interactables.push({
      id: m.id,
      name: m.name,
      position: new THREE.Vector3(m.talk.x, 0, m.talk.z),
      radius: m.talk.radius,
      focus: new THREE.Vector3(m.post.x, m.post.y + m.talk.focusY, m.post.z),
    });
  }

  // ---------- NEAR Spire + Protocol Plaza (blender/build_spire.py) ----------
  const screens = new Map<string, THREE.Mesh>();
  const pendingScreens = new Map<string, ScreenView>();
  const spireReady = loadGLB("/models/spire.glb").then((gltf) => {
    const prepared = prepareModel(gltf.scene);
    colliders.push(...prepared.colliders);
    scene.add(gltf.scene);
    for (const id of ["spire_info", "labs_board"]) {
      const m = gltf.scene.getObjectByName(`SIGN_${id}`);
      if (m instanceof THREE.Mesh) {
        screens.set(id, m);
        const v = pendingScreens.get(id);
        if (v) paintScreen(m, v);
      }
    }
  });
  // Interior fill: the lobby and Labs sit under a 72 m tower (no sun), the HDRI alone reads flat.
  for (const [x, y, z, color, power] of [[-24, 6.4, -58.5, 0xffe2c0, 30], [-26.5, 3.5, -67.8, 0xdcefff, 26], [-19.5, 3.5, -67.8, 0xdcefff, 20]] as const) {
    const l = new THREE.PointLight(color, power, 14, 2);
    l.position.set(x, y, z);
    scene.add(l);
    spireLights.push(l);
  }

  let lastTime = 0;
  let frameNo = 0;
  return {
    colliders,
    interactables,
    spawn: new THREE.Vector3(14, 0, 1.5),
    sun,
    ready: Promise.all([ready, spireReady]).then(() => undefined),
    talk(id) {
      talkingTo = id;
      for (const n of npcs) n.char?.setAction(n.id === id ? "Talking" : null);
    },
    setScreen(id, view) {
      pendingScreens.set(id, view);
      const m = screens.get(id);
      if (m) paintScreen(m, view);
    },
    setStall(_id, view) {
      pendingStall = view;
      applyStall(view);
    },
    update(time, focus) {
      const dt = THREE.MathUtils.clamp(time - lastTime, 0, 0.05); // never negative (clock resets, tests)
      lastTime = time;
      // Face their post's direction at rest; turn toward the player while in conversation.
      frameNo++;
      for (const n of npcs) {
        const g = n.group;
        const want = talkingTo === n.id ? Math.atan2(focus.x - g.position.x, focus.z - g.position.z) : n.yaw;
        let delta = want - g.rotation.y;
        delta = Math.atan2(Math.sin(delta), Math.cos(delta));
        g.rotation.y += delta * (1 - Math.exp(-6 * dt));
        // Far NPCs animate at 1/6 rate (they still idle, never freeze in bind pose).
        // ponytail: rate-only LOD; swap to a low-poly mesh when the cast grows past ~20 named NPCs.
        n.pending += dt;
        const dist = Math.abs(focus.x - g.position.x) + Math.abs(focus.z - g.position.z);
        const far = dist > 40;
        g.visible = dist < 70 || talkingTo === n.id; // not drawn from across the district
        if (n.char && (!far || talkingTo === n.id || frameNo % 6 === 0)) {
          n.char.update(n.pending);
          n.pending = 0;
        }
      }
      // Keep the shadow frustum centred on the player, snapped to texels to avoid shimmering.
      const texel = (sc.right - sc.left) / sun.shadow.mapSize.x;
      const fx = Math.round(focus.x / texel) * texel;
      const fz = Math.round(focus.z / texel) * texel;
      sun.target.position.set(fx, 0, fz);
      sun.position.set(fx, 0, fz).addScaledVector(sunDir, 120);
      const inSpire = focus.z < -44; // north of the Ledger Tower gap
      for (const l of spireLights) l.visible = inSpire;
      for (const l of marketLights) l.visible = !inSpire;
      for (const fn of animated) fn(time);
    },
  };
}
