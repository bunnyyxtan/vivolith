// Bench and cafe seating, pure maths: seat reservation and the rig-aware sit drop.
import type { Box } from "../physics/collision";

/** Pelvis (Hips bone) height above the seat surface when sitting, metres. */
export const PELVIS = 0.1;
/** Seat height when no seat collider is found under the anchor. */
export const SEAT_FALLBACK = 0.45;
/** How far soles may sink below the floor before the drop stops lowering the pelvis. */
const SOLE_SLACK = 0.03;

/** Reserves the first free slot for `who` (a person already in a slot keeps it). -1 when every slot is taken, so two
 *  people can never be given the same seat. */
export function claimSlot<T>(slots: (T | null)[], who: T): number {
  const own = slots.indexOf(who);
  if (own >= 0) return own;
  const free = slots.indexOf(null);
  if (free < 0) return -1;
  slots[free] = who;
  return free;
}

/** Frees `who`'s slot (no-op when they hold none). */
export function freeSlot<T>(slots: (T | null)[], who: T): void {
  const i = slots.indexOf(who);
  if (i >= 0) slots[i] = null;
}

/** Height of the seat surface above `floorY` under (x, z): the tallest low collider box there (a bench or chair seat),
 *  else SEAT_FALLBACK. Boxes taller than 0.9 m are backs, walls or tables, not seats. */
export function seatHeight(colliders: readonly Box[], x: number, z: number, floorY: number): number {
  let top = -1;
  for (const b of colliders) {
    if (x < b.minX || x > b.maxX || z < b.minZ || z > b.maxZ) continue;
    if (b.maxY > 0.25 + floorY && b.maxY <= 0.9 + floorY) top = Math.max(top, b.maxY - floorY);
  }
  return top > 0 ? top : SEAT_FALLBACK;
}

/** Vertical drop (metres) that seats a character: the pelvis lands PELVIS above the seat, but the soles are not pushed
 *  more than SOLE_SLACK below the floor. `hipsRise` and `footRise` are the Hips bone and the lowest sole above the root
 *  in the Sit pose with no drop applied; `seat` is the seat height above the floor. Long-legged bodies stop at the floor
 *  (pelvis a little high), short ones sit on the seat (feet dangle). */
export function sitLift(hipsRise: number, footRise: number, seat: number): number {
  const toSeat = hipsRise - (seat + PELVIS);
  const toFloor = footRise + SOLE_SLACK;
  return Math.max(0, Math.min(toSeat, toFloor, 0.7));
}
