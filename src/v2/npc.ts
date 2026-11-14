// Townsfolk brain: each folk picks an activity (sit, queue at a stall, chat, wait, carry a crate, browse a shop)
// from SPOT_<kind>__<id> empties of town.glb (fallback spots when absent), walks there on an A* path,
// does it for a while, then picks the next. Also: capsule push between Kavi and everyone, NPC separation,
// stagger + speech bubble when bumped.
// Faked: shop "entering" (they vanish at the door), NPC purchases are visual only (no economy demand hook).
import * as THREE from "three";
import { STEP_HEIGHT, groundHeightAt, pushOut, type Body, type Box } from "../physics/collision";
import { standHeight, type FloorHeight } from "./floor";
import type { AnimatedCharacter } from "../character";
import { NPC_STEP, createNav, type Nav } from "./nav";
import { createBubbles, installPose, type PoseState } from "./npcfx";
import { separate, steer } from "./avoid";
import { claimSlot, freeSlot, seatHeight, sitLift } from "./seats";
import { audio } from "./audio";
import { CAST_BUMP, FOLK_VOICES, VOICES, castBumpUrl, folkVoiceUrl, voiceUrl, type CastBumpId } from "./audio-manifest";
import type { MerchantId } from "../economy/state";

type Kind = "bench" | "shopdoor" | "stallq" | "chat" | "wait" | "crate" | "cafe" | "photo" | "jog";
const KINDS: readonly Kind[] = ["bench", "shopdoor", "stallq", "chat", "wait", "crate", "cafe", "photo", "jog"];
const WEIGHT: Record<Kind, number> = { bench: 2, shopdoor: 2, stallq: 3, chat: 3, wait: 1, crate: 1.5, cafe: 2, photo: 1.2, jog: 0.5 };
/** What people do on a trip to the N Spire district (gardens, square, lobby). */
const SPIRE_KINDS: readonly Kind[] = ["bench", "shopdoor", "chat", "wait", "photo", "cafe", "stallq", "jog"];
const JOG_SPEED = 3.0;

/** Spire district areas, from the spot name (spire_<area>_...), see blender/build_v2_spire_district.py. */
type Area = "amph" | "yard" | "orch" | "stn" | "depot";
const AREA = /spire_(amph|yard|orch|stn|depot)_/;
/** The day's rhythm: what people do at each hour (multiplies WEIGHT) and where they gather (cost bonus, metres). */
interface Phase { kinds: Partial<Record<Kind, number>>; areas: Partial<Record<Area, number>>; spire: number }
const RHYTHM: { from: number; phase: Phase }[] = [
  { from: 0, phase: { kinds: { wait: 2, bench: 1.2, stallq: 0.3, crate: 0.2, jog: 0 }, areas: { stn: 25 }, spire: 0.4 } },       // night: last trams home
  { from: 6, phase: { kinds: { crate: 3, stallq: 2, wait: 1.6, jog: 2 }, areas: { depot: 30, orch: 25, stn: 15 }, spire: 0.35 } }, // morning: deliveries, market, commute
  { from: 11, phase: { kinds: { stallq: 2.2, cafe: 2, bench: 1.2 }, areas: { yard: 40 }, spire: 0.45 } },                        // lunch: food trucks, cafes
  { from: 15, phase: { kinds: { photo: 2, bench: 1.5, chat: 1.5, jog: 1.5 }, areas: { amph: 10, orch: 10 }, spire: 0.4 } },      // afternoon: strolls
  { from: 18, phase: { kinds: { bench: 2.5, chat: 2, cafe: 1.5, crate: 0.3 }, areas: { amph: 50, yard: 15 }, spire: 0.6 } },     // evening: Demo Day on the lawn
  { from: 23, phase: { kinds: { wait: 2, bench: 1.2, stallq: 0.3, crate: 0.2, jog: 0 }, areas: { stn: 25 }, spire: 0.4 } },
];
const phaseAt = (hour: number): Phase => {
  let p = RHYTHM[0].phase;
  for (const r of RHYTHM) if (hour >= r.from) p = r.phase;
  return p;
};

/** Anything cars must stop for. */
/** Everyone walking the town: merchants first (`fixed`, at their stalls), then the townsfolk. */
export interface Pedestrian { x: number; y: number; z: number; hidden: boolean; fixed: boolean }
export const pedestrians: Pedestrian[] = [];

