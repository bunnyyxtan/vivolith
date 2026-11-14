// Independent check of VIVOLITH on NEAR testnet, straight from public RPC (no keys, no dependencies, Node 18+):
// the deployed contract's code hash, its merchants and live order book, token supply, and a list of real
// transactions with their status and the NEP-245 events they emitted.
//   node scripts/near/verify.mjs [contract-id]   (archival RPC by default: older transactions are pruned from regular nodes)
const CONTRACT = process.argv[2] ?? "market.bunnyy-nearworld.testnet";
const RPC = process.env.NEAR_RPC_URL ?? "https://archival-rpc.testnet.fastnear.com";
const EXPLORER = "https://testnet.nearblocks.io/txns/";

/** Real transactions from the running game: [what it shows, tx hash, signer]. */
const TXS = [
  ["guest account created for a new player (function-call key only)", "7FmsiLPFyiu3EXodmvpFiujfwWC8oR8H45W3Z2eRe6PE", "bunnyy-nearworld.testnet"],
  ["player registered: 25 starter coins minted", "2Pvc9K9LFynbCcrfNGdjo1wRuQK1nroH4UszBrA3wtBx", "bunnyy-nearworld.testnet"],
  ["player buys 3 mangoes at Tomas's posted price (meta-transaction, relayer pays gas)", "CaA3WN7WEWcj7jZNUjgrND4CvBgpE1HktTuxZenZXXyY", "bunnyy-nearworld.testnet"],
  ["player sells 3 mangoes to Pema at a price Pema signed (ed25519 checked on chain)", "7reZrbXQiur9NqbSQrWgK2s1nZK8ALDp7jAmuktzgbBQ", "bunnyy-nearworld.testnet"],
  ["player invests in 30 Pema shares: 8 c to the reserve, 2 c to the till", "eyF1JCdxanLkzSxX5EHpsiwmmfifySToLEz64K1mqyS", "bunnyy-nearworld.testnet"],
  ["player sells 15 shares back for exactly the 4 c backing", "HzKujJMXrtZuxEYuFXu2bwg2z37GqWCfvFZBmo4iw7w", "bunnyy-nearworld.testnet"],
  ["dividends settled for all four stalls (accumulator, no holder list)", "7g4zoX9scGAeicNkdR9c6Q8zwE2TViQgQi7pXqbQWqGQ", "bunnyy-nearworld.testnet"],
  ["owed dividend claimed: 1 c paid, 0.35 c carried", "J3qmH7oTxvd3Ni35XvgJJpufcNjaK5Zki8LraEYmFZqc", "bunnyy-nearworld.testnet"],
  // 2026-11-14, production vivolith.world, one new player after the recovery fixes (README "One decision, traced on chain")
  ["guest account created for a new player, holding only a trading key", "3tRuy2fWwy7jLANd8LMCDpXrELzpymCfB5P73WBghJaD", "bunnyy-nearworld.testnet"],
  ["the player buys 3 mangoes from Tomas at 4 c", "FS54fN889VDpyUSqDrTLUxo7dRSY9DiACa3BX9vqJ4Vh", "bunnyy-nearworld.testnet"],
  ["the Market Guild advances closed, broke Pema 5 c: one mango's bid", "G1ARMXdujweiFcCjmAbCgEU7Vr2SRievrfYPnxZnKLoP", "bunnyy-nearworld.testnet"],
  ["the player sells Pema 1 mango for 5 c: her stall reopens", "HEwAwEi8vsfGLkBeGkTTqa5FMrANBCk11AL1D3aXvLki", "bunnyy-nearworld.testnet"],
  ["harbor contract lands 14 mangoes at closed Tomas (28 c freight): his stall reopens", "2BjftdZegMUXMwwh4wxFh7J8M3RE6dJXkJkw1LzzXRJF", "bunnyy-nearworld.testnet"],
  ["NEAR AI (Jev) lowers Arin's mango bid 6 -> 5 c, posted with Arin's own key", "CznTaWJhctgxL7RSMYubwUMyU5vGJBJUb62uaZEXuFBa", "arin.bunnyy-nearworld.testnet"],
  ["resident Lin buys a lassi from Arin, the meal NEAR AI chose for her", "CqWCNMNaYgqE3mpj2bRxDEPfhUTmkCRuhZZduSy1ynsE", "picker.bunnyy-nearworld.testnet"],
];

