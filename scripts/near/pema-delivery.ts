// One authorized recovery delivery through production's own routes (vivolith.world): a new guest, the orchard pick, and
// exactly 1 mango sold to Pema at her 1 c reopen bid. Stops if the state differs from the preflight.
//   node scripts/near/pema-delivery.ts          read-only check
//   node scripts/near/pema-delivery.ts --yes    guest (2 tx) + pick (1 tx) + deal (1 tx)
// Reads the chain over public RPC; needs no secrets (the relayer signs on the server). The guest key lives only in this
// process and is never written or printed.
import fs from "node:fs";
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, actions, encodeSignedDelegate, teraToGas } from "near-api-js";

const BASE = "https://vivolith.world", CONTRACT = "market.bunnyy-nearworld.testnet", PEMA = "pema.bunnyy-nearworld.testnet";
const yes = process.argv.includes("--yes");
const provider = new JsonRpcProvider({ url: "https://rpc.testnet.fastnear.com" });
const report: Record<string, unknown> = { at: new Date().toISOString() };
const save = (): void => fs.writeFileSync("docs/evidence/phase2-pema-delivery.json", JSON.stringify(report, null, 1));
const stop = (why: string): never => { report.stopped = why; if (yes) save(); console.error(`STOP: ${why}`); process.exit(2); throw new Error(why); };
const view = async <T>(method: string, args: Record<string, unknown> = {}): Promise<T> => (await provider.callFunction({ contractId: CONTRACT, method, args } as never)) as unknown as T;
const balances = async (id: string): Promise<Record<string, number>> => Object.fromEntries((await view<[string, string][]>("get_balances", { account_id: id })).map(([t, v]) => [t, Number(v)]));
type Stall = { merchant: string; open: boolean; need: string; delivered: string; debt: string; last_rent: number | null };
const stall = async (): Promise<Stall> => (await view<Stall[]>("get_stalls")).find((s) => s.merchant === "pema")!;
const post = async (route: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> => {
  const r = await fetch(`${BASE}/api/near/${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
};
const settle = async (id: string, want: (b: Record<string, number>) => boolean): Promise<Record<string, number>> => {
  for (let i = 0; i < 15; i++) { const b = await balances(id); if (want(b)) return b; await new Promise((r) => setTimeout(r, 2000)); }
  return balances(id);
};

// ---- re-check (read-only): exactly the preflight's state ----
const s0 = await stall(), p0 = await balances(PEMA);
report.before = { stall: s0, pema: p0 };
console.log("before:", JSON.stringify(report.before));
if (s0.open) stop("Pema is already open: the delivery is not needed");
if (Number(s0.need) - Number(s0.delivered) !== 1) stop(`Pema needs ${Number(s0.need) - Number(s0.delivered)} mangoes, not 1`);
if ((p0.coin ?? 0) !== 1) stop(`Pema's till is ${p0.coin ?? 0} c, not 1 c`);
if (!yes) { console.log("CHECK ONLY: nothing sent. Re-run with --yes."); process.exit(0); }

// ---- 1-2. guest account (created and registered by the relayer) ----
const key = KeyPair.fromRandom("ed25519");
const g = await post("guest", { publicKey: key.getPublicKey().toString() });
if (g.status !== 200 || g.body.status !== "onchain") stop(`guest: ${JSON.stringify(g.body)}`);
const player = String(g.body.accountId);
report.guest = { account: player, txHashes: g.body.txHashes };
console.log("guest:", JSON.stringify(report.guest));
await settle(player, (b) => (b.coin ?? 0) > 0);

// ---- 3. orchard pick ----
const pick = await post("pick", { account: player });
if (pick.status !== 200 || pick.body.status !== "onchain") stop(`pick: ${JSON.stringify(pick.body)}`);
const afterPick = await settle(player, (b) => (b.mango ?? 0) >= 1);
report.pick = { txHash: pick.body.txHash, qty: pick.body.qty, guest: afterPick };
console.log("pick:", JSON.stringify(report.pick));
save();

// ---- 4. the one sale: re-check Pema, have her sign exactly 1 mango at 1 c, settle it ----
const s1 = await stall(), p1 = await balances(PEMA);
if (s1.open || (p1.coin ?? 0) !== 1) stop(`Pema changed before the sale: ${JSON.stringify({ s1, p1 })}`);
const deal = await post("deal", { merchant: "pema", side: "sell", token: "mango", qty: 1, unit: 1, ref: 0, tactics: [], rep: 0, player });
if (deal.status !== 200) stop(`deal refused: ${JSON.stringify(deal.body)}`);
const args = deal.body.args as Record<string, string>;
if (args.merchant !== "pema" || args.side !== "sell" || args.token_id !== "mango" || args.qty !== "1" || args.unit_price !== "1") stop(`signed deal is not 1 mango at 1 c: ${JSON.stringify(args)}`);
const me = new Account(player, provider, new KeyPairSigner(key));
let relayed: { status: number; body: Record<string, unknown> } | null = null;
for (let i = 0; i < 6 && !relayed; i++) {
  try {
    const { signedDelegate } = await me.createSignedMetaTransaction({ receiverId: CONTRACT, actions: [actions.functionCall("deal", args, teraToGas("50"), 0n)], blockHeightTtl: 120 } as never);
    relayed = await post("relay", { signedDelegate: Buffer.from(encodeSignedDelegate(signedDelegate)).toString("base64") });
  } catch { await new Promise((r) => setTimeout(r, 1500)); } // a fresh access key can take a block or two to appear
}
if (!relayed) stop("could not build the signed delegate");
report.sale = { http: relayed!.status, ...relayed!.body };
console.log("sale:", JSON.stringify(report.sale));
save();
if (relayed!.status !== 200 || relayed!.body.status !== "onchain") stop("the sale did not land");

// ---- verify on chain ----
const pAfter = await settle(PEMA, (b) => (b.mango ?? 0) === (p1.mango ?? 0) + 1);
const sAfter = await stall(), gAfter = await balances(player);
const tx = await provider.viewTransactionStatus({ txHash: String(relayed!.body.txHash), accountId: player, waitUntil: "FINAL" } as never).catch(() => null) as { status?: Record<string, unknown> } | null;
const chron = (await (await fetch(`${BASE}/api/near/chronicle`)).json()) as { events?: { text: string; status: string; txHash: string | null; kind: string }[] };
report.after = {
  pema: pAfter, stall: sAfter, guest: gAfter,
  txStatus: tx?.status && "SuccessValue" in tx.status ? "SuccessValue" : tx?.status ?? "unknown",
  explorer: `https://testnet.nearblocks.io/txns/${String(relayed!.body.txHash)}`,
  chronicle: (chron.events ?? []).filter((e) => e.txHash === relayed!.body.txHash),
};
console.log("after:", JSON.stringify(report.after, null, 1));
save();