export interface MerchantRef {
  readonly id?: string;
  readonly root: THREE.Group;
  readonly post: { npc: THREE.Vector3; stall: THREE.Vector3 };
  readonly character: AnimatedCharacter;
  readonly head: THREE.Vector3;
  attend: THREE.Vector3 | null;
  serving: boolean;
  /** While serving: true on the merchant's turn to speak (the customer speaks on the other turns). */
  serveTalk: boolean;
}
interface Errand { mer: string; line: string; carry: boolean; tag?: string; side?: boolean }
export interface FolkChar { c: AnimatedCharacter; root: THREE.Group }

interface Spot {
  kind: Kind; area: Area | null; x: number; z: number; yaw: number; cap: number; users: number;
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
  /** View culling: drawn this frame, animation time owed while off screen, ink/shadow detail (near only). */
  onScreen: boolean; lag: number; near: boolean; inks: THREE.Object3D[]; bodies: THREE.Mesh[];
  /** Residents: confirmed trades to act out (walk to the stall, then say it), and the line being walked to now. */
  errands: Errand[]; errand: string | null; errandTag: string | null;
  /** Townsfolk: index into FOLK_VOICES. startled: seconds left on the startled clip before it is released. */
  voice: number; startled: number;
  /** Walking and pushable (separation yields to everyone else: standing, seated, queuing and merchants never move for it). */
  mobile: boolean;
  /** Rig-aware seating: Hips and lowest sole above the root in the Sit pose (measured once), and the drop for the current seat. */
  sitHips: number; sitFeet: number; sitCal: boolean; sitDrop: number;
  /** Seconds left on a one-shot gesture (Look, Wave): nothing else changes the clip meanwhile. */
  gest: number;
  /** Measured ground speed (m/s, smoothed) from where the body actually went: the gait follows it, shoves included. */
  vel: number; px: number; pz: number;
  /** Walking out of a seat or doorway collider on the first leg: not pushed out of it (that snapped up to 3 m). */
  exit: boolean;
  /** Residents: where their work is (Lin the orchard, Dev the depot), and true while working a spot there. */
  home: Area | null; work: boolean;
  /** Errand for a confirmed sale: the goods are carried to the buyer and handed over there. */
  handOver: boolean;
}

const WALK = 1.3, PLAYER_R = 0.32, HEAD = 1.85;
const TURN_RATE = 4; // rad/s, the fastest anyone turns on the spot or while walking
const AHEAD_M = 0.7; // how far ahead a sidestep is checked against walls
const FAR_TRIP = 0.15; // chance a plan heads across town instead of somewhere near
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
  /** Speech bubble above a point (e.g. a merchant's head) for `sec` seconds. */
  say(at: THREE.Vector3, text: string, sec?: number): void;
  /** Game hour (0..23): sets the day's rhythm; at 07:00 the orchard is picked. */
  setHour(hour: number): void;
  /** What people talk about (built from the live economy). */
  setGossip(lines: readonly string[]): void;
  /** A shipment landed at the Harbor Depot: up to `crates` crates appear on the dock for porters to carry. */
  deliver(crates: number): void;
  /** Townsperson `who` walks to merchant `mer`'s stall and says `line` there (a resident's confirmed trade). */
  /** A resident walks to a merchant for a confirmed trade: `line` is what they say, `tag` the trade marker shown over the
   *  merchant (what changed hands), `side` hands over at the side of a shut stall instead of through its shutter. */
  errand(who: number, mer: string, line: string, carry?: boolean, opts?: { tag?: string; side?: boolean }): void;
}

