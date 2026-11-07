// End-to-end relayer check against testnet, exercising the same handlers the browser hits:
// guest account -> haggled deal signed by Pema -> player's meta-transaction relayed -> balances on both sides change.
// Also checks that a forbidden method is refused. Run: node scripts/near/e2e.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, actions, encodeSignedDelegate, teraToGas } from "near-api-js";
import { handle, readConfig, type RelayEnv } from "../../server/near/handlers.ts";

const env: RelayEnv = Object.fromEntries(
  fs.readFileSync(".env.local", "utf8").split(/\r?\n/).filter((l) => /^NEAR_[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
);
const cfg = readConfig(env);
const provider = new JsonRpcProvider({ url: cfg.rpcUrl });

async function call(route: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const req = new Request(`http://localhost/api/near/${route}`, { method: body === undefined ? "GET" : "POST", body: body === undefined ? undefined : JSON.stringify(body) });
  const res = await handle(route, req, env);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const balances = async (accountId: string): Promise<Record<string, number>> =>
  Object.fromEntries(((await provider.callFunction({ contractId: cfg.contractId, method: "get_balances", args: { account_id: accountId }, finality: "final" })) as unknown as [string, string][]).map(([t, v]) => [t, Number(v)]));

async function relayCall(player: Account, method: string, args: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  for (let i = 0; ; i++) {
    try {
      const { signedDelegate } = await player.createSignedMetaTransaction({ receiverId: cfg.contractId, actions: [actions.functionCall(method, args, teraToGas("50"), 0n)], blockHeightTtl: 120 });
      return await call("relay", { signedDelegate: Buffer.from(encodeSignedDelegate(signedDelegate)).toString("base64") });
    } catch (e) {
      if (i >= 5) throw e; // a just-created access key can take a block or two to become visible
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
}

const tx = (h: unknown): string => `https://testnet.nearblocks.io/txns/${String(h)}`;

const status = await call("status");
console.log("status", status.body.configured, status.body.contractId, status.body.rateLimit);
assert.equal(status.body.configured, true);

const key = KeyPair.fromRandom("ed25519");
const guest = await call("guest", { publicKey: key.getPublicKey().toString() });
assert.equal(guest.status, 200, JSON.stringify(guest.body));
const accountId = String(guest.body.accountId);
console.log("guest", accountId, (guest.body.txHashes as string[]).map(tx).join(" "));
const player = new Account(accountId, provider, new KeyPairSigner(key));
const pema = `pema.${cfg.relayerId}`;

const before = { you: await balances(accountId), pema: await balances(pema) };
const signed = await call("deal", { merchant: "pema", side: "buy", token: "mango", qty: 1, unit: 15, player: accountId });
assert.equal(signed.status, 200, JSON.stringify(signed.body));
const dealt = await relayCall(player, "deal", signed.body.args as Record<string, unknown>);
assert.equal(dealt.status, 200, JSON.stringify(dealt.body));
console.log("deal (haggled 1 mango at 15 c, Pema-signed)", tx(dealt.body.txHash));

const bought = await relayCall(player, "buy", { seller: pema, token_id: "lemon", qty: "2", max_price: "4" });
assert.equal(bought.status, 200, JSON.stringify(bought.body));
console.log("buy (2 lemons at Pema's posted 4 c)", tx(bought.body.txHash));

const after = { you: await balances(accountId), pema: await balances(pema) };
console.log("you  ", JSON.stringify(before.you), "->", JSON.stringify(after.you));
console.log("pema ", JSON.stringify(before.pema), "->", JSON.stringify(after.pema));
assert.equal(after.you.coin, before.you.coin - 15 - 8);
assert.equal(after.you.mango, 1);
assert.equal(after.you.lemon, 2);
assert.equal(after.pema.coin, before.pema.coin + 23);
assert.equal(after.pema.mango, before.pema.mango - 1);

const tooCheap = await call("deal", { merchant: "pema", side: "buy", token: "mango", qty: 1, unit: 2, player: accountId });
assert.equal(tooCheap.status, 409);
console.log("lowball refused:", tooCheap.body.message);

const { signedDelegate } = await player.createSignedMetaTransaction({ receiverId: cfg.contractId, actions: [actions.functionCall("register_player", { account_id: accountId }, teraToGas("30"), 0n)], blockHeightTtl: 120 });
const forbidden = await call("relay", { signedDelegate: Buffer.from(encodeSignedDelegate(signedDelegate)).toString("base64") });
assert.equal(forbidden.status, 403);
console.log("forbidden method refused:", forbidden.body.message);

const receipts = (await provider.callFunction({ contractId: cfg.contractId, method: "get_receipts", args: { account_id: accountId }, finality: "final" })) as unknown as { kind: string; token_id: string; qty: string; price: string }[];
console.log("receipts on chain:", receipts.map((r) => `${r.kind} ${r.qty} ${r.token_id} @${r.price}`).join(", "));
console.log("E2E OK");
