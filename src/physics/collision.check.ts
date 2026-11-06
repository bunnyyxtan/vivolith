// Run: node src/physics/collision.check.ts   (Node 24 strips the types natively)
import assert from "node:assert/strict";
import { box, stepBody, type Body } from "./collision.ts";

const body = (x: number, z: number, y = 0): Body => ({ x, y, z, vy: 0, radius: 0.35, height: 1.8, grounded: false });

// Walking into a wall stops at the wall's surface + radius.
const wall = [box(0, 0, 2, 2, 3)];
const a = body(-2, 0);
for (let i = 0; i < 60; i++) stepBody(wall, a, 0.05, 0, 1 / 60);
assert.ok(Math.abs(a.x - (-1 - 0.35)) < 1e-6, `wall stop x=${a.x}`);

// A low curb (0.25 m) is stepped onto, not blocked.
const curb = [box(0, 0, 2, 2, 0.25)];
const b = body(-2, 0);
for (let i = 0; i < 40; i++) stepBody(curb, b, 0.05, 0, 1 / 60); // ends at x=0, curb centre
assert.ok(b.x > -0.5 && Math.abs(b.y - 0.25) < 1e-6, `curb step x=${b.x} y=${b.y}`);

// Falling lands on the ground and reports grounded.
const c = body(5, 5, 3);
for (let i = 0; i < 120; i++) stepBody([], c, 0, 0, 1 / 60);
assert.equal(c.y, 0);
assert.equal(c.grounded, true);

// Spawned inside a box: pushed out of the nearest side.
const d = body(0.9, 0);
stepBody(wall, d, 0, 0, 1 / 60);
assert.ok(Math.abs(d.x - 1.35) < 1e-6, `inside push x=${d.x}`);

console.log("collision checks passed");
