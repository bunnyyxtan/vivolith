// Browser side of VIVOLITH on NEAR testnet. No wallet popups: on first play the browser makes an ed25519 key
// (kept in localStorage), the relayer creates a guest account whose only key is a function-call key limited to
// the game contract's player methods, and every move is a meta-transaction the relayer pays gas for.
// A move counts as "onchain" only when the relayer returns a tx hash whose outcome succeeded.
// Social/email login (NEAR Auth): one Auth0 sign-in; the relayer verifies it and opens an account owned by the
// player's NEAR Auth MPC key, with a game session key for moves, so play continues with no further popups.
import { Auth0Client } from "@auth0/auth0-spa-js";
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, actions, encodeSignedDelegate, teraToGas, type KeyPairString } from "near-api-js";

export const EXPLORER_TX = "https://testnet.nearblocks.io/txns/";
export const EXPLORER_ACCOUNT = "https://testnet.nearblocks.io/address/";
const RPC = "https://rpc.testnet.fastnear.com";
const KEY_STORE = "vivolith.near.key";
const ACCOUNT_STORE = "vivolith.near.account";
const LABEL_STORE = "vivolith.near.label";
const GUEST_KEY_STORE = "vivolith.near.guestKey";
const GUEST_ACCOUNT_STORE = "vivolith.near.guestAccount";


export interface ChainStatus {
  readonly configured: boolean;
  readonly contractId: string;
  readonly relayer: string | null;
  readonly merchants: readonly string[];
  /** Our Auth0 tenant for Google/email sign-in; null until configured (the sign-in button stays hidden). */
  readonly auth: { readonly domain: string; readonly clientId: string } | null;
}

export interface TxOutcome {
  /** unknown: sent, but no final answer came back; the chain is re-read instead of guessing either way. */
  readonly status: "onchain" | "failed" | "local" | "unknown";
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
    status = { configured: false, contractId: "", relayer: null, merchants: [], auth: null };
  }
  return status;
}

export const merchantAccount = (id: string): string => `${id}.${status?.relayer ?? ""}`;
export const playerId = (): string | null => player?.accountId ?? null;
/** True when Google/email sign-in is available (the relayer has our Auth0 tenant configured). */
export const socialAvailable = (): boolean => Boolean(status?.auth);
/** Email or name of a signed-in player; null for guests. */
export const playerLabel = (): string | null => store.get(LABEL_STORE);

let auth: Auth0Client | null = null;
const authClient = (): Auth0Client => {
  if (!status?.auth) throw new Error("sign-in is not available yet");
  return (auth ??= new Auth0Client({ domain: status.auth.domain, clientId: status.auth.clientId, authorizationParams: { redirect_uri: `${location.origin}/`, scope: "openid profile email" } }));
};

/** Social/email sign-in: one Auth0 popup (from a click or key press). If the browser blocks popups, the page
 *  redirects to NEAR Auth instead and finishSocialRedirect() completes it on return. The guest account is parked
 *  and restored on sign-out. */
export async function signInSocial(): Promise<{ accountId: string; label: string; merged: boolean }> {
  try {
    await authClient().loginWithPopup({ authorizationParams: { prompt: "login" } });
  } catch (e) {
    if (!/popup/i.test(e instanceof Error ? e.message : "") || /closed|cancel/i.test(e instanceof Error ? e.message : "")) throw e;
    await authClient().loginWithRedirect({ authorizationParams: { prompt: "login" } }); // leaves the page
    throw new Error("redirecting to sign in");
  }
  return finishSignIn();
}

/** Completes a redirect sign-in when the page loads with Auth0's ?code&state. Returns null if not returning. */
export async function finishSocialRedirect(): Promise<{ accountId: string; label: string; merged: boolean } | null> {
  const q = new URLSearchParams(location.search);
  if (!q.has("code") || !q.has("state")) return null;
  await chainStatus();
  try {
    await authClient().handleRedirectCallback();
  } finally {
    history.replaceState(null, "", location.pathname); // drop the one-time code from the address bar
  }
  return finishSignIn();
}

