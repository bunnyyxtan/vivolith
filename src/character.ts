// Skinned, animated humanoids (Mixamo characters converted to GLB by blender/convert_mixamo.py).
import * as THREE from "three";
import { loadGLB } from "./assets";

export interface AnimatedCharacter {
  readonly root: THREE.Group;
  /** Drive locomotion blending from horizontal speed (m/s). */
  setSpeed(speed: number, walkSpeed: number, runSpeed: number): void;
  /** Play a named one-shot or looping clip on top of locomotion (e.g. "Talking"). */
  setAction(name: string | null, once?: boolean): void;
  update(dt: number): void;
  /** Skeleton bone by name suffix (e.g. "LeftUpLeg"), or undefined. */
  bone(name: string): THREE.Object3D | undefined;
  /** Runs right after the mixer each update: procedural pose overrides (sitting, carrying). */
  post: (() => void) | null;
  /** Extra root-height trim in metres (e.g. sitting lowers the whole body). */
  lift: number;
}

const FADE = 0.25;

function findClip(clips: THREE.AnimationClip[], pattern: RegExp): THREE.AnimationClip | undefined {
  return clips.find((c) => pattern.test(c.name));
}

/** Loads a character GLB and scales it so its standing height equals `height` metres. */
/** `clipSource`: another Mixamo-rig GLB whose clips (rotation tracks only) replace this model's own,
 *  for exports whose baked clips are static. */
export async function loadCharacter(url: string, height: number, clipSource?: string | string[]): Promise<AnimatedCharacter> {
  const gltf = await loadGLB(url);
  if (clipSource) {
    // retarget by bone suffix: rigs differ only in the "mixamorig<N>" prefix
    const bySuffix = new Map<string, string>();
    gltf.scene.traverse((o) => bySuffix.set(o.name.replace(/^mixamorig\d*/, ""), o.name));
    const seen = new Set<string>();
    const merged: THREE.AnimationClip[] = [];
    for (const url of Array.isArray(clipSource) ? clipSource : [clipSource]) {
      for (const c of (await loadGLB(url)).animations) {
        if (seen.has(c.name)) continue; // first source wins per clip name
        seen.add(c.name);
        merged.push(new THREE.AnimationClip(c.name, c.duration,
          c.tracks.flatMap((t) => {
            const target = t.name.endsWith(".quaternion") ? bySuffix.get(t.name.split(".")[0].replace(/^mixamorig\d*/, "")) : undefined;
            if (!target) return [];
            const tr = t.clone();
            tr.name = `${target}.quaternion`;
            return [tr];
          })));
      }
    }
    gltf.animations = merged;
  }
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
  const baseY = -bounds.min.y * model.scale.y;
  model.position.y = baseY;

  const root = new THREE.Group();
  root.add(model);
  const mixer = new THREE.AnimationMixer(model);
  const clips = gltf.animations;
  const idle = findClip(clips, /idle/i);
  const walk = findClip(clips, /walk/i);
  const run = findClip(clips, /run/i);
  if (!idle) throw new Error(`${url}: no Idle clip (found: ${clips.map((c) => c.name).join(", ")})`);

  // Ground contact per clip: lowest foot/toe bone over the clip minus the sole thickness measured in the bind pose,
  // so soles touch the ground whichever clip (Mixamo or Tripo in-place) is playing.
  const feet: THREE.Object3D[] = [];
  const bones = new Map<string, THREE.Object3D>();
  model.traverse((o) => {
    if ((o as THREE.Bone).isBone) {
      bones.set(o.name.replace(/^mixamorig\d*:?/, ""), o);
      if (/(foot|toe)/i.test(o.name)) feet.push(o);
    }
  });
  const tmp = new THREE.Vector3();
  const lowFoot = (): number => {
    model.updateMatrixWorld(true);
    let m = Infinity;
    for (const f of feet) m = Math.min(m, f.getWorldPosition(tmp).y);
    return m;
  };
  const sole = feet.length ? lowFoot() : 0; // bind pose: mesh bottom is at world y = 0
  const clipTrim = (clip: THREE.AnimationClip | undefined, samples: number): number => {
    if (!clip || !feet.length) return 0;
    const a = mixer.clipAction(clip).play();
    let low = Infinity;
    for (let i = 0; i < samples; i++) {
      mixer.setTime((clip.duration * i) / samples);
      low = Math.min(low, lowFoot());
    }
    a.stop();
    return -(low - sole);
  };
  const idle0 = clipTrim(idle, 4), walk0 = clipTrim(walk, 12), run0 = clipTrim(run, 12);
  const trimOf = (w: number, r: number): number => {
    const loco = idle0 + (walk0 - idle0) * w;
    return loco + (run0 - walk0) * r * w;
  };
  const idleA = mixer.clipAction(idle).play();
  const walkA = walk ? mixer.clipAction(walk).play() : null;
  const runA = run ? mixer.clipAction(run).play() : null;
  walkA?.setEffectiveWeight(0);
  runA?.setEffectiveWeight(0);
  let overlay: THREE.AnimationAction | null = null;
  let last = { speed: 0, walk: 1, run: 2 };
  let trim = idle0;
  const api: { lift: number } = { lift: 0 };

  const setSpeed = (speed: number, walkSpeed: number, runSpeed: number): void => {
    last = { speed, walk: walkSpeed, run: runSpeed };
      // idle -> walk over [0, walkSpeed], walk -> run over [walkSpeed, runSpeed]
      const w = THREE.MathUtils.clamp(speed / walkSpeed, 0, 1);
      const r = runA ? THREE.MathUtils.clamp((speed - walkSpeed) / (runSpeed - walkSpeed), 0, 1) : 0;
      const locoWeight = overlay ? 0 : 1;
      trim = overlay ? idle0 : trimOf(w, r);
      idleA.setEffectiveWeight((1 - w) * locoWeight);
      walkA?.setEffectiveWeight(w * (1 - r) * locoWeight);
      runA?.setEffectiveWeight(w * r * locoWeight);
      // Match stride to ground speed so feet don't slide.
      if (walkA) walkA.timeScale = THREE.MathUtils.clamp(speed / walkSpeed, 0.6, 1.4);
      if (runA) runA.timeScale = THREE.MathUtils.clamp(speed / runSpeed, 0.7, 1.2);
  };

  const character: AnimatedCharacter = {
    root,
    post: null,
    get lift() { return api.lift; },
    set lift(v: number) { api.lift = v; },
    bone: (name) => bones.get(name),
    setSpeed,
    setAction(name, once = false) {
      const clip = name ? findClip(clips, new RegExp(name, "i")) : undefined;
      const next = clip ? mixer.clipAction(clip) : null;
      if (next === overlay) return;
      const fade = once ? 0.1 : FADE;
      overlay?.fadeOut(fade);
      if (next) {
        next.setLoop(once ? THREE.LoopOnce : THREE.LoopRepeat, Infinity);
        next.clampWhenFinished = once;
        next.reset().setEffectiveWeight(1).fadeIn(fade).play();
      }
      overlay = next;
      setSpeed(last.speed, last.walk, last.run);
    },
    update(dt) {
      mixer.update(dt);
      model.position.y = baseY + trim - api.lift;
      character.post?.();
    },
  };
  return character;
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
