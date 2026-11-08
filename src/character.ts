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
  /** Natural ground speeds (m/s) of the walk and run clips, measured at load (null without both clips). */
  readonly gait: { walk: number; run: number } | null;
}

export interface Footprint { x: number; z: number; lift: number }

const FADE = 0.25;

function findClip(clips: THREE.AnimationClip[], pattern: RegExp): THREE.AnimationClip | undefined {
  return clips.find((c) => pattern.test(c.name));
}

const suffix = (name: string): string => name.replace(/^mixamorig\d*:?/, "");
const RETARGET_FPS = 30;
const LIMB = /^(Left|Right)(Shoulder|Arm|ForeArm|Hand|UpLeg|Leg|Foot)/;
/** Retargeted clips by "model|source|clip": instances of one model share bone names, so the 24 townsfolk bake 6 sets. */
const retargeted = new Map<string, THREE.AnimationClip>();
/** Outward swing (radians, about the body's forward axis) added to retargeted limbs: the Mixamo walk and run set
 *  each foot on the centre line, which on Kavi's wider hips crossed the steps like a catwalk. */
const LIMB_SPREAD: Record<string, number> = { UpLeg: 0.05 };

/** World-space correction for a bone inside a spread limb: each spread ancestor (or itself) swings it away from the body. */
function limbSpread(b: THREE.Object3D): THREE.Quaternion {
  const q = new THREE.Quaternion();
  for (let o: THREE.Object3D | null = b; o; o = o.parent) {
    const m = /^(Left|Right)(\w+)$/.exec(suffix(o.name));
    const angle = m ? LIMB_SPREAD[m[2]] : undefined;
    if (m && angle) q.premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), (m[1] === "Left" ? 1 : -1) * angle));
  }
  return q;
}

/**
 * Bakes `clip` (animating `src`) onto the bones of `dst`, whose rest orientations differ (a Tripo rig renamed to
 * Mixamo names: bone rolls differ by up to 180 degrees, so copying local rotations lays the body on its back).
 * Each target bone takes the source bone's world rotation away from its rest, applied after first turning the
 * target's rest bone direction onto the source's. Rotations only; the feet are grounded at runtime.
 */
