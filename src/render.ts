// Rendering pipeline: HDR environment, MSAA render target, ground-truth AO, subtle bloom, tone mapping.
// `?quality=low` skips AO and bloom for weak GPUs.
import * as THREE from "three";
import { HDRLoader } from "three/addons/loaders/HDRLoader.js";
import { Sky } from "three/addons/objects/Sky.js";
import { createClouds } from "./clouds";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { GTAOPass } from "three/addons/postprocessing/GTAOPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";

export interface Pipeline {
  render(): void;
  resize(w: number, h: number): void;
}

export const QUALITY_LOW = new URLSearchParams(location.search).get("quality") === "low";

export function createRenderer(canvas: HTMLCanvasElement): THREE.WebGLRenderer {
  // MSAA happens in the composer's render target, so the default framebuffer needs none.
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, QUALITY_LOW ? 1 : 1.5));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.75;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  return renderer;
}

/**
 * Image-based lighting from an equirect HDR. The visible sky is a procedural Sky matched to the sun,
 * because the HDRI's photographed buildings would clash with the district on the horizon.
 */
export async function loadEnvironment(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  url: string,
  rotationY: number,
  sunDir: THREE.Vector3,
): Promise<void> {
  const hdr = await new HDRLoader().loadAsync(url);
  hdr.mapping = THREE.EquirectangularReflectionMapping;
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromEquirectangular(hdr).texture;
  pmrem.dispose();
  hdr.dispose();
  scene.environmentRotation.set(0, rotationY, 0);

  const sky = new Sky();
  sky.scale.setScalar(4000);
  const u = sky.material.uniforms;
  u.turbidity.value = 8;
  u.rayleigh.value = 2.6;
  u.mieCoefficient.value = 0.007;
  u.mieDirectionalG.value = 0.86;
  u.sunPosition.value.copy(sunDir);
  scene.background = null;
  scene.add(sky);
  createClouds(scene, sunDir);
}

/**
 * Portrait studio: renders a close-up of a conversation partner once into an offscreen target and
 * returns it as a canvas for the dialogue stamp. Waits briefly so the NPC has turned to face the player.
 */
export function createPortraitStudio(renderer: THREE.WebGLRenderer, scene: THREE.Scene) {
  const SIZE = 384;
  const rt = new THREE.WebGLRenderTarget(SIZE, SIZE);
  rt.texture.colorSpace = THREE.SRGBColorSpace;
  const cam = new THREE.PerspectiveCamera(24, 1, 0.05, 80);
  const pixels = new Uint8Array(SIZE * SIZE * 4);
  return (subject: THREE.Vector3, toward: THREE.Vector3, delayMs = 650): Promise<HTMLCanvasElement | null> =>
    new Promise((resolve) => {
      setTimeout(() => {
        try {
          const dir = toward.clone().sub(subject).setY(0);
          if (dir.lengthSq() < 1e-6) dir.set(0, 0, 1);
          dir.normalize();
          cam.position.copy(subject).addScaledVector(dir, 1.3);
          cam.position.y += 0.06;
          cam.lookAt(subject.x, subject.y - 0.06, subject.z);
          const prev = renderer.getRenderTarget();
          renderer.setRenderTarget(rt);
          renderer.render(scene, cam);
          renderer.setRenderTarget(prev);
          renderer.readRenderTargetPixels(rt, 0, 0, SIZE, SIZE, pixels);
          const canvas = document.createElement("canvas");
          canvas.width = canvas.height = SIZE;
          const g = canvas.getContext("2d")!;
          const img = g.createImageData(SIZE, SIZE);
          for (let y = 0; y < SIZE; y++) {
            // WebGL rows are bottom-up
            img.data.set(pixels.subarray((SIZE - 1 - y) * SIZE * 4, (SIZE - y) * SIZE * 4), y * SIZE * 4);
          }
          g.putImageData(img, 0, 0);
          resolve(canvas);
        } catch {
          resolve(null);
        }
      }, delayMs);
    });
}

export type PortraitStudio = ReturnType<typeof createPortraitStudio>;

export function createPipeline(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera): Pipeline {
  const size = renderer.getSize(new THREE.Vector2());
  const target = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: QUALITY_LOW ? 0 : 4 });
  const composer = new EffectComposer(renderer, target);
  composer.setPixelRatio(renderer.getPixelRatio());
  composer.addPass(new RenderPass(scene, camera));

  if (!QUALITY_LOW) {
    const ao = new GTAOPass(scene, camera, size.x, size.y);
    ao.updateGtaoMaterial({ radius: 0.6, distanceExponent: 1.5, thickness: 1.2, scale: 1.0, samples: 12 });
    ao.blendIntensity = 0.85;
    composer.addPass(ao);
    composer.addPass(new UnrealBloomPass(size.clone(), 0.18, 0.5, 0.95));
  }
  composer.addPass(new OutputPass());

  return {
    render: () => composer.render(),
    resize: (w, h) => {
      renderer.setSize(w, h);
      composer.setSize(w, h);
    },
  };
}
