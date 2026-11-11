// Renderer, sky, lights and post pipeline for the bright anime-style look.
import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { DAY_GLOW, setGlow } from "./toon";

export interface Pipeline {
  render(): void;
  resize(w: number, h: number): void;
  setCamera(c: THREE.Camera): void;
  readonly composer: EffectComposer;
}
export interface Look {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly sun: THREE.DirectionalLight;
  readonly pipeline: Pipeline;
  /** Move the shadow frustum with the player, snapped to shadow texels. */
  followSun(target: THREE.Vector3): void;
  updateSky(time: number, camPos: THREE.Vector3): void;
  /** Day and night from the game clock (minutes since midnight): sky, sun or moon, fill light, fog, glow. */
  setTime(minuteOfDay: number): void;
}

// From behind the camera-left (the player looks -Z at the Spire): the N is front-lit, shadows fall away (reference).
const SUN_DIR = new THREE.Vector3(-0.5, 0.78, 0.42).normalize();

/** One lighting state of the day. Colours are linear (as the sky shader and lights use them). */
interface Key {
  at: number; zen: number[]; mid: number[]; hor: number[]; cloud: number[]; sun: string; sunI: number; dir: number[];
  sky: string; ground: string; hemiI: number; fog: string; exposure: number; glow: number;
}
const DAY: Omit<Key, "at"> = {
  zen: [0.04, 0.24, 0.86], mid: [0.12, 0.45, 0.98], hor: [0.5, 0.76, 1.0], cloud: [1, 1, 1], sun: "#fff4de", sunI: 3.4,
  dir: [SUN_DIR.x, SUN_DIR.y, SUN_DIR.z], sky: "#9ccaff", ground: "#8a9cc8", hemiI: 1.0, fog: "#8fc6ff", exposure: 1.2, glow: DAY_GLOW,
};
const DAWN: Omit<Key, "at"> = {
  zen: [0.1, 0.22, 0.55], mid: [0.45, 0.45, 0.7], hor: [1.0, 0.66, 0.45], cloud: [1.0, 0.82, 0.75], sun: "#ffc58a", sunI: 2.0,
  dir: [0.75, 0.25, 0.35], sky: "#c8b8d8", ground: "#7a6a80", hemiI: 0.85, fog: "#e8b89a", exposure: 1.15, glow: 0.35,
};
const DUSK: Omit<Key, "at"> = {
  zen: [0.12, 0.14, 0.42], mid: [0.55, 0.35, 0.55], hor: [1.0, 0.52, 0.3], cloud: [1.0, 0.7, 0.6], sun: "#ff9a5a", sunI: 1.8,
  dir: [-0.8, 0.22, 0.4], sky: "#b0a0d0", ground: "#5a4a6a", hemiI: 0.8, fog: "#d89a80", exposure: 1.15, glow: 0.75,
};
// Night stays readable: a cool moon from high up, a bright blue fill, and the lamps at full glow.
const NIGHT: Omit<Key, "at"> = {
  zen: [0.01, 0.02, 0.07], mid: [0.03, 0.06, 0.16], hor: [0.1, 0.16, 0.32], cloud: [0.18, 0.22, 0.35], sun: "#9fb8ff", sunI: 0.9,
  dir: [-0.3, 0.75, 0.5], sky: "#5a70b0", ground: "#283048", hemiI: 0.75, fog: "#1a2440", exposure: 1.3, glow: 1,
};
/** Dawn 06:00, full day 08:30 to 17:00, sunset 19:00, dark by 21:30 (rent night). Hours. */
const KEYS: Key[] = [
  { at: 0, ...NIGHT }, { at: 4.5, ...NIGHT }, { at: 6, ...DAWN }, { at: 8.5, ...DAY }, { at: 17, ...DAY },
  { at: 19, ...DUSK }, { at: 21.5, ...NIGHT }, { at: 24, ...NIGHT },
];
const SHADOW_SIZE = 2048;
const SHADOW_HALF = 38;

