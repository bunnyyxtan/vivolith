// NEAR City sign system: canvas-lettered textures, sign kinds with real geometry, and the town placement.
// Logos use the official SVG paths (public/brand/near-symbol.svg, near-wordmark.svg) via Path2D, never redrawn.
// Everything is merged per material at the end, so the whole set costs a handful of draw calls.
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { box, type Box } from "../physics/collision";

export const BRAND = { mint: "#00EC97", ink: "#1f2a26", cream: "#f4efe0" } as const;
const FONT = '"Inter Tight", system-ui, sans-serif';

// ------------------------------------------------------------------ logos --
interface LogoArt { paths: Path2D[]; x: number; y: number; w: number; h: number }
const logos: { symbol?: LogoArt; wordmark?: LogoArt } = {};

async function loadLogo(url: string, bounds?: [number, number, number, number]): Promise<LogoArt> {
  const svg = await (await fetch(url)).text();
  const vb = /viewBox="([^"]+)"/.exec(svg)?.[1]?.split(/\s+/).map(Number) ?? [0, 0, 1, 1];
  const [x, y, w, h] = bounds ?? [vb[0] ?? 0, vb[1] ?? 0, vb[2] ?? 1, vb[3] ?? 1];
  const paths = [...svg.matchAll(/\sd="([^"]+)"/g)].map((m) => new Path2D(m[1]));
  return { paths, x, y, w, h };
}

/** Load fonts and the official logo paths. Must resolve before makeSignTexture is used. */
export async function loadBrandAssets(): Promise<void> {
  const fonts = ["400", "600", "700"].map((w) => document.fonts.load(`${w} 64px "Inter Tight"`).catch(() => []));
  const [symbol, wordmark] = await Promise.all([
    loadLogo("/brand/near-symbol.svg", [144, 144, 351, 351]), // visible N inside the 639 box
    loadLogo("/brand/near-wordmark.svg"),
    ...fonts,
  ]);
  logos.symbol = symbol;
  logos.wordmark = wordmark;
}

function drawLogo(ctx: CanvasRenderingContext2D, art: LogoArt | undefined, x: number, y: number, h: number, color: string): number {
  if (!art) return 0;
  const s = h / art.h;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(s, s);
  ctx.translate(-art.x, -art.y);
  ctx.fillStyle = color;
  for (const p of art.paths) ctx.fill(p);
  ctx.restore();
  return art.w * s;
}

// --------------------------------------------------------------- textures --
export interface SignLine { text: string; size: number; weight?: 400 | 600 | 700; dim?: boolean }
export type SignStyleName = "civic" | "dark" | "mint";
export interface SignSpec {
  lines: SignLine[];
  style?: SignStyleName;
  /** tile = mint square with the N symbol; wordmark = official wordmark under the text; none. */
  logo?: "tile" | "wordmark" | "none";
  aspect: number; // width / height of the face
  px?: number;    // longest side in pixels (default 1024)
  align?: "left" | "center";
}

const STYLES: Record<SignStyleName, { bg: string; fg: string; tile: string; tileFg: string; bar: string }> = {
  civic: { bg: BRAND.cream, fg: BRAND.ink, tile: BRAND.mint, tileFg: BRAND.ink, bar: BRAND.mint },
  dark: { bg: BRAND.ink, fg: BRAND.cream, tile: BRAND.mint, tileFg: BRAND.ink, bar: BRAND.mint },
  mint: { bg: BRAND.mint, fg: BRAND.ink, tile: BRAND.ink, tileFg: BRAND.mint, bar: BRAND.ink },
};

const texCache = new Map<string, THREE.CanvasTexture>();

