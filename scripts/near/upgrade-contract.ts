// Upgrades the market contract from v1 (20 shares per stall) to v2 (300 shares, on-chain rent and closures,
// share buyback) without touching anyone's holdings. The new code and `migrate` go in ONE transaction, so the
// upgrade either fully happens or not at all. Before: the raw ledger is snapshotted and checked (every stall's
// holders add up to 20). After: every balance is compared key by key (shares x15, everything else identical).
//   node scripts/near/upgrade-contract.ts --rehearse   (throwaway v1 contract: seed, upgrade, verify, delete)
//   node scripts/near/upgrade-contract.ts              (the live market; refuses unless it still runs v1)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { Account, JsonRpcProvider, actions, nearToYocto, teraToGas, type KeyPairString } from "near-api-js";
import { ledger } from "./ledger.mjs";

const OWNER = "bunnyy-nearworld.testnet";
const RPC = process.env.NEAR_RPC_URL ?? "https://rpc.testnet.fastnear.com";
const V2_WASM = path.resolve("contracts/market/target/near/vivolith_market.wasm");
const V1_CODE_HASH = "DNDtq19jNTtqHR1arr4zm5THQC7EAPBAJ3jUazFMKTcA";
const STORAGE_TOP_UP = "0.5"; // v2 code is ~41 KB larger, plus room for closures, dust and activity records
const GAS = teraToGas("30");

const ownerKey = (): KeyPairString => {
  const file = path.join(os.homedir(), ".near-credentials", "testnet", `${OWNER}.json`);
  return (JSON.parse(fs.readFileSync(file, "utf8")) as { private_key: string }).private_key as KeyPairString;
};
const b58 = (buf: Buffer): string => {
  const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = BigInt(`0x${buf.toString("hex")}`), s = "";
  while (n > 0n) { s = A[Number(n % 58n)] + s; n /= 58n; }
  return s;
};
const txOf = (r: unknown): string => (r as { transaction?: { hash?: string } }).transaction?.hash ?? "?";

type Ledger = Awaited<ReturnType<typeof ledger>>;

/** The ledger once finality has caught up: two reads 3 s apart that agree (recent trades land a few blocks late). */
async function settledLedger(contractId: string): Promise<Ledger> {
  let prev = await ledger(contractId);
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const next = await ledger(contractId);
    if (JSON.stringify(next.balances) === JSON.stringify(prev.balances)) return next;
    prev = next;
  }
  throw new Error("ledger kept changing; try again when the market is quiet");
}

/** Throws unless `after` is exactly `before` with every share balance multiplied by 15. */
export function verifySplit(before: Ledger, after: Ledger): string {
  const keys = new Set([...Object.keys(before.balances), ...Object.keys(after.balances)]);
  let shares = 0, others = 0;
  for (const k of keys) {
    const was = BigInt(before.balances[k] ?? "0"), now = BigInt(after.balances[k] ?? "0");
    const want = k.startsWith("share:") ? was * 15n : was;
    if (now !== want) throw new Error(`ledger mismatch at ${k}: was ${was}, now ${now}, expected ${want}`);
    if (k.startsWith("share:")) shares++; else others++;
  }
  return `${shares} share balances x15 and ${others} other balances unchanged`;
}

function checkV1(l: Ledger): void {
  const sums: Record<string, bigint> = {};
  for (const [k, v] of Object.entries(l.balances)) if (k.startsWith("share:")) { const t = k.split("|")[0]; sums[t] = (sums[t] ?? 0n) + BigInt(v); }
  for (const [t, s] of Object.entries(sums)) if (s !== 20n) throw new Error(`${t} holdings add up to ${s}, not 20: refusing`);
}

async function upgrade(provider: JsonRpcProvider, contractId: string, topUp = STORAGE_TOP_UP): Promise<void> {
  const acct = await provider.viewAccount({ accountId: contractId, finality: "final" }) as unknown as { code_hash: string };
  if (acct.code_hash !== V1_CODE_HASH) throw new Error(`${contractId} runs ${acct.code_hash}, not v1: refusing to migrate`);
  const before = await settledLedger(contractId);
  checkV1(before);
  fs.writeFileSync(path.resolve(`docs/evidence/ledger-before-${contractId.split(".")[0]}.json`), JSON.stringify(before, null, 1));
  const wasm = fs.readFileSync(V2_WASM);
  console.log(`${contractId}: v1 ledger ok (${Object.keys(before.balances).length} balances at block ${before.block}); deploying v2 ${b58(createHash("sha256").update(wasm).digest())}`);
  const owner = new Account(OWNER, provider, ownerKey());
  console.log(`storage top-up: ${txOf(await owner.transfer({ receiverId: contractId, amount: nearToYocto(topUp) }))}`);
  const self = new Account(contractId, provider, ownerKey());
  const r = await self.signAndSendTransaction({
    receiverId: contractId,
    actions: [actions.deployContract(new Uint8Array(wasm)), actions.functionCall("migrate", {}, teraToGas("200"), 0n)],
  });
  console.log(`upgrade + migrate (one transaction): ${txOf(r)}`);
  const after = await settledLedger(contractId);
  fs.writeFileSync(path.resolve(`docs/evidence/ledger-after-${contractId.split(".")[0]}.json`), JSON.stringify(after, null, 1));
  console.log(`verified: ${verifySplit(before, after)}`);
  for (const t of ["share:pema", "share:tomas", "share:mira", "share:arin"]) {
    const s = await provider.callFunction({ contractId, method: "mt_supply", args: { token_id: t }, finality: "final" }).catch(() => null);
    if (s !== null && s !== "300") throw new Error(`${t} supply is ${String(s)}, expected 300`);
  }
}

