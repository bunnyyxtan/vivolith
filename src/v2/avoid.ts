// Pedestrian-to-pedestrian avoidance, pure maths (no three.js): overlap separation that never shoves a standing person,
// and look-ahead steering with a keep-right rule so two people walking at each other pass instead of stalling.
// Static walls stay in physics/collision.ts (pushOut); this only deals with people.

export interface Agent {
  x: number; z: number;
  /** Body radius, metres. */
  r: number;
  /** True when the agent is walking and may be pushed; standing, seated, queuing and merchant agents stay put. */
  mobile: boolean;
  hidden: boolean;
}

/** Pushes two overlapping agents apart. A mobile agent yields fully to an immovable one, both yield half to each other.
 *  Returns true when they overlapped. */
export function separate(a: Agent, b: Agent): boolean {
  if (a.hidden || b.hidden || (!a.mobile && !b.mobile)) return false;
  const dx = b.x - a.x, dz = b.z - a.z, R = a.r + b.r, d2 = dx * dx + dz * dz;
  if (d2 >= R * R) return false;
  const d = Math.sqrt(d2);
  const nx = d > 1e-4 ? dx / d : 1, nz = d > 1e-4 ? dz / d : 0; // exactly stacked: any direction will do, deterministically
  const pen = R - d;
  if (a.mobile && b.mobile) {
    a.x -= nx * pen * 0.5; a.z -= nz * pen * 0.5; b.x += nx * pen * 0.5; b.z += nz * pen * 0.5;
  } else if (a.mobile) { a.x -= nx * pen; a.z -= nz * pen; }
  else { b.x += nx * pen; b.z += nz * pen; }
  return true;
}

export interface Steer {
  /** Heading to walk (radians, three.js yaw: forward = (sin, cos)). */
  yaw: number;
  /** 0..1 speed factor: slow down when something stands right ahead. */
  slow: number;
}

const LOOK = 1.9; // metres of look-ahead
const MARGIN = 0.14; // extra clearance beside a person
const MAX_TURN = 0.95; // rad

/** Adjusts the wanted heading around agents on a collision course ahead. Keep-right: a head-on pair, or someone dead
 *  ahead, is passed on the right side (yaw + 90 deg), so two walkers choose opposite world sides and never mirror. */
export function steer(me: Agent, yaw: number, others: readonly Agent[], look = LOOK): Steer {
  const fx = Math.sin(yaw), fz = Math.cos(yaw), rx = Math.cos(yaw), rz = -Math.sin(yaw);
  let turn = 0, slow = 1;
  for (const o of others) {
    if (o === me || o.hidden) continue;
    const dx = o.x - me.x, dz = o.z - me.z;
    const ahead = dx * fx + dz * fz;
    if (ahead <= 0 || ahead > look) continue;
    const lat = dx * rx + dz * rz; // + = the other person is on my right
    const clear = me.r + o.r + MARGIN;
    if (Math.abs(lat) >= clear) continue;
    const side = Math.abs(lat) < 0.12 ? 1 : lat > 0 ? -1 : 1; // dead ahead: pass on the right; else away from them
    const urgency = 1 - ahead / look;
    turn += side * (0.35 + 0.65 * urgency) * (1 - (Math.abs(lat) / clear) * 0.5);
    slow = Math.min(slow, ahead < me.r + o.r + 0.5 ? (o.mobile ? 0.55 : 0.4) : ahead < 1.2 ? 0.75 : 1);
  }
  return { yaw: yaw + Math.max(-MAX_TURN, Math.min(MAX_TURN, turn)), slow };
}
