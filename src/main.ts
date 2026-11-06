import * as THREE from "three";
import "./style.css";
import { createInput } from "./input";
import { createPlayer } from "./player";
import { createCameraRig } from "./camera";
import { buildWorld, SUN_DIR } from "./world";
import { createGameplay } from "./gameplay";
import { createCrowd, marketStallStops, type Crowd } from "./crowd";
import { createPipeline, createPortraitStudio, createRenderer, loadEnvironment } from "./render";
import { loadCharacter, showPlaceholderNotice } from "./character";

// Poly Haven "venice_sunset": the sun sits at u=0.600 of the equirect (measured in Blender).
const HDRI_URL = "/hdri/venice_sunset_2k.hdr";
const HDRI_SUN_U = 0.5999;

const canvas = document.querySelector<HTMLCanvasElement>("#game")!;
const renderer = createRenderer(canvas);
const scene = new THREE.Scene();
const world = buildWorld(scene);
const input = createInput(canvas);
const rig = createCameraRig(window.innerWidth / window.innerHeight);
const pipeline = createPipeline(renderer, scene, rig.camera);

// Rotate the HDRI so its sun lines up with the shadow-casting light.
const hdriPhi = (HDRI_SUN_U - 0.5) * Math.PI * 2;
const hdriAzimuth = Math.atan2(Math.cos(hdriPhi), Math.sin(hdriPhi));
const sunAzimuth = Math.atan2(SUN_DIR.x, SUN_DIR.z);
const envReady = loadEnvironment(renderer, scene, HDRI_URL, hdriAzimuth - sunAzimuth, SUN_DIR);
const player = createPlayer(world.spawn);
scene.add(player.mesh);
loadCharacter("/models/player.glb", 1.76)
  .then((c) => player.attachCharacter(c))
  .catch(() => showPlaceholderNotice("Placeholder character: Mixamo model not imported yet (public/models/player.glb)"));

// ---------- HUD + gameplay ----------
const titleCard = document.querySelector<HTMLDivElement>("#title-card")!;
const playButton = document.querySelector<HTMLButtonElement>("#play")!;
const gameplay = createGameplay(
  document.querySelector<HTMLDivElement>("#hud")!, world, player, rig, input, createPortraitStudio(renderer, scene),
);

// Ambient crowd: browses open stalls; Pema's stall counts as open only while the economy says so.
let crowd: Crowd | null = null;
world.ready
  .then(() => createCrowd(scene, marketStallStops((id) => {
    if (id !== "pema") return true;
    const p = gameplay.state().merchants.pema;
    return p.status === "open" && p.stock.mango + p.stock.lemon > 0;
  })))
  .then((c) => {
    crowd = c;
    (window as unknown as { __nw: Record<string, unknown> }).__nw.crowd = c;
  })
  .catch(() => showPlaceholderNotice("Market crowd failed to load (public/models/*.glb)"));

let started = false;
// No pointer lock: the cursor stays visible for UI; hold right mouse to orbit (see input.ts).
playButton.addEventListener("click", () => {
  started = true;
  titleCard.classList.add("hidden");
});

// ---------- Loop ----------
const clock = new THREE.Clock();
function frame() {
  const dt = Math.min(clock.getDelta(), 0.05);
  const t = clock.elapsedTime;

  if (!started) {
    // Title shot: slow orbit-free drift towards the tower until the player clicks in.
    input.takeLook();
    input.takeZoom();
    rig.camera.position.set(6 + Math.sin(t * 0.08) * 2, 3.2, 30 - t * 0.15);
    rig.camera.lookAt(0, 12, -21);
  } else {
    player.update(dt, input, rig.yaw(), world.colliders, gameplay.frozen());
    rig.update(dt, input, player.mesh.position, world.colliders);
  }
  gameplay.update(dt, started);
  crowd?.update(dt, player.mesh.position);

  world.update(t, player.mesh.position);
  pipeline.render();
  requestAnimationFrame(frame);
}

playButton.disabled = true;
playButton.textContent = "Loading Saltlight Row...";
Promise.all([world.ready, envReady])
  .then(() => {
    playButton.disabled = false;
    playButton.textContent = "Click to enter";
  })
  .catch((err: unknown) => {
    playButton.textContent = "Failed to load the district. Reload to retry.";
    throw err;
  });
requestAnimationFrame(frame);

window.addEventListener("resize", () => {
  rig.camera.aspect = window.innerWidth / window.innerHeight;
  rig.camera.updateProjectionMatrix();
  pipeline.resize(window.innerWidth, window.innerHeight);
});

// Test hook for automated playtests (read-only inspection).
(window as unknown as { __nw: unknown }).__nw = { player, rig, world, renderer, input, gameplay, pipeline };
