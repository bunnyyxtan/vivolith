import { defineConfig, loadEnv } from "vite";
import { nearRelay } from "./server/near-relay";
import { evidenceWriter } from "./server/evidence";

// NEAR_* variables are read server-side only (never exposed to client code: no VITE_ prefix).
export default defineConfig(({ mode }) => ({
  plugins: [
    nearRelay(loadEnv(mode, process.cwd(), ["NEAR_", "ELEVENLABS_"])), evidenceWriter(process.cwd()),
    // which commit a live page was built from (scripts/deploy.mjs passes it: Vercel builds without .git)
    { name: "commit-stamp", transformIndexHtml: () => [{ tag: "meta", attrs: { name: "vivolith-commit", content: process.env.VIVOLITH_COMMIT ?? "dev" }, injectTo: "head" }] },
  ],
}));
