// Run: node src/v2/map.check.ts   (Node strips the types natively)
// Map maths: the city is framed from its real bounds at 75-85% of the viewport, labels never overlap, hit-testing picks the
// nearest marker, far markers pin to the frame, routes are measured along the path.
import assert from "node:assert/strict";
import { cityBounds, coverage, declutter, edgePoint, fitView, footprints, pick, routeLength, type Label } from "./maplayout.ts";

const lanes = [[[-70, -100], [-70, 90]], [[-70, 90], [60, 90]], [[60, 90], [60, -100]]];
const districts = [{ x0: -59, z0: -94, x1: -34.5, z1: -74 }, { x0: 34.5, z0: -94, x1: 59, z1: -74 }];
const box = (minX: number, minZ: number, maxX: number, maxZ: number, h = 10) => ({ minX, minY: 0, minZ, maxX, maxY: h, maxZ });

// 1. Only buildings count: slabs, poles and low props are dropped.
{
  const f = footprints([box(0, 0, 10, 10), box(0, 0, 200, 10), box(0, 0, 1, 1), box(0, 0, 10, 10, 1)]);
  assert.equal(f.length, 1, "one real building out of four boxes");
}

// 2. Bounds come from the real geometry; a stray far-off box does not stretch them, a building at the edge does.
{
  const feet = footprints([box(-80, -20, -72, 0), box(900, 900, 910, 910)]);
  const b = cityBounds(lanes, 7, districts, [{ x: 0, z: 0 }], feet);
  assert.ok(b.x0 <= -80 && b.x1 < 70, "edge building included, nothing near x=900");
  assert.ok(b.z1 < 100 && b.z0 > -110, "stray box ignored");
}

// 3. Fit: the city covers 75-85% of the limiting side at any viewport, from a phone to a wide monitor.
{
  const b = cityBounds(lanes, 7, districts, [], []);
  for (const [w, h] of [[390, 760], [800, 600], [1280, 720], [1920, 1080], [2560, 1080]]) {
    const c = coverage(b, fitView(b, w, h, 0.8), w, h);
    assert.ok(c >= 0.75 && c <= 0.85, `${w}x${h}: city covers ${(c * 100).toFixed(0)}%`);
  }
  const v = fitView(b, 1000, 800, 0.8);
  assert.ok(Math.abs(v.cx - (b.x0 + b.x1) / 2) < 1e-9 && Math.abs(v.cz - (b.z0 + b.z1) / 2) < 1e-9, "centred on the city");
}

// 4. Declutter: no two labels overlap each other or a marker, priority wins, and nothing leaves the viewport.
{
  const mk = (id: string, x: number, y: number, priority: number): Label => ({ id, text: id, x, y, r: 10, w: 90, h: 17, priority });
  const labels = [mk("low", 100, 100, 10), mk("high", 120, 100, 90), mk("mid", 400, 300, 50), mk("edge", 3, 3, 40)];
  const markers = labels.map((l) => ({ x: l.x, y: l.y, r: l.r }));
  const placed = declutter(labels, markers, { w: 800, h: 600 });
  assert.ok(placed.find((p) => p.id === "high"), "the high priority label is placed");
  for (let i = 0; i < placed.length; i++) {
    const a = placed[i].box;
    assert.ok(a.x0 >= 4 && a.z0 >= 4 && a.x1 <= 796 && a.z1 <= 596, `${placed[i].id} inside the viewport`);
    for (const m of markers) assert.ok(!(a.x0 < m.x + m.r && a.x1 > m.x - m.r && a.z0 < m.y + m.r && a.z1 > m.y - m.r), `${placed[i].id} clear of markers`);
    for (let j = i + 1; j < placed.length; j++) { const c = placed[j].box; assert.ok(a.x1 <= c.x0 || c.x1 <= a.x0 || a.z1 <= c.z0 || c.z1 <= a.z0, `${placed[i].id} and ${placed[j].id} do not overlap`); }
  }
  const crowd = declutter(Array.from({ length: 30 }, (_, i) => mk(`c${i}`, 200 + (i % 3), 200, i)), [], { w: 800, h: 600 });
  assert.ok(crowd.length < 30, "a pile of labels on one spot is thinned, not stacked");
  const fixed = declutter([{ ...mk("zone", 300, 300, 1), r: 0, fixed: true }], [], { w: 800, h: 600 });
  assert.deepEqual([fixed[0].x, fixed[0].y], [300, 300], "a fixed label stays centred where it is asked");
}

// 5. Hit-testing and edge pinning.
{
  const items = [{ id: "a", x: 100, y: 100, r: 9 }, { id: "b", x: 108, y: 100, r: 9 }];
  assert.equal(pick(items, 107, 100, 12)?.id, "b", "nearest marker wins");
  assert.equal(pick(items, 300, 300, 12), null, "empty space picks nothing");
  const e = edgePoint(300, 100, 80);
  assert.ok(Math.abs(e.x - 80) < 1e-9 && Math.abs(e.y - 80 / 3) < 1e-9, "pinned to the frame along the same direction");
  assert.deepEqual(edgePoint(0, 0, 50), { x: 0, y: 0 });
}

// 6. Route length is the sum of its segments.
assert.equal(routeLength(0, 0, [3, 4, 3, 10]), 11);

console.log("map checks passed");
