// Vercel Function entry (Node.js runtime, web handler signature) for /api/near/<route>. Same handlers as
// `npm run dev`. Bundled by scripts/build-api.mjs into api/near/[route].js (Vercel cannot resolve .ts imports).
import { handle } from "./handlers.ts";

const route = (req: Request): string => new URL(req.url).pathname.split("/").filter(Boolean).pop() ?? "";

export async function GET(req: Request): Promise<Response> {
  return handle(route(req), req, process.env);
}

export async function POST(req: Request): Promise<Response> {
  return handle(route(req), req, process.env);
}
