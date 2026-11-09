// Deploys the VIVOLITH market contract and the four merchant accounts to NEAR testnet. Idempotent: re-running
// redeploys the code but never re-creates accounts or re-seeds inventory.
//   node scripts/near/deploy-contract.ts            (deploy)
//   node scripts/near/deploy-contract.ts --check    (balances only, no transactions)
// Keys: owner from ~/.near-credentials/testnet/<owner>.json, merchant keys derived from NEAR_MERCHANT_SECRET in
// .env.local (generated and appended if missing). Nothing secret is printed.
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Account, JsonRpcProvider, actions, nearToYocto, teraToGas, type KeyPairString } from "near-api-js";
import { MERCHANTS, merchantKey, type MerchantId } from "../../server/near/keys.ts";
import { GUILD_FUND } from "../../server/near/handlers.ts";
import { SHARE_PACK } from "../../src/economy/sim.ts";
import { initialEconomy } from "../../src/economy/state.ts";

const OWNER = "bunnyy-nearworld.testnet";
const CONTRACT = `market.${OWNER}`;
const RPC = process.env.NEAR_RPC_URL ?? "https://rpc.testnet.fastnear.com";
const WASM = path.resolve("contracts/market/target/near/vivolith_market.wasm");
const ENV_FILE = path.resolve(".env.local");
const CONTRACT_FUNDING = "3.5"; // 222 KB code + state headroom
const MERCHANT_FUNDING = "0.5"; // gas for their autonomous trades
const GAS = teraToGas("100");

const RULES: Record<MerchantId, string> = {
  pema: "Loyal: fair low prices for regulars, never gouges, restocks from the cheapest seller.",
  tomas: "Gouger: price climbs with scarcity, sells surplus only at a premium, hoards stock.",
  mira: "Arbitrageur: bids low for surplus, resells where goods are scarce.",
  arin: "Steady: wants reliable supply, pays a fair steady bid, keeps a buffer, avoids risk.",
};

/** Opening stock and tills come from the game's own starting state (src/economy/state.ts), so the chain and the
 *  offline sim start from the same city: Pema nearly out of mangoes, Tomas on a surplus, Mira with cash, Arin balanced.
 *  Orders are not seeded: the first merchant turn (scripts/near/tick.ts) prices and posts them from pricing.ts. */
const START = initialEconomy().merchants;

function ownerKey(): KeyPairString {
  const file = path.join(os.homedir(), ".near-credentials", "testnet", `${OWNER}.json`);
  const key = (JSON.parse(fs.readFileSync(file, "utf8")) as { private_key?: string }).private_key;
  if (!key) throw new Error(`no private_key in ${file}`);
  return key as KeyPairString;
}

function merchantSecret(): string {
  const env = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, "utf8") : "";
  const found = /^NEAR_MERCHANT_SECRET=(.+)$/m.exec(env)?.[1]?.trim();
  if (found) return found;
  const secret = randomBytes(32).toString("hex");
  fs.appendFileSync(ENV_FILE, `${env.endsWith("\n") || !env ? "" : "\n"}NEAR_MERCHANT_SECRET=${secret}\n`);
  console.log("generated NEAR_MERCHANT_SECRET in .env.local");
  return secret;
}

async function exists(provider: JsonRpcProvider, accountId: string): Promise<boolean> {
  try {
    await provider.viewAccount({ accountId, finality: "final" });
    return true;
  } catch {
    return false;
  }
}

const near = (yocto: bigint): string => (Number(yocto / 10n ** 21n) / 1000).toFixed(3);
const txOf = (r: unknown): string => (r as { transaction?: { hash?: string } }).transaction?.hash ?? "?";

async function main(): Promise<void> {
  const provider = new JsonRpcProvider({ url: RPC });
  const owner = new Account(OWNER, provider, ownerKey());
  console.log(`owner ${OWNER}: ${near(await owner.getBalance())} NEAR`);
  if (process.argv.includes("--check")) return;

  const ownerPubKey = await owner.getSigner()!.getPublicKey();
  const ownerPub = ownerPubKey.toString();
  if (process.argv.includes("--fresh") && (await exists(provider, CONTRACT))) {
    // State layout changed: delete the contract account (balance returns to the owner) and start clean.
    console.log(`deleted ${CONTRACT}: ${txOf(await new Account(CONTRACT, provider, ownerKey()).deleteAccount(OWNER))}`);
  }
  if (!(await exists(provider, CONTRACT))) {
    const r = await owner.createSubAccount({ accountOrPrefix: "market", publicKey: ownerPub, nearToTransfer: nearToYocto(CONTRACT_FUNDING) });
    console.log(`created ${CONTRACT}: ${txOf(r)}`);
  }
  const market = new Account(CONTRACT, provider, ownerKey());
  const deployed = txOf(await market.deployContract(new Uint8Array(fs.readFileSync(WASM))));
  console.log(`deployed code: ${deployed}`);
  const state = await market.getContractState().catch(() => ({ values: [] as unknown[] }));
  if (!state.values.some((v) => (v as { key: string }).key === Buffer.from("STATE").toString("base64"))) {
    const args = { operator: OWNER, guild: `guild.${OWNER}`, guild_fund: String(GUILD_FUND) };
    console.log(`init: ${txOf(await market.callFunctionRaw({ contractId: CONTRACT, methodName: "new", args, gas: GAS }))}`);
  }

  const secret = merchantSecret();
  const listed = (await provider.callFunction({ contractId: CONTRACT, method: "get_merchants", args: {}, finality: "final" })) as unknown as { id: string }[];
  const known = new Set(listed.map((m) => m.id));
  for (const id of MERCHANTS) {
    const accountId = `${id}.${OWNER}`;
    const key = merchantKey(id, secret);
    if (!(await exists(provider, accountId))) {
      // Created with the owner's full-access key for recovery, plus a function-call key the relayer signs with.
      const r = await owner.signAndSendTransaction({
        receiverId: accountId,
        actions: [
          actions.createAccount(),
          actions.transfer(nearToYocto(MERCHANT_FUNDING)),
          actions.addFullAccessKey(ownerPubKey),
          actions.addFunctionCallAccessKey(key.getPublicKey(), CONTRACT, ["list", "bid", "buy", "sell"]),
        ],
      });
      console.log(`created ${accountId}: ${txOf(r)}`);
    }
    if (known.has(id)) continue;
    const dealKey = key.getPublicKey().toString();
    const { price, backing } = SHARE_PACK[id];
    await owner.callFunctionRaw({ contractId: CONTRACT, methodName: "add_merchant", args: { id, account_id: accountId, rule: RULES[id], deal_key: dealKey, pack_price: String(price), pack_backing: String(backing) }, gas: GAS });
    const start = START[id];
    for (const [token_id, amount] of Object.entries(start.stock)) {
      if (amount > 0) await owner.callFunctionRaw({ contractId: CONTRACT, methodName: "operator_mint", args: { account_id: accountId, token_id, amount: String(amount), reason: "opening stock" }, gas: GAS });
    }
    await owner.callFunctionRaw({ contractId: CONTRACT, methodName: "seed_till", args: { merchant: id, amount: String(start.cash) }, gas: GAS });
    console.log(`merchant ${id} registered and stocked`);
  }
  console.log(`owner after: ${near(await owner.getBalance())} NEAR`);
  console.log(`contract: https://testnet.nearblocks.io/address/${CONTRACT}`);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message.split("\n")[0] : e);
  process.exit(1);
});
