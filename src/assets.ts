// GLB loading for Blender exports (Draco-compressed geometry).
import * as THREE from "three";
import { GLTFLoader, type GLTF } from "three/addons/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";
import type { Box } from "./physics/collision";

const draco = new DRACOLoader().setDecoderPath("/draco/");
const loader = new GLTFLoader().setDRACOLoader(draco);

export function loadGLB(url: string): Promise<GLTF> {
  return loader.loadAsync(url);
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
        m.needsUpdate = true;
      }
    }
    if (obj.name.startsWith("BLD_")) blockers.push(obj);
  });
  for (const h of hidden) h.removeFromParent();
  return { colliders, blockers };
}
