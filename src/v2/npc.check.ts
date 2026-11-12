// Run: node src/v2/npc.check.ts   (Node 24 strips the types natively)
// Deterministic regression tests for townsfolk movement: pedestrian avoidance, building detours, seat reservation,
// the rig-aware sit drop and the repeated sit -> stand -> walk cycle. Pure maths, no browser, no random numbers.
import assert from "node:assert/strict";
import { box, pushOut, type Body } from "../physics/collision.ts";
import { createNav } from "./nav.ts";
import { separate, steer, type Agent } from "./avoid.ts";
import { claimSlot, freeSlot, seatHeight, sitLift } from "./seats.ts";

const DT = 1 / 60, WALK = 1.3;
interface Walker extends Agent { id: string; gx: number; gz: number; yaw: number; speed: number; done: boolean; minGap: number }
const walker = (id: string, x: number, z: number, gx: number, gz: number, speed = WALK): Walker =>
  ({ id, x, z, r: 0.33, mobile: true, hidden: false, gx, gz, yaw: Math.atan2(gx - x, gz - z), speed, done: false, minGap: 9 });
const stander = (x: number, z: number): Agent => ({ x, z, r: 0.33, mobile: false, hidden: false });

/** One frame of the game's walking rule: steer around people, move, separate, keep out of walls. */
function stepAll(ws: Walker[], fixed: Agent[], walls: ReturnType<typeof box>[]): void {
  const all: Agent[] = [...ws, ...fixed];
  for (const w of ws) {
    if (w.done) { w.mobile = false; continue; }
    const dx = w.gx - w.x, dz = w.gz - w.z, d = Math.hypot(dx, dz);
    if (d < 0.15) { w.done = true; continue; }
    const st = d > 1.2 ? steer(w, Math.atan2(dx, dz), all) : { yaw: Math.atan2(dx, dz), slow: 1 };
    const diff = Math.atan2(Math.sin(st.yaw - w.yaw), Math.cos(st.yaw - w.yaw));
    w.yaw += diff * (1 - Math.exp(-9 * DT));
    const v = Math.min(w.speed * st.slow, d * 3 + 0.3);
    w.x += Math.sin(w.yaw) * v * DT; w.z += Math.cos(w.yaw) * v * DT;
  }
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) separate(all[i], all[j]);
  const body: Body = { x: 0, y: 0, z: 0, vy: 0, radius: 0.3, height: 1.7, grounded: true };
  for (const w of ws) {
    if (!w.mobile) continue;
    body.x = w.x; body.z = w.z; pushOut(walls, body); w.x = body.x; w.z = body.z;
  }
  for (const w of ws) for (const o of all) if (o !== w) w.minGap = Math.min(w.minGap, Math.hypot(o.x - w.x, o.z - w.z) - w.r - o.r);
}
const run = (ws: Walker[], fixed: Agent[], walls: ReturnType<typeof box>[], sec: number): number => {
  let t = 0;
  for (; t < sec * 60 && !ws.every((w) => w.done); t++) stepAll(ws, fixed, walls);
  return t * DT;
};
const SLACK = -0.06; // gap below 0 = bodies overlapping; separation keeps it within a few cm

// 1. Head-on: two people walking straight at each other pass without stopping or overlapping.
{
  const a = walker("a", -6, 0, 6, 0), b = walker("b", 6, 0, -6, 0);
  const t = run([a, b], [], [], 25);
  assert.ok(a.done && b.done, `head-on pair finished (t=${t.toFixed(1)}s)`);
  assert.ok(a.minGap > SLACK && b.minGap > SLACK, `head-on gap ${a.minGap.toFixed(2)}`);
  assert.ok(t < 14, `head-on pair no stall: ${t.toFixed(1)}s for 12 m`);
}

// 2. Two groups of four cross a 3 m wide street in opposite directions: everyone gets across, nobody overlaps.
{
  const ws: Walker[] = [];
  for (let i = 0; i < 4; i++) { ws.push(walker(`e${i}`, -7 - i * 0.3, -1.2 + i * 0.8, 7, -1.2 + i * 0.8)); ws.push(walker(`w${i}`, 7 + i * 0.3, -0.8 + i * 0.8, -7, -0.8 + i * 0.8)); }
  const walls = [box(0, -3.6, 30, 1, 3), box(0, 3.6, 30, 1, 3)]; // street walls at z = +-3.1
  const t = run(ws, [], walls, 60);
  assert.ok(ws.every((w) => w.done), `street crossing finished (t=${t.toFixed(1)}s)`);
  assert.ok(Math.min(...ws.map((w) => w.minGap)) > -0.12, `street crossing gap ${Math.min(...ws.map((w) => w.minGap)).toFixed(2)}`);
}

// 3. A standing person (queue, bench, merchant) in the way: the walker goes around and never pushes them.
{
  const s = stander(0, 0), w = walker("w", -6, 0.02, 6, 0);
  const t = run([w], [s], [], 20);
  assert.ok(w.done, `walked around the stander (t=${t.toFixed(1)}s)`);
  assert.ok(w.minGap > SLACK, `stander gap ${w.minGap.toFixed(2)}`);
  assert.equal(s.x, 0); assert.equal(s.z, 0); // immovable agents are never shoved
}

