// Dev-server adapter: mounts the same NEAR relayer handlers the Vercel function uses (server/near/handlers.ts)
// under /api/near/* in `npm run dev`, so local and production behave the same. Keys never reach the bundle.
import type { IncomingMessage } from "node:http";
import type { Plugin } from "vite";
import { handle, type RelayEnv } from "./near/handlers.ts";

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c: Buffer) => {
      raw += c.toString();
      if (raw.length > 8192) req.destroy(new Error("body too large"));
    });
    req.on("end", () => resolve(raw));
    req.on("error", reject);
  });
}

export function nearRelay(env: RelayEnv): Plugin {
  return {
    name: "vivolith-near-relay",
    configureServer(server) {
      server.middlewares.use("/api/near", async (req, res) => {
        const url = new URL(req.originalUrl ?? req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
        const route = url.pathname.split("/").filter(Boolean).pop() ?? "";
        const headers = new Headers();
        for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
        const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req);
        const response = await handle(route, new Request(url, { method: req.method, headers, body }), env);
        res.statusCode = response.status;
        response.headers.forEach((v, k) => res.setHeader(k, v));
        res.end(await response.text());
      });
    },
  };
}
