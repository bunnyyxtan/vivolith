import * as THREE from "three";
import type { Input } from "./input";
import type { Box } from "./physics/collision";

const tmpBox = new THREE.Box3();
const tmpHit = new THREE.Vector3();

/** Nearest hit distance of a ray against collider boxes (cheap vs. raycasting 700k triangles). */
function rayVsBoxes(ray: THREE.Ray, boxes: readonly Box[], far: number): number {
  let best = far;
  for (const b of boxes) {
    if (b.maxY - b.minY < 1.2) continue; // curbs, sidewalks, tables: never block the view
    tmpBox.min.set(b.minX, b.minY, b.minZ);
    tmpBox.max.set(b.maxX, b.maxY, b.maxZ);
    if (ray.intersectBox(tmpBox, tmpHit)) best = Math.min(best, tmpHit.distanceTo(ray.origin));
  }
  return best;
}

const MOUSE_SENSITIVITY = 0.0024;
const BASE_DISTANCE = 4.6;
const SHOULDER = 0.55;
const EYE_HEIGHT = 1.55;
const MIN_DISTANCE = 1.8;
const MAX_DISTANCE = 12;
const MIN_PITCH = -0.45;
const MAX_PITCH = 1.15;

export interface CameraRig {
  readonly camera: THREE.PerspectiveCamera;
  yaw(): number;
  /** Point the orbit (used by cutscenes and automated screenshots). */
  setView(yaw: number, pitch: number): void;
  update(dt: number, input: Input, target: THREE.Vector3, blockers: readonly Box[]): void;
}

export function createCameraRig(aspect: number): CameraRig {
  const camera = new THREE.PerspectiveCamera(58, aspect, 0.1, 600);
  const ray = new THREE.Ray();
  const focus = new THREE.Vector3();
  const desired = new THREE.Vector3();
  const dir = new THREE.Vector3();
  const smoothFocus = new THREE.Vector3();
  let yaw = 0;
  let pitch = 0.22;
  let distance = BASE_DISTANCE;
  let zoomDistance = BASE_DISTANCE;
  let first = true;

  return {
    camera,
    yaw: () => yaw,
    setView(y, p) {
      yaw = y;
      pitch = THREE.MathUtils.clamp(p, MIN_PITCH, MAX_PITCH);
    },
    update(dt, input, target, blockers) {
      const look = input.takeLook();
      yaw -= look.dx * MOUSE_SENSITIVITY;
      pitch = THREE.MathUtils.clamp(pitch + look.dy * MOUSE_SENSITIVITY, MIN_PITCH, MAX_PITCH);
      zoomDistance = THREE.MathUtils.clamp(zoomDistance * (1 + input.takeZoom() * 0.12), MIN_DISTANCE, MAX_DISTANCE);

      focus.set(target.x, target.y + EYE_HEIGHT, target.z);
      if (first) smoothFocus.copy(focus);
      smoothFocus.lerp(focus, 1 - Math.exp(-18 * dt));

      // Orbit offset behind the player, plus an over-the-shoulder shift to the right.
      const cosP = Math.cos(pitch);
      dir.set(Math.sin(yaw) * cosP, Math.sin(pitch), Math.cos(yaw) * cosP);
      const right = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
      const pivot = smoothFocus.clone().addScaledVector(right, SHOULDER);

      // Pull in when geometry blocks the view; ease back out slowly.
      ray.set(pivot, dir);
      const hitDistance = rayVsBoxes(ray, blockers, zoomDistance + 0.25);
      const allowed = Math.max(0.8, Math.min(zoomDistance, hitDistance - 0.25));
      const rate = allowed < distance ? 25 : 4;
      distance += (allowed - distance) * (1 - Math.exp(-rate * dt));
      if (first) distance = allowed;
      first = false;

      desired.copy(pivot).addScaledVector(dir, distance);
      camera.position.copy(desired);
      camera.lookAt(pivot);
    },
  };
}
