// Ambient pedestrians: data-driven walkers on lane / plaza / Spire routes with a small state machine
// (walk -> browse an open stall -> walk on), pausing for the player. Every walker is a different Mixamo
// character from the cast registry (src/cast.ts) with its own Idle and Walk clips: no clones, no tints.
import * as THREE from "three";
import { loadGLB } from "./assets";
import type { Box } from "./physics/collision";
import { PEDESTRIANS, type CastMember } from "./cast";

interface Pedestrian {
  readonly root: THREE.Group;
  readonly mixer: THREE.AnimationMixer;
  readonly walk: THREE.AnimationAction;
  readonly idle: THREE.AnimationAction;
  readonly route: readonly THREE.Vector3[];
  readonly speed: number;
  /** Ground speed the Walk clip was authored for (m/s), so the stride matches the movement. */
  readonly clipSpeed: number;
  readonly body: Box;
  target: number;
  state: "walk" | "browse" | "yield";
  timer: number;
  /** Metres stepped aside while yielding to the player. */
  sidestep: number;
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
  /** Live collision boxes (one per walker) so the player cannot walk through people. */
  readonly bodies: readonly Box[];
}

const LANE_NORTH = -3.7;
const LANE_SOUTH = 3.7;
const BROWSE_CHANCE = 0.45;
const YIELD_DISTANCE = 1.4;
const BODY_HALF = 0.28;
const BODY_HEIGHT = 1.7;
const SIDESTEP_MAX = 1.2;
/** Manhattan metres beyond which a walker is not drawn (fog hides it anyway). */
const CULL_DISTANCE = 55;
const SIDESTEP_SPEED = 0.8;

// Loops through Market Lane, around the plaza fountain, and up through the Ledger Tower gap to the Spire.
function routes(): THREE.Vector3[][] {
  const v = (x: number, z: number) => new THREE.Vector3(x, 0, z);
  const ring = (cx: number, cz: number, r: number, n: number, phase: number) =>
    Array.from({ length: n }, (_, i) => v(cx + Math.cos(phase + (i / n) * Math.PI * 2) * r, cz + Math.sin(phase + (i / n) * Math.PI * 2) * r));
  const spire = [v(6, -12), v(5, -26), v(3.5, -37.5), v(10, -43), v(11, -52.3), v(-11, -52.3), v(-10, -43), v(-3.5, -37.5), v(-4.5, -26), v(-6, -12)];
  return [
    [v(14, LANE_NORTH), v(72, LANE_NORTH), v(72, LANE_SOUTH), v(14, LANE_SOUTH)],
    spire,
    [v(70, LANE_SOUTH + 0.5), v(15, LANE_SOUTH + 0.5), v(15, LANE_NORTH - 0.4), v(70, LANE_NORTH - 0.4)],
    ring(0, 0, 8.5, 10, 0),
    [v(40, LANE_NORTH + 0.5), v(66, LANE_NORTH + 0.5), v(66, LANE_SOUTH - 0.5), v(40, LANE_SOUTH - 0.5)],
    ring(0, 0, 10.5, 12, 1.4).reverse(),
    [v(-8, 13.6), v(10, 13.6), v(14, 2), v(30, 2), v(30, -2), v(10, -10), v(-12, -10), v(-12, 10)],
    [...spire].reverse(),
  ];
}

interface LoadedWalker {
  readonly scene: THREE.Group;
  readonly idle: THREE.AnimationClip;
  readonly walk: THREE.AnimationClip;
  readonly scale: number;
}

async function loadWalker(m: CastMember): Promise<LoadedWalker> {
  const gltf = await loadGLB(m.url);
  gltf.scene.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      o.castShadow = true;
      o.receiveShadow = true;
      o.frustumCulled = false; // skinned bounds don't follow the animation
    }
  });
  const idle = gltf.animations.find((c) => /idle/i.test(c.name));
  const walk = gltf.animations.find((c) => /walk/i.test(c.name));
  if (!idle || !walk) throw new Error(`${m.url}: needs Idle + Walk (found ${gltf.animations.map((c) => c.name).join(", ")})`);
  const size = new THREE.Box3().setFromObject(gltf.scene).getSize(new THREE.Vector3());
  return { scene: gltf.scene, idle, walk, scale: m.height / Math.max(size.y, 1e-3) };
}

