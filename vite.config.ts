import { defineConfig, loadEnv } from "vite";
import { nearRelay } from "./server/near-relay";

// NEAR_* variables are read server-side only (never exposed to client code: no VITE_ prefix).
export default defineConfig(({ mode }) => ({
  plugins: [nearRelay(loadEnv(mode, process.cwd(), "NEAR_"))],
}));
