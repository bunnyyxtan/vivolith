// Reads the market contract's raw state (NEAR `view_state`) and decodes every token balance, so an upgrade can
// be checked key by key: `node scripts/near/ledger.mjs [contract] > before.json`. Read-only; no keys needed.
// Balances are stored by near-sdk's LookupMap under prefix "b" with a borsh key (String token, AccountId owner)
// and a borsh u128 value.
const RPC = process.env.NEAR_RPC_URL ?? "https://rpc.testnet.fastnear.com";

async function rpc(method, params) {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error).slice(0, 300)}`);
  return j.result;
}

const str = (buf, at) => { const n = buf.readUInt32LE(at); return [buf.subarray(at + 4, at + 4 + n).toString("utf8"), at + 4 + n]; };
const u128 = (buf) => (buf.readBigUInt64LE(8) << 64n) + buf.readBigUInt64LE(0);

/** { block, balances: { "token|owner": "amount" } } for every stored balance. */
export async function ledger(contract) {
  const r = await rpc("query", { request_type: "view_state", finality: "final", account_id: contract, prefix_base64: Buffer.from("b").toString("base64") });
  const balances = {};
  for (const { key, value } of r.values) {
    const k = Buffer.from(key, "base64"), v = Buffer.from(value, "base64");
    if (k[0] !== 0x62 || v.length !== 16) continue;
    const [token, at] = str(k, 1);
    const [owner] = str(k, at);
    balances[`${token}|${owner}`] = u128(v).toString();
  }
  return { block: r.block_height, balances };
}

if (process.argv[1]?.endsWith("ledger.mjs")) {
  console.log(JSON.stringify(await ledger(process.argv[2] ?? "market.bunnyy-nearworld.testnet"), null, 1));
}