export async function createCrowd(scene: THREE.Scene, stalls: readonly StallStop[]): Promise<Crowd> {
  const loaded = await Promise.allSettled(PEDESTRIANS.map(loadWalker));
  const allRoutes = routes();
  const peds: Pedestrian[] = [];
  const failed: string[] = [];
  loaded.forEach((res, i) => {
    if (res.status !== "fulfilled") {
      failed.push(PEDESTRIANS[i].url);
      return;
    }
    const { scene: model, idle: idleClip, walk: walkClip, scale } = res.value;
    model.scale.setScalar(scale);
    model.position.y = -new THREE.Box3().setFromObject(model).min.y;
    const root = new THREE.Group();
    root.add(model);
    scene.add(root);
    const mixer = new THREE.AnimationMixer(model);
    const walk = mixer.clipAction(walkClip).play();
    const idle = mixer.clipAction(idleClip).play();
    idle.setEffectiveWeight(0);
    walk.time = (i * 0.37) % walkClip.duration;
    const route = allRoutes[i % allRoutes.length];
    const start = (i * 3) % route.length;
    root.position.copy(route[start]).lerp(route[(start + 1) % route.length], 0.3 + (i % 3) * 0.2);
    const hurried = /hurried/i.test(PEDESTRIANS[i].appearance);
    peds.push({
      root, mixer, walk, idle, route,
      speed: hurried ? 1.55 : 1.1 + ((i * 17) % 7) / 25,
      clipSpeed: hurried ? 1.55 : 1.25,
      body: { minX: 0, maxX: 0, minY: 0, maxY: BODY_HEIGHT, minZ: 0, maxZ: 0 },
      target: (start + 1) % route.length, state: "walk", timer: 0, sidestep: 0, browsedAt: -1,
    });
  });
  if (failed.length) throw new Error(`pedestrians failed to load: ${failed.join(", ")}`);

  const tmp = new THREE.Vector3();
  const dir = new THREE.Vector3();
  const toPlayer = new THREE.Vector3();
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
  const syncBody = (p: Pedestrian) => {
    const { x, z } = p.root.position;
    p.body.minX = x - BODY_HALF; p.body.maxX = x + BODY_HALF;
    p.body.minZ = z - BODY_HALF; p.body.maxZ = z + BODY_HALF;
  };

  return {
    count: () => peds.length,
    bodies: peds.map((p) => p.body),
    update(dt, player) {
      for (const p of peds) {
        // Distance cull: skinned meshes skip frustum culling (bounds don't follow the pose), so far walkers
        // are hidden and not skinned; they keep walking their route.
        const far = Math.abs(player.x - p.root.position.x) + Math.abs(player.z - p.root.position.z) > CULL_DISTANCE;
        p.root.visible = !far;
        if (!far) p.mixer.update(dt);
        syncBody(p);
        if (p.state === "browse") {
          p.timer -= dt;
          blend(p, false, dt);
          if (p.timer <= 0) p.state = "walk";
          continue;
        }
        const goal = p.route[p.target];
        tmp.subVectors(goal, p.root.position).setY(0);
        const dist = tmp.length();
        dir.copy(tmp).normalize();
        // Yield to the player standing in the way.
        toPlayer.set(player.x - p.root.position.x, 0, player.z - p.root.position.z);
        const close = toPlayer.length() < YIELD_DISTANCE;
        if (close && toPlayer.normalize().dot(dir) > 0.4) {
          // Yield: pause, then step aside to the right so a head-on player can pass (no deadlock).
          p.state = "yield";
          p.timer += dt;
          if (p.timer > 0.4 && p.sidestep < SIDESTEP_MAX) {
            const s = SIDESTEP_SPEED * dt;
            p.root.position.x += -dir.z * s;
            p.root.position.z += dir.x * s;
            p.sidestep += s;
          }
          blend(p, p.timer > 0.4 && p.sidestep < SIDESTEP_MAX, dt);
          face(p, Math.atan2(toPlayer.x, toPlayer.z), dt);
          continue;
        }
        if (p.state === "yield") { p.timer = 0; p.sidestep = 0; }
        p.state = "walk";
        blend(p, true, dt);
        face(p, Math.atan2(dir.x, dir.z), dt);
        p.root.position.addScaledVector(dir, Math.min(dist, p.speed * dt));
        p.walk.timeScale = p.speed / p.clipSpeed;
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
