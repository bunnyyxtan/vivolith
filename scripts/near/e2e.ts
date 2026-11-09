// End-to-end check against testnet through the same relayer handlers the browser hits, with real transactions:
// two fresh guest accounts; a haggled deal signed by a merchant; posted buys; investing (reserve + till split); a
// sale back at the backing; refused moves that must change nothing; dividends settled and claimed; a re-register of
// an existing account; and the contract's own `audit` after every step. Run: node scripts/near/e2e.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, actions, encodeSignedDelegate, teraToGas } from "near-api-js";
import { handle, readConfig, type RelayEnv } from "../../server/near/handlers.ts";

const env: RelayEnv = Object.fromEntries(
  fs.readFileSync(".env.local", "utf8").split(/\r?\n/).filter((l) => /^NEAR_[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
);
const cfg = readConfig(env);
const provider = new JsonRpcProvider({ url: cfg.rpcUrl });
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function call(route: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const req = new Request(`http://localhost/api/near/${route}`, { method: body === undefined ? "GET" : "POST", body: body === undefined ? undefined : JSON.stringify(body) });
  const res = await handle(route, req, env);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const view = async <T>(method: string, args: Record<string, unknown> = {}): Promise<T> =>
  (await provider.callFunction({ contractId: cfg.contractId, method, args, finality: "final" })) as unknown as T;
const balances = async (accountId: string): Promise<Record<string, number>> =>
  Object.fromEntries((await view<[string, string][]>("get_balances", { account_id: accountId })).map(([t, v]) => [t, Number(v)]));
/** Balances once "final" has caught up with a just-landed transaction (two equal reads 2 s apart). */
async function settled(accountId: string): Promise<Record<string, number>> {
  let prev = JSON.stringify(await balances(accountId));
  for (let i = 0; i < 8; i++) {
    await sleep(2000);
    const next = JSON.stringify(await balances(accountId));
    if (next === prev) return JSON.parse(next) as Record<string, number>;
    prev = next;
  }
  return JSON.parse(prev) as Record<string, number>;
}
async function audit(step: string): Promise<void> {
  const a = await view<{ ok: boolean; custody_ok: boolean; contract_coin: string; reserves_and_vaults: string; stalls: { merchant: string; reserve_ok: boolean; vault_ok: boolean }[] }>("audit");
  assert.equal(a.ok, true, `audit failed after ${step}: ${JSON.stringify(a)}`);
  console.log(`  audit ok after ${step}: contract holds ${a.contract_coin} c = reserves + vaults ${a.reserves_and_vaults} c`);
}

async function relayCall(player: Account, method: string, args: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  for (let i = 0; ; i++) {
    try {
      const { signedDelegate } = await player.createSignedMetaTransaction({ receiverId: cfg.contractId, actions: [actions.functionCall(method, args, teraToGas("50"), 0n)], blockHeightTtl: 120 });
      return await call("relay", { signedDelegate: Buffer.from(encodeSignedDelegate(signedDelegate)).toString("base64") });
    } catch (e) {
      if (i >= 5) throw e; // a just-created access key can take a block or two to become visible
      await sleep(1500);
    }
  }
}

/** contracts/market STARTER_COIN: what register_player mints, once per account. */
const STARTER = 40;
const tx = (h: unknown): string => `https://testnet.nearblocks.io/txns/${String(h)}`;

async function newGuest(): Promise<Account> {
  const key = KeyPair.fromRandom("ed25519");
  const guest = await call("guest", { publicKey: key.getPublicKey().toString() });
  assert.equal(guest.status, 200, JSON.stringify(guest.body));
  const accountId = String(guest.body.accountId);
  console.log("guest", accountId, (guest.body.txHashes as string[]).map(tx).join(" "));
  return new Account(accountId, provider, new KeyPairSigner(key));
}

const status = await call("status");
assert.equal(status.body.configured, true);
console.log("status", status.body.contractId, status.body.rateLimit);
await audit("opening");

const [kavi, rin] = [await newGuest(), await newGuest()];
const pema = `pema.${cfg.relayerId}`, tomas = `tomas.${cfg.relayerId}`;
assert.equal((await settled(kavi.accountId)).coin, STARTER, "starter purse, minted once on NEAR");
assert.equal((await settled(rin.accountId)).coin, STARTER);
// The grant is once per account: asking again (a reload, Continue or New Game re-runs this) mints nothing.
const supply0 = await view<string>("mt_supply", { token_id: "coin" });
const again1 = await call("guest", { publicKey: (await kavi.getSigner()!.getPublicKey()).toString() });
const again2 = await call("register", { accountId: kavi.accountId });
assert.equal(again1.status, 200); assert.equal(again2.status, 200);
assert.deepEqual([again1.body.txHashes, again2.body.txHashes], [[], []], "no transaction: already registered");
assert.equal((await settled(kavi.accountId)).coin, STARTER, "still exactly one starter purse");
assert.equal(await view<string>("mt_supply", { token_id: "coin" }), supply0, "no coin minted by the repeats");
console.log(`starter purse: ${STARTER} c on NEAR for each new guest; repeated guest/register calls minted nothing`);
// A refused registration grants nothing: only accounts this relayer created can register.
const fake = await call("register", { accountId: "g0123456789abcdef.someone-else.testnet" });
assert.equal(fake.status, 400);
assert.equal(await view<string>("mt_supply", { token_id: "coin" }), supply0);
console.log("refused registration of a foreign account:", fake.body.message);

// 1. Buy 3 mangoes from Tomas at his posted price (tutorial step 3).
const offers = await view<{ merchant: string; token_id: string; side: string; qty: string; price: string }[]>("get_offers");
const ask = offers.find((o) => o.merchant === "tomas" && o.token_id === "mango" && o.side === "ask");
assert.ok(ask && Number(ask.qty) >= 3, "Tomas has mangoes on offer");
const bought = await relayCall(kavi, "buy", { seller: tomas, token_id: "mango", qty: "3", max_price: ask.price });
assert.equal(bought.status, 200, JSON.stringify(bought.body));
console.log(`buy 3 mangoes from Tomas at ${ask.price} c`, tx(bought.body.txHash));

// 2. A refused move changes nothing: price limit below the ask.
const before = await settled(kavi.accountId);
const refused = await relayCall(kavi, "buy", { seller: tomas, token_id: "mango", qty: "1", max_price: String(Number(ask.price) - 1) });
assert.equal(refused.status, 422, JSON.stringify(refused.body));
assert.deepEqual(await settled(kavi.accountId), before, "a failed trade moves nothing");
console.log("refused (price limit):", refused.body.message, tx(refused.body.txHash));

// 3. Deliver to Pema with a haggled deal she signs (tutorial step 4): 3 at 6 c. If her till cannot pay 18 c yet, the
// next market turn's Market Guild loan covers it (as a player waiting a minute would see).
if (((await settled(pema)).coin ?? 0) < 18) {
  const t = await call("tick", {});
  console.log("pema's till was short: market turn", t.body.status, ((t.body.log as string[] | undefined) ?? []).filter((l) => /guild lent pema/.test(l)).join("; "));
  await settled(pema);
}
// 3. Deliver to Pema with a haggled deal she signs (tutorial step 4): 3 at 6 c.
const signed = await call("deal", { merchant: "pema", side: "sell", token: "mango", qty: 3, unit: 6, player: kavi.accountId });
assert.equal(signed.status, 200, JSON.stringify(signed.body));
const dealt = await relayCall(kavi, "deal", signed.body.args as Record<string, unknown>);
assert.equal(dealt.status, 200, JSON.stringify(dealt.body));
console.log("deal: sold 3 mangoes to Pema at 6 c (Pema-signed)", tx(dealt.body.txHash));
const replay = await relayCall(kavi, "deal", signed.body.args as Record<string, unknown>);
assert.notEqual(replay.status, 200, "a signed deal is single use");
console.log("replayed deal refused:", replay.body.message ?? replay.body.status);
const stalls = await view<{ merchant: string; open: boolean }[]>("get_stalls");
console.log("pema open after the delivery:", stalls.find((s) => s.merchant === "pema")?.open);

// 4. Invest: 2 packs of Pema (5 c each: 4 c reserve, 1 c till), and Rin 1 pack of Tomas.
const pemaBefore = await settled(pema);
const inv = await relayCall(kavi, "buy", { seller: pema, token_id: "share:pema", qty: "30", max_price: "10" });
assert.equal(inv.status, 200, JSON.stringify(inv.body));
console.log("invest 30 Pema shares for 10 c", tx(inv.body.txHash));
const inv2 = await relayCall(rin, "buy", { seller: tomas, token_id: "share:tomas", qty: "15", max_price: "10" });
assert.equal(inv2.status, 200, JSON.stringify(inv2.body));
console.log("invest 15 Tomas shares for 10 c", tx(inv2.body.txHash));
const k1 = await settled(kavi.accountId);
assert.equal(k1["share:pema"], 30);
assert.equal((await settled(pema)).coin - pemaBefore.coin, 2, "1 c a pack to the till");
await audit("investing");

// 5. Sell one pack back: exactly the 4 c backing, whatever Pema's till holds.
const sold = await relayCall(kavi, "sell", { buyer: pema, token_id: "share:pema", qty: "15", min_price: "4" });
assert.equal(sold.status, 200, JSON.stringify(sold.body));
const k2 = await settled(kavi.accountId);
assert.equal(k2.coin - k1.coin, 4);
assert.equal(k2["share:pema"], 15);
console.log("sold 15 Pema shares back for 4 c", tx(sold.body.txHash));
const oversell = await relayCall(kavi, "sell", { buyer: pema, token_id: "share:pema", qty: "30", min_price: "0" });
assert.equal(oversell.status, 422);
console.log("refused (selling shares not owned):", oversell.body.message);
await audit("selling back");

// 6. Dividends: settle today for every stall, then claim. What is owed comes from the contract's own view.
const settle = await call("settle", {});
console.log("settle", settle.status, settle.body.status, tx(settle.body.txHash));
await sleep(3000);
for (const who of [kavi, rin]) {
  const owed = await view<{ merchant: string; shares: string; coins: string; fraction: string }[]>("get_pending", { account_id: who.accountId });
  console.log(`  ${who.accountId.slice(0, 8)} owed:`, owed.filter((p) => p.shares !== "0" || p.coins !== "0").map((p) => `${p.merchant} ${p.coins} c + ${(Number(p.fraction) / 720720e18).toFixed(4)}`).join(", ") || "nothing");
  const c = await call("claim", { account: who.accountId });
  console.log(`  claim -> ${c.body.status} ${c.body.coins ?? ""}`, c.body.txHash ? tx(c.body.txHash) : "");
}
await audit("dividends");

// 6b. Dividend sniping on NEAR: Rin has held Tomas shares since step 4. The market turn makes sales; they accrue to
// holders at that moment. Sam buys a pack only afterwards, right before settlement, and sells right after: Sam must
// get the 8 c backing back and no dividend, while Rin's owed dividend grew with the sales.
const owedUnits = async (who: string, stall: string): Promise<bigint> => {
  const p = (await view<{ merchant: string; coins: string; fraction: string }[]>("get_pending", { account_id: who })).find((x) => x.merchant === stall)!;
  return BigInt(p.coins) * 720720n * 10n ** 18n + BigInt(p.fraction);
};
const sam = await newGuest();
const rinBefore = await owedUnits(rin.accountId, "tomas");
const turn = await call("tick", {});
console.log("market turn:", turn.body.status, ((turn.body.log as string[] | undefined) ?? []).filter((l) => /tomas/.test(l) && /street|bought/.test(l)).join("; ") || "(no Tomas sales this turn)");
await sleep(4000);
const rinAfter = await owedUnits(rin.accountId, "tomas");
console.log(`  rin (long-term holder) owed at Tomas: ${Number(rinBefore) / 720720e18} -> ${Number(rinAfter) / 720720e18} c, accrued at the sales`);
const sam0 = (await settled(sam.accountId)).coin;
const snipeBuy = await relayCall(sam, "buy", { seller: tomas, token_id: "share:tomas", qty: "15", max_price: "10" });
assert.equal(snipeBuy.status, 200, JSON.stringify(snipeBuy.body));
const snipeSettle = await call("settle", {});
console.log("  sam bought 15 Tomas shares, then settlement:", snipeSettle.body.status, tx(snipeBuy.body.txHash));
const snipeSell = await relayCall(sam, "sell", { buyer: tomas, token_id: "share:tomas", qty: "15", min_price: "8" });
assert.equal(snipeSell.status, 200, JSON.stringify(snipeSell.body));
const sam1 = (await settled(sam.accountId)).coin;
assert.equal(sam1 - sam0, -10 + 8, "the sniper paid the spread and earned no dividend from sales made before buying");
console.log(`  sam sold right after: coin ${sam0} -> ${sam1} (spread only, no dividend)`, tx(snipeSell.body.txHash));
await audit("sniping check");

// 7. A stored account from before a market reset re-registers (idempotent) and a foreign one is refused.
const again = await call("register", { accountId: kavi.accountId });
assert.equal(again.status, 200, JSON.stringify(again.body));
const foreign = await call("register", { accountId: "someone-else.testnet" });
assert.equal(foreign.status, 400);
console.log("re-register: existing account ok, foreign account refused:", foreign.body.message);

// 8. A forbidden method is refused by the relayer before it reaches NEAR.
const { signedDelegate } = await kavi.createSignedMetaTransaction({ receiverId: cfg.contractId, actions: [actions.functionCall("register_player", { account_id: kavi.accountId }, teraToGas("30"), 0n)], blockHeightTtl: 120 });
const forbidden = await call("relay", { signedDelegate: Buffer.from(encodeSignedDelegate(signedDelegate)).toString("base64") });
assert.equal(forbidden.status, 403);
console.log("forbidden method refused:", forbidden.body.message);

const receipts = await view<{ kind: string; token_id: string; qty: string; price: string }[]>("get_receipts", { account_id: kavi.accountId });
console.log("receipts on chain:", receipts.map((r) => `${r.kind} ${r.qty} ${r.token_id} @${r.price}`).join(", "));
console.log("E2E OK");
