// Browser side of VIVOLITH on NEAR testnet. No wallet popups: on first play the browser makes an ed25519 key
// (kept in localStorage), the relayer creates a guest account whose only key is a function-call key limited to
// the game contract's player methods, and every move is a meta-transaction the relayer pays gas for.
// A move counts as "onchain" only when the relayer returns a tx hash whose outcome succeeded.
// Social/email login (NEAR Auth): one Auth0 sign-in; the relayer verifies it and opens an account owned by the
// player's NEAR Auth MPC key, with a game session key for moves, so play continues with no further popups.
import { Auth0Client } from "@auth0/auth0-spa-js";
import type { ChronicleEvent } from "../economy/chronicle";
import { INSPECT_ACCOUNT, READ_ONLY } from "./inspect";
import { relaySigned } from "./moves";
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
  /** Length of one on-chain market day (the relayer's MARKET_DAY_MS). */
  readonly marketDayMs?: number;
  /** Who moves the market: players' browsers (default) or the city's own scheduler (server/near/ops.ts). */
  readonly driver?: "players" | "scheduler";
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
/** The account a read-only inspection shows (no signer); null otherwise. */
let watched: string | null = null;

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
  // ?offline: play with the local economy only (playtests and demos without touching NEAR); the HUD says "Offline"
  const wanted = !new URLSearchParams(location.search).has("offline");
  // a passing network error must not turn a real session into an offline one: three tries before giving up
  for (let attempt = 0; wanted && !status && attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1500 * attempt));
    try {
      const r = await fetch("/api/near/status");
      if (r.ok) status = (await r.json()) as ChainStatus;
      else if (r.status < 500) break; // the server answered: not configured here
    } catch { /* network: try again */ }
  }
  status ??= { configured: false, contractId: "", relayer: null, merchants: [], auth: null };
  return status;
}

/** Picks the morning's mangoes at the orchard (relayer route `pick`): minted on NEAR once per market day. */
export const pickOrchard = (account: string): Promise<Record<string, unknown>> => post("pick", { account }).catch(() => ({ status: "failed" }));

/** A merchant explains its price and day (relayer route `talk`): `ai` only when NEAR AI phrased it. */
/** A merchant's latest bid decision from the server (NEAR AI when it answered, else the rule price). Read-only. */
export interface AgentDecision {
  readonly merchant: string; readonly lever: string; readonly kind: "price" | "plan"; readonly day: number; readonly source: "ai" | "fallback"; readonly model: string | null;
  readonly action: string; readonly basePrice: number; readonly price: number; readonly confidence: number | null;
  readonly receipt: { readonly id: string | null; readonly status: string; readonly note: string };
  readonly justification: readonly string[]; readonly line: string; readonly fallbackReason: string | null;
  readonly txHash: string | null; readonly at: number;
  /** Setting the price right now: confirmed, this market day, and the order is still posted on chain (server `decisions`). */
  readonly live?: boolean;
}
export async function agentDecision(id: string): Promise<AgentDecision | null> {
  try {
    const r = await fetch(`/api/near/decisions?merchant=${encodeURIComponent(id)}`);
    if (!r.ok) return null;
    const j = (await r.json()) as { decisions?: AgentDecision[] };
    return j.decisions?.[0] ?? null;
  } catch { return null; }
}

/** The server-issued conversation id: the server keeps the last few exchanges under it (the client never sends history). */
let conversation: string | null = null;
/** Asks a merchant or resident (Lin `picker`, Dev `porter`) the player's own question (relayer route `talk`). The answer
 *  is grounded in their chain state, decisions and memory; `ai` only when NEAR AI phrased it. `sentences` is the same
 *  line split for a streaming voice. */
export async function askMerchant(id: string, question = ""): Promise<{ line: string; ai: boolean; sentences: string[]; mood: string; speech: string[] } | null> {
  const r = await post("talk", { npc: id, question: question.slice(0, 200), account: playerId() ?? undefined, conv: conversation ?? undefined }).catch(() => null);
  if (r && typeof r.conv === "string") conversation = r.conv;
  if (!r || typeof r.line !== "string") return null;
  // the validated reply's own sentences, exactly: they are what gets voiced, so nothing else can be spoken
  const parts = r.sentences;
  const sentences = Array.isArray(parts) && parts.every((s) => typeof s === "string") && (parts as string[]).join(" ") === r.line ? (parts as string[]) : [r.line];
  // one speech token per sentence (the server signed exactly these sentences), so the voice route will speak them
  const speech = sentences === parts && Array.isArray(r.speech) && r.speech.length === sentences.length && r.speech.every((t) => typeof t === "string") ? (r.speech as string[]) : [];
  return { line: r.line, ai: r.source === "ai", sentences, mood: typeof r.mood === "string" ? r.mood : "neutral", speech };
}