export function makeSignTexture(spec: SignSpec): THREE.CanvasTexture {
  const key = JSON.stringify(spec);
  const hit = texCache.get(key);
  if (hit) return hit;
  const st = STYLES[spec.style ?? "civic"];
  const A = spec.aspect, px = spec.px ?? 1024;
  const W = A >= 1 ? px : Math.round(px * A), H = A >= 1 ? Math.round(px / A) : px;
  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = st.bg;
  ctx.fillRect(0, 0, W, H);
  const barH = Math.min(W, H) * 0.045;
  ctx.fillStyle = st.bar;
  ctx.fillRect(0, H - barH, W, barH);
  const m = Math.min(W, H) * 0.08;
  let x0 = m, y0 = m, x1 = W - m, y1 = H - m - barH * 0.6;
  const logo = spec.logo ?? "tile";
  if (logo === "tile") {
    const vertical = A < 0.9;
    const ts = vertical ? Math.min(x1 - x0, (y1 - y0) * 0.4) : y1 - y0;
    const tx = vertical ? (x0 + x1 - ts) / 2 : x0;
    ctx.fillStyle = st.tile;
    ctx.fillRect(tx, y0, ts, ts);
    const sh = ts * 0.66;
    drawLogo(ctx, logos.symbol, tx + (ts - sh) / 2, y0 + (ts - sh) / 2, sh, st.tileFg);
    if (vertical) y0 += ts + m * 0.8; else x0 += ts + m;
  } else if (logo === "wordmark") {
    const wh = (y1 - y0) * 0.2;
    drawLogo(ctx, logos.wordmark, x0, y1 - wh, wh, st.fg);
    y1 -= wh + m * 0.7;
  }
  const maxW = x1 - x0;
  ctx.textBaseline = "middle";
  ctx.textAlign = spec.align === "center" || (logo === "tile" && A < 0.9) ? "center" : "left";
  const px0 = ctx.textAlign === "center" ? (x0 + x1) / 2 : x0;
  const sized = spec.lines.map((l) => {
    let f = l.size * H;
    ctx.font = `${l.weight ?? 700} ${f}px ${FONT}`;
    const w = ctx.measureText(l.text).width;
    if (w > maxW) f *= maxW / w;
    return { l, f };
  });
  const total = sized.reduce((a, s) => a + s.f * 1.15, 0);
  let y = y0 + (y1 - y0 - total) / 2;
  for (const { l, f } of sized) {
    ctx.font = `${l.weight ?? 700} ${f}px ${FONT}`;
    ctx.globalAlpha = l.dim ? 0.7 : 1;
    ctx.fillStyle = st.fg;
    ctx.fillText(l.text, px0, y + f * 0.575);
    y += f * 1.15;
  }
  ctx.globalAlpha = 1;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  texCache.set(key, tex);
  return tex;
}

// --------------------------------------------------------------- geometry --
const MAT = {
  ink: new THREE.MeshStandardMaterial({ color: BRAND.ink, roughness: 0.7 }),
  mint: new THREE.MeshStandardMaterial({ color: BRAND.mint, roughness: 0.5, emissive: BRAND.mint, emissiveIntensity: 0.35 }),
  cream: new THREE.MeshStandardMaterial({ color: BRAND.cream, roughness: 0.8 }),
  glass: new THREE.MeshBasicMaterial({ color: BRAND.mint, transparent: true, opacity: 0.2, depthWrite: false, side: THREE.DoubleSide }),
};
const faceMats = new Map<THREE.Texture, THREE.MeshBasicMaterial>();
const faceMat = (t: THREE.Texture): THREE.MeshBasicMaterial => {
  let m = faceMats.get(t);
  if (!m) { m = new THREE.MeshBasicMaterial({ map: t }); faceMats.set(t, m); }
  return m;
};

type Mat = THREE.Material;
function bx(parent: THREE.Object3D, mat: Mat, w: number, h: number, d: number, x: number, y: number, z: number): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  parent.add(m);
  return m;
}
function cyl(parent: THREE.Object3D, mat: Mat, r: number, h: number, x: number, y: number, z: number): void {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 10), mat);
  m.position.set(x, y, z);
  parent.add(m);
}

export interface Footprint { x: number; z: number; w: number; d: number; h: number }
const fp = (o: THREE.Object3D, f: Footprint): void => { ((o.userData.footprints ??= []) as Footprint[]).push(f); };

