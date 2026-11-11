// Ambient traffic: a handful of cars on the directed lanes of /models/v2/roads.json (fallback loop if absent).
// Car GLBs have their nose on local +Z, so rotation.y = atan2(headingX, headingZ). Cars look ahead along their own
// route (cars as oriented rectangles, townsfolk, Kavi), reserve junction connectors first-come-first-served, pull
// into roads.json parking spots, wait, and leave; dead-end lanes either U-turn or despawn and respawn elsewhere.
// Faked: no real physics, junction conflicts are geometric proximity of connector lanes.
import * as THREE from "three";
import { loadGLB, prepareModel } from "../assets";
import type { Box } from "../physics/collision";
import type { Player } from "./player";
import { pedestrians } from "./npc";

interface Poly { x: Float32Array; z: Float32Array; c: Float32Array; n: number; len: number }
interface Lane { id: string; poly: Poly; next: number[]; speed: number; turn: boolean; ring: boolean }
interface Spot {
  x: number; z: number; hx: number; hz: number; lane: number; sA: number; sB: number;
  inP: Poly; outP: Poly; reverseOut: boolean; busy: boolean;
}
const DRIVE = 0, PARK_IN = 1, PARKED = 2, HIDDEN = 3, LEAVE = 4;
/** Drivable rig read from a car GLB (blender/fix_cars.py): wheel_* spin about local X, steer_* turn about Y. */
interface Rig { wheels: THREE.Object3D[]; steers: THREE.Object3D[]; body: THREE.Object3D | null; wb: number; r: number; mid: number }
interface Car extends Rig {
  obj: THREE.Object3D; halfL: number; halfW: number;
  /** Axle positions (x, z): the leading one follows the road, the trailing one is dragged behind it. */
  fx: number; fz: number; rx: number; rz: number; steer: number; pv: number; pitch: number; roll: number;
  mode: number; poly: Poly; seg: number; s: number; dir: number; v: number;
  lane: number; next: number; claim: number; spot: number; wantSpot: number; timer: number; stuck: number;
  x: number; z: number; yaw: number; hx: number; hz: number; spin: number; despawn: boolean;
}
interface RoadsJson { lanes: { id: string; points: number[][]; next?: string[]; speed?: number }[]; parking?: { x: number; z: number; yaw?: number; dx?: number; dz?: number }[] }

const MODELS = ["ev_sedan", "ev_pickup"];
const POOL = 7, ACCEL = 3, BRAKE = 9, COMFORT = 4, MAX_SPEED = 7;
/** Top of the town's asphalt (measured by raycast: 0.024 m everywhere on the lanes); tyres stand on it. */
const ROAD_Y = 0.024;
/** Sky reflection and clear coat on car paint: enough for a highlight, not so much that the sky bleaches the colour. */
const CAR_REFLECT = 0.5, CAR_COAT = 0.35;
const MAX_STEER = 0.6, PITCH_PER_ACCEL = 0.006, ROLL_PER_LATERAL = 0.004, MAX_TILT = 0.035;
const PROBES = [1.5, 3, 4.5, 6, 7.5, 9, 10.5, 12, 13.5, 15, 16.5, 18, 19.5];
const MAX_PARKED = 2, PARK_CHANCE = 0.5, RING_UTURN = 0.4, MIN_SPAWN_GAP = 18, MIN_SPAWN_PLAYER = 30;

const FALLBACK: RoadsJson = (() => {
  const pts: number[][] = [];
  for (let x = -40; x <= 60; x += 10) pts.push([x, 69.6]);
  const back: number[][] = [];
  for (let x = 60; x >= -40; x -= 10) back.push([x, 66.4]);
  return { lanes: [{ id: "fb_e", points: pts, next: ["fb_w"], speed: 7 }, { id: "fb_w", points: back, next: ["fb_e"], speed: 7 }] };
})();

