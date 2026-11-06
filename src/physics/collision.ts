// Pure, dependency-free character collision: a vertical cylinder vs axis-aligned boxes.
// Kept free of three.js so it can be checked with plain `node` (see collision.check.ts).
// ponytail: O(n) scan over every box per frame; add a spatial grid if box count passes ~2k.

export interface Box {
  minX: number; minY: number; minZ: number;
  maxX: number; maxY: number; maxZ: number;
}

export interface Body {
  x: number; y: number; z: number; // feet position
  vy: number;
  radius: number;
  height: number;
  grounded: boolean;
}

export const STEP_HEIGHT = 0.4;
export const GRAVITY = 20;

export function box(cx: number, cz: number, w: number, d: number, h: number, baseY = 0): Box {
  return { minX: cx - w / 2, maxX: cx + w / 2, minZ: cz - d / 2, maxZ: cz + d / 2, minY: baseY, maxY: baseY + h };
}

/** Highest walkable surface under the body's centre that it can step onto. */
export function groundHeightAt(boxes: readonly Box[], x: number, z: number, feetY: number): number {
  let ground = 0;
  for (const b of boxes) {
    if (x < b.minX || x > b.maxX || z < b.minZ || z > b.maxZ) continue;
    if (b.maxY <= feetY + STEP_HEIGHT && b.maxY > ground) ground = b.maxY;
  }
  return ground;
}

/** Push the body's circle out of every box it overlaps at its current height. */
export function pushOut(boxes: readonly Box[], body: Body): void {
  for (let pass = 0; pass < 2; pass++) {
    for (const b of boxes) {
      if (b.maxY <= body.y + STEP_HEIGHT || b.minY >= body.y + body.height) continue;
      const cx = Math.min(Math.max(body.x, b.minX), b.maxX);
      const cz = Math.min(Math.max(body.z, b.minZ), b.maxZ);
      const dx = body.x - cx;
      const dz = body.z - cz;
      const distSq = dx * dx + dz * dz;
      if (distSq >= body.radius * body.radius) continue;
      if (distSq > 1e-9) {
        const dist = Math.sqrt(distSq);
        const push = body.radius - dist;
        body.x += (dx / dist) * push;
        body.z += (dz / dist) * push;
        continue;
      }
      // Centre is inside the box: leave along the shallowest side.
      const exits = [
        { d: body.x - b.minX, x: b.minX - body.radius, z: body.z },
        { d: b.maxX - body.x, x: b.maxX + body.radius, z: body.z },
        { d: body.z - b.minZ, x: body.x, z: b.minZ - body.radius },
        { d: b.maxZ - body.z, x: body.x, z: b.maxZ + body.radius },
      ];
      const best = exits.reduce((a, e) => (e.d < a.d ? e : a));
      body.x = best.x;
      body.z = best.z;
    }
  }
}

/** Advance one physics step: horizontal move, collision, gravity, ground snap. */
export function stepBody(boxes: readonly Box[], body: Body, moveX: number, moveZ: number, dt: number): void {
  body.x += moveX;
  body.z += moveZ;
  pushOut(boxes, body);

  const feetBefore = body.y;
  body.vy -= GRAVITY * dt;
  body.y += body.vy * dt;

  const ground = groundHeightAt(boxes, body.x, body.z, feetBefore);
  if (body.y <= ground) {
    body.y = ground;
    body.vy = 0;
    body.grounded = true;
  } else {
    body.grounded = false;
  }
}