/** The Town Chronicle (relayer route `chronicle`): recorded market events with provenance; null when unavailable. */
export async function chronicleEvents(): Promise<ChronicleEvent[] | null> {
  if (isOffline()) return null;
  try {
    const r = await fetch("/api/near/chronicle");
    return r.ok ? (((await r.json()) as { events?: ChronicleEvent[] }).events ?? []) : null;
  } catch { return null; }
}

/** When the market last took a turn on NEAR (a fresh read, not the cached status). */
export interface LastTick { readonly at: number; readonly day: number; readonly txs: number; readonly failed: number }
export async function lastMarketTurn(): Promise<LastTick | null> {
  try {
    const r = await fetch("/api/near/status");
    return r.ok ? (((await r.json()) as { lastTick?: LastTick | null }).lastTick ?? null) : null;
  } catch {
    return null;
  }
}

/** True once we know NEAR is not available (not configured, unreachable or ?offline): the game runs locally. */
export const isOffline = (): boolean => status !== null && !status.configured;

/** The current on-chain market day, numbered exactly as the relayer does (floor(now / marketDayMs)); null offline. */
export const marketDay = (): number | null => (status?.marketDayMs ? Math.floor(Date.now() / status.marketDayMs) : null);
/** Length of one on-chain market day in ms; null offline. */
export const marketDayMs = (): number | null => status?.marketDayMs ?? null;

export const merchantAccount = (id: string): string => `${id}.${status?.relayer ?? ""}`;
export const playerId = (): string | null => player?.accountId ?? watched;
/** True when Google/email sign-in is available (the relayer has our Auth0 tenant configured). */
export const socialAvailable = (): boolean => Boolean(status?.auth);
/** Email or name of a signed-in player; null for guests. Never empty while signed in (finishSignIn falls back to the
 *  account name), so "signed in" can never be mistaken for "guest". */
export const playerLabel = (): string | null => store.get(LABEL_STORE) || null;

/** Called when another tab of this browser signs in or out, or this tab's sign-in turns out to have expired. */
const accountListeners = new Set<(why: "other-tab" | "expired") => void>();
export const onAccountChange = (f: (why: "other-tab" | "expired") => void): void => { accountListeners.add(f); };
// Another tab changed who is signed in (localStorage is shared per origin): follow it, never keep acting as the old one.
try {
  window.addEventListener("storage", (e) => {
    if (e.key !== null && e.key !== KEY_STORE && e.key !== ACCOUNT_STORE && e.key !== LABEL_STORE) return;
    player = null;
    void connectGuest().then(() => { for (const f of accountListeners) f("other-tab"); });
  });
} catch { /* no window (tests) */ }

let auth: Auth0Client | null = null;
const authClient = (): Auth0Client => {
  if (!status?.auth) throw new Error("sign-in is not available yet");
  return (auth ??= new Auth0Client({ domain: status.auth.domain, clientId: status.auth.clientId, authorizationParams: { redirect_uri: `${location.origin}/`, scope: "openid profile email" } }));
};

/** Social/email sign-in: one Auth0 popup (from a click or key press). If the browser blocks popups, the page
 *  redirects to NEAR Auth instead and finishSocialRedirect() completes it on return. The guest account is parked
 *  and restored on sign-out. */
export interface SignedIn { readonly accountId: string; readonly label: string; readonly merged: boolean; readonly linked: boolean }
/** The verified email/Google identity already has an account and this browser's guest has progress: nothing changed;
 *  the player chooses with chooseSignIn ("merge" the guest in, or "separate"). */
export interface SignInConflict { readonly conflict: true; readonly existing: Record<string, number>; readonly guestHoldings: Record<string, number> }
export type SignInResult = SignedIn | SignInConflict;

/** Auth0's Google connection: the button says "Continue with Google", so it goes straight to Google. */
const GOOGLE = "google-oauth2";

