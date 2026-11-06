// Ambient market crowd: data-driven pedestrians on sidewalk/lane routes with a small state machine
// (walk -> browse an open stall -> walk on), pausing for the player. Reuses the two Mixamo rigs with
// outfit tints and body-scale variation; Remy's walk is retargeted to the Pema rig (rotation tracks only).
import * as THREE from "three";
import { clone as cloneSkinned } from "three/addons/utils/SkeletonUtils.js";
import { loadGLB } from "./assets";

type Rig = "remy" | "pema";

interface Pedestrian {
  readonly root: THREE.Group;
  readonly mixer: THREE.AnimationMixer;
  readonly walk: THREE.AnimationAction;
  readonly idle: THREE.AnimationAction;
  readonly route: readonly THREE.Vector3[];
  readonly speed: number;
  target: number;
  state: "walk" | "browse" | "yield";
  timer: number;
  browsedAt: number;
}

/** A stall a pedestrian may stop at; `open()` comes from the economy so closed shops are skipped. */
export interface StallStop {
  readonly id: string;
  readonly at: THREE.Vector3;
  readonly facing: number;
  open(): boolean;
}

export interface Crowd {
  update(dt: number, player: THREE.Vector3): void;
  count(): number;
}

const LANE_NORTH = -3.7;
const LANE_SOUTH = 3.7;
const BROWSE_CHANCE = 0.45;
const YIELD_DISTANCE = 1.4;

// Loops through Market Lane and around the plaza fountain (three.js coordinates, y = 0 road level).
function routes(): THREE.Vector3[][] {
  const v = (x: number, z: number) => new THREE.Vector3(x, 0, z);
  const ring = (cx: number, cz: number, r: number, n: number, phase: number) =>
    Array.from({ length: n }, (_, i) => v(cx + Math.cos(phase + (i / n) * Math.PI * 2) * r, cz + Math.sin(phase + (i / n) * Math.PI * 2) * r));
  return [
    [v(14, LANE_NORTH), v(72, LANE_NORTH), v(72, LANE_SOUTH), v(14, LANE_SOUTH)],
    [v(70, LANE_SOUTH + 0.5), v(15, LANE_SOUTH + 0.5), v(15, LANE_NORTH - 0.4), v(70, LANE_NORTH - 0.4)],
    [v(40, LANE_NORTH + 0.5), v(66, LANE_NORTH + 0.5), v(66, LANE_SOUTH - 0.5), v(40, LANE_SOUTH - 0.5)],
    ring(0, 0, 8.5, 10, 0),
    ring(0, 0, 10.5, 12, 1.4).reverse(),
    [v(-8, 13.6), v(10, 13.6), v(14, 2), v(30, 2), v(30, -2), v(10, -10), v(-12, -10), v(-12, 10)],
  ];
}

const OUTFITS = ["#6b7f9a", "#9a5a3e", "#4f6b4a", "#8a7a5c", "#3f4a5e", "#a8865a", "#6c4a6e", "#5a6f73"];

function tint(root: THREE.Object3D, color: THREE.Color, onlyNames: RegExp | null): void {
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    if (onlyNames && !onlyNames.test(o.name)) return;
    const mats = (Array.isArray(o.material) ? o.material : [o.material]).map((m) => {
      const c = (m as THREE.MeshStandardMaterial).clone();
      c.color.multiply(color);
      return c;
    });
    o.material = Array.isArray(o.material) ? mats : mats[0];
  });
}

function prepare(model: THREE.Object3D, height: number): number {
  model.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      o.castShadow = true;
      o.receiveShadow = true;
      o.frustumCulled = false;
    }
  });
  const size = new THREE.Box3().setFromObject(model).getSize(new THREE.Vector3());
  return height / Math.max(size.y, 1e-3);
}