const mkPoly = (cap: number): Poly => ({ x: new Float32Array(cap), z: new Float32Array(cap), c: new Float32Array(cap), n: 0, len: 0 });
function fillPoly(p: Poly, pts: ArrayLike<ArrayLike<number>>): Poly {
  let n = 0;
  for (let i = 0; i < pts.length && n < p.x.length; i++) {
    const x = pts[i][0], z = pts[i][1];
    if (n && Math.hypot(x - p.x[n - 1], z - p.z[n - 1]) < 1e-3) continue;
    p.x[n] = x; p.z[n] = z;
    p.c[n] = n ? p.c[n - 1] + Math.hypot(x - p.x[n - 1], z - p.z[n - 1]) : 0;
    n++;
  }
  p.n = n; p.len = n ? p.c[n - 1] : 0;
  return p;
}
const mkLanePoly = (pts: number[][]): Poly => fillPoly(mkPoly(pts.length), pts);

/** Point and unit tangent at distance s; `hint` is a starting segment. Returns the segment index. */
function sample(p: Poly, s: number, hint: number, out: number[]): number {
  if (p.n < 2) { out[0] = p.x[0] ?? 0; out[1] = p.z[0] ?? 0; out[2] = 0; out[3] = 1; return 0; }
  s = Math.min(Math.max(s, 0), p.len);
  let i = Math.min(Math.max(hint, 0), p.n - 2);
  while (i > 0 && p.c[i] > s) i--;
  while (i < p.n - 2 && p.c[i + 1] < s) i++;
  const dx = p.x[i + 1] - p.x[i], dz = p.z[i + 1] - p.z[i], d = Math.hypot(dx, dz) || 1;
  const t = Math.min(Math.max((s - p.c[i]) / d, 0), 1);
  out[0] = p.x[i] + dx * t; out[1] = p.z[i] + dz * t; out[2] = dx / d; out[3] = dz / d;
  return i;
}

function bezier(p: Poly, x0: number, z0: number, d0x: number, d0z: number, x1: number, z1: number, d1x: number, d1z: number): Poly {
  const k = Math.hypot(x1 - x0, z1 - z0) * 0.45;
  const ax = x0 + d0x * k, az = z0 + d0z * k, bx = x1 - d1x * k, bz = z1 - d1z * k;
  const pts: number[][] = [];
  for (let i = 0; i <= 16; i++) {
    const t = i / 16, u = 1 - t;
    pts.push([u * u * u * x0 + 3 * u * u * t * ax + 3 * u * t * t * bx + t * t * t * x1, u * u * u * z0 + 3 * u * u * t * az + 3 * u * t * t * bz + t * t * t * z1]);
  }
  return fillPoly(p, pts);
}

/** Wheels, steer pivots, wheelbase, tyre radius and where the axles' midpoint sits from the model origin (local Z). */
function rigOf(obj: THREE.Object3D): Rig {
  const wheels: THREE.Object3D[] = [], steers: THREE.Object3D[] = [];
  let body: THREE.Object3D | null = null;
  obj.updateMatrixWorld(true);
  obj.traverse((o) => {
    if (/^wheel_/.test(o.name)) wheels.push(o);
    else if (/^steer_/.test(o.name)) steers.push(o);
    else if (o.name === "body") body = o;
  });
  const inv = new THREE.Matrix4().copy(obj.matrixWorld).invert();
  const at = wheels.map((w) => w.getWorldPosition(new THREE.Vector3()).applyMatrix4(inv));
  if (at.length < 4) return { wheels, steers, body, wb: 2.8, r: 0.34, mid: 0 }; // an unrigged model still drives
  const front = Math.max(...at.map((p) => p.z)), rear = Math.min(...at.map((p) => p.z));
  return { wheels, steers, body, wb: front - rear, r: at.reduce((n, p) => n + p.y, 0) / at.length, mid: (front + rear) / 2 };
}

async function loadRoads(): Promise<{ json: RoadsJson; real: boolean }> {
  try {
    const r = await fetch("/models/v2/roads.json");
    const j = (await r.json()) as RoadsJson;
    if (Array.isArray(j.lanes) && j.lanes.length) return { json: j, real: true };
  } catch { /* not built yet */ }
  console.warn("traffic: roads.json missing, using fallback road");
  return { json: FALLBACK, real: false };
}

