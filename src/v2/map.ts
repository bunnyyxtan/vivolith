// City map: a live minimap (HUD) and a full map (M). Everything is drawn from the real world: road lanes from
// /models/v2/roads.json, building footprints from the city's collision boxes, places from named objects in the town
// (placards, landmarks, merchants, the Spire's own meshes) and from the signs the game places (brand.ts SIGN_SPOTS).
// District bounds come from blender/build_v2_spire_district.py (Blender y = -z here). Canvas 2D, vector paths drawn
// straight from world metres every frame (no cached bitmap, so it stays sharp at any zoom). North (-z) is up on the full
// map; the minimap turns with the camera and keeps a north badge. Routes come from the walking grid the townsfolk use
// (nav.ts, built from the same collision boxes), so a drawn route is one a person can actually walk.
import * as THREE from "three";
import type { Box } from "../physics/collision";
import { SIGN_SPOTS } from "./brand";
import { createNav } from "./nav";
import { cityBounds, declutter, edgePoint, fitView, footprints, pick, routeLength, type Footprint, type Label, type Rect, type View } from "./maplayout";

export interface MapPlace { id: string; name: string; x: number; z: number; ax: number; az: number; kind: "merchant" | "landmark" | "place" | "shop"; glyph: string; pri: number; showAt: number }
export interface CityMap { update(dt: number): void; readonly open: boolean }
interface Deps {
  scene: THREE.Scene; colliders: readonly Box[];
  player: () => { x: number; z: number; heading: number };
  /** Direction the camera looks along the ground, atan2(dx, dz); the minimap turns with it. */
  cameraYaw: () => number;
  objective: () => THREE.Vector3 | null;
  merchants: () => { name: string; at: THREE.Vector3; stall: THREE.Vector3 }[];
  /** True when the map may open (walking, not in a menu or panel). */
  allowed: () => boolean;
  /** Freeze/unfreeze play while the full map is up. */
  setFrozen: (on: boolean) => void;
}

// ---- style: one light, hand-inked cartographic palette that matches the daytime city
const P = {
  paper: "#f2ebdb", walk: "#e6dcc4", casing: "#b9ad93", road: "#fffcf4", ink: "#1b2336", inkSoft: "rgba(27,35,54,.62)", halo: "rgba(255,251,242,.95)",
  bldg: "#d3dbea", bldgTall: "#b9c6de", bldgEdge: "#5f6e8c", shade: "rgba(45,55,85,.17)",
  cyan: "#10b3a8", gold: "#f6b72f", pink: "#ff3d81", orange: "#ff9a3d", frame: "#101a2b",
};
const DISTRICTS: { name: string; r: Rect; tint: string }[] = [ // x0, z0, x1, z1 (m)
  { name: "Demo Day Lawn", r: { x0: -34.5, z0: -94, x1: 34.5, z1: -75 }, tint: "#8fd18a" },
  { name: "Builders' Yard", r: { x0: -59, z0: -73, x1: -34.5, z1: -50 }, tint: "#cdb892" },
  { name: "Mango Orchard", r: { x0: -59, z0: -94, x1: -34.5, z1: -74 }, tint: "#f1b45f" },
  { name: "Spire Station", r: { x0: 34.5, z0: -73, x1: 59, z1: -50 }, tint: "#9db8d9" },
  { name: "Harbor Depot", r: { x0: 34.5, z0: -94, x1: 59, z1: -74 }, tint: "#8fb0cf" },
  { name: "Spire Forecourt", r: { x0: -34, z0: -75, x1: 34, z1: -46 }, tint: "#8fe0d6" },
];
const ROAD_W = 7, WALK_W = 11.5, REACHED_M = 4, MM_SPAN = 76, FIT = 0.8; // road width and kerb width (m), waypoint reach, metres across the minimap, city share of the map
const FONT = '"Inter Tight",system-ui,sans-serif';

const SHOPS = ["Chain Abstraction Cafe", "Shard Street Goods", "NEAR Innovation District"];
const LAND_GLYPH: Record<string, string> = { "N Spire": "N", "NEAR AI Lab": "AI", "NEAR Intents Exchange": "X", "Agent Plaza": "A" };
const NAMED: [string, string, number][] = [["PLACARD_orchard", "Mango Orchard", 70], ["PLACARD_yard", "Builders' Yard", 70], ["PLACARD_station", "Spire Station", 70], ["PLACARD_depot", "Harbor Depot", 70], ["LANDMARK_ai_lab", "NEAR AI Lab", 90], ["LANDMARK_intents_exchange", "NEAR Intents Exchange", 90]];

