// Guest -> email/Google upgrade, checked on testnet with real transactions through the relayer's own `linkIdentity`
// (the step right after the Auth0 token is verified; Google/email login itself needs a person, so synthetic
// identities stand in for verified ones). Run: node scripts/near/link-check.ts
// Checks: a guest with progress links into a new identity account exactly (one starter purse, coin supply unchanged);
// a retry and a login "on another device" change nothing and get the same account and key; an existing identity
// never takes in a second guest without consent; "separate" keeps the guest; "merge" moves it once; the cloud save
// is readable only with a key NEAR shows on the account; the audit holds throughout.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, actions, encodeSignedDelegate, teraToGas } from "near-api-js";
import { handle, linkIdentity, readConfig, type RelayEnv } from "../../server/near/handlers.ts";

const env: RelayEnv = Object.fromEntries(
  fs.readFileSync(".env.local", "utf8").split(/\r?\n/).filter((l) => /^NEAR_[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
);
const cfg = readConfig(env);
const secret = env.NEAR_MERCHANT_SECRET!.trim();
const provider = new JsonRpcProvider({ url: cfg.rpcUrl });
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const req = (): Request => new Request("http://localhost/api/near/social", { method: "POST", headers: { "x-forwarded-for": "10.9.8.7" } });

async function call(route: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await handle(route, new Request(`http://localhost/api/near/${route}`, { method: body === undefined ? "GET" : "POST", body: body === undefined ? undefined : JSON.stringify(body) }), env);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}
const view = async <T>(method: string, args: Record<string, unknown> = {}): Promise<T> =>
  (await provider.callFunction({ contractId: cfg.contractId, method, args, finality: "final" })) as unknown as T;
const holdings = async (id: string): Promise<Record<string, number>> =>
  Object.fromEntries((await view<[string, string][]>("get_balances", { account_id: id })).map(([t, v]) => [t, Number(v)]));
async function settled(id: string): Promise<Record<string, number>> {
  let prev = JSON.stringify(await holdings(id));
  for (let i = 0; i < 8; i++) { await sleep(2000); const next = JSON.stringify(await holdings(id)); if (next === prev) break; prev = next; }
  return JSON.parse(prev) as Record<string, number>;
}
const audit = async (step: string): Promise<void> => {
  const a = await view<{ ok: boolean }>("audit");
  assert.equal(a.ok, true, `audit after ${step}`);
};
const supply = async (): Promise<number> => Number(await view<string>("mt_supply", { token_id: "coin" }));

async function newGuest(): Promise<Account> {
  const key = KeyPair.fromRandom("ed25519");
  const g = await call("guest", { publicKey: key.getPublicKey().toString() });
  assert.equal(g.status, 200, JSON.stringify(g.body));
  return new Account(String(g.body.accountId), provider, new KeyPairSigner(key));
}
async function relay(p: Account, method: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  for (let i = 0; ; i++) {
    try {
      const { signedDelegate } = await p.createSignedMetaTransaction({ receiverId: cfg.contractId, actions: [actions.functionCall(method, args, teraToGas("50"), 0n)], blockHeightTtl: 120 });
      const r = await call("relay", { signedDelegate: Buffer.from(encodeSignedDelegate(signedDelegate)).toString("base64") });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      return r.body;
    } catch (e) { if (i >= 5) throw e; await sleep(1500); }
  }
}
/** A cloud save request signed like the browser does (chain.ts signedForSave). */
function signed(accountId: string, key: KeyPair, data: string): Record<string, unknown> {
  const ts = Date.now(), msg = `vivolith-save|${accountId}|${ts}|${createHash("sha256").update(data).digest("hex")}`;
  return { account: accountId, publicKey: key.getPublicKey().toString(), ts, signature: Buffer.from(key.sign(new TextEncoder().encode(msg)).signature).toString("base64") };
}

const tag = Date.now().toString(36);
const pema = `pema.${cfg.relayerId}`, tomas = `tomas.${cfg.relayerId}`;

// 1. A guest makes progress: buys mangoes and a pack of Pema shares.
const guestA = await newGuest();
const ask = (await view<{ merchant: string; token_id: string; side: string; price: string }[]>("get_offers")).find((o) => o.merchant === "tomas" && o.token_id === "mango" && o.side === "ask")!;
await relay(guestA, "buy", { seller: tomas, token_id: "mango", qty: "2", max_price: ask.price });
await relay(guestA, "buy", { seller: pema, token_id: "share:pema", qty: "15", max_price: "5" });
const aBefore = await settled(guestA.accountId);
console.log(`guest A ${guestA.accountId} progress:`, JSON.stringify(aBefore));

// 2. It signs in with an email that has no account yet: linked in one transaction, exactly the guest's holdings.
const s0 = await supply();
const idX = `email:link-${tag}@example.com`;
const link = await linkIdentity(cfg, req(), idX, secret, guestA.accountId, null);
assert.equal(link.status, "onchain", JSON.stringify(link));
assert.equal(link.merged, guestA.accountId);
const acctX = String(link.accountId);
const xAfter = await settled(acctX);
assert.deepEqual(xAfter, aBefore, "the new account holds exactly what the guest held (its own starter purse burned)");
assert.deepEqual(await settled(guestA.accountId), {}, "the guest is empty: everything moved once");
assert.equal(await supply(), s0, "no coin created: one starter purse in all");
console.log(`linked into ${acctX}: ${JSON.stringify(xAfter)} · coin supply unchanged (${s0})`, (link.txHashes as string[]).map((h) => `https://testnet.nearblocks.io/txns/${h}`).join(" "));
await audit("link");

// 3. A retry with the same guest (an interrupted page) and a login on another device: nothing moves, same account + key.
const retry = await linkIdentity(cfg, req(), idX, secret, guestA.accountId, null);
const device2 = await linkIdentity(cfg, req(), idX, secret, null, null);
assert.deepEqual([retry.accountId, device2.accountId, retry.sessionKey, device2.sessionKey], [acctX, acctX, link.sessionKey, link.sessionKey]);
assert.deepEqual([retry.txHashes, device2.txHashes], [[], []]);
assert.deepEqual(await settled(acctX), xAfter);
console.log("retry and another device: same account and session key, no transaction, holdings unchanged");

// 4. The session key really controls the linked account from anywhere: trade with it.
const onDevice2 = new Account(acctX, provider, new KeyPairSigner(KeyPair.fromString(String(device2.sessionKey) as never)));
await relay(onDevice2, "sell", { buyer: pema, token_id: "share:pema", qty: "15", min_price: "4" });
const x2 = await settled(acctX);
assert.equal(x2.coin, (xAfter.coin ?? 0) + 4);
console.log("another device sold the linked shares back with the derived session key: +4 c");

// 5. A second guest with progress meets the now-existing account: no merge without consent.
const guestB = await newGuest();
await relay(guestB, "buy", { seller: tomas, token_id: "mango", qty: "1", max_price: ask.price });
const bBefore = await settled(guestB.accountId);
const conflict = await linkIdentity(cfg, req(), idX, secret, guestB.accountId, null);
assert.equal(conflict.status, "conflict");
assert.deepEqual([await settled(guestB.accountId), await settled(acctX)], [bBefore, x2], "nothing moved");
console.log("existing account + guest with progress: conflict returned, nothing moved");
const separate = await linkIdentity(cfg, req(), idX, secret, guestB.accountId, "separate");
assert.equal(separate.status, "onchain");
assert.deepEqual([await settled(guestB.accountId), await settled(acctX)], [bBefore, x2], "separate: nothing moved");
console.log("choice 'separate': signed in, the guest stays in its browser untouched");
const s1 = await supply();
const merge = await linkIdentity(cfg, req(), idX, secret, guestB.accountId, "merge");
assert.equal(merge.merged, guestB.accountId);
const x3 = await settled(acctX), burn = Math.min(40, bBefore.coin ?? 0);
assert.equal(x3.coin, (x2.coin ?? 0) + (bBefore.coin ?? 0) - burn);
assert.equal(x3.mango ?? 0, (x2.mango ?? 0) + (bBefore.mango ?? 0));
assert.deepEqual(await settled(guestB.accountId), {});
assert.equal(await supply(), s1 - burn, "one starter purse kept for the merged player");
const again = await linkIdentity(cfg, req(), idX, secret, guestB.accountId, "merge");
assert.deepEqual([again.txHashes, await settled(acctX)], [[], x3], "merging twice moves nothing");
console.log(`choice 'merge': guest B moved in once (one starter purse of ${burn} c burned); a second merge moved nothing`);
await audit("merge");

// 6. Cloud save: only a key NEAR shows on the account can read or write its story.
const keyX = KeyPair.fromString(String(link.sessionKey) as never);
const story = JSON.stringify({ flags: { tut: 4, savedAt: Date.now() }, note: `link-check ${tag}` });
assert.equal((await call("save", { ...signed(acctX, keyX, story), data: story })).status, 200);
const loaded = await call("load", signed(acctX, keyX, ""));
assert.equal(loaded.body.data, story);
const stranger = KeyPair.fromRandom("ed25519");
assert.equal((await call("load", signed(acctX, stranger, ""))).status, 403, "a key that is not on the account cannot read");
const forged = { ...signed(acctX, keyX, ""), signature: Buffer.alloc(64).toString("base64") };
assert.equal((await call("load", forged)).status, 401, "a bad signature cannot read");
assert.equal((await call("save", { ...signed(acctX, stranger, "x"), data: "x" })).status, 403, "nor overwrite");
console.log("cloud save: written and read back with the account's key; foreign key 403, bad signature 401");
console.log("LINK CHECK OK");