export async function createCrowd(scene: THREE.Scene, stalls: readonly StallStop[], count = 10): Promise<Crowd> {
  const [remy, pema] = await Promise.all([loadGLB("/models/player.glb"), loadGLB("/models/pema.glb")]);
  const remyScale = prepare(remy.scene, 1.76);
  const pemaScale = prepare(pema.scene, 1.62);
  const walkClip = remy.animations.find((c) => /walk/i.test(c.name))!;
  const remyIdle = remy.animations.find((c) => /idle/i.test(c.name))!;
  const pemaIdle = pema.animations.find((c) => /idle/i.test(c.name))!;
  // Retarget: bone names match across Mixamo rigs; keep rotations only so proportions stay the Pema rig's.
  const walkForPema = new THREE.AnimationClip("Walk", walkClip.duration, walkClip.tracks.filter((t) => t.name.endsWith(".quaternion")));

  const allRoutes = routes();
  const peds: Pedestrian[] = [];
  for (let i = 0; i < count; i++) {
    const rig: Rig = i % 2 === 0 ? "remy" : "pema";
    const src = rig === "remy" ? remy.scene : pema.scene;
    const model = cloneSkinned(src);
    const variation = 0.92 + ((i * 37) % 13) / 100;
    model.scale.setScalar((rig === "remy" ? remyScale : pemaScale) * variation);
    const outfit = new THREE.Color(OUTFITS[i % OUTFITS.length]).lerp(new THREE.Color("#ffffff"), 0.35);
    tint(model, outfit, rig === "remy" ? /Tops|Bottoms|Shoes/i : null);
    const root = new THREE.Group();
    root.add(model);
    scene.add(root);
    const mixer = new THREE.AnimationMixer(model);
    const walk = mixer.clipAction(rig === "remy" ? walkClip : walkForPema).play();
    const idle = mixer.clipAction(rig === "remy" ? remyIdle : pemaIdle).play();
    idle.setEffectiveWeight(0);
    walk.time = (i * 0.37) % walkClip.duration;
    const route = allRoutes[i % allRoutes.length];
    const start = Math.floor((i * 5) / allRoutes.length) % route.length;
    const startPos = route[start].clone().lerp(route[(start + 1) % route.length], 0.3 + (i % 3) * 0.2);
    root.position.copy(startPos);
    peds.push({ root, mixer, walk, idle, route, speed: 1.15 + ((i * 17) % 7) / 20, target: (start + 1) % route.length, state: "walk", timer: 0, browsedAt: -1 });
  }

  const tmp = new THREE.Vector3();
  const blend = (p: Pedestrian, walking: boolean, dt: number) => {
    const w = THREE.MathUtils.damp(p.walk.getEffectiveWeight(), walking ? 1 : 0, 6, dt);
    p.walk.setEffectiveWeight(w);
    p.idle.setEffectiveWeight(1 - w);
  };
  const face = (p: Pedestrian, yaw: number, dt: number) => {
    let d = yaw - p.root.rotation.y;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    p.root.rotation.y += d * (1 - Math.exp(-8 * dt));
  };

  return {
    count: () => peds.length,
    update(dt, player) {
      for (const p of peds) {
        p.mixer.update(dt);
        if (p.state === "browse") {
          p.timer -= dt;
          blend(p, false, dt);
          if (p.timer <= 0) p.state = "walk";
          continue;
        }
        const goal = p.route[p.target];
        tmp.subVectors(goal, p.root.position).setY(0);
        const dist = tmp.length();
        const heading = Math.atan2(tmp.x, tmp.z);
        // Yield to the player standing in the way.
        const toPlayer = new THREE.Vector3(player.x - p.root.position.x, 0, player.z - p.root.position.z);
        const blocked = toPlayer.length() < YIELD_DISTANCE && toPlayer.normalize().dot(tmp.clone().normalize()) > 0.4;
        if (blocked) {
          p.state = "yield";
          blend(p, false, dt);
          face(p, Math.atan2(toPlayer.x, toPlayer.z), dt);
          continue;
        }
        p.state = "walk";
        blend(p, true, dt);
        face(p, heading, dt);
        const step = Math.min(dist, p.speed * dt);
        p.root.position.addScaledVector(tmp.normalize(), step);
        p.walk.timeScale = p.speed / 1.25;
        if (dist < 0.3) p.target = (p.target + 1) % p.route.length;
        // Browse an open stall when passing its counter (skip closed or empty ones: the economy shows).
        for (const s of stalls) {
          if (p.browsedAt === s.at.x * 1000 + s.at.z) continue;
          if (p.root.position.distanceTo(s.at) < 0.9 && s.open() && Math.sin(s.at.x * 12.9898 + p.speed * 78.233) * 0.5 + 0.5 < BROWSE_CHANCE) {
            p.browsedAt = s.at.x * 1000 + s.at.z;
            p.state = "browse";
            p.timer = 3 + ((s.at.x * 7) % 4);
            p.root.rotation.y = s.facing;
            break;
          }
        }
      }
    },
  };
}

/** Customer-side stop points in front of every Market Lane stall (matches blender/build_street.py). */
export function marketStallStops(isOpen: (id: string) => boolean): StallStop[] {
  const stops: StallStop[] = [];
  [19, 28.5, 38, 47.5, 57, 66.5].forEach((x, i) => {
    const id = i === 0 ? "pema" : `n${i}`;
    stops.push({ id, at: new THREE.Vector3(x, 0, LANE_NORTH), facing: Math.PI, open: () => isOpen(id) });
  });
  for (let i = 0; i < 6; i++) {
    const id = `s${i}`;
    stops.push({ id, at: new THREE.Vector3(23.5 + i * 9.5, 0, LANE_SOUTH), facing: 0, open: () => isOpen(id) });
  }
  return stops;
}
