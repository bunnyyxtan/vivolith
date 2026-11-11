// City map: a live minimap (HUD) and a full map (M). Everything is drawn from the real world: road lanes from
// /models/v2/roads.json, building footprints from the city's collision boxes, places from named objects in the town
// (placards, landmarks, merchants, the Spire's own meshes) and from the signs the game places (brand.ts SIGN_SPOTS).
// District bounds come from blender/build_v2_spire_district.py (Blender y = -z here). Canvas 2D; the static city is
// drawn once into a cached image. North (toward the N Spire, -z) is up.
import * as THREE from "three";
import type { Box } from "../physics/collision";
import { SIGN_SPOTS } from "./brand";

export interface MapPlace { name: string; x: number; z: number; kind: "merchant" | "landmark" | "place" }
export interface CityMap { update(dt: number): void; readonly open: boolean }
interface Deps {
  scene: THREE.Scene; colliders: readonly Box[];
  player: () => { x: number; z: number; heading: number };
  objective: () => THREE.Vector3 | null;
  merchants: () => { name: string; at: THREE.Vector3 }[];
  /** True when the map may open (walking, not in a menu or panel). */
  allowed: () => boolean;
  /** Freeze/unfreeze play while the full map is up. */
  setFrozen: (on: boolean) => void;
}

const W0 = -115, W1 = 115, PX = 4; // world bounds (m) and cached pixels per metre
const C = { bg: "#0b1626", block: "#1b2c44", blockEdge: "#2a4262", road: "#2e4f6e", lane: "#3d6688", grid: "rgba(120,170,220,0.06)", cyan: "#4fe3d6", gold: "#ffcc5c", text: "#dbe7f3", dim: "#7f97b2" };
const DISTRICTS: [string, number, number, number, number][] = [ // name, x0, z0, x1, z1
  ["Demo Day Lawn", -34.5, -94, 34.5, -75], ["Builders' Yard", -59, -73, -34.5, -50], ["Mango Orchard", -59, -94, -34.5, -74],
  ["Spire Station", 34.5, -73, 59, -50], ["Harbor Depot", 34.5, -94, 59, -74], ["Spire Forecourt", -34, -75, 34, -46],
];
const REACHED_M = 4, MM_SCALE = 3.2, MERCHANT_LABEL_ZOOM = 4.5; // waypoint clears within this; minimap canvas px per metre (~55 m around you)

