// Switches the market contract to revenue-event dividend accrual in place, without resetting anything. ONE transaction
// from the contract account: deploy the one-off `--features upgrade` build, call `adopt_pending_revenue` (revenue
// earned under the old rule is declared and accrued once), deploy the real build. All three actions run in one
// receipt, so the upgrade either fully happens or not at all, and no sale can land in between.
//   node scripts/near/upgrade-accrual.ts --rehearse   (throwaway contract on the old code: seed, upgrade, verify, delete)
//   node scripts/near/upgrade-accrual.ts              (the live market; refuses unless it still runs the old code)
// Checks: the code hash before and after, every non-coin balance unchanged, players' coin unchanged, audit ok, and the
// holders' owed dividends equal to what the old rule would have paid for the pending revenue.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Account, JsonRpcProvider, KeyPair, actions, nearToYocto, teraToGas, type KeyPairString } from "near-api-js";
import { ledger } from "./ledger.mjs";

const OWNER = "bunnyy-nearworld.testnet";
const RPC = process.env.NEAR_RPC_URL ?? "https://rpc.testnet.fastnear.com";
const DIR = path.resolve("contracts/market/target/near");
const OLD_HASH = "AJpMw5JUn9rpWRCQbY27jQwdHRzHJghJRbZRurvGsuFB";
const GAS = teraToGas("100");
const K = 720720n * 10n ** 18n;

const ownerKey = (): KeyPairString =>
  (JSON.parse(fs.readFileSync(path.join(os.homedir(), ".near-credentials", "testnet", `${OWNER}.json`), "utf8")) as { private_key: string }).private_key as KeyPairString;
const b58 = (buf: Buffer): string => {
  const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = BigInt(`0x${buf.toString("hex")}`), s = "";
  while (n > 0n) { s = A[Number(n % 58n)] + s; n /= 58n; }
  return s;
};
const wasm = (f: string): Uint8Array => new Uint8Array(fs.readFileSync(path.join(DIR, f)));
const hashOf = (f: string): string => b58(createHash("sha256").update(fs.readFileSync(path.join(DIR, f))).digest());
const txOf = (r: unknown): string => (r as { transaction?: { hash?: string } }).transaction?.hash ?? "?";
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const provider = new JsonRpcProvider({ url: RPC });
const owner = new Account(OWNER, provider, ownerKey());

const view = async <T>(contractId: string, method: string, args: Record<string, unknown> = {}): Promise<T> =>
  (await provider.callFunction({ contractId, method, args, finality: "final" })) as unknown as T;
const codeHash = async (id: string): Promise<string> => (await provider.viewAccount({ accountId: id, finality: "final" })).code_hash;
/** The ledger once finality caught up: two reads 3 s apart that agree. */
async function settledLedger(id: string): Promise<Awaited<ReturnType<typeof ledger>>> {
  let prev = await ledger(id);
  for (let i = 0; i < 10; i++) {
    await sleep(3000);
    const next = await ledger(id);
    if (JSON.stringify(next.balances) === JSON.stringify(prev.balances)) return next;
    prev = next;
  }
  return prev;
}

interface Stall { merchant: string; revenue: string; supply: string; treasury: string }
interface Pending { merchant: string; shares: string; coins: string; fraction: string }

/** What each holder is owed once the pending revenue is declared, as the old rule would have at settlement
 *  (in 1/K coin; the old and new remainders may differ by less than one coin, which the check allows). */
async function expectedOwed(id: string, holders: string[]): Promise<Map<string, bigint>> {
  const stalls = await view<Stall[]>(id, "get_stalls");
  const out = new Map<string, bigint>();
  for (const h of holders) {
    const pend = await view<Pending[]>(id, "get_pending", { account_id: h });
    let units = 0n;
    for (const p of pend) {
      const s = stalls.find((x) => x.merchant === p.merchant)!;
      const declared = (BigInt(s.revenue) * 5000n) / 10000n;
      units += BigInt(p.coins) * K + BigInt(p.fraction) + ((declared * K) / BigInt(s.supply)) * BigInt(p.shares);
    }
    out.set(h, units);
  }
  return out;
}