/** Stepped slab: mint rim, ink body, lettered face(s). Local +Z is the front; origin at the slab centre. */
function slab(w: number, h: number, d: number, front: THREE.Texture, back?: THREE.Texture | null): THREE.Group {
  const g = new THREE.Group();
  bx(g, MAT.mint, w + 0.12, h + 0.12, d * 0.55, 0, 0, -d * 0.2);
  bx(g, MAT.ink, w + 0.04, h + 0.04, d, 0, 0, 0);
  const f = new THREE.Mesh(new THREE.PlaneGeometry(w, h), faceMat(front));
  f.position.z = d / 2 + 0.012;
  g.add(f);
  if (back) {
    const b = new THREE.Mesh(new THREE.PlaneGeometry(w, h), faceMat(back));
    b.position.z = -d / 2 - 0.012;
    b.rotation.y = Math.PI;
    g.add(b);
  }
  return g;
}

// ------------------------------------------------------------------ signs --
export type SignKind = "gateway" | "fascia" | "blade" | "street" | "stop" | "billboard" | "banner" | "roof";
export interface SignOpts {
  lines: SignLine[];
  /** Second face text (gateway, blade, street, banner); defaults to the front. */
  back?: SignLine[];
  /** Street sign: second blade. Stop: flag text and ad panel text. */
  extra?: SignLine[];
  ad?: SignLine[];
  style?: SignStyleName;
  logo?: "tile" | "wordmark" | "none";
  width?: number;
  height?: number;
  /** Gap between the wall and a fascia slab (brackets bridge it). */
  gap?: number;
}

function tex(o: SignOpts, lines: SignLine[], w: number, h: number, px = 1024, style = o.style, logo = o.logo): THREE.CanvasTexture {
  return makeSignTexture({ lines, style, logo, aspect: w / h, px });
}

