// Runs one autonomous merchant turn on testnet (same handler the game calls) and prints what each merchant did.
//   node scripts/near/tick.ts
import fs from "node:fs";
import { handle, type RelayEnv } from "../../server/near/handlers.ts";

const env: RelayEnv = Object.fromEntries(
  fs.readFileSync(".env.local", "utf8").split(/\r?\n/).filter((l) => /^NEAR_[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
);
const route = process.argv[2] ?? "tick";
const res = await handle(route, new Request(`http://localhost/api/near/${route}`, { method: "POST", body: "{}" }), env);
const body = (await res.json()) as { status: string; log?: string[]; txHashes?: string[]; message?: string };
console.log(res.status, body.status, body.message ?? "");
for (const l of body.log ?? []) console.log(" ", l);
for (const h of body.txHashes ?? []) console.log("  https://testnet.nearblocks.io/txns/" + h);
