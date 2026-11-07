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
import { Account, JsonRpcProvider, KeyPairSigner, actions, nearToYocto, teraToGas, type KeyPairString } from "near-api-js";
import { MERCHANTS, merchantKey, type MerchantId } from "../../server/near/keys.ts";

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

/** Starting inventory: Pema is nearly out of mangoes, Tomas sits on a surplus, Mira has cash, Arin is balanced. */
const SEED: Record<MerchantId, { mint: [string, number][]; asks: [string, number, number][]; bids: [string, number, number][] }> = {
  pema: { mint: [["mango", 3], ["lemon", 12], ["coin", 20]], asks: [["mango", 3, 22], ["lemon", 12, 4], ["share:pema", 10, 5]], bids: [["mango", 20, 9]] },
  tomas: { mint: [["mango", 40], ["coin", 30]], asks: [["mango", 40, 12], ["share:tomas", 6, 9]], bids: [] },
  mira: { mint: [["coin", 150]], asks: [["share:mira", 6, 7]], bids: [["mango", 20, 6], ["lemon", 20, 2]] },
  arin: { mint: [["mango", 10], ["lemon", 10], ["lassi", 12], ["coin", 60]], asks: [["lassi", 12, 6], ["share:arin", 6, 6]], bids: [["mango", 10, 8]] },
};

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
    console.log(`init: ${txOf(await market.callFunctionRaw({ contractId: CONTRACT, methodName: "new", args: { operator: OWNER }, gas: GAS }))}`);
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
    const seed = SEED[id];
    const dealKey = key.getPublicKey().toString();
    await owner.callFunctionRaw({ contractId: CONTRACT, methodName: "add_merchant", args: { id, account_id: accountId, rule: RULES[id], deal_key: dealKey }, gas: GAS });
    for (const [token_id, amount] of seed.mint) {
      await owner.callFunctionRaw({ contractId: CONTRACT, methodName: "operator_mint", args: { account_id: accountId, token_id, amount: String(amount), reason: "opening stock" }, gas: GAS });
    }
    const merchant = new Account(accountId, provider, new KeyPairSigner(key));
    for (const [method, orders] of [["list", seed.asks], ["bid", seed.bids]] as const) {
      for (const [token_id, qty, price] of orders) {
        await merchant.callFunctionRaw({ contractId: CONTRACT, methodName: method, args: { token_id, qty: String(qty), price: String(price) }, gas: GAS });
      }
    }
    console.log(`merchant ${id} registered and stocked`);
  }
  console.log(`owner after: ${near(await owner.getBalance())} NEAR`);
  console.log(`contract: https://testnet.nearblocks.io/address/${CONTRACT}`);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message.split("\n")[0] : e);
  process.exit(1);
});
