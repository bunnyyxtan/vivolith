// Atmosphere: height fog with sun in-scattering, replacing three's flat-colour fog for every material.
// Physically motivated: optical depth from an exponential height profile (dense near the ground and the sea,
// thin aloft), plus a little uniform haze; the in-scattered colour turns warm toward the sun (Mie forward
// scattering) and stays cool away from it. scene.fog (FogExp2) still drives colour and density at runtime.
import * as THREE from "three";

export interface AtmosphereOptions {
  /** World-space direction toward the sun. */
  readonly sunDir: THREE.Vector3;
  /** In-scattered colour looking at the sun (linear RGB, may exceed 1). */
  readonly sunColor: readonly [number, number, number];
  /** Sharpness of the forward-scattering lobe (higher = tighter around the sun). */
  readonly sunPower: number;
  /** Inverse scale height (1/m): 0.035 -> density halves every ~20 m of altitude. */
  readonly heightFalloff: number;
  /** Height-independent haze (per metre), keeps very far objects soft. */
  readonly baseHaze: number;
}

const f = (n: number) => n.toFixed(5);

/** Must run before the first render (shaders compile lazily on first use). */
export function installAtmosphere(o: AtmosphereOptions): void {
  const s = o.sunDir.clone().normalize();
  THREE.ShaderChunk.fog_pars_vertex = /* glsl */ `
#ifdef USE_FOG
  varying float vFogDepth;
  varying vec3 vFogRay;
#endif`;
  THREE.ShaderChunk.fog_vertex = /* glsl */ `
#ifdef USE_FOG
  vFogDepth = - mvPosition.z;
  vFogRay = ( vec4( mvPosition.xyz, 0.0 ) * viewMatrix ).xyz; // view -> world rotation (camera to fragment)
#endif`;
  THREE.ShaderChunk.fog_pars_fragment = /* glsl */ `
#ifdef USE_FOG
  uniform vec3 fogColor;
  varying float vFogDepth;
  varying vec3 vFogRay;
  #ifdef FOG_EXP2
    uniform float fogDensity;
  #else
    uniform float fogNear;
    uniform float fogFar;
  #endif
  const vec3 ATMO_SUN_DIR = vec3( ${f(s.x)}, ${f(s.y)}, ${f(s.z)} );
  const vec3 ATMO_SUN_COLOR = vec3( ${f(o.sunColor[0])}, ${f(o.sunColor[1])}, ${f(o.sunColor[2])} );
#endif`;
  THREE.ShaderChunk.fog_fragment = /* glsl */ `
#ifdef USE_FOG
  #ifdef FOG_EXP2
    float atmoDist = length( vFogRay );
    vec3 atmoDir = vFogRay / max( atmoDist, 1e-4 );
    float atmoRise = atmoDir.y * atmoDist;
    float atmoB = ${f(o.heightFalloff)};
    float atmoHeight = abs( atmoRise ) > 1e-3 ? ( 1.0 - exp( - atmoB * atmoRise ) ) / ( atmoB * atmoRise ) : 1.0;
    float atmoDepth = fogDensity * exp( - atmoB * max( cameraPosition.y, 0.0 ) ) * atmoDist * atmoHeight + ${f(o.baseHaze)} * atmoDist;
    float fogFactor = 1.0 - exp( - atmoDepth );
    float atmoSun = pow( max( dot( atmoDir, ATMO_SUN_DIR ), 0.0 ), ${f(o.sunPower)} );
    vec3 atmoColor = mix( fogColor, ATMO_SUN_COLOR, atmoSun );
  #else
    float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
    vec3 atmoColor = fogColor;
  #endif
  gl_FragColor.rgb = mix( gl_FragColor.rgb, atmoColor, fogFactor );
#endif`;
}

/**
 * Tames three's Sky shader: scales its radiance (it is authored for very high exposure) and soft-clips the
 * sun disc so bloom sees a bright sun, not a frame-filling flare.
 */
export function tameSky(material: THREE.ShaderMaterial, gain: number, discMax: number): void {
  material.uniforms.skyGain = { value: gain };
  material.uniforms.discMax = { value: discMax };
  material.fragmentShader = material.fragmentShader
    .replace("void main() {", "uniform float skyGain;\nuniform float discMax;\nvoid main() {")
    .replace(
      "gl_FragColor = vec4( texColor, 1.0 );",
      "vec3 skyC = texColor * skyGain;\n\t\t\tfloat skyPeak = max( max( skyC.r, skyC.g ), skyC.b );\n" +
        "\t\t\tskyC *= skyPeak > discMax ? discMax / skyPeak : 1.0;\n\t\t\tgl_FragColor = vec4( skyC, 1.0 );",
    );
  material.needsUpdate = true;
}
