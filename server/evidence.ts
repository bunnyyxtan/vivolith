// Dev-server-only endpoint for automated playtest screenshots: POST /__evidence?name=<slug> with a JPEG
// body writes docs/evidence/<slug>.jpg. Used by the browser pane, which cannot save downloads itself.
// Not part of `vite build` (apply: "serve"), and the name is restricted to a safe slug.
import fs from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";

const NAME = /^[a-z0-9][a-z0-9-]{2,80}$/;
const MAX_BYTES = 8 * 1024 * 1024;

export function evidenceWriter(root: string): Plugin {
  const dir = path.join(root, "docs", "evidence");
  return {
    name: "vivolith-evidence",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/__evidence", (req, res) => {
        const name = new URL(req.url ?? "", "http://x").searchParams.get("name") ?? "";
        if (req.method !== "POST" || !NAME.test(name)) {
          res.statusCode = 400;
          res.end("bad request");
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        req.on("data", (c: Buffer) => {
          size += c.length;
          if (size > MAX_BYTES) req.destroy();
          else chunks.push(c);
        });
        req.on("end", () => {
          const body = Buffer.concat(chunks);
          if (body[0] !== 0xff || body[1] !== 0xd8) { // JPEG magic
            res.statusCode = 415;
            res.end("jpeg only");
            return;
          }
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(path.join(dir, `${name}.jpg`), body);
          res.end(JSON.stringify({ ok: true, bytes: body.length }));
        });
      });
    },
  };
}
