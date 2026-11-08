// Renderer, sky, lights and post pipeline for the bright anime-style look.
import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";

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
}

// From behind the camera-left (the player looks -Z at the Spire): the N is front-lit, shadows fall away (reference).
const SUN_DIR = new THREE.Vector3(-0.5, 0.78, 0.42).normalize();
const SHADOW_SIZE = 2048;
const SHADOW_HALF = 38;

const SKY_VERT = /* glsl */ `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); gl_Position.z = gl_Position.w; }`;
const SKY_FRAG = /* glsl */ `
varying vec3 vDir; uniform float uTime; uniform vec3 uSun;
float h(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
float n(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);
  return mix(mix(h(i),h(i+vec2(1,0)),f.x), mix(h(i+vec2(0,1)),h(i+vec2(1,1)),f.x), f.y); }
float fbm(vec2 p){ float a=.5, s=0.; for(int i=0;i<5;i++){ s+=a*n(p); p=p*2.03+7.1; a*=.5; } return s; }
void main(){
  vec3 d = normalize(vDir);
  float t = clamp(d.y, 0., 1.);
  vec3 zenith = vec3(0.04, 0.24, 0.86), mid = vec3(0.12, 0.45, 0.98), hor = vec3(0.50, 0.76, 1.0);
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
    cloud = mix(cloud, vec3(1.0, .99, .96), step(.62, c) * .5);
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
    uniforms: { uTime: { value: 0 }, uSun: { value: SUN_DIR.clone() } },
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

  const envScene = new THREE.Scene();
  envScene.add(new THREE.Mesh(new THREE.SphereGeometry(100, 32, 16), skyMat.clone()));
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(envScene, 0.02).texture;
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
  return {
    renderer, scene, sun, pipeline,
    followSun(t) {
      // work in light space so the snap is along shadow-map axes
      const m = sun.shadow.camera.matrixWorldInverse;
      sun.position.copy(t).addScaledVector(SUN_DIR, 110);
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
