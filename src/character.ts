// Skinned, animated humanoids (Mixamo characters converted to GLB by blender/convert_mixamo.py).
import * as THREE from "three";
import { loadGLB } from "./assets";

export interface AnimatedCharacter {
  readonly root: THREE.Group;
  /** Drive locomotion blending from horizontal speed (m/s). */
  setSpeed(speed: number, walkSpeed: number, runSpeed: number): void;
  /** Play a named one-shot or looping clip on top of locomotion (e.g. "Talking"). */
  setAction(name: string | null): void;
  update(dt: number): void;
}

const FADE = 0.25;

function findClip(clips: THREE.AnimationClip[], pattern: RegExp): THREE.AnimationClip | undefined {
  return clips.find((c) => pattern.test(c.name));
}

/** Loads a character GLB and scales it so its standing height equals `height` metres. */
export async function loadCharacter(url: string, height: number): Promise<AnimatedCharacter> {
  const gltf = await loadGLB(url);
  const model = gltf.scene;
  model.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      o.castShadow = true;
      o.receiveShadow = true;
      o.frustumCulled = false; // skinned bounds don't follow the animation
    }
  });
  const bounds = new THREE.Box3().setFromObject(model);
  const size = bounds.getSize(new THREE.Vector3());
  model.scale.setScalar(height / Math.max(size.y, 1e-3));
  model.position.y = -bounds.min.y * model.scale.y;

  const root = new THREE.Group();
  root.add(model);
  const mixer = new THREE.AnimationMixer(model);
  const clips = gltf.animations;
  const idle = findClip(clips, /idle/i);
  const walk = findClip(clips, /walk/i);
  const run = findClip(clips, /run/i);
  if (!idle) throw new Error(`${url}: no Idle clip (found: ${clips.map((c) => c.name).join(", ")})`);

  const idleA = mixer.clipAction(idle).play();
  const walkA = walk ? mixer.clipAction(walk).play() : null;
  const runA = run ? mixer.clipAction(run).play() : null;
  walkA?.setEffectiveWeight(0);
  runA?.setEffectiveWeight(0);
  let overlay: THREE.AnimationAction | null = null;
  let last = { speed: 0, walk: 1, run: 2 };

  const setSpeed = (speed: number, walkSpeed: number, runSpeed: number): void => {
    last = { speed, walk: walkSpeed, run: runSpeed };
      // idle -> walk over [0, walkSpeed], walk -> run over [walkSpeed, runSpeed]
      const w = THREE.MathUtils.clamp(speed / walkSpeed, 0, 1);
      const r = runA ? THREE.MathUtils.clamp((speed - walkSpeed) / (runSpeed - walkSpeed), 0, 1) : 0;
      const locoWeight = overlay ? 0 : 1;
      idleA.setEffectiveWeight((1 - w) * locoWeight);
      walkA?.setEffectiveWeight(w * (1 - r) * locoWeight);
      runA?.setEffectiveWeight(w * r * locoWeight);
      // Match stride to ground speed so feet don't slide.
      if (walkA) walkA.timeScale = THREE.MathUtils.clamp(speed / walkSpeed, 0.6, 1.4);
      if (runA) runA.timeScale = THREE.MathUtils.clamp(speed / runSpeed, 0.7, 1.2);
  };

  return {
    root,
    setSpeed,
    setAction(name) {
      const clip = name ? findClip(clips, new RegExp(name, "i")) : undefined;
      const next = clip ? mixer.clipAction(clip) : null;
      if (next === overlay) return;
      overlay?.fadeOut(FADE);
      if (next) next.reset().setEffectiveWeight(1).fadeIn(FADE).play();
      overlay = next;
      setSpeed(last.speed, last.walk, last.run);
    },
    update(dt) {
      mixer.update(dt);
    },
  };
}

/** Visible notice so a missing character model is never silently replaced by a placeholder. */
export function showPlaceholderNotice(message: string): void {
  const el = document.createElement("div");
  el.textContent = message;
  el.style.cssText =
    "position:fixed;top:12px;right:12px;padding:6px 10px;border-radius:6px;font:12px ui-monospace,monospace;" +
    "background:rgba(120,30,20,.75);color:#fff;pointer-events:none;z-index:10";
  document.body.appendChild(el);
}
