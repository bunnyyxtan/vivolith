// Kavi: third-person locomotion with eased velocity, smooth turning and speed-matched animation.
import * as THREE from "three";
import { stepBody, type Body, type Box } from "../physics/collision";
import { loadCharacter, type AnimatedCharacter } from "../character";
import { applyToon } from "./toon";
import type { Input } from "./input";

export const WALK_SPEED = 3.2;
export const RUN_SPEED = 6.8;
const ACCEL = 28; // m/s^2 toward target velocity
const DECEL = 34;
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
    return await loadCharacter("/models/v2/kavi.glb", HEIGHT);
  } catch {
    return loadCharacter("/models/player.glb", HEIGHT); // placeholder until kavi.glb exists
  }
}

export async function createPlayer(): Promise<Player> {
  const character = await loadKavi();
  applyToon(character.root, 0.011);
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
      // On the ground, stand on the visible pavement; in the air, follow the body.
      root.position.set(body.x, body.grounded && player.floor ? player.floor(body.x, body.z, body.y) : body.y, body.z);
      root.rotation.y = player.heading;
      focus.set(body.x, body.y + 1.45, body.z);
      character.setSpeed(speedNow, WALK_SPEED, RUN_SPEED);
      character.update(dt);
    },
  };
  return player;
}
