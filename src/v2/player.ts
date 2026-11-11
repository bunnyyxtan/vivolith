// Kavi: third-person locomotion with eased velocity, smooth turning and speed-matched animation.
import * as THREE from "three";
import { stepBody, type Body, type Box } from "../physics/collision";
import { loadCharacter, type AnimatedCharacter } from "../character";
import { applyToon } from "./toon";
import { standHeight } from "./floor";
import type { Input } from "./input";

// Kavi's clips carry 1.62 m/s (walk) and 4.2 m/s (run) at their own cadence (measured by loadCharacter's gait).
// The old 3.2 m/s jog sat between them: a 60/40 walk/run pose mix that shuffled like an old man.
export const WALK_SPEED = 4.0; // a jog: the run clip at 0.95x its own speed, pure run pose
export const RUN_SPEED = 6.3; // sprint: the run clip at 1.5x, ~4.3 steps/s (real sprint cadence), leaning in
const SPRINT_LEAN = 0.09; // rad of forward lean at full sprint, pivoting at the feet
const ACCEL = 18; // m/s^2 toward target velocity: ~0.18 s to a jog, so the first steps read as steps
const DECEL = 22;
const AIR_CONTROL = 0.45;
const TURN_RATE = 14; // 1/s exponential turn
const JUMP_SPEED = 6.2;
const MAX_STEP = 1 / 60;
const HEIGHT = 1.7;

export interface Player {
  readonly root: THREE.Group;
  readonly body: Body;
  heading: number;
  /** horizontal ground speed, m/s */
  readonly speed: number;
  /** camera aim point */
  readonly focus: THREE.Vector3;
  frozen: boolean;
  /** Visible floor height (sidewalks sit above the collision ground); set once the town has loaded. */
  floor: ((x: number, z: number, ground: number) => number) | null;
  setSpawn(p: THREE.Vector3, facing: number): void;
  update(dt: number, input: Input, camYaw: number, colliders: readonly Box[]): void;
}

async function loadKavi(): Promise<AnimatedCharacter> {
  try {
    // Kavi from Tripo Studio (blender/build_studio_character.py): his own mesh, rig and every clip, no Mixamo data.
    return await loadCharacter("/models/v2/kavi.glb", HEIGHT);
  } catch {
    return loadCharacter("/models/player.glb", HEIGHT); // placeholder until kavi.glb exists
  }
}

export async function createPlayer(): Promise<Player> {
  const character = await loadKavi();
  applyToon(character.root, 0.011);
  character.autoGround = true;
  const root = new THREE.Group();
  root.add(character.root);

  const body: Body = { x: 0, y: 0, z: 0, vy: 0, radius: 0.32, height: 1.8, grounded: false };
  const vel = new THREE.Vector2();
  const want = new THREE.Vector2();
  const diff = new THREE.Vector2();
  const focus = new THREE.Vector3();
  let speedNow = 0;
  let wasGrounded = true;

  const player: Player = {
    root, body, heading: Math.PI, frozen: false, focus, floor: null,
    get speed() { return speedNow; },
    setSpawn(p, facing) {
      body.x = p.x; body.y = p.y; body.z = p.z; body.vy = 0;
      vel.set(0, 0);
      player.heading = facing;
    },
    update(dt, input, camYaw, colliders) {
      const f = (input.down("KeyW") || input.down("ArrowUp") ? 1 : 0) - (input.down("KeyS") || input.down("ArrowDown") ? 1 : 0);
      const r = (input.down("KeyD") || input.down("ArrowRight") ? 1 : 0) - (input.down("KeyA") || input.down("ArrowLeft") ? 1 : 0);
      const top = input.down("ShiftLeft") || input.down("ShiftRight") ? RUN_SPEED : WALK_SPEED;
      want.set(0, 0);
      if (!player.frozen && (f || r)) {
        const sy = Math.sin(camYaw), cy = Math.cos(camYaw);
        // forward = (sin, cos); right = (-cos, sin) (screen-right when looking along forward)
        want.set(sy * f - cy * r, cy * f + sy * r).normalize().multiplyScalar(top);
      }
      const moving = want.lengthSq() > 0;
      const jumpWanted = input.consumePress("Space") && !player.frozen;

      let remaining = dt;
      while (remaining > 1e-5) {
        const h = Math.min(remaining, MAX_STEP);
        remaining -= h;
        diff.copy(want).sub(vel);
        const rate = (moving ? ACCEL : DECEL) * (body.grounded ? 1 : AIR_CONTROL);
        const len = diff.length();
        if (len > 1e-6) vel.addScaledVector(diff, Math.min(len, rate * h) / len);
        if (jumpWanted && body.grounded) { body.vy = JUMP_SPEED; body.grounded = false; }
        stepBody(colliders, body, vel.x * h, vel.y * h, h);
      }
      speedNow = vel.length();
      if (body.grounded !== wasGrounded) {
        // airborne (jump or step off a ledge): one hop clip held at its end; landing hands back to locomotion
        character.setAction(body.grounded ? null : "Jump", true);
        wasGrounded = body.grounded;
      }

      if (speedNow > 0.4) {
        let d = Math.atan2(vel.x, vel.y) - player.heading;
        d = Math.atan2(Math.sin(d), Math.cos(d));
        player.heading += d * (1 - Math.exp(-TURN_RATE * dt));
      }
      // Pose first, then height: on the ground both feet stand on the visible pavement; in the air, follow the body.
      root.position.set(body.x, root.position.y, body.z);
      root.rotation.y = player.heading;
      const lean = SPRINT_LEAN * THREE.MathUtils.clamp((speedNow - WALK_SPEED) / (RUN_SPEED - WALK_SPEED), 0, 1);
      character.root.rotation.x += (lean - character.root.rotation.x) * (1 - Math.exp(-8 * dt));
      focus.set(body.x, body.y + 1.45, body.z);
      character.setSpeed(speedNow, WALK_SPEED, RUN_SPEED);
      character.update(dt);
      root.position.y = body.grounded && player.floor ? standHeight(player.floor, body.x, body.z, body.y, character.footprints()) : body.y;
    },
  };
  return player;
}