export function makeSign(kind: SignKind, o: SignOpts): THREE.Object3D {
  const root = new THREE.Group();
  root.name = `SIGN:${o.lines[0]?.text ?? kind}`; // the city map finds named places by their real signs
  switch (kind) {
    case "gateway": {
      const span = o.width ?? 11, h = o.height ?? 1.9, postH = 6.4;
      const head = slab(span + 0.5, h, 0.5, tex(o, o.lines, span + 0.5, h, 2048), tex(o, o.back ?? o.lines, span + 0.5, h, 2048));
      head.position.y = postH - h / 2;
      root.add(head);
      bx(root, MAT.mint, span, 0.06, 0.3, 0, postH - h - 0.05, 0);
      for (const s of [-1, 1]) {
        bx(root, MAT.ink, 0.55, postH - h, 0.55, s * span / 2, (postH - h) / 2, 0);
        bx(root, MAT.mint, 0.7, 0.1, 0.7, s * span / 2, 0.05, 0);
        fp(root, { x: s * span / 2, z: 0, w: 0.7, d: 0.7, h: postH });
      }
      break;
    }
    case "fascia": {
      const w = o.width ?? 3, h = o.height ?? 0.75, gap = o.gap ?? 0.12;
      const s = slab(w, h, 0.12, tex(o, o.lines, w, h));
      s.position.z = gap + 0.06;
      root.add(s);
      for (const sx of [-1, 1]) bx(root, MAT.ink, 0.08, 0.08, gap + 0.02, sx * (w / 2 - 0.25), 0, (gap + 0.02) / 2);
      break;
    }
    case "blade": {
      const w = o.width ?? 0.85;
      bx(root, MAT.ink, 0.05, 0.05, 1.3, 0, 0, 0.65);
      bx(root, MAT.mint, 0.09, 0.09, 0.09, 0, 0, 1.3);
      const s = slab(w, w, 0.07, tex(o, o.lines, w, w, 512), tex(o, o.back ?? o.lines, w, w, 512));
      s.rotation.y = Math.PI / 2;
      s.position.set(0, -0.2 - w / 2, 0.85);
      root.add(s);
      for (const sz of [-0.3, 0.3]) bx(root, MAT.ink, 0.015, 0.2, 0.015, 0, -0.1, 0.85 + sz);
      break;
    }
    case "street": {
      const w = 1.35, h = 0.32, poleH = 3.2;
      cyl(root, MAT.ink, 0.045, poleH, 0, poleH / 2, 0);
      cyl(root, MAT.mint, 0.07, 0.1, 0, poleH + 0.05, 0);
      const a = slab(w, h, 0.05, tex(o, o.lines, w, h, 1024, "civic", "tile"), tex(o, o.lines, w, h, 1024, "civic", "tile"));
      a.position.y = poleH - 0.3;
      root.add(a);
      const b = slab(w, h, 0.05, tex(o, o.extra ?? o.lines, w, h, 1024, "dark", "tile"), tex(o, o.extra ?? o.lines, w, h, 1024, "dark", "tile"));
      b.position.y = poleH - 0.75;
      b.rotation.y = Math.PI / 2;
      root.add(b);
      fp(root, { x: 0, z: 0, w: 0.2, d: 0.2, h: poleH });
      break;
    }
    case "stop": {
      // origin: back-centre at ground, front (+Z) faces the road
      const L = 3.6;
      bx(root, MAT.cream, L + 0.1, 0.1, 1.5, 0, 2.6, 0.7);
      bx(root, MAT.mint, L + 0.1, 0.04, 1.5, 0, 2.53, 0.7);
      for (const sx of [-1, 1]) bx(root, MAT.ink, 0.08, 2.6, 0.08, sx * (L / 2 - 0.05), 1.3, 1.3);
      bx(root, MAT.glass, L - 0.1, 2.2, 0.03, 0, 1.3, 0.1);
      bx(root, MAT.ink, 2.4, 0.06, 0.4, 0, 0.5, 0.35);
      for (const sx of [-1, 1]) bx(root, MAT.ink, 0.06, 0.5, 0.35, sx * 1.1, 0.25, 0.35);
      const hs = slab(L + 0.1, 0.55, 0.1, tex(o, o.lines, L + 0.1, 0.55, 1024, "dark", "tile"), tex(o, o.lines, L + 0.1, 0.55, 1024, "dark", "tile"));
      hs.position.set(0, 2.6 + 0.05 + 0.3, 1.42);
      root.add(hs);
      cyl(root, MAT.ink, 0.04, 3.3, L / 2 + 0.2, 1.65, 1.4);
      const fl = slab(0.55, 0.55, 0.05, tex(o, o.extra ?? o.lines, 0.55, 0.55, 512, "mint", "none"), tex(o, o.extra ?? o.lines, 0.55, 0.55, 512, "mint", "none"));
      fl.position.set(L / 2 + 0.2, 3.5, 1.4);
      fl.rotation.y = Math.PI / 2;
      root.add(fl);
      if (o.ad) {
        const ad = slab(1.1, 1.7, 0.05, tex(o, o.ad, 1.1, 1.7, 1024, "dark", "tile"));
        ad.position.set(-L / 2 + 0.75, 1.3, 0.14);
        root.add(ad);
      }
      fp(root, { x: 0, z: 0.7, w: L + 0.2, d: 1.5, h: 2.7 });
      break;
    }
    case "billboard": {
      const w = o.width ?? 8, h = o.height ?? 3.4, leg = 2.2;
      const s = slab(w, h, 0.3, tex(o, o.lines, w, h, 2048));
      s.position.y = leg + h / 2;
      root.add(s);
      for (const sx of [-1, 1]) bx(root, MAT.ink, 0.25, leg + 0.2, 0.25, sx * (w / 2 - 0.6), (leg + 0.2) / 2, -0.1);
      bx(root, MAT.ink, w, 0.08, 0.6, 0, leg - 0.04, 0.2);
      for (let i = 0; i < 3; i++) {
        const x = (i - 1) * (w / 3);
        bx(root, MAT.ink, 0.05, 0.05, 0.7, x, leg + h + 0.12, 0.45);
        bx(root, MAT.mint, 0.22, 0.1, 0.18, x, leg + h + 0.12, 0.85);
      }
      break;
    }
    case "banner": {
      const w = o.width ?? 0.62, h = o.height ?? 1.25;
      bx(root, MAT.ink, w + 0.1, 0.04, 0.04, 0, h / 2 + 0.02, 0);
      const s = slab(w, h, 0.03, tex(o, o.lines, w, h, 512), tex(o, o.back ?? o.lines, w, h, 512));
      root.add(s);
      break;
    }
    case "roof": {
      const w = o.width ?? 3.2, h = o.height ?? 0.8;
      const s = slab(w, h, 0.12, tex(o, o.lines, w, h));
      s.position.y = 0.5 + h / 2;
      root.add(s);
      for (const sx of [-1, 1]) bx(root, MAT.ink, 0.07, 0.5, 0.07, sx * (w / 2 - 0.3), 0.25, 0);
      break;
    }
  }
  return root;
}

