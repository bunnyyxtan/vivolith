// Pure map maths (no DOM, no three): city bounds from the real geometry, fit-to-city framing, label decluttering and
// pointer hit-testing. Run the checks with: node src/v2/map.check.ts
export interface Rect { x0: number; z0: number; x1: number; z1: number }
export interface Footprint extends Rect { h: number }
export interface View { cx: number; cz: number; zoom: number } // world centre (m) and screen pixels per metre
export interface BoxLike { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number }

/** Building footprints from collision boxes: tall enough to stop you, not ground slabs, not poles and planters. */
export function footprints(boxes: readonly BoxLike[]): Footprint[] {
  const out: Footprint[] = [];
  for (const b of boxes) {
    const w = b.maxX - b.minX, d = b.maxZ - b.minZ;
    if (b.maxY - b.minY < 2.5 || w > 80 || d > 80 || w * d < 6) continue;
    out.push({ x0: b.minX, z0: b.minZ, x1: b.maxX, z1: b.maxZ, h: b.maxY });
  }
  return out;
}

const union = (a: Rect | null, x0: number, z0: number, x1: number, z1: number): Rect =>
  a ? { x0: Math.min(a.x0, x0), z0: Math.min(a.z0, z0), x1: Math.max(a.x1, x1), z1: Math.max(a.z1, z1) } : { x0, z0, x1, z1 };

/** The city's real extent: road lanes (with their width), districts and named places; buildings only when they touch
 *  that area, so a stray far-off collider cannot shrink the map. */
export function cityBounds(lanes: readonly (readonly (readonly number[])[])[], roadWidth: number, districts: readonly Rect[], points: readonly { x: number; z: number }[], feet: readonly Rect[]): Rect {
  let b: Rect | null = null;
  const r = roadWidth / 2;
  for (const l of lanes) for (const [x, z] of l) b = union(b, x - r, z - r, x + r, z + r);
  for (const d of districts) b = union(b, d.x0, d.z0, d.x1, d.z1);
  for (const p of points) b = union(b, p.x, p.z, p.x, p.z);
  if (!b) return { x0: -50, z0: -50, x1: 50, z1: 50 };
  const core = { x0: b.x0 - 12, z0: b.z0 - 12, x1: b.x1 + 12, z1: b.z1 + 12 };
  for (const f of feet) if (f.x1 >= core.x0 && f.x0 <= core.x1 && f.z1 >= core.z0 && f.z0 <= core.z1) b = union(b, f.x0, f.z0, f.x1, f.z1);
  return b;
}

/** The view that shows `b` filling `frac` of the viewport's limiting side, centred. */
export function fitView(b: Rect, vw: number, vh: number, frac: number): View {
  const bw = Math.max(1, b.x1 - b.x0), bh = Math.max(1, b.z1 - b.z0);
  return { cx: (b.x0 + b.x1) / 2, cz: (b.z0 + b.z1) / 2, zoom: Math.min((vw * frac) / bw, (vh * frac) / bh) };
}

/** Share of the viewport the city covers (the larger of the width and height shares) at a view. */
export function coverage(b: Rect, v: View, vw: number, vh: number): number {
  return Math.max(((b.x1 - b.x0) * v.zoom) / vw, ((b.z1 - b.z0) * v.zoom) / vh);
}

export interface Label {
  readonly id: string;
  readonly text: string;
  readonly x: number; readonly y: number; // marker anchor on screen
  readonly r: number;                     // marker radius (px)
  readonly w: number; readonly h: number; // text box
  readonly priority: number;              // higher wins
  /** Centred exactly on (x, y), no alternative spots (area names inside a district). */
  readonly fixed?: boolean;
}
export interface Placed { readonly id: string; readonly x: number; readonly y: number; readonly box: Rect }

const hit = (a: Rect, b: Rect, pad: number): boolean => a.x0 < b.x1 + pad && a.x1 > b.x0 - pad && a.z0 < b.z1 + pad && a.z1 > b.z0 - pad;

/** Greedy label placement: highest priority first, each tries above, below, right, left of its marker and is dropped when
 *  every spot would overlap an earlier label or any marker. Returns the labels that fit, with their centre positions. */
export function declutter(labels: readonly Label[], markers: readonly { x: number; y: number; r: number }[], view: { w: number; h: number }): Placed[] {
  const taken: Rect[] = markers.map((m) => ({ x0: m.x - m.r, z0: m.y - m.r, x1: m.x + m.r, z1: m.y + m.r }));
  const out: Placed[] = [];
  for (const l of [...labels].sort((a, b) => b.priority - a.priority)) {
    const gap = l.r + 3;
    const spots: [number, number][] = l.fixed ? [[0, 0]] : [[0, -(gap + l.h / 2)], [0, gap + l.h / 2], [gap + l.w / 2, 0], [-(gap + l.w / 2), 0]];
    for (const [dx, dy] of spots) {
      const cx = l.x + dx, cy = l.y + dy;
      const box = { x0: cx - l.w / 2, z0: cy - l.h / 2, x1: cx + l.w / 2, z1: cy + l.h / 2 };
      if (box.x0 < 4 || box.z0 < 4 || box.x1 > view.w - 4 || box.z1 > view.h - 4) continue;
      if (taken.some((t) => hit(box, t, 2))) continue;
      taken.push(box); out.push({ id: l.id, x: cx, y: cy, box }); break;
    }
  }
  return out;
}

/** The nearest marker within `maxPx` of a screen point, or null. Later markers win ties (they are drawn on top). */
export function pick<T extends { x: number; y: number; r: number }>(items: readonly T[], px: number, py: number, maxPx: number): T | null {
  let best: T | null = null, bd = Infinity;
  for (const m of items) {
    const d = Math.hypot(m.x - px, m.y - py);
    if (d <= Math.max(maxPx, m.r) && d <= bd) { best = m; bd = d; }
  }
  return best;
}

/** Where the ray from the centre towards (dx, dy) leaves a square of half-size `half` (for pinning far markers to the edge). */
export function edgePoint(dx: number, dy: number, half: number): { x: number; y: number } {
  const m = Math.max(Math.abs(dx), Math.abs(dy)) || 1;
  return { x: (dx / m) * half, y: (dy / m) * half };
}

/** Length of a polyline given as flat x,z pairs, starting at (sx, sz). */
export function routeLength(sx: number, sz: number, flat: readonly number[]): number {
  let len = 0, px = sx, pz = sz;
  for (let i = 0; i + 1 < flat.length; i += 2) { len += Math.hypot(flat[i] - px, flat[i + 1] - pz); px = flat[i]; pz = flat[i + 1]; }
  return len;
}
