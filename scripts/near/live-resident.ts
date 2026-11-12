// One autonomous resident journey on testnet: Lin (picker) works, ONE Jev decision picks her buyer and her meal from the
// real posted orders, then she trades with her own key. It runs the relayer's own residentTurn, never the full market tick.
//   node scripts/near/live-resident.ts          dry run: reads chain only, prints the rule plan and the exact transactions
//   node scripts/near/live-resident.ts --yes    runs it: at most 1 NEAR AI request and 4 testnet transactions, no retries
// Transactions: (1) relayer mints Lin's day of mangoes, (2) Lin sells to the chosen bid, (3) Lin buys a lassi, (4) relayer
// burns the lassi (eaten). Nothing secret is printed.
import fs from "node:fs";
import { Account, JsonRpcProvider } from "near-api-js";
import { MARKET_DAY_MS, decisionStore, readConfig, residentTurn, type RelayEnv } from "../../server/near/handlers.ts";
import { agentConfig } from "../../server/near/agent.ts";
import { RESIDENTS, planResident, type Offer } from "../../src/economy/residents.ts";

const send = process.argv.includes("--yes");
const env: RelayEnv = Object.fromEntries(
  fs.readFileSync(".env.local", "utf8").split(/\r?\n/).filter((l) => /^NEAR_[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
);
const cfg = readConfig(env);
const provider = new JsonRpcProvider({ url: cfg.rpcUrl });
const agentCfg = { ...agentConfig({ ...env, NEAR_AGENT_MERCHANTS: "picker" }), retries: 0 }; // only Lin; never a second request
const lin = RESIDENTS.find((r) => r.id === "picker")!;
const accountId = `${lin.id}.${cfg.relayerId}`;
const link = (h: string): string => `https://testnet.nearblocks.io/txns/${h}`;
const view = async <T>(method: string, args: Record<string, unknown> = {}): Promise<T> =>
  (await provider.callFunction({ contractId: cfg.contractId, method, args, finality: "final" })) as unknown as T;
const held = async (id: string): Promise<Record<string, number>> => Object.fromEntries((await view<[string, string][]>("get_balances", { account_id: id })).map(([t, v]) => [t, Number(v)]));
const fail = (m: string): never => { console.error("STOP:", m); process.exit(1); };

const day = Math.floor(Date.now() / MARKET_DAY_MS);
const book = await view<Offer[]>("get_offers");
const before = await held(accountId);
if (!(await view<boolean>("is_registered", { account_id: accountId }))) fail(`${accountId} is not registered`);
if (!agentCfg.key) fail("NEAR_AI_KEY is not set");
const plan = planResident(lin, book, before.coin ?? 0, (before.mango ?? 0) + lin.perDay);
console.log(`Lin now: ${JSON.stringify(before)}; rule plan today: sell ${plan.sell ? `${plan.sell.qty} to ${plan.sell.merchant} at ${plan.sell.price} c` : "nothing"}, meal ${plan.eat ? `from ${plan.eat.merchant} at ${plan.eat.price} c` : plan.hungry !== null ? `unaffordable (${plan.hungry} c)` : "none posted"}`);
if (!plan.sell && !plan.eat) fail("no posted bid for mangoes and no lassi ask: Lin has nothing to respond to (nothing sent)");
if (!send) { console.log("DRY RUN: nothing sent. Re-run with --yes (1 NEAR AI request, up to 4 transactions)."); process.exit(0); }

// residentTurn calls the global fetch for the model, so cap the model endpoint at one request; chain calls pass through
let aiRequests = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
  if (String(url).startsWith(agentCfg.url) && ++aiRequests > 1) throw new Error("a second NEAR AI request was refused");
  return realFetch(url, init);
}) as typeof fetch;
const log: string[] = [], txs: string[] = [];
const relayer = new Account(cfg.relayerId, provider, cfg.relayerKey!);
const ate = await residentTurn(cfg, provider, relayer, env.NEAR_MERCHANT_SECRET!.trim(), day, log, txs, agentCfg, decisionStore(cfg));
console.log("\n--- result ---");
for (const l of log) console.log(" ", l);
for (const h of txs) console.log("  ", link(h));
console.log(`NEAR AI requests: ${aiRequests}; transactions: ${txs.length}; meals eaten: ${JSON.stringify(ate)}`);
await new Promise((r) => setTimeout(r, 6000));
console.log(`Lin after: ${JSON.stringify(await held(accountId))}`);
