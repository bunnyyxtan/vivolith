import { createGame } from "./game";

const canvas = document.getElementById("game") as HTMLCanvasElement;
const title = document.getElementById("title")!;
const fill = document.getElementById("fill") as HTMLElement;
const play = document.getElementById("play") as HTMLButtonElement;

async function boot(): Promise<void> {
  const game = await createGame(canvas, (p) => { fill.style.width = `${Math.round(p * 100)}%`; });
  game.start();
  play.classList.add("ready");
  play.addEventListener("click", () => {
    title.classList.add("gone");
    void canvas.requestPointerLock?.();
  });

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
    renderer: look.renderer, scene: look.scene, camera: rig.camera, player, pipeline: look.pipeline, game,
    sim: (sec: number) => { for (let i = 0; i < sec * 60; i++) step(1 / 60); },
    shot: post, frameTime,
  };
}

boot().catch((e: unknown) => {
  fill.style.background = "#ff6b6b";
  throw e;
});
