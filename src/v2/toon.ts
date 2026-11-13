// Anime character shading: toon material + inverted-hull ink outline that follows skinning.
import * as THREE from "three";
import { mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";

function gradient(steps: number[]): THREE.DataTexture {
  const data = new Uint8Array(steps.length * 4);
  steps.forEach((v, i) => data.set([v, v, v, 255], i * 4));
  const t = new THREE.DataTexture(data, steps.length, 1);
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.needsUpdate = true;
  return t;
}
const RAMP = gradient([120, 175, 225, 255]);
/** Characters get a softer top step: under the 3.4 sun a full 255 clipped cream fabric to flat white (no texture left). */
const CHAR_RAMP = gradient([112, 160, 200, 226]);
/** Tripo's baked normal maps read as scratchy, wet highlights through toon bands; kept at this fraction of their strength. */
const CHAR_NORMAL = 0.35;

/** Ink line width on screen (CSS pixels) close up; with distance it thins with the world thickness instead. */
const INK_PX = 1.6;
const inkRes = { value: new THREE.Vector2(window.innerWidth, window.innerHeight) };
window.addEventListener("resize", () => inkRes.value.set(window.innerWidth, window.innerHeight));

// Screen-space hull: the vertex moves out along its normal by min(INK_PX, world thickness on screen) pixels, so the
// line never grows into a slab up close and still fades with distance.
const OUTLINE_VERT = /* glsl */ `
#include <common>
#include <skinning_pars_vertex>
uniform float thickness;
uniform vec2 resolution;
uniform float inkPx;
void main() {
  #include <beginnormal_vertex>
  #include <skinbase_vertex>
  #include <skinnormal_vertex>
  #include <begin_vertex>
  #include <skinning_vertex>
  vec4 clip = projectionMatrix * modelViewMatrix * vec4(transformed, 1.0);
  vec2 dir = (projectionMatrix * vec4(normalize(normalMatrix * objectNormal), 0.0)).xy;
  float len = length(dir);
  if (len > 1e-5) {
    float worldPx = thickness * projectionMatrix[1][1] * resolution.y * 0.5 / max(clip.w, 1e-3);
    clip.xy += dir / len * min(inkPx, worldPx) * 2.0 / resolution * clip.w;
  }
  gl_Position = clip;
}`;
const OUTLINE_FRAG = /* glsl */ `uniform vec3 inkColor; uniform float inkLight; void main() { gl_FragColor = vec4(inkColor * inkLight, 1.0); }`;

/** Character ink follows the scene light (1 by day): an unlit navy line read lighter than the shaded body at night and
 *  showed as a pale edge. Props keep a constant 1. */
const charInkLight = { value: 1 };
export function setInkLight(v: number): void { charInkLight.value = v; }

// ---------- glow: every emissive surface (lamps, bulbs, lit windows) follows one level, near 0 by day ----------
const glowing = new Set<THREE.MeshStandardMaterial | THREE.MeshToonMaterial>();
/** Daytime glow: a hint of light in lamps and windows, too little to bloom. */
export const DAY_GLOW = 0.08;
let glowLevel = DAY_GLOW;
/** Registers a material whose emissive should follow the time of day (no-op for non-emissive ones). */
export function trackGlow(m: THREE.Material): void {
  if (!(m instanceof THREE.MeshStandardMaterial || m instanceof THREE.MeshToonMaterial)) return;
  if (glowing.has(m) || (m.emissive.getHex() === 0 && !m.emissiveMap) || m.emissiveIntensity <= 0) return;
  m.userData.glow0 = m.emissiveIntensity;
  m.emissiveIntensity = m.userData.glow0 * glowLevel;
  glowing.add(m);
}
/** Changes a tracked material's full-glow strength (0 = dark, e.g. a closed stall's lantern). */
export function setGlowBase(m: THREE.Material, base: number): void {
  if (!glowing.has(m as THREE.MeshStandardMaterial)) return;
  m.userData.glow0 = base;
  (m as THREE.MeshStandardMaterial).emissiveIntensity = base * glowLevel;
}
/** 0..1: how lit the city's lamps and windows are (WP4 drives this from the clock). */
export function setGlow(level: number): void {
  glowLevel = level;
  for (const m of glowing) m.emissiveIntensity = Number(m.userData.glow0) * level;
}

function toToon(src: THREE.Material, character = false): THREE.MeshToonMaterial {
  const s = src as THREE.MeshStandardMaterial;
  const m = new THREE.MeshToonMaterial({
    color: s.color?.clone() ?? new THREE.Color("#fff"),
    map: s.map ?? null,
    gradientMap: character ? CHAR_RAMP : RAMP,
    emissive: s.emissive?.clone() ?? new THREE.Color(0),
    emissiveIntensity: s.emissiveIntensity ?? 1,
    emissiveMap: s.emissiveMap ?? null,
    side: s.side === THREE.DoubleSide ? THREE.DoubleSide : THREE.FrontSide,
    transparent: s.transparent,
    alphaTest: s.alphaTest,
    vertexColors: s.vertexColors,
  });
  m.onBeforeCompile = (sh) => {
    // Props: cool fresnel rim light. Characters: the rim only brightens the surface's own lit colour (a fixed cool
    // add painted a white-cyan halo on every character at night), and the lit result is eased 10% toward grey so the
    // post grade's saturation does not turn sunset skin orange.
    sh.fragmentShader = sh.fragmentShader.replace(
      "#include <opaque_fragment>",
      character
        ? `float rimF = pow(1.0 - saturate(dot(normalize(vNormal), normalize(vViewPosition))), 3.0);
           outgoingLight += outgoingLight * rimF * 0.3;
           outgoingLight = mix(vec3(dot(outgoingLight, vec3(0.2126, 0.7152, 0.0722))), outgoingLight, 0.9);
           #include <opaque_fragment>`
        : `float rimF = pow(1.0 - saturate(dot(normalize(vNormal), normalize(vViewPosition))), 3.0);
           outgoingLight += rimF * vec3(0.45, 0.7, 1.0) * 0.4;
           #include <opaque_fragment>`,
    );
  };
  m.customProgramCacheKey = () => (character ? "toon-char" : "toon-rim");
  if (s.normalMap) { m.normalMap = s.normalMap; m.normalScale.copy(s.normalScale).multiplyScalar(character ? CHAR_NORMAL : 1); } // keep surface detail
  trackGlow(m);
  return m;
}

/** The surface's own colour, darkened toward navy ink: lines read as shading, not a black stroke. */
function inkFor(mat: THREE.Material, ink: string): THREE.Color {
  const c = (mat as THREE.MeshToonMaterial).color?.clone() ?? new THREE.Color("#888");
  return new THREE.Color(ink).lerp(c.multiplyScalar(0.35), 0.45);
}

/** Outline hull geometry with one averaged normal per position, so hard-edged props (split normals)
 *  get a closed ink line instead of cracks at every sharp edge. */
function smoothHull(src: THREE.BufferGeometry): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", src.getAttribute("position"));
  if (src.index) g.setIndex(src.index);
  const merged = mergeVertices(g, 1e-4);
  merged.computeVertexNormals();
  return merged;
}

