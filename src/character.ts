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
  /** Where each foot is this frame (world x, z) and how far it is lifted above the lower foot (m). */
  footprints(): readonly Footprint[];
  /** Runs right after the mixer each update: procedural pose overrides (sitting, carrying). */
  post: (() => void) | null;
  /** Extra root-height trim in metres (e.g. sitting lowers the whole body). */
  lift: number;
  /** Keep the lowest sole on the ground every frame (blended clips leave the per-clip trims a few cm off).
   *  One-shot overlays such as a jump are excluded, so the feet can still leave the ground. */
  autoGround: boolean;
  /** Raise the ground contact by dy metres: the depth of the rendered sole below the root, measured on the GPU
   *  (src/v2/soles.ts) for skins whose CPU skinning cannot be trusted. */
  raiseSole(dy: number): void;
}

export interface Footprint { x: number; z: number; lift: number }

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
  let baseY = -bounds.min.y * model.scale.y;
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
  // The sole is skinned geometry, not a bone: chunky shoes sit well below the toe bones and the heel drops when the
  // foot rolls, so contact is measured on the vertices the foot and toe bones carry (strided, at most ~240 per mesh).
  const soles: { mesh: THREE.SkinnedMesh; idx: number[] }[] = [];
  model.traverse((o) => {
    const mesh = o as THREE.SkinnedMesh;
    if (!mesh.isSkinnedMesh) return;
    const si = mesh.geometry.getAttribute("skinIndex"), sw = mesh.geometry.getAttribute("skinWeight");
    if (!si || !sw) return;
    const footBone = mesh.skeleton.bones.map((b) => /(foot|toe)/i.test(b.name));
    const idx: number[] = [];
    for (let i = 0; i < si.count; i++) {
      let best = 0, w = -1;
      for (let k = 0; k < 4; k++) if (sw.getComponent(i, k) > w) { w = sw.getComponent(i, k); best = si.getComponent(i, k); }
      if (footBone[best]) idx.push(i);
    }
    const stride = Math.max(1, Math.ceil(idx.length / 240));
    if (idx.length) soles.push({ mesh, idx: idx.filter((_, k) => k % stride === 0) });
  });
  const tmp = new THREE.Vector3();
  const sides: [THREE.Object3D[], Footprint][] = [/left/i, /right/i]
    .map((re): [THREE.Object3D[], Footprint] => [feet.filter((f) => re.test(f.name)), { x: 0, z: 0, lift: 0 }])
    .filter(([side]) => side.length > 0);
  const prints = sides.map(([, fp]) => fp);
  const boneLow = (): number => {
    let m = Infinity;
    for (const f of feet) m = Math.min(m, f.getWorldPosition(tmp).y);
    return m;
  };
  const skinLow = (): number => {
    let m = Infinity;
    for (const { mesh, idx } of soles) {
      mesh.skeleton.update();
      for (const i of idx) m = Math.min(m, mesh.applyBoneTransform(i, mesh.getVertexPosition(i, tmp)).applyMatrix4(mesh.matrixWorld).y);
    }
    return m;
  };
  // CPU skinning only counts when it agrees with the bones: some converted skins (the cast folk) do not round-trip on
  // the CPU and land metres away, so those keep the bone measure. Checked on every sampled clip frame below.
  const skinOk = (): boolean => Math.abs(skinLow() - boneLow()) < height * 0.25;
  const lowFoot = (): number => {
    model.updateMatrixWorld(true);
    return soles.length ? skinLow() : boneLow();
  };
  // bind pose first (mesh bottom at world y = 0), before any clip moves the bones
  model.updateMatrixWorld(true);
  const bindBone = feet.length ? boneLow() : 0;
  const bindSkin = soles.length ? skinLow() : 0;
  const checkSkin = (clip: THREE.AnimationClip | undefined): boolean => {
    if (!clip) return true;
    const a = mixer.clipAction(clip).play();
    let ok = true;
    for (let i = 0; i < 6 && ok; i++) { mixer.setTime((clip.duration * i) / 6); model.updateMatrixWorld(true); ok = skinOk(); }
    a.stop();
    return ok;
  };
  if (soles.length && !(Math.abs(bindSkin - bindBone) < height * 0.25 && [idle, walk, run].every(checkSkin))) soles.length = 0;
  let sole = soles.length ? bindSkin : bindBone;
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
  let ground = idle0; // smoothed auto-ground offset
  const rootPos = new THREE.Vector3();

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
    autoGround: false,
    raiseSole(dy) { sole += dy; baseY += dy; },
    get lift() { return api.lift; },
    set lift(v: number) { api.lift = v; },
    bone: (name) => bones.get(name),
    footprints() {
      // per side, the lowest foot/toe bone: the swing foot reads as lifted, the planted one as 0
      let low = Infinity;
      for (const [side, fp] of sides) {
        let y = Infinity, x = 0, z = 0;
        for (const b of side) { b.getWorldPosition(tmp); if (tmp.y < y) { y = tmp.y; x = tmp.x; z = tmp.z; } }
        fp.x = x; fp.z = z; fp.lift = y;
        low = Math.min(low, y);
      }
      for (const [, fp] of sides) fp.lift -= low;
      return prints;
    },
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
      if (character.autoGround && !overlay && feet.length) {
        // Measure where the soles really are this frame and ease the body so they rest on the ground. While seated
        // (lift > 0) the standing correction is held: the sit drop applies on top of it and the feet may lift.
        model.position.y = baseY + ground - api.lift;
        if (api.lift < 0.01) {
          root.updateMatrixWorld(true);
          const err = sole - (lowFoot() - root.getWorldPosition(rootPos).y);
          ground += err * Math.min(1, dt * 12);
          model.position.y = baseY + ground;
        }
      } else {
        ground = trim;
        model.position.y = baseY + trim - api.lift;
      }
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