const SKY_VERT = /* glsl */ `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); gl_Position.z = gl_Position.w; }`;
const SKY_FRAG = /* glsl */ `
varying vec3 vDir; uniform float uTime; uniform vec3 uSun; uniform vec3 uZen, uMid, uHor, uCloud;
float h(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
float n(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);
  return mix(mix(h(i),h(i+vec2(1,0)),f.x), mix(h(i+vec2(0,1)),h(i+vec2(1,1)),f.x), f.y); }
float fbm(vec2 p){ float a=.5, s=0.; for(int i=0;i<5;i++){ s+=a*n(p); p=p*2.03+7.1; a*=.5; } return s; }
void main(){
  vec3 d = normalize(vDir);
  float t = clamp(d.y, 0., 1.);
  vec3 zenith = uZen, mid = uMid, hor = uHor;
  vec3 col = mix(hor, mid, smoothstep(0., .18, t)); col = mix(col, zenith, smoothstep(.2, .85, t));
  float sd = max(dot(d, uSun), 0.);
  col += vec3(1., .95, .8) * (pow(sd, 600.) * 2. + pow(sd, 12.) * .12);
  // cel clouds: planar projection, hard-stepped fbm, lit top / blue-grey underside
  if (d.y > 0.02) {
    vec2 uv = d.xz / (d.y + 0.25) * 1.6 + vec2(uTime * 0.004, 0.);
    float c = fbm(uv * 1.1);
    float body = smoothstep(.50, .53, c);
    float lit = smoothstep(.58, .61, c);
    vec3 cloud = mix(vec3(0.68, 0.78, 0.95), vec3(1.), lit);
    cloud = mix(cloud, vec3(1.0, .99, .96), step(.62, c) * .5) * uCloud;
    float fade = smoothstep(.02, .22, d.y);
    col = mix(col, cloud, body * fade * 0.97);
  }
  gl_FragColor = vec4(col, 1.);
}`;