export function createLife(scene: THREE.Scene, colliders: Box[], town: THREE.Object3D | null, mers: readonly MerchantRef[], folkChars: readonly FolkChar[], floor: FloorHeight = (_x, _z, g) => g): Life {
  const nav: Nav = createNav(colliders);
  const bubbles = createBubbles();
  const spots: Spot[] = [];
  const mk = (kind: Kind, x: number, z: number, yaw: number, cap = 1, name = "", deep = false): Spot => {
    const s: Spot = { kind, area: (AREA.exec(name)?.[1] as Area | undefined) ?? null, x, z, yaw, cap, users: 0, name, deep, mer: null, next: null, slots: [null, null], t: 0, turn: 0, has: false, crate: null };
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
    onScreen: true, lag: 0, near: true, inks: [], bodies: [], errands: [], errand: null, errandTag: null, voice: 0, startled: 0, mobile: false, sitHips: 0.9, sitFeet: 0.37, sitCal: false, sitDrop: 0.37,
    gest: 0, vel: 0, px: root.position.x, pz: root.position.z, exit: false, home: null, work: false, handOver: false,
  });
  const merEnts = mers.map((m) => { const e = mkEnt(m.character, m.root, true); e.mer = m; return e; });
  const folk = folkChars.map((f, i) => {
    const e = mkEnt(f.c, f.root, false);
    e.voice = (i % 6) % FOLK_VOICES.length; // same model (market.ts cycles 6) = same voice; model 1 (Noor) = folk0
    e.carry = makeCrate();
    e.carry.position.set(0, 1.0, 0.36);
    e.carry.visible = false;
    f.root.add(e.carry);
    return e;
  });
  // the first townsfolk act out the residents (play.ts: folk[i] = RESIDENTS[i]): Lin picks at the orchard, Dev works the depot
  const HOMES: readonly Area[] = ["orch", "depot"];
  HOMES.forEach((a, i) => { if (folk[i]) folk[i].home = a; });
  const all = [...merEnts, ...folk];
  pedestrians.push(...all);
  if (import.meta.env.DEV) { // playtest handles for the browser console (dev server only)
    Object.assign(window, { __npcs: pedestrians, __tpose: (sim: (sec: number) => void): string[] => tposeReport(scene, sim) });
  }

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

  // ---- rig-aware sitting: measure each body's Sit pose once, then drop it onto the actual seat
  const tmpV = new THREE.Vector3();
  const calibrate = (e: Ent): void => {
    if (e.sitCal) return;
    e.sitCal = true;
    if (!e.c.has("Sit")) return;
    e.c.lift = 0;
    e.c.setAction("Sit");
    for (let k = 0; k < 24; k++) e.c.update(0.05);
    e.root.updateMatrixWorld(true);
    const ry = e.root.getWorldPosition(tmpV).y;
    const hips = e.c.bone("Hips");
    if (hips) e.sitHips = hips.getWorldPosition(tmpV).y - ry;
    let low = Infinity;
    for (const n of ["LeftToeBase", "RightToeBase"]) {
      const b = e.c.bone(n);
      if (b) low = Math.min(low, b.getWorldPosition(tmpV).y - ry - 0.03); // ball of the foot to the sole
    }
    if (low < Infinity) e.sitFeet = low;
    e.c.setAction(null);
    for (let k = 0; k < 8; k++) e.c.update(0.05);
  };
  folk.forEach(calibrate);

  // ---- decisions
  const dist = (e: Ent, s: Spot): number => Math.hypot(e.x - s.x, e.z - s.z);
  const pulls = new Map<string, number>();
  let phase = phaseAt(10), hourNow = -1;
  let gossip: readonly string[] = CHAT_LINES;
  /** Puts a crate on up to n empty crate spots of an area (a delivery or a morning's picking). */
  const stock = (area: Area, n: number): void => {
    for (const s of spots) {
      if (n <= 0) break;
      if (s.kind !== "crate" || s.area !== area || s.has || s.users > 0) continue;
      s.has = true;
      if (s.crate) s.crate.visible = true;
      n--;
    }
  };
  const pullOf = (s: Spot): number => (s.mer?.id ? pulls.get(s.mer.id) ?? 1 : 1);
  const claim = (e: Ent, kind: Kind, spireOnly = false): Spot | null => {
    const far = Math.random() < FAR_TRIP; // sometimes head across town (park, Spire)
    let best: Spot | null = null, bc = 1e9;
    for (const s of spots) {
      if (s.kind !== kind || s.users >= s.cap || (spireOnly && !s.name.includes("spire"))) continue;
      if (kind === "crate" && (e.carrying ? s.has : !s.has)) continue; // pick up where a crate is, drop where none
      if (kind === "crate" && e.carrying && (s.area === "depot" || s.area === "orch")) continue; // crates go to market, not back
      if (kind === "stallq" && s.next === null && s.users >= 1) continue;
      if (kind === "stallq" && pullOf(s) < 0.05) continue; // closed or sold out: shoppers walk past
      let c = (far && kind !== "stallq" ? 0 : dist(e, s)) + rnd(0, 18);
      if (kind === "chat" && s.users === 1) c -= 40; // join a waiting partner
      if (kind === "stallq" && s.next && s.next.users === 0) c += 50; // queue place 1 only behind an occupied place 0
      if (kind === "stallq") c += (1 - pullOf(s)) * 30; // cheap, stocked stalls draw the crowd
      if (s.area) c -= phase.areas[s.area] ?? 0; // where people gather at this hour
      if (kind === "crate" && !e.carrying && s.area) c -= 15; // porters fetch from the depot and the orchard first
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
    e.exit = !nav.clear(e.x, e.z); // standing in a seat or doorway: step out to the nearest free cell first
    if (e.exit && nav.nearestFree(e.x, e.z, cell) && Math.hypot(cell.x - e.x, cell.z - e.z) > 0.1) e.path.unshift(cell.x, cell.z);
    e.path.push(tx, tz);
    e.pi = 0; e.sx = e.x; e.sz = e.z; e.stuckT = 0;
    e.state = "walk";
    return true;
  };
  const release = (e: Ent): void => {
    const s = e.spot;
    if (s) {
      s.users = Math.max(0, s.users - 1);
      freeSlot(s.slots, e);
      if ((s.kind === "stallq" && !s.next) || s.name === "errand") if (s.mer) { s.mer.serving = false; s.mer.attend = null; }
      if (e.work && e.carrying) { e.carrying = false; if (e.carry) e.carry.visible = false; if (s.crate) s.crate.visible = s.has; }
    }
    if (e.startled <= 0) { e.c.setAction(null); e.gest = 0; } // stand up out of the Sit or Talking clip before walking off
    e.work = false;
    e.spot = null; e.pose.phone = 0; // pose.sit decays in the main loop: zeroing it popped the stand-up 0.37 m
  };
  /** Next errand: stand at the merchant's customer point facing them (a private spot nobody else can claim). */
  const startErrand = (e: Ent): boolean => {
    const job = e.errands.shift();
    const m = job && mers.find((x) => x.id === job.mer);
    if (!job || !m) return false;
    const st = m.post.stall, np = m.post.npc;
    // a shut stall takes goods at its side (beside the counter end), never through the shutter
    // (where the crate pile stands while it trades; the chalkboard is at the other end)
    const at = job.side ? { x: (np.x + st.x) / 2 + Math.sign(st.x - np.x) * 0.9, z: np.z - 2.3 } : { x: st.x, z: st.z };
    const s: Spot = { kind: "wait", area: null, x: at.x, z: at.z, yaw: Math.atan2(np.x - at.x, np.z - at.z), cap: 1, users: 1, name: "errand", deep: false, mer: m, next: null, slots: [e, null], t: 0, turn: 0, has: false, crate: null };
    if (nav.nearestFree(s.x, s.z, cell)) { s.x = cell.x; s.z = cell.z; }
    e.spot = s; e.slot = 0; e.errand = job.line; e.errandTag = job.tag ?? null; e.jogLeft = 0; e.speed = e.baseSpeed;
    // a confirmed sale: the goods go with them to the buyer (never shown for a trade that did not happen)
    e.handOver = job.carry; e.carrying = job.carry; if (e.carry) e.carry.visible = job.carry;
    if (goTo(e, s)) return true;
    release(e); e.errand = null;
    return false;
  };
  /** A resident's work place: a free spot in their home area (crates to sort, the orchard rows, the dock). */
  const workSpot = (e: Ent): Spot | null => {
    let best: Spot | null = null, bc = 1e9;
    for (const s of spots) {
      if (s.area !== e.home || s.users >= s.cap || (s.kind !== "crate" && s.kind !== "wait" && s.kind !== "photo")) continue;
      const c = dist(e, s) + rnd(0, 12) - (s.kind === "crate" && s.has ? 8 : 0);
      if (c < bc) { bc = c; best = s; }
    }
    return best;
  };
  /** A short stop between activities: look around, then choose what next. */
  const pause = (e: Ent): void => {
    e.state = "idle"; e.t = rnd(0.6, 2.2);
    e.exit = !nav.clear(e.x, e.z); // still in a seat or doorway: stay put until the next walk steps out of it
    if (Math.random() < 0.35 && gesture(e, "Look")) e.t = Math.max(e.t, e.gest + 0.2);
  };
  const decide = (e: Ent): void => {
    if (e.errands.length && startErrand(e)) return;
    e.state = "idle"; e.t = rnd(0.5, 2); e.exit = !nav.clear(e.x, e.z);
    // residents spend most of the day at their own work; a delivery happens only as an errand for a confirmed sale
    if (e.home && !e.carrying && Math.random() < 0.8) {
      const s = workSpot(e);
      if (s) {
        s.users++; e.spot = s; e.slot = 0; s.slots[0] = e; e.work = true; e.last = s.kind; e.phase = 0;
        if (goTo(e, s)) return;
        release(e);
      }
    }
    // a trip to the N Spire district (lobby, gardens, square, yard, lawn); porters with a crate always deliver it
    const spire = !e.carrying && Math.random() < phase.spire;
    const opts = (e.carrying ? KINDS : spire ? SPIRE_KINDS.filter((k) => k !== e.last) : KINDS.filter((k) => k !== e.last && k !== "jog"))
      .filter((k) => !(e.home && k === "crate")); // residents never haul crates around town
    let total = 0;
    const w = opts.map((k) => { const v = e.carrying ? (k === "crate" ? 10 : 0) : WEIGHT[k] * (phase.kinds[k] ?? 1); total += v; return v; });
    let r = Math.random() * total;
    for (let i = 0; i < opts.length; i++) {
      r -= w[i];
      if (r > 0 || w[i] === 0) continue;
      const s = claim(e, opts[i], spire);
      if (!s) break;
      const shared = s.kind === "chat" || s.kind === "bench";
      const slot = shared ? claimSlot(s.slots, e) : 0; // a seat is reserved before anyone walks to it: never two on one
      if (slot < 0) continue;
      s.users++;
      e.spot = s; e.slot = slot; s.slots[slot] = e; e.last = opts[i]; e.phase = 0;
      if (goTo(e, s, e.slot)) return;
      release(e);
    }
  };

  const arrive = (e: Ent): void => {
    const s = e.spot;
    if (!s) { e.state = "idle"; return; }
    e.state = "act"; e.phase = 0; e.spd = 0;
    switch (s.kind) {
      case "bench": case "cafe":
        e.t = rnd(20, 40);
        e.sitDrop = sitLift(e.sitHips, e.sitFeet, seatHeight(colliders, e.x, e.z, e.by)); // this body on this seat
        break;
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
    if (e.errand) { // at the stall: the trade, as recorded on NEAR; the merchant turns to them
      e.t = 4; chat(e, e.errand, 4); e.errand = null;
      if (s.mer) { s.mer.serving = true; s.mer.attend = new THREE.Vector3(e.x, 0, e.z); if (e.errandTag) bubbles.say(s.mer.head, e.errandTag, 4, "tag"); }
      e.errandTag = null;
    }
    if (e.work) e.t = rnd(14, 28);
  };

  /** Turn toward yaw: eased, and never faster than TURN_RATE (a full about-face takes ~0.8 s, not one frame). */
  const faceTo = (e: Ent, yaw: number, dt: number, k = 8): void => {
    const d = wrap(yaw - e.yaw) * (1 - Math.exp(-k * dt)), m = TURN_RATE * dt;
    e.yaw += d > m ? m : d < -m ? -m : d;
  };
  /** A one-shot clip (Look, Wave) when the model has it; false otherwise. Only while standing still. */
  const gesture = (e: Ent, name: string): boolean => {
    const len = e.c.duration(name);
    if (!len || e.gest > 0 || e.startled > 0) return false;
    e.c.setAction(name, true);
    e.gest = len - 0.2; // released just before it ends, so the fade back never holds a clamped last frame
    return true;
  };

  /** A resident at work: sorts the crate at the spot (lifted and set back down where it was) or checks the rows. */
  const workFolk = (e: Ent, dt: number): void => {
    const s = e.spot!;
    e.t -= dt;
    faceTo(e, s.yaw, dt);
    if (s.kind === "crate" && s.has && e.gest <= 0) {
      const lift = e.t > 1 && e.t % 6 < 2.2;
      if (lift !== e.carrying) { e.carrying = lift; if (s.crate) s.crate.visible = !lift; if (e.carry) e.carry.visible = lift; }
    } else if (Math.random() < dt * 0.12) gesture(e, "Look");
    e.pose.carry += ((e.carrying ? 1 : 0) - e.pose.carry) * (1 - Math.exp(-6 * dt));
    if (e.gest <= 0 && e.startled <= 0) e.c.setAction(null);
    if (e.t <= 0) { release(e); pause(e); }
  };

  const actFolk = (e: Ent, dt: number): void => {
    if (e.work) { workFolk(e, dt); return; }
    const s = e.spot!;
    e.t -= dt;
    let talk = false, seatTarget = 0, carryTarget = e.carrying ? 1 : 0;
    switch (s.kind) {
      case "bench": case "cafe": {
        faceTo(e, s.yaw, dt, 10);
        seatTarget = Math.abs(wrap(s.yaw - e.yaw)) < 0.35 ? 1 : 0; // turn to the seat first, then sit down
        const p = s.kind === "bench" ? s.slots[1 - e.slot] : null;
        if (p && p.state === "act" && p.spot === s) { // friends on a bench take turns talking
          if (e.slot === 0) { s.turn -= dt; if (s.turn < 0) { s.turn = rnd(3, 6); e.phase ^= 1; p.phase = e.phase ^ 1; } }
          talk = e.phase === 1;
          if (talk && Math.random() < dt * 0.06) chat(e, gossip[Math.floor(Math.random() * gossip.length)], 2.4);
        }
        break;
      }
      case "wait": case "shopdoor": case "crate":
        faceTo(e, s.yaw, dt);
        if (s.kind === "wait" && s.name !== "errand" && Math.random() < dt * 0.08) gesture(e, "Look"); // waiting: glance around
        if (s.name === "errand" && e.handOver && e.t < 2.6) { // hand the goods over the counter
          e.handOver = false; e.carrying = false; if (e.carry) e.carry.visible = false;
        }
        if (s.name === "errand") carryTarget = e.carrying ? 1 : 0;
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
        // served at the counter: customer and merchant take turns to speak, never both at once
        talk = !s.next && e.t < 5 && Math.floor(e.t / 1.4) % 2 === 1;
        if (!s.next && s.mer) s.mer.serveTalk = e.t < 5 && !talk;
        break;
      case "chat": {
        const p = s.slots[1 - e.slot];
        if (p && p.state === "act" && p.spot === s) {
          if (s.t === 0) { s.t = rnd(14, 26); e.t = 999; if (Math.random() < 0.5) gesture(e, "Wave"); } // a hello
          const toX = p.x - e.x, toZ = p.z - e.z;
          faceTo(e, Math.atan2(toX, toZ), dt);
          if (e.slot === 0) { s.turn -= dt; if (s.turn < 0) { s.turn = rnd(3, 5); s.slots[0]!.phase ^= 1; s.slots[1]!.phase = s.slots[0]!.phase ^ 1; } }
          talk = e.phase === 0 ? e.slot === 0 : e.slot === 1;
          if (e.slot === 0) { s.t -= dt; if (s.t <= 0.001) { s.t = 0.001; e.t = 0; p.t = 0; } }
          if (e.slot === 0 && Math.random() < dt * 0.15 && talk) chat(e, gossip[Math.floor(Math.random() * gossip.length)], 2.4);
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
    e.c.lift = e.pose.sit * e.sitDrop;
    e.pose.carry += (carryTarget - e.pose.carry) * (1 - Math.exp(-6 * dt));
    if (e.gest <= 0 && e.startled <= 0) e.c.setAction(seatTarget > 0 && e.c.has("Sit") ? "Sit" : talk ? "Talking" : null); // the real Tripo clip; the drop only trims it to the seat
    const done = s.kind === "crate" ? e.phase === 1 && e.t <= -0.6 : e.t <= 0 && (s.kind !== "shopdoor" || e.phase === 3);
    if (done) { release(e); pause(e); }
  };

  const walkFolk = (e: Ent, dt: number): void => {
    const tx = e.path[e.pi], tz = e.path[e.pi + 1];
    const last = e.pi + 2 >= e.path.length;
    const dx = tx - e.x, dz = tz - e.z, d = Math.hypot(dx, dz);
    if (d < (last ? 0.12 : 0.4)) {
      e.pi += 2; e.exit = false;
      if (e.pi >= e.path.length) { arrive(e); return; }
      return;
    }
    const wantRaw = Math.atan2(dx, dz);
    let st = d > 1.2 ? steer(e, wantRaw, all) : { yaw: wantRaw, slow: 1 }; // go around people ahead (not on the last metre)
    if (st.yaw !== wantRaw && !nav.clear(e.x + Math.sin(st.yaw) * AHEAD_M, e.z + Math.cos(st.yaw) * AHEAD_M)) {
      // that side is a wall or a step: pass on the other side, else squeeze by slowly on the path line
      const alt = 2 * wantRaw - st.yaw;
      st = nav.clear(e.x + Math.sin(alt) * AHEAD_M, e.z + Math.cos(alt) * AHEAD_M) ? { yaw: alt, slow: st.slow } : { yaw: wantRaw, slow: Math.min(st.slow, 0.5) };
    }
    const want = st.yaw, diff = wrap(want - e.yaw);
    faceTo(e, want, dt, 9);
    const target = Math.abs(diff) > 1.2 ? 0.2 : Math.min(e.speed * (e.carrying ? 0.8 : 1) * st.slow, d * 3 + 0.3);
    e.spd += (target - e.spd) * (1 - Math.exp(-6 * dt));
    e.x += Math.sin(e.yaw) * e.spd * dt; e.z += Math.cos(e.yaw) * e.spd * dt;
    if (!last && !e.exit) { // the final leg may end inside a seat or doorway collider, the first may start in one
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
  /** A townsperson says something: the bubble, and their voice when the camera is near (street chatter, one at a time). */
  const CHAT_HEAR_M = 14;
  const chat = (e: Ent, text: string, sec: number): void => {
    bubbles.say(e.head, text, sec);
    if (cam && Math.hypot(e.x - cam.position.x, e.z - cam.position.z) < CHAT_HEAR_M) void audio.line(`folk${e.voice}`, text, { at: e.head, ambient: true });
  };
  // ---- view culling: townsfolk outside the camera frustum or far away are not drawn; beyond DETAIL_FAR they lose the
  // ink outline and shadow (a few pixels tall there). Characters disable three's own culling (skinned bounds lag).
  const VIEW_FAR = 90, DETAIL_FAR = 30;
  const frustum = new THREE.Frustum(), viewProj = new THREE.Matrix4(), sphere = new THREE.Sphere(new THREE.Vector3(), 1.2);
  for (const e of folk) {
    e.root.traverse((o) => {
      if (/_outline$/.test(o.name)) e.inks.push(o);
      else if ((o as THREE.Mesh).isMesh && (o as THREE.Mesh).castShadow) e.bodies.push(o as THREE.Mesh);
    });
  }
  const cull = (): void => {
    if (!cam) return;
    viewProj.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    frustum.setFromProjectionMatrix(viewProj);
    const cp = cam.position;
    for (const e of folk) {
      const d = Math.hypot(e.x - cp.x, e.z - cp.z);
      sphere.center.set(e.x, e.y + 0.9, e.z);
      e.onScreen = !e.hidden && d < VIEW_FAR && frustum.intersectsSphere(sphere);
      e.root.visible = e.onScreen;
      const near = d < DETAIL_FAR;
      if (near !== e.near) {
        e.near = near;
        e.c.coarse = !near;
        for (const o of e.inks) o.visible = near;
        for (const b of e.bodies) b.castShadow = near;
      }
    }
  };
  let lpx = 0, lpz = 0;

  let voiceCd = 0; // one voiced reaction at a time across the whole street
  let tick = 0; // frame counter: far townsfolk animate on alternate frames
  const bump = (e: Ent, nx: number, nz: number, speed: number): void => {
    e.cd = 3;
    const k = e.fixed ? 1.2 : 2.4;
    e.svx = nx * k; e.svz = nz * k; e.stag = e.fixed ? 0.6 : 0.9;
    if (!e.fixed && e.state !== "act") e.state = "stag";
    // what they say is what you hear: a merchant's own bump line, or one of the townsperson's voice's lines
    const mid = e.fixed ? e.mer?.id : undefined;
    const merchant = mid && mid in VOICES ? (mid as MerchantId) : null;
    const cast = mid && mid in CAST_BUMP ? (mid as CastBumpId) : null; // Bram, Ines: recorded in their own voices
    let text: string, url: string | null;
    if (merchant) { text = VOICES[merchant].lines.bump; url = voiceUrl(merchant, "bump"); }
    else if (cast) { const n = Math.floor(Math.random() * CAST_BUMP[cast].length); text = CAST_BUMP[cast][n]; url = castBumpUrl(cast, n); }
    else if (!e.fixed) { const v = FOLK_VOICES[e.voice], n = Math.floor(Math.random() * v.bump.length); text = v.bump[n]; url = folkVoiceUrl(e.voice, n); }
    else { text = BUMP_LINES[Math.floor(Math.random() * BUMP_LINES.length)]; url = null; }
    // The subtitle appears only when the voice does: one voiced reaction at a time, so a second bump inside the gap
    // still flinches but stays silent and unlabelled (a bubble without sound was the reported defect).
    if (url) {
      if (voiceCd <= 0) { voiceCd = 0.8; bubbles.say(e.head, text, 1.6); void audio.at(url, e.x, e.y + 1.6, e.z); }
    } else bubbles.say(e.head, text, 1.6);
    // a real flinch where the model has one (Tripo "Startled"); seated folk keep their seat
    const seated = e.state === "act" && (e.spot?.kind === "bench" || e.spot?.kind === "cafe");
    if (!seated && e.c.has("Startled") && speed > 1.6) { e.c.setAction("Startled", true); e.startled = 1.1; }
  };

  const place = (e: Ent): void => {
    const seated = (e.spot?.kind === "bench" || e.spot?.kind === "cafe") && (e.state === "act" || (e.state === "walk" && e.pi + 2 >= e.path.length)); // seat colliders must not lift the sitter
    // groundHeightAt allows STEP_HEIGHT above feetY: offset so townsfolk climb at most NPC_STEP (curbs, stairs).
    e.y = e.fixed ? e.hy : seated ? e.by : groundHeightAt(colliders, e.x, e.z, e.y + NPC_STEP - STEP_HEIGHT);
    if (!seated) e.by = e.y;
    // stand (or sit) on the visible pavement, not the flat collision ground; both feet clear curbs and steps
    // (footprints are from the pose just updated, at last frame's root: a few cm behind at walking speed)
    const vy = e.fixed ? e.y : seated ? floor(e.x, e.z, e.y) : standHeight(floor, e.x, e.z, e.y, e.c.footprints());
    e.root.position.set(e.x, vy, e.z);
    e.root.rotation.y = e.yaw;
    e.c.root.position.z = seated && e.state === "act" && !e.c.has("Sit") ? -0.1 : 0; // procedural sit only: hips slightly back; the Sit clip carries its own
    e.pose.yaw = e.yaw;
    e.head.set(e.x, vy + HEAD - e.c.lift, e.z);
  };

  return {
    setPull(id, pull) { pulls.set(id, pull); },
    setHour(hour) {
      if (hour === hourNow) return;
      hourNow = hour;
      phase = phaseAt(hour);
      if (hour === 7) stock("orch", 4); // the morning's picking waits by the orchard lane
    },
    setGossip(lines) { if (lines.length) gossip = lines; },
    deliver(crates) { stock("depot", crates); },
    errand(who, mer, line, carry = false, opts = {}) {
      const e = folk[who];
      if (!e) return;
      e.errands.push({ mer, line, carry, tag: opts.tag, side: opts.side });
      if (e.errand === null && e.state !== "stag") { release(e); e.carrying = false; if (e.carry) e.carry.visible = false; decide(e); }
    },
    say(at, text, sec = 3.2) { bubbles.say(at, text, sec); },
    bind(b, c) { pb = b; cam = c; lpx = b.x; lpz = b.z; },
    update(dt) {
      dt = Math.min(dt, 0.1);
      tick++;
      voiceCd -= dt;
      for (const e of all) if (e.startled > 0 && (e.startled -= dt) <= 0) e.c.setAction(null); // release the flinch
      for (const e of folk) if (e.gest > 0 && (e.gest -= dt) <= 0) e.c.setAction(null); // and a finished gesture
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
          if (pb) faceTo(e, Math.atan2(pb.x - e.x, pb.z - e.z), dt, 10); // turn to see who it was
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
        if (e.state !== "act") { // the seat drop eases out after standing (a pop was 0.37 m) and never outlives the seat
          e.pose.sit = e.pose.sit < 0.01 ? 0 : e.pose.sit * Math.exp(-7 * dt);
          e.c.lift = e.pose.sit * e.sitDrop;
        }
        // the gait follows where the body really went (path, steering and shoves): planted feet do not slide
        const step = Math.hypot(e.x - e.px, e.z - e.pz);
        e.px = e.x; e.pz = e.z;
        e.vel += ((e.hidden || step > 1 ? 0 : step / dt) - e.vel) * (1 - Math.exp(-12 * dt));
        if (e.state !== "act") e.pose.carry += ((e.carrying ? 1 : 0) - e.pose.carry) * (1 - Math.exp(-6 * dt));
        e.c.setSpeed(e.vel < 0.03 ? 0 : e.vel, WALK, WALK * 2);
        // off screen: the mixer catches up twice a second (nobody sees the pose); far but on screen (a few pixels
        // tall): every other frame; near: every frame
        e.lag += dt;
        if ((e.onScreen && (e.near || (tick & 1) === 0)) || e.lag > 0.5) { e.c.update(e.lag); e.lag = 0; }
        place(e);
      }
      // people never overlap: separation over everyone (merchants, queues and sitters hold their ground), then walls
      for (const e of all) e.mobile = !e.fixed && !e.hidden && e.state !== "act";
      for (let i = 0; i < all.length; i++) {
        for (let j = i + 1; j < all.length; j++) separate(all[i], all[j]);
      }
      for (const e of folk) {
        if (!e.mobile || e.exit || (e.state === "walk" && e.pi + 2 >= e.path.length)) continue; // the last leg may end inside a seat or doorway collider
        body.x = e.x; body.z = e.z; body.y = e.y; pushOut(colliders, body); // a shove must not put anyone inside a wall
        e.x = body.x; e.z = body.z;
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
        }
      }
      // crates set down at the market sell over a couple of minutes, so porters keep coming from the depot and orchard
      for (const s of spots) {
        if (s.kind !== "crate" || !s.has || s.area || s.users > 0 || Math.random() > dt * 0.008) continue;
        s.has = false;
        if (s.crate) s.crate.visible = false;
      }
      cull();
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