async function upgrade(id: string, holders: string[]): Promise<void> {
  assert.equal(await codeHash(id), OLD_HASH, `${id} does not run the old code; refusing`);
  assert.equal(hashOf("old.wasm"), OLD_HASH);
  const before = await settledLedger(id);
  const stallsBefore = await view<Stall[]>(id, "get_stalls");
  const expect = await expectedOwed(id, holders);
  console.log(`before: ${Object.keys(before.balances).length} balances, pending revenue ${stallsBefore.map((s) => `${s.merchant} ${s.revenue}`).join(", ")}`);
  const market = new Account(id, provider, ownerKey());
  const r = await market.signAndSendTransaction({
    receiverId: id,
    actions: [
      actions.deployContract(wasm("upgrade.wasm")),
      actions.functionCall("adopt_pending_revenue", {}, GAS, 0n),
      actions.deployContract(wasm("vivolith_market.wasm")),
    ],
  });
  console.log(`upgrade tx (deploy upgrade build + adopt_pending_revenue + deploy final build): https://testnet.nearblocks.io/txns/${txOf(r)}`);
  await sleep(3000);
  assert.equal(await codeHash(id), hashOf("vivolith_market.wasm"), "final code is live");
  const after = await settledLedger(id);
  // Only coin moved, and only between merchant tills and the contract's vault: players and goods are untouched.
  const merchants = (await view<{ account_id: string }[]>(id, "get_merchants")).map((m) => m.account_id);
  const keys = new Set([...Object.keys(before.balances), ...Object.keys(after.balances)]);
  for (const k of keys) {
    const [token, who] = k.split("|");
    if (token === "coin" && (merchants.includes(who) || who === id)) continue;
    assert.equal(after.balances[k], before.balances[k], `${k} changed: ${before.balances[k]} -> ${after.balances[k]}`);
  }
  const audit = await view<{ ok: boolean; contract_coin: string; reserves_and_vaults: string }>(id, "audit");
  assert.equal(audit.ok, true, `audit failed: ${JSON.stringify(audit)}`);
  for (const h of holders) {
    const pend = await view<Pending[]>(id, "get_pending", { account_id: h });
    const got = pend.reduce((n, p) => n + BigInt(p.coins) * K + BigInt(p.fraction), 0n);
    const want = expect.get(h)!;
    const diff = got > want ? got - want : want - got;
    assert.ok(diff <= K, `${h}: owed ${got}, the old rule would have given ${want}`);
    console.log(`  ${h}: owed ${(Number(got) / Number(K)).toFixed(4)} c (old rule at settlement: ${(Number(want) / Number(K)).toFixed(4)} c)`);
  }
  const stallsAfter = await view<Stall[]>(id, "get_stalls");
  console.log(`after: audit ok (contract ${audit.contract_coin} c = reserves + vaults ${audit.reserves_and_vaults} c); day revenue kept: ${stallsAfter.map((s) => `${s.merchant} ${s.revenue}`).join(", ")}`);
}

async function rehearse(): Promise<void> {
  const id = `rh${Date.now().toString(36)}.${OWNER}`;
  const ownerPub = (await owner.getSigner()!.getPublicKey()).toString();
  console.log(`rehearsal contract ${id}`);
  await owner.createSubAccount({ accountOrPrefix: id.split(".")[0], publicKey: ownerPub, nearToTransfer: nearToYocto("4") });
  const c = new Account(id, provider, ownerKey());
  const call = (method: string, args: Record<string, unknown>) => owner.callFunctionRaw({ contractId: id, methodName: method, args, gas: GAS });
  const coinOf = async (who: string): Promise<number> => Number(await view<string>(id, "mt_balance_of", { account_id: who, token_id: "coin" }));
  try {
    await c.deployContract(wasm("old.wasm"));
    await call("new", { operator: OWNER, guild: `guild.${id}`, guild_fund: "200" });
    const dealKey = KeyPair.fromRandom("ed25519").getPublicKey().toString();
    await call("add_merchant", { id: "pema", account_id: `pema.${id}`, rule: "rehearsal", deal_key: dealKey, pack_price: "5", pack_backing: "4" });
    await call("register_player", { account_id: OWNER });
    await call("buy", { seller: `pema.${id}`, token_id: "share:pema", qty: "75", max_price: "25" }); // a quarter of Pema
    await call("operator_mint", { account_id: `pema.${id}`, token_id: "mango", amount: "20", reason: "harbor" });
    await call("street_sale", { merchant: "pema", token_id: "mango", qty: "20", unit_price: "3" }); // 60 c revenue, pending
    await upgrade(id, [OWNER]);
    // after the switch: a sale accrues at once, and settlement only closes the record
    await call("operator_mint", { account_id: `pema.${id}`, token_id: "mango", amount: "10", reason: "harbor" });
    await call("street_sale", { merchant: "pema", token_id: "mango", qty: "10", unit_price: "2" }); // 20 c -> 10 declared -> 2.5
    await sleep(3000);
    const owed = (await view<Pending[]>(id, "get_pending", { account_id: OWNER }))[0];
    assert.deepEqual([owed.coins, owed.fraction], ["10", "0"], "7.5 + 2.5 owed after the first sale on the new code");
    await call("settle_day", { day: 1, merchant: "pema" });
    await sleep(3000);
    const last = (await view<{ revenue: string; declared: string; funded: string; arrears: string }[]>(id, "get_settlements", { merchant: "pema" })).at(-1)!;
    assert.deepEqual([last.revenue, last.declared, last.funded, last.arrears], ["80", "40", "40", "0"], JSON.stringify(last));
    console.log(`  day record after the switch: revenue ${last.revenue}, declared ${last.declared}, funded ${last.funded}`);
    const coin0 = await coinOf(OWNER);
    await call("sell", { buyer: `pema.${id}`, token_id: "share:pema", qty: "75", min_price: "20" }); // pays dividends first
    await sleep(3000);
    assert.equal((await coinOf(OWNER)) - coin0, 10 + 20, "selling paid the 10 c of dividends and the 20 c backing");
    assert.equal((await view<{ ok: boolean }>(id, "audit")).ok, true);
    console.log("REHEARSAL OK");
  } finally {
    console.log(`deleted ${id}: ${txOf(await c.deleteAccount(OWNER))}`);
  }
}

if (process.argv.includes("--rehearse")) await rehearse();
else {
  const id = `market.${OWNER}`;
  const holders = Array.from(new Set(Object.keys((await ledger(id)).balances).filter((k) => k.startsWith("share:")).map((k) => k.split("|")[1])))
    .filter((h) => !/^(pema|tomas|mira|arin)\./.test(h));
  console.log(`live: ${holders.length} partner accounts hold shares`);
  await upgrade(id, holders);
  console.log("UPGRADE OK");
}
