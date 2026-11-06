import * as THREE from "three";
import { stepBody, type Body, type Box } from "./physics/collision";
import type { Input } from "./input";
import type { AnimatedCharacter } from "./character";

const WALK_SPEED = 3.4;
const RUN_SPEED = 7.0;
const ACCEL = 14; // how fast velocity reaches the target (1/s)
const TURN_RATE = 12;
const JUMP_SPEED = 6.2;

export interface Player {
  readonly body: Body;
  readonly mesh: THREE.Group;
  /** Swap the placeholder body for an animated character. */
  attachCharacter(character: AnimatedCharacter): void;
  update(dt: number, input: Input, cameraYaw: number, colliders: readonly Box[], frozen: boolean): void;
}

/** Placeholder hero until the Blender character lands (Milestone 2). */
function buildMesh(): THREE.Group {
  const g = new THREE.Group();
  const jacket = new THREE.MeshStandardMaterial({ color: 0x2b3440, roughness: 0.75 });
  const skin = new THREE.MeshStandardMaterial({ color: 0xc58c62, roughness: 0.6 });
  const scarf = new THREE.MeshStandardMaterial({ color: 0x0091fd, roughness: 0.5, emissive: 0x003a66, emissiveIntensity: 0.4 });

  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.28, 0.75, 6, 16), jacket);
  torso.position.y = 0.95;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.19, 24, 16), skin);
  head.position.y = 1.62;
  const scarfMesh = new THREE.Mesh(new THREE.TorusGeometry(0.17, 0.05, 8, 20), scarf);
  scarfMesh.rotation.x = Math.PI / 2;
  scarfMesh.position.y = 1.42;
  const bag = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.28, 0.14), new THREE.MeshStandardMaterial({ color: 0x8a5a33, roughness: 0.8 }));
  bag.position.set(0, 1.0, -0.3); // on the back: makes facing readable from the camera
  for (const m of [torso, head, scarfMesh, bag]) {
    m.castShadow = true;
    g.add(m);
  }
  return g;
}

export function createPlayer(spawn: THREE.Vector3): Player {
  const body: Body = { x: spawn.x, y: spawn.y, z: spawn.z, vy: 0, radius: 0.32, height: 1.8, grounded: false };
  const mesh = buildMesh();
  const velocity = new THREE.Vector2();
  let facing = Math.PI; // facing -z (towards the tower)
  let bob = 0;
  let character: AnimatedCharacter | null = null;

  return {
    body,
    mesh,
    attachCharacter(c) {
      for (const child of [...mesh.children]) mesh.remove(child);
      mesh.add(c.root);
      character = c;
    },
    update(dt, input, cameraYaw, colliders, frozen) {
      const k = input.keys;
      const fwd = frozen ? 0 : (k.has("KeyW") || k.has("ArrowUp") ? 1 : 0) - (k.has("KeyS") || k.has("ArrowDown") ? 1 : 0);
      const side = frozen ? 0 : (k.has("KeyD") || k.has("ArrowRight") ? 1 : 0) - (k.has("KeyA") || k.has("ArrowLeft") ? 1 : 0);

      // Camera-relative direction: camera looks along -z when yaw = 0.
      const sin = Math.sin(cameraYaw);
      const cos = Math.cos(cameraYaw);
      const dirX = -sin * fwd + cos * side;
      const dirZ = -cos * fwd - sin * side;
      const len = Math.hypot(dirX, dirZ);
      const speed = k.has("ShiftLeft") || k.has("ShiftRight") ? RUN_SPEED : WALK_SPEED;
      const targetX = len > 0 ? (dirX / len) * speed : 0;
      const targetZ = len > 0 ? (dirZ / len) * speed : 0;

      const blend = 1 - Math.exp(-ACCEL * dt);
      velocity.x += (targetX - velocity.x) * blend;
      velocity.y += (targetZ - velocity.y) * blend;

      if (!frozen && body.grounded && input.pressed("Space")) body.vy = JUMP_SPEED;

      stepBody(colliders, body, velocity.x * dt, velocity.y * dt, dt);

      const moving = velocity.length();
      if (moving > 0.2) {
        const want = Math.atan2(velocity.x, velocity.y);
        let delta = want - facing;
        delta = Math.atan2(Math.sin(delta), Math.cos(delta));
        facing += delta * (1 - Math.exp(-TURN_RATE * dt));
      }
      bob += dt * moving * 2.2;
      if (character) {
        character.setSpeed(moving, WALK_SPEED, RUN_SPEED);
        character.update(dt);
      }
      const bobOffset = !character && body.grounded ? Math.abs(Math.sin(bob)) * 0.05 * Math.min(moving / RUN_SPEED, 1) : 0;
      mesh.position.set(body.x, body.y + bobOffset, body.z);
      mesh.rotation.y = facing;
    },
  };
}
