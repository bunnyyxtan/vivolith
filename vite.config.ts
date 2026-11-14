import fs from "node:fs";
import path from "node:path";
import { defineConfig, loadEnv } from "vite";
import { nearRelay } from "./server/near-relay";
import { evidenceWriter } from "./server/evidence";

/** The size of every model the game ships, so the loader's progress is exact bytes over exact total (src/assets.ts). */
function modelBytes(dir = "public/models"): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) Object.assign(out, modelBytes(p));
    else if (e.name.endsWith(".glb")) out[`/${path.relative("public", p).split(path.sep).join("/")}`] = fs.statSync(p).size;
  }
  return out;
}

// NEAR_* variables are read server-side only (never exposed to client code: no VITE_ prefix).
export default defineConfig(({ mode }) => ({
  define: { __MODEL_BYTES__: JSON.stringify(modelBytes()) },
  plugins: [
    nearRelay(loadEnv(mode, process.cwd(), ["NEAR_", "ELEVENLABS_", "VIVOLITH_VOICE_", "VIVOLITH_READ_ONLY"])), evidenceWriter(process.cwd()),
    // which commit a live page was built from (scripts/deploy.mjs passes it: Vercel builds without .git)
    { name: "commit-stamp", transformIndexHtml: () => [{ tag: "meta", attrs: { name: "vivolith-commit", content: process.env.VIVOLITH_COMMIT ?? "dev" }, injectTo: "head" }] },
  ],
}));
