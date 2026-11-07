// Browser side of VIVOLITH on NEAR testnet. No wallet popups: on first play the browser makes an ed25519 key
// (kept in localStorage), the relayer creates a guest account whose only key is a function-call key limited to
// the game contract's player methods, and every move is a meta-transaction the relayer pays gas for.
// A move counts as "onchain" only when the relayer returns a tx hash whose outcome succeeded.
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, actions, encodeSignedDelegate, teraToGas, type KeyPairString } from "near-api-js";

export const EXPLORER_TX = "https://testnet.nearblocks.io/txns/";
export const EXPLORER_ACCOUNT = "https://testnet.nearblocks.io/address/";
const RPC = "https://rpc.testnet.fastnear.com";
const KEY_STORE = "vivolith.near.key";
const ACCOUNT_STORE = "vivolith.near.account";

export interface ChainStatus {
  readonly configured: boolean;
  readonly contractId: string;
  readonly relayer: string | null;
  readonly merchants: readonly string[];
}

export interface TxOutcome {
  readonly status: "onchain" | "failed" | "local";
  readonly txHash?: string;
  readonly message?: string;
}

export interface ChainReceipt {
  readonly kind: string;
  readonly token_id: string;
  readonly qty: string;
  readonly price: string;
  readonly counterparty: string;
  readonly block_height: number;
}

const provider = new JsonRpcProvider({ url: RPC });
let status: ChainStatus | null = null;
let player: Account | null = null;

const store = {
  get: (k: string): string | null => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string): void => { try { localStorage.setItem(k, v); } catch { /* private mode: key lives for this tab only */ } },
};

async function post(route: string, body: unknown): Promise<Record<string, unknown>> {
  const r = await fetch(`/api/near/${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = (await r.json().catch(() => ({ status: "failed", message: `HTTP ${r.status}` }))) as Record<string, unknown>;
  return { ...j, httpStatus: r.status };
}

export async function chainStatus(): Promise<ChainStatus> {
  if (status) return status;
  try {
    const r = await fetch("/api/near/status");
    if (!r.ok) throw new Error(String(r.status));
    status = (await r.json()) as ChainStatus;
  } catch {
    status = { configured: false, contractId: "", relayer: null, merchants: [] };
  }
  return status;
}

export const merchantAccount = (id: string): string => `${id}.${status?.relayer ?? ""}`;
export const playerId = (): string | null => player?.accountId ?? null;

/** Silent guest login. Returns the account id, or null when the relayer is unavailable (game stays local). */
export async function connectGuest(): Promise<string | null> {
  const s = await chainStatus();
  if (!s.configured) return null;
  let secret = store.get(KEY_STORE) as KeyPairString | null;
  if (!secret) {
    secret = KeyPair.fromRandom("ed25519").toString() as KeyPairString;
    store.set(KEY_STORE, secret);
  }
  const key = KeyPair.fromString(secret);
  let accountId = store.get(ACCOUNT_STORE);
  if (!accountId) {
    const r = await post("guest", { publicKey: key.getPublicKey().toString() });
    if (r.status !== "onchain" || typeof r.accountId !== "string") return null;
    accountId = r.accountId;
    store.set(ACCOUNT_STORE, accountId);
  }
  player = new Account(accountId, provider, new KeyPairSigner(key));
  return accountId;
}

export async function view<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
  const s = await chainStatus();
  return (await provider.callFunction({ contractId: s.contractId, method, args, blockQuery: { finality: "optimistic" } })) as unknown as T;
}

/** Player move as a relayed meta-transaction (retries briefly while a fresh key becomes visible). */
async function act(method: "buy" | "sell" | "deal", args: Record<string, unknown>): Promise<TxOutcome> {
  if (!player) return { status: "local", message: "offline: not connected to NEAR" };
  const s = await chainStatus();
  for (let attempt = 0; ; attempt++) {
    try {
      const { signedDelegate } = await player.createSignedMetaTransaction({ receiverId: s.contractId, actions: [actions.functionCall(method, args, teraToGas("50"), 0n)], blockHeightTtl: 120 });
      const bytes = encodeSignedDelegate(signedDelegate);
      const r = await post("relay", { signedDelegate: btoa(String.fromCharCode(...bytes)) });
      if (r.status === "onchain" && typeof r.txHash === "string") return { status: "onchain", txHash: r.txHash };
      return { status: "failed", txHash: typeof r.txHash === "string" && r.txHash ? r.txHash : undefined, message: String(r.message ?? "not recorded") };
    } catch (e) {
      if (attempt >= 3) return { status: "failed", message: e instanceof Error ? e.message.split("\n")[0].slice(0, 120) : "relay unreachable" };
      await new Promise((r) => setTimeout(r, 1200));
    }
  }
}

/** A haggled deal: the merchant signs the agreed price (server), the player settles it in one tx. */
export async function haggleDeal(merchant: string, side: "buy" | "sell", token: string, qty: number, unit: number): Promise<TxOutcome> {
  const id = playerId();
  if (!id) return { status: "local", message: "offline: not connected to NEAR" };
  const signed = await post("deal", { merchant, side, token, qty, unit, player: id }).catch(() => null);
  if (!signed || signed.status !== "signed") return { status: "failed", message: String(signed?.message ?? "merchant unreachable") };
  return act("deal", signed.args as Record<string, unknown>);
}

/** Buys from a merchant's posted ask (used for stall shares). */
export const buyPosted = (merchant: string, token: string, qty: number, maxPrice: number): Promise<TxOutcome> =>
  act("buy", { seller: merchantAccount(merchant), token_id: token, qty: String(qty), max_price: String(maxPrice) });

export async function balances(accountId: string): Promise<Record<string, number>> {
  const rows = await view<[string, string][]>("get_balances", { account_id: accountId });
  return Object.fromEntries(rows.map(([t, v]) => [t, Number(v)]));
}

export const receipts = (accountId: string): Promise<ChainReceipt[]> => view<ChainReceipt[]>("get_receipts", { account_id: accountId });

/** Asks the relayer to run the merchants' autonomous turn and the day's settlement (both throttled server-side). */
export const marketTick = (): Promise<Record<string, unknown>> => post("tick", {}).catch(() => ({ status: "failed" }));
export const settleDay = (): Promise<Record<string, unknown>> => post("settle", {}).catch(() => ({ status: "failed" }));
