// Anime character shading: toon material + inverted-hull ink outline that follows skinning.
import * as THREE from "three";

function gradient(steps: number[]): THREE.DataTexture {
  const data = new Uint8Array(steps.length * 4);
  steps.forEach((v, i) => data.set([v, v, v, 255], i * 4));
  const t = new THREE.DataTexture(data, steps.length, 1);
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.needsUpdate = true;
  return t;
}
const RAMP = gradient([120, 175, 225, 255]);

const OUTLINE_VERT = /* glsl */ `
#include <common>
#include <skinning_pars_vertex>
uniform float thickness;
void main() {
  #include <beginnormal_vertex>
  #include <skinbase_vertex>
  #include <skinnormal_vertex>
  #include <begin_vertex>
  #include <skinning_vertex>
  transformed += normalize(objectNormal) * thickness;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(transformed, 1.0);
}`;
const OUTLINE_FRAG = /* glsl */ `uniform vec3 inkColor; void main() { gl_FragColor = vec4(inkColor, 1.0); }`;

function toToon(src: THREE.Material): THREE.MeshToonMaterial {
  const s = src as THREE.MeshStandardMaterial;
  const m = new THREE.MeshToonMaterial({
    color: s.color?.clone() ?? new THREE.Color("#fff"),
    map: s.map ?? null,
    gradientMap: RAMP,
    emissive: s.emissive?.clone() ?? new THREE.Color(0),
    emissiveIntensity: s.emissiveIntensity ?? 1,
    emissiveMap: s.emissiveMap ?? null,
    side: s.side === THREE.DoubleSide ? THREE.DoubleSide : THREE.FrontSide,
    transparent: s.transparent,
    alphaTest: s.alphaTest,
  });
  m.onBeforeCompile = (sh) => {
    // cool fresnel rim light
    sh.fragmentShader = sh.fragmentShader.replace(
      "#include <opaque_fragment>",
      `float rimF = pow(1.0 - saturate(dot(normalize(vNormal), normalize(vViewPosition))), 3.0);
       outgoingLight += rimF * vec3(0.45, 0.7, 1.0) * 0.4;
       #include <opaque_fragment>`,
    );
  };
  m.customProgramCacheKey = () => "toon-rim";
  return m;
}

/** Converts every mesh under root to toon + outline. `thickness` is world metres. */
export function applyToon(root: THREE.Object3D, thickness = 0.012, ink = "#1a2238"): void {
  const worldScale = new THREE.Vector3();
  root.updateWorldMatrix(true, true);
  const meshes: THREE.Mesh[] = [];
  root.traverse((o) => { if (o instanceof THREE.Mesh) meshes.push(o); });
  for (const mesh of meshes) {
    mesh.getWorldScale(worldScale);
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(toToon) : toToon(mesh.material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    const mat = new THREE.ShaderMaterial({
      vertexShader: OUTLINE_VERT,
      fragmentShader: OUTLINE_FRAG,
      side: THREE.BackSide,
      uniforms: { thickness: { value: thickness / Math.max(worldScale.y, 1e-4) }, inkColor: { value: new THREE.Color(ink) } },
    });
    let hull: THREE.Mesh;
    if (mesh instanceof THREE.SkinnedMesh) {
      const sk = new THREE.SkinnedMesh(mesh.geometry, mat);
      sk.bind(mesh.skeleton, mesh.bindMatrix);
      hull = sk;
    } else {
      hull = new THREE.Mesh(mesh.geometry, mat);
    }
    hull.name = `${mesh.name}_outline`;
    hull.frustumCulled = false;
    hull.castShadow = false;
    hull.receiveShadow = false;
    mesh.add(hull);
  }
}
