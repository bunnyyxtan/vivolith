// Townsfolk brain: each folk picks an activity (sit, queue at a stall, chat, wait, carry a crate, browse a shop)
// from SPOT_<kind>__<id> empties of town.glb (fallback spots when absent), walks there on an A* path,
// does it for a while, then picks the next. Also: capsule push between Kavi and everyone, NPC separation,
// stagger + speech bubble when bumped.
// Faked: shop "entering" (they vanish at the door), NPC purchases are visual only (no economy demand hook).
import * as THREE from "three";
import { STEP_HEIGHT, groundHeightAt, pushOut, type Body, type Box } from "../physics/collision";
import type { FloorHeight } from "./floor";
import type { AnimatedCharacter } from "../character";
import { NPC_STEP, createNav, type Nav } from "./nav";
import { createBubbles, installPose, type PoseState } from "./npcfx";

type Kind = "bench" | "shopdoor" | "stallq" | "chat" | "wait" | "crate" | "cafe" | "photo" | "jog";
const KINDS: readonly Kind[] = ["bench", "shopdoor", "stallq", "chat", "wait", "crate", "cafe", "photo", "jog"];
const WEIGHT: Record<Kind, number> = { bench: 2, shopdoor: 2, stallq: 3, chat: 3, wait: 1, crate: 1.5, cafe: 2, photo: 1.2, jog: 0.5 };
/** What people do on a trip to the N Spire district (gardens, square, lobby). */
const SPIRE_KINDS: readonly Kind[] = ["bench", "shopdoor", "chat", "wait", "photo", "cafe", "stallq", "jog"];
const JOG_SPEED = 3.0;

/** Anything cars must stop for. */
export interface Pedestrian { x: number; z: number; hidden: boolean }
export const pedestrians: Pedestrian[] = [];

export interface MerchantRef {
  readonly id?: string;
  readonly root: THREE.Group;
  readonly post: { npc: THREE.Vector3; stall: THREE.Vector3 };
  readonly character: AnimatedCharacter;
  readonly head: THREE.Vector3;
  attend: THREE.Vector3 | null;
  serving: boolean;
}
export interface FolkChar { c: AnimatedCharacter; root: THREE.Group }

interface Spot {
  kind: Kind; x: number; z: number; yaw: number; cap: number; users: number;
  name: string; deep: boolean; mer: MerchantRef | null; next: Spot | null;
  slots: (Ent | null)[]; t: number; turn: number; has: boolean; crate: THREE.Object3D | null;
}
interface Ent extends Pedestrian {
  c: AnimatedCharacter; root: THREE.Group; pose: PoseState; y: number; yaw: number;
  r: number; fixed: boolean; cd: number; svx: number; svz: number; stag: number; head: THREE.Vector3;
  // folk only
  state: "idle" | "walk" | "act" | "stag"; spot: Spot | null; slot: number; path: number[]; pi: number;
  speed: number; spd: number; t: number; phase: number; last: Kind | null; carrying: boolean;
  stuckT: number; sx: number; sz: number; carry: THREE.Object3D | null; mer: MerchantRef | null;
  hx: number; hz: number; hy: number; // merchant home
  by: number; // last ground height outside seat colliders
  jogLeft: number; // waypoints left on a jogging lap (0 = not jogging)
  baseSpeed: number;
}

const WALK = 1.3, PLAYER_R = 0.32, HEAD = 1.85;
const BUMP_LINES = ["Whoa!", "Hey, watch out!", "Careful!", "Easy there!", "Oof!", "Hey!"];
const CHAT_LINES = ["Mangoes are cheap today.", "Rent night again.", "Did you see the Spire?", "Prices keep moving.", "Tomas won't budge.", "Lovely weather."];
const rnd = (a: number, b: number): number => a + Math.random() * (b - a);
const wrap = (d: number): number => Math.atan2(Math.sin(d), Math.cos(d));

