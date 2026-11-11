// WP0 feasibility: one resident earns and spends on NEAR testnet with the existing contract (no contract change).
//   node scripts/near/resident-check.ts            dry run: views only, prints the plan, sends nothing
//   node scripts/near/resident-check.ts --run      the loop: mint (orchard picking) -> sell -> buy lassi -> eaten
//   node scripts/near/resident-check.ts --ticks    duplicate-tick checks (runs real market turns)
//   add --live to send market turns to the deployed relayer (its persistent limiter) instead of the local handler
// The resident is `picker.<relayer>`: created once, reused afterwards. It signs with a function-call key limited
// to the market contract's `buy` and `sell`, derived from NEAR_MERCHANT_SECRET. Nothing secret is printed.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { Account, JsonRpcProvider, KeyPairSigner, actions, nearToYocto, teraToGas } from "near-api-js";
import { MARKET_DAY_MS, handle, readConfig, type RelayEnv } from "../../server/near/handlers.ts";
import { keyPairFromSeed } from "../../server/near/keys.ts";

const RUN = process.argv.includes("--run");
const TICKS = process.argv.includes("--ticks");
const RESIDENT = "picker";
const RESIDENT_METHODS = ["buy", "sell"];
const RESIDENT_FUNDING = "0.1"; // NEAR for the resident's own gas
const PICKED = 6; // mangoes a day's picking yields
const GAS = teraToGas("50");

const env: RelayEnv = Object.fromEntries(
  fs.readFileSync(".env.local", "utf8").split(/\r?\n/).filter((l) => /^NEAR_[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
);
const cfg = readConfig(env);
const provider = new JsonRpcProvider({ url: cfg.rpcUrl });
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const tx = (h: string): string => `https://testnet.nearblocks.io/txns/${h}`;

interface Offer { merchant: string; account_id: string; token_id: string; side: string; qty: string; price: string }
interface Stall { merchant: string; open: boolean; last_settled: number | null; last_rent: number | null }
interface Sent { txHash: string; ok: boolean; error?: string }

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
    if (next === prev) break;
    prev = next;
  }
  return JSON.parse(prev) as Record<string, number>;
}
const exists = (accountId: string): Promise<boolean> => provider.viewAccount({ accountId, finality: "final" }).then(() => true, () => false);

