// Resets the market contract's ledger in place (testnet only), for when its state is too large for NEAR to delete the
// account. Deploys the one-off `--features cleanup` build, deletes every raw state key in batches, and checks the
// state is empty. Then `node scripts/near/deploy-contract.ts` deploys the real code (which has no `clean`) and inits.
// Every NEAR account (players, merchants, the relayer) is untouched; only this contract's storage is cleared.
//   node scripts/near/reset-state.ts            (dry run: prints what would be deleted)
//   node scripts/near/reset-state.ts --confirm  (clears it)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Account, JsonRpcProvider, teraToGas, type KeyPairString } from "near-api-js";

const OWNER = "bunnyy-nearworld.testnet";
const CONTRACT = `market.${OWNER}`;
const RPC = process.env.NEAR_RPC_URL ?? "https://rpc.testnet.fastnear.com";
const CLEANUP_WASM = path.resolve("contracts/market/target/near/cleanup.wasm");
const BATCH = 120;

if (!CONTRACT.endsWith(".testnet")) throw new Error("testnet only");

async function rpc<T>(method: string, params: unknown): Promise<T> {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = (await r.json()) as { result?: T; error?: unknown };
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error).slice(0, 300)}`);
  return j.result as T;
}

const stateKeys = async (): Promise<string[]> =>
  (await rpc<{ values: { key: string }[] }>("query", { request_type: "view_state", finality: "final", account_id: CONTRACT, prefix_base64: "" })).values.map((v) => v.key);

const ownerKey = (): KeyPairString => {
  const file = path.join(os.homedir(), ".near-credentials", "testnet", `${OWNER}.json`);
  return (JSON.parse(fs.readFileSync(file, "utf8")) as { private_key: string }).private_key as KeyPairString;
};
const txOf = (r: unknown): string => (r as { transaction?: { hash?: string } }).transaction?.hash ?? "?";

const keys = await stateKeys();
const acct = await rpc<{ storage_usage: number; code_hash: string }>("query", { request_type: "view_account", finality: "final", account_id: CONTRACT });
const prefixes: Record<string, number> = {};
for (const k of keys) {
  const p = Buffer.from(k, "base64").subarray(0, 1).toString("latin1");
  prefixes[p] = (prefixes[p] ?? 0) + 1;
}
console.log(`${CONTRACT}: ${keys.length} state keys, ${acct.storage_usage} B, code ${acct.code_hash}`);
console.log(`keys by collection prefix: ${JSON.stringify(prefixes)}`);
if (!process.argv.includes("--confirm")) {
  console.log("dry run: nothing changed (pass --confirm to clear)");
  process.exit(0);
}

const provider = new JsonRpcProvider({ url: RPC });
const market = new Account(CONTRACT, provider, ownerKey());
console.log(`deployed cleanup build: ${txOf(await market.deployContract(new Uint8Array(fs.readFileSync(CLEANUP_WASM))))}`);
for (let i = 0; i < keys.length; i += BATCH) {
  const r = await market.callFunctionRaw({ contractId: CONTRACT, methodName: "clean", args: { keys: keys.slice(i, i + BATCH) }, gas: teraToGas("300") });
  console.log(`cleared keys ${i + 1}-${Math.min(i + BATCH, keys.length)}: ${txOf(r)}`);
}
let left = await stateKeys();
for (let i = 0; i < 10 && left.length; i++) { // the last batch reaches "final" a few blocks later
  await new Promise((r) => setTimeout(r, 2000));
  left = await stateKeys();
}
console.log(left.length === 0 ? "state is empty" : `${left.length} keys left`);
if (left.length) process.exit(1);
