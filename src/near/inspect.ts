// Read-only inspection of the connected game (QA and judges): open the site with `?inspect=<account>`.
// The page reads the real market (status, chronicle, decisions, NEAR view calls) and shows that account's wallet and
// the HUD as a player would see it, but it cannot change anything:
//   - no signing key is loaded, so nothing can be signed (chain.ts connectGuest never touches the key store)
//   - every request to /api/ other than GET is refused before it leaves the page: no guest account, market turn,
//     settlement, dividend claim, trade, harvest, NEAR AI conversation, voice generation or cloud save
//   - the local save is never written (the inspected state is the chain's, not this browser's story)
// Recorded voice files still play (static files, free); lines without a recording show as silent subtitles.

/** The inspected account of a page URL: `/inspect/<account>` (public route) or the older `?inspect=<account>`. Null when
 *  not inspecting, "" for `/inspect` or `?inspect` alone, else the account id. */
export const inspectParam = (search: string, pathname = ""): string | null => {
  const p = /^\/inspect(?:\/([^/]*))?\/?$/.exec(pathname);
  return p ? decodeURIComponent(p[1] ?? "") : new URLSearchParams(search).get("inspect");
};

/** The judges' ledger view: `/ledger` (public route) or the older `?ledger`. */
export const ledgerView = (search: string, pathname: string): boolean => /^\/ledger\/?$/.test(pathname) || new URLSearchParams(search).has("ledger");

/** The clean address for an old query-style link (`/?ledger` -> `/ledger`, `/?inspect=a` -> `/inspect/a`), keeping
 *  any other parameters; null when the address is already clean. Old bookmarks keep working and then show the route. */
export function cleanUrl(pathname: string, search: string): string | null {
  if (pathname !== "/" && pathname !== "/index.html") return null;
  const q = new URLSearchParams(search), acct = q.get("inspect");
  let path: string;
  if (acct !== null) { path = acct ? `/inspect/${encodeURIComponent(acct)}` : "/inspect"; q.delete("inspect"); }
  else if (q.has("ledger")) { path = "/ledger"; q.delete("ledger"); }
  else return null;
  const rest = q.toString();
  return rest ? `${path}?${rest}` : path;
}

/** True when this request could change the economy or spend credits: any non-GET request to the game's API. */
export function mutating(method: string | undefined, url: string): boolean {
  const m = (method ?? "GET").toUpperCase();
  if (m === "GET" || m === "HEAD") return false;
  let path: string;
  try { path = new URL(url, "http://local").pathname; } catch { return true; } // unreadable: refuse
  return path.startsWith("/api/");
}

const param = typeof location === "undefined" ? null : inspectParam(location.search, location.pathname ?? "");
/** This page is a read-only inspection. */
export const READ_ONLY = param !== null;
/** The account whose wallet the inspection shows (no key: view calls only); null when none was given. */
export const INSPECT_ACCOUNT = param && /^[a-z0-9._-]{2,64}$/.test(param) ? param : null;

/** Installs the request guard once, before the game makes any request. */
export function installInspectGuard(): void {
  if (!READ_ONLY || typeof window === "undefined") return;
  const real = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    if (mutating(method, url)) return Promise.resolve(new Response(JSON.stringify({ status: "failed", message: "read-only inspection" }), { status: 403, headers: { "content-type": "application/json" } }));
    return real(input, init);
  };
}