/** ok only if the transaction and every receipt succeeded (same rule as the relayer's `outcome`). */
function sent(r: unknown): Sent {
  const o = r as { transaction?: { hash?: string }; status?: unknown; receipts_outcome?: { outcome: { status: unknown } }[] };
  const failure = [o.status, ...(o.receipts_outcome ?? []).map((x) => x.outcome.status)].find((s) => typeof s === "object" && s !== null && "Failure" in s);
  return { txHash: o.transaction?.hash ?? "", ok: !failure, error: failure ? JSON.stringify(failure).slice(0, 200) : undefined };
}
async function send(who: Account, method: string, args: Record<string, unknown>): Promise<Sent> {
  for (let i = 0; ; i++) {
    try {
      return sent(await who.signAndSendTransaction({ receiverId: cfg.contractId, actions: [actions.functionCall(method, args, GAS, 0n)], throwOnFailure: false }));
    } catch (e) {
      if (i >= 4) throw e; // a just-created access key can take a block or two to become visible
      await sleep(1500);
    }
  }
}
/** --live: market turns go to the deployed relayer (its persistent rate limiter); otherwise the local handler. */
const LIVE_TICK = process.argv.includes("--live") ? "https://vivolith.vercel.app/api/near/tick" : null;
async function tick(): Promise<{ status: string; log: string[]; txHashes: string[] }> {
  const res = LIVE_TICK
    ? await fetch(LIVE_TICK, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
    : await handle("tick", new Request("http://localhost/api/near/tick", { method: "POST", body: "{}" }), env);
  const b = (await res.json()) as { status: string; log?: string[]; txHashes?: string[] };
  return { status: b.status, log: b.log ?? [], txHashes: b.txHashes ?? [] };
}
const offers = (): Promise<Offer[]> => view<Offer[]>("get_offers");
const bestBid = (all: Offer[], token: string): Offer | undefined =>
  all.filter((o) => o.side === "bid" && o.token_id === token && Number(o.qty) > 0).sort((a, b) => Number(b.price) - Number(a.price))[0];
const askOf = (all: Offer[], merchant: string, token: string): Offer | undefined =>
  all.find((o) => o.side === "ask" && o.merchant === merchant && o.token_id === token && Number(o.qty) > 0);
const fmt = (b: Record<string, number>): string => `coin ${b.coin ?? 0}, mango ${b.mango ?? 0}, lassi ${b.lassi ?? 0}`;

const secret = (env.NEAR_MERCHANT_SECRET ?? "").trim();
assert.ok(cfg.relayerId.endsWith(".testnet") && cfg.relayerKey && secret.length >= 32, "relayer id, relayer key and NEAR_MERCHANT_SECRET must be configured (testnet only)");
const residentId = `${RESIDENT}.${cfg.relayerId}`;
const residentKey = keyPairFromSeed(createHash("sha256").update(`vivolith-resident:${RESIDENT}:${secret}`).digest());
const relayer = new Account(cfg.relayerId, provider, cfg.relayerKey!);
const resident = new Account(residentId, provider, new KeyPairSigner(residentKey));

console.log(`contract ${cfg.contractId} | relayer ${cfg.relayerId} | resident ${residentId} | local rate limiter: ${cfg.redisUrl ? "persistent" : "memory"}`);
const there = await exists(residentId);
const registered = there && (await view<boolean>("is_registered", { account_id: residentId }));
const open = await offers();
console.log(`resident account exists: ${there}, registered: ${registered}${there ? `, holds ${fmt(await balances(residentId))}` : ""}`);
console.log(`best mango bid: ${JSON.stringify(bestBid(open, "mango") ?? null)}`);
console.log(`arin lassi ask: ${JSON.stringify(askOf(open, "arin", "lassi") ?? null)}`);

if (!RUN && !TICKS) {
  console.log(`DRY RUN, nothing sent. --run would: ${there ? "" : `create ${residentId} (${RESIDENT_FUNDING} NEAR, function-call key for ${RESIDENT_METHODS.join("/")}); `}${registered ? "" : "register it (40 c starter purse, once); "}mint up to ${PICKED} mango to it; sell them into the best bid; buy 1 lassi from arin; burn that lassi as eaten.`);
}

if (RUN) {
  const hashes: Record<string, string> = {};
  // 1. Create or reuse the restricted account (owner full-access key for recovery, as for the merchants).
  if (!there) {
    const ownerPub = await relayer.getSigner()!.getPublicKey();
    const r = sent(await relayer.signAndSendTransaction({
      receiverId: residentId,
      actions: [actions.createAccount(), actions.transfer(nearToYocto(RESIDENT_FUNDING)), actions.addFullAccessKey(ownerPub), actions.addFunctionCallAccessKey(residentKey.getPublicKey(), cfg.contractId, RESIDENT_METHODS)],
      throwOnFailure: false,
    }));
    assert.ok(r.ok, `create failed: ${r.error}`);
    hashes.create = r.txHash;
  }
  const keys = (await resident.getAccessKeyList()).keys;
  const mine = keys.find((k) => String(k.public_key) === residentKey.getPublicKey().toString());
  const perm = mine?.access_key.permission;
  if (!perm || typeof perm !== "object" || !("FunctionCall" in perm)) throw new Error("resident signing key must be a function-call key");
  const fc = perm.FunctionCall;
  assert.equal(fc.receiver_id, cfg.contractId);
  assert.deepEqual([...fc.method_names].sort(), [...RESIDENT_METHODS].sort());
  console.log(`resident signing key: function-call only, receiver ${fc.receiver_id}, methods ${fc.method_names.join(",")}`);
  if (!registered) {
    const r = sent(await relayer.callFunctionRaw({ contractId: cfg.contractId, methodName: "register_player", args: { account_id: residentId }, gas: GAS }));
    assert.ok(r.ok, `register failed: ${r.error}`);
    hashes.register = r.txHash;
  }

  // 2. Orders must be posted; one market turn posts them if the book is empty.
  let book = await offers();
  if (!bestBid(book, "mango") || !askOf(book, "arin", "lassi")) {
    const t = await tick();
    console.log(`market turn to post orders: ${t.status}`);
    await sleep(4000);
    book = await offers();
  }
  const bid = bestBid(book, "mango");
  if (!bid) throw new Error("no merchant is bidding for mangoes");
  const n = Math.min(PICKED, Number(bid.qty));
  const before = { resident: await settled(residentId), buyer: await settled(bid.account_id), arin: await settled(`arin.${cfg.relayerId}`) };

  // 3. Production: the operator mints the day's picking to the resident (goods only; coin is never minted here).
  const mint = sent(await relayer.callFunctionRaw({ contractId: cfg.contractId, methodName: "operator_mint", args: { account_id: residentId, token_id: "mango", amount: String(n), reason: "orchard picking" }, gas: GAS }));
  assert.ok(mint.ok, `mint failed: ${mint.error}`);
  hashes.mint = mint.txHash;

  // 4. The resident sells into the merchant's standing bid, signed with its own restricted key.
  const sale = await send(resident, "sell", { buyer: bid.account_id, token_id: "mango", qty: String(n), min_price: bid.price });
  assert.ok(sale.ok, `sell failed: ${sale.error}`);
  hashes.sell = sale.txHash;
  const earned = n * Number(bid.price);

  // 5. The resident buys one lassi from Arin. His kitchen turns mangoes into lassi during a market turn and posts
  // the ask on the next one (turns are throttled to one a minute), so wait up to three turns for it.
  let ask = askOf(await offers(), "arin", "lassi");
  for (let i = 0; !ask && i < 3; i++) {
    const t = await tick();
    console.log(`market turn for lassi: ${t.status}; ${t.log.filter((l) => /arin/.test(l)).join("; ") || "no arin lines"}`);
    await sleep(t.status === "skipped" ? 62000 : 5000);
    ask = askOf(await offers(), "arin", "lassi");
  }
  if (!ask) throw new Error("Arin has no lassi on offer after three market turns");
  const price = Number(ask.price);
  const buy = await send(resident, "buy", { seller: ask.account_id, token_id: "lassi", qty: "1", max_price: ask.price });
  assert.ok(buy.ok, `buy failed: ${buy.error}`);
  hashes.buy = buy.txHash;

  // 6. Consumption: the lassi leaves the economy.
  const eat = sent(await relayer.callFunctionRaw({ contractId: cfg.contractId, methodName: "operator_burn", args: { account_id: residentId, token_id: "lassi", amount: "1", reason: "eaten" }, gas: GAS }));
  assert.ok(eat.ok, `burn failed: ${eat.error}`);
  hashes.eaten = eat.txHash;

  // 7. A method outside the key's list must be refused before it reaches the contract.
  const refused = await resident.signAndSendTransaction({ receiverId: cfg.contractId, actions: [actions.functionCall("list", { token_id: "mango", qty: "1", price: "1" }, GAS, 0n)], throwOnFailure: false }).then((r) => !sent(r).ok, () => true);
  assert.ok(refused, "a method outside buy/sell must be refused");

  const after = { resident: await settled(residentId), buyer: await settled(bid.account_id), arin: await settled(`arin.${cfg.relayerId}`) };
  const d = (a: Record<string, number>, b: Record<string, number>, t: string): number => (b[t] ?? 0) - (a[t] ?? 0);
  // Only this script touches the resident, so its balances are exact.
  assert.equal(d(before.resident, after.resident, "coin"), earned - price, "resident coin = earnings - lassi price");
  assert.equal(d(before.resident, after.resident, "mango"), 0, "every picked mango was sold");
  assert.equal(d(before.resident, after.resident, "lassi"), 0, "the lassi was eaten");
  const receipts = await view<{ kind: string; token_id: string; qty: string; price: string }[]>("get_receipts", { account_id: residentId });
  assert.ok(receipts.some((r) => r.kind === "sold" && r.token_id === "mango" && Number(r.qty) === n && Number(r.price) === Number(bid.price)), "sale receipt on chain");
  assert.ok(receipts.some((r) => r.kind === "bought" && r.token_id === "lassi" && Number(r.price) === price), "purchase receipt on chain");
  // Merchants also trade with live players and market turns, so their deltas are reported and compared, not asserted.
  const buyerOk = d(before.buyer, after.buyer, "coin") === -earned && d(before.buyer, after.buyer, "mango") === n;
  const arinOk = d(before.arin, after.arin, "coin") === price && d(before.arin, after.arin, "lassi") === -1;
  const a = await view<{ ok: boolean }>("audit");
  assert.equal(a.ok, true, "contract audit");

  console.log(`\nresident ${residentId}\n  before: ${fmt(before.resident)}\n  after:  ${fmt(after.resident)}   (earned ${earned} c for ${n} mango at ${bid.price} c, paid ${price} c for 1 lassi)`);
  console.log(`buyer ${bid.account_id}\n  before: ${fmt(before.buyer)}\n  after:  ${fmt(after.buyer)}   ${buyerOk ? "matches exactly" : "differs from this loop alone (other market activity in between)"}`);
  console.log(`arin\n  before: ${fmt(before.arin)}\n  after:  ${fmt(after.arin)}   ${arinOk ? "matches exactly" : "differs from this loop alone (other market activity in between)"}`);
  console.log(`lassi paid from earnings alone: ${earned >= price} (earned ${earned} c, price ${price} c; the resident also holds its 40 c starter purse)`);
  for (const [k, h] of Object.entries(hashes)) console.log(`  ${k}: ${tx(h)}`);
  console.log("refused: a `list` call signed with the resident key (method not on the key)");
  console.log("audit ok. RESIDENT LOOP OK");
}

if (TICKS) {
  const stalls = (): Promise<Stall[]> => view<Stall[]>("get_stalls");
  const sales = (log: string[]): number => log.filter((l) => /street shoppers bought/.test(l)).length;
  const dayNow = (): number => Math.floor(Date.now() / MARKET_DAY_MS);
  // Stay clear of the limiter's minute boundary and of a market-day rollover for the first pair.
  const intoMinute = Date.now() % 60000;
  if (intoMinute > 20000) await sleep(60000 - intoMinute + 1500);
  const day0 = dayNow();
  // a. Two turns at the same instant: exactly one may run.
  const [a, b] = await Promise.all([tick(), tick()]);
  console.log(`\nconcurrent turns: ${a.status} / ${b.status}; street-sale lines ${sales(a.log)} / ${sales(b.log)}`);
  assert.deepEqual([a.status, b.status].sort(), ["onchain", "skipped"], "exactly one of two concurrent turns runs");
  for (const h of [...a.txHashes, ...b.txHashes].filter(Boolean)) console.log(`  ${tx(h)}`);
  await sleep(5000);
  const s1 = await stalls();
  // b. A second turn more than 60 s later.
  await sleep(62000);
  const c = await tick();
  await sleep(5000);
  const s2 = await stalls();
  const sameDay = dayNow() === day0;
  console.log(`turn 62 s later: ${c.status}; same market day: ${sameDay}; street-sale lines ${sales(c.log)}; rent lines ${c.log.filter((l) => /rent/.test(l)).length}; dividend lines ${c.log.filter((l) => /dividends/.test(l)).length}`);
  for (const h of c.txHashes.filter(Boolean)) console.log(`  ${tx(h)}`);
  if (sameDay) {
    assert.deepEqual(s2.map((s) => [s.merchant, s.last_rent, s.last_settled]), s1.map((s) => [s.merchant, s.last_rent, s.last_settled]), "rent and settlement ran at most once this market day");
    console.log("rent and settlement records unchanged by the second turn (once per market day, enforced in the contract)");
  } else {
    console.log("the market day rolled over between the two turns: rent/settlement comparison skipped, rerun to check it");
  }
  console.log("TICK CHECK DONE");
}