export async function signInSocial(): Promise<SignInResult> {
  const authorizationParams = { prompt: "login" as const, connection: GOOGLE };
  try {
    await authClient().loginWithPopup({ authorizationParams });
  } catch (e) {
    if (!/popup/i.test(e instanceof Error ? e.message : "") || /closed|cancel/i.test(e instanceof Error ? e.message : "")) throw e;
    await authClient().loginWithRedirect({ authorizationParams }); // leaves the page
    throw new Error("redirecting to sign in");
  }
  return finishSignIn();
}

/** Completes a redirect sign-in when the page loads with Auth0's ?code&state. Returns null if not returning. */
export async function finishSocialRedirect(): Promise<SignInResult | null> {
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

/** Completes a sign-in the player just made a choice about (after a SignInConflict), with the same login token. */
export const chooseSignIn = (choice: "merge" | "separate"): Promise<SignInResult> => finishSignIn(choice);

async function finishSignIn(choice: "merge" | "separate" | null = null): Promise<SignInResult> {
  const claims = await authClient().getIdTokenClaims();
  if (!claims?.__raw) throw new Error("sign-in was cancelled");
  const r = await post("social", { idToken: claims.__raw, guest: await guestProof(claims.__raw), choice });
  if (r.status === "conflict") return { conflict: true, existing: (r.existing ?? {}) as Record<string, number>, guestHoldings: (r.guestHoldings ?? {}) as Record<string, number> };
  if (r.status !== "onchain" || typeof r.accountId !== "string" || typeof r.sessionKey !== "string") throw new Error(String(r.message ?? "sign-in failed"));
  if (!store.get(GUEST_KEY_STORE) && store.get(KEY_STORE) && !store.get(LABEL_STORE)) { // park the guest
    store.set(GUEST_KEY_STORE, store.get(KEY_STORE)!);
    store.set(GUEST_ACCOUNT_STORE, store.get(ACCOUNT_STORE) ?? "");
  }
  store.set(KEY_STORE, r.sessionKey);
  store.set(ACCOUNT_STORE, r.accountId);
  store.set(LABEL_STORE, String(r.label || r.accountId.split(".")[0]));
  player = new Account(r.accountId, provider, new KeyPairSigner(KeyPair.fromString(r.sessionKey as KeyPairString)));
  return { accountId: r.accountId, label: String(r.label || r.accountId.split(".")[0]), merged: Boolean(r.merged), linked: Boolean(r.linked) };
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
  // read-only inspection: watch an account by name, never load a key or create or register one (inspect.ts)
  if (READ_ONLY) { watched = INSPECT_ACCOUNT ?? store.get(ACCOUNT_STORE); return watched; }
  let secret = store.get(KEY_STORE) as KeyPairString | null;
  if (!secret) {
    secret = KeyPair.fromRandom("ed25519").toString() as KeyPairString;
    store.set(KEY_STORE, secret);
  }
  const key = KeyPair.fromString(secret);
  // guest and register are idempotent on the relayer (the id comes from this key): a passing failure is retried, so a
  // real session does not fall back to offline play; a rate limit (429) is final
  const retried = async (route: string, body: unknown): Promise<Record<string, unknown>> => {
    let r: Record<string, unknown> = { status: "failed" };
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await sleep(2000 * attempt);
      r = await post(route, body).catch(() => ({ status: "failed" }));
      if (r.status === "onchain" || Number(r.httpStatus) === 429 || (Number(r.httpStatus) >= 400 && Number(r.httpStatus) < 500)) break;
    }
    return r;
  };
  let accountId = store.get(ACCOUNT_STORE);
  if (!accountId) {
    const r = await retried("guest", { publicKey: key.getPublicKey().toString() });
    if (r.status !== "onchain" || typeof r.accountId !== "string") return null;
    accountId = r.accountId;
    store.set(ACCOUNT_STORE, accountId);
  }
  // A stored account may predate a market reset: make sure the current ledger knows it (idempotent on the relayer).
  const known = await view<boolean>("is_registered", { account_id: accountId }).catch(() => true);
  if (!known) {
    const r = await retried("register", { accountId });
    if (r.status !== "onchain") return null;
  }
  player = new Account(accountId, provider, new KeyPairSigner(key));
  return accountId;
}

// ---------- cloud save: the story (quests, position, receipts list) for signed-in players, on any device ----------

const hex = async (s: string): Promise<string> =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))), (b) => b.toString(16).padStart(2, "0")).join("");