function retargetClip(clip: THREE.AnimationClip, src: THREE.Object3D, dst: THREE.Object3D): THREE.AnimationClip {
  const srcBones = new Map<string, THREE.Object3D>();
  src.traverse((o) => { if ((o as THREE.Bone).isBone) srcBones.set(suffix(o.name), o); });
  const dstBones: THREE.Object3D[] = [];
  dst.traverse((o) => { if ((o as THREE.Bone).isBone) dstBones.push(o); }); // parents before children
  // from matrixWorld (updated before every read): getWorldQuaternion re-walks the parent chain per bone per frame
  const _p = new THREE.Vector3(), _s = new THREE.Vector3();
  const worldQ = (o: THREE.Object3D): THREE.Quaternion => { const q = new THREE.Quaternion(); o.matrixWorld.decompose(_p, q, _s); return q; };
  const worldP = (o: THREE.Object3D): THREE.Vector3 => o.getWorldPosition(new THREE.Vector3());
  src.updateMatrixWorld(true);
  dst.updateMatrixWorld(true);
  // per target bone: its source, rest world rotations, and the rest-direction alignment. A bone aims at its only
  // child (a hand at its middle finger); others (hips, chest, finger tips) keep their parent's alignment, so an
  // A-pose hand follows its T-pose-aligned forearm instead of bending ~65 degrees at the wrist.
  const aligned = new Map<THREE.Object3D, THREE.Quaternion>();
  const rig = dstBones.map((b) => {
    const s = srcBones.get(suffix(b.name));
    const kids = b.children.filter((c) => (c as THREE.Bone).isBone);
    const aim = kids.length === 1 ? kids[0] : kids.find((c) => /HandMiddle1$/.test(c.name));
    const sc = aim ? srcBones.get(suffix(aim.name)) : undefined;
    // Only limbs align (A-pose vs T-pose). The spine, neck and head keep the target's own posture: forcing a
    // forward-carried neck vertical tipped every townsperson's face up ~13 degrees.
    const align = s && aim && sc && LIMB.test(suffix(b.name))
      ?new THREE.Quaternion().setFromUnitVectors(worldP(aim).sub(worldP(b)).normalize(), worldP(sc).sub(worldP(s)).normalize())
      : (aligned.get(b.parent!) ?? new THREE.Quaternion()).clone();
    aligned.set(b, align);
    return { b, s, fix: limbSpread(b), srcRestInv: s ? worldQ(s).invert() : null, dstRest: align.clone().multiply(worldQ(b)), restLocal: b.quaternion.clone() };
  });
  const parentRest = new Map<THREE.Object3D, THREE.Quaternion>();
  for (const { b } of rig) if (b.parent && !(b.parent as THREE.Bone).isBone) parentRest.set(b.parent, worldQ(b.parent));

  const mixer = new THREE.AnimationMixer(src);
  const action = mixer.clipAction(clip).play();
  const n = Math.max(2, Math.ceil(clip.duration * RETARGET_FPS) + 1);
  const times = new Float32Array(n);
  const values = rig.map(() => new Float32Array(n * 4));
  const world = new Map<THREE.Object3D, THREE.Quaternion>();
  const local = new THREE.Quaternion();
  const prev = rig.map(() => new THREE.Quaternion());
  for (let i = 0; i < n; i++) {
    const t = (clip.duration * i) / (n - 1);
    times[i] = t;
    mixer.setTime(t);
    src.updateMatrixWorld(true);
    world.clear();
    rig.forEach((r, k) => {
      const parentW = world.get(r.b.parent!) ?? parentRest.get(r.b.parent!) ?? new THREE.Quaternion();
      const w = r.s ? worldQ(r.s).multiply(r.srcRestInv!).multiply(r.dstRest).premultiply(r.fix) : parentW.clone().multiply(r.restLocal);
      world.set(r.b, w);
      local.copy(parentW).invert().multiply(w);
      if (i > 0 && local.dot(prev[k]) < 0) local.set(-local.x, -local.y, -local.z, -local.w); // no flips between keys
      prev[k].copy(local);
      local.toArray(values[k], i * 4);
    });
  }
  action.stop();
  mixer.uncacheRoot(src);
  const tracks = rig.flatMap((r, k) => (r.s ? [new THREE.QuaternionKeyframeTrack(`${r.b.name}.quaternion`, times, values[k])] : []));
  return new THREE.AnimationClip(clip.name, clip.duration, tracks);
}

/** Loads a character GLB and scales it so its standing height equals `height` metres. */
/** `clipSource`: Mixamo-rig GLBs whose clips (rotation tracks only) replace this model's own, for exports whose
 *  baked clips are static or poor. "url#Walk,Run" takes only those clips from that file; the first source wins.
 *  Picked clips from another file are retargeted onto this rig (retargetClip); the rest are copied by bone name. */