async function rpc(method, params, attempt = 0) {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json().catch(() => ({ error: { message: `HTTP ${r.status}` } }));
  const msg = j.error && String(j.error.cause?.name ?? j.error.message ?? j.error);
  // the free public archival RPC rate-limits bursts: wait and try again (2, 4, 6, 8 s) before giving up
  if (msg && /rate limit|HTTP 429/i.test(msg) && attempt < 4) {
    await new Promise((ok) => setTimeout(ok, 2000 * (attempt + 1)));
    return rpc(method, params, attempt + 1);
  }
  if (msg) throw new Error(`${method}: ${msg}`);
  return j.result;
}
const view = async (method, args = {}) => {
  const r = await rpc("query", { request_type: "call_function", finality: "final", account_id: CONTRACT, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") });
  return JSON.parse(Buffer.from(r.result).toString());
};

const acct = await rpc("query", { request_type: "view_account", finality: "final", account_id: CONTRACT });
console.log(`Contract ${CONTRACT}\n  code hash ${acct.code_hash}  storage ${acct.storage_usage} B`);

const merchants = await view("get_merchants");
console.log(`\nMerchants (${merchants.length}), each its own NEAR account:`);
for (const m of merchants) console.log(`  ${m.id.padEnd(6)} ${m.account_id}  ${m.rule}`);

const audit = await view("audit");
console.log(`\nAudit (computed by the contract from live state): ${audit.ok ? "OK" : "FAILED"}`);
console.log(`  custody: contract holds ${audit.contract_coin} c = reserves + vaults ${audit.reserves_and_vaults} c (${audit.custody_ok ? "ok" : "MISMATCH"})`);
console.log(`  guild ${audit.guild}: ${audit.guild_coin} c held, ${audit.guild_lent} c lent`);
for (const s of audit.stalls) console.log(`  ${s.merchant.padEnd(6)} reserve ${s.reserve} c (needs ${s.reserve_required}) ${s.reserve_ok ? "ok" : "MISMATCH"} · vault ${s.vault} c ${s.vault_ok ? "ok" : "MISMATCH"} · ${s.share_supply} shares`);
const stalls = await view("get_stalls");
console.log("\nStalls:");
for (const s of stalls) {
  console.log(`  ${s.merchant.padEnd(6)} ${s.open ? "open  " : "CLOSED"} holders ${s.holders} · treasury ${s.treasury}/${s.supply} · pack ${s.pack_price} c (backing ${s.pack_backing}) · arrears ${s.arrears} · guild debt ${s.debt} · dividends declared ${s.total_declared} / funded ${s.total_funded} / paid ${s.total_paid}`);
  const recent = (await view("get_settlements", { merchant: s.merchant })).slice(-3);
  if (recent.length) console.log(`         last settlements: ${recent.map((r) => `day ${r.day}: revenue ${r.revenue}, declared ${r.declared}, funded ${r.funded}`).join("; ")}`);
}
if (!audit.ok) process.exitCode = 1;

const offers = await view("get_offers");
console.log(`\nLive order book (${offers.length} offers):`);
for (const o of offers) console.log(`  ${o.merchant.padEnd(6)} ${o.side} ${o.qty.padStart(3)} ${o.token_id.padEnd(12)} @ ${o.price} c`);

const tokens = ["coin", "mango", "lemon", "lassi", ...merchants.map((m) => `share:${m.id}`)];
const supply = await view("mt_batch_supply", { token_ids: tokens });
console.log(`\nNEP-245 supply: ${tokens.map((t, i) => `${t}=${supply[i] ?? 0}`).join("  ")}`);

console.log("\nTransactions:");
let failed = 0;
for (const [what, hash, signer] of TXS) {
  try {
    const tx = await rpc("EXPERIMENTAL_tx_status", { tx_hash: hash, sender_account_id: signer, wait_until: "NONE" });
    const ok = "SuccessValue" in (tx.status ?? {});
    const events = tx.receipts_outcome.flatMap((r) => r.outcome.logs).filter((l) => l.startsWith("EVENT_JSON:"))
      .map((l) => JSON.parse(l.slice(11))).filter((e) => e.standard === "nep245");
    const summary = events.slice(0, 3).map((e) => { const d = e.data[0]; return `${e.event} ${d.amounts?.[0]} ${d.token_ids?.[0]}${d.memo ? ` (${d.memo})` : ""}`; });
    if (!ok) failed++;
    console.log(`  ${ok ? "OK  " : "FAIL"} ${what}\n       ${EXPLORER}${hash}${summary.length ? `\n       events: ${summary.join("; ")}${events.length > 3 ? ` +${events.length - 3} more` : ""}` : ""}`);
  } catch (e) {
    failed++;
    console.log(`  ??   ${what}: ${e.message}`);
  }
}
if (failed) { console.log(`\n${failed} transaction(s) could not be confirmed`); process.exit(1); }