/** A request signed by this browser's key for the active account; the relayer checks NEAR has that key on the account. */
async function signedForSave(data: string): Promise<Record<string, unknown> | null> {
  const secret = store.get(KEY_STORE), accountId = store.get(ACCOUNT_STORE);
  if (!secret || !accountId) return null;
  const key = KeyPair.fromString(secret as KeyPairString), ts = Date.now();
  const { signature } = key.sign(new TextEncoder().encode(`vivolith-save|${accountId}|${ts}|${await hex(data)}`));
  return { account: accountId, publicKey: key.getPublicKey().toString(), ts, signature: btoa(String.fromCharCode(...signature)) };
}

/** Uploads the save of a signed-in player (guests' saves stay in their browser). True when stored. */
export async function cloudPut(data: string): Promise<boolean> {
  if (!store.get(LABEL_STORE)) return false;
  const auth = await signedForSave(data);
  if (!auth) return false;
  const r = await post("save", { ...auth, data }).catch(() => null);
  return r?.status === "saved";
}

/** The signed-in player's save from any device, or null. */
export async function cloudGet(): Promise<{ data: string; ts: number } | null> {
  if (!store.get(LABEL_STORE)) return null;
  const auth = await signedForSave("");
  if (!auth) return null;
  const r = await post("load", auth).catch(() => null);
  return r?.status === "found" && typeof r.data === "string" ? { data: r.data, ts: Number(r.ts) } : null;
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
  const o = await actOnce(method, args);
  if (o.status === "failed" && store.get(LABEL_STORE) && /AccessKeyNotFound|InvalidAccessKey|access key.*(not found|doesn't exist|does not exist)/i.test(o.message ?? "")) {
    // The signed-in session's key is no longer on the account (revoked or expired): nothing was charged. Sign out to
    // this browser's guest game so the player is never left "signed in" with moves that cannot succeed.
    await signOutSocial();
    for (const f of accountListeners) f("expired");
    return { status: "failed", message: "your sign-in expired: sign in again" };
  }
  return o;
}

async function actOnce(method: "buy" | "sell" | "deal", args: Record<string, unknown>): Promise<TxOutcome> {
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
  return relaySigned(delegate, post, sleep, SEND_TRIES, RETRY_MS);
}

/** A haggled deal: the merchant signs the agreed price (server), the player settles it in one tx. */
/** `ref`: the raw NEAR AI price this screen was built on (0 when none): the relayer refuses a deal whose reference is no longer the live price. */
export async function haggleDeal(merchant: string, side: "buy" | "sell", token: string, qty: number, unit: number, ref = 0, tactics: readonly string[] = [], rep = 0): Promise<TxOutcome> {
  const id = playerId();
  if (!id) return { status: "local", message: "offline: not connected to NEAR" };
  let signed: Record<string, unknown> | null = null;
  for (let attempt = 0; attempt < SEND_TRIES && !signed; attempt++) { // the merchant's signature moves nothing yet
    if (attempt > 0) await sleep(RETRY_MS);
    const r = await post("deal", { merchant, side, token, qty, unit, ref, tactics, rep, player: id }).catch(() => null);
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

/** The latest final block height (null when the RPC does not answer): how old a receipt is, in blocks. */
export const finalHeight = async (): Promise<number | null> => { try { return (await provider.viewBlock({ finality: "final" })).header.height; } catch { return null; } };
export const receipts = (accountId: string): Promise<ChainReceipt[]> => view<ChainReceipt[]>("get_receipts", { account_id: accountId });

/** Asks the relayer to run the merchants' autonomous turn and the day's settlement (both throttled server-side). */
export const marketTick = (): Promise<Record<string, unknown>> => post("tick", {}).catch(() => ({ status: "failed" }));
/** After a player's trade the stall's posted orders follow the new price at once (server `reprice`), not a turn later. */
export const repriceMerchant = (merchant: string): void => { void post("reprice", { merchant }).catch(() => null); };
export const settleDay = (): Promise<Record<string, unknown>> => post("settle", {}).catch(() => ({ status: "failed" }));
/** Pays the player every whole coin of dividends they are owed (the relayer checks get_pending first and sends nothing
 *  when nothing is owed). Their own trades claim too. */
export const claimDividends = (accountId: string): Promise<Record<string, unknown>> => post("claim", { account: accountId }).catch(() => ({ status: "failed" }));