/** Proof that this browser owns its guest account, bound to this login token, so its progress can move over. */
async function guestProof(idToken: string): Promise<{ accountId: string; publicKey: string; signature: string } | null> {
  const secret = store.get(KEY_STORE), accountId = store.get(ACCOUNT_STORE);
  if (!secret || !accountId || store.get(LABEL_STORE)) return null; // not a guest right now
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(idToken)));
  const hex = Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
  const key = KeyPair.fromString(secret as KeyPairString);
  const { signature } = key.sign(new TextEncoder().encode(`vivolith-link|${accountId}|${hex}`));
  return { accountId, publicKey: key.getPublicKey().toString(), signature: btoa(String.fromCharCode(...signature)) };
}

async function finishSignIn(): Promise<{ accountId: string; label: string; merged: boolean }> {
  const claims = await authClient().getIdTokenClaims();
  if (!claims?.__raw) throw new Error("sign-in was cancelled");
  const r = await post("social", { idToken: claims.__raw, guest: await guestProof(claims.__raw) });
  if (r.status !== "onchain" || typeof r.accountId !== "string" || typeof r.sessionKey !== "string") throw new Error(String(r.message ?? "sign-in failed"));
  if (!store.get(GUEST_KEY_STORE) && store.get(KEY_STORE) && !store.get(LABEL_STORE)) { // park the guest
    store.set(GUEST_KEY_STORE, store.get(KEY_STORE)!);
    store.set(GUEST_ACCOUNT_STORE, store.get(ACCOUNT_STORE) ?? "");
  }
  store.set(KEY_STORE, r.sessionKey);
  store.set(ACCOUNT_STORE, r.accountId);
  store.set(LABEL_STORE, String(r.label ?? ""));
  player = new Account(r.accountId, provider, new KeyPairSigner(KeyPair.fromString(r.sessionKey as KeyPairString)));
  return { accountId: r.accountId, label: String(r.label ?? ""), merged: Boolean(r.merged) };
}

/** Back to the guest account this browser had before signing in (its key never left the browser). */
export async function signOutSocial(): Promise<string | null> {
  const guestKey = store.get(GUEST_KEY_STORE), guestAccount = store.get(GUEST_ACCOUNT_STORE);
  for (const k of [LABEL_STORE, KEY_STORE, ACCOUNT_STORE]) { try { localStorage.removeItem(k); } catch { /* ignore */ } }
  if (guestKey && guestAccount) { store.set(KEY_STORE, guestKey); store.set(ACCOUNT_STORE, guestAccount); }
  player = null;
  return connectGuest();
}

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
  // A stored account may predate a market reset: make sure the current ledger knows it (idempotent on the relayer).
  const known = await view<boolean>("is_registered", { account_id: accountId }).catch(() => true);
  if (!known) {
    const r = await post("register", { accountId });
    if (r.status !== "onchain") return null;
  }
  player = new Account(accountId, provider, new KeyPairSigner(key));
  return accountId;
}

export async function view<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
  const s = await chainStatus();
  return (await provider.callFunction({ contractId: s.contractId, method, args, blockQuery: { finality: "optimistic" } })) as unknown as T;
}

const SEND_TRIES = 4;
const RETRY_MS = 1500;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const errText = (e: unknown, fallback: string): string => (e instanceof Error ? e.message.split("\n")[0].slice(0, 120) : fallback);

/** Player move as a relayed meta-transaction. It is signed once; an attempt with no clear answer resends the same
 *  bytes, which NEAR accepts at most once (the delegate nonce), so a retry can never pay twice. */
