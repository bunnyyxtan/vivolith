// Skinned, animated humanoids (Tripo Studio characters built by blender/build_studio_character.py).
import * as THREE from "three";
import { loadGLB } from "./assets";

export interface AnimatedCharacter {
  readonly root: THREE.Group;
  /** Drive locomotion blending from horizontal speed (m/s). */
  setSpeed(speed: number, walkSpeed: number, runSpeed: number): void;
  /** Play a named one-shot or looping clip on top of locomotion (e.g. "Talking"). */
  setAction(name: string | null, once?: boolean): void;
  /** Whether the model carries a clip whose name matches (case-insensitive). */
  has(name: string): boolean;
  /** Length (s) of the clip whose name matches, 0 when the model has none. */
  duration(name: string): number;
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
  /** Far away (a few pixels tall): auto-ground re-measures the soles every 4th update instead of every one. */
  coarse: boolean;
  /** Raise the ground contact by dy metres: the depth of the rendered sole below the root, measured on the GPU
   *  (src/v2/soles.ts) for skins whose CPU skinning cannot be trusted. */
  raiseSole(dy: number): void;
  /** Natural ground speeds (m/s) of the walk and run clips, measured at load (null without both clips). */
  readonly gait: { walk: number; run: number } | null;
}

export interface Footprint { x: number; z: number; lift: number }

const FADE = 0.25;
const WALK_STRETCH = 1.3; // fastest walk, x the walk clip's natural speed
const RUN_SLOW = 0.75; // slowest pure run, x the run clip's natural speed

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
  // One stance point per foot, the ball (ToeBase): taking the lowest of ankle and toe jumped from heel to ball mid-
  // stance, a fake forward slide that overestimated the run's speed and left a jog's planted feet sliding ~20%.
  const footBone = (side: RegExp): THREE.Object3D[] => {
    const all = feet.filter((f) => side.test(f.name));
    const ball = all.filter((f) => /toebase/i.test(f.name));
    return ball.length ? ball : all;
  };
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
  // Locomotion fades out while an overlay clip fades in (and back): dropping it at once left the blend's total weight
  // under 1 for the fade, which three.js fills with the rest pose (a visible snap toward a T-pose).
  let locoW = 1, locoFade = FADE;
  let last = { speed: 0, walk: 1, run: 2 };
  let trim = idle0;
  const api: { lift: number } = { lift: 0 };
  let ground = idle0; // smoothed auto-ground offset
  let groundTick = 0, groundDt = 0; // coarse mode: updates since the last sole measure, and their time
  const rootPos = new THREE.Vector3();
  let phase = 0, phaseRate = 0; // shared gait phase (0..1 of a walk clip) and its rate, cycles/s

  const setSpeed = (speed: number, walkSpeed: number, runSpeed: number): void => {
    last = { speed, walk: walkSpeed, run: runSpeed };
    if (walkA && runA && walkGait && runGait) {
      // measured gaits: idle -> walk up to 80% of the walk's own speed; walk -> run in a narrow band (a brisk walk up
      // to 1.3x the walk, a slow run from 0.75x the run). Spanning the whole gap left Kavi's 3.2 m/s jog a 60/40
      // walk/run pose mix: bent knees and a shuffling stride, neither gait.
      const w = THREE.MathUtils.clamp(speed / (walkGait.natural * 0.8), 0, 1);
      const r0 = walkGait.natural * WALK_STRETCH, r1 = Math.max(r0 + 0.1, runGait.natural * RUN_SLOW);
      const r = THREE.MathUtils.smoothstep(speed, r0, r1);
      const locoWeight = locoW;
      trim = overlay ? idle0 : trimOf(w, r);
      idleA.setEffectiveWeight((1 - w) * locoWeight);
      walkA.setEffectiveWeight(w * (1 - r) * locoWeight);
      runA.setEffectiveWeight(w * r * locoWeight);
      // stride matched to ground speed (no sliding); both clips advance on one phase. The blended feet cover the
      // blended distance per cycle, so the rate is speed over that distance (summing the two rates ran ~8% fast).
      // Below 80% of the walk speed the idle blend shrinks every stride to w of its length (feet sit between the
      // idle stance and the walk pose), so the cadence is speed / (w * cycle): a steady step rate with shorter
      // steps. The old floor of 35% of the walk speed stepped too slowly and slid the feet at every slow turn.
      const cycle = (1 - r) * walkGait.natural * walk!.duration + r * runGait.natural * run!.duration;
      phaseRate = speed / (cycle * Math.max(w, 1e-3));
      walkA.timeScale = 0; runA.timeScale = 0; // driven by phase in update()
      return;
    }
      // idle -> walk over [0, walkSpeed], walk -> run over [walkSpeed, runSpeed]
      const w = THREE.MathUtils.clamp(speed / walkSpeed, 0, 1);
      const r = runA ? THREE.MathUtils.clamp((speed - walkSpeed) / (runSpeed - walkSpeed), 0, 1) : 0;
      const locoWeight = locoW;
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
    coarse: false,
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
    has: (name) => findClip(clips, new RegExp(name, "i")) !== undefined,
    duration: (name) => findClip(clips, new RegExp(name, "i"))?.duration ?? 0,
    setAction(name, once = false) {
      const clip = name ? findClip(clips, new RegExp(name, "i")) : undefined;
      const next = clip ? mixer.clipAction(clip) : null;
      if (next === overlay) return;
      const fade = once ? 0.1 : FADE;
      overlay?.fadeOut(fade);
      locoFade = fade;
      if (next) {
        next.setLoop(once ? THREE.LoopOnce : THREE.LoopRepeat, Infinity);
        next.clampWhenFinished = once;
        next.reset().setEffectiveWeight(1).fadeIn(fade).play();
      }
      overlay = next;
      setSpeed(last.speed, last.walk, last.run);
    },
    update(dt) {
      const locoTo = overlay ? 0 : 1;
      if (locoW !== locoTo) {
        locoW = locoTo > locoW ? Math.min(1, locoW + dt / locoFade) : Math.max(0, locoW - dt / locoFade);
        setSpeed(last.speed, last.walk, last.run);
      }
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
        groundDt += dt;
        if (api.lift < 0.01 && (!character.coarse || (groundTick++ & 3) === 0)) {
          root.updateMatrixWorld(true);
          const err = sole - (lowFoot() - root.getWorldPosition(rootPos).y);
          ground += err * Math.min(1, Math.min(groundDt, 0.07) * 12); // at most 4 frames of catch-up (no pop after sitting)
          groundDt = 0;
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
