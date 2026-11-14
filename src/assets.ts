// GLB loading for Blender exports (Draco-compressed geometry).
import * as THREE from "three";
import { GLTFLoader, type GLTF } from "three/addons/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";
import type { Box } from "./physics/collision";

const draco = new DRACOLoader().setDecoderPath("/draco/");
const loader = new GLTFLoader().setDRACOLoader(draco);

// Startup prefetch. The city's models used to load one after another (plaza, then Kavi, then the market, then the
// townsfolk, then the merchants: each waited for the previous one to be parsed, so the network sat idle during every
// parse). `prefetch` keeps PREFETCH_LANES downloads running back to back in the order the game needs them, so the
// network never idles and the first model is not slowed by the last; it counts the bytes as they arrive (the loader's
// progress is real, not timed), and `loadGLB` parses from the buffer when its turn comes.
const PREFETCH_LANES = 2;
/** Every shipped model's size in bytes, written in at build time (vite.config.ts): the loader knows the whole total
 *  before the first byte arrives. Absent outside a Vite build (node checks), where sizes come from the responses. */
declare const __MODEL_BYTES__: Record<string, number> | undefined;
const SIZES: Record<string, number> = typeof __MODEL_BYTES__ === "undefined" ? {} : __MODEL_BYTES__;
interface Download { loaded: number; total: number; done: boolean }
const prefetched = new Map<string, Promise<ArrayBuffer>>();
const downloads = new Map<string, Download>();

async function fetchCounted(url: string, d: Download): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  // a compressed response's length is not the length we read: then the size is only known once it has arrived
  const len = Number(res.headers.get("content-length") ?? 0);
  if (!res.headers.get("content-encoding") && len > 0) d.total = len;
  if (!res.body) {
    const b = await res.arrayBuffer();
    Object.assign(d, { loaded: b.byteLength, total: b.byteLength, done: true });
    return b;
  }
  const reader = res.body.getReader(), chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    d.loaded += value.byteLength;
  }
  const out = new Uint8Array(d.loaded);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.byteLength; }
  Object.assign(d, { total: d.loaded, done: true });
  return out.buffer;
}

const waiting: (() => Promise<unknown>)[] = [];
let running = 0;
const pump = (): void => {
  while (running < PREFETCH_LANES && waiting.length) {
    running++;
    void waiting.shift()!().finally(() => { running--; pump(); });
  }
};

/** Queues these downloads, in this order, from now (and loads the Draco decoder). Later `loadGLB` calls use them. */
export function prefetch(urls: readonly string[]): void {
  draco.preload();
  for (const url of urls) {
    if (prefetched.has(url)) continue;
    const d: Download = { loaded: 0, total: SIZES[url] ?? 0, done: false };
    downloads.set(url, d);
    const p = new Promise<ArrayBuffer>((resolve, reject) => { waiting.push(() => fetchCounted(url, d).then(resolve, reject)); });
    p.catch(() => { d.done = true; }); // a failed prefetch is reported by the loadGLB that needs it
    prefetched.set(url, p);
  }
  pump();
}

/** The prefetch so far: bytes arrived, models finished, and `share`, the fraction done counting each model by its size
 *  where known (a model still queued counts as the average of those whose size is known). */
export function downloadProgress(): { loaded: number; files: number; finished: number; share: number } {
  let loaded = 0, finished = 0, sized = 0, sizedBytes = 0;
  for (const d of downloads.values()) {
    loaded += d.loaded;
    if (d.done) finished++;
    if (d.total) { sized++; sizedBytes += d.total; }
  }
  const files = downloads.size, avg = sized ? sizedBytes / sized : 0;
  const expected = sizedBytes + (files - sized) * avg;
  const share = files === 0 ? 1 : finished === files ? 1 : expected > 0 ? Math.min(0.99, loaded / expected) : 0;
  return { loaded, files, finished, share };
}

/** True once this prefetched file has fully arrived (or failed); true for a file that was never prefetched. */
export const downloadDone = (url: string): boolean => downloads.get(url)?.done ?? true;

/** Drops the prefetched buffers once the scene has been built from them (they would otherwise stay in memory). */
export function releasePrefetch(): void {
  prefetched.clear();
}

export function loadGLB(url: string): Promise<GLTF> {
  const buffer = prefetched.get(url);
  if (!buffer) return loader.loadAsync(url);
  return buffer.then((b) => loader.parseAsync(b, url.slice(0, url.lastIndexOf("/") + 1)));
}

/**
 * Window glass: the buildings are hollow shells, so transparent glass shows a black void.
 * Opaque, glossy glass reflects the sky instead; lit panes glow like occupied rooms at dusk.
 */
function dressGlass(m: THREE.MeshStandardMaterial, lit: boolean): void {
  m.transparent = false;
  m.opacity = 1;
  m.depthWrite = true;
  m.alphaMap = null;
  m.roughness = lit ? 0.35 : 0.06;
  m.metalness = lit ? 0 : 0.9;
  m.color.set(lit ? "#6b4a2e" : "#2a3442");
  m.envMapIntensity = lit ? 0.4 : 1.6;
  if (lit) {
    m.emissive.set("#ffb46b");
    m.emissiveIntensity = 1.6;
  }
  m.needsUpdate = true;
}

/** Materials that get weathering: plaster, trim and stone of the historic Row (not glass, metal or emitters). */
const WEATHERED = /^(facade_plaster|modular_urban_apartments_facade_(plaster|trim)|tower_stone|beige_wall|curb_stone)/;

