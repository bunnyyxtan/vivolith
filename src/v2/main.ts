import { inject } from '@vercel/analytics';
import { createGame } from "./game";
import { createPlay } from "./play";
import { BOOT_GROUPS, createBoot, createMenu } from "./menu";
import { cleanUrl, installInspectGuard } from "../near/inspect";
import { prefetch, releasePrefetch } from "../assets";

// Initialize Vercel Web Analytics
inject();

// Every model the first screen needs starts downloading now, in parallel (they used to load one after another).
prefetch(BOOT_GROUPS.flatMap((g) => g.urls));

installInspectGuard(); // /inspect/<account>: read-only, before the game makes any request (src/near/inspect.ts)
// old query-style links (?ledger, ?inspect=) keep working; the address bar then shows the clean route
const clean = cleanUrl(location.pathname, location.search);
if (clean) history.replaceState(null, "", clean + location.hash);
const canvas = document.getElementById("game") as HTMLCanvasElement;
const loader = createBoot();

async function boot(): Promise<void> {
  // the loader's progress is the bytes that arrived (src/assets.ts), then these two real milestones
  const game = await createGame(canvas, () => undefined);
  loader.reached("city");
  const gameplay = await createPlay(game);
  releasePrefetch();
  const menu = createMenu(game, gameplay);
  menu.open();
  game.start();
  loader.reached("ready");
  window.setTimeout(() => loader.hide(), 450); // the first frames render behind the fading loader
  if (import.meta.env.DEV) exposeDevHooks(game, gameplay);
}

// Dev server only (Vite drops this from production builds): playtest helpers on window.__v2 for the browser console.
function exposeDevHooks(game: Awaited<ReturnType<typeof createGame>>, gameplay: Awaited<ReturnType<typeof createPlay>>): void {
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