async function act(method: "buy" | "sell" | "deal", args: Record<string, unknown>): Promise<TxOutcome> {
  if (!player) return { status: "local", message: "offline: not connected to NEAR" };
  const s = await chainStatus();
  let delegate = "";
  for (let attempt = 0; !delegate; attempt++) {
    try { // signing sends nothing: retrying it is safe (a fresh guest key can take a moment to become visible)
      const { signedDelegate } = await player.createSignedMetaTransaction({ receiverId: s.contractId, actions: [actions.functionCall(method, args, teraToGas("50"), 0n)], blockHeightTtl: 120 });
      delegate = btoa(String.fromCharCode(...encodeSignedDelegate(signedDelegate)));
    } catch (e) {
      if (attempt >= SEND_TRIES - 1) return { status: "failed", message: errText(e, "could not sign") };
      await sleep(RETRY_MS);
    }
  }
  let sent = false; // an earlier attempt may have reached NEAR
  for (let attempt = 0; attempt < SEND_TRIES; attempt++) {
    if (attempt > 0) await sleep(RETRY_MS * attempt);
    let r: Record<string, unknown>;
    try { r = await post("relay", { signedDelegate: delegate }); } catch { sent = true; continue; } // network: resend
    if (r.status === "onchain" && typeof r.txHash === "string") return { status: "onchain", txHash: r.txHash };
    if (r.status === "duplicate") return sent ? { status: "unknown", message: "sent earlier; checking NEAR" } : { status: "failed", message: "already submitted" };
    if (r.status === "unknown" || (Number(r.httpStatus) >= 500 && r.status !== "error")) { sent = true; continue; }
    return { status: "failed", txHash: typeof r.txHash === "string" && r.txHash ? r.txHash : undefined, message: String(r.message ?? "not recorded") };
  }
  return sent ? { status: "unknown", message: "no answer from NEAR; checking your balance" } : { status: "failed", message: "relay unreachable" };
}

/** A haggled deal: the merchant signs the agreed price (server), the player settles it in one tx. */
export async function haggleDeal(merchant: string, side: "buy" | "sell", token: string, qty: number, unit: number): Promise<TxOutcome> {
  const id = playerId();
  if (!id) return { status: "local", message: "offline: not connected to NEAR" };
  let signed: Record<string, unknown> | null = null;
  for (let attempt = 0; attempt < SEND_TRIES && !signed; attempt++) { // the merchant's signature moves nothing yet
    if (attempt > 0) await sleep(RETRY_MS);
    const r = await post("deal", { merchant, side, token, qty, unit, player: id }).catch(() => null);
    if (r && (r.status === "signed" || Number(r.httpStatus) < 500)) signed = r;
  }
  if (!signed || signed.status !== "signed") return { status: "failed", message: String(signed?.message ?? "merchant unreachable") };
  return act("deal", signed.args as Record<string, unknown>);
}

/** Buys from a merchant's posted ask; for stall shares `maxPrice` caps the total cost. */
export const buyPosted = (merchant: string, token: string, qty: number, maxPrice: number): Promise<TxOutcome> =>
  act("buy", { seller: merchantAccount(merchant), token_id: token, qty: String(qty), max_price: String(maxPrice) });

/** Sells into a merchant's standing bid; for stall shares `minPrice` is the least total payout. */
export const sellPosted = (merchant: string, token: string, qty: number, minPrice: number): Promise<TxOutcome> =>
  act("sell", { buyer: merchantAccount(merchant), token_id: token, qty: String(qty), min_price: String(minPrice) });

export async function balances(accountId: string): Promise<Record<string, number>> {
  const rows = await view<[string, string][]>("get_balances", { account_id: accountId });
  return Object.fromEntries(rows.map(([t, v]) => [t, Number(v)]));
}

export const receipts = (accountId: string): Promise<ChainReceipt[]> => view<ChainReceipt[]>("get_receipts", { account_id: accountId });

/** Asks the relayer to run the merchants' autonomous turn and the day's settlement (both throttled server-side). */
export const marketTick = (): Promise<Record<string, unknown>> => post("tick", {}).catch(() => ({ status: "failed" }));
export const settleDay = (): Promise<Record<string, unknown>> => post("settle", {}).catch(() => ({ status: "failed" }));
/** Pays the player every whole coin of dividends they are owed (the relayer checks get_pending first and sends nothing
 *  when nothing is owed). Their own trades claim too. */
export const claimDividends = (accountId: string): Promise<Record<string, unknown>> => post("claim", { account: accountId }).catch(() => ({ status: "failed" }));