// 4. Landmark detour: A* around a NEAR-Labs sized block, with the avoidance rule on top; nobody enters the building.
{
  const lab = box(0, 0, 14, 8, 9); // x -7..7, z -4..4, 9 m tall
  const nav = createNav([lab]);
  const route: number[] = [];
  assert.ok(nav.path(-12, 0, 12, 0, route), "route around the building exists");
  const w = walker("w", -12, 0, 12, 0);
  const other = walker("o", 12, 1, -12, 1);
  let wp = 0, op = 0;
  const wr = route.slice(), orr: number[] = [];
  nav.path(12, 1, -12, 1, orr);
  const body: Body = { x: 0, y: 0, z: 0, vy: 0, radius: 0.3, height: 1.7, grounded: true };
  for (let t = 0; t < 60 * 60 && !(w.done && other.done); t++) {
    for (const [m, r, k] of [[w, wr, 0], [other, orr, 1]] as const) {
      let i = k === 0 ? wp : op;
      if (i * 2 + 1 < r.length) { m.gx = r[i * 2]; m.gz = r[i * 2 + 1]; if (Math.hypot(m.gx - m.x, m.gz - m.z) < 0.4) i++; }
      if (k === 0) wp = i; else op = i;
      if (i * 2 + 1 >= r.length) { m.gx = k === 0 ? 12 : -12; m.gz = k === 0 ? 0 : 1; }
    }
    stepAll([w, other], [], [lab]);
    for (const m of [w, other]) {
      body.x = m.x; body.z = m.z; body.y = 0; pushOut([lab], body);
      assert.ok(!(Math.abs(m.x) < 7 && Math.abs(m.z) < 4), `${m.id} inside the building at ${m.x.toFixed(1)},${m.z.toFixed(1)}`);
    }
  }
  assert.ok(w.done && other.done, "both reached the far side of the building");
}

// 5. Seat reservation: a 2-seat bench with five claimants hands out exactly two seats; leaving frees one.
{
  const slots: (string | null)[] = [null, null];
  const got = ["a", "b", "c", "d", "e"].map((who) => claimSlot(slots, who));
  assert.deepEqual(got, [0, 1, -1, -1, -1]);
  assert.equal(claimSlot(slots, "a"), 0, "a sitter re-claiming keeps their seat");
  freeSlot(slots, "a");
  assert.equal(claimSlot(slots, "c"), 0, "the freed seat goes to the next person");
  assert.equal(claimSlot(slots, "d"), -1);
  freeSlot(slots, "nobody"); // no-op
  assert.deepEqual(slots, ["c", "b"]);
}

// 6. Seat height from colliders: bench seat 0.45 m, a bench back (1.0 m) is ignored, no seat -> 0.45 fallback, raised floor.
{
  const seat = box(0, 0, 1.6, 0.5, 0.45), back = box(0, -0.3, 1.6, 0.1, 1.0), onStep = box(10, 0, 1.6, 0.5, 0.45, 0.3);
  assert.ok(Math.abs(seatHeight([seat, back], 0, 0, 0) - 0.45) < 1e-9);
  assert.ok(Math.abs(seatHeight([seat, back], 5, 5, 0) - 0.45) < 1e-9, "fallback");
  assert.ok(Math.abs(seatHeight([onStep], 10, 0, 0.3) - 0.45) < 1e-9, "seat measured from the floor under it");
}

// 7. Rig-aware sit drop across body types: pelvis on the seat for short legs, soles on the floor for long legs, never absurd.
{
  const bodies = [{ n: "short", h: 0.88, f: 0.36 }, { n: "average", h: 0.95, f: 0.4 }, { n: "tall", h: 1.05, f: 0.5 }, { n: "broad", h: 0.98, f: 0.42 }, { n: "child", h: 0.7, f: 0.28 }];
  for (const b of bodies) {
    const drop = sitLift(b.h, b.f, 0.45);
    assert.ok(drop >= 0 && drop <= 0.7, `${b.n} drop ${drop}`);
    const pelvisAboveSeat = b.h - drop - 0.45, soleAboveFloor = b.f - drop;
    assert.ok(soleAboveFloor >= -0.031, `${b.n} soles sink ${soleAboveFloor.toFixed(3)}`);
    assert.ok(pelvisAboveSeat >= 0.1 - 1e-9, `${b.n} pelvis ${pelvisAboveSeat.toFixed(3)} never below the seat`);
  }
  assert.ok(Math.abs(sitLift(0.95, 0.6, 0.45) - 0.4) < 1e-9, "short legs: pelvis exactly on the seat");
  assert.ok(Math.abs(sitLift(1.05, 0.3, 0.45) - 0.33) < 1e-9, "long legs: soles stop at the floor");
}

// 8. Repeated sit -> stand -> walk: the drop returns to exactly 0 every cycle (the 0.37 m sink bug) and never overshoots.
{
  let sit = 0, lift = 0;
  const drop = 0.38;
  for (let cycle = 0; cycle < 6; cycle++) {
    for (let f = 0; f < 600; f++) { sit += (1 - sit) * (1 - Math.exp(-6 * DT)); lift = sit * drop; } // sitting down
    assert.ok(Math.abs(lift - drop) < 0.01, `seated drop ${lift}`);
    let prev = lift;
    for (let f = 0; f < 120; f++) { // standing up, 2 s of walking: the game's decay
      sit = sit < 0.01 ? 0 : sit * Math.exp(-7 * DT); lift = sit * drop;
      assert.ok(lift <= prev + 1e-12 && prev - lift < 0.05, "stand-up eases, never pops"); prev = lift;
    }
    assert.equal(lift, 0, `walking again with no drop (cycle ${cycle})`);
  }
}

console.log("npc movement checks passed");
