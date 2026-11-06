// Saltlight Row. The district geometry (facades, street, stalls, props, Ledger Tower) is built in Blender
// by blender/build_street.py and loaded from public/models/saltlight_row.glb. This file adds lights,
// sea, pier, the NPC, and live game surfaces (price boards).
import * as THREE from "three";
import { box, type Box } from "./physics/collision";
import { loadGLB, prepareModel } from "./assets";
import { loadCharacter, showPlaceholderNotice, type AnimatedCharacter } from "./character";

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

export function buildWorld(scene: THREE.Scene): World {
  const colliders: Box[] = [];
  const interactables: Interactable[] = [];
  const animated: Array<(t: number) => void> = [];

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
  }
  const towerGlow = new THREE.PointLight(PALETTE.sky, 40, 26, 1.6);
  towerGlow.position.set(0, 36, -21);
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
  colliders.push(box(0, -42, 160, 2, 6), box(-32, 0, 2, 100, 6), box(86, 0, 2, 60, 6)); // district bounds

  const plank = mat(0x6e5236, 0.8);
  const deck = new THREE.Mesh(new THREE.BoxGeometry(6, 0.25, 18), plank);
  deck.position.set(0, 0.125, 54);
  deck.castShadow = deck.receiveShadow = true;
  scene.add(deck);
  colliders.push(box(0, 54, 6, 18, 0.25), box(-3.4, 54, 0.6, 18, 4), box(3.4, 54, 0.6, 18, 4), box(0, 63.4, 6, 0.6, 4));

  // ---------- Blender district ----------
  const ready = loadGLB("/models/saltlight_row.glb").then((gltf) => {
    const prepared = prepareModel(gltf.scene);
    colliders.push(...prepared.colliders);
    scene.add(gltf.scene);
    const board = gltf.scene.getObjectByName("SIGN_pema");
    if (board instanceof THREE.Mesh) paintPriceBoard(board, "PEMA'S", [["Mangoes", "3 c"], ["Lemons", "1 c"]]);
  });

  // ---------- Auntie Pema (Mixamo character, idles behind her stall, turns and talks in dialogue) ----------
  const pemaPos = new THREE.Vector3(19, 0.15, -6.9);
  const npc = new THREE.Group();
  npc.position.copy(pemaPos);
  scene.add(npc);
  colliders.push(box(pemaPos.x, pemaPos.z, 0.6, 0.6, 1.7, 0.15));
  let pema: AnimatedCharacter | null = null;
  let talkingTo: string | null = null;
  loadCharacter("/models/pema.glb", 1.62)
    .then((c) => {
      c.setSpeed(0, 1, 2);
      npc.add(c.root);
      pema = c;
    })
    .catch(() => {
      showPlaceholderNotice("Placeholder NPC: public/models/pema.glb failed to load");
      const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.3, 0.7, 6, 16), mat(0xb5462f, 0.8));
      body.position.y = 0.9;
      npc.add(body);
    });
  interactables.push({
    id: "pema",
    name: "Auntie Pema",
    position: new THREE.Vector3(19, 0, -4.3),
    radius: 2.4,
    lines: [
      "Mangoes! Sweetest on the Row. Three coins a crate... for you, maybe two.",
      "Rent is due tonight and the Tea House hasn't paid me. Don't tell anyone.",
      "Everyone on this street hears about every deal. Remember that, newcomer.",
    ],
  });

  let lastTime = 0;
  return {
    colliders,
    interactables,
    spawn: new THREE.Vector3(14, 0, 1.5),
    sun,
    ready,
    talk(id) {
      talkingTo = id;
      pema?.setAction(id === "pema" ? "Talking" : null);
    },
    update(time, focus) {
      const dt = Math.min(time - lastTime, 0.05);
      lastTime = time;
      // Face the street at rest; turn toward the player while in conversation.
      const want = talkingTo === "pema" ? Math.atan2(focus.x - npc.position.x, focus.z - npc.position.z) : 0;
      let delta = want - npc.rotation.y;
      delta = Math.atan2(Math.sin(delta), Math.cos(delta));
      npc.rotation.y += delta * (1 - Math.exp(-6 * dt));
      pema?.update(dt);
      // Keep the shadow frustum centred on the player, snapped to texels to avoid shimmering.
      const texel = (sc.right - sc.left) / sun.shadow.mapSize.x;
      const fx = Math.round(focus.x / texel) * texel;
      const fz = Math.round(focus.z / texel) * texel;
      sun.target.position.set(fx, 0, fz);
      sun.position.set(fx, 0, fz).addScaledVector(sunDir, 120);
      for (const fn of animated) fn(time);
    },
  };
}
