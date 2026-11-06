// Layered golden-hour clouds: an fbm cloud deck on a camera-following dome, lit from the sun direction
// (warm sun-side rims, cooler bellies), fading into the horizon haze. One draw call, no textures.
import * as THREE from "three";

const vertex = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = normalize((modelMatrix * vec4(position, 0.0)).xyz);
    gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0);
  }`;

const fragment = /* glsl */ `
  uniform vec3 uSun;
  uniform float uTime;
  uniform float uCoverage;
  varying vec3 vDir;
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
  }
  float fbm(vec2 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 6; i++) { v += a * noise(p); p = p * 2.02 + 17.0; a *= 0.5; }
    return v;
  }
  void main() {
    vec3 d = normalize(vDir);
    if (d.y < 0.0) discard;
    // Project onto a flat cloud deck: distant clouds compress toward the horizon.
    vec2 uv = d.xz / (d.y + 0.1) * 0.9 + vec2(uTime * 0.0035, uTime * 0.0012);
    float base = fbm(uv);
    float detail = fbm(uv * 3.1 + 5.3);
    float shape = base * 0.8 + detail * 0.35;
    float cover = smoothstep(uCoverage, uCoverage + 0.22, shape);
    float horizon = smoothstep(0.015, 0.22, d.y);
    float alpha = cover * horizon * 0.95;
    if (alpha < 0.01) discard;
    vec3 sun = normalize(uSun);
    float towardSun = max(dot(d, sun), 0.0);
    float thickness = smoothstep(uCoverage, uCoverage + 0.45, shape);
    vec3 belly = vec3(0.34, 0.31, 0.38);
    vec3 top = mix(vec3(1.05, 0.74, 0.52), vec3(0.98, 0.9, 0.84), smoothstep(0.0, 0.6, d.y));
    vec3 col = mix(top, belly, thickness * 0.65);
    col += vec3(1.25, 0.62, 0.28) * pow(towardSun, 5.0) * (1.0 - thickness * 0.5); // silver-gold lining
    gl_FragColor = vec4(col * 1.45, alpha);
  }`;

export function createClouds(scene: THREE.Scene, sunDir: THREE.Vector3, coverage = 0.52): THREE.Mesh {
  const material = new THREE.ShaderMaterial({
    vertexShader: vertex,
    fragmentShader: fragment,
    uniforms: { uSun: { value: sunDir.clone() }, uTime: { value: 0 }, uCoverage: { value: coverage } },
    transparent: true,
    depthWrite: false,
    side: THREE.BackSide,
    fog: false,
  });
  // Radius inside the camera far plane (600); the dome follows the camera so it never gets closer.
  const dome = new THREE.Mesh(new THREE.SphereGeometry(520, 48, 24), material);
  dome.renderOrder = -1;
  dome.frustumCulled = false;
  const start = performance.now();
  dome.onBeforeRender = (_r, _s, camera) => {
    dome.position.copy(camera.position);
    material.uniforms.uTime.value = (performance.now() - start) / 1000;
  };
  scene.add(dome);
  return dome;
}