/**
 * Weathering in world space, so every copy of a kit piece ages differently: rising damp and street grime
 * near the ground, rain streaks running down the walls, broad tonal variation (no two bays share a tone)
 * and matching roughness changes (damp and dirty plaster is less rough). Cost: two value-noise lookups.
 */
function weather(m: THREE.MeshStandardMaterial): void {
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vWeatherPos;")
      .replace("#include <worldpos_vertex>", "#include <worldpos_vertex>\nvWeatherPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;");
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
varying vec3 vWeatherPos;
float wHash( vec2 p ) { return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453 ); }
float wNoise( vec2 p ) {
  vec2 i = floor( p ), f = fract( p ); vec2 u = f * f * ( 3.0 - 2.0 * f );
  return mix( mix( wHash( i ), wHash( i + vec2( 1, 0 ) ), u.x ), mix( wHash( i + vec2( 0, 1 ) ), wHash( i + vec2( 1, 1 ) ), u.x ), u.y );
}`,
      )
      .replace(
        "#include <map_fragment>",
        `#include <map_fragment>
  float wAlong = vWeatherPos.x + vWeatherPos.z;            // runs along any wall facing x or z
  float wTone = wNoise( vec2( wAlong, vWeatherPos.y ) * 0.09 );                 // broad patches
  float wStreak = wNoise( vec2( wAlong * 2.6, vWeatherPos.y * 0.12 ) );         // long vertical drips
  float wDamp = 1.0 - smoothstep( 0.0, 1.5 + wNoise( vec2( wAlong * 0.7, 3.1 ) ) * 0.9, vWeatherPos.y ); // rising damp
  float wDirt = clamp( wDamp * 0.55 + smoothstep( 0.62, 0.95, wStreak ) * 0.22, 0.0, 0.7 );
  vec3 wGrime = vec3( 0.42, 0.38, 0.33 );
  diffuseColor.rgb *= mix( vec3( 1.0 ), wGrime, wDirt ) * ( 0.92 + wTone * 0.16 );
  float wRough = wDirt;`,
      )
      .replace(
        "#include <roughnessmap_fragment>",
        "#include <roughnessmap_fragment>\n  roughnessFactor = clamp( roughnessFactor - wRough * 0.18, 0.04, 1.0 );",
      );
  };
  m.customProgramCacheKey = () => "weathered";
  m.needsUpdate = true;
}

export interface PreparedModel {
  readonly colliders: Box[];
  readonly blockers: THREE.Mesh[];
}

/**
 * Applies the Blender export conventions (see blender/build_street.py):
 *  - COL_* meshes become collision boxes and are hidden
 *  - materials named "*__tint_rrggbb" get that base-colour multiplier
 *  - every visible mesh casts and receives shadows
 */
export function prepareModel(root: THREE.Object3D): PreparedModel {
  root.updateMatrixWorld(true);
  const colliders: Box[] = [];
  const blockers: THREE.Mesh[] = [];
  const bounds = new THREE.Box3();
  const hidden: THREE.Object3D[] = [];

  root.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    if (obj.name.startsWith("COL_")) {
      bounds.setFromObject(obj);
      colliders.push({
        minX: bounds.min.x, minY: bounds.min.y, minZ: bounds.min.z,
        maxX: bounds.max.x, maxY: bounds.max.y, maxZ: bounds.max.z,
      });
      hidden.push(obj);
      return;
    }
    obj.castShadow = true;
    obj.receiveShadow = true;
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (const m of mats) {
      if (!(m instanceof THREE.MeshStandardMaterial)) continue;
      const tint = /__tint_([0-9a-f]{6})/i.exec(m.name);
      if (tint) m.color.set(`#${tint[1]}`); // hex is sRGB; three converts
      if (m.name.startsWith("modular_urban_apartments_facade_glass")) dressGlass(m, false);
      if (m.name.startsWith("facade_glass_lit")) dressGlass(m, true);
      if (WEATHERED.test(m.name) && !m.userData.weathered) {
        m.userData.weathered = true;
        weather(m);
      }
      if (/leaves/i.test(m.name)) {
        // Foliage cards: alpha-tested cut-out (sorted blending flickers and turns canopies see-through).
        m.transparent = false;
        m.alphaTest = 0.5;
        m.depthWrite = true;
        m.side = THREE.DoubleSide;
        // Mipmapping averages the cut-out alpha down with distance, so far trees lost their leaves and looked bare.
        // Scale alpha up by the mip level being sampled so canopies keep their coverage at any distance.
        m.onBeforeCompile = (sh) => {
          sh.fragmentShader = sh.fragmentShader.replace(
            "#include <alphatest_fragment>",
            `#ifdef USE_MAP
               vec2 texel = vMapUv * vec2(textureSize(map, 0));
               float mip = max(0.0, 0.5 * log2(max(dot(dFdx(texel), dFdx(texel)), dot(dFdy(texel), dFdy(texel)))));
               diffuseColor.a *= 1.0 + mip * 0.3;
             #endif
             #include <alphatest_fragment>`,
          );
        };
        m.customProgramCacheKey = () => "leaf-coverage";
        m.needsUpdate = true;
      }
    }
    if (obj.name.startsWith("BLD_")) blockers.push(obj);
  });
  for (const h of hidden) h.removeFromParent();
  return { colliders, blockers };
}
