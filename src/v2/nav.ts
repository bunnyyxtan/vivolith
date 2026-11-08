// Coarse walkable grid + A* over the collider boxes, for townsfolk path-finding.
// Cells are blocked by any box that would stop a standing person (same rule as pushOut at ground level).
// ponytail: static snapshot, rebuilt when the collider count changes; add dynamic obstacles if doors/props move.
import type { Box } from "../physics/collision";

/** Townsfolk step up curbs and stairs but walk around anything taller (planters, low walls, bench seats). */
export const NPC_STEP = 0.2;

const CELL = 1;
const PAD = 0.5; // body radius + margin
const MAX_CELLS = 700;
const SQRT2 = Math.SQRT2;

export interface Nav {
  /** True when the cell under (x, z) is walkable. */
  clear(x: number, z: number): boolean;
  /** Writes the nearest walkable cell centre to out; false when none within ~10 m. */
  nearestFree(x: number, z: number, out: { x: number; z: number }): boolean;
  /** Fills out with x,z pairs from just after (ax, az) to the goal cell centre. False when unreachable. */
  path(ax: number, az: number, bx: number, bz: number, out: number[]): boolean;
}

export function createNav(colliders: readonly Box[]): Nav {
  let ox = 0, oz = 0, w = 1, h = 1, count = -1;
  let blocked = new Uint8Array(1);
  let gScore = new Float32Array(1), parent = new Int32Array(1), seen = new Uint32Array(1), closed = new Uint32Array(1);
  let gen = 0;

  const rebuild = (): void => {
    count = colliders.length;
    let x0 = 1e9, z0 = 1e9, x1 = -1e9, z1 = -1e9;
    for (const b of colliders) {
      x0 = Math.min(x0, b.minX); z0 = Math.min(z0, b.minZ); x1 = Math.max(x1, b.maxX); z1 = Math.max(z1, b.maxZ);
    }
    if (x0 > x1) { x0 = z0 = -50; x1 = z1 = 50; }
    ox = x0 - 4; oz = z0 - 4;
    w = Math.min(MAX_CELLS, Math.ceil((x1 - x0 + 8) / CELL));
    h = Math.min(MAX_CELLS, Math.ceil((z1 - z0 + 8) / CELL));
    blocked = new Uint8Array(w * h);
    gScore = new Float32Array(w * h); parent = new Int32Array(w * h);
    seen = new Uint32Array(w * h); closed = new Uint32Array(w * h);
    gen = 0;
    for (const b of colliders) {
      if (b.maxY <= NPC_STEP || b.minY >= 1.8) continue;
      const i0 = Math.max(0, Math.floor((b.minX - PAD - ox) / CELL)), i1 = Math.min(w - 1, Math.floor((b.maxX + PAD - ox) / CELL));
      const j0 = Math.max(0, Math.floor((b.minZ - PAD - oz) / CELL)), j1 = Math.min(h - 1, Math.floor((b.maxZ + PAD - oz) / CELL));
      for (let j = j0; j <= j1; j++) {
        const cz = oz + (j + 0.5) * CELL;
        if (cz < b.minZ - PAD || cz > b.maxZ + PAD) continue;
        for (let i = i0; i <= i1; i++) {
          const cx = ox + (i + 0.5) * CELL;
          if (cx >= b.minX - PAD && cx <= b.maxX + PAD) blocked[j * w + i] = 1;
        }
      }
    }
  };
  const ensure = (): void => { if (count !== colliders.length) rebuild(); };
  const idx = (x: number, z: number): number => {
    const i = Math.floor((x - ox) / CELL), j = Math.floor((z - oz) / CELL);
    return i < 0 || j < 0 || i >= w || j >= h ? -1 : j * w + i;
  };
  const free = (i: number): boolean => i >= 0 && blocked[i] === 0;
  const los = (ax: number, az: number, bx: number, bz: number): boolean => {
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 0.4));
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      if (!free(idx(ax + (bx - ax) * t, az + (bz - az) * t))) return false;
    }
    return true;
  };

  const nearestFree: Nav["nearestFree"] = (x, z, out) => {
    ensure();
    const c = idx(x, z);
    if (free(c)) { out.x = x; out.z = z; return true; }
    const ci = Math.floor((x - ox) / CELL), cj = Math.floor((z - oz) / CELL);
    for (let r = 1; r <= 10; r++) {
      let best = -1, bd = 1e9;
      for (let j = cj - r; j <= cj + r; j++) {
        for (let i = ci - r; i <= ci + r; i++) {
          if (Math.max(Math.abs(i - ci), Math.abs(j - cj)) !== r || i < 0 || j < 0 || i >= w || j >= h) continue;
          if (blocked[j * w + i]) continue;
          const d = Math.hypot(ox + (i + 0.5) * CELL - x, oz + (j + 0.5) * CELL - z);
          if (d < bd) { bd = d; best = j * w + i; }
        }
      }
      if (best >= 0) { out.x = ox + ((best % w) + 0.5) * CELL; out.z = oz + (Math.floor(best / w) + 0.5) * CELL; return true; }
    }
    return false;
  };

  const heap: number[] = []; // [f0, idx0, f1, idx1, ...] binary min-heap on f
  const push = (f: number, n: number): void => {
    let i = heap.length >> 1;
    heap.push(f, n);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p * 2] <= f) break;
      heap[i * 2] = heap[p * 2]; heap[i * 2 + 1] = heap[p * 2 + 1];
      i = p;
    }
    heap[i * 2] = f; heap[i * 2 + 1] = n;
  };
  const pop = (): number => {
    const top = heap[1];
    const f = heap[heap.length - 2], n = heap[heap.length - 1];
    heap.length -= 2;
    const size = heap.length >> 1;
    if (size > 0) {
      let i = 0;
      for (;;) {
        let c = i * 2 + 1;
        if (c >= size) break;
        if (c + 1 < size && heap[(c + 1) * 2] < heap[c * 2]) c++;
        if (heap[c * 2] >= f) break;
        heap[i * 2] = heap[c * 2]; heap[i * 2 + 1] = heap[c * 2 + 1];
        i = c;
      }
      heap[i * 2] = f; heap[i * 2 + 1] = n;
    }
    return top;
  };

  const cell = { x: 0, z: 0 };
  const path: Nav["path"] = (ax, az, bx, bz, out) => {
    ensure();
    out.length = 0;
    if (!nearestFree(ax, az, cell)) return false;
    const s = idx(cell.x, cell.z);
    if (!nearestFree(bx, bz, cell)) return false;
    const goal = idx(cell.x, cell.z), gx = cell.x, gz = cell.z;
    if (s < 0 || goal < 0) return false;
    gen++;
    heap.length = 0;
    const gi = goal % w, gj = Math.floor(goal / w);
    const hF = (i: number, j: number): number => {
      const dx = Math.abs(i - gi), dz = Math.abs(j - gj);
      return Math.max(dx, dz) + (SQRT2 - 1) * Math.min(dx, dz);
    };
    gScore[s] = 0; parent[s] = -1; seen[s] = gen;
    push(hF(s % w, Math.floor(s / w)), s);
    let found = false;
    while (heap.length) {
      const n = pop();
      if (closed[n] === gen) continue;
      closed[n] = gen;
      if (n === goal) { found = true; break; }
      const ni = n % w, nj = Math.floor(n / w);
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          if (!di && !dj) continue;
          const i = ni + di, j = nj + dj;
          if (i < 0 || j < 0 || i >= w || j >= h) continue;
          const m = j * w + i;
          if (blocked[m] || closed[m] === gen) continue;
          if (di && dj && (blocked[nj * w + i] || blocked[j * w + ni])) continue; // no corner cutting
          const g = gScore[n] + (di && dj ? SQRT2 : 1);
          if (seen[m] !== gen || g < gScore[m]) {
            seen[m] = gen; gScore[m] = g; parent[m] = n;
            push(g + hF(i, j), m);
          }
        }
      }
    }
    if (!found) return false;
    const cells: number[] = [];
    for (let n = goal; n >= 0; n = parent[n]) cells.push(n);
    cells.reverse(); // start..goal
    // string-pull: farthest cell in line of sight from the current anchor
    let px = ax, pz = az, k = 0;
    while (k < cells.length - 1) {
      let j = cells.length - 1;
      for (; j > k + 1; j--) {
        if (los(px, pz, ox + ((cells[j] % w) + 0.5) * CELL, oz + (Math.floor(cells[j] / w) + 0.5) * CELL)) break;
      }
      k = j;
      px = ox + ((cells[k] % w) + 0.5) * CELL; pz = oz + (Math.floor(cells[k] / w) + 0.5) * CELL;
      out.push(px, pz);
    }
    if (!out.length) out.push(gx, gz);
    return true;
  };

  return { clear: (x, z) => { ensure(); return free(idx(x, z)); }, nearestFree, path };
}
