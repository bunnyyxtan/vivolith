import { createGame } from "./game";
import { createPlay } from "./play";
import { createBoot, createMenu } from "./menu";

const canvas = document.getElementById("game") as HTMLCanvasElement;
const loader = createBoot();

async function boot(): Promise<void> {
  const game = await createGame(canvas, (p) => loader.progress(p * 0.5));
  // The market (town, merchants, townsfolk) has no progress events: ease the rule toward 95% meanwhile.
  let eased = 0.5;
  const ease = window.setInterval(() => { eased += (0.95 - eased) * 0.06; loader.progress(eased); }, 120);
  const gameplay = await createPlay(game);
  window.clearInterval(ease);
  const menu = createMenu(game, gameplay);
  menu.open();
  game.start();
  loader.progress(1);
  window.setTimeout(() => loader.hide(), 350); // the first frames render behind the fading loader

  const { look, player, rig, step } = game;
  const post = async (name: string): Promise<string> => {
    game.render();
    const blob = await new Promise<Blob | null>((r) => look.renderer.domElement.toBlob(r, "image/jpeg", 0.9));
    if (!blob) throw new Error("capture failed");
    const res = await fetch(`/__evidence?name=${encodeURIComponent(name)}`, { method: "POST", body: blob });
    return `${res.status} ${await res.text()}`;
  };
  const frameTime = (frames = 60): number => {
    const gl = look.renderer.getContext();
    const t: number[] = [];
    for (let i = 0; i < frames; i++) {
      gl.finish();
      const t0 = performance.now();
      game.render();
      gl.finish();
      t.push(performance.now() - t0);
    }
    t.sort((a, b) => a - b);
    return Number(t[frames >> 1].toFixed(2));
  };
  (window as unknown as Record<string, unknown>).__v2 = {
    renderer: look.renderer, scene: look.scene, camera: rig.camera, player, pipeline: look.pipeline, game, play: gameplay,
    sim: (sec: number) => { for (let i = 0; i < sec * 60; i++) step(1 / 60); },
    shot: post, frameTime,
  };
}

boot().catch((e: unknown) => {
  loader.fail("the city could not load. Reload to try again");
  throw e;
});