export async function installTraffic(scene: THREE.Scene, colliders: Box[], player: Player, onUpdate: Array<(dt: number) => void>): Promise<void> {
  const { json } = await loadRoads();
  const usable = json.lanes.filter((l) => Array.isArray(l.points) && l.points.length > 1);
  const ids = new Map(usable.map((l, i) => [l.id, i]));
  const lanes: Lane[] = usable.map((l) => ({
    id: l.id, poly: mkLanePoly(l.points), speed: Math.min(l.speed ?? 7, MAX_SPEED),
    next: (l.next ?? []).flatMap((n) => (ids.has(n) ? [ids.get(n)!] : [])),
    turn: l.id.startsWith("turn_") || l.id.startsWith("ring_"), ring: l.id.startsWith("ring_"),
  }));
  if (!lanes.length) return;

  // Sanity checks: dangling or discontinuous links.
  const bad: string[] = [];
  usable.forEach((l, i) => {
    if (!lanes[i].next.length) bad.push(`${l.id}(dead end)`);
    for (const n of lanes[i].next) {
      const a = lanes[i].poly, b = lanes[n].poly;
      if (Math.hypot(a.x[a.n - 1] - b.x[0], a.z[a.n - 1] - b.z[0]) > 1.5) bad.push(`${l.id}->${lanes[n].id}(gap)`);
    }
  });
  if (bad.length) console.warn("traffic: suspicious lanes", bad.slice(0, 12).join(", "));

  // Junction conflicts between connector lanes.
  const turnIdx = lanes.flatMap((l, i) => (l.turn ? [i] : []));
  const conflicts: number[][] = lanes.map(() => []);
  const tp = [0, 0, 0, 0];
  // footprint of a connector: its own path (core) plus the last 6 m of feeding lanes and first 6 m of exit lanes (ext)
  const foot = new Map<number, { core: number[]; ext: number[] }>();
  const addPts = (arr: number[], L: Lane, from: number, to: number): void => {
    for (let s = Math.max(0, from); s <= Math.min(L.poly.len, to); s += 0.75) { sample(L.poly, s, 0, tp); arr.push(tp[0], tp[1]); }
  };
  for (const a of turnIdx) {
    const f = { core: [] as number[], ext: [] as number[] };
    addPts(f.core, lanes[a], 0, lanes[a].poly.len);
    const feeders = (t: number): number[] => lanes.flatMap((L, i) => (L.next.includes(t) ? [i] : []));
    const tail = (i: number, depth: number): void => {
      const L = lanes[i];
      if (!L.turn) addPts(f.ext, L, L.poly.len - 6, L.poly.len);
      if ((L.turn || L.poly.len < 6) && depth < 2) for (const q of feeders(i)) tail(q, depth + 1);
    };
    for (const q of feeders(a)) tail(q, 0);
    const head = (i: number, depth: number): void => {
      const L = lanes[i];
      if (!L.turn) addPts(f.ext, L, 0, 6);
      if ((L.turn || L.poly.len < 6) && depth < 2) for (const n of L.next) head(n, depth + 1);
    };
    for (const n of lanes[a].next) head(n, 0);
    foot.set(a, f);
  }
  const near = (p: number[], q: number[], r: number): boolean => {
    for (let i = 0; i < p.length; i += 2) for (let j = 0; j < q.length; j += 2) if (Math.hypot(p[i] - q[j], p[i + 1] - q[j + 1]) < r) return true;
    return false;
  };
  for (const a of turnIdx) {
    conflicts[a].push(a);
    for (const b of turnIdx) {
      if (a >= b) continue;
      const A = foot.get(a)!, B = foot.get(b)!;
      if (near(A.core, B.core, 5) || near(A.ext, B.core, 3.6) || near(B.ext, A.core, 3.6)) { conflicts[a].push(b); conflicts[b].push(a); }
    }
  }
  const claim = new Int16Array(lanes.length).fill(-1);

  // Models.
  const templates: { obj: THREE.Object3D; halfL: number; halfW: number }[] = [];
  await Promise.all(MODELS.map(async (m) => {
    try {
      const gltf = await loadGLB(`/models/v2/props/${m}.glb`);
      prepareModel(gltf.scene);
      // Cars keep their PBR materials (coated paint, glossy glass): toon shading flattens them into clay.
      gltf.scene.traverse((o) => {
        if (!(o instanceof THREE.Mesh)) return;
        o.castShadow = true; o.receiveShadow = true;
        for (const mat of Array.isArray(o.material) ? o.material : [o.material]) {
          if (mat instanceof THREE.MeshStandardMaterial) { mat.envMap = scene.environment; mat.envMapIntensity = CAR_REFLECT; }
          if (mat instanceof THREE.MeshPhysicalMaterial) mat.clearcoat = Math.min(mat.clearcoat, CAR_COAT);
        }
      });
      const b = new THREE.Box3().setFromObject(gltf.scene);
      templates.push({ obj: gltf.scene, halfL: (b.max.z - b.min.z) / 2, halfW: (b.max.x - b.min.x) / 2 });
    } catch { /* model missing */ }
  }));
  if (!templates.length) return;

  const tmp = [0, 0, 0, 0], tmp2 = [0, 0, 0, 0];
  const pl = player.body;
  const cars: Car[] = [];

  // roads.json "parking" entries are the town's static parked cars, so bays are free only as pull-overs:
  // on each long lane a car eases 1.2 m toward the curb, waits, then eases back out (forward both ways).
  const spots: Spot[] = [];
  const planSpots = (): void => {
    lanes.forEach((L, li) => {
      if (L.turn || L.ring || L.poly.len < 26) return;
      const sA = Math.min(4, L.poly.len * 0.15) + Math.random() * (L.poly.len - 24), sP = sA + 10, sB = sP + 10;
      const inP = mkPoly(20), outP = mkPoly(20);
      sample(L.poly, sA, 0, tmp); sample(L.poly, sP, 0, tmp2);
      const px = tmp2[0] - tmp2[3] * 1.2, pz = tmp2[1] + tmp2[2] * 1.2;
      bezier(inP, tmp[0], tmp[1], tmp[2], tmp[3], px, pz, tmp2[2], tmp2[3]);
      sample(L.poly, sB, 0, tmp);
      bezier(outP, px, pz, tmp2[2], tmp2[3], tmp[0], tmp[1], tmp[2], tmp[3]);
      spots.push({ x: px, z: pz, hx: tmp2[2], hz: tmp2[3], lane: li, sA, sB, inP, outP, reverseOut: false, busy: false });
    });
  };
  const bays = (): void => { // free nose-in bays from roads.json (perpendicular: reverse out; parallel: pull through)
    for (const sp of json.parking ?? []) {
      let fx = sp.dx ?? 0, fz = sp.dz ?? -1;
      const fl = Math.hypot(fx, fz) || 1; fx /= fl; fz /= fl;
      let best = -1, bestS = 0, bestD = 13;
      lanes.forEach((L, li) => {
        if (L.turn || L.ring || L.poly.len < 14) return;
        for (let t = 0; t <= L.poly.len; t += 1) {
          sample(L.poly, t, 0, tmp);
          const d = Math.hypot(sp.x - tmp[0], sp.z - tmp[1]);
          const side = (sp.x - tmp[0]) * -tmp[3] + (sp.z - tmp[1]) * tmp[2];
          if (d < bestD && side > 0) { best = li; bestS = t; bestD = d; }
        }
      });
      if (best < 0) continue;
      const L = lanes[best];
      sample(L.poly, bestS, 0, tmp);
      let hx = fx, hz = fz, dot = hx * tmp[2] + hz * tmp[3];
      if (dot < 0) { hx = -hx; hz = -hz; dot = -dot; }
      const rev = dot < 0.6;
      if (rev && (sp.x - tmp[0]) * hx + (sp.z - tmp[1]) * hz < 0) { hx = -hx; hz = -hz; }
      const sA = Math.max(0.5, bestS - (rev ? 7 : 9)), sB = Math.min(L.poly.len - 0.5, bestS + 9);
      const inP = mkPoly(20), outP = mkPoly(20);
      sample(L.poly, sA, 0, tmp); sample(L.poly, sB, 0, tmp2);
      bezier(inP, tmp[0], tmp[1], tmp[2], tmp[3], sp.x, sp.z, hx, hz);
      if (!rev) bezier(outP, sp.x, sp.z, hx, hz, tmp2[0], tmp2[1], tmp2[2], tmp2[3]);
      spots.unshift({ x: sp.x, z: sp.z, hx, hz, lane: best, sA, sB, inP, outP, reverseOut: rev, busy: false });
    }
  };
  planSpots();
  bays();
  const v3 = new THREE.Vector3();
  const staticCars: { x: number; z: number }[] = [];
  const scanStatic = (): void => {
    staticCars.length = 0;
    scene.traverse((o) => {
      if (o.name.startsWith("PROP_") && /sedan|pickup|car_/.test(o.name)) { o.getWorldPosition(v3); staticCars.push({ x: v3.x, z: v3.z }); }
    });
  };
  setTimeout(scanStatic, 4000);
  const blockedSpot = (sp: Spot): boolean => staticCars.some((q) => Math.hypot(q.x - sp.x, q.z - sp.z) < 2.5);


  const sampleAhead = (c: Car, d: number, out: number[]): void => {
    const rem = c.dir > 0 ? c.poly.len - c.s : c.s;
    if (d > rem && c.dir > 0 && c.next >= 0) sample(lanes[c.next].poly, d - rem, 0, out);
    else sample(c.poly, c.s + c.dir * d, c.seg, out);
  };

  const pickNext = (c: Car): void => {
    const L = lanes[c.lane];
    c.next = L.next.length ? L.next[Math.floor(Math.random() * L.next.length)] : -1;
  };

  const enterLane = (c: Car, li: number, s: number): void => {
    const L = lanes[li];
    c.mode = DRIVE; c.dir = 1; c.lane = li; c.poly = L.poly; c.s = s; c.seg = 0; c.spot = -1; c.wantSpot = -1;
    pickNext(c);
    if (L.ring) c.despawn = Math.random() > RING_UTURN;
    if (!L.turn && !L.ring && cars.reduce((n, o) => n + (o.mode === PARK_IN || o.mode === PARKED || o.mode === LEAVE ? 1 : 0), 0) < MAX_PARKED && (Math.random() < PARK_CHANCE || spots.some((sp) => sp.lane === li && sp.reverseOut && !sp.busy))) {
      const free = spots.flatMap((sp, i) => (!sp.busy && sp.lane === li && sp.sA > s - 0.6 && !blockedSpot(sp) ? [i] : []));
      if (free.length && free.some((i) => spots[i].reverseOut)) c.wantSpot = free.filter((i) => spots[i].reverseOut)[0];
      else if (free.length) c.wantSpot = free[Math.floor(Math.random() * free.length)];
    }
  };

  /** Kinematic bicycle: the leading axle (front, or rear when reversing) rides the path at s ± wheelbase/2; the other
   *  axle is dragged after it at a fixed wheelbase, so the body always points where it moves and never slides. */
  const place = (c: Car, snap: boolean, dt: number): void => {
    c.seg = sample(c.poly, c.s, c.seg, tmp);
    const half = c.wb / 2;
    sampleAhead(c, half, tmp2); // leading axle and the road's direction there
    if (snap) {
      const back = c.dir > 0 ? -1 : 1;
      c.fx = tmp[0] + tmp[2] * half; c.fz = tmp[1] + tmp[3] * half;
      c.rx = tmp[0] - tmp[2] * half; c.rz = tmp[1] - tmp[3] * half;
      if (back > 0) { c.rx = tmp2[0]; c.rz = tmp2[1]; } else { c.fx = tmp2[0]; c.fz = tmp2[1]; }
    } else if (c.dir > 0) {
      c.fx = tmp2[0]; c.fz = tmp2[1];
      const dx = c.fx - c.rx, dz = c.fz - c.rz, d = Math.hypot(dx, dz) || 1;
      c.rx = c.fx - (dx / d) * c.wb; c.rz = c.fz - (dz / d) * c.wb;
    } else {
      c.rx = tmp2[0]; c.rz = tmp2[1];
      const dx = c.fx - c.rx, dz = c.fz - c.rz, d = Math.hypot(dx, dz) || 1;
      c.fx = c.rx + (dx / d) * c.wb; c.fz = c.rz + (dz / d) * c.wb;
    }
    const hl = Math.hypot(c.fx - c.rx, c.fz - c.rz) || 1;
    c.hx = (c.fx - c.rx) / hl; c.hz = (c.fz - c.rz) / hl;
    c.yaw = Math.atan2(c.hx, c.hz);
    c.x = (c.fx + c.rx) / 2 - c.hx * c.mid; c.z = (c.fz + c.rz) / 2 - c.hz * c.mid;
    c.obj.position.set(c.x, ROAD_Y, c.z);
    c.obj.rotation.y = c.yaw;
    // Front wheels turn toward the road's direction at the front axle.
    const want = c.dir > 0 ? Math.atan2(Math.sin(Math.atan2(tmp2[2], tmp2[3]) - c.yaw), Math.cos(Math.atan2(tmp2[2], tmp2[3]) - c.yaw)) : 0;
    const k = snap ? 1 : Math.min(1, dt * 8);
    c.steer += (Math.max(-MAX_STEER, Math.min(MAX_STEER, want)) - c.steer) * k;
    for (const s of c.steers) s.rotation.y = c.steer;
    // The body dips under braking and leans out of turns (small, smoothed).
    if (c.body && dt > 0) {
      const accel = (c.v - c.pv) / dt;
      const pitch = Math.max(-MAX_TILT, Math.min(MAX_TILT, -accel * PITCH_PER_ACCEL));
      const roll = Math.max(-MAX_TILT, Math.min(MAX_TILT, c.v * c.v * (c.steer / c.wb) * ROLL_PER_LATERAL));
      c.pitch += (pitch - c.pitch) * Math.min(1, dt * 4); c.roll += (roll - c.roll) * Math.min(1, dt * 4);
      c.body.rotation.set(c.pitch, 0, c.roll);
    }
    c.pv = c.v;
  };

  const hide = (c: Car, delay: number): void => {
    if (c.claim >= 0 && claim[c.claim] === cars.indexOf(c)) claim[c.claim] = -1;
    c.claim = -1;
    if (c.spot >= 0) spots[c.spot].busy = false;
    c.spot = -1; c.wantSpot = -1;
    c.mode = HIDDEN; c.timer = delay; c.v = 0; c.obj.visible = false;
  };

  const clearAround = (x: number, z: number, r: number, self: Car): boolean => {
    for (const o of cars) if (o !== self && o.mode !== HIDDEN && Math.hypot(o.x - x, o.z - z) < r) return false;
    return true;
  };

  const trySpawn = (c: Car, initial: boolean): boolean => {
    for (let k = 0; k < 20; k++) {
      const li = Math.floor(Math.random() * lanes.length), L = lanes[li];
      if (L.turn || L.ring || L.poly.len < 8) continue;
      const s = initial ? Math.random() * L.poly.len * 0.8 : Math.random() * 3;
      sample(L.poly, s, 0, tmp);
      if (!clearAround(tmp[0], tmp[1], MIN_SPAWN_GAP, c)) continue;
      if (!initial && Math.hypot(tmp[0] - pl.x, tmp[1] - pl.z) < MIN_SPAWN_PLAYER) continue;
      c.obj.visible = true; c.v = initial ? L.speed * 0.6 : 0; c.claim = -1;
      enterLane(c, li, s);
      c.seg = 0; c.yaw = Math.atan2(tmp[2], tmp[3]); c.x = tmp[0]; c.z = tmp[1];
      place(c, true, 0);
      return true;
    }
    return false;
  };

  for (let i = 0; i < POOL; i++) {
    const t = templates[i % templates.length];
    const obj = t.obj.clone(true);
    const car: Car = {
      obj, ...rigOf(obj), halfL: t.halfL, halfW: t.halfW, fx: 0, fz: 0, rx: 0, rz: 0, steer: 0, pv: 0, pitch: 0, roll: 0,
      mode: HIDDEN, poly: lanes[0].poly, seg: 0, s: 0, dir: 1, v: 0,
      lane: 0, next: -1, claim: -1, spot: -1, wantSpot: -1, timer: i * 1.5, stuck: 0, x: 0, z: 0, yaw: 0, hx: 0, hz: 1, spin: 0, despawn: false,
    };
    obj.visible = false;
    scene.add(obj);
    cars.push(car);
    trySpawn(car, true);
  }
  Object.assign(window, { __traffic: cars, __trafficSpots: spots }); // playtest handles

  setTimeout(() => { // lanes through buildings (town.glb loads async)
    const inside: string[] = [];
    lanes.forEach((L) => {
      for (let s = 0; s <= L.poly.len; s += 2) {
        sample(L.poly, s, 0, tmp);
        if (colliders.some((b) => b.maxY - b.minY > 0.8 && b.minY < 1 && tmp[0] > b.minX - 0.8 && tmp[0] < b.maxX + 0.8 && tmp[1] > b.minZ - 0.8 && tmp[1] < b.maxZ + 0.8)) { inside.push(L.id); break; }
      }
    });
    if (inside.length) console.warn("traffic: lanes inside colliders", inside.slice(0, 12).join(", "));
  }, 6000);

  const junctionBlocked = (ni: number, ci: number): boolean => {
    for (const m of conflicts[ni]) if (claim[m] >= 0 && claim[m] !== ci) return true;
    return false;
  };

  const update = (c: Car, ci: number, dt: number): void => {
    if (c.mode === HIDDEN) {
      c.timer -= dt;
      if (c.timer <= 0 && !trySpawn(c, false)) c.timer = 2;
      return;
    }
    if (c.mode === PARKED) {
      c.timer -= dt;
      if (c.timer <= 0) {
        const sp = spots[c.spot];
        const a = sp.reverseOut ? sp.inP : sp.outP;
        const ex = sp.reverseOut ? sp.inP.x[0] : a.x[a.n - 1], ez = sp.reverseOut ? sp.inP.z[0] : a.z[a.n - 1];
        if (clearAround(ex, ez, 14, c) && !cars.some((o) => o !== c && o.mode === DRIVE && o.lane === sp.lane && o.s > sp.sA - 35 && o.s < sp.sB + 6) && Math.hypot(pl.x - sp.x, pl.z - sp.z) > 2.5) {
          c.mode = LEAVE; c.dir = sp.reverseOut ? -1 : 1;
          c.poly = sp.reverseOut ? sp.inP : sp.outP; c.s = sp.reverseOut ? c.poly.len : 0; c.seg = 0;
        } else c.timer = 1.5;
      }
      return;
    }
    const L = lanes[c.lane];
    let target = c.mode === DRIVE ? (L.turn ? 4 : L.ring ? 4.5 : L.speed) : c.mode === PARK_IN ? 3 : 2.5;
    let blockedByCar = false;

    // look ahead along the route
    for (let k = 0; k < PROBES.length; k++) {
      const d = PROBES[k];
      sampleAhead(c, d, tmp2);
      const px = tmp2[0], pz = tmp2[1];
      let hit = false, byCar = false;
      for (const o of cars) {
        if (o === c || o.mode === HIDDEN) continue;
        const dx = px - o.x, dz = pz - o.z;
        if (dx * dx + dz * dz > 36) continue;
        const lf = dx * o.hx + dz * o.hz, ls = dx * o.hz - dz * o.hx;
        if (Math.abs(lf) < o.halfL + 0.3 && Math.abs(ls) < o.halfW + c.halfW + 0.15) { hit = true; byCar = true; break; }
      }
      if (!hit) {
        for (const q of pedestrians) {
          if (q.hidden) continue;
          const dx = px - q.x, dz = pz - q.z;
          if (dx * dx + dz * dz < 1.69) { hit = true; break; }
        }
        if (!hit && pl.y < 1.6) { const dx = px - pl.x, dz = pz - pl.z; if (dx * dx + dz * dz < 1.96) hit = true; }
      }
      if (hit) {
        target = Math.min(target, Math.sqrt(2 * COMFORT * Math.max(0, (k ? PROBES[k - 1] : 0) - c.halfL - 1)));
        if (byCar) blockedByCar = true;
      }
    }

    // junction right of way: claim the connector when the nose reaches the stop line, else wait there
    const remaining = c.poly.len - c.s, stopAt = c.halfL + (c.next >= 0 && lanes[c.next].ring ? 3 : 1.2);
    let hold = false;
    if (c.mode === DRIVE && c.next >= 0 && lanes[c.next].turn && c.claim !== c.next) {
      if (remaining < 14) target = Math.min(target, 5);
      if (junctionBlocked(c.next, ci)) {
        hold = true;
        target = Math.min(target, Math.sqrt(2 * COMFORT * Math.max(0, remaining - stopAt)));
        if (remaining < stopAt + 1.5) blockedByCar = true;
      } else if (remaining < stopAt + 0.6) {
        if (c.claim >= 0 && claim[c.claim] === ci) claim[c.claim] = -1;
        claim[c.next] = ci; c.claim = c.next;
      }
    }

    c.v += Math.max(-BRAKE * dt, Math.min(ACCEL * dt, target - c.v));
    c.stuck = blockedByCar && c.v < 0.2 ? c.stuck + dt : 0;
    if (c.stuck > 25) { hide(c, 4); return; }
    const sPrev = c.s;
    c.s += c.dir * c.v * dt;
    if (hold && c.s > c.poly.len - stopAt) { c.s = Math.max(sPrev, c.poly.len - stopAt); c.v = 0; }

    // end of path
    if (c.dir > 0 && c.s >= c.poly.len) {
      if (c.mode === PARK_IN) {
        c.s = c.poly.len; c.mode = PARKED; c.v = 0; c.timer = 8 + Math.random() * 10; place(c, true, dt); return;
      }
      if (c.mode === LEAVE) { const sp = spots[c.spot]; sp.busy = false; enterLane(c, sp.lane, sp.sB); }
      else if (c.next < 0) { hide(c, 6); return; }
      else if (lanes[c.next].turn && c.claim !== c.next) { c.s = c.poly.len - 0.02; c.v = 0; }
      else { const carry = c.s - c.poly.len; enterLane(c, c.next, carry); }
    } else if (c.dir < 0 && c.s <= 0) {
      const sp = spots[c.spot];
      const li = sp.lane, s = sp.reverseOut ? sp.sA : sp.sB;
      sp.busy = false;
      enterLane(c, li, s);
    }

    if (c.mode === DRIVE) {
      if (c.despawn && lanes[c.lane].ring && c.s > lanes[c.lane].poly.len * 0.5) { hide(c, 6 + Math.random() * 10); return; }
      if (c.claim >= 0 && c.lane !== c.claim && c.next !== c.claim && c.s > c.halfL + 0.5) { if (claim[c.claim] === ci) claim[c.claim] = -1; c.claim = -1; }
      if (c.wantSpot >= 0 && c.lane === spots[c.wantSpot].lane && c.s >= spots[c.wantSpot].sA) {
        const sp = spots[c.wantSpot];
        if (!sp.busy && c.v < MAX_SPEED + 1) {
          sp.busy = true; c.spot = c.wantSpot; c.wantSpot = -1; c.mode = PARK_IN; c.poly = sp.inP; c.s = 0; c.seg = 0; c.next = -1;
        } else c.wantSpot = -1;
      }
    }

    place(c, false, dt);
    c.spin += (c.dir * c.v * dt) / c.r; // rolling: the tyre's rim covers exactly the distance driven
    for (const w of c.wheels) w.rotation.x = c.spin;
  };

  const pushKavi = (c: Car): void => {
    if (pl.y >= 1.6) return;
    const dx = pl.x - c.x, dz = pl.z - c.z;
    const lf = dx * c.hx + dz * c.hz, ls = dx * c.hz - dz * c.hx;
    const hl = c.halfL + pl.radius, hw = c.halfW + pl.radius;
    if (Math.abs(lf) >= hl || Math.abs(ls) >= hw) return;
    const pf = hl - Math.abs(lf), ps = hw - Math.abs(ls);
    if (ps < pf) { const m = Math.min(ps, 0.3) * (ls >= 0 ? 1 : -1); pl.x += m * c.hz; pl.z -= m * c.hx; }
    else { const m = Math.min(pf, 0.3) * (lf >= 0 ? 1 : -1); pl.x += m * c.hx; pl.z += m * c.hz; }
  };

  onUpdate.push((dt0) => {
    const dt = Math.min(dt0, 0.05);
    for (let i = 0; i < cars.length; i++) update(cars[i], i, dt);
    for (const c of cars) if (c.mode !== HIDDEN) pushKavi(c);
  });
}