export async function loadCharacter(url: string, height: number, clipSource?: string | string[]): Promise<AnimatedCharacter> {
  const gltf = await loadGLB(url);
  if (clipSource) {
    // copy by bone suffix: rigs differ only in the "mixamorig<N>" prefix
    const bySuffix = new Map<string, string>();
    gltf.scene.traverse((o) => bySuffix.set(o.name.replace(/^mixamorig\d*/, ""), o.name));
    const seen = new Set<string>();
    const merged: THREE.AnimationClip[] = [];
    for (const src of Array.isArray(clipSource) ? clipSource : [clipSource]) {
      const [srcUrl, only] = src.split("#");
      const pick = only ? new Set(only.split(",")) : null;
      const srcGltf = srcUrl === url ? gltf : await loadGLB(srcUrl);
      for (const c of srcGltf.animations) {
        if (seen.has(c.name) || (pick && !pick.has(c.name))) continue; // first source wins per clip name
        seen.add(c.name);
        if (srcGltf !== gltf) { // rest poses differ between rigs (3-23 degrees per bone): copied local rotations lean the body back
          const k = `${url}|${srcUrl}|${c.name}`;
          let clip = retargeted.get(k);
          if (!clip) { clip = retargetClip(c, srcGltf.scene, gltf.scene); retargeted.set(k, clip); }
          merged.push(clip);
          continue;
        }
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
  // Gait of each locomotion clip, measured on the scaled model: the ground speed its planted foot carries
  // (playback rate = speed / natural, so feet do not slide) and the phase of the left foot's touchdown (walk and run
  // play on one shared gait phase, aligned there, so a blend never crosses the legs).
  const footBone = (side: RegExp): THREE.Object3D[] => feet.filter((f) => side.test(f.name));
  const leftF = footBone(/left/i), rightF = footBone(/right/i);
  const gaitOf = (clip: THREE.AnimationClip | undefined): { natural: number; touchdown: number } | null => {
    if (!clip || !leftF.length || !rightF.length) return null;
    const a = mixer.clipAction(clip).play();
    const N = 96, L: THREE.Vector3[] = [], R: THREE.Vector3[] = [];
    const low = (bs: THREE.Object3D[]): THREE.Vector3 => {
      const out = new THREE.Vector3(0, Infinity, 0);
      for (const b of bs) { b.getWorldPosition(tmp); if (tmp.y < out.y) out.copy(tmp); }
      return out;
    };
    for (let i = 0; i <= N; i++) { mixer.setTime((clip.duration * i) / N); model.updateMatrixWorld(true); L.push(low(leftF)); R.push(low(rightF)); }
    a.stop();
    const lMin = Math.min(...L.map((p) => p.y)), rMin = Math.min(...R.map((p) => p.y));
    const dt = clip.duration / N, speeds: number[] = [];
    for (let i = 0; i < N; i++) { // a foot within 2 cm of its lowest is planted: it moves back at the ground speed
      if (L[i].y < lMin + 0.02 && L[i + 1].y < lMin + 0.02) speeds.push(Math.hypot(L[i + 1].x - L[i].x, L[i + 1].z - L[i].z) / dt);
      if (R[i].y < rMin + 0.02 && R[i + 1].y < rMin + 0.02) speeds.push(Math.hypot(R[i + 1].x - R[i].x, R[i + 1].z - R[i].z) / dt);
    }
    speeds.sort((x, y) => x - y);
    let td = 0;
    for (let i = 1; i <= N; i++) if (L[i].y < lMin + 0.02 && L[i - 1].y >= lMin + 0.02) { td = i / N; break; }
    return speeds.length ? { natural: Math.max(0.3, speeds[speeds.length >> 1]), touchdown: td } : null;
  };
  const walkGait = gaitOf(walk), runGait = gaitOf(run);
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
  let phase = 0, phaseRate = 0; // shared gait phase (0..1 of a walk clip) and its rate, cycles/s

  const setSpeed = (speed: number, walkSpeed: number, runSpeed: number): void => {
    last = { speed, walk: walkSpeed, run: runSpeed };
    if (walkA && runA && walkGait && runGait) {
      // measured gaits: idle -> walk up to 80% of the walk's own speed, walk -> run between the two natural speeds
      const w = THREE.MathUtils.clamp(speed / (walkGait.natural * 0.8), 0, 1);
      const r = THREE.MathUtils.clamp((speed - walkGait.natural) / Math.max(0.1, runGait.natural - walkGait.natural), 0, 1);
      const locoWeight = overlay ? 0 : 1;
      trim = overlay ? idle0 : trimOf(w, r);
      idleA.setEffectiveWeight((1 - w) * locoWeight);
      walkA.setEffectiveWeight(w * (1 - r) * locoWeight);
      runA.setEffectiveWeight(w * r * locoWeight);
      // stride matched to ground speed (no sliding); both clips advance on one phase
      const ws = THREE.MathUtils.clamp(speed / walkGait.natural, 0.35, 2.2), rs = THREE.MathUtils.clamp(speed / runGait.natural, 0.35, 2.2);
      phaseRate = (1 - r) * (ws / walk!.duration) + r * (rs / run!.duration);
      walkA.timeScale = 0; runA.timeScale = 0; // driven by phase in update()
      return;
    }
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
    gait: walkGait && runGait ? { walk: walkGait.natural, run: runGait.natural } : null,
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
      if (walkA && runA && walkGait && runGait) {
        phase = (phase + phaseRate * dt) % 1;
        walkA.time = ((phase + walkGait.touchdown) % 1) * walk!.duration;
        runA.time = ((phase + runGait.touchdown) % 1) * run!.duration;
      }
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