/** Converts every mesh under root to toon, with an ink outline unless `outline` is false. `thickness` is the
 *  line's largest width in world metres (screen width is capped at INK_PX). `hardSurface`: static props with split
 *  normals (smooth outline hull). See-through, cut-out and double-sided meshes never get a hull. */
export function applyToon(root: THREE.Object3D, thickness = 0.012, ink = "#1a2238", hardSurface = false, outline = true): void {
  const worldScale = new THREE.Vector3();
  root.updateWorldMatrix(true, true);
  const meshes: THREE.Mesh[] = [];
  root.traverse((o) => { if (o instanceof THREE.Mesh) meshes.push(o); });
  for (const mesh of meshes) {
    mesh.getWorldScale(worldScale);
    const character = mesh instanceof THREE.SkinnedMesh;
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map((m) => toToon(m, character)) : toToon(mesh.material, character);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    // skinned bounds don't follow the animation, so characters are never culled; static props are (off-screen ones cost
    // a draw call each, twice with their ink hull)
    mesh.frustumCulled = !character;
    const first = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    if (!outline || first.transparent || first.alphaTest > 0 || first.side === THREE.DoubleSide) continue;
    const mat = new THREE.ShaderMaterial({
      vertexShader: OUTLINE_VERT,
      fragmentShader: OUTLINE_FRAG,
      side: THREE.BackSide,
      uniforms: {
        thickness: { value: thickness / Math.max(worldScale.y, 1e-4) },
        inkColor: { value: inkFor(first, ink) },
        resolution: inkRes,
        inkPx: { value: INK_PX },
        inkLight: mesh instanceof THREE.SkinnedMesh ? charInkLight : { value: 1 },
      },
    });
    let hull: THREE.Mesh;
    if (mesh instanceof THREE.SkinnedMesh) {
      const sk = new THREE.SkinnedMesh(mesh.geometry, mat);
      sk.bind(mesh.skeleton, mesh.bindMatrix);
      hull = sk;
    } else {
      hull = new THREE.Mesh(hardSurface ? smoothHull(mesh.geometry) : mesh.geometry, mat);
    }
    hull.name = `${mesh.name}_outline`;
    hull.frustumCulled = !character;
    hull.castShadow = false;
    hull.receiveShadow = false;
    mesh.add(hull);
  }
}