export function createCityMap(d: Deps): CityMap {
  const css = document.createElement("style");
  css.textContent = `
  .mm { position:fixed; right:20px; bottom:24px; width:176px; height:176px; border-radius:50%; overflow:hidden; z-index:6; pointer-events:none;
    box-shadow:0 0 0 2px rgba(79,227,214,.55), 0 6px 22px rgba(0,10,25,.45); background:${C.bg}; }
  .mm canvas { width:100%; height:100%; display:block; }
  .mm-tag { position:fixed; right:20px; bottom:206px; width:176px; text-align:center; z-index:6; font:600 12px "Inter Tight",system-ui,sans-serif; color:${C.gold}; text-shadow:0 1px 4px #000a; pointer-events:none; }
  body.in-menu .mm, body.in-menu .mm-tag { display:none; }
  .cmap { position:fixed; inset:0; z-index:20; background:rgba(6,12,22,.92); opacity:0; pointer-events:none; transition:opacity .25s ease; }
  .cmap.on { opacity:1; pointer-events:auto; }
  .cmap canvas { width:100%; height:100%; display:block; cursor:grab; }
  .cmap .bar { position:absolute; left:24px; top:20px; font:600 14px "Inter Tight",system-ui,sans-serif; color:${C.text}; letter-spacing:.04em; pointer-events:none; }
  .cmap .bar b { font-size:22px; letter-spacing:.18em; color:#fff; display:block; margin-bottom:4px; }
  .cmap .bar span { color:${C.dim}; font-weight:400; }`;
  document.head.append(css);

  // ---- data from the world
  const places = (): MapPlace[] => {
    const out: MapPlace[] = [];
    const v = new THREE.Vector3();
    const named: [string, string][] = [["PLACARD_orchard", "Mango Orchard"], ["PLACARD_yard", "Builders' Yard"], ["PLACARD_station", "Spire Station"], ["PLACARD_depot", "Harbor Depot"], ["LANDMARK_ai_lab", "NEAR AI Lab"], ["LANDMARK_intents_exchange", "NEAR Intents Exchange"]];
    for (const [obj, name] of named) { const o = d.scene.getObjectByName(obj); if (o) { o.getWorldPosition(v); out.push({ name, x: v.x, z: v.z, kind: obj.startsWith("LANDMARK") ? "landmark" : "place" }); } }
    if (spire === null) {
      const b = new THREE.Box3();
      d.scene.traverse((o) => { if (/^SPIRE_(east|west)_base/.test(o.name) && (o as THREE.Mesh).isMesh) b.expandByObject(o); });
      if (!b.isEmpty()) spire = b.getCenter(new THREE.Vector3());
    }
    if (spire) out.push({ name: "N Spire", x: spire.x, z: spire.z, kind: "landmark" });
    for (const s of SIGN_SPOTS) if (["Agent Plaza", "Linden Park", "Market Square"].includes(s.name)) out.push({ name: s.name, x: s.x, z: s.z, kind: s.name === "Agent Plaza" ? "landmark" : "place" });
    for (const m of d.merchants()) out.push({ name: m.name, x: m.at.x, z: m.at.z, kind: "merchant" });
    return out;
  };
  let spire: THREE.Vector3 | null = null;
  let lanes: number[][][] = [];
  void fetch("/models/v2/roads.json").then((r) => r.json()).then((j: { lanes?: { points: number[][] }[] }) => { lanes = (j.lanes ?? []).map((l) => l.points); stat = null; }).catch(() => undefined);

  // ---- cached static city
  let stat: HTMLCanvasElement | null = null, statAt = 0;
  const toPx = (w: number): number => (w - W0) * PX;
  const buildStatic = (): HTMLCanvasElement => {
    const cv = document.createElement("canvas"); cv.width = cv.height = (W1 - W0) * PX;
    const g = cv.getContext("2d")!;
    g.fillStyle = C.bg; g.fillRect(0, 0, cv.width, cv.height);
    g.strokeStyle = C.grid; g.lineWidth = 1;
    for (let m = W0; m <= W1; m += 10) { g.beginPath(); g.moveTo(toPx(m), 0); g.lineTo(toPx(m), cv.height); g.moveTo(0, toPx(m)); g.lineTo(cv.width, toPx(m)); g.stroke(); }
    g.setLineDash([6, 6]); g.strokeStyle = "rgba(79,227,214,.35)"; g.lineWidth = 2;
    for (const [, x0, z0, x1, z1] of DISTRICTS) g.strokeRect(toPx(x0), toPx(z0), (x1 - x0) * PX, (z1 - z0) * PX);
    g.setLineDash([]);
    g.lineCap = "round"; g.lineJoin = "round";
    for (const [w, col] of [[7 * PX, C.road], [1.2, C.lane]] as const) {
      g.strokeStyle = col; g.lineWidth = w;
      for (const pts of lanes) { g.beginPath(); pts.forEach(([x, z], i) => (i ? g.lineTo(toPx(x), toPx(z)) : g.moveTo(toPx(x), toPx(z)))); g.stroke(); }
    }
    g.fillStyle = C.block; g.strokeStyle = C.blockEdge; g.lineWidth = 1.5;
    for (const b of d.colliders) {
      if (b.maxY - b.minY < 2.5 || b.maxX - b.minX > 80 || b.maxZ - b.minZ > 80) continue; // buildings, not ground slabs
      g.fillRect(toPx(b.minX), toPx(b.minZ), (b.maxX - b.minX) * PX, (b.maxZ - b.minZ) * PX);
      g.strokeRect(toPx(b.minX), toPx(b.minZ), (b.maxX - b.minX) * PX, (b.maxZ - b.minZ) * PX);
    }
    return cv;
  };
  const staticCity = (): HTMLCanvasElement => {
    if (!stat || d.colliders.length !== statAt) { stat = buildStatic(); statAt = d.colliders.length; } // town and props stream in
    return stat;
  };

  // ---- markers
  const pin = (g: CanvasRenderingContext2D, x: number, y: number, kind: MapPlace["kind"] | "objective" | "waypoint", s: number): void => {
    g.save(); g.translate(x, y);
    if (kind === "objective" || kind === "waypoint") {
      g.shadowColor = C.gold; g.shadowBlur = 10 * s; g.fillStyle = C.gold;
      g.beginPath(); g.moveTo(0, -9 * s); g.lineTo(7 * s, 0); g.lineTo(0, 9 * s); g.lineTo(-7 * s, 0); g.closePath(); g.fill();
      if (kind === "waypoint") { g.shadowBlur = 0; g.fillStyle = C.bg; g.beginPath(); g.arc(0, 0, 2.6 * s, 0, Math.PI * 2); g.fill(); }
    } else if (kind === "merchant") {
      g.fillStyle = "#ffb44a"; g.strokeStyle = "#2a1a06"; g.lineWidth = 1.5 * s; g.beginPath(); g.arc(0, 0, 5 * s, 0, Math.PI * 2); g.fill(); g.stroke();
    } else if (kind === "landmark") {
      g.fillStyle = C.cyan; g.shadowColor = C.cyan; g.shadowBlur = 8 * s; g.fillRect(-5 * s, -5 * s, 10 * s, 10 * s);
    } else { g.strokeStyle = C.cyan; g.lineWidth = 2 * s; g.beginPath(); g.arc(0, 0, 5 * s, 0, Math.PI * 2); g.stroke(); }
    g.restore();
  };
  const arrow = (g: CanvasRenderingContext2D, x: number, y: number, heading: number, s: number): void => {
    g.save(); g.translate(x, y); g.rotate(Math.PI - heading); // heading is atan2(dx, dz); map up is -z
    g.fillStyle = "#ffffff"; g.shadowColor = C.cyan; g.shadowBlur = 8;
    g.beginPath(); g.moveTo(0, -10 * s); g.lineTo(7 * s, 8 * s); g.lineTo(0, 4 * s); g.lineTo(-7 * s, 8 * s); g.closePath(); g.fill();
    g.restore();
  };

  // ---- waypoint (map click), with a soft gold beam in the world
  let waypoint: THREE.Vector3 | null = null;
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 40, 12, 1, true), new THREE.MeshBasicMaterial({ color: C.gold, transparent: true, opacity: 0.32, depthWrite: false, toneMapped: false }));
  beam.visible = false; d.scene.add(beam);
  const setWaypoint = (p: THREE.Vector3 | null): void => { waypoint = p; beam.visible = !!p; if (p) beam.position.set(p.x, 20, p.z); };

  // ---- minimap
  const mm = document.createElement("div"); mm.className = "mm hud";
  const mmc = document.createElement("canvas"); mmc.width = mmc.height = 352; mm.append(mmc);
  const tag = document.createElement("div"); tag.className = "mm-tag hud";
  document.body.append(mm, tag);
  const drawMini = (): void => {
    const g = mmc.getContext("2d")!, p = d.player(), half = mmc.width / 2, k = MM_SCALE / PX;
    g.fillStyle = C.bg; g.fillRect(0, 0, mmc.width, mmc.height);
    g.save(); g.translate(half, half); g.scale(k, k); g.translate(-toPx(p.x), -toPx(p.z)); g.drawImage(staticCity(), 0, 0); g.restore();
    const at = (x: number, z: number): [number, number] => [half + (x - p.x) * MM_SCALE, half + (z - p.z) * MM_SCALE];
    for (const pl of places()) { const [x, y] = at(pl.x, pl.z); if (Math.hypot(x - half, y - half) < half - 8) pin(g, x, y, pl.kind, 1.6); }
    for (const [target, kind] of [[d.objective(), "objective"], [waypoint, "waypoint"]] as const) {
      if (!target) continue;
      let [x, y] = at(target.x, target.z);
      const r = Math.hypot(x - half, y - half), max = half - 18;
      if (r > max) { x = half + ((x - half) / r) * max; y = half + ((y - half) / r) * max; } // pinned to the rim when far
      pin(g, x, y, kind, 1.8);
    }
    arrow(g, half, half, p.heading, 1.8);
    tag.textContent = waypoint ? `Waypoint · ${Math.round(Math.hypot(waypoint.x - p.x, waypoint.z - p.z))} m` : "";
  };

  // ---- full map
  const full = document.createElement("div"); full.className = "cmap";
  const fc = document.createElement("canvas");
  const bar = document.createElement("div"); bar.className = "bar";
  bar.innerHTML = `<b>NEAR CITY</b>Click a place to set a waypoint <span>· drag to pan · scroll to zoom · M or Esc to close</span>`;
  full.append(fc, bar); document.body.append(full);
  let isOpen = false, zoom = 2.2, cx = 0, cz = -10;
  let drag: { x: number; y: number; cx: number; cz: number; moved: boolean } | null = null;
  const drawFull = (): void => {
    const s = Math.min(window.devicePixelRatio, 2);
    if (fc.width !== Math.round(innerWidth * s)) { fc.width = Math.round(innerWidth * s); fc.height = Math.round(innerHeight * s); }
    const g = fc.getContext("2d")!;
    g.fillStyle = C.bg; g.fillRect(0, 0, fc.width, fc.height);
    const scr = (x: number, z: number): [number, number] => [fc.width / 2 + (x - cx) * zoom * s, fc.height / 2 + (z - cz) * zoom * s];
    g.save(); g.translate(fc.width / 2, fc.height / 2); g.scale((zoom * s) / PX, (zoom * s) / PX); g.translate(-toPx(cx), -toPx(cz));
    g.drawImage(staticCity(), 0, 0); g.restore();
    g.textAlign = "center";
    for (const [name, x0, z0, x1, z1] of DISTRICTS) { const [x, y] = scr((x0 + x1) / 2, (z0 + z1) / 2); g.font = `600 ${11 * s}px "Inter Tight",system-ui,sans-serif`; g.fillStyle = "rgba(79,227,214,.55)"; g.fillText(name.toUpperCase(), x, y); }
    for (const pl of places()) {
      const [x, y] = scr(pl.x, pl.z); pin(g, x, y, pl.kind, s * 1.2);
      if (pl.kind === "merchant" && zoom < MERCHANT_LABEL_ZOOM) continue; // stalls stand close: names once zoomed in
      g.font = `600 ${12 * s}px "Inter Tight",system-ui,sans-serif`; g.fillStyle = pl.kind === "merchant" ? "#ffd59a" : C.text;
      g.shadowColor = "#000"; g.shadowBlur = 4 * s; g.fillText(pl.name, x, y - 12 * s); g.shadowBlur = 0;
    }
    const o = d.objective(); if (o) { const [x, y] = scr(o.x, o.z); pin(g, x, y, "objective", s * 1.4); }
    if (waypoint) { const [x, y] = scr(waypoint.x, waypoint.z); pin(g, x, y, "waypoint", s * 1.4); }
    const p = d.player(); const [px, py] = scr(p.x, p.z); arrow(g, px, py, p.heading, s * 1.3);
  };
  const setOpen = (on: boolean): void => {
    if (on === isOpen) return;
    isOpen = on; full.classList.toggle("on", on); d.setFrozen(on);
    if (on) { const p = d.player(); cx = p.x; cz = p.z; drawFull(); }
  };
  window.addEventListener("keydown", (e) => {
    if ((e.target as HTMLElement | null)?.tagName === "INPUT") return;
    if (e.code === "KeyM" && (isOpen || d.allowed())) { setOpen(!isOpen); e.preventDefault(); e.stopImmediatePropagation(); }
    else if (e.code === "Escape" && isOpen) { setOpen(false); e.preventDefault(); e.stopImmediatePropagation(); } // never also opens the pause menu
  }, { capture: true });
  fc.addEventListener("wheel", (e) => { e.preventDefault(); zoom = Math.min(12, Math.max(0.8, zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15))); drawFull(); }, { passive: false });
  fc.addEventListener("pointerdown", (e) => { drag = { x: e.clientX, y: e.clientY, cx, cz, moved: false }; fc.setPointerCapture(e.pointerId); });
  fc.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (Math.hypot(dx, dy) > 4) drag.moved = true;
    cx = drag.cx - dx / zoom; cz = drag.cz - dy / zoom; drawFull();
  });
  fc.addEventListener("pointerup", (e) => {
    if (drag && !drag.moved) { // a click: waypoint there, or clear it when clicking the current one
      const x = cx + (e.clientX - innerWidth / 2) / zoom, z = cz + (e.clientY - innerHeight / 2) / zoom;
      if (waypoint && Math.hypot(waypoint.x - x, waypoint.z - z) < 20 / zoom) setWaypoint(null); else setWaypoint(new THREE.Vector3(x, 0, z));
      drawFull();
    }
    drag = null;
  });

  let acc = 0;
  return {
    get open() { return isOpen; },
    update(dt) {
      acc += dt;
      if (waypoint) { const p = d.player(); if (Math.hypot(waypoint.x - p.x, waypoint.z - p.z) < REACHED_M) setWaypoint(null); }
      if (acc < 1 / 30) return; // 30 fps is plenty for a map
      acc = 0;
      drawMini();
      if (isOpen) drawFull();
    },
  };
}