// ---------------------------------------------------------------- placing --
/** Where each placed sign stands (signs are merged into a few meshes afterwards, so their names don't survive). */
export const SIGN_SPOTS: { name: string; x: number; z: number }[] = [];

function place(group: THREE.Group, boxes: Box[], obj: THREE.Object3D, x: number, y: number, z: number, yaw: number): void {
  if (obj.name.startsWith("SIGN:")) SIGN_SPOTS.push({ name: obj.name.slice(5), x, z });
  obj.position.set(x, y, z);
  obj.rotation.y = yaw;
  group.add(obj);
  const c = Math.cos(yaw), s = Math.sin(yaw);
  for (const f of (obj.userData.footprints ?? []) as Footprint[]) {
    boxes.push(box(x + f.x * c + f.z * s, z - f.x * s + f.z * c, Math.abs(f.w * c) + Math.abs(f.d * s), Math.abs(f.w * s) + Math.abs(f.d * c), f.h, y));
  }
}

const rc = new THREE.Raycaster();
function cast(root: THREE.Object3D, o: THREE.Vector3, d: THREE.Vector3, far: number): { p: THREE.Vector3; n: THREE.Vector3; dist: number } | null {
  rc.set(o, d.clone().normalize());
  rc.far = far;
  const h = rc.intersectObject(root, true)[0];
  if (!h || !h.face) return null;
  return { p: h.point, n: h.face.normal.clone().transformDirection(h.object.matrixWorld), dist: h.distance };
}
const V = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z);

/** First candidate along `scan` whose wall hit lies near `expected` metres from the ray origin. */
function findWall(town: THREE.Object3D, ox: number, oy: number, oz: number, dir: THREE.Vector3, scan: "x" | "z", cands: number[], expected: number, tol: number) {
  for (const c of cands) {
    const h = cast(town, V(scan === "x" ? c : ox, oy, scan === "z" ? c : oz), dir, expected + 12);
    if (h && Math.abs(h.dist - expected) <= tol && Math.abs(h.n.y) < 0.3) return { ...h, at: c };
  }
  return null;
}

function mergeStatic(group: THREE.Group): void {
  group.updateMatrixWorld(true);
  const byMat = new Map<Mat, THREE.BufferGeometry[]>();
  group.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const g = m.geometry.clone();
    g.applyMatrix4(m.matrixWorld);
    const mat = m.material as Mat;
    (byMat.get(mat) ?? byMat.set(mat, []).get(mat)!).push(g);
  });
  group.clear();
  for (const [mat, geos] of byMat) {
    const merged = mergeGeometries(geos, false);
    if (!merged) continue;
    const mesh = new THREE.Mesh(merged, mat);
    mesh.matrixAutoUpdate = false;
    mesh.frustumCulled = true;
    group.add(mesh);
  }
}


