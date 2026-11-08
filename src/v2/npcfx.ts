// NPC presentation helpers: speech bubbles (HUD style, above the head) and procedural pose tricks
// (sitting, carrying, stagger lean) applied on top of the clip after the mixer runs.
import * as THREE from "three";
import type { AnimatedCharacter } from "../character";

const CSS = `
.npc-bubble { position:fixed; left:0; top:0; z-index:4; pointer-events:none; font:600 14px "Inter Tight",system-ui,sans-serif;
  color:#eef2f0; background:#10151f; padding:6px 10px; border-bottom:2px solid #00ec97; white-space:nowrap; display:none; }
`;

interface Bubble { el: HTMLDivElement; head: THREE.Vector3 | null; t: number }

export interface Bubbles {
  /** Show `text` above `head` (live vector, top of the head) for `secs`. */
  say(head: THREE.Vector3, text: string, secs?: number): void;
  update(dt: number, camera: THREE.Camera): void;
}

export function createBubbles(pool = 5): Bubbles {
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);
  const bubbles: Bubble[] = Array.from({ length: pool }, () => {
    const el = document.createElement("div");
    el.className = "npc-bubble";
    document.body.appendChild(el);
    return { el, head: null, t: 0 };
  });
  const v = new THREE.Vector3();
  return {
    say(head, text, secs = 1.8) {
      const b = bubbles.find((x) => x.t <= 0 || x.head === head) ?? bubbles.reduce((a, c) => (c.t < a.t ? c : a));
      b.head = head; b.t = secs; b.el.textContent = text;
    },
    update(dt, camera) {
      for (const b of bubbles) {
        if (b.t <= 0 || !b.head) continue;
        b.t -= dt;
        v.copy(b.head).project(camera);
        if (b.t <= 0 || v.z > 1) { b.el.style.display = "none"; b.t = 0; continue; }
        b.el.style.display = "block";
        b.el.style.transform = `translate(${((v.x * 0.5 + 0.5) * innerWidth).toFixed(0)}px,${((-v.y * 0.5 + 0.5) * innerHeight - 6).toFixed(0)}px) translate(-50%,-100%)`;
      }
    },
  };
}

const qp = new THREE.Quaternion(), qb = new THREE.Quaternion(), qd = new THREE.Quaternion(), axis = new THREE.Vector3();

/** Rotate a bone about the character's lateral axis (world space) by `ang` radians: negative swings limbs forward. */
function rot(bone: THREE.Object3D | undefined, yaw: number, ang: number): void {
  if (!bone?.parent || Math.abs(ang) < 1e-3) return;
  axis.set(Math.cos(yaw), 0, -Math.sin(yaw));
  bone.parent.getWorldQuaternion(qp);
  qb.copy(qp).multiply(bone.quaternion);
  qd.setFromAxisAngle(axis, ang);
  qb.premultiply(qd);
  bone.quaternion.copy(qp.invert()).multiply(qb);
}

export interface PoseState { sit: number; carry: number; lean: number; yaw: number; phone: number }

/** Installs the pose post-pass on a character. The caller mutates the returned state each frame. */
export function installPose(c: AnimatedCharacter): PoseState {
  const s: PoseState = { sit: 0, carry: 0, lean: 0, yaw: 0, phone: 0 };
  const b = (n: string): THREE.Object3D | undefined => c.bone(n);
  c.post = () => {
    if (s.sit > 0.01) {
      for (const side of ["Left", "Right"]) {
        rot(b(`${side}UpLeg`), s.yaw, -1.45 * s.sit);
        rot(b(`${side}Leg`), s.yaw, 1.5 * s.sit);
      }
    }
    if (s.carry > 0.01) {
      for (const side of ["Left", "Right"]) {
        rot(b(`${side}Arm`), s.yaw, -0.95 * s.carry);
        rot(b(`${side}ForeArm`), s.yaw, -0.9 * s.carry);
      }
    }
    if (s.lean > 0.01) rot(b("Spine1"), s.yaw, 0.3 * s.lean);
    if (s.phone > 0.01) { // taking a photo: right arm raised in front, forearm bent up to the face
      rot(b("RightArm"), s.yaw, -1.25 * s.phone);
      rot(b("RightForeArm"), s.yaw, -0.9 * s.phone);
    }
  };
  return s;
}