/** A throwaway v1 market with a merchant, a player holding 4 of 20 shares and an open share ask. */
async function rehearse(provider: JsonRpcProvider): Promise<void> {
  const v1 = path.resolve(process.env.V1_WASM ?? "");
  if (!fs.existsSync(v1)) throw new Error("set V1_WASM to a v1 build (code hash " + V1_CODE_HASH + ")");
  const owner = new Account(OWNER, provider, ownerKey());
  const pub = (await owner.getSigner()!.getPublicKey()).toString();
  const rh = `rh${Date.now().toString(36)}`;
  const contractId = `${rh}.${OWNER}`;
  await owner.createSubAccount({ accountOrPrefix: rh, publicKey: pub, nearToTransfer: nearToYocto("3.6") });
  const c = new Account(contractId, provider, ownerKey());
  const pema = `pema.${contractId}`, kavi = `kavi.${contractId}`;
  try {
  await c.deployContract(new Uint8Array(fs.readFileSync(v1)));
  await c.callFunctionRaw({ contractId, methodName: "new", args: { operator: OWNER }, gas: GAS });
  for (const a of [pema, kavi]) await c.signAndSendTransaction({ receiverId: a, actions: [actions.createAccount(), actions.transfer(nearToYocto("0.15")), actions.addFullAccessKey(await owner.getSigner()!.getPublicKey())] });
  const call = (who: Account, methodName: string, args: object): Promise<unknown> => who.callFunctionRaw({ contractId, methodName, args, gas: GAS });
  await call(owner, "add_merchant", { id: "pema", account_id: pema, rule: "loyal", deal_key: pub });
  await call(owner, "register_player", { account_id: kavi });
  const P = new Account(pema, provider, ownerKey()), K = new Account(kavi, provider, ownerKey());
  await call(P, "list", { token_id: "share:pema", qty: "10", price: "5" });
  await call(K, "buy", { seller: pema, token_id: "share:pema", qty: "4", max_price: "5" });
  console.log(`rehearsal v1 market ${contractId} seeded: kavi holds 4 of 20 Pema shares`);
    await upgrade(provider, contractId, "0.01"); // funded at creation
    // v2 behaviour on the migrated ledger: buy a pack at the carried-over price, buyback, rent and closure
    await call(P, "list", { token_id: "share:pema", qty: "90", price: "1", per: "3" });
    await call(P, "bid", { token_id: "share:pema", qty: "90", price: "1", per: "3" });
    await call(K, "buy", { seller: pema, token_id: "share:pema", qty: "6", max_price: "2" });
    await call(K, "sell", { buyer: pema, token_id: "share:pema", qty: "3", min_price: "1" });
    await call(owner, "charge_rent", { day: 1, merchant: "pema", rent: "999", reopen_need: "2" });
    const stalls = await provider.callFunction({ contractId, method: "get_stalls", args: {}, finality: "final" }) as { open: boolean }[];
    const kv = await provider.callFunction({ contractId, method: "mt_balance_of", args: { account_id: kavi, token_id: "share:pema" }, finality: "final" });
    console.log(`v2 on migrated state: kavi now holds ${String(kv)} (60 + 6 - 3 = 63 expected); pema open: ${stalls[0].open} (false expected)`);
    if (String(kv) !== "63" || stalls[0].open) throw new Error("v2 behaviour check failed");
  } finally {
    for (const a of [kavi, pema]) await new Account(a, provider, ownerKey()).deleteAccount(OWNER).catch(() => undefined);
    await c.deleteAccount(OWNER).catch((e: unknown) => console.log(`could not delete ${contractId}: ${String(e).slice(0, 120)}`));
    console.log(`rehearsal accounts deleted (balance returned to ${OWNER})`);
  }
}

const provider = new JsonRpcProvider({ url: RPC });
const run = process.argv.includes("--rehearse") ? rehearse(provider) : upgrade(provider, `market.${OWNER}`);
run.catch((e: unknown) => { console.error(e instanceof Error ? e.message.split("\n")[0] : e); process.exit(1); });
