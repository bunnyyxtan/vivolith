// v2 runtime: level loading, update loop, and the hook API for gameplay wiring.
import * as THREE from "three";
import { loadGLB, prepareModel } from "../assets";
import type { Box } from "../physics/collision";
import { createLook, type Look } from "./look";
import { createPlayer, type Player } from "./player";
import { createCameraRig, type CameraRig } from "./camera";
import { createInput, type Input } from "./input";
import { installBrand } from "./brand";
import { installTraffic } from "./traffic";

export interface Game {
  readonly look: Look;
  readonly player: Player;
  readonly rig: CameraRig;
  readonly input: Input;
  readonly colliders: Box[];
  /** Per-frame callbacks for later gameplay wiring (dt in seconds). */
  readonly onUpdate: Array<(dt: number) => void>;
  start(): void;
  /** Advance the simulation manually (tests while rAF is throttled). */
  step(dt: number): void;
  render(): void;
}

const FALLBACK_SPAWN = new THREE.Vector3(0, 0, -30);

async function loadLevel(): Promise<{ scene: THREE.Object3D; colliders: Box[]; spawn: THREE.Vector3; facing: number }> {
  let gltf;
  try {
    gltf = await loadGLB("/models/v2/plaza.glb");
  } catch {
    gltf = await loadGLB("/models/spire.glb");
    const m = prepareModel(gltf.scene);
    return { scene: gltf.scene, colliders: m.colliders, spawn: FALLBACK_SPAWN.clone(), facing: Math.PI };
  }
  const m = prepareModel(gltf.scene);
  const sp = gltf.scene.getObjectByName("SPAWN");
  let spawn = FALLBACK_SPAWN.clone(), facing = Math.PI;
  if (sp) {
    spawn = sp.getWorldPosition(new THREE.Vector3());
    spawn.y += 3; // drop in: the plaza deck is a ~0.9 m collider slab, so spawning at y=0 would be inside it
    // contract: the player faces three -Z (toward the Spire); the SPAWN empty only gives position
  }
  return { scene: gltf.scene, colliders: m.colliders, spawn, facing };
}

export async function createGame(canvas: HTMLCanvasElement, progress: (p: number) => void): Promise<Game> {
  const look = createLook(canvas);
  progress(0.1);
  const level = await loadLevel();
  look.scene.add(level.scene);
  progress(0.6);
  const player = await createPlayer();
  look.scene.add(player.root);
  progress(0.9);

  const input = createInput(canvas);
  const rig = createCameraRig(canvas.clientWidth / Math.max(canvas.clientHeight, 1), level.facing);
  look.pipeline.setCamera(rig.camera);
  player.setSpawn(level.spawn, level.facing);
  const onUpdate: Array<(dt: number) => void> = [];
  installBrand(look.scene, level.colliders, onUpdate); // NEAR City signage, placed once the town has loaded
  void installTraffic(look.scene, level.colliders, player, onUpdate).catch((e: unknown) => console.warn("traffic", e));
  let time = 0;

  const step = (dt: number): void => {
    time += dt;
    player.update(dt, input, rig.yaw, level.colliders);
    rig.update(dt, input, player.focus, level.colliders);
    look.followSun(player.root.position);
    look.updateSky(time, rig.camera.position);
    for (const f of onUpdate) f(dt);
  };
  rig.snap(player.focus, level.colliders);

  const resize = (): void => {
    const w = window.innerWidth, h = window.innerHeight;
    look.pipeline.resize(w, h);
    rig.resize(w / h);
  };
  window.addEventListener("resize", resize);
  resize();

  const game: Game = {
    look, player, rig, input, colliders: level.colliders, onUpdate, step,
    render: () => look.pipeline.render(),
    start() {
      let last = performance.now();
      const loop = (now: number): void => {
        requestAnimationFrame(loop);
        const dt = Math.min((now - last) / 1000, 0.05);
        last = now;
        step(dt);
        game.render();
      };
      requestAnimationFrame(loop);
    },
  };
  progress(1);
  return game;
}
