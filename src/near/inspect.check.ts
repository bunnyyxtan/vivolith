// Read-only inspection (?inspect) cannot change the economy or spend credits.  node src/near/inspect.check.ts
import assert from "node:assert/strict";
import fs from "node:fs";

// a browser page opened with ?inspect=<account>, whose real fetch only records what would have left the page
const sent: string[] = [];
const g = globalThis as unknown as Record<string, unknown>;
g.location = { search: "?inspect=kavi-qa.bunnyy-nearworld.testnet" };
g.window = globalThis;
g.fetch = (input: string, init?: RequestInit): Promise<Response> => { sent.push(`${init?.method ?? "GET"} ${input}`); return Promise.resolve(new Response("{}")); };
const { READ_ONLY, INSPECT_ACCOUNT, inspectParam, installInspectGuard, mutating } = await import("./inspect.ts");

assert.equal(inspectParam(""), null, "a normal page is not an inspection");
assert.equal(inspectParam("?ledger"), null);
assert.equal(inspectParam("?inspect"), "");
assert.ok(READ_ONLY && INSPECT_ACCOUNT === "kavi-qa.bunnyy-nearworld.testnet");

// every route the client posts to (read from chain.ts, moves.ts and audio.ts), plus every mutating server route
const chain = fs.readFileSync("src/near/chain.ts", "utf8") + fs.readFileSync("src/near/moves.ts", "utf8"), audio = fs.readFileSync("src/v2/audio.ts", "utf8");
const posted = [...chain.matchAll(/(?:post|retried)\("([a-z-]+)"/g)].map((m) => m[1]);
assert.ok(posted.length >= 12, `client routes found: ${posted.join(", ")}`);
assert.ok(audio.includes('fetch("/api/near/voice", { method: "POST"'), "the voice route is a POST");
const writes = [...new Set([...posted, "voice", "guest", "register", "relay", "settle", "deal", "tick", "pick", "talk", "social", "claim", "save", "load", "market-turn"])];
for (const r of writes) assert.ok(mutating("POST", `/api/near/${r}`) && mutating("post", `https://vivolith.world/api/near/${r}`), r);
for (const r of ["status", "chronicle", "decisions?merchant=pema"]) assert.ok(!mutating("GET", `/api/near/${r}`) && !mutating(undefined, `/api/near/${r}`), r);
assert.ok(!mutating("POST", "https://rpc.testnet.fastnear.com"), "NEAR view calls (JSON-RPC) stay allowed: no key is loaded to sign");

installInspectGuard();
for (const r of writes) {
  const res = await fetch(`/api/near/${r}`, { method: "POST", body: "{}" });
  assert.equal(res.status, 403, r);
  assert.equal(((await res.json()) as { message: string }).message, "read-only inspection");
}
await fetch(new Request("http://local/api/near/tick", { method: "POST" }));
await fetch("/api/near/status"); await fetch("/api/near/chronicle");
assert.deepEqual(sent, ["GET /api/near/status", "GET /api/near/chronicle"], "only reads left the page");

// no key is ever loaded or created: connectGuest returns the watched account before touching the key store or posting
const cg = chain.slice(chain.indexOf("export async function connectGuest"));
const ro = cg.indexOf("if (READ_ONLY)"), key = cg.indexOf("KEY_STORE"), post = cg.indexOf("post(");
assert.ok(ro > 0 && ro < key && ro < post, "connectGuest: the read-only branch comes first");
assert.ok(/if \(READ_ONLY\) \{ watched = [^}]*return watched; \}/.test(cg), "the read-only branch only watches");
assert.ok(chain.includes('if (!player) return { status: "local"'), "trades without a signer never sign");
// the save is never written during an inspection
assert.ok(fs.readFileSync("src/v2/play.ts", "utf8").includes("if (resetting || READ_ONLY) return;"));

// server side: a QA relay started with VIVOLITH_READ_ONLY=1 refuses every write, whatever page or tool calls it
const { handle } = await import("../../server/near/handlers.ts");
const qa = { VIVOLITH_READ_ONLY: "1", NEAR_RPC_URL: "http://127.0.0.1:9" };
for (const r of writes) assert.equal((await handle(r, new Request(`http://localhost/api/near/${r}`, { method: "POST", body: "{}" }), qa)).status, 403, `server ${r}`);
assert.equal((await handle("market-turn", new Request("http://localhost/api/near/market-turn", { headers: { authorization: "Bearer x" } }), { ...qa, CRON_SECRET: "x" })).status, 403, "no scheduled turn");
assert.notEqual((await handle("status", new Request("http://localhost/api/near/status"), qa)).status, 403, "reads answer");
assert.notEqual((await handle("tick", new Request("http://localhost/api/near/tick", { method: "POST", body: "{}" }), { NEAR_RPC_URL: "http://127.0.0.1:9" })).status, 403, "without the switch, normal players are unaffected");
// the dev relay only sees env vars vite.config.ts passes it: without this the switch silently does nothing
assert.ok(/loadEnv\(.*"VIVOLITH_READ_ONLY"/.test(fs.readFileSync("vite.config.ts", "utf8")), "vite.config.ts passes VIVOLITH_READ_ONLY to the relay");
assert.ok(fs.readFileSync(".claude/launch.json", "utf8").includes("$env:VIVOLITH_READ_ONLY='1'"), "near-world-inspect sets the switch");
console.log(`inspect.check: ok (${writes.length} write routes refused in the page and on a read-only relay, reads pass)`);
