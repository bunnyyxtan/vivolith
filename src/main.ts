import * as THREE from "three";
import "./style.css";
import { createInput } from "./input";
import { createPlayer } from "./player";
import { createCameraRig } from "./camera";
import { buildWorld, SUN_DIR, type Interactable } from "./world";
import { createPipeline, createRenderer, loadEnvironment } from "./render";
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

// ---------- HUD ----------
const titleCard = document.querySelector<HTMLDivElement>("#title-card")!;
const playButton = document.querySelector<HTMLButtonElement>("#play")!;
const promptEl = document.querySelector<HTMLDivElement>("#prompt")!;
const dialogueEl = document.querySelector<HTMLDivElement>("#dialogue")!;
const speakerEl = dialogueEl.querySelector<HTMLDivElement>(".speaker")!;
const lineEl = dialogueEl.querySelector<HTMLDivElement>(".line")!;

let started = false;
const lock = () => {
  canvas.requestPointerLock()?.catch?.(() => { /* user gesture race: next click retries */ });
};
playButton.addEventListener("click", () => {
  started = true;
  titleCard.classList.add("hidden");
  lock();
});
canvas.addEventListener("click", () => { if (started && !input.locked()) lock(); });

let talkingTo: Interactable | null = null;
let lineIndex = 0;

function nearestInteractable(): Interactable | null {
  let best: Interactable | null = null;
  let bestDist = Infinity;
  for (const it of world.interactables) {
    const d = Math.hypot(it.position.x - player.body.x, it.position.z - player.body.z);
    if (d < it.radius && d < bestDist) { best = it; bestDist = d; }
  }
  return best;
}

function updateInteraction() {
  const near = nearestInteractable();
  if (talkingTo && near !== talkingTo) { talkingTo = null; dialogueEl.hidden = true; }

  if (input.pressed("KeyE") && near) {
    if (talkingTo === near) {
      lineIndex += 1;
      if (lineIndex >= near.lines.length) { talkingTo = null; dialogueEl.hidden = true; }
    } else {
      talkingTo = near;
      lineIndex = 0;
    }
    if (talkingTo) {
      speakerEl.textContent = talkingTo.name;
      lineEl.textContent = talkingTo.lines[lineIndex];
      dialogueEl.hidden = false;
    }
  }

  world.talk(talkingTo ? talkingTo.id : null); // no-op when unchanged

  const showPrompt = near !== null && started;
  promptEl.hidden = !showPrompt;
  if (showPrompt && near) {
    promptEl.innerHTML = `<kbd>E</kbd>${talkingTo ? "Continue" : `Talk to ${near.name}`}`;
  }
}

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
    player.update(dt, input, rig.yaw(), world.colliders, false);
    rig.update(dt, input, player.mesh.position, world.colliders);
    updateInteraction();
  }

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
(window as unknown as { __nw: unknown }).__nw = { player, rig, world, renderer, input };