export interface Life {
  /** Player body (pushed on contact) and the camera used to place speech bubbles. */
  bind(body: Body, camera: THREE.Camera): void;
  update(dt: number): void;
  /** 0..2 shopper pull per merchant id (pricing.ts stallPull): 0 = nobody queues (closed or sold out). */
  setPull(id: string, pull: number): void;
}

export function createLife(scene: THREE.Scene, colliders: Box[], town: THREE.Object3D | null, mers: readonly MerchantRef[], folkChars: readonly FolkChar[], floor: FloorHeight = (_x, _z, g) => g): Life {
  const nav: Nav = createNav(colliders);
  const bubbles = createBubbles();
  const spots: Spot[] = [];
  const mk = (kind: Kind, x: number, z: number, yaw: number, cap = 1, name = "", deep = false): Spot => {
    const s: Spot = { kind, x, z, yaw, cap, users: 0, name, deep, mer: null, next: null, slots: [null, null], t: 0, turn: 0, has: false, crate: null };
    spots.push(s);
    return s;
  };

  // ---- spots: town empties first, fallbacks for kinds the town does not provide yet
  const have = new Set<Kind>();
  if (town) {
    town.updateMatrixWorld(true);
    const p = new THREE.Vector3(), d = new THREE.Vector3();
    town.traverse((o) => {
      const m = /^SPOT_([a-z]+)/i.exec(o.name);
      const kind = m && (m[1].toLowerCase() as Kind);
      if (!kind || !KINDS.includes(kind)) return;
      o.getWorldPosition(p);
      o.getWorldDirection(d); // town empties' +Z points away from where the person looks (checked against stallq/merchant), so flipped
      mk(kind, p.x, p.z, Math.atan2(-d.x, -d.z), kind === "chat" || kind === "bench" ? 2 : kind === "jog" ? 99 : 1, o.name);
      have.add(kind);
    });
  }
  const fb = (kind: Kind, list: number[][], cap = 1): void => {
    if (!have.has(kind)) for (const [x, z, yaw] of list) mk(kind, x, z, yaw, cap);
  };
  const L = Math.PI / 2;
  fb("bench", [[8.2, 50, -L], [-8.2, 50, L], [8.2, 64, -L], [-8.2, 64, L], [8.2, 78, -L], [-8.2, 78, L]]);
  fb("shopdoor", [[9.3, 22, L], [-9.3, 22, -L], [9.3, 42, L], [-9.3, 42, -L], [9.3, 58, L], [-9.3, 58, -L]]);
  fb("chat", [[0, 40, 0], [0, 58, 0], [3, 84, 0], [-3, 70, 0]], 2);
  fb("wait", [[-8, 92, 0], [8, 92, 0]]);
  fb("crate", [[9.5, 33, 0], [-9.5, 33, 0], [9.5, 52, 0], [-9.5, 52, 0]]);
  // stall queues: one per merchant, two places beside the stall point (leaving it free for Kavi)
  for (const q of spots) { // real stallq empties: nearest merchant serves; *_b queues behind *_a
    if (q.kind !== "stallq") continue;
    let bd = 7;
    for (const m of mers) { const d = Math.hypot(m.root.position.x - q.x, m.root.position.z - q.z); if (d < bd) { bd = d; q.mer = m; } }
    if (/_b$/.test(q.name)) q.next = spots.find((o) => o.name === q.name.replace(/_b$/, "_a")) ?? null;
  }
  if (!have.has("stallq")) for (const m of mers) {
    const st = m.post.stall, np = m.post.npc;
    const ax = st.x - np.x, az = st.z - np.z, len = Math.hypot(ax, az) || 1;
    const fx = ax / len, fz = az / len; // merchant -> customer side
    const px = -fz, pz = fx; // sideways
    const yaw = Math.atan2(-fx, -fz); // face the merchant
    const q0 = mk("stallq", st.x + px * 1.0 + fx * 0.3, st.z + pz * 1.0 + fz * 0.3, yaw);
    const q1 = mk("stallq", q0.x + fx * 0.9, q0.z + fz * 0.9, yaw);
    q0.mer = q1.mer = m; q1.next = q0;
  }
  // N Spire plaza (z < 0): lobby doors up the golden steps, promenade benches, strolling/looking-around points on the lawns
  mk("shopdoor", -3, -49.2, Math.PI, 1, "spire_l", true); mk("shopdoor", 0, -49.2, Math.PI, 1, "spire_c", true); mk("shopdoor", 3, -49.2, Math.PI, 1, "spire_r", true);
  for (const z of [-7.5, -16.5, -23, -31.5, -40.5]) { mk("bench", 6.9, z, -L, 1, "spire_bench"); mk("bench", -6.9, z, L, 1, "spire_bench"); }
  for (const [x, z, y] of [[-2.5, -20, 0], [2.5, -32, 0], [0, -44, 0], [-4, -8, 0]]) mk("chat", x, z, y, 2, "spire_chat");
  for (const [x, z, y] of [[-20, -18, 1], [20, -24, -1], [-26, -58, 0.5], [26, -62, -0.5], [-18, -40, 1.2], [18, -40, -1.2]]) mk("wait", x, z, y, 1, "spire_look");
  // snap open-ground spots onto walkable cells (seat/door/crate spots may sit inside colliders on purpose)
  const cell = { x: 0, z: 0 };
  for (const s of spots) {
    if ((s.kind === "chat" || s.kind === "wait" || s.kind === "stallq") && nav.nearestFree(s.x, s.z, cell)) { s.x = cell.x; s.z = cell.z; }
  }
  // crates on half the crate spots
  const crateGeo = new THREE.BoxGeometry(0.55, 0.36, 0.42);
  const crateMat = new THREE.MeshToonMaterial({ color: "#b9854a" });
  const makeCrate = (): THREE.Mesh => { const m = new THREE.Mesh(crateGeo, crateMat); m.castShadow = true; return m; };
  const crateSpots = spots.filter((s) => s.kind === "crate");
  crateSpots.forEach((s, i) => {
    s.crate = makeCrate();
    s.crate.position.set(s.x, groundHeightAt(colliders, s.x, s.z, 0) + 0.18, s.z);
    s.has = i % 2 === 0;
    s.crate.visible = s.has;
    scene.add(s.crate);
  });

  // ---- entities
  const mkEnt = (c: AnimatedCharacter, root: THREE.Group, fixed: boolean): Ent => ({
    c, root, pose: installPose(c), x: root.position.x, z: root.position.z, y: root.position.y, yaw: root.rotation.y, hidden: false,
    r: 0.33, fixed, cd: 0, svx: 0, svz: 0, stag: 0, head: new THREE.Vector3(),
    state: "idle", spot: null, slot: 0, path: [], pi: 0, speed: rnd(1.0, 1.5), spd: 0, t: 0, phase: 0, last: null, carrying: false,
    stuckT: 0, sx: 0, sz: 0, carry: null, mer: null, hx: root.position.x, hz: root.position.z, hy: root.position.y, by: root.position.y, jogLeft: 0, baseSpeed: 1.2,
  });
  const merEnts = mers.map((m) => { const e = mkEnt(m.character, m.root, true); e.mer = m; return e; });
  const folk = folkChars.map((f) => {
    const e = mkEnt(f.c, f.root, false);
    e.carry = makeCrate();
    e.carry.position.set(0, 1.0, 0.36);
    e.carry.visible = false;
    f.root.add(e.carry);
    return e;
  });
  const all = [...merEnts, ...folk];
  pedestrians.push(...all);
  (window as unknown as { __npcs: Pedestrian[]; __tpose: unknown }).__npcs = pedestrians; // playtest handles
  (window as unknown as { __tpose: unknown }).__tpose = (sim: (sec: number) => void): string[] => tposeReport(scene, sim);

  const spire = spots.filter((q) => q.name.includes("spire"));
  const jogs = spots.filter((q) => q.kind === "jog").sort((a, b) => a.name.localeCompare(b.name));
  let spawnN = 0;
  const spawn = (e: Ent): void => {
    e.baseSpeed = e.speed;
    const pool = spawnN++ % 2 === 1 ? spire : spots; // half the town starts around the Spire
    const s = pool[Math.floor(Math.random() * pool.length)];
    if (s && nav.nearestFree(s.x + rnd(-2, 2), s.z + rnd(-2, 2), cell)) { e.x = cell.x; e.z = cell.z; }
    e.y = groundHeightAt(colliders, e.x, e.z, 0);
    e.yaw = rnd(-3, 3);
  };
  folk.forEach(spawn);

  // ---- decisions
  const dist = (e: Ent, s: Spot): number => Math.hypot(e.x - s.x, e.z - s.z);
  const pulls = new Map<string, number>();
  const pullOf = (s: Spot): number => (s.mer?.id ? pulls.get(s.mer.id) ?? 1 : 1);
  const claim = (e: Ent, kind: Kind, spireOnly = false): Spot | null => {
    const far = Math.random() < 0.3; // sometimes head across town (park, Spire)
    let best: Spot | null = null, bc = 1e9;
    for (const s of spots) {
      if (s.kind !== kind || s.users >= s.cap || (spireOnly && !s.name.includes("spire"))) continue;
      if (kind === "crate" && (e.carrying ? s.has : !s.has)) continue; // pick up where a crate is, drop where none
      if (kind === "stallq" && s.next === null && s.users >= 1) continue;
      if (kind === "stallq" && pullOf(s) < 0.05) continue; // closed or sold out: shoppers walk past
      let c = (far && kind !== "stallq" ? 0 : dist(e, s)) + rnd(0, 18);
      if (kind === "chat" && s.users === 1) c -= 40; // join a waiting partner
      if (kind === "stallq" && s.next && s.next.users === 0) c += 50; // queue place 1 only behind an occupied place 0
      if (kind === "stallq") c += (1 - pullOf(s)) * 30; // cheap, stocked stalls draw the crowd
      if (c < bc) { bc = c; best = s; }
    }
    return best;
  };
  const goTo = (e: Ent, s: Spot, slot = 0): boolean => {
    let tx = s.x, tz = s.z;
    if (s.kind === "chat" || s.kind === "bench") { // chat: either side, facing; bench: two seats side by side
      const off = s.kind === "chat" ? 0.55 : 0.45;
      tx += Math.cos(s.yaw) * (slot ? off : -off); tz -= Math.sin(s.yaw) * (slot ? off : -off);
    }
    if (!nav.path(e.x, e.z, tx, tz, e.path)) return false;
    e.path.push(tx, tz);
    e.pi = 0; e.sx = e.x; e.sz = e.z; e.stuckT = 0;
    e.state = "walk";
    return true;
  };
  const release = (e: Ent): void => {
    const s = e.spot;
    if (s) {
      s.users = Math.max(0, s.users - 1);
      if (s.slots[e.slot] === e) s.slots[e.slot] = null;
      if (s.kind === "stallq" && s.mer && !s.next) { s.mer.serving = false; s.mer.attend = null; }
    }
    e.spot = null; e.pose.sit = 0; e.pose.phone = 0;
  };
  const decide = (e: Ent): void => {
    e.state = "idle"; e.t = rnd(0.5, 2);
    const spire = Math.random() < 0.4; // routine: a trip to the N Spire district (lobby, gardens, square)
    const opts = spire ? SPIRE_KINDS.filter((k) => k !== e.last) : KINDS.filter((k) => k !== e.last && k !== "jog");
    let total = 0;
    const w = opts.map((k) => { const v = e.carrying ? (k === "crate" ? 10 : 0) : WEIGHT[k]; total += v; return v; });
    let r = Math.random() * total;
    for (let i = 0; i < opts.length; i++) {
      r -= w[i];
      if (r > 0 || w[i] === 0) continue;
      const s = claim(e, opts[i], spire);
      if (!s) break;
      s.users++;
      e.spot = s; e.slot = s.kind === "chat" || s.kind === "bench" ? (s.slots[0] ? 1 : 0) : 0; s.slots[e.slot] = e; e.last = opts[i]; e.phase = 0;
      if (goTo(e, s, e.slot)) return;
      release(e);
    }
  };

  const arrive = (e: Ent): void => {
    const s = e.spot;
    if (!s) { e.state = "idle"; return; }
    e.state = "act"; e.phase = 0; e.spd = 0;
    switch (s.kind) {
      case "bench": case "cafe": e.t = rnd(20, 40); break;
      case "shopdoor": e.t = 1.6; break;
      case "wait": e.t = rnd(12, 25); break;
      case "photo": e.t = rnd(5, 9); break;
      case "jog": { // run the garden loop: on to the next waypoint until the lap is done
        if (e.jogLeft === 0) { e.jogLeft = Math.floor(rnd(8, 15)); e.speed = JOG_SPEED; }
        e.jogLeft--;
        const next = jogs[(jogs.indexOf(s) + 1) % jogs.length];
        release(e);
        if (e.jogLeft > 0 && next && goTo(e, next)) { e.spot = next; next.users++; return; }
        e.jogLeft = 0; e.speed = e.baseSpeed; decide(e);
        return;
      }
      case "chat": e.t = 12; s.t = 0; break; // waits for a partner up to 12 s
      case "crate": e.t = 0.9; break;
      case "stallq": e.t = s.next ? 999 : rnd(4, 7); if (!s.next && s.mer) { s.mer.serving = true; s.mer.attend = new THREE.Vector3(e.x, 0, e.z); } break;
    }
  };

  const faceTo = (e: Ent, yaw: number, dt: number, k = 8): void => { e.yaw += wrap(yaw - e.yaw) * (1 - Math.exp(-k * dt)); };

  const actFolk = (e: Ent, dt: number): void => {
    const s = e.spot!;
    e.t -= dt;
    let talk = false, seatTarget = 0, carryTarget = e.carrying ? 1 : 0;
    switch (s.kind) {
      case "bench": case "cafe": {
        seatTarget = 1; faceTo(e, s.yaw, dt);
        const p = s.kind === "bench" ? s.slots[1 - e.slot] : null;
        if (p && p.state === "act" && p.spot === s) { // friends on a bench take turns talking
          if (e.slot === 0) { s.turn -= dt; if (s.turn < 0) { s.turn = rnd(3, 6); e.phase ^= 1; p.phase = e.phase ^ 1; } }
          talk = e.phase === 1;
          if (talk && Math.random() < dt * 0.06) bubbles.say(e.head, CHAT_LINES[Math.floor(Math.random() * CHAT_LINES.length)], 2.4);
        }
        break;
      }
      case "wait": case "shopdoor": case "crate":
        faceTo(e, s.yaw, dt);
        break;
      case "photo": // phone up toward the sculpture or the Spire
        faceTo(e, s.yaw, dt);
        e.pose.phone += (1 - e.pose.phone) * (1 - Math.exp(-5 * dt));
        break;
      case "stallq":
        faceTo(e, s.yaw, dt);
        if (s.next && s.next.users === 0 && e.t > 5) { // front place free: step up
          s.users--; s.slots[e.slot] = null; s.next.users++; s.next.slots[0] = e; e.spot = s.next; e.slot = 0;
          if (!goTo(e, s.next)) { release(e); decide(e); }
          return;
        }
        talk = !s.next && e.t < 5;
        break;
      case "chat": {
        const p = s.slots[1 - e.slot];
        if (p && p.state === "act" && p.spot === s) {
          if (s.t === 0) { s.t = rnd(14, 26); e.t = 999; }
          const toX = p.x - e.x, toZ = p.z - e.z;
          faceTo(e, Math.atan2(toX, toZ), dt);
          if (e.slot === 0) { s.turn -= dt; if (s.turn < 0) { s.turn = rnd(3, 5); s.slots[0]!.phase ^= 1; s.slots[1]!.phase = s.slots[0]!.phase ^ 1; } }
          talk = e.phase === 0 ? e.slot === 0 : e.slot === 1;
          if (e.slot === 0) { s.t -= dt; if (s.t <= 0.001) { s.t = 0.001; e.t = 0; p.t = 0; } }
          if (e.slot === 0 && Math.random() < dt * 0.15 && talk) bubbles.say(e.head, CHAT_LINES[Math.floor(Math.random() * CHAT_LINES.length)], 2.4);
        } else if (s.t > 0) e.t = 0; // partner left
        break;
      }
    }
    // crate carry transitions
    if (s.kind === "crate" && e.t <= 0 && e.phase === 0) {
      e.phase = 1;
      if (e.carrying) { e.carrying = false; s.has = true; if (s.crate) { s.crate.visible = true; } if (e.carry) e.carry.visible = false; }
      else { e.carrying = true; s.has = false; if (s.crate) s.crate.visible = false; if (e.carry) e.carry.visible = true; }
      carryTarget = e.carrying ? 1 : 0;
    }
    if (s.kind === "shopdoor") {
      if (e.phase === 0 && e.t <= 0) { e.phase = 1; e.t = s.deep ? 3.5 : 0.9; }
      else if (e.phase === 1) { // step into the doorway then vanish
        e.spd = s.deep ? 1.3 : 0.9; e.x += Math.sin(s.yaw) * e.spd * dt; e.z += Math.cos(s.yaw) * e.spd * dt;
        if (e.t <= 0) { e.phase = 2; e.t = rnd(6, 12); e.hidden = true; e.root.visible = false; }
      } else if (e.phase === 2 && e.t <= 0) { e.hidden = false; e.root.visible = true; e.x = s.x; e.z = s.z; e.yaw = s.yaw + Math.PI; e.phase = 3; e.t = 0; }
    }
    e.pose.sit += (seatTarget - e.pose.sit) * (1 - Math.exp(-6 * dt));
    e.c.lift = e.pose.sit * 0.37;
    e.pose.carry += (carryTarget - e.pose.carry) * (1 - Math.exp(-6 * dt));
    e.c.setAction(talk ? "Talking" : null);
    const done = s.kind === "crate" ? e.phase === 1 && e.t <= -0.6 : e.t <= 0 && (s.kind !== "shopdoor" || e.phase === 3);
    if (done) { release(e); decide(e); }
  };

  const walkFolk = (e: Ent, dt: number): void => {
    const tx = e.path[e.pi], tz = e.path[e.pi + 1];
    const last = e.pi + 2 >= e.path.length;
    const dx = tx - e.x, dz = tz - e.z, d = Math.hypot(dx, dz);
    if (d < (last ? 0.12 : 0.4)) {
      e.pi += 2;
      if (e.pi >= e.path.length) { arrive(e); return; }
      return;
    }
    const want = Math.atan2(dx, dz), diff = wrap(want - e.yaw);
    e.yaw += diff * (1 - Math.exp(-9 * dt));
    const target = Math.abs(diff) > 1.2 ? 0.2 : Math.min(e.speed * (e.carrying ? 0.8 : 1), d * 3 + 0.3);
    e.spd += (target - e.spd) * (1 - Math.exp(-6 * dt));
    e.x += Math.sin(e.yaw) * e.spd * dt; e.z += Math.cos(e.yaw) * e.spd * dt;
    if (!last) { // the final leg may end inside a seat or doorway collider
      body.x = e.x; body.z = e.z; body.y = e.y; pushOut(colliders, body);
      e.x = body.x; e.z = body.z;
    }
    e.stuckT += dt;
    if (e.stuckT > 3) { // no progress in 3 s: re-plan once, else give up this plan
      if (Math.hypot(e.x - e.sx, e.z - e.sz) < 0.5) {
        const s = e.spot;
        if (s && e.phase++ < 2 && goTo(e, s, e.slot)) return;
        release(e); decide(e);
      }
      e.sx = e.x; e.sz = e.z; e.stuckT = 0;
    }
  };

  const body: Body = { x: 0, y: 0, z: 0, vy: 0, radius: 0.3, height: 1.7, grounded: true };
  let pb: Body | null = null, cam: THREE.Camera | null = null;
  let lpx = 0, lpz = 0;

  const bump = (e: Ent, nx: number, nz: number, speed: number): void => {
    e.cd = 3;
    const k = e.fixed ? 1.2 : 2.4;
    e.svx = nx * k; e.svz = nz * k; e.stag = 0.6;
    if (!e.fixed && e.state !== "act") e.state = "stag";
    if (Math.random() < 0.9) bubbles.say(e.head, BUMP_LINES[Math.floor(Math.random() * BUMP_LINES.length)], 1.6);
    void speed;
  };

  const place = (e: Ent): void => {
    const seated = (e.spot?.kind === "bench" || e.spot?.kind === "cafe") && (e.state === "act" || (e.state === "walk" && e.pi + 2 >= e.path.length)); // seat colliders must not lift the sitter
    // groundHeightAt allows STEP_HEIGHT above feetY: offset so townsfolk climb at most NPC_STEP (curbs, stairs).
    e.y = e.fixed ? e.hy : seated ? e.by : groundHeightAt(colliders, e.x, e.z, e.y + NPC_STEP - STEP_HEIGHT);
    if (!seated) e.by = e.y;
    const vy = e.fixed ? e.y : floor(e.x, e.z, e.y); // stand (or sit) on the visible pavement, not the flat collision ground
    e.root.position.set(e.x, vy, e.z);
    e.root.rotation.y = e.yaw;
    e.c.root.position.z = seated && e.state === "act" ? -0.1 : 0; // hips slightly back on the seat
    e.pose.yaw = e.yaw;
    e.head.set(e.x, vy + HEAD - e.c.lift, e.z);
  };

  return {
    setPull(id, pull) { pulls.set(id, pull); },
    bind(b, c) { pb = b; cam = c; lpx = b.x; lpz = b.z; },
    update(dt) {
      dt = Math.min(dt, 0.1);
      // merchants: stagger offsets spring back
      for (const m of merEnts) {
        m.cd -= dt;
        m.stag -= dt;
        m.svx *= Math.exp(-5 * dt); m.svz *= Math.exp(-5 * dt);
        m.x += m.svx * dt; m.z += m.svz * dt;
        m.x += (m.hx - m.x) * (1 - Math.exp(-4 * dt)); m.z += (m.hz - m.z) * (1 - Math.exp(-4 * dt));
        m.yaw = m.root.rotation.y; // market.ts owns merchant facing
        m.pose.lean = Math.max(0, m.stag / 0.6);
        place(m);
      }
      for (const e of folk) {
        e.cd -= dt;
        if (e.stag > 0) {
          e.stag -= dt;
          e.x += e.svx * dt; e.z += e.svz * dt;
          e.svx *= Math.exp(-4 * dt); e.svz *= Math.exp(-4 * dt);
          e.spd = 0;
          if (e.state === "stag" && e.stag <= 0) { if (e.spot && goTo(e, e.spot, e.slot)) { /* resumes */ } else decide(e); }
        } else if (e.state === "idle") {
          e.t -= dt; e.spd *= Math.exp(-8 * dt);
          if (e.t <= 0) decide(e);
        } else if (e.state === "walk") walkFolk(e, dt);
        else if (e.state === "act") actFolk(e, dt);
        e.pose.lean = Math.max(0, e.stag / 0.6);
        if (e.state === "walk" || e.state === "stag" || (e.state === "act" && e.spd > 0.05)) {
          if (e.state !== "act") { body.x = e.x; body.z = e.z; body.y = e.y; if (e.state === "stag") pushOut(colliders, body); e.x = body.x; e.z = body.z; }
        }
        if (e.state === "idle") e.c.lift = 0;
        e.c.setSpeed(e.spd, WALK, WALK * 2);
        e.c.update(dt);
        place(e);
      }
      // separation between walking folk
      for (let i = 0; i < folk.length; i++) {
        const a = folk[i];
        if (a.hidden || a.state === "act") continue;
        for (let j = i + 1; j < folk.length; j++) {
          const b = folk[j];
          if (b.hidden || b.state === "act") continue;
          const dx = b.x - a.x, dz = b.z - a.z, d2 = dx * dx + dz * dz, R = a.r + b.r;
          if (d2 >= R * R || d2 < 1e-8) continue;
          const d = Math.sqrt(d2), p = (R - d) * 0.5;
          a.x -= (dx / d) * p; a.z -= (dz / d) * p; b.x += (dx / d) * p; b.z += (dz / d) * p;
        }
      }
      // player contact
      if (pb) {
        const sp = Math.hypot(pb.x - lpx, pb.z - lpz) / Math.max(dt, 1e-3);
        lpx = pb.x; lpz = pb.z;
        for (const e of all) {
          if (e.hidden) continue;
          const dx = e.x - pb.x, dz = e.z - pb.z, R = e.r + PLAYER_R, d2 = dx * dx + dz * dz;
          if (d2 >= R * R) continue;
          const d = Math.sqrt(d2) || 1e-3, nx = dx / d, nz = dz / d, pen = R - d;
          const immovable = e.fixed || (e.state === "act" && e.spot?.kind !== "chat");
          const share = immovable ? 0 : 0.6;
          e.x += nx * pen * share; e.z += nz * pen * share;
          pb.x -= nx * pen * (1 - share); pb.z -= nz * pen * (1 - share);
          if (e.cd <= 0 && sp > 1.0) bump(e, nx, nz, sp);
          if (e.cd > 0 && e.cd < 2.9) e.yaw += wrap(Math.atan2(-nx, -nz) - e.yaw) * 0.1; // turn toward Kavi
        }
        // folk turn to look at Kavi after a bump
      }
      if (cam) bubbles.update(dt, cam);
    },
  };
}