export function createLook(canvas: HTMLCanvasElement): Look {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: "high-performance" });
  // 1.5 at most: the frame is 4x MSAA + bloom + grade, so DPR 2 would cost 4x the pixels of 1080p for little gain
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.2;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap; // soft PCF in r187 (PCFSoftShadowMap removed)

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog("#8fc6ff", 150, 900);

  // sky dome (also baked once into the environment map for reflections / fill)
  const skyMat = new THREE.ShaderMaterial({
    vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: {
      uTime: { value: 0 }, uSun: { value: SUN_DIR.clone() },
      uZen: { value: new THREE.Vector3(...DAY.zen) }, uMid: { value: new THREE.Vector3(...DAY.mid) },
      uHor: { value: new THREE.Vector3(...DAY.hor) }, uCloud: { value: new THREE.Vector3(...DAY.cloud) },
    },
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(1000, 32, 16), skyMat);
  sky.frustumCulled = false;
  sky.renderOrder = -1;
  scene.add(sky);

  // far ground so the level never ends in a void
  const far = new THREE.Mesh(new THREE.CircleGeometry(1200, 48).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: "#9fb4c8", roughness: 1 }));
  far.position.y = -0.15;
  far.receiveShadow = true;
  scene.add(far);

  // Reflections and fill come from the sky itself; re-baked when the sky changes enough (see setTime).
  const envScene = new THREE.Scene();
  envScene.add(new THREE.Mesh(new THREE.SphereGeometry(100, 32, 16), skyMat)); // shares the live sky uniforms
  const pmrem = new THREE.PMREMGenerator(renderer);
  let envTarget = pmrem.fromScene(envScene, 0.02);
  scene.environment = envTarget.texture;
  const rebakeEnv = (): void => {
    const next = pmrem.fromScene(envScene, 0.02);
    scene.environment = next.texture;
    // materials that captured the old map explicitly (the cars) follow the new one
    scene.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        if (m instanceof THREE.MeshStandardMaterial && m.envMap === envTarget.texture) m.envMap = next.texture;
      }
    });
    envTarget.dispose();
    envTarget = next;
  };
  scene.environmentIntensity = 0.35;

  const hemi = new THREE.HemisphereLight("#9ccaff", "#8a9cc8", 1.0); // cool fill, blue-tinted shadows
  scene.add(hemi);

  const sun = new THREE.DirectionalLight("#fff4de", 3.4);
  sun.castShadow = true;
  sun.shadow.mapSize.set(SHADOW_SIZE, SHADOW_SIZE);
  const sc = sun.shadow.camera;
  sc.left = sc.bottom = -SHADOW_HALF; sc.right = sc.top = SHADOW_HALF; sc.near = 1; sc.far = 220;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.04;
  sun.shadow.radius = 3;
  scene.add(sun, sun.target);

  // MSAA target + bloom (high threshold: emissives only) + tone-map/sRGB output
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  const target = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: 4 });
  const composer = new EffectComposer(renderer, target);
  const camera = new THREE.PerspectiveCamera(); // replaced by game via RenderPass.camera
  const pass = new RenderPass(scene, camera);
  composer.addPass(pass);
  const bloom = new UnrealBloomPass(new THREE.Vector2(size.x / 2, size.y / 2), 0.2, 0.5, 1.8);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
  // cheap grade after tone mapping: saturation + gentle S-curve contrast (display-referred)
  composer.addPass(new ShaderPass({
    uniforms: { tDiffuse: { value: null }, sat: { value: 1.3 }, con: { value: 1.08 } },
    vertexShader: "varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }",
    fragmentShader: `uniform sampler2D tDiffuse; uniform float sat, con; varying vec2 vUv;
      void main(){ vec3 c = texture2D(tDiffuse, vUv).rgb; float l = dot(c, vec3(.2126,.7152,.0722));
        c = mix(vec3(l), c, sat); c = (c - .5) * con + .5; gl_FragColor = vec4(clamp(c,0.,1.), 1.); }`,
  }));

  const pipeline: Pipeline = {
    composer,
    setCamera(c) { pass.camera = c; },
    render() { composer.render(); },
    resize(w, h) {
      renderer.setSize(w, h, false);
      composer.setPixelRatio(renderer.getPixelRatio());
      composer.setSize(w, h);
    },
  };

  const snap = new THREE.Vector3();
  const texel = (2 * SHADOW_HALF) / SHADOW_SIZE;
  const sunDir = SUN_DIR.clone();
  const fog = scene.fog as THREE.Fog;
  const ca = new THREE.Color(), cb = new THREE.Color();
  const mixV = (u: { value: THREE.Vector3 }, a: number[], b: number[], t: number): void => {
    u.value.set(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t);
  };
  const mixC = (out: THREE.Color, a: string, b: string, t: number): void => { out.copy(ca.set(a)).lerp(cb.set(b), t); };
  let lastBake = -1, bakedAt = -Infinity;
  return {
    renderer, scene, sun, pipeline,
    setTime(minuteOfDay) {
      const h = (((minuteOfDay / 60) % 24) + 24) % 24;
      let i = 0;
      while (i < KEYS.length - 2 && KEYS[i + 1].at <= h) i++;
      const a = KEYS[i], b = KEYS[i + 1];
      const lin = (h - a.at) / (b.at - a.at);
      const t = lin * lin * (3 - 2 * lin); // ease in and out of each phase
      const u = skyMat.uniforms;
      mixV(u.uZen, a.zen, b.zen, t); mixV(u.uMid, a.mid, b.mid, t); mixV(u.uHor, a.hor, b.hor, t); mixV(u.uCloud, a.cloud, b.cloud, t);
      sunDir.set(a.dir[0] + (b.dir[0] - a.dir[0]) * t, a.dir[1] + (b.dir[1] - a.dir[1]) * t, a.dir[2] + (b.dir[2] - a.dir[2]) * t).normalize();
      u.uSun.value.copy(sunDir);
      mixC(sun.color, a.sun, b.sun, t); sun.intensity = a.sunI + (b.sunI - a.sunI) * t;
      mixC(hemi.color, a.sky, b.sky, t); mixC(hemi.groundColor, a.ground, b.ground, t); hemi.intensity = a.hemiI + (b.hemiI - a.hemiI) * t;
      mixC(fog.color, a.fog, b.fog, t);
      renderer.toneMappingExposure = a.exposure + (b.exposure - a.exposure) * t;
      setGlow(a.glow + (b.glow - a.glow) * t);
      // the sky's reflections: re-bake every quarter game-hour (a few ms; never per frame)
      const q = Math.floor(h * 4), now = performance.now();
      if (q !== lastBake && now - bakedAt > 500) { lastBake = q; bakedAt = now; rebakeEnv(); } // fast-forward: twice a second at most
    },
    followSun(t) {
      // work in light space so the snap is along shadow-map axes
      const m = sun.shadow.camera.matrixWorldInverse;
      sun.position.copy(t).addScaledVector(sunDir, 110);
      sun.target.position.copy(t);
      sun.updateMatrixWorld(); sun.target.updateMatrixWorld();
      sun.shadow.camera.position.copy(sun.position);
      sun.shadow.camera.lookAt(sun.target.position);
      sun.shadow.camera.updateMatrixWorld();
      m.copy(sun.shadow.camera.matrixWorld).invert();
      snap.copy(t).applyMatrix4(m);
      const dx = snap.x - Math.round(snap.x / texel) * texel;
      const dy = snap.y - Math.round(snap.y / texel) * texel;
      const right = new THREE.Vector3().setFromMatrixColumn(sun.shadow.camera.matrixWorld, 0);
      const up = new THREE.Vector3().setFromMatrixColumn(sun.shadow.camera.matrixWorld, 1);
      sun.position.addScaledVector(right, -dx).addScaledVector(up, -dy);
      sun.target.position.addScaledVector(right, -dx).addScaledVector(up, -dy);
    },
    updateSky(time, camPos) { skyMat.uniforms.uTime.value = time; sky.position.copy(camPos); },
  } as Look;
}
