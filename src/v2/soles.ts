// Ground contact measured on what the GPU draws. Several converted cast skins do not round-trip through CPU
// skinning (their vertices land metres away on the CPU while the GPU draws them correctly), and their skinned
// bounds are wrong with them, so the standing reference from the bones left soles ~13 cm under the pavement.
// Once at load, each character is posed in idle, rendered alone as a white silhouette in an orthographic side
// view, and the lowest lit pixel row is the real sole: the character's ground reference is raised by that depth.
import * as THREE from "three";
import type { AnimatedCharacter } from "../character";

const PX = 512; // 1 m of height over 512 px: 2 mm per pixel
const BELOW = 0.5; // the view spans 0.5 m below the root to 0.5 m above it
const SETTLE = 24; // idle updates so the auto-ground has converged before measuring

/** Depth (m, positive = below the root) of the lowest drawn pixel of `c` standing in idle, or null if nothing drew. */
function soleDepth(renderer: THREE.WebGLRenderer, c: AnimatedCharacter, target: THREE.WebGLRenderTarget): number | null {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0);
  scene.overrideMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const parent = c.root.parent;
  const saved = c.root.position.clone();
  const hidden: THREE.Object3D[] = [];
  c.root.traverse((o) => { if (/outline/i.test(o.name) && o.visible) { o.visible = false; hidden.push(o); } }); // ink hull is drawn wider
  scene.add(c.root);
  c.root.position.set(0, 0, 0);
  c.lift = 0;
  c.setAction(null);
  c.setSpeed(0, 1, 2);
  for (let i = 0; i < SETTLE; i++) c.update(0.1);
  scene.updateMatrixWorld(true);
  const cam = new THREE.OrthographicCamera(-0.6, 0.6, 1 - BELOW, -BELOW, 0.1, 20);
  cam.position.set(0, 0, 10);
  cam.lookAt(0, 0, 0);
  renderer.setRenderTarget(target);
  renderer.render(scene, cam);
  const px = new Uint8Array(PX * PX * 4);
  renderer.readRenderTargetPixels(target, 0, 0, PX, PX, px);
  renderer.setRenderTarget(null);
  for (const o of hidden) o.visible = true;
  parent?.add(c.root);
  c.root.position.copy(saved);
  for (let row = 0; row < PX; row++) {
    for (let col = 0; col < PX; col++) {
      if (px[(row * PX + col) * 4] > 127) return BELOW - ((row + 0.5) / PX) * 1;
    }
  }
  return null;
}

/** Puts every character's drawn sole on its root. Returns the depths found (m) for checking. */
export function calibrateSoles(renderer: THREE.WebGLRenderer, chars: readonly AnimatedCharacter[]): number[] {
  const target = new THREE.WebGLRenderTarget(PX, PX);
  const depths: number[] = [];
  for (const c of chars) {
    const d = soleDepth(renderer, c, target);
    if (d === null) continue;
    depths.push(d);
    if (Math.abs(d) > 0.004) c.raiseSole(d);
  }
  target.dispose();
  return depths;
}