/** Playtest: characters whose upper arms stay near horizontal (T-pose) or never move over 3 s of sim. Empty = pass. */
export function tposeReport(scene: THREE.Scene, sim: (sec: number) => void): string[] {
  const arms: { name: string; bones: THREE.Object3D[]; kids: THREE.Object3D[]; elev: number[][]; dirs: THREE.Vector3[][] }[] = [];
  const seen = new Set<THREE.Skeleton>();
  scene.traverse((o) => {
    if (!(o instanceof THREE.SkinnedMesh) || /outline$/.test(o.name) || seen.has(o.skeleton)) return;
    seen.add(o.skeleton);
    const bones = o.skeleton.bones.filter((b) => /(Left|Right)Arm$/.test(b.name));
    const kids = bones.map((b) => b.children.find((c) => /ForeArm$/.test(c.name))).filter((c): c is THREE.Object3D => !!c);
    if (kids.length !== bones.length || !bones.length) return;
    let top: THREE.Object3D = o;
    while (top.parent && top.parent !== scene) top = top.parent;
    arms.push({ name: `${top.name || o.name}@${o.parent?.parent ? "" : ""}`, bones, kids, elev: bones.map(() => []), dirs: bones.map(() => []) });
  });
  const a = new THREE.Vector3(), b = new THREE.Vector3();
  for (let k = 0; k < 6; k++) {
    sim(0.5);
    scene.updateMatrixWorld(true);
    for (const r of arms) r.bones.forEach((bone, i) => {
      bone.getWorldPosition(a); r.kids[i].getWorldPosition(b);
      b.sub(a).normalize();
      r.elev[i].push((Math.asin(b.y) * 180) / Math.PI);
      r.dirs[i].push(b.clone());
    });
  }
  const bad: string[] = [];
  for (const r of arms) {
    const worldPos = r.bones[0].getWorldPosition(new THREE.Vector3());
    const tpose = r.elev.every((e) => e.every((x) => Math.abs(x) < 15));
    const frozen = r.dirs.every((d) => d.every((x) => x.angleTo(d[0]) < (0.3 * Math.PI) / 180));
    if (tpose || frozen) bad.push(`${tpose ? "T-POSE" : "FROZEN"} ${r.name} at ${worldPos.x.toFixed(1)},${worldPos.z.toFixed(1)} elev ${r.elev[0].map((x) => x.toFixed(0)).join("/")}`);
  }
  return bad;
}