function buildTown(town: THREE.Object3D, boxes: Box[]): THREE.Group {
  const g = new THREE.Group();
  g.name = "BRAND";
  town.updateMatrixWorld(true);
  const ground = (x: number, z: number): number => cast(town, V(x, 2.5, z), V(0, -1, 0), 6)?.p.y ?? 0;
  const roof = (x: number, zs: number[]): { y: number; z: number } | null => {
    for (const z of zs) { const h = cast(town, V(x, 40, z), V(0, -1, 0), 45); if (h && h.p.y > 7) return { y: h.p.y, z }; }
    return null;
  };

  // Gateways: market square entrance (z 52, both faces), Innovation District at the east end of Cafe Street.
  place(g, boxes, makeSign("gateway", {
    lines: [{ text: "NEAR Market", size: 0.42 }, { text: "Market Square", size: 0.17, weight: 600, dim: true }],
    back: [{ text: "Intents Avenue", size: 0.36 }, { text: "Leaving the Market Square", size: 0.16, weight: 600, dim: true }],
    width: 10.4, height: 1.9,
  }), 0, 0.14, 52, 0);
  place(g, boxes, makeSign("gateway", {
    lines: [{ text: "NEAR Innovation District", size: 0.3 }, { text: "AI Lab, Agent Plaza, Labs", size: 0.15, weight: 600, dim: true }],
    back: [{ text: "Shard Street", size: 0.36 }, { text: "Back to the Market", size: 0.16, weight: 600, dim: true }],
    width: 13.2, height: 1.8, style: "dark",
  }), 33, 0.14, 70, -Math.PI / 2);

  // Inside of the town gate.
  place(g, boxes, makeSign("fascia", {
    lines: [{ text: "NEAR City", size: 0.5 }, { text: "Safe travels", size: 0.22, weight: 600, dim: true }], width: 6, height: 0.6, style: "mint", logo: "none", gap: 0.02,
  }), 0, 6.4, 99.45, Math.PI);

  // Avenue shopfronts toward the gate: fascia + hanging blade on both sides.
  const east = findWall(town, 0, 4.45, 0, V(1, 0, 0), "z", [96, 95, 97, 94, 98], 7, 0.6);
  if (east) place(g, boxes, makeSign("fascia", { lines: [{ text: "Shard Street Goods", size: 0.3 }, { text: "Open late", size: 0.17, weight: 600, dim: true }], width: 3.2, height: 0.8, gap: 0.37 }), east.p.x - 0.37, 3.78, east.at, -Math.PI / 2);
  const west = findWall(town, 0, 4.45, 0, V(-1, 0, 0), "z", [96, 95, 97, 94, 98], 7, 0.6);
  if (west) place(g, boxes, makeSign("fascia", { lines: [{ text: "Chain Abstraction Cafe", size: 0.24 }, { text: "One order. Any chain.", size: 0.15, weight: 600, dim: true }], width: 3.4, height: 0.8, gap: 0.37 }), west.p.x + 0.37, 3.78, west.at, Math.PI / 2);
  const bladeE = findWall(town, 0, 5.8, 0, V(1, 0, 0), "z", [80, 79, 81, 82], 7, 0.6);
  if (bladeE) place(g, boxes, makeSign("blade", { lines: [{ text: "Goods", size: 0.2 }, { text: "Shard St.", size: 0.11, weight: 600, dim: true }] }), bladeE.p.x, 5.6, bladeE.at, -Math.PI / 2);
  const bladeW = findWall(town, 0, 5.8, 0, V(-1, 0, 0), "z", [80, 79, 81, 82], 7, 0.6);
  if (bladeW) place(g, boxes, makeSign("blade", { lines: [{ text: "Cafe", size: 0.2 }, { text: "Open", size: 0.11, weight: 600, dim: true }], style: "dark" }), bladeW.p.x, 5.6, bladeW.at, Math.PI / 2);

  // Square landmarks.
  const round = findWall(town, 10, 5.4, 0, V(1, 0, 0), "z", [39], 13, 1.5);
  if (round) place(g, boxes, makeSign("fascia", { lines: [{ text: "Agent Plaza", size: 0.4 }, { text: "Agents trade while you sleep", size: 0.14, weight: 600, dim: true }], width: 4.6, height: 1.2, style: "dark", gap: 0.3 }), round.p.x - 0.3, 5.4, round.at, -Math.PI / 2);

  // Linden Park gate plaque on Cafe Street (faces south to the street).
  place(g, boxes, makeSign("fascia", { lines: [{ text: "Linden Park", size: 0.42 }, { text: "Open dawn to dusk", size: 0.16, weight: 600, dim: true }], width: 3.1, height: 0.72, gap: 0.04 }), -62, 3.7, 63.35, 0);

  // Kiosk roof sign.
  place(g, boxes, makeSign("roof", { lines: [{ text: "Chain Abstraction Cafe", size: 0.24 }, { text: "One order. Any chain.", size: 0.15, weight: 600, dim: true }], width: 3.2, height: 0.8, style: "dark" }), -24, 3.0, 61.2, 0);

  // Street name poles at the Cafe Street / Intents Avenue crossing.
  const pole = (x: number, z: number, yaw: number, a: string, b: string): void =>
    place(g, boxes, makeSign("street", { lines: [{ text: a, size: 0.36 }], extra: [{ text: b, size: 0.36 }] }), x, ground(x, z), z, yaw);
  pole(5.7, 78.3, 0, "Intents Avenue", "Shard Street");
  pole(-5.7, 61.7, 0, "Intents Avenue", "Shard Street");
  pole(5.7, 52.8, 0, "Market Square", "Intents Avenue");

  // Bus / tram stop on the east pavement.
  place(g, boxes, makeSign("stop", {
    lines: [{ text: "Intents Avenue", size: 0.4 }], extra: [{ text: "02", size: 0.5 }],
    ad: [{ text: "Agents trade while you sleep", size: 0.12 }],
  }), 6.35, ground(6, 82.4), 82.4, -Math.PI / 2);

  // Rooftop billboards on the mid rows, facing the avenue and the player coming from the gate.
  const be = roof(12.5, [58, 57, 59, 56, 60]);
  if (be) place(g, boxes, makeSign("billboard", { lines: [{ text: "Every crate is a NEP-245 token", size: 0.2 }, { text: "Own it. Trade it. Prove it.", size: 0.1, weight: 600, dim: true }], logo: "wordmark" }), 12.5, be.y, be.z, Math.atan2(-0.35, 1));
  const bw = roof(-12.5, [58, 57, 59, 56, 60]);
  if (bw) place(g, boxes, makeSign("billboard", { lines: [{ text: "One account. Any chain.", size: 0.24 }, { text: "Pay in whatever you hold.", size: 0.1, weight: 600, dim: true }], style: "dark", logo: "wordmark" }), -12.5, bw.y, bw.z, Math.atan2(0.35, 1));

  // Banners on the unbannered Cafe Street lamps.
  for (const lx of [-35, -21, 21, 35]) {
    place(g, boxes, makeSign("banner", { lines: [{ text: "NEAR", size: 0.1 }, { text: "City", size: 0.1, weight: 600, dim: true }] }), lx + 0.41, 3.28, 74.6, 0);
  }
  mergeStatic(g);
  return g;
}

/** Wait for the town (SPAWN_TOWN appears once market.ts adds it), then place and merge all signs once. */
export function installBrand(scene: THREE.Scene, colliders: Box[], onUpdate: Array<(dt: number) => void>): void {
  let frame = 0, started = false;
  onUpdate.push(() => {
    if (started || ++frame % 30 !== 0 || frame > 3600) return;
    const spawn = scene.getObjectByName("SPAWN_TOWN");
    if (!spawn) return;
    started = true;
    let town: THREE.Object3D = spawn;
    while (town.parent && town.parent !== scene) town = town.parent;
    void loadBrandAssets().then(() => {
      const added: Box[] = [];
      scene.add(buildTown(town, added));
      colliders.push(...added);
    }).catch((e: unknown) => console.warn("brand signs skipped", e));
  });
}