export function createCityMap(d: Deps): CityMap {
  const css = document.createElement("style");
  css.textContent = `
  .mm { position:fixed; right:16px; bottom:34px; width:var(--mm); height:var(--mm); --mm:clamp(112px,16vmin,164px); border-radius:18px; overflow:hidden; z-index:6; pointer-events:none; opacity:.96;
    box-shadow:0 0 0 2px ${P.frame}, 0 0 0 4px rgba(255,255,255,.85), 0 6px 18px rgba(8,14,30,.35); background:${P.paper}; transition:opacity .2s; }
  .mm.off { opacity:0; }
  .mm canvas { width:100%; height:100%; display:block; }
  .mm-tag { position:fixed; right:16px; bottom:12px; width:var(--mm); --mm:clamp(112px,16vmin,164px); z-index:6; display:flex; justify-content:space-between; gap:8px; font:700 12px ${FONT}; color:#fff; text-shadow:0 1px 3px rgba(8,14,30,.85); pointer-events:none; transition:opacity .2s; }
  .mm-tag.off { opacity:0; } .mm-tag i { font-style:normal; color:#ff7aa8; }
  body.in-menu .mm, body.in-menu .mm-tag { display:none; }
  .cmap { position:fixed; inset:0; z-index:20; background:rgba(8,14,26,.84); backdrop-filter:blur(3px); opacity:0; pointer-events:none; transition:opacity .22s ease; font-family:${FONT}; }
  .cmap.on { opacity:1; pointer-events:auto; }
  .cm-panel { position:absolute; inset:14px; border-radius:20px; overflow:hidden; background:${P.paper}; box-shadow:0 0 0 3px ${P.frame}, 0 0 0 5px rgba(255,255,255,.85), 0 18px 60px rgba(0,0,0,.5); }
  .cm-panel > canvas { position:absolute; inset:0; width:100%; height:100%; display:block; cursor:grab; touch-action:none; }
  .cm-panel > canvas.drag { cursor:grabbing; } .cm-panel > canvas.over { cursor:pointer; }
  .cm-card { position:absolute; background:rgba(255,252,244,.94); color:${P.ink}; border-radius:14px; box-shadow:0 0 0 2px ${P.ink}, 0 6px 16px rgba(20,28,50,.25); padding:10px 14px; font-size:13px; line-height:1.35; }
  .cm-title { left:16px; top:16px; } .cm-title b { display:block; font-size:20px; letter-spacing:.16em; } .cm-title span { color:${P.inkSoft}; font-size:12px; }
  .cm-info { right:16px; top:16px; min-width:190px; max-width:min(300px,46vw); display:none; } .cm-info.on { display:block; }
  .cm-info b { display:flex; align-items:center; gap:8px; font-size:14px; } .cm-info em { font-style:normal; color:${P.inkSoft}; display:block; }
  .cm-info button { margin-top:8px; font:700 12px ${FONT}; border:2px solid ${P.ink}; background:#fff; color:${P.ink}; border-radius:999px; padding:3px 12px; cursor:pointer; }
  .cm-note { color:#c2185b; font-weight:700; margin-top:6px; } .cm-note:empty { display:none; }
  .cm-legend { left:16px; bottom:16px; width:196px; font-size:12px; } .cm-legend h4 { margin:0 0 6px; font-size:11px; letter-spacing:.14em; color:${P.inkSoft}; display:flex; justify-content:space-between; gap:14px; }
  .cm-legend ul { list-style:none; margin:0; padding:0; display:grid; gap:5px; } .cm-legend li { display:flex; align-items:center; gap:9px; } .cm-legend li canvas { width:22px; height:22px; flex:none; }
  .cm-legend.min ul { display:none; } .cm-legend h4 button { all:unset; cursor:pointer; color:${P.ink}; font-weight:700; }
  .cm-ctl { right:16px; bottom:16px; display:flex; flex-direction:column; gap:8px; padding:8px; }
  .cm-ctl button { width:38px; height:38px; border-radius:12px; border:2px solid ${P.ink}; background:#fff; color:${P.ink}; cursor:pointer; display:grid; place-items:center; font:700 20px ${FONT}; padding:0; }
  .cm-ctl button:hover, .cm-info button:hover { background:#ffe7b3; } .cm-ctl button:focus-visible, .cm-info button:focus-visible { outline:3px solid ${P.cyan}; outline-offset:2px; }
  .cm-hint { left:50%; transform:translateX(-50%); bottom:14px; padding:5px 14px; font-size:12px; white-space:nowrap; color:${P.inkSoft}; border-radius:999px; box-shadow:0 0 0 2px rgba(27,35,54,.5); }
  .cm-tip { position:absolute; pointer-events:none; display:none; background:${P.ink}; color:#fff; border-radius:10px; padding:6px 10px; font-size:12px; line-height:1.3; white-space:nowrap; z-index:2; } .cm-tip b { display:block; font-size:13px; } .cm-tip span { color:#ffd27a; }
  @media (max-width:760px) { .cm-info { top:76px; left:16px; right:16px; max-width:none; } .cm-hint { display:none; } .cm-legend { width:auto; } .cm-legend.min { padding:6px 10px; } .cm-title b { font-size:16px; } .cm-title span { display:none; } }`;
  document.head.append(css);

  // ---- data from the world
  let spire: THREE.Vector3 | null = null;
  let lanes: number[][][] = [];
  let roadsPath = new Path2D(), bldgPath = new Path2D(), tallPath = new Path2D(), shadePath = new Path2D();
  let feet: Footprint[] = [];
  let bounds: Rect = { x0: -60, z0: -60, x1: 60, z1: 60 };
  let places: MapPlace[] = [];
  let builtFor = -1, geoVersion = 0;
  void fetch("/models/v2/roads.json").then((r) => r.json()).then((j: { lanes?: { points: number[][] }[] }) => { lanes = (j.lanes ?? []).map((l) => l.points); builtFor = -1; }).catch(() => undefined);

  const findPlaces = (): MapPlace[] => {
    const out: MapPlace[] = [];
    const v = new THREE.Vector3();
    const add = (id: string, name: string, x: number, z: number, kind: MapPlace["kind"], pri: number, showAt: number): void => { out.push({ id, name, x, z, ax: x, az: z, kind, glyph: LAND_GLYPH[name] ?? "", pri, showAt }); };
    for (const [obj, name, pri] of NAMED) { const o = d.scene.getObjectByName(obj); if (o) { o.getWorldPosition(v); add(obj, name, v.x, v.z, obj.startsWith("LANDMARK") ? "landmark" : "place", pri, obj.startsWith("LANDMARK") ? 0 : 0.9); } }
    if (spire === null) {
      const b = new THREE.Box3();
      d.scene.traverse((o) => { if (/^SPIRE_(east|west)_base/.test(o.name) && (o as THREE.Mesh).isMesh) b.expandByObject(o); });
      if (!b.isEmpty()) spire = b.getCenter(new THREE.Vector3());
    }
    if (spire) add("spire", "N Spire", spire.x, spire.z, "landmark", 100, 0);
    for (const s of SIGN_SPOTS) {
      if (s.name === "Agent Plaza") add("agent-plaza", s.name, s.x, s.z, "landmark", 80, 0);
      else if (s.name === "Linden Park" || s.name === "Market Square") add(s.name, s.name, s.x, s.z, "place", s.name === "Market Square" ? 75 : 60, 0.9);
      else if (SHOPS.includes(s.name) && !out.some((p) => p.name === s.name && Math.hypot(p.x - s.x, p.z - s.z) < 3)) add(`${s.name}@${Math.round(s.x)}`, s.name, s.x, s.z, "shop", 30, 3);
    }
    return out;
  };

  const nav = createNav(d.colliders);
  const rebuild = (): void => {
    builtFor = d.colliders.length;
    feet = footprints(d.colliders);
    places = findPlaces();
    bounds = cityBounds(lanes, ROAD_W, DISTRICTS.map((x) => x.r), places, feet);
    roadsPath = new Path2D();
    for (const pts of lanes) pts.forEach(([x, z], i) => (i ? roadsPath.lineTo(x, z) : roadsPath.moveTo(x, z)));
    bldgPath = new Path2D(); tallPath = new Path2D(); shadePath = new Path2D();
    for (const f of feet) {
      (f.h > 18 ? tallPath : bldgPath).rect(f.x0, f.z0, f.x1 - f.x0, f.z1 - f.z0);
      shadePath.rect(f.x0 + 0.9, f.z0 + 0.9, f.x1 - f.x0, f.z1 - f.z0);
    }
    geoVersion++;
  };
  const geo = (): void => { if (builtFor !== d.colliders.length) rebuild(); };

  /** Everything that can be chosen: the fixed places plus the merchants (the waypoint goes to the customer side of the stall). */
  const allPlaces = (): MapPlace[] => {
    geo();
    const m: MapPlace[] = d.merchants().map((x, i) => ({ id: `merchant${i}`, name: x.name, x: x.at.x, z: x.at.z, ax: x.stall.x, az: x.stall.z, kind: "merchant" as const, glyph: x.name.replace(/^Auntie\s+/i, "").charAt(0).toUpperCase(), pri: 50, showAt: 2.2 }));
    return [...places, ...m];
  };

  // ---- waypoint, route, the world beam
  type Pin = { x: number; z: number; name: string };
  let waypoint: Pin | null = null;
  let route: number[] | null = null, routeVer = 0, routeAt = -9, routeFrom = { x: 1e9, z: 1e9 }, routeKey = "";
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 46, 14, 1, true), new THREE.MeshBasicMaterial({ color: P.pink, transparent: true, opacity: 0.34, depthWrite: false, toneMapped: false }));
  beam.visible = false; d.scene.add(beam);
  const setWaypoint = (p: Pin | null): void => { waypoint = p; beam.visible = !!p; if (p) beam.position.set(p.x, 23, p.z); routeKey = ""; };
  const target = (): { x: number; z: number; kind: "waypoint" | "objective" } | null => {
    if (waypoint) return { x: waypoint.x, z: waypoint.z, kind: "waypoint" };
    const o = d.objective(); return o ? { x: o.x, z: o.z, kind: "objective" } : null;
  };
  const refreshRoute = (t: number): void => {
    const tg = target(), p = d.player();
    if (!tg) { if (route) { route = null; routeVer++; } return; }
    const key = `${tg.kind}:${tg.x.toFixed(1)}:${tg.z.toFixed(1)}`;
    const moved = Math.hypot(p.x - routeFrom.x, p.z - routeFrom.z);
    if (key === routeKey && (t - routeAt < 1.2 || moved < 2.5)) return;
    routeKey = key; routeAt = t; routeFrom = { x: p.x, z: p.z };
    const out: number[] = [];
    const ok = nav.path(p.x, p.z, tg.x, tg.z, out) && out.length >= 2;
    route = ok ? [p.x, p.z, ...out] : null; routeVer++; // only a route the walking grid verified is ever drawn
  };
  const routeMetres = (): number | null => (route ? routeLength(route[0], route[1], route.slice(2)) : null);
  const free = { x: 0, z: 0 };
  let noteText = "", noteUntil = 0;
  const say = (m: string): void => { noteText = m; noteUntil = performance.now() + 4500; };
  /** Sets the waypoint on walkable ground: a click inside a building moves to the nearest street, and nothing is set when none is near. */
  const probe: number[] = [];
  /** Nearest walkable spot a person can actually reach from where they stand: rings out to 40 m (a landmark's marker can sit deep
   *  inside a building), nearest first, skipping any pocket the walking grid cannot connect to the player. */
  const reachable = (x: number, z: number): { x: number; z: number } | null => {
    const p = d.player();
    if (nav.nearestFree(x, z, free) && nav.path(p.x, p.z, free.x, free.z, probe)) return { x: free.x, z: free.z };
    let first: { x: number; z: number } | null = null, tries = 0;
    for (let r = 2; r <= 40 && tries < 14; r += 2) {
      for (let i = 0; i < 16 && tries < 14; i++) {
        const cx = x + Math.cos((i / 16) * 6.2832) * r, cz = z + Math.sin((i / 16) * 6.2832) * r;
        if (!nav.clear(cx, cz)) continue;
        first ??= { x: cx, z: cz }; tries++;
        if (nav.path(p.x, p.z, cx, cz, probe)) return { x: cx, z: cz };
      }
    }
    return first;
  };
  const trySet = (x: number, z: number, name: string): boolean => {
    const at = reachable(x, z);
    if (!at) { say("No walkable ground near there."); return false; }
    setWaypoint({ x: at.x, z: at.z, name });
    if (name === "Waypoint" && Math.hypot(at.x - x, at.z - z) > 1.5) say("That spot is inside a building, so the waypoint moved to the nearest street.");
    return true;
  };

  // ---- drawing helpers
  const textW = new Map<string, number>();
  const measure = (g: CanvasRenderingContext2D, font: string, t: string): number => { const k = font + t; let w = textW.get(k); if (w === undefined) { g.font = font; w = g.measureText(t).width; textW.set(k, w); } return w; };
  const spacing = (g: CanvasRenderingContext2D, px: number): void => { (g as unknown as { letterSpacing: string }).letterSpacing = `${px}px`; };
  const label = (g: CanvasRenderingContext2D, t: string, x: number, y: number, font: string, color: string, track = 0): void => {
    g.font = font; g.textAlign = "center"; g.textBaseline = "middle"; g.lineJoin = "round"; spacing(g, track);
    g.lineWidth = 4; g.strokeStyle = P.halo; g.strokeText(t, x, y); g.fillStyle = color; g.fillText(t, x, y); spacing(g, 0);
  };
  const badge = (g: CanvasRenderingContext2D, x: number, y: number, r: number, fill: string, glyph: string, glyphColor = "#fff"): void => {
    g.save(); g.translate(x, y);
    g.fillStyle = "rgba(20,28,50,.25)"; g.beginPath(); g.arc(0.5, 1.8, r, 0, 6.3); g.fill();
    g.fillStyle = fill; g.strokeStyle = P.ink; g.lineWidth = 2; g.beginPath(); g.arc(0, 0, r, 0, 6.3); g.fill(); g.stroke();
    if (glyph) { g.fillStyle = glyphColor; g.font = `800 ${Math.round(r * (glyph.length > 1 ? 0.92 : 1.18))}px ${FONT}`; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText(glyph, 0, 0.5); }
    g.restore();
  };
  const star = (g: CanvasRenderingContext2D, x: number, y: number, r: number, t: number): void => {
    g.save(); g.translate(x, y);
    g.strokeStyle = "rgba(246,183,47,.55)"; g.lineWidth = 2; g.beginPath(); g.arc(0, 0, r * (1.25 + 0.25 * Math.sin(t * 3)), 0, 6.3); g.stroke();
    g.fillStyle = P.gold; g.strokeStyle = P.ink; g.lineWidth = 2; g.lineJoin = "round"; g.beginPath();
    for (let i = 0; i < 10; i++) { const a = (i * Math.PI) / 5 - Math.PI / 2, rr = i % 2 ? r * 0.5 : r; g.lineTo(Math.cos(a) * rr, Math.sin(a) * rr); }
    g.closePath(); g.fill(); g.stroke(); g.restore();
  };
  const flag = (g: CanvasRenderingContext2D, x: number, y: number, r: number): void => { // a map pin whose tip is the spot
    g.save(); g.translate(x, y);
    g.fillStyle = "rgba(20,28,50,.25)"; g.beginPath(); g.ellipse(0, 0, r * 0.55, r * 0.22, 0, 0, 6.3); g.fill();
    g.fillStyle = P.pink; g.strokeStyle = P.ink; g.lineWidth = 2; g.lineJoin = "round"; g.beginPath();
    g.moveTo(0, 0); g.bezierCurveTo(-r * 1.1, -r * 1.1, -r * 0.95, -r * 2.2, 0, -r * 2.2); g.bezierCurveTo(r * 0.95, -r * 2.2, r * 1.1, -r * 1.1, 0, 0); g.closePath(); g.fill(); g.stroke();
    g.fillStyle = "#fff"; g.beginPath(); g.arc(0, -r * 1.4, r * 0.38, 0, 6.3); g.fill(); g.restore();
  };
  const playerMark = (g: CanvasRenderingContext2D, x: number, y: number, rot: number, s: number, t: number): void => {
    g.save(); g.translate(x, y);
    g.fillStyle = "rgba(16,179,168,.16)"; g.beginPath(); g.arc(0, 0, 16 * s * (1 + 0.06 * Math.sin(t * 4)), 0, 6.3); g.fill();
    g.rotate(rot);
    g.fillStyle = "rgba(16,179,168,.22)"; g.beginPath(); g.moveTo(0, 0); g.arc(0, 0, 34 * s, -Math.PI / 2 - 0.55, -Math.PI / 2 + 0.55); g.closePath(); g.fill();
    g.fillStyle = "#fff"; g.strokeStyle = P.ink; g.lineWidth = 2.4; g.lineJoin = "round";
    g.beginPath(); g.moveTo(0, -11 * s); g.lineTo(8 * s, 9 * s); g.lineTo(0, 4.5 * s); g.lineTo(-8 * s, 9 * s); g.closePath(); g.fill(); g.stroke();
    g.fillStyle = P.cyan; g.beginPath(); g.arc(0, 1 * s, 2.4 * s, 0, 6.3); g.fill();
    g.restore();
  };
  const markR = (p: MapPlace, k: number): number => (p.kind === "landmark" ? 11 : p.kind === "merchant" ? 9 : p.kind === "shop" ? 5.5 : 7.5) * k;
  const placeMark = (g: CanvasRenderingContext2D, p: MapPlace, x: number, y: number, k: number): void => {
    if (p.kind === "landmark") badge(g, x, y, 11 * k, P.cyan, p.glyph);
    else if (p.kind === "merchant") badge(g, x, y, 9 * k, P.orange, p.glyph);
    else if (p.kind === "shop") badge(g, x, y, 5.5 * k, "#fff", "");
    else { badge(g, x, y, 7.5 * k, "#fff", ""); badge(g, x, y, 2.6 * k, P.cyan, ""); }
  };

  /** The static city, in world metres under whatever transform the caller set. `px` is one screen pixel in metres. */
  const drawCity = (g: CanvasRenderingContext2D, px: number, detail: boolean): void => {
    geo();
    for (const dz of DISTRICTS) {
      g.globalAlpha = 0.34; g.fillStyle = dz.tint; g.fillRect(dz.r.x0, dz.r.z0, dz.r.x1 - dz.r.x0, dz.r.z1 - dz.r.z0); g.globalAlpha = 1;
      if (detail) { g.setLineDash([6 * px, 5 * px]); g.lineWidth = 1.6 * px; g.strokeStyle = "rgba(27,35,54,.38)"; g.strokeRect(dz.r.x0, dz.r.z0, dz.r.x1 - dz.r.x0, dz.r.z1 - dz.r.z0); g.setLineDash([]); }
    }
    g.lineCap = "round"; g.lineJoin = "round";
    for (const [w, col] of [[WALK_W, P.walk], [ROAD_W + 1.3, P.casing], [ROAD_W, P.road]] as const) { g.lineWidth = w; g.strokeStyle = col; g.stroke(roadsPath); }
    g.fillStyle = P.shade; g.fill(shadePath);
    g.fillStyle = P.bldg; g.fill(bldgPath); g.fillStyle = P.bldgTall; g.fill(tallPath);
    g.lineWidth = 1.25 * px; g.strokeStyle = P.bldgEdge; g.stroke(bldgPath); g.stroke(tallPath);
  };
  const drawRoute = (g: CanvasRenderingContext2D, px: number, kind: "waypoint" | "objective"): void => {
    if (!route || route.length < 4) return;
    g.beginPath(); g.moveTo(route[0], route[1]); for (let i = 2; i + 1 < route.length; i += 2) g.lineTo(route[i], route[i + 1]);
    g.lineJoin = "round"; g.lineCap = "round"; g.setLineDash([]);
    g.lineWidth = 7 * px; g.strokeStyle = P.ink; g.stroke();
    g.lineWidth = 4.4 * px; g.strokeStyle = kind === "waypoint" ? P.pink : P.gold; g.stroke();
    g.lineWidth = 1.6 * px; g.strokeStyle = "rgba(255,255,255,.9)"; g.setLineDash([2 * px, 7 * px]); g.stroke(); g.setLineDash([]);
  };

  // ---- minimap
  const mm = document.createElement("div"); mm.className = "mm hud";
  const mmc = document.createElement("canvas"); mm.append(mmc);
  const tag = document.createElement("div"); tag.className = "mm-tag hud";
  const tagArea = document.createElement("span"), tagWp = document.createElement("span"); tag.append(tagArea, tagWp);
  document.body.append(mm, tag);
  let mmKey = "", mmSize = 0, mmDpr = 1;
  const areaAt = (x: number, z: number): string => {
    for (const dz of DISTRICTS) if (x >= dz.r.x0 && x <= dz.r.x1 && z >= dz.r.z0 && z <= dz.r.z1) return dz.name;
    let best = "", bd = 26;
    for (const p of places) { const dd = Math.hypot(p.x - x, p.z - z); if (p.kind !== "shop" && dd < bd) { bd = dd; best = p.name; } }
    return best;
  };
  const drawMini = (t: number): void => {
    const p = d.player(), yaw = d.cameraYaw(), tg = target();
    const wpKey = tg ? `${tg.kind}${tg.x.toFixed(1)}${tg.z.toFixed(1)}` : "";
    const S = mm.clientWidth || 200, dpr = Math.min(window.devicePixelRatio || 1, 2);
    const key = `${S}|${Math.round(p.x * 24)}|${Math.round(p.z * 24)}|${Math.round(yaw * 240)}|${Math.round(p.heading * 60)}|${wpKey}|${routeVer}|${geoVersion}`;
    if (key === mmKey) return; // nothing that shows has changed: no redraw
    mmKey = key;
    if (S !== mmSize || dpr !== mmDpr) { mmSize = S; mmDpr = dpr; mmc.width = mmc.height = Math.round(S * dpr); }
    const ms = Math.min(1.1, Math.max(0.72, S / 190)), g = mmc.getContext("2d")!, k = S / MM_SPAN, a = yaw + Math.PI, ca = Math.cos(a), sa = Math.sin(a), half = S / 2;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = P.paper; g.fillRect(0, 0, S, S);
    g.save(); g.translate(half, half); g.rotate(a); g.scale(k, k); g.translate(-p.x, -p.z);
    drawCity(g, 1 / k, false);
    if (tg) drawRoute(g, 1 / k, tg.kind);
    g.restore();
    const at = (x: number, z: number): { x: number; y: number } => { const dx = (x - p.x) * k, dz = (z - p.z) * k; return { x: half + dx * ca - dz * sa, y: half + dx * sa + dz * ca }; };
    const inside = (q: { x: number; y: number }, m: number): boolean => Math.abs(q.x - half) <= half - m && Math.abs(q.y - half) <= half - m;
    for (const pl of allPlaces().sort((x, y) => x.pri - y.pri)) { // low priority first: the important ones end up on top
      if (pl.kind === "shop" || (pl.kind === "place" && pl.pri < 70)) continue;
      const q = at(pl.x, pl.z); if (!inside(q, 10)) continue;
      placeMark(g, pl, q.x, q.y, ms * (pl.kind === "landmark" ? 0.9 : 0.8));
    }
    if (tg) { // far targets pin to the edge with a pointer and the distance; near ones sit on the spot
      const q = at(tg.x, tg.z), dist = Math.round(Math.hypot(tg.x - p.x, tg.z - p.z));
      if (inside(q, 14)) { if (tg.kind === "waypoint") flag(g, q.x, q.y, 6 * ms); else star(g, q.x, q.y, 8.5 * ms, t); }
      else {
        const e = edgePoint(q.x - half, q.y - half, half - 15), ex = half + e.x, ey = half + e.y;
        g.save(); g.translate(ex, ey); g.rotate(Math.atan2(e.y, e.x) + Math.PI / 2);
        g.fillStyle = tg.kind === "waypoint" ? P.pink : P.gold; g.strokeStyle = P.ink; g.lineWidth = 2; g.lineJoin = "round";
        g.beginPath(); g.moveTo(0, -9); g.lineTo(8, 6); g.lineTo(0, 2); g.lineTo(-8, 6); g.closePath(); g.fill(); g.stroke(); g.restore();
        label(g, `${dist} m`, half + Math.min(half - 24, Math.max(24 - half, e.x)), ey + (e.y > 0 ? -17 : 17), `800 11px ${FONT}`, P.ink);
      }
    }
    const n = edgePoint(sa, -ca, half - 12); // the north badge rides the frame as the camera turns
    badge(g, half + n.x, half + n.y, 7 * ms, P.ink, "N");
    playerMark(g, half, half, Math.PI - p.heading + a, 0.85 * ms, t);
    const area = areaAt(p.x, p.z), w = waypoint ? `${Math.round(routeMetres() ?? Math.hypot(waypoint.x - p.x, waypoint.z - p.z))} m` : "";
    if (tagArea.textContent !== area) tagArea.textContent = area;
    if (tagWp.textContent !== w) tagWp.textContent = w;
  };

  // ---- full map
  const full = document.createElement("div"); full.className = "cmap";
  full.innerHTML = `<div class="cm-panel"><canvas></canvas>
    <div class="cm-card cm-title"><b>NEAR CITY</b><span>City map</span></div>
    <div class="cm-card cm-info"><b></b><em></em><div class="cm-note"></div><button type="button">Clear waypoint</button></div>
    <div class="cm-card cm-legend"><h4>LEGEND <button type="button" aria-label="Show or hide legend">hide</button></h4><ul></ul></div>
    <div class="cm-card cm-ctl"><button type="button" data-a="in" aria-label="Zoom in">+</button><button type="button" data-a="out" aria-label="Zoom out">&minus;</button>
      <button type="button" data-a="me" aria-label="Centre on me"><svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.4"><circle cx="10" cy="10" r="4"/><path d="M10 1v4M10 15v4M1 10h4M15 10h4"/></svg></button>
      <button type="button" data-a="fit" aria-label="Fit whole city"><svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M2 7V2h5M13 2h5v5M18 13v5h-5M7 18H2v-5"/></svg></button></div>
    <div class="cm-card cm-hint">Click a place or street to set a waypoint &middot; drag to pan &middot; scroll to zoom &middot; M or Esc to close</div>
    <div class="cm-tip"></div></div>`;
  document.body.append(full);
  const q = <T extends Element>(s: string): T => full.querySelector<T>(s)!;
  const fc = q<HTMLCanvasElement>(".cm-panel > canvas"), panel = q<HTMLElement>(".cm-panel");
  const info = q<HTMLElement>(".cm-info"), infoB = q<HTMLElement>(".cm-info b"), infoE = q<HTMLElement>(".cm-info em"), note = q<HTMLElement>(".cm-note"), tip = q<HTMLElement>(".cm-tip");
  const legend = q<HTMLElement>(".cm-legend"), clearBtn = q<HTMLButtonElement>(".cm-info button");
  const legendRows: [string, (g: CanvasRenderingContext2D) => void][] = [
    ["You", (g) => playerMark(g, 11, 11, 0, 0.62, 0)], ["Objective", (g) => star(g, 11, 11, 8, 0)], ["Waypoint", (g) => flag(g, 11, 17, 5)],
    ["Landmark", (g) => badge(g, 11, 11, 8.5, P.cyan, "")], ["Merchant stall", (g) => badge(g, 11, 11, 8, P.orange, "")], ["Place", (g) => { badge(g, 11, 11, 7, "#fff", ""); badge(g, 11, 11, 2.4, P.cyan, ""); }],
    ["Road", (g) => { g.fillStyle = P.walk; g.fillRect(1, 7, 20, 8); g.fillStyle = P.casing; g.fillRect(1, 8, 20, 6); g.fillStyle = P.road; g.fillRect(1, 9, 20, 4); }],
    ["Building", (g) => { g.fillStyle = P.bldg; g.fillRect(3, 3, 16, 16); g.strokeStyle = P.bldgEdge; g.lineWidth = 1.5; g.strokeRect(3, 3, 16, 16); }],
    ["District", (g) => { g.globalAlpha = 0.5; g.fillStyle = "#8fd18a"; g.fillRect(2, 3, 18, 16); g.globalAlpha = 1; g.setLineDash([3, 3]); g.strokeStyle = P.inkSoft; g.strokeRect(2, 3, 18, 16); }],
  ];
  const ul = q<HTMLElement>(".cm-legend ul");
  for (const [name, draw] of legendRows) {
    const li = document.createElement("li"), c = document.createElement("canvas"); c.width = c.height = 44;
    const g = c.getContext("2d")!; g.scale(2, 2); draw(g); li.append(c, document.createTextNode(name)); ul.append(li);
  }
  const legendBtn = q<HTMLButtonElement>(".cm-legend h4 button");
  let legendTouched = false;
  legendBtn.onclick = () => { legendTouched = true; legend.classList.toggle("min"); legendBtn.textContent = legend.classList.contains("min") ? "show" : "hide"; };

  type Hit = MapPlace & { sx: number; sy: number; x: number; y: number; r: number };
  let isOpen = false, W = 800, H = 600, dpr = 1;
  let view: View = { cx: 0, cz: 0, zoom: 2 }, goal: View = { ...view }, fit: View = { ...view }, atFit = true;
  let hover: Hit | null = null, hits: Hit[] = [];
  let drag: { x: number; y: number; cx: number; cz: number; moved: boolean } | null = null;
  let clock = 0, acc = 0;
  const clampGoal = (): void => {
    goal.zoom = Math.min(fit.zoom * 9, Math.max(fit.zoom * 0.5, goal.zoom));
    const mx = (bounds.x1 - bounds.x0) * 0.35, mz = (bounds.z1 - bounds.z0) * 0.35;
    goal.cx = Math.min(bounds.x1 + mx, Math.max(bounds.x0 - mx, goal.cx)); goal.cz = Math.min(bounds.z1 + mz, Math.max(bounds.z0 - mz, goal.cz));
  };
  const size = (): void => {
    const r = panel.getBoundingClientRect(); dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = Math.max(200, r.width); H = Math.max(200, r.height);
    if (fc.width !== Math.round(W * dpr) || fc.height !== Math.round(H * dpr)) { fc.width = Math.round(W * dpr); fc.height = Math.round(H * dpr); }
    geo(); fit = fitView(bounds, W, H, FIT);
    if (atFit) { goal = { ...fit }; view = { ...fit }; } else clampGoal();
    // the legend starts folded when it would sit on the city at this size (it stays one click away)
    const left = W / 2 - ((bounds.x1 - bounds.x0) * fit.zoom) / 2, short = H / 2 + ((bounds.z1 - bounds.z0) * fit.zoom) / 2 > H - 330;
    if (!legendTouched) { const fold = left < 232 && short; legend.classList.toggle("min", fold); legendBtn.textContent = fold ? "show" : "hide"; }
  };
  const toFit = (): void => { atFit = true; goal = { ...fit }; };
  const toMe = (): void => { const p = d.player(); atFit = false; goal = { cx: p.x, cz: p.z, zoom: fit.zoom * 2.6 }; clampGoal(); };
  const zoomAt = (f: number, mx: number, my: number): void => {
    atFit = false;
    const wx = goal.cx + (mx - W / 2) / goal.zoom, wz = goal.cz + (my - H / 2) / goal.zoom;
    goal.zoom *= f; clampGoal();
    goal.cx = wx - (mx - W / 2) / goal.zoom; goal.cz = wz - (my - H / 2) / goal.zoom; clampGoal();
  };
  const scr = (x: number, z: number): [number, number] => [W / 2 + (x - view.cx) * view.zoom, H / 2 + (z - view.cz) * view.zoom];
  const wrl = (sx: number, sy: number): [number, number] => [view.cx + (sx - W / 2) / view.zoom, view.cz + (sy - H / 2) / view.zoom];

  const drawFull = (): void => {
    const g = fc.getContext("2d")!, rel = view.zoom / fit.zoom, p = d.player();
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = P.paper; g.fillRect(0, 0, W, H);
    g.save(); g.translate(W / 2, H / 2); g.scale(view.zoom, view.zoom); g.translate(-view.cx, -view.cz);
    drawCity(g, 1 / view.zoom, true);
    const tg = target(); if (tg) drawRoute(g, 1 / view.zoom, tg.kind);
    g.restore();
    // markers, then labels placed around them without overlap
    const k = rel < 1.6 ? 1 : rel < 3.5 ? 1.12 : 1.25;
    hits = allPlaces().filter((pl) => pl.kind !== "shop" || rel >= pl.showAt).sort((a, b) => a.pri - b.pri).map((pl) => { const [sx, sy] = scr(pl.x, pl.z); return { ...pl, sx, sy, x: sx, y: sy, r: markR(pl, k) }; });
    const labFont = (pl: MapPlace): string => `${pl.kind === "landmark" ? 800 : 700} ${pl.kind === "landmark" ? 13 : 12}px ${FONT}`;
    const labels: Label[] = [];
    for (const h of hits) {
      if (h.id !== hover?.id && rel < h.showAt) continue;
      labels.push({ id: h.id, text: h.name, x: h.sx, y: h.sy, r: h.r, w: measure(g, labFont(h), h.name) + 8, h: 17, priority: h.id === hover?.id ? 1000 : h.pri });
    }
    const you = scr(p.x, p.z);
    // district names sit inside their areas, large and quiet: only where the area is big enough, the name is not already a
    // place label, and (as the lowest priority) nothing else is in the way
    const dist = new Map<string, { txt: string; font: string }>();
    for (const dz of DISTRICTS) {
      if (hits.some((h) => h.name === dz.name)) continue;
      const [x0, y0] = scr(dz.r.x0, dz.r.z0), [x1, y1] = scr(dz.r.x1, dz.r.z1), txt = dz.name.toUpperCase(), font = `800 ${Math.min(15, Math.max(10, (x1 - x0) / 11))}px ${FONT}`;
      const tw = measure(g, font, txt) + txt.length * 1.5;
      if (tw > (x1 - x0) * 0.92 || x1 < 0 || y1 < 0 || x0 > W || y0 > H) continue;
      dist.set(`d:${dz.name}`, { txt, font });
      labels.push({ id: `d:${dz.name}`, text: txt, x: (x0 + x1) / 2, y: y0 + 14, r: 0, w: tw + 8, h: 16, priority: 1, fixed: true });
    }
    const placed = declutter(labels, [...hits.map((h) => ({ x: h.sx, y: h.sy, r: h.r })), { x: you[0], y: you[1], r: 16 }], { w: W, h: H });
    for (const pl of placed) { const dl = dist.get(pl.id); if (dl) label(g, dl.txt, pl.x, pl.y, dl.font, "rgba(27,35,54,.5)", 1.5); }
    for (const h of hits) placeMark(g, h, h.sx, h.sy, k);
    for (const pl of placed) { if (dist.has(pl.id)) continue; const h = hits.find((x) => x.id === pl.id)!; label(g, h.name, pl.x, pl.y, labFont(h), h.kind === "merchant" ? "#8a4300" : P.ink); }
    if (hover) { g.strokeStyle = P.ink; g.lineWidth = 3; g.beginPath(); g.arc(hover.sx, hover.sy, hover.r + 4, 0, 6.3); g.stroke(); g.strokeStyle = "#fff"; g.lineWidth = 1.5; g.stroke(); }
    const o = d.objective(); if (o && !waypoint) { const [sx, sy] = scr(o.x, o.z); star(g, sx, sy, 12, clock); }
    if (waypoint) { const [sx, sy] = scr(waypoint.x, waypoint.z); flag(g, sx, sy, 10); }
    playerMark(g, you[0], you[1], Math.PI - p.heading, 1.15, clock);
  };
  const readout = (): void => {
    const p = d.player(), noting = performance.now() < noteUntil;
    info.classList.toggle("on", !!waypoint || noting);
    clearBtn.style.display = waypoint ? "" : "none";
    if (waypoint) {
      const straight = Math.round(Math.hypot(waypoint.x - p.x, waypoint.z - p.z)), rm = routeMetres();
      infoB.innerHTML = `<svg width="14" height="18" viewBox="0 0 14 18"><path d="M7 17C1 10 1 3 7 1s6 9 0 16z" fill="${P.pink}" stroke="${P.ink}" stroke-width="1.6"/></svg>`;
      infoB.append(document.createTextNode(waypoint.name));
      infoE.textContent = rm !== null ? `${Math.round(rm)} m by street · ${straight} m straight` : `${straight} m straight · no walking route found`;
    } else { infoB.textContent = ""; infoE.textContent = ""; }
    note.textContent = noting ? noteText : "";
  };
  const setOpen = (on: boolean): void => {
    if (on === isOpen) return;
    isOpen = on; full.classList.toggle("on", on); d.setFrozen(on); tip.style.display = "none"; hover = null;
    if (on) { atFit = true; size(); view = { ...fit }; goal = { ...fit }; readout(); drawFull(); }
  };
  const run = (a: string): void => { if (a === "fit") toFit(); else if (a === "me") toMe(); else if (a === "in") zoomAt(1.45, W / 2, H / 2); else zoomAt(1 / 1.45, W / 2, H / 2); };

  window.addEventListener("keydown", (e) => {
    if ((e.target as HTMLElement | null)?.tagName === "INPUT") return;
    if (e.code === "KeyM" && (isOpen || d.allowed())) { setOpen(!isOpen); e.preventDefault(); e.stopImmediatePropagation(); }
    else if (e.code === "Escape" && isOpen) { setOpen(false); e.preventDefault(); e.stopImmediatePropagation(); } // never also opens the pause menu
    else if (isOpen) {
      const act = e.code === "Digit0" || e.code === "Numpad0" ? "fit" : e.code === "KeyC" ? "me" : e.code === "Equal" || e.code === "NumpadAdd" ? "in" : e.code === "Minus" || e.code === "NumpadSubtract" ? "out" : null;
      if (act) { run(act); e.preventDefault(); e.stopImmediatePropagation(); }
    }
  }, { capture: true });
  full.querySelectorAll<HTMLButtonElement>(".cm-ctl button").forEach((b) => b.addEventListener("click", () => run(b.dataset.a!)));
  clearBtn.onclick = () => { setWaypoint(null); readout(); };
  window.addEventListener("resize", () => { if (isOpen) size(); });
  const local = (e: PointerEvent | WheelEvent): [number, number] => { const r = fc.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  fc.addEventListener("wheel", (e) => { e.preventDefault(); const [mx, my] = local(e); zoomAt(e.deltaY < 0 ? 1.18 : 1 / 1.18, mx, my); }, { passive: false });
  fc.addEventListener("contextmenu", (e) => { e.preventDefault(); setWaypoint(null); readout(); });
  fc.addEventListener("pointerdown", (e) => { if (e.button !== 0) return; drag = { x: e.clientX, y: e.clientY, cx: goal.cx, cz: goal.cz, moved: false }; fc.setPointerCapture(e.pointerId); });
  fc.addEventListener("pointermove", (e) => {
    const [mx, my] = local(e);
    if (drag) {
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.hypot(dx, dy) > 4) { drag.moved = true; fc.classList.add("drag"); }
      if (drag.moved) { atFit = false; goal.cx = drag.cx - dx / goal.zoom; goal.cz = drag.cz - dy / goal.zoom; clampGoal(); view.cx = goal.cx; view.cz = goal.cz; hover = null; tip.style.display = "none"; return; }
    }
    hover = pick(hits, mx, my, 15); fc.classList.toggle("over", !!hover);
    if (hover) {
      const p = d.player(), m = Math.round(Math.hypot(hover.ax - p.x, hover.az - p.z));
      tip.innerHTML = `<b>${hover.name}</b><span>${m} m away · click to set waypoint</span>`; tip.style.display = "block";
      tip.style.left = `${Math.min(W - 230, mx + 14)}px`; tip.style.top = `${Math.max(8, my - 44)}px`;
    } else tip.style.display = "none";
  });
  fc.addEventListener("pointerup", (e) => {
    fc.classList.remove("drag");
    if (drag && !drag.moved) { // a click: waypoint on the place, or on the street there; clicking the current waypoint clears it
      const [mx, my] = local(e), h = pick(hits, mx, my, 15);
      const [wx, wz] = h ? [h.ax, h.az] : wrl(mx, my);
      if (waypoint && Math.hypot(waypoint.x - wx, waypoint.z - wz) < 18 / view.zoom) setWaypoint(null);
      else trySet(wx, wz, h ? h.name : "Waypoint");
      readout();
    }
    drag = null;
  });

  return {
    get open() { return isOpen; },
    update(dt) {
      clock += dt; acc += dt;
      const p = d.player();
      if (waypoint && Math.hypot(waypoint.x - p.x, waypoint.z - p.z) < REACHED_M) setWaypoint(null);
      refreshRoute(clock);
      (beam.material as THREE.MeshBasicMaterial).opacity = 0.3 + 0.08 * Math.sin(clock * 3);
      const show = d.allowed() && !isOpen;
      mm.classList.toggle("off", !show); tag.classList.toggle("off", !show);
      if (!isOpen) { if (show) drawMini(clock); return; }
      const f = 1 - Math.exp(-14 * Math.min(dt, 0.05));
      view.cx += (goal.cx - view.cx) * f; view.cz += (goal.cz - view.cz) * f; view.zoom += (goal.zoom - view.zoom) * f;
      if (acc >= 1 / 45 || Math.abs(goal.zoom - view.zoom) > 1e-3) { acc = 0; readout(); drawFull(); }
    },
  };
}
