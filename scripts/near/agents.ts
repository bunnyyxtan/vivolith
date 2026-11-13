// Operator controls for the six NEAR AI agents (server/near/ops.ts). Reads the same Redis the relayer uses.
//   node --env-file=.env.local scripts/near/agents.ts                status: driver, enabled agents, halted, today's use
//   node --env-file=.env.local scripts/near/agents.ts memory pema    one agent's economic memory and today's decision
//   node --env-file=.env.local scripts/near/agents.ts halt           runtime kill switch ON (every price = rule price)
//   node --env-file=.env.local scripts/near/agents.ts resume         kill switch OFF
//   node --env-file=.env.local scripts/near/agents.ts turn           dry run: what one scheduler turn would do
//   node --env-file=.env.local scripts/near/agents.ts turn --yes     runs ONE scheduler turn (signs testnet transactions,
//                                                                    may make paid NEAR AI calls within the daily budget)
// No secret is ever printed.
import { agentConfig, decisionFor } from "../../server/near/agent.ts";
import { AGENTS } from "../../server/near/autonomy.ts";
import { decisionStore, handle, readConfig, MARKET_DAY_MS } from "../../server/near/handlers.ts";
import { readMemory } from "../../server/near/memory.ts";
import { KILL_KEY, agentsHalted, opsConfig, usage } from "../../server/near/ops.ts";

const env = process.env as Record<string, string | undefined>;
const [cmd = "status", arg] = process.argv.slice(2);
const cfg = readConfig(env), store = decisionStore(cfg), ops = opsConfig(env), ai = agentConfig(env);
const day = Math.floor(Date.now() / MARKET_DAY_MS);
if (!cfg.redisUrl) console.warn("No Redis configured: this reads and writes this process's memory only, not the relayer's.");

if (cmd === "status") {
  console.log(JSON.stringify({
    driver: ops.driver, enabled: [...ai.enabled], halted: await agentsHalted(ops, store), nearAiKey: Boolean(ai.key), decisionModel: ai.model,
    chatModel: (env.NEAR_AI_CHAT_MODEL ?? env.NEAR_AI_MODEL ?? "").trim() || null, schedulerSecret: Boolean(ops.schedulerSecret),
    limits: { decisions: ops.dailyDecisions, chats: ops.dailyChats, verifies: ops.dailyVerifies }, usedToday: await usage(store), marketDay: day,
  }, null, 1));
} else if (cmd === "memory") {
  const id = arg ?? "";
  if (!(AGENTS as readonly string[]).includes(id)) throw new Error(`agent must be one of ${AGENTS.join(", ")}`);
  console.log(JSON.stringify({ today: await decisionFor(store, id, day), memory: await readMemory(store, id) }, null, 1));
} else if (cmd === "halt") {
  await store.set(KILL_KEY, `halted by operator at ${new Date().toISOString()}`, 30 * 24 * 3600);
  console.log("agents halted: every merchant and resident uses the rule until `resume`");
} else if (cmd === "resume") {
  await store.del(KILL_KEY);
  console.log(`kill switch cleared${ops.agentsOff ? " (NEAR_AGENTS_OFF is still set in this environment)" : ""}`);
} else if (cmd === "turn") {
  if (!process.argv.includes("--yes")) {
    console.log(`DRY RUN. One scheduler turn would: run market day ${day} on ${cfg.contractId}, let ${[...ai.enabled].join(", ") || "no agent"} decide`
      + ` with ${ai.model}${ai.key ? "" : " (no NEAR_AI_KEY: rule prices only)"}, within ${ops.dailyDecisions} decisions a day. Re-run with --yes to send it.`);
  } else {
    if (!ops.schedulerSecret) throw new Error("set NEAR_SCHEDULER_SECRET (or CRON_SECRET) first");
    const r = await handle("market-turn", new Request("http://localhost/api/near/market-turn", { method: "POST", headers: { authorization: `Bearer ${ops.schedulerSecret}` }, body: "{}" }), env);
    const j = (await r.json()) as { log?: string[]; txHashes?: string[] };
    console.log(r.status, (j.log ?? []).join("\n"), `\n${(j.txHashes ?? []).filter(Boolean).length} transactions`);
  }
} else {
  throw new Error(`unknown command ${cmd}`);
}
