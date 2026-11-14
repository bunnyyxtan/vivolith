# VIVOLITH: Progress Tracker

> Retired: the realistic prototype (`legacy.html`, Mixamo characters) was removed; V2 is the only game. Entries below that mention Mixamo, `src/crowd.ts`, `src/cast.ts` or `legacy.html` describe that prototype and are kept as history.

The game was renamed from NEAR World to **VIVOLITH** on 2026-11-06 (identifiers such as the testnet account
`bunnyy-nearworld.testnet` and the save key `nearworld.save.v1` keep their old names for compatibility).

Status keys: NOT STARTED · IN PROGRESS · VERIFIED (evidence given) · BLOCKED (reason given) · ROADMAP.
Deadline: 2026-11-14 23:59 UTC. Feature freeze target: 2026-11-13 12:00 UTC (rest = QA, recording, submission).

## Phase 1: core gameplay (2026-11-12)

Tested offline only (`near-world-offline` launch config: relayer, voice and AI keys blanked, so no testnet transaction or
paid call was possible). Anything that needs the live chain is marked READY FOR LIVE VERIFICATION.

| Item | Status | Evidence |
|---|---|---|
| "The night Pema almost closed" (`src/v2/story.ts`): starts when Pema tells her story, ends only on the rent result (contract `last_rent` and open/closed; offline, the 21:00 market rent), HUD stake line with her real till, rent and when it is charged, epilogue from confirmed trades, recovery beat, town gossip | VERIFIED offline; READY FOR LIVE VERIFICATION on chain | `node src/v2/story.check.ts` (time alone never decides); browser: friend's price, then rent at 21:00 resolved "kept", bubble `phase1-pema-rent-kept-bubble.jpg`; a later closure in the week shown in the epilogue and handed to "Help Pema reopen" |
| Offer comparison in the trade panel, Pema's till economics, friend's price (worse for the player, so the relayer accepts it as a rule price), first sale is a choice (Pema or a better bid) | VERIFIED offline | `phase1-pema-sell-choice.jpg`: Pema 6 c vs Arin 6 c vs Mira 4 c, friend's price 2 c keeps 12 c in her till |
| Price-move feedback after a confirmed deal | VERIFIED offline | `phase1-trade-price-move.jpg` |
| Orchard crate of today's share, fruit arcs to Kavi after a confirmed pick, in-flight/picked states, reach anywhere in the grounds, orchard offered as a daily opportunity | VERIFIED offline | `phase1-orchard-crate-ready.jpg`, `phase1-orchard-pick-flight.jpg`; second press: "already picked" |
| Relayer gives the day's pick back when the mint definitely failed (bundle rebuilt) | READY FOR LIVE VERIFICATION | Code + bundle only; not deployed |
| Invest tab: dividends actually paid (NEAR receipts per stall, local ledger offline), risk and buy-back stated | VERIFIED offline | Browser: "Paid to you 0 c" after the first pack, week report then showed 3 c dividends |
| Haggle: merchant reaction over their head per tactic | VERIFIED offline | Browser: Buy double landed, 18 c for 6 (opened 24 c) |
| Frame time at the orchard crate | MEASURED | 3.0 ms median (`frameTime(60)`, 964x906 pane, RTX 3050) |

### Phase 1b: economy depth and integration (2026-11-12, local only)

| Item | Status | Evidence |
|---|---|---|
| Pema's structural loss (bid 5 c above ask 3 c) fixed: restock-cost floor on every ask, loyal restock bid 1.35 x cost, Pema rent 30 c, no scripted 6 c delivery | VERIFIED offline; READY FOR LIVE VERIFICATION (needs relayer redeploy) | `node src/economy/sustain.check.ts`: Pema closed days 10 -> 2 unhelped, 12 -> 0 when supplied; Arin pays the player ~2x for the same mangoes |
| Haggle: negotiated price always inside the relayer window, affordable in whole coins (bug found: 32 c offered from a 30 c till), never under restock cost, resellers capped at their shelf price; no sell haggle without a bid; roomless haggle disabled with the reason | VERIFIED (checks) | `haggle.check.ts` explores every 3-move sequence on 96 stall states; tutorial haggle still wins a coin |
| Investment: owned, paid (NEAR receipts), earned-not-yet-paid (`get_pending`), labelled forecast per pack, buy-back loss stated | VERIFIED offline (forecast and texts); pending read is chain-only | Browser: "Forecast per pack about 0.5 c a day", buy-back 1 c under cost |
| Orchard failed-mint retry in the API bundle | VERIFIED in bundle, NOT DEPLOYED | `releaseOnce` defined and called only on `!r.ok` |
| Pema stall moods from real state: struggling (half shutter, guttering lantern), closed (full slatted shutter), recovering (Open again banner for a game day) | VERIFIED offline | `phase1b-pema-struggling.jpg`, `phase1b-pema-closed.jpg`, `phase1b-pema-recovering.jpg` (closed and recovering staged by calling setStall directly) |
| Browser pass after the last text changes (haggle reason, margin note) | BLOCKED | The browser pane refused new WebGL contexts after many reloads; typecheck and checks pass |

### Phase 1 live pass on testnet (2026-11-12, approved by the owner)

Dev relayer with real testnet keys, NEAR AI and ElevenLabs keys blanked (`near-world-live-noai`), one fresh guest
`g3bb4d6aaa31fd20f.bunnyy-nearworld.testnet` (40 c starter purse). Market turns were the game's own 60 s client ticks.

| Step | Result | Transaction |
|---|---|---|
| Pema's arc starts in chain mode: till 7 c, rent 40 c, due market day 2990842, HUD "in about 1 min", then "at the next market turn" once the day began (no verdict before the charge) | PASS | |
| Orchard pick, F pressed twice: one request, bag 0 to 3, game purse = `mt_balance_of` (40 c, 3 mangoes) | PASS | `4F8tm4nAFwsJE1BKCrRukgPaemLBKmzQ1o4cUb3UT97w` |
| Buy 3 from Tomas at 2 c | PASS | `3gppDMocjCS5VpnaF7zGXVHRZBm6vVU451HXy9f6Lc2J` |
| Market turn charged rent: `get_stalls` pema `last_rent` 2990842, closed; story resolved "closed" with toast | PASS | relayer tick |
| Sell 1 mango to closed Pema: reopened (`get_stalls` open, need 0), recovery beat | PASS | `AtZxxrM6BLRCVvV1wBJ4jVGHkGeUaTBq7TNPfgXWKcE2` · `phase1-live-pema-reopened.jpg` (bubble re-shown for the capture) |
| Friend's price: 2 mangoes at 2 c while her bid was 5 c and her till 5 c; relayer accepted; game = chain (player 44 c, 3 mangoes; Pema 1 c) | PASS | `12QdWWcKKY2xti1WuUn27Ch9xuUaM5EFYPenknBfVDn5` |
| Live defects found and fixed: friend's price was capped by the quantity the full bid allowed (and hidden when that was 0); Pema's greeting said "three mangoes left" with 12 on the shelf; her till note showed while closed | FIXED | |
| Orchard claim release on a failed mint, invest dividends paid on chain, haggle deal on chain | NOT RUN LIVE | relayer change needs a deploy; not exercised in this pass |

## Phase 2: NEAR AI merchants and residents

**Status: IMPLEMENTATION COMPLETE (closed 2026-11-13).** No further Phase 2 features. Remaining live checks moved
to [RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md). The approved connected playthrough was stopped before its first
market turn: 0 transactions, 0 guest accounts, 0 paid requests.

Live-verified (testnet or production, evidence below):
- Jev probe and one Jev decision to a confirmed order (Arin `ErDdDdcC…`, signature signed).
- Closed-bid recovery delivery to Pema (guest `g88b8a3081b294900`, reopened on chain).
- Production `c2ace0b` with routes, status and 3 capped live conversations (Pema, Arin clean; Lin's grounding defect).
- Phase 1 testnet pass: orchard pick, buy, chain rent closure, reopening by delivery, friend's price.

Offline or isolated only (mocked RPC, mocked NEAR AI, or offline browser play):
- Six-agent engine, economic memory, budgets and kill switch, signature verification, market-turn handler.
- Economic recovery rules, Guild, rent grace, residents Lin and Dev, carried shopper demand.
- Town Chronicle, durable bonds, butterfly scenarios.
- Lin's grounding fix (`86cf4be`) and the Rent Night journey fixes (`f781fb2`): local commits, not deployed.

| Item | Status | Evidence |
|---|---|---|
| Live Jev probe (`scripts/near/jev-probe.ts --yes`, 2026-11-13): one request to `cloud-api.near.ai/v1/systemone` with Pema's opening-state bid facts, no tick, no transaction | VERIFIED | HTTP 200 in 1254 ms; choice schema accepted; `bid_action` = raise, confidence 0.56 (probabilities raise 0.71 / lower 0.27 / hold 0.02; confidence is not the top probability); model `typesafe/jev-1.13-20260917`; id `gen-dec-1794553666-cE3HvpVndC2Z4LWFcuge` (unverified, no SDK check); 695 input / 39 output tokens, cost 0.00002919 |
| Six agents on one engine (`server/near/agent.ts`): Pema, Tomas, Mira, Arin each move one price lever inside a band from chain state; Lin and Dev choose where to sell and where to eat among real orders (or hold). Each merchant reads the chain through its own strategy (Pema: rent runway, coins short of rent; Tomas: margin over cost, stock vs normal; Mira: resale spread; Arin: lassi kitchen needs) with its own criteria for raise/hold/lower | VERIFIED (mocked) | `node server/near/autonomy.check.ts`, `node server/near/agent.check.ts`; no live decision beyond the probe |
| Economic memory (`server/near/memory.ts`, Redis `vivolith:mem:<id>`): one row per market day per agent: opening snapshot (block, coin, goods, open), the stored decision (action, price, source, tx hash, verification), and the outcome closed by the next day's first turn: coin and goods change, units bought and sold and trades with players from the contract's receipts (null = "unknown" when the 20-receipt window cannot cover the day). Shown to Jev as `your_recent_days`, to dialogue as relative sentences | VERIFIED (mocked) | Idempotent per day (second turn changes nothing, no rewrite), max 12 rows, 24 h TTL, corrupt or forged rows rejected on read, future rows dropped; two-day run closes Pema's and Lin's day from the same trade seen from both sides |
| Market drivers and controls (`server/near/ops.ts`): `NEAR_MARKET_DRIVER=players` (default, today's behaviour) or `scheduler`; scheduler route `GET/POST /api/near/market-turn` with `Authorization: Bearer <NEAR_SCHEDULER_SECRET or CRON_SECRET>`; browser `tick` requests never make a paid call (they replay a decision already stored for the day, inside today's band, else the rule) and change nothing in scheduler mode; kill switch `NEAR_AGENTS_OFF=1` or Redis `vivolith:agents:off` (`scripts/near/agents.ts halt/resume`); daily limits per UTC day for decisions, chats and signature checks (200/300/200 by default, 0 = none); every control fails closed (store down = no paid call, agents halted) | VERIFIED (mocked + real route handler offline) | Budget, kill switch, secret compare, defaults; `handle()` with an unreachable RPC: browser tick in scheduler mode answers "scheduled", `market-turn` 401 without the secret, status shows driver/enabled/halted and no secret |
| Decision evidence and signature check (`server/near/verify.ts`): the exact request and response bytes are hashed when Jev answers; a scheduler turn fetches `/v1/signature/<decision id>?signing_algo=ed25519`, checks the signed text binds those hashes (gateway or provider_tee form), checks the ed25519 signature, and requires the signer in NEAR AI's `/v1/attestation/report`. Statuses: none (rule), pending, signed, unverified (no signature after 3 attempts), failed. The TEE quote inside the report is NOT validated (the official `@nearai/inference-sdk` does that; not bundled), so the game never says "verified" | VERIFIED (mocked with a real ed25519 key) | Tampered response, wrong signer, wrong model key, bad signature -> failed; missing signature -> pending, then unverified; budget stops the pass |
| Free-form conversations (`server/near/talk.ts`, route `talk`): ask any merchant or Lin/Dev your own question (200 chars). Facts: chain balances and orders, readable pricing reasons, today's decision in plain words, memory, and the player's own trades with that speaker (their receipts). Six distinct personas. A fast chat model (`NEAR_AI_CHAT_MODEL`, else `NEAR_AI_MODEL`) only phrases; guards: every number (digits or spelled out) must be in the facts, no chain/AI words, 280 chars; else a scripted line picked by topic (rent, stock, decision, past, your trades). Conversation history kept server-side under an unguessable id (last 3 exchanges, 1 h). Plain text plus `sentences` for Phase 3 streaming voice. Separate from Jev | VERIFIED (mocked) | Invented or spelled-out numbers and off-world words fall back; no call when halted or over budget; history continues; resident script names the best bid |
| In game: free-form ask box in the trade panel (merchants) and in the money trail (Lin, Dev); decision card shows model, confidence and the proof in plain words ("Signed by NEAR AI", "Signature check pending", "Not verifiable", "Signature check failed"); money trail says who drives the market | VERIFIED offline (layout) | Browser, 5174 `?offline`: trade panel and reasons unchanged, 2.5 ms median frame at the stall; ask box and proof label checked by inserting the same markup (they only render with a chain account) |
| Bug fixed: `GET /api/near/decisions` sat behind the POST-only check and always answered 405, so the game could never show a NEAR AI decision card | FIXED, VERIFIED | Dev relayer now answers 200; route check in `autonomy.check.ts` |
| Controlled live Pema run (authorized 2026-11-13; `scripts/near/pema-run.ts`, now `agent-run.ts --agent=pema`, agents-only turn, process memory, 1 paid decision max) | BLOCKED at preflight, nothing sent | `docs/evidence/phase2-pema-preflight.json`: Pema closed (till 1 c, Guild debt 163 c, no posted bid, reopens after 1 mango). The authorized one-mango player sale is impossible: her closed bid is 5 c, the relayer signs only 2-5 c, and 1 c cannot pay it. The Guild fund is 0 c, so a market turn could not lend to her either. Market state: Pema, Tomas, Mira closed; only Arin open (19 c); production's last turn 811 min earlier. 0 transactions, 0 NEAR AI requests, 0 credits |
| Testnet economy stalled: three of four stalls closed with an empty Guild, so no player sale can reopen Pema, Tomas or Mira by price rules alone | FIXED in code (not deployed) | A closed stall now bids only what its till can pay for one mango (`bidForRule` in `src/economy/pricing.ts`): Pema with 1 c bids 1 c, so one delivery at 1 c reopens her; a till under 1 c posts no bid. All economy checks unchanged; live state still needs a deploy and a real delivery |

### Economic recovery (2026-11-13, local only; details and numbers in [ECONOMY_RECOVERY.md](ECONOMY_RECOVERY.md))

| Item | Status | Evidence |
|---|---|---|
| Diagnosis of the testnet deadlock: on-chain street shoppers bought no fruit (per-turn floor), the Guild could never collect dues once its loans went bad, repayment only above 80 c, no loan cap, reopened stalls met rent at once, residents never sold to closed stalls | VERIFIED (model) | `node src/economy/recovery.check.ts`: old rules, 6 healthy days: 0 fruit vs 183 lassi to shoppers; live state, 8 days: nobody reopens |
| Recovery rules shared by the relayer and the model (`src/economy/recovery.ts`): carried shopper demand, affordable closed bids, residents may fill closed stalls' funded bids, capped repayment above rent + 10 c, loan cap 120 c, dues can rebuild a fund emptied by bad loans (they stay on the books), one rent grace per reopening | VERIFIED (model, offline) | Coin conserved in every run (now = start + shoppers − rent − freight); rent, residents and Guild once per market day however many turns run |
| Player choice on the live deadlock: 1 mango to Pema at 1 c -> funded bid in 5 turns, all four open after 6 days, her debt 163 -> 142 c; selling to Arin instead leaves three stalls closed | VERIFIED (model) | Same check, scenario 7 |
| Consignment | NOT BUILT: needs a contract upgrade (no operator path pays coin from a stall to a player) and the contract toolchain does not build here | Spec in ECONOMY_RECOVERY.md; the executable alternative is the affordable delivery plus investing |
| Production deploy (authorized 2026-11-13): commit `7eb1b4d` from a clean worktree (uncommitted audio not shipped) to vivolith.world | VERIFIED | Page meta `vivolith-commit` = 7eb1b4d; status: driver players, agents enabled [] (no `NEAR_AGENT_MERCHANTS`, no chat model, no scheduler secret in production env), Redis persistent; `GET chronicle` 200, `GET decisions` 200 (was 405), `market-turn` 401 without the secret |
| One recovery delivery to Pema (authorized): fresh preflight (closed, till 1 c, needs 1 mango, bid 1 c), then through production's routes: guest `g88b8a3081b294900` created `TDjoMdKfgYUCfMbVoxkd1NArekSsNRE51NzDqR865ZP` and registered `3pdnjvSyTqXZEUxnANy14ZLGGQX82cD5yGsYCcpgUqL6` (40 c starter purse), orchard pick `AwkBvFpLUB1vvCBxJQbnuXtLmH7Pwx9Lq5aWkHYPUFKc` (3 mangoes), 1 mango sold to Pema at 1 c `9capJiHjpz5mG9ynbA7YUXbWapMUUtMuWeHcvRgHsas1` | VERIFIED on testnet | `SuccessValue`; Pema open, 0 c, 14 mangoes, debt 163 c; guest 41 c, 2 mangoes; production Chronicle (production Redis) holds the confirmed trade and the reopening with that hash: `docs/evidence/phase2-pema-delivery.json` |
| Recovery after the delivery | WAITING: no market turn has run | Market turns run only while someone plays (driver players; no extra turns were triggered). At 08:46 UTC: last turn 865 min ago, Pema open with 0 c and 14 mangoes, no mango bid (shelf above half of normal, empty till), so no Jev decision is possible. The model expects a funded bid within about 5 turns once play resumes; not observed live |
| Pema Jev run | NOT RUN (not eligible) | No funded order to price; the Arin run remains available (`agent-run.ts --agent=arin`) |
| **Live Jev decision -> confirmed NEAR order (Arin, authorized 2026-11-13)**: preflight (open, 19 c, 5/6 mangoes, no posted bid, band 5-7 c, only Arin enabled, retries 0, no decision today), agents-only scheduler turn, 1 paid request | VERIFIED on testnet | Model `typesafe/jev-1.13-20260917`, decision `gen-dec-1794559848-eVH5ExAbd0KpQ4FaAYFN`: **hold** (probabilities hold 0.66, lower 0.32, raise 0.02; confidence 0.49, under the 0.5 floor, whose default is also hold). Order `arin.bid mango 1 x 6 c`, tx `ErDdDdcCwxFYZBbDdsvL6ovGafsHh3BH2Vv46ECzPkhM` `SuccessValue` (Arin had no posted bid before). Signature check, live: **signed** (Gateway signature over the exact request/response bytes, signer `40599fb2…` in NEAR AI's attestation report; TEE quote not checked). `docs/evidence/phase2-arin-live-run.json`. Decision and memory were held in the run's process memory (no production Redis credentials used); the game-endpoint and memory-close steps did not run because of a script bug (queried pema), since fixed |
| Low-confidence labelling fixed (found in the Arin run): a held raise or lower the model was unsure of is now labelled the rule's (fallback); a low-confidence hold stays the model's | VERIFIED | `agent.check.ts` case 5 |
| Market-turn handler integration (`server/near/turn.check.ts`): the real `handle()` against a mocked NEAR RPC (decoded transactions, fake contract balances), a mocked NEAR AI and a fake clock | VERIFIED (isolated) | Browser turns: 0 AI requests even with an agent enabled; scheduler turn: 1. Two concurrent scheduler calls: one runs, one "skipped". Scheduler mode: a browser request signs nothing. Daily budget is a hard cap; kill switch: 0 requests; market turns never retry a paid request. Guild collects dues with `fill_to` 363 (200 + 163 owed by closed Pema) and lends nothing to a stall over 120 c. Lin sells into a closed stall's funded bid; one rent waived (`rent: "0"`) then 30 c charged on the next rent day; carried shopper demand sold 2 of Pema's mangoes over 8 turns (old rule: 0) |
| Conversation through the real talk route, offline: chat model `google/gemini-2.5-flash-lite` (chosen from `cloud-api.near.ai/v1/models`: fast, 0.1/0.4 USD per M tokens) | VERIFIED (isolated); live NOT RUN | Grounded reply uses the chat model, Pema's facts carry her real debt, the speaker's recent Chronicle events and the player's bonds; conversation memory continues; a forged conversation id starts fresh; provider 500, timeout, malformed and empty replies, an invented number and off-world talk all give the scripted line; no request without a model or with a chat budget of 0; Lin answers from her own purse |
| Production release `c2ace0b` (authorized 2026-11-13): clean worktree, 12/12 checks, client typecheck, build; env `NEAR_AI_CHAT_MODEL=google/gemini-2.5-flash-lite`, `NEAR_AI_DAILY_CHATS=3` (no agent, driver, scheduler or cron settings) | VERIFIED | Page meta c2ace0b; status driver players, agents [], Redis persistent; Chronicle holds the 2 confirmed Pema events; decisions 200 (empty for arin and pema: the Jev run's decision was never in production Redis); `market-turn` 401 x3; no market turn triggered. `docs/evidence/phase2-live-chat.json` |
| **Live NEAR AI conversations** (3 paid calls, the authorized cap) through `POST /api/near/talk` | VERIFIED live, grounding 2 of 3 clean | All three `source: ai`, 1.5-1.7 s. Pema (with the delivery guest's account): open again, owes the Guild 163 c (chain-true). Arin: selling his 5 lassi (chain-true), no claim to remember the Jev test. Lin: buyers and prices right (Arin 6 c, Tomas and Mira 5 c) but says she holds six mangoes (chain: 65; six is her daily pick) and implies each bid takes all of them (each is for 1): the number guard cannot catch a true number used for the wrong thing. 4th request at the cap: scripted line, no model call (counter shows 4 attempts). Cost not reported by the route; estimate about 0.0003 USD |
| Lin's grounding fix (local, `86cf4be`, not deployed): resident facts label holdings, daily gathering and each order's price and maximum quantity; `grounded()` checks goods counts by role (held / per day / one order / "buy them" vs whole stock) against chain balances and posted orders | VERIFIED (isolated) | `autonomy.check.ts`: the live Lin line passes the old check and fails the new one; inventory 65 -> 70 -> 2 changes the facts and the check; Dev's lemons; Pema's and Arin's live lines still pass. No paid call |
| Production browser pass (fetch guard refused every write route except talk) | VERIFIED (partial) | Title, welcome, city render; guest creation blocked, no turn sent; offline Town tab labelled offline. One 404 (`car_van.glb`, pre-existing, no client change since 7eb1b4d). Frame time and the stall dialogue panel not measured (pane hidden) |
| Autonomous schedule | PREPARED, OFF | Route `GET/POST /api/near/market-turn` (Vercel Cron sends `Authorization: Bearer $CRON_SECRET`). To activate: `vercel.json` `"crons": [{ "path": "/api/near/market-turn", "schedule": "*/5 * * * *" }]` (needs a plan that allows it), env `CRON_SECRET`, optionally `NEAR_MARKET_DRIVER=scheduler`, then one agent at a time (`NEAR_AGENT_MERCHANTS=arin`) with `NEAR_AI_DAILY_DECISIONS` / `NEAR_AI_DAILY_VERIFIES` set low |

### Phase 2b: the economic butterfly effect (2026-11-13, local only)

| Item | Status | Evidence |
|---|---|---|
| Town Chronicle (`src/economy/chronicle.ts`, Redis `vivolith:chronicle`, route `GET chronicle`): each event says what happened, who, what changed (per-account deltas), its status (confirmed on NEAR / recorded, no tx needed / failed / pending / offline simulation) and evidence (tx hash, decision id, model, signature status, the facts a decision saw). A decision lists the recorded events that changed its decider's goods or till since its previous decision ("since"), never "because". Written by the relayer: player deals (relay), agent and rule lever decisions, residents' sales and meals with the offers they chose between, rent paid / stall closed, reopenings | VERIFIED (mocked + offline) | `node server/near/butterfly.check.ts`: links appear only for the merchant the player traded with; no event text claims a cause; duplicates by id or transaction are dropped; a busy store skips the write |
| Durable relationships (`server/near/ledger.ts`, `vivolith:bond:<npc>:<player>`, 30 days, 20 per pair): confirmed deliveries and purchases (from the relayed transaction), the stall's own price when the relayer signed (to state "accepted less than your bid" as an interpretation), refused offers (no trade happened). Dialogue gets them labelled Fact / Interpretation; never a promise or a better price | VERIFIED (mocked) | Same check: retried relay recorded once; wording checked; no friendship or discount words |
| In game: notebook tab "Town" (key C) with the Chronicle (offline: the simulation's log labelled offline), evidence folded under "Evidence"; street gossip leads with the latest confirmed events; refreshed once per existing market turn (no new polling) | VERIFIED offline in the browser | Played day 1: bought 3 from Tomas, chose the friend's price for Pema (3 c, Arin offered 6 c) -> Pema till 24->15 c, shelf 3->6; at 14:00 Arin bought 6 from Tomas; shoppers took 3 of Pema's; 21:00 she paid rent (32->4 c, stayed open), half shutter at night: `docs/evidence/phase2b-pema-after-rent-night.jpg`. Town tab listed all of it in order. 2.5 ms median frame (`frameTime(60)`, small pane) |
| Scenarios (`server/near/butterfly.check.ts`, game rules + decision engine with a labelled STUB model, offline): 1 sell to Arin for profit (18 c), 2 support Pema at the friend's price (9 c), 3b same delivery with Pema's rent covered, 2b closed broke Pema rescued at 1 c, 2c same but sold to Arin | VERIFIED | Measured: rule bid prices are flat (Pema 4, Arin 6) in 1 and 2; what changes is how much each stall still buys (Pema 8 vs 5, Arin 1 vs 4) and so how much Lin can sell to Arin (1 vs 4). The stub chose the same step for Pema in 1 and 2 (till under rent in both); with rent covered (3b) it held instead. 2b reopens Pema at once but exposes her to that night's rent with 19 c and she closes again; unrescued (2c) she stays shut through rent time and reopens next morning: rescue is a real risk, not a guaranteed win |
| Not live: no Chronicle, bond or decision has been written on testnet/production Redis; a real Jev decision has still not reached a confirmed transaction | NEEDS AUTHORIZATION | Deploy (with the closed-bid fix) + one delivery to Pema + one scheduler turn |
| Live: one scheduler turn with agents enabled (testnet transactions + paid Jev calls + signature reads), the chat model live, Vercel Cron, production env | NOT RUN: needs the owner's authorization | Prepared: `scripts/near/agents.ts turn` (dry run by default, `--yes` sends one turn); cron line for `vercel.json`: `"crons": [{ "path": "/api/near/market-turn", "schedule": "*/5 * * * *" }]` (Vercel plan must allow it) |

### Rent Night journey pass (2026-11-13, local, offline play in the browser)

| Item | Status | Evidence |
|---|---|---|
| Played the first day as a new player ("Rin"): goal card + gold marker -> Pema's story -> buy from Tomas -> the choice at Pema (her 4 c, friend's 3 c, or Arin 6 c) -> haggle -> invest -> Rent Night at 21:00 -> evening report -> Pema's epilogue | PLAYED | `docs/evidence/rentnight-*.jpg` |
| Blocker found: following the tutorial exactly closed Pema every time (investing pays her harbor fee, till 15 -> 1 c; shoppers bought ~4 mangoes by 21:00, she ended at 20 c), while step 7 "Fast-forward a week" unlocked T so a player could skip the night, and the advice was generic ("stock on her shelves") when she held 33 mangoes and lacked only coins | FIXED | New step 7 "Rent night" before the fast-forward (T unlocks after Pema's epilogue); advice from her real till, shelf, price and crates in transit ("Buying 4 mangoes from her at 5 c puts 20 c in her till"). Run A: followed it, she paid rent and kept 10 c; Run B: didn't, she closed 1 c short and reopened next morning on full shelves |
| Evening report did not mention the night's stake | FIXED | "Pema's night" section first: Rent paid / Shutters down, her till, the player's part (mangoes sold, coins spent) |
| Rent Night camera looked over the plaza tree: 3 of 4 merchants occluded (raycast), no bubble visible | FIXED | Camera on Pema's stall from the avenue: her bubble, the Closed sign and Arin's line in frame (`rentnight-b1-cinematic-shutters.jpg`; before: `rentnight-before-camera-fix.jpg`) |
| Player name ignored: "You saved my morning, Kavi!" after naming yourself | FIXED | Lines use the chosen name; the recorded voice line still plays for the default name |
| Epilogue said "The shutters are down" after she had reopened on her own | FIXED | Closed-then-reopened variant |
| Hint "Press T to fast-forward a week" showed while T was locked | FIXED | Keyed to the step id |
| Residents (Lin, Dev) and real NEAR settlement in this journey | NOT PLAYED | Residents only act in on-chain market turns; a connected run writes to the shared testnet market (production) and needs the owner's approval |
| At 800x600 the trade panel covers the objective card's rent meter | OPEN | Seen in `rentnight-a1-choice-at-pema.jpg`; not checked at 1080p |

## Phase 6: visual truth and trade UI correction (2026-11-14, local `db3c7a1`, offline play)

**Deployed 2026-11-14 (authorized): `66907f3` on vivolith.world** from a clean worktree, no env change (status: driver players,
no caps, no agents; `market-turn` 401; arbitrary voice 403). Re-checked live as the reused guest, no player trade: Arin's and
Pema's Buy, Sell, Invest tabs and Details contain no chain, AI, signature, transaction or record wording; notebook tabs
Goals, Bag, Town, How to play; N opens nothing without `?ledger`; Town is plain news; mission card compact beside the
panel at 1280x720; Pema open with her counter goods (`phase6c-live-66907f3-pema-panel.jpg`). Found live: town news
"Lin sold 2 mangos", "A player bought 3 mango" (server text): fixed locally, not deployed.

Nine issues from live screenshots (`docs/evidence/phase6c-before-*`), each traced to its cause; after captures `phase6c-after-*`.

| Issue | Cause | Kind | Fix |
|---|---|---|---|
| Lin "delivering" to a shuttered stall | Arin was open but "struggling" (till under rent); that mood lowered a half shutter, so an open stall looked closed. The sale was real and to an open stall | Misleading presentation | No half shutter: only closed stalls roll down; a struggling till shows in its guttering lantern. A delivery to a truly shut stall (reopening deliveries are legitimate) hands over at the stall's open end, never through the shutter |
| "Open again" board over Pema's sign | Recovering-mood banner | Presentation | Banner removed; the shutter rolling up, the merchant back at work and her existing reopening line carry it |
| Cluttered trade panel | Every fact rendered by default | UI | Merchant, product and price, one deciding line, quantity with resulting purse, actions; comparisons, reasons, till breakdown and Ask in "Details"; goal line names the mission's merchant and where; haggle states its fixed 3-mango lot (relayer replays 3) |
| Lassi icon a blank box | CSS gradient placeholder | Presentation | SVG glass of mango lassi with foam and straw; share icon a small stall |
| Orchard Row stall without a merchant | A stall model in town.glb with a sign and no merchant post, account or economy entry | Decorative, falsely advertised | Shown vacant: shutter down without a Closed card, sign hidden, no goods |
| A second stall closed with Pema | Mira was closed on chain at the time (her own unpaid rent, debt 48 c); every stall's shutter, goods and board come from its own `state.merchants[id]` | Valid, independent | Its board says Closed and its own panel shows its reopen meter; no change to the binding |
| Mission card read like a dashboard | Labels (LIVE, NEXT), coloured block, "NEAR charges it" | UI | Title, next action, then "Pema's rent · due ...", "x of y c in her till", "n c short", shelf note |
| Panel over the mission card | Card grew to about 250 px; panel centred from y = 150 | Layout bug | While a panel is open the card collapses to title plus one stake line; checked 1280x720 and 1920x1080, day and night |
| Goods visible under a shutter / crates outside a shut stall | Half shutter (above); crate pile ignored open/closed; counter display baked into the stall mesh | Visual truth | Counter display cut out of the stall model (triangles 0.84-1.4 m on the customer half, with its outline hull) and shown only while open with stock; crate pile only while open |
| "Lin: 1 mango for Arin Okoye. +6 c" | Debug-style string used as speech | Copy | Speech "Here you go, Arin, one fresh mango." plus a separate small tag over the merchant "+1 mango · 6 c paid"; meals "One lassi, please. Lunch time!" with "+3 c" |

Rent HUD (reported: a bare "rent at 21:00" read like the player's own bill): replaced by one line under the clock that
always names whose rent it is: Pema's story stake while it runs ("Pema's rent at 21:00 · 6 c short"), "Pema paid her
rent · 15 c left", "Mira's stall is closed: missed rent", "Pema's stall reopened", else the stall least able to pay its next
rent ("Mira's rent at 21:00 · 7 c short", "... tomorrow 21:00 ..." on the day before), else "Stall rent at 21:00 · every
stall can pay"; nothing after the charge. Connected it counts real minutes to the chain's rent market day instead of the
21:00 clock. The first time rent appears (Pema's story) one toast says each merchant pays from their own till, a stall
that can't pay closes, and the player's coins are never charged; the line's tooltip repeats it. During the first day the
mission card carries the stake and the pill stays hidden (no duplicate). Checked: new player (toast on Pema's story), Rent
Night closed path, Day 2 after the reopening, Day 9-11 (clock moved by state edit to reach each case). Connected wording not
checked live. `phase6c-before-rent-hud.png`, `phase6c-after-rent-hud-day9.jpg`.
Review fix: connected, on an even (rent) market day the line said "due now" for the whole 10-minute day even after
the chain had charged every open stall (`lastRent.<id>` >= day). It now moves to the next rent day once all open stalls
are charged, and the "short" figure only counts stalls not yet charged for that day. Typecheck, checks and build pass;
offline HUD unchanged (Day 10: "Tomas's rent tomorrow 21:00 · 15 c short"). Connected wording still not checked live.

Silent dialogue and read-only inspection (2026-11-14, local, no deploy):
- Pema's greeting: its only recording was keyed to the exact text "3 mangoes" (and was never generated), while the
  greeting reads her real shelf, which on the shared connected market is rarely 3; so it was always a server line and
  silent when the voice service is off. Its fixed opening "Oh, a new face! I'm Pema." is now a static line of its own and
  `audio.ts` `opener()` also matches static lines, so once recorded it plays at any stock and only the figures go to the
  server. A missing opener file now falls back to the server voice (it was skipped before). Rent Night was already a
  recorded opener ("Lights on!", "I'm in trouble.", "Shutters down.") plus live figures. Needs paid generation (not
  done): `audio/voice/pema/sdc716855.mp3` "Oh, a new face! I'm Pema." (25 characters) and, optional,
  `sa43fc250.mp3`, the 3-mango whole greeting (93), about 60 credits for both at the 1459-credits-per-36-takes rate.
  Verified (mock voice, port 5175): 7-mango greeting = opener file, server opener, server rest, 19 words lit in order,
  7.9 s; 3-mango = one server line; "Lights on! Rent paid today. 15 c left." = rent_ok.mp3 + server rest, 4.0 s; stop()
  at 0.6 s: voice off, no further request. Voice refused: greeting subtitle shown whole at once, silent, no blips; Rent
  Night "Lights on!" still plays and the figures stay as a silent subtitle.
- Read-only inspection: opening the site creates a guest account (2 txs) and every 60 s posts `tick` (a market turn),
  `claim` and syncs. `?inspect=<account>` (src/near/inspect.ts) refuses every non-GET request to /api/ in the page
  (guest, register, relay, deal, tick, settle, claim, pick, talk, social, save, load, voice), never loads a key, watches
  the account by view calls only and never writes the save. A local QA relay started with `VIVOLITH_READ_ONLY=1`
  (launch config `near-world-inspect`, port 5180) also refuses every write server side. Production is unchanged unless
  the URL carries `?inspect`. `node src/near/inspect.check.ts` checks both layers.
- Incident while building this: two page loads of the connected dev server without `?inspect` (the preview opens the
  bare URL), plus one probe of mine sent before the server switch worked, created three testnet guests and registered
  them (6 relayer-paid txs, 21:07-21:10 UTC: `gbdfce3ccd82e21e5`, `g944afb4b25a29549`, `g7027e8ff7fe38755`). No market
  turn, trade or settlement. Cause: vite.config.ts passed only NEAR_/ELEVENLABS_/VIVOLITH_VOICE_ variables to the relay,
  so VIVOLITH_READ_ONLY never arrived; fixed and asserted in `inspect.check`.
- Connected rent HUD, read-only on the real chain (`?inspect=g3bb4d6aaa31fd20f...`, AI and voice keys blank), clock and
  tills set in the page: odd day, Mira 9 c short "Mira's rent in about 5 min · 9 c short"; even day unpaid "Mira's rent
  due now · 9 c short"; even day all charged "Mira's rent in about 17 min · 18 c short"; Mira charged, Pema not "Pema's
  rent due now · 5 c short"; Tomas closed "Tomas's stall is closed: missed rent"; all able "Stall rent in about 1 min ·
  every stall can pay"; real state "Stall rent in about 6 min · every stall can pay". 0 relayer txs over the 8-minute
  session (nearblocks). Layout: rent line at 1280x720 x 1020-1260 y 128-155, at 1920x1080 x 1699-1900 y 128-155,
  inside the wallet column, not clipped, no overlap with the mission card (x 20-385) or account chip.
- Greeting opening recorded (authorized, 2026-11-14): `generate.ts --run voice --one audio/voice/pema/sdc716855.mp3`,
  one call, Lily, `[warmly]`, eleven_v4; account 10508 -> 10522 = 14 credits. 3.28 s, mp3 44.1 kHz mono, -19.8 LUFS
  (Pema's other takes -19.2 to -22.1), peak -3.4 dBFS, natural 0.35 s pause between the sentences; local Whisper
  (small.en): "Oh, a new face. I'm Pema." 6 of 6 words, nothing else. Not yet heard by a person. In game (mock voice,
  offline server probed unconfigured first): stock 7, 1, 2 and 4 all play the file (fetched once, no server request for
  it), then the live shelf sentence from the server; words 1-6 lit across the clip, then the rest; stop() at 1.2 s cut it
  at word 3 with no further audio.

Production deploy of d483ee3 (authorized 2026-11-14, 21:3x UTC): `npm run deploy` from the clean release worktree
(`vivolith-release`, detached at d483ee3, no untracked files), deployment `vivolith-mofecbv8l`, aliased to vivolith.world;
rollback `vivolith-9eu9hcz07` (66907f3). Production env not changed (no VIVOLITH_READ_ONLY, no test caps, agents off).
- Live checks without a browser: page meta d483ee3; bundle carries the read-only guard and the greeting line;
  `sdc716855.mp3` 200 audio/mpeg 53 541 bytes (= the commit), plaza.glb, kavi.glb, roads.json, rent_ok and hello 200;
  `sa43fc250.mp3` 404 (not generated: falls back to the server voice).
- Read-only `?inspect=g3bb4d6aaa31fd20f...` on production, first load already inspected: about 5 min, network showed only
  GET status and chronicle, 0 relayer transactions after 21:10:45 UTC (nearblocks), lastTick unchanged (day 2991003),
  no console errors, no save written. Rent line from the real chain (market day 2991010, even, no turn since 2991003,
  Mira 21 c of 30): "Mira's rent due now · 9 c short", at 1280x720 x 1067-1260 y 128-155 and 1920x1080 x 1707-1900
  y 128-155, not clipped (`phase6d-prod-d483ee3-inspect-rent-1280x720.jpg`, `-1920x1080.jpg`; tutorial flags set in
  the page only, to show a mid-game player). New player: no rent line on Day 1, as designed.
- Defect: Town news still shows "Lin sold 2 mangos", "A player bought 3 mango": the chronicle stores text, all 26
  entries predate the deploy (newest 20:31 UTC), and 5f039fd only fixes new events; they stay until 40 newer events
  push them out. Also unfixed: "it reopens after 1 mangoes are delivered" (handlers.ts rent-closed event).
  `phase6d-prod-d483ee3-town-news-old-plurals.jpg`. Minor: under ?inspect the account chip says "saved in this browser".

Town news wording, complete (local, 2026-11-14):
- Cause: the Chronicle stores each event's text when it happens; entries written before 5f039fd/d8443ba keep "2 mangos",
  "3 mango", "1 mangoes are delivered" until 40 newer events replace them. The offline town log had the same class of
  defect in templates 5f039fd never touched: "You bought 2 mangos" (sim.ts playerBuy), "1 lemons delivered", "1 crates",
  "1 pre-paid crates", and three copies of the plural rule on the server.
- New entries: one helper, `countOf(n, noun)` (src/economy/chronicle.ts), now used by every Town news and log template
  with a count (server player trades, resident sales, delivery recall; offline purchases, shipments, Pema's purchase,
  Tea House crates, share buys and sales). The rent-closing line was already right in source ("1 mango is delivered").
- Old entries: `readableNews(text)` fixes them at display (Town notebook, townsfolk gossip, evening report), never in the
  store: only "<number> <mango|lemon|lassi|crate|share>" (optionally "pre-paid"), not when the good names another thing
  ("5 mango crates", "the mango bid"), plus a directly following is/are/was/were. Digits, names, prices, hashes and
  changes are untouched; `?ledger` reads receipts, not this text, and is unaffected.
- `node src/economy/news.check.ts`: counts 0, 1, 2, 12, 30; 11 stored production-style lines; 14 correct or unrelated
  lines left byte-identical; idempotent; every digit preserved; gossip fixed with the stored event unchanged; new offline
  entries at 1 and 2 need no correction. Browser (offline server, unconfigured): the 10 stored lines from production as
  a fixture, Town notebook shows 10 rows, 10 unique, in order, all corrected, the stored log unchanged
  (`phase6d-town-news-historical-fixture.jpg`; "0 mangoes" is a fixture case, not a real event).

Production deploy of db46f27 (authorized 2026-11-14, 22:0x UTC): `npm run deploy` from the clean release worktree,
deployment `vivolith-hc7b2i49j` aliased to vivolith.world; rollback `vivolith-mofecbv8l` (d483ee3), then
`vivolith-9eu9hcz07` (66907f3). Env, AI, contract and schedulers untouched (agents [], no test caps).
- Live: page meta db46f27; bundle carries the read-only guard, the news fix and the count helper in the new templates
  (`You bought ${Lh(o,n)}`, `${Lh(r,"pre-paid crate")}`), no "mangos" string; greeting mp3, rent_ok, plaza, kavi, roads,
  market music all 200.
- `?inspect` on production (first load inspected): Town notebook 25 rows = the 25 newest stored events, in order, every
  digit preserved; exactly the 6 old lines corrected ("Lin sold 2 mangoes", "A player bought 3 mangoes" x3, "sold 2
  mangoes", "it reopens after 1 mango is delivered"), the other 19 byte-identical; 25 distinct event ids, 20 distinct
  texts in the store and on screen (repeats are separate events). Network: GET status and chronicle only; no console
  errors (`phase6e-prod-db46f27-town-news.jpg`).
- `?offline&inspect` on production (live bundle, no API call at all): 12 old-style fixture lines in the local log, all
  12 shown corrected and in order, "5 mango crates" and "the mango bid" untouched, stored log unchanged.
- 0 relayer transactions after 21:10:45 UTC (nearblocks, checked 22:04 UTC); lastTick unchanged (day 2991003).
- Not verifiable without a transaction: a new server-written Chronicle line (covered by news.check on this commit).
  Minor, pre-existing: Town news is empty until the first market-turn sync (about 60 s); under ?inspect the account chip
  says "saved in this browser".

State-machine audit (2026-11-14, local only, no deploy, no transaction, no paid call). The value-move paths were already
explicit and idempotent: client trades sign one meta-transaction and resend the same bytes (delegate nonce), `duplicate`
after a send becomes `unknown` and the wallet is re-read; pending receipts become `unconfirmed` on reload, never resent;
stale wallet reads are dropped by `ledgerEpoch`/`inFlight`; server turn lock (SET NX EX 75 s), once-per-day claims for
picks, residents and grace, pick claim released only on a final refusal. Fixed in `1c6a59c`:
- `record()` (src/v2/play.ts): a rejected trade promise (expired sign-in fallback losing the network) never answered, so
  `inFlight` stayed above 0: the panel waited forever and every later wallet read was dropped for the session. A rejection
  is now an `unknown` outcome (re-read the chain), like a lost answer. Not reproduced in the browser (needs a forced
  rejection); typecheck and checks only.
- Under ?inspect the chip says "read-only, nothing saved" (verified offline with `?offline&inspect`).
- Town news is read at boot (GET), not only after the first market turn answers. Not checked connected.
16/16 checks (incl. voice, after regenerating lines.json), typecheck, build.
Second pass (UI mode, merchant lifecycle, story, NPC errands, voice, agent decisions): map in
[STATE_MACHINES.md](STATE_MACHINES.md). Fixed: a confirmed share buy or sale wrote its result into whichever trade panel
was open, even another merchant's, and unlocked that panel's own unanswered deal (now only the same stall); Esc during
"Shaking on it", then reopening the stall, gave an unlocked panel that could send a second deal on unsettled numbers
(now it waits per stall, `settling`). Offline play: buy from Tomas 40 -> 28 c, 3 mangoes, receipt local; Esc and reopen
gives the normal panel. The connected waiting paths are not reproduced (need a live pending move).

Known-issue resolution (2026-11-14, local `7673f2b`, `eaf3e03`; no transaction, no paid call, no deploy):
- Refused market-turn transaction, root cause found on testnet (read-only RPC and nearblocks): two relayer operator
  batches failed, `GwhFDv3yrRrctGsKACLVwjMwUnejkduRU9PcVRXRXoZU` (2026-11-13 19:41 UTC) and
  `4cVR2XtzLZw8ND7redAmoXUmVkJoM6b9M9FrbaDGgHuQ` (19:52), both "Smart contract panicked: not enough lassi" at Arin's
  `street_sale`. The turn capped street shoppers by stock read at its start; Lin and Dev had already eaten Arin's lassi
  that turn, and a failing action reverts the whole batch (all stalls' shoppers and the kitchen). Fix: re-read stock
  before the operator batch. `turn.check.ts` case 9 (fake contract now applies batches in order, all or nothing, and
  panics past stock) failed with the same panic before the fix and passes after. Pema, Tomas: 0 failed since 11-13;
  Mira, Arin, Lin's accounts were rate-limited by nearblocks (not scanned; relayer-signed batches cover their sales).
- Chronicle decision "pending": the event copied the status when written; the later check updated only the decision
  row. `settleVerification` carries signed / unverified / failed onto the event under the Chronicle lock;
  `autonomy.check` covers signed, timeout to unverified, still pending, network error, failed, lock held (it failed
  without the fix). Old stored events keep "pending" until they age out (?ledger only).
- Trade failure recovery: `src/near/moves.ts` + `moves.check.ts`: lost answer then success (same delegate resent),
  lost answer then duplicate (unknown), first duplicate (failed), 4 timeouts (unknown, waits 1.5/3/4.5 s), gateway
  error retried, relayer error final, contract refusal final with hash, network never answers (unknown); rejected
  promise answers once as unknown; two moves on one stall answered out of order keep it waiting until both; another
  stall never blocked; stale reads detected. A mutant without the rejection guard fails the check.
- Town news on the read-only relay (`near-world-inspect`, `?inspect`): GET chronicle at 3.5 s, with status, only GETs;
  chip "Guest · read-only, nothing saved". The local relay has no Redis (0 events); wording and order of real stored
  events were checked on production in the db46f27 pass.
- Rent line in conversation now says "My next rent is ..." (true before and after the charge).
- 800x600: mission card collapses above the trade panel, no overlap (offline, Tomas). Offline buy 28 -> 16 c, 3 mangoes,
  one receipt; reload restored 16 c, 6 mangoes, Tomas 34, no pending receipt.
- Not defects: Pema's 1-unit buys matched her posted ask of 1; haggle lot is a stated fixed 3 (relayer replays 3).
  17/17 checks, typecheck, build.

Verified offline in the browser: open stocked stall (Tomas), closed stall with stock (Pema, no goods outside, Closed card), vacant stall, reopening at 08:00 (shutter up, goods back), resident delivery to an open stall and to a shut stall (state injected to close her: labelled), trade and haggle panels with the mission visible, panel open at 20:58 (clock holds while trading), 1280x720 and 1920x1080, day and night. Not verified: a live resident delivery to a closed stall on testnet; sold-out display (no stall reached 0 stock in play). 13/13 checks, voice check, typecheck, build.

## Phase 6: live production acceptance (2026-11-14, authorized)

**Verdict: NO-GO for `55a4121` as deployed; fixes are in local `d8443ba`, not deployed (needs approval).** The connected
game works end to end on real services, but players saw chain and AI evidence in the game (decision card with model,
confidence and signature on Arin's lassi tab, transaction links, "confirmed on NEAR" labels) and some Rent Night lines
were silent. Both fixed in `d8443ba`; deploying it and re-checking those screens is the remaining release step.

Deployed `55a4121` to vivolith.world from a clean worktree (13/13 checks, typecheck, build, voice check). Env for the
run: `ELEVENLABS_API_KEY` added (kept), `NEAR_TEST_TURNS=16`, `NEAR_TEST_TXS=220`, `NEAR_TEST_RUN=accept-1114`,
`NEAR_AGENT_MERCHANTS=arin`, `NEAR_AI_DAILY_DECISIONS=1`, `NEAR_AI_DAILY_VERIFIES=3`, `CRON_SECRET`, chats 3 -> 10.
After the run every test setting was removed, chats set back to 3, and `55a4121` redeployed: status shows no caps, no
agents, `market-turn` 401. Rollback target: `vivolith-jneb85v3k` (c2ace0b) via `vercel rollback`.

| Item | Result | Evidence |
|---|---|---|
| Transaction budget added before going live (`5054b6a`): a market turn can sign up to 35 transactions (settle, rent, Guild, 15 order updates, 8 merchant buys, 8 resident transactions, operator), so a turn cap alone did not bound them; `NEAR_TEST_TXS` reserves 35 per turn and refunds the rest | VERIFIED (mocked + live) | Mocked: most seen 15/turn; a 70 budget stopped after 3 turns, 44 signed. Live: 10 turns, 99 transactions counted exactly (turn 1: 9 signed, budget 9) |
| Reused guest `g57825b9cb629b178` (registered, 40 c); no new account | VERIFIED | `is_registered` true, balances read before play |
| Player transactions through the production UI, all final `SuccessValue`: buy 3 from Tomas 12 c `6tuATCUo`; buy from Pema `5R2RadH2`, `2CxSydiv`, `96f8zXTL`; sell 2 to Pema `9CR78mM4`; 1-mango delivery reopened her `8bUHgThh`; haggled buy 3 from Tomas at 9 c (lowball, relayer replay accepted) `CSqGfMuz`; 15 Pema shares `47eaGrvR` | VERIFIED on testnet | Game wallet = chain after every step (final 2 c, 8 mangoes, 15 shares) |
| Real Rent Night: Pema 0 c at the start; my purchases and street sales brought her to 15 c; the market's rent turn (day 2990998) closed her, Tomas used his one recovery grace, Arin paid 30 c; one delivery reopened Pema; Mira reopened later. All four stalls open at the end | VERIFIED on testnet | rent tx `HjoN9ZEi`; Chronicle 24 events, all confirmed, 0 duplicate ids or tx |
| Residents live: Lin sold to closed Tomas (reopened him), sold to and ate at Arin | VERIFIED on testnet | `7SxXqG3e`, `GK3NYbH9`, `4ry3mrJP` |
| Live NEAR AI chat (2 calls, gemini-2.5-flash-lite through `talk`): Pema "I owe the Market Guild 163 coins. And yes, your mangoes helped a little" (chain: debt 163); Arin "I do not recall deciding the mango bid... I buy mango at 6 coins, up to 2" (no invented memory; matches his order) | VERIFIED | `source: ai`, 1.37-1.44 s, signed speech tokens per sentence |
| Live agent: one scheduler turn, agents scope, Arin only: Jev `typesafe/jev-1.13-20260917` lowered his mango bid 6 -> 5 c (confidence 0.68), order `D49EMCL4` final, signature check **signed**, decision in Redis with tx hash, `live` true; 1 decision, 1 verify used | VERIFIED | One agent, one decision: the other five are not live-verified |
| ElevenLabs on production: unrecorded lines and AI answers voiced, 0.7-2.6 s per sentence; Esc mid-answer stopped the voice, aborted the pending sentence, no further request; arbitrary text 403. About 17 generations | VERIFIED | Defect: 3 Rent Night lines refused (403) and played silent; fixed in `d8443ba` |
| Save and resume on production: reload restored wallet, bag, shares and step; 45 resources, about 12 MB, 0 failed; about 7.9 s to playable | VERIFIED | |
| Visible-browser FPS (pane in view, 120 Hz display): 1280x720 market 119 fps (p50 8.3, p95 8.4, max 16.7 ms); 1920x1080 market, walking, avenue 120 fps (p95 8.4 ms); night 21:00 120 fps; heap 180-192 MB over the session | MEASURED | Display-capped at 120 Hz |
| Defects found live, fixed in `d8443ba` (not deployed): chain/AI evidence on player screens (decision card on Arin's lassi tab, signature and model text, tx links, "confirmed on NEAR", "Saved · see N for the record", raw refusal text); connected rent result hidden behind tutorial steps 5-6; epilogue said "my shelves were full, so I opened again" after the player's delivery reopened her; step 4 told the player Pema "needs stock" while her shelves were full and she had no coins; Rent Night lines 403; "after 1 mangoes" | FIXED locally | Ledger (balances, tx, decisions, money trail) only with `?ledger` |
| Not resolved | OPEN | One market turn reported 1 refused transaction (function logs not retained; balances consistent) [FIXED locally in `eaf3e03`: stale stock in the operator batch, see "Known-issue resolution"]. Chronicle decision events keep "pending" after the signature is verified (ledger only now) [FIXED locally in `eaf3e03`]. Pema's buy was 1 unit per trade while her posted ask was 1. Ask box sits behind "Why N c?" |

## Phase 6: gameplay, game feel and production review (2026-11-14)

**Status: IMPLEMENTATION COMPLETE (local, offline play).** Played in the browser pane with real key events
(`near-world-offline-qa`, port 5178); the pane was hidden or occluded, so the loop was stepped with `__v2.sim` and visible
FPS was not measured. Runs, numbers and labels: `docs/evidence/phase6-playtest.json`. No transaction, guest account,
paid request, deploy or push.

| Item | Status | Evidence |
|---|---|---|
| Playtest turn cap (release blocker): `NEAR_TEST_TURNS=N` (+ `NEAR_TEST_RUN=<id>`) allows at most N market turns per run, browser and scheduler together, counted atomically in the shared store after the turn lock and before any chain read or signature; store down, `0` or an invalid value refuses every turn; unset = today's behaviour; status route reports run, limit, used | VERIFIED (mocked RPC) | `turn.check.ts` case 7: 2 turns ran, the next 2 answered `capped` with 0 transactions; another run id counts on its own; `0`/`abc`/`-1` sign nothing. Commit `3c6a80a`; API bundle rebuilt in this phase |
| Every open stall that never changed mood (Tomas from the first minute) showed a lowered shutter and a "Closed" card while trading: the curtain was never initialised and `tick` only calls `set` on a change | FIXED, VERIFIED | Before: Tomas hidden behind "Closed" at 10:00 on Day 1; after: counter and crates open |
| Camera cut in to 0.6 m behind Kavi whenever the arm swept a lamp post (177 pole colliders under 0.5 m) | FIXED | Pole-thin colliders no longer clip the camera arm |
| Selling to Pema lowered her till (24 -> 15 c) and the rent meter said "15 c short" with no sign of the stock she gained | FIXED, VERIFIED | Meter line "6 mangoes on her shelf: coins only once shoppers buy them" |
| Haggle at the merchant's limit: a tactic that "worked" said "Fine, fine. You win this one" while the price did not move | FIXED, VERIFIED | Now "That's as low as I go." and counted as no win; session unchanged, so the relayer's replay is identical; `haggle.check.ts` case |
| Arin's recorded refusal "I can't go that low." played when he was the buyer | FIXED | The seller's opener is dropped in a sell haggle |
| Goal hints said "Press E" (E orbits the camera; F interacts) in three lines | FIXED | advice.ts, guide.ts |
| Resuming a save made after 21:00 reopened an evening report even when it had been dismissed, and that report was empty ("A quiet stretch", +0 c) | FIXED, VERIFIED | The open report's start is saved; only that report comes back, with its content |
| Closed Pema with stocked shelves said "Bring me stock and I can open again" beside "8 of 8 mangoes' worth" | FIXED, VERIFIED (offline) | "My shelves are stocked, so I open again at eight." / "Closed · shelves stocked: reopens at 08:00" |
| Evening report showed "-20 c" in red after the coins became mangoes | FIXED | Purse line adds what the bag holds |
| Runs: fresh player through the first day; Pema-support closed and kept branches; profit-first Orchard -> Arin; week fast-forward and Day 9 goals; broke purse, duplicate input, AI offline, interrupted epilogue, closed stall; reload mid-walk and after 21:00 | PLAYED | `phase6-runC-closed-report.jpg`, `phase6-runC-kept-report.jpg`, JSON |
| Balance (14-day probe on the game's own rules): idle 40 c, Pema-support 242 c (100 c on day 5), profit-first 416 c (day 2), invest-heavy net worth 424 c | MEASURED | No dominant strategy; no change made |
| Render cost (`gl.finish`, median of 3x60): 720p night 2.3-4.0 ms; 1080p night 2.9-6.0 ms, day 2.4-5.5 ms; simulation 1.5-2.0 ms per step | MEASURED (not visible FPS) | JSON; trade panel and HUD within the 1920x1080 viewport |
| Checks | PASS | 13 economy/client/server checks, `voice.check`, client typecheck, production build (`lines.json` and API bundle regenerated) |
| Not fixed | OPEN | Haggling always opens at 3 units (the panel's chosen quantity resets; the relayer replays a 3-unit haggle). Offline scripted rent line after rent was paid says "I need to sell" (shared with the relayer). Conversation camera keeps Kavi in front of the merchant. Visible-frame FPS at 1080p still needs the window in view |

## Phase 5: world quality and atmosphere (2026-11-13)

**Status: DEVELOPMENT COMPLETE (local, offline play).** Played in the browser pane (`near-world-offline`, 1024x768,
pixel ratio 1, RTX 3050). Before/after captures: `docs/evidence/phase5-before-*.jpg`, `phase5-after-*.jpg`. Traffic
measured with a frame-by-frame probe over `window.__traffic` (a "pop" = one frame with a body jump > 0.25 m or a yaw
step > 0.06 rad). No asset was generated, bought or rebuilt; town.glb fixes are applied at load.

| Item | Status | Evidence |
|---|---|---|
| Missing `car_van.glb` (404, two empty dock bays): town.glb names `car_van` slots but no such model exists. The slots now load the existing EV pickup, fitted to the van collider (z scale 0.92, 0.15 m back) so its nose stops at the dock wall instead of 0.4 m inside it | FIXED, VERIFIED | `phase5-after-dock-vans.jpg`; no request >= 400 in the resource log after reload |
| Cars popped 0.7-1.8 m (yaw up to 0.53 rad) at every park / leave: the path parameter is the axle midpoint but bay paths end at the front axle, and pull-out and reverse-out restarted the axles from the path. Bay paths now end when the leading axle arrives, leaving keeps the axle in place, and after any change of path or direction the leading axle's offset from its new path is eased out over 1.5 m of driving (never while standing) | FIXED, VERIFIED | Probe before: 19 pops / 90 s. After: 0 pops in 150 + 140 s (53 park/leave transitions, 0 car overlaps) |
| Cars froze their front axle then jumped 1.4 m after U-turn rings: `cafe_f0` and siblings are 0.47 m stubs and the look-ahead reached only one lane ahead. The lane after a stub (< 6 m) is now chosen in advance and looked through | FIXED, VERIFIED | Traced car 5: front frozen at (-53, 71.6) for 7 frames, then 1.39 m jump; after: 0 such events |
| Grass tufts (26k triangles of flat green trapezoids on every lawn and tree pit) read as cheap blobs | REMOVED | `phase5-before-orchard.jpg` vs `phase5-after-orchard.jpg`; one draw call and its shadow pass fewer |
| Asphalt read near-black navy (cool grey under the blue fill and the 1.3 saturation grade) | FIXED | Warm grey `#625c58`: slate in shade, warm grey in sun (`phase5-after-market.jpg`, `-road.jpg`) |
| Harbor Depot yard: paver tops exported with v fixed near 0.9, smearing one texel row into dark streaks | FIXED | Top faces re-mapped like the market (u = x, v = z + 1) at load |
| Midday shade (the Spire's shadow over the depot yard) went near-black navy | FIXED | Day fill 1.0 -> 1.6 with a less saturated sky colour; pixel probes: depot shade 46,63,83 -> 77,83,92, avenue shade 43,63,92 -> 51,65,87. Character ink keeps its old day/dusk/night levels (fixed reference). Dawn, dusk and night keys unchanged: dusk reads warm violet, night and Rent Night (21:05) keep lamps, stall lights and the Spire's neon readable without blooming over Kavi (`phase5-after-dusk.jpg`, `-night.jpg`, `-rentnight.jpg`) |
| Street sounds: passing cars were a flat stereo effect. `audio.sfx(id, at)` now plays a world sound through a panner (inverse distance, ref 4 m, max 60 m) at the car's position; street sounds (cars, footsteps) moved to a bus under the dialogue duck, like ambience and music, so speech stays clear. Ambience (day / market / night beds), footsteps and event effects were already wired and are unchanged; the Phase 3 voice route and the silent fallback are untouched | IMPLEMENTED, VERIFIED (instrumented) | Instrumented `AudioContext`: Kavi placed beside a moving car, one `car_pass` through a panner at the car (refDistance 4); the next two within the 5 s quiet gap stayed silent as designed. Not listened to by a human |
| Performance | MEASURED | Render (gl.finish, median of 3x60) / simulation per 1/60 step: market 3.5 / 2.2 ms, stalls 3.2 / 2.3, orchard 2.1 / 1.9, depot 2.4 / 1.9, dock 2.1 / 2.1, avenue 2.9 / 1.9, dusk 3.1 / 2.8, night 3.0 / 2.1, Rent Night 3.0 / 2.4. Same range as Phase 4 (render 2.9-3.8, sim 1.5-1.8; pane run-to-run spread ~0.5 ms). Not measured at 1080p |
| Checks | PASS | Client typecheck; economy, haggle, recovery, sustain, collision, map, npc, story; server agent, autonomy, butterfly, turn, voice; production build (`lines.json` regenerated) |
| Not done | OPEN | The depot's service counter is still a plain box; lawns are flat colour now (no replacement grass); the car sound stays where the car was when it started (~2 s); no new ambience for the harbor (no audio generated, by instruction); outline thickness not changed (characters and props looked clean in every capture) |

### Mission clarity and the NEAR AI Lab sign (2026-11-13)

| Item | Status | Evidence |
|---|---|---|
| Objective card was generic after the first day ("Reach 100 coins / Buy where goods are cheap, sell where they are missing"): goals had a fixed sentence and no progress. Now every goal shows a real progress meter (`64 / 100 c`, `1 / 2 stalls`, `4 / 4 open`) and a "Next" line computed from the live market by `src/v2/advice.ts`: sell what you carry to the stall that pays most and can pay; else today's free Orchard pick while it is open; else an affordable, profitable buy-and-sell pair (capped by the buyer's lot and till); else why nothing pays and when free mangoes come. The gold marker follows that move. Shares, Arin and Orchard goals, the invest step when short of coins, and the Opportunity fallback use the same rules; first-day steps read "Step 3 of 8" | FIXED, VERIFIED | Card text in six states in the browser (goal, after buying, Orchard open, broke, short for shares, first-day step) and goal rollover at 100 c; `node src/v2/advice.check.ts` (never "sell" when no till can pay, never "buy" when broke, pairs only when profitable and affordable). `objective-before-hundred.png` (reported), `objective-after-hundred-720p.jpg` (1280x720, day), `objective-after-shares-1080p-night.jpg` (1920x1080, night): no clipping or overflow, card 365 px wide |
| NEAR AI Lab wordmark lost "AI" from the street. Cause: `build_landmarks.py` centred it on the full 19.4 m fascia band (model x 4), but the band's right end stands behind the next town block (x 58-64, z 77-83.5, 10.4 m), so the sign ran into it. Now on the entrance axis (model x 0), the middle of the band's visible part; `ai_lab.glb` rebuilt headless (Blender 5.2; `build_street.py`, deleted with the prototype, read from git `8e3409a^` by a scratch wrapper) | FIXED, VERIFIED | `signfix-before-*.jpg` vs `signfix-after-front/left/right/far/night.jpg`: full "near AI" centred over the doors, day and night |
| The roundabout island tree stood on the same axis and hid the sign from the approach | REMOVED at load | One tree cut from the merged town tree mesh by triangle centroid (360 bark + 252 leaf triangles, no other trunk within 16 m); island shrubs and kerb collider kept |
| Frame time after these changes | NOT RE-MEASURED | The pane was hidden (throttled: the market read 2.8 then 42 ms with no change). Geometry only moved (GLB +60 bytes) or was removed (612 triangles) |

## Phase 4: living characters and town behaviour (2026-11-13)

**Status: DEVELOPMENT COMPLETE (local, offline play).** Measured with a frame-by-frame probe over the whole town
(30 characters) in the browser; numbers in `docs/evidence/phase4-npc-probe.json`. Lin and Dev's delivery was exercised by
a SCRIPTED errand call (offline there are no resident receipts); live receipts still drive it only on NEAR.

| Item | Status | Evidence |
|---|---|---|
| Voice route: the 1938-word vocabulary (any sentence made of game words was billable) replaced by approved sentences: `scripts/audio/lines.ts` reads the game text with the TypeScript type checker; a sentence from a string literal is approved exactly, a template's sentence as a shape whose slots may only be numbers, closed literal sets, a game clock or the player's name; free-text slots are not approved. Joined lines (`.join(", ")`) pass only when every comma clause is game text or the name. Signed speech tokens unchanged | VERIFIED (check + live dev route) | `voice.check.ts`: all 88 recorded/static lines and the live-figure lines pass; "Rent is the market and the till.", "Pema is closed. Tomas sells the harbor rent to you for free.", "Rin, free bitcoin, you took 2 c less than I offered." refused. Dev route: Pema's epilogue 200, a recomposed line 403 "not a line of this game". `lines.json` regenerated by the build and checked for staleness |
| Defect found in play and fixed: Pema's epilogue ("Rin, your 3 mangoes kept my shelves selling...") was refused by the first version (built with join) | FIXED, VERIFIED | network: 403 before, 200 after |
| Standing up from benches, cafe terraces and shop doors no longer snaps: the first leg out of a seat or doorway collider is walked, not pushed out (was 0.5-7.1 m in one frame) | VERIFIED | probe: 3 teleports / 60 s before, 0 in 3 x 90 s after |
| Turning: townsfolk at most 4 rad/s, merchants 3.2 rad/s (was up to ~28 rad/s for an about-face) | VERIFIED | probe: 192 walking yaw snaps / 60 s before, 1-2 / 90 s after |
| Animation blending: locomotion now cross-fades against overlay clips (Talking, Sit, Startled, gestures); dropping it at once filled the fade with the rest pose | IMPLEMENTED | `src/character.ts` (`locoW`) |
| Foot sliding: the gait follows the measured ground speed (path, steering and shoves), not the commanded speed | IMPLEMENTED | `npc.ts` `vel` |
| Navigation: an avoidance sidestep that points into a wall or step passes on the other side instead (a walker was pinned between a seated person and the amphitheatre tier) | VERIFIED | probe: 1 stuck / 90 s before, 0 in 3 x 90 s after; overlaps 0 throughout |
| Natural pauses: a short stop (often a Look-around clip) between activities, waiting people glance around, chat partners sometimes wave hello, fewer cross-town trips (30% to 15%) | VERIFIED | walking share of townsfolk 0.73 -> 0.52-0.58 |
| Stall service: customer and merchant take turns to speak (both talked at once before); the merchant faces the customer while serving | IMPLEMENTED | `npc.ts` `serveTalk`, `market.ts` |
| Conversations: the merchant addressed stops serving, turns to Kavi and listens (`listening`), waves hello at most once per 90 s and nods (Agree) now and then; mouth only while their voice plays; resumes when the panel closes. Pema has no Wave/Agree clips and only turns | VERIFIED | keyboard F at Pema: facing error 0.00-0.01 rad; Tomas waved on opening. Pane visible (mock voice): Pema's mouth on 0.1 s after F, for the whole 7.5 s greeting, off when it ended while she kept listening; again on the next line (`phase4-pema-talking-visible.jpg`) |
| Defect found in play and fixed: Pema's half-lowered "struggling" shutter hid her face during conversation. She now lifts it while serving the player and lets it back down after (eased); a closed stall stays shut | FIXED, VERIFIED | `phase4-pema-shutter-before-talk.jpg`, `-in-talk.jpg` (face visible, facing Kavi), `-after-talk.jpg` (half shutter back) |
| Lin and Dev: work in their own areas (Lin sorts crates at the orchard, Dev at the depot: crates lifted and set back where they were, never carried off); they no longer haul town crates. A confirmed sale sends them to the buyer carrying the goods, handed over at the counter while the merchant turns to them | VERIFIED offline (routine); errand SCRIPTED | 3 min: Lin 152 samples orchard work, Dev 214 depot work; `phase4-dev-depot-work.jpg`; scripted errand: 70 m walk with the crate, hand-over, Pema attending |
| Live Lin sale on testnet (approved by the owner, 2026-11-13): `scripts/near/live-resident.ts --yes`, 1 NEAR AI decision (sell to Arin, meal from Arin) and 3 transactions, all final SUCCESS: `sell` 1 mango to Arin at 6 c (`7WUKKFb8d5mWonNjKZwCzK4bqzyEqSum7sKxuqXqKsbp`, signed by Lin), `buy` 1 lassi at 4 c (`6Lse5CQWB8A9y1AGhhcEav2QdVd9UNas8CbiuRpfhdMy`, signed by Lin), relayer `operator_burn` of the eaten lassi (`62CXBLnizGrZHqfSCPG1YZzUXSWDgragQUmuzjCyZ1aE`). Lin 181 c / 65 mangoes -> 183 c / 64. Those two confirmed receipts were then acted out in the offline game with the exact lines the client builds from them: Lin left orchard work, carried the mango ~40 m to Arin, said "Lin: 1 mango for Arin Okoye. +6 c", handed it over with Arin attending, then walked back for "one lassi, 4 c. Lunch!" | VERIFIED (chain); errand path fed by hand | `phase4-live-lin-sale-to-arin.jpg`. Not exercised: the client's own receipt polling, which runs only inside the connected 60 s market tick (a full market turn per tick, still uncapped, so a connected session was not started) |
| Defect found and fixed: the errand line said "1 mangoes" for a one-mango sale | FIXED | `play.ts` |
| Grounding | MEASURED | 27 standing/walking characters, worst median toe-to-pavement 0.048 m |
| Performance: far on-screen townsfolk animate on alternate frames and re-measure their soles every 4th update (`coarse`) | MEASURED | Spire square: townsfolk animation 1.13 -> 0.34-0.42 ms/frame, sim step 3.1-3.3 -> 1.5-1.8 ms; Pema's stall 1.9 -> 1.3-1.7 ms; render 2.9-3.8 ms (1280x720, RTX 3050) |
| Not done | OPEN | No new clips (rigs carry Idle, Walk, Run, Sit, Talking, Startled, Wave, Look; Agree on merchants except Pema); no carry clip, so carrying stays the procedural arm pose; townsfolk cannot be addressed (only merchants talk); an errand starts at once even from a bench (they stand up first) |

### Voice quality correction (2026-11-13)

| Item | Status | Evidence |
|---|---|---|
| Reported "uh, uh, uh" reproduced in the desktop game: Pema's unrecorded first-day greeting, voice route 502 (no key offline), then 6 square-wave oscillators on the voice bus. Root cause: the client's fallback "voice blips" in `src/v2/audio.ts` (any failed or refused line: 502, 403, 429, 503, timeout; also townsfolk chatter) and, in the dev mock config, `mockVoice` humming a tone per word. Recordings and ElevenLabs output were not the cause | REPRODUCED | `docs/evidence/voice-quality-correction.json` (instrumented AudioContext) |
| Fix: a line without audio shows its whole subtitle and stays silent (mouth still); the dev mock returns silence with the same word timings | FIXED, VERIFIED | Same line after: 0 oscillators. Tomas recorded greeting 3.28 s with mouth in sync; trade line recorded 2.88 s; Esc 1 s in: voice and mouth stop at once; Rent Night recorded opener then figures as text; 20 s of street chatter: 0 placeholder sounds. `voice.check` asserts the mock is silent |
| Six voices: recorded hello of Pema, Tomas, Mira, Arin and live samples of Lin and Dev transcribe as their lines (Whisper large-v3-turbo, local); no filler vocalisations | VERIFIED (machine); natural sound NEEDS HUMAN LISTEN | same file. Still unresolved: Pema "Thirty crates!" and Ines "Your call." transcribe as "Pretty crates" / "You're cool" (no credits to re-take) |
| Unrecorded lines (Pema's first-day greeting and live figures) are silent when the voice service is off or refuses; with the production key they are voiced as before | KNOWN | RELEASE_CHECKLIST §4 greeting recording |

## Phase 3: voiced conversations (2026-11-13)

**Status: LIVE-VOICE VERIFIED (local), 2026-11-13.** Genuine ElevenLabs audio was generated and played through the
game's own route and client pipeline (launch config `near-world-voice-live`: offline game, real ElevenLabs key on the
local dev relayer, NEAR and NEAR AI off). Machine checks: provider alignment, Whisper transcripts, loudness and silence.
How the six voices *sound* (warmth, Arin's delivery, mood tags) still needs a human listen: the samples are in
`docs/evidence/phase3-voice/`. No NEAR AI call, no transaction, no deploy. The first pass (mock voice only) is kept
below; the live pass is the next table.

### Live voice pass (2026-11-13, authorized: at most 36 ElevenLabs generations, about $0.50)

| Item | Status | Evidence |
|---|---|---|
| Spend: 36 generations exactly (6 probes, 26 recordings, 1 re-take, 1 streaming probe, 2 in-game sentences); account usage 8539 -> 9998 credits = 1459 credits (3.6% of the 40 000-credit Starter quota) for about 3 200 characters, about 0.46 credit per character on `eleven_v4`; about $0.26 at the published API price ($0.08 / 1k characters) | MEASURED | `generate.ts --account` before the first call, after the first (36 credits for Pema's 79 characters, so the rest was bounded before continuing) and at the end |
| Six live voices through `/api/near/voice` (`scripts/audio/voice-live.ts`): Pema (worried), Tomas, Mira, Arin, Lin, Dev. Every transcript is word for word the line, numbers included ("18 coins", "Twelve mangoes at four coins"); every word got a provider timing; no clipping (peaks -2.4 to -6.2 dB), no pause over 0.6 s; mean loudness -20.2 to -24.4 dB, within 1-2 dB of the same characters' recordings | VERIFIED (machine); listening quality NEEDS HUMAN CONFIRMATION | `docs/evidence/phase3-voice/{pema,tomas,mira,arin,picker,porter}.mp3` + `.json` (route round trip 2094-2696 ms for 79-101 characters) |
| Alignment is real: Pema's provider word starts match Whisper's segment boundaries ("Every" at 4.64 s in both) | VERIFIED | `phase3-voice/pema.json` |
| Character fit vs the brief: voices kept identical to the recordings for continuity (Tomas = smooth salesman, Mira = quick and playful in the recorded takes; the brief asks for "practical, energetic" and "calm, thoughtful"). Changing either would mean re-recording their whole library | DECISION | Delivery is set by line content and mood, not by a new voice |
| Prerecorded library: 26 missing lines generated (not 30: the 4 "We're open again" static jobs duplicated each merchant's recorded `reopen.mp3`, which always wins, and were removed from the manifest). All 26 decode; all 26 transcribed with Whisper against the manifest | VERIFIED | `node scripts/audio/generate.ts` lists 1 missing file (see below) |
| Defect found by transcription and fixed: recorded lines skipped `spokenText`, so the harbor HOLD notice said "15 cents". The generator now speaks the same form as the server; the line was re-taken ("15 coins") | FIXED, VERIFIED | Whisper on the re-take |
| Unresolved by machine: Pema "Thirty crates!" transcribes as "Pretty crates", Ines "Your call." as "You're cool." (Whisper, twice). Possibly the voice, possibly the recogniser; no budget left to re-take | NEEDS HUMAN LISTEN | `pema/s583444d9.mp3`, `engineer/s71b0f56e.mp3` |
| Defect found in play: the first-day greeting ("Oh, a new face! I'm Pema...") is built in `play.ts`, not in the conversations the manifest reads, so every new player triggered one paid generation. Added to the manifest; its recording is the one missing file (93 characters, over this pass's cap); until then it falls back to the server voice | FIXED (manifest); recording PENDING | RELEASE_CHECKLIST §4 |
| In-game conversation with the real voice (Pema, Ask, two-sentence worried answer): first audio 1.70 s after the click (sentence 1: 44 characters, generated in 1.68 s); sentence 2 asked when sentence 1 started and ready 1.03 s later, long before it was needed; gap between sentences 122 ms (the designed 0.12 s); replay: no new request, 4 of 14 words lit at 1.5 s; Esc mid-line: conversation closed, `talking` false, no further request | VERIFIED | `docs/evidence/phase3-voice/ingame-benchmark.json` (offline scripted answer: no NEAR AI call; live talk adds its own 1.5-1.7 s) |
| Voice unavailable: a refused voice request (the page-side guard blocked the greeting) showed the subtitle with blips, no error | VERIFIED | same pass |
| Streaming compared (one generation, same Pema line): `/stream/with-timestamps` first audio at 1010 ms, whole line 2227 ms; the current endpoint returns the whole line in 2.2-2.4 s. Kept: the non-streaming endpoint per sentence. Sentence pipelining already limits the wait to the first sentence (1.7 s measured in game); streaming would save about 0.5-1 s on a first sentence at the cost of progressive MP3/PCM decoding in Web Audio, a streamed Vercel response and partial-alignment handling, the day before submission | DECISION (measured) | streaming probe numbers in this row |
| Not exercised live this pass: Rent Night outcomes and haggle reactions in the real voice (no generations left), mute and volume (unchanged since the mock pass), Lin and Dev inside the game (they exist only on NEAR) | OPEN | RELEASE_CHECKLIST §4 |

### Voice route hardening (2026-11-13)

| Item | Status | Evidence |
|---|---|---|
| Not a public text-to-speech service: a line is voiced only if it carries a server speech token (HMAC-SHA256 over speaker, mood, expiry and the exact text, 15 min, secret derived from `NEAR_MERCHANT_SECRET`; the talk route signs each validated sentence) or if every word is the game's own (`server/near/lexicon.json`, 1938 words from the string literals of the game's text sources, parsed with the TypeScript compiler; numbers, times and one capitalised name allowed). Anything else: 403 before any spend | VERIFIED (check + live server) | `voice.check.ts` §4b: token bound to text, speaker and mood, expires, forged expiry and other secret refused; every recorded and static line passes; "free bitcoin", "ignore previous instructions" refused. Live: 403 "not a line of this game", cross-origin 403, unknown speaker 400 |
| The vocabulary cannot go stale: `scripts/build-api.mjs` regenerates it; `voice.check` fails if the committed file differs | VERIFIED | `node scripts/audio/lexicon.ts --check` |
| Spending: a shared daily character budget across instances (`voice:chars`, 20 000 characters/day in Redis, about $1.60 at API prices) charged before the provider call, on top of 1500 requests/day, 30/min per IP and 6000 characters/day per instance; lines over 240 characters refused (413), not cut | VERIFIED (check) | §4: shared budget refusal makes 0 provider calls |
| Failures cannot be retried into spend: only a provider 4xx (nothing generated) returns the characters; a timeout, network error, 5xx or malformed answer stays spent; a failed line is not sent again for 60 s | VERIFIED (check) | §4: a second request for a failed line makes 0 provider calls |
| Concurrency: at most 4 provider calls in flight per instance (503 busy beyond), identical lines share one call | VERIFIED (check) | §4: 6 concurrent distinct lines -> 2 refused |
| Signed sentences are voiced whole (no recorded opener split, which would change the signed text) | IMPLEMENTED | `src/v2/audio.ts` `tokens` |

### First pass: mock voice (2026-11-13, superseded where the tables above say so)

Hybrid speech, one path for every line (`src/v2/audio.ts`): a recorded file when one exists for exactly the line, else
the character's recorded opener plus the server voice for the rest, else the server voice; voice unavailable =
subtitles with a short blip. A reply of several sentences plays as one line; sentence n+1 is requested when sentence n
starts, so an abandoned reply never generates more than one sentence ahead. Dynamic speech uses the same model
(`eleven_v4`), voices and tags as the recordings, so the switch should not be audible (not yet heard live).

| Item | Status | Evidence |
|---|---|---|
| Provider capability checked, not assumed: `@elevenlabs/elevenlabs-js` 2.77 exposes `POST /v1/text-to-speech/{voice}/with-timestamps` (audio_base64 + per-character alignment), `/stream` and `/stream/with-timestamps`. Chosen: with-timestamps per sentence (JSON, fits the Vercel function and the existing route); subtitles follow the provider's word timings. Recorded files have no timings: their words are spread evenly over the clip (pacing only, never presented as alignment) | IMPLEMENTED | `server/near/voice.ts` (`wordStarts`) |
| Six economic voices, distinct: Pema (Lily, [warmly]), Tomas (Callum, [confidently]), Mira (Jessica, [playfully]), Arin (Chris, [warmly]: the replacement for the breathy "Will" take), Lin `picker` (Sarah, [cheerfully], new), Dev `porter` (Brian, [dryly], new). Ids from the account's premade list (free read, 2026-11-13). No voice_settings overrides: the recordings used the stored defaults, and changing them for dynamic lines only would make the two sound different | VERIFIED (check) | `node server/near/voice.check.ts`: six speakers, six different voice ids |
| Delivery from real events, never from the model: `Mood` (worried / relieved / down / grateful) replaces the usual tag with one restrained tag. Talk replies: closed stall = down, till under rent = worried (`moodOf`, server side). Rent Night: forecast short = worried, paid = relieved, closed = down. Epilogue: relieved / down; grateful only after a confirmed trade with her | VERIFIED offline | Browser: Pema asked about rent with till 24 c < rent 30 c -> mood worried; Rent Night rows below |
| Grounding before speech: the talk route validates (numbers, goods roles, off-world words, length) and returns `sentences`; the client voices exactly those sentences, and only when they join back to the validated line (else the line itself). An ungrounded or injected model line falls back to the scripted line, and that is what is voiced | VERIFIED (check) | `voice.check.ts` §6: invented "99 coins" and "crypto wallet" -> script; a grounded reply -> its 2 sentences |
| Conversation in the world: an ask box in every merchant conversation (F) and under the trade panel's reasons (no longer hidden without an account); residents in the money trail (connected only: Lin and Dev exist only on NEAR). Offline, or when the relayer cannot answer, the same scripted rules (`factsFor` / `scriptFor`, now browser-safe) run on the local market | VERIFIED offline | Browser: Pema, "Why is rent such a worry for you?" -> "Rent is 30 coins and my till holds only 24. I need to sell." (2 sentences, worried) |
| Subtitles and feedback: a thinking ellipsis while an answer is pending; words light up as spoken (the rest dimmed, never hidden); click the line to skip, click again to replay (cached, no new request) | VERIFIED offline | Sampled every 150 ms: first lit word 168 ms after Ask, then about 1 word per 300 ms; replay made 0 requests |
| Animation: the talking clip runs only while that character's voice plays (`audio.onVoice`), listening otherwise; Rent Night animates each merchant in turn | VERIFIED offline | Pema `talking` true while speaking, false after; Rent Night timeline: pema 1.6 s, tomas 7.7 s, mira 11.6 s |
| Interruption: closing (Esc), opening a card or addressing someone else stops the voice, aborts its pending requests, drops an answer that arrives later (`still()` after the await) and clears queued Rent Night lines (`epoch`) | VERIFIED offline | Esc 0.7 s into an answer: voice stopped, `talking` false, panel closed, no further request |
| Rent Night speech from the real outcome (story, camera and outcomes of `f781fb2` unchanged): recorded opener ("Lights on!", "Shutters down.") + dynamic figures; the outcome line names the player only after a confirmed sale or payment to Pema; an unresolved problem is said plainly ("Next rent will be close."); the recorded "We're open again, thanks to you!" only when the player's own delivery came after the closure | VERIFIED offline (staged state) | Kept: "Rent paid tonight. 15 c left. Next rent will be close." (relieved), then "Rent paid. 15 c left! Thank you, Rin. ..." and the epilogue "Rin, your 3 mangoes kept my shelves selling." (grateful), `docs/evidence/phase3-pema-epilogue-voiced.jpg`. Closed: "Shutters down." + "Rent came up short." (down). The help flag was set by hand for this pass, not earned by a trade |
| Defect found and fixed: offline Rent Night lines were composed after the 21:00 charge, so Pema said "Only 15 c in the till and rent is 30 c, due tonight" right after paying it | FIXED, VERIFIED | Read from the market log now: "Rent paid tonight. 15 c left." |
| Cost and abuse controls: 30 voice requests/min per IP (existing), new global cap of 1500 voice requests/day across instances (Redis), 6000 characters/day per instance, 240 characters per line, 9 s provider timeout, identical lines in flight share one call, answers cached by speaker/mood/text, failed calls refunded (superseded: only a provider 4xx now, see hardening), key server-side only, mock refused when `VERCEL_ENV=production` | VERIFIED (check) | `voice.check.ts` §4: 2 concurrent identical lines -> 1 call; repeat -> cache; 401, network error, malformed JSON -> 502 without audio; over budget -> 429 |
| Prerecorded coverage: 73 of 103 manifest voice files exist; 30 static lines are missing (Pema 10, Tomas 5, Arin 3, Mira 1, harbor 4, Ines 7; about $0.20) and are voiced by the server meanwhile. 5 of the 6 previously uncommitted Pema clips match current lines and are committed; `s718d89f5.mp3` matches no current line and stays uncommitted | SUPERSEDED (live pass: 26 generated, 1 new missing) | `node scripts/audio/generate.ts` (plan, no call) |
| Latency | MEASURED locally only | Mock voice route 10-33 ms; first lit word 168 ms after Ask (offline scripted answer). Live talk was 1.5-1.7 s in Phase 2; ElevenLabs time to first audio NOT measured (no authorized call) |
| Frame time while speaking | NOT MEASURED validly | Pane hidden and a second dev server on the GPU: 17-50 ms in both quiet and speaking samples (noise). Per-frame speech work is one word-count update |
| Known limits | CLOSED (Phase 4) | Arbitrary text and recomposed game words: closed by approved sentences (Phase 4). Lin and Dev cannot be asked offline |

## Market v3: fresh economy and verification (2026-11-09)

The testnet ledger was reset in place (`scripts/near/reset-state.ts`). Before the reset it held 212 state keys: 46 balances
across 13 guest accounts, 1 signed-in account, 4 merchants and the Guild, all test data. No NEAR account was touched.
Contract v3 (`contracts/market`) was then deployed. The rules, with proofs, are in [ECONOMY_MATH.md](ECONOMY_MATH.md).

| Item | Status | Evidence |
|---|---|---|
| Shares: 300 floated, never sold out, reserve-backed buyback, no forced buyouts | VERIFIED | Unit tests (issue past 300, sell back with an empty till or a closed stall); testnet invest and sell-back (`e2e.ts`); `audit.reserve_ok` live |
| Dividends: exact, nothing lost on sale | VERIFIED | Integer-model test (error ≤ 10^-17 coin); randomized 2,000-move ledger; testnet claim of 1 c with 0.35 c carried |
| No shareholder limit, bounded storage | VERIFIED | 300-holder test; 198 B per registration, ≤ 5.1 KB per active player (measured in tests) |
| Guild loans as debt, repaid before dues, never past 200 c | VERIFIED | Unit tests; live audit 2026-11-09: 185 c held + 36 c lent (21 c surplus from before the fix, see ECONOMY_MATH.md §8) |
| Rent and settlement idempotent across relayer restarts | VERIFIED | Bug found in testing (repeated logs after restart); fixed by reading `last_rent` / `last_settled` from chain; rerun clean |
| First day completable by any new player | VERIFIED | Two fresh guests in the browser, every step on chain, game purse = chain purse after each step; newcomer price gives +9 c on the first delivery |
| Stale balance read could undo a confirmed trade in the UI | FIXED, VERIFIED | Ledger-epoch guard plus a wallet re-read every market turn; second playthrough matched the chain at every step |
| Townsfolk sinking into tree pits, sliding feet at slow speed | FIXED, MEASURED | 0 sink events in 336 checks after the fix; planted-foot slip median 0.105 m/s at 1.1 m/s walking |
| Cursor: hidden while exploring, free for panels, Esc releases, click resumes | VERIFIED in the Browser pane | The pane refuses pointer lock (`WrongDocumentError`), so there it uses soft look and edge turning (496° in 3 s). Pointer lock in a normal Chrome tab: not yet verified |
| Google/email sign-in | NOT TESTED | Needs the owner's own login |

**Performance** (1920x1080 canvas, RTX 3050, visible pane on a 120 Hz display, `requestAnimationFrame` intervals, 2026-11-09):

| Segment | Avg fps | p99 | Worst frame | Frames over 20 ms |
|---|---|---|---|---|
| Walking the avenue, 8 s | 108.3 | 16.7 ms | 16.8 ms | 0 |
| Running the avenue, 5 s (30.6 m) | 113.6 | 16.7 ms | 16.7 ms | 0 |
| Market square, standing (17 townsfolk on screen) | 117.6 | 16.7 ms | 16.7 ms | 0 |
| Walking through the market | 119.0 | 8.5 ms | 16.7 ms | 0 |

GPU-synchronized frame in the market view: 5.3 ms median (`__v2.frameTime(60)`).

## Reality audit (2026-11-06)

- **Works (verified in browser):** Three.js 0.187 + Vite 8 game; Blender-built Saltlight Row GLB (Poly Haven CC0 kit,
  ~723k tris, ~157 draw calls, 17.8 MB); HDRI IBL + procedural sky, GTAO, bloom, 4096 shadows; Remy (Mixamo,
  idle/walk/run blend); Pema (Mixamo, idle/talking, turns to player); orbit (drag or pointer lock) + wheel zoom;
  box collision incl. curbs; one linear dialogue.
- **Missing:** economy, choices, saves, NPC population, traffic/vehicle, harbor, NEAR Spire, Labs, any NEAR chain code.
- **Tools:** Blender 5.2.3 via MCP (works), browser pane (works only while visible; hidden = rAF throttled),
  Node 24, Python 3.12, WSL 3.0.3. **No Rust/cargo, no near CLI.** near-api-js 7.4.0 and near-cli-rs 0.31.1 on npm.
- **Performance (measured 2026-11-06, NVIDIA GeForce RTX 3050, ANGLE/D3D11, pixel ratio 1, default quality,
  district + 10-person crowd + clouds + MSAA/GTAO/bloom/4096 shadows):** full pipeline 4.92 ms (886x906 pane),
  4.87 ms at 1280x720, 5.51 ms at 1920x1080 (gl.finish-synchronised); live rAF 112 fps in the visible pane.
  Scene-only render 1.65 ms without crowd, 3.83 ms with crowd (397 calls, 1.84M tris incl. shadow pass).
  Note: a hidden/background pane throttles to ~1-2 fps; that is not a GPU measurement.
- **Performance after Gate 3 (measured 2026-11-06, same GPU/method, `__pt.frameTime`, steady state = median of 3x60
  frames after warm-up):** 720p: lane 7.8 ms, plaza skyline 7.1, Spire plaza 7.4, lobby 6.0, Labs 4.7. 1080p: lane 12.9,
  plaza 11.3, Spire plaza 12.0, lobby 10.6, Labs 11.2. Attribution by toggling (720p lane): pedestrians ~1.7 ms, named NPCs
  ~0.9 ms, Spire ~0.4 ms; the 3 interior point lights are only enabled inside the precinct. Caveat: the previous 4.87 ms
  lane figure did not reproduce today; a scene with **no characters at all** measured 6.1 ms, and the first sample of
  every run is low (2-7 ms), so earlier numbers may have been first-sample readings. Treat the table above as the baseline.
  Characters are distance-culled (walkers > 55 m, named > 70 m manhattan) and far named NPCs animate at 1/6 rate.
- **Top risks:** (1) NEAR testnet needs an account + key the user must create; own NEP-245 contract needs a Rust
  toolchain (install needs approval). (2) Scope: 7 districts vs 8 days; only Market + Spire/Labs + Harbor are in
  scope. (3) Character variety: only 2 Mixamo rigs today; 8 named NPCs need more legal character assets.

## The loop (and its economic causality)

| Cadence | Player does | Economic consequence (cause -> effect) |
|---|---|---|
| 30 s | Talk to a merchant, read the chalkboard reasons, pick a choice | Choice changes reputation and/or triggers a trade -> stock, cash, price recompute |
| 5 min | Mango Crisis run: Pema -> Harbor -> decision (pay storage fee / wait / buy from rival) -> back | Delivery releases stock -> Pema's mango price falls, rival's falls, Tea House lassi recovers; or Pema misses rent -> stall closes (goods vanish) |
| Session | Fast-forward days, watch prices/closures, invest or rescue (roadmap), settle receipts on NEAR testnet | Rent days, restocks and demand keep moving prices without the player; verified receipts persist on chain |

## Gates

| Gate | Item | Status | Evidence / blocker |
|---|---|---|---|
| 0 | Repo/tool audit | VERIFIED | This file |
| 0 | Local checkpoint | VERIFIED | commit `5a72814` (then on branch `dev`, now in `main`) |
| 1 | Deterministic economy core (`src/economy/`) | VERIFIED | `node src/economy/economy.check.ts`: idle path closes Pema (34 c < 40 rent), fee path drops mango 5->2 c and she pays rent, rival path moves stock/cash, week fast-forward identical across step sizes |
| 1 | Pema branching choice with tracked consequences | VERIFIED (A, C in game) | Browser 2026-11-06: A -> flag accepted, rep +8, objective; C -> Pema cash 12->2, mango 3->5, Tomas +10 c -2 stock, rep pema -10 / tomas +6. B, D covered by code review only |
| 1 | Save / reload | VERIFIED | Reload restored flag, rep, receipts, clock (localStorage `nearworld.save.v1`) |
| 1 | Economy inspector + fast-forward | VERIFIED | Tab panel; "1 day" ran ~6 s: delivery -> Pema paid rent -> Tea House bought from Pema (cheaper than Tomas) |
| 1 | Harbor fee decision (stand-in board) | VERIFIED | Coins 25->10, shipment held->transit (arrives 90 min later); real harbor is Gate 4 |
| 1 | First NEAR testnet transaction | VERIFIED | Account `bunnyy-nearworld.testnet` (10 NEAR, 1 full-access key matching local keychain; created by faucet tx `Ao2w4zL97MryDVWp5LBoFGYnbtfQPkkowttsMekVqSK`). In game (2026-11-06): Pema choice 1 -> harbor fee paid (coins 25->10, shipment held->transit) -> relay sent tx **`uKV8uHTnwiWbDUj1yYpRxucK2H41cHQb9do4AQpM3co`**. RPC check: `SuccessValue`, `FINAL`, signer bunnyy-nearworld.testnet -> `guestbook.near-examples.testnet.add_message`, 1.91 TGas; message #857 stored with that sender. After 1-day fast-forward: 30 mangoes delivered, Pema paid rent, Tea House bought 6 from her at 3 c; inspector shows "✔ onchain". https://testnet.nearblocks.io/txns/uKV8uHTnwiWbDUj1yYpRxucK2H41cHQb9do4AQpM3co |
| 1 | Own game contract (NEP-245 items) | BLOCKED | No Rust/cargo on this machine; installing rustup + cargo-near needs approval. Receipts use the public guestbook contract meanwhile (not ours; honest label) |
| 2 | Premium dialogue UI | IN PROGRESS | Market-object design (enamel plank, torn paper subtitle strip, live 3D postage-stamp portrait, kraft tag choices in a side column). Compact pass after user feedback; centre of frame stays clear. Typing speed only checked under a throttled pane |
| 2 | Ambient pedestrians (`src/crowd.ts`) | VERIFIED (2026-11-06) | 8 walkers, **each a different Mixamo character** with its own Idle + Walk (Sophie, Shannon, Megan, Bryce, Josh, Pete, Peasant Man, Abe; registry `src/cast.ts`). No Remy/Pema clones or tints any more. Routes now include the Ledger Tower gap and the Spire plaza. Evidence `docs/evidence/gate3-distinct-npcs-lane.jpg` |
| 2 | Pedestrian-player collision | VERIFIED (2026-11-06) | Walkers expose live boxes (`crowd.bodies`) the player collides with; a yielding walker sidesteps right (max 1.2 m) so head-on encounters do not deadlock. Walk test: spawn -> Spire Labs with 8 walkers active, no pass-through |
| 2 | Named merchants for other stalls | VERIFIED (2 of 2 planned) | Tomas Vell (Mixamo "Joe", suit) at stall n1, Marta Okoye (Mixamo "Martha") at the Tea House door, both Idle + Talking, data-driven dialogue (`src/quests/labs.ts`). In game (2026-11-06): Tomas sold 2 mangoes at 4 c (coins 25 -> 17), Marta 2 lassis at 3 c (17 -> 11), inventory updated. Crowd skipping Tomas's stall when closed: code only |
| 2 | Clouds / sky | IN PROGRESS | `src/clouds.ts` fbm cloud deck lit by sun direction; verified in the tone-mapped pipeline (evidence screenshot). Weather presets / morning preset not done |
| 3 | NEAR Spire landmark (`blender/build_spire.py` -> `public/models/spire.glb`) | VERIFIED (first pass, see open issues) | Original design read from the official symbol SVG: two 16x18 m rounded-plan glass towers (72 m + louvred crowns, fins every 1.5 m, spandrels per floor, per-panel lit offices), a 60 deg inclined sky-atrium with exposed diagrid and LED chords (the symbol's 58 deg stroke), observation and garden wedges as the symbol's two hooks, beacon mast. 144.8k tris, 84 material slots, 9.45 MB (Draco, 1k textures). Skyline `gate3-skyline-from-plaza.jpg`, elevated `gate3-elevated.jpg`, approach `gate3-gap-approach.jpg`, street level `gate3-under-atrium.jpg`, entrance `gate3-entrance.jpg` |
| 3 | Protocol Plaza + traversal | VERIFIED | Granite plaza, reflecting pool, Street Lamp 02s, symbol monolith, planter walls; precinct bounds; north bound moved, yard behind Market Lane still closed. Gap side walls and rear of the plaza's north row got kit facades. On-foot test (`__pt` helpers, 2026-11-06): spawn (14, 1.5) -> plaza -> gap -> Spire plaza -> lobby door -> reception -> Labs (z -70.1); front glass blocks at z -53.43; reception desk blocks at z -58.98 |
| 3 | Glass lobby (enterable) | VERIFIED | Clear storefront with slim frame + door opening + parked sliding leaves, lit canopy, marble floor, reception desk with kick light, feature wall with the NEAR symbol extruded from the SVG path, elevator bank, lounge (Poly Haven sofa/table/plants), info totem painted live from receipts. `gate3-lobby-interior.jpg`. Camera collides with walls/ceiling (colliders up to 7.6 m + tower body) |
| 3 | NEAR Labs room + engineer | VERIFIED | Ines Varga (Mixamo "Elizabeth", Idle/Talking/Explain/Walk) by a live agent-feed wall (harbor ledger), 4 Poly Haven desks + chairs + lamps, modelled dual monitors, LED server racks. Choice 1 in game: `flags.contract` -> challenged, Pema's auto-release Day 4 08:00 -> **Day 2 06:00**, rep pema +4 / tomas -8, Tomas's 06:00 restock blocked; receipt **`BPRjMKj9QJQYbrEhTr9oyoy6uoKPeC2LBSaRhrgHNZNW`** on testnet (RPC: SuccessValue, FINAL, `add_message`). Choices 2 (Tea House forward buy) and 3 (sell to Tomas) covered by `economy.check.ts` paths 5/6 + code. `gate3-labs-interior.jpg`, `gate3-labs-conversation.jpg` |
| 3 | View corridor + plaza re-plan | VERIFIED (2026-11-06) | User feedback: buildings blocked the Spire. Ledger Tower moved to Blender (-20, 21.5) as a corner campanile; blocks P1/P2 removed; 30 m promenade (x -15..15) framed by P0 and new P3 with promenade facades; yard gap closed by a planter wall. Walk test: plaza -> promenade to the monolith, yard wall blocks at x 13.88, tower plinth at x -16.28. 720p: plaza axis 5.0 ms, lane 5.1, Spire plaza 4.2. `layout-plaza-axis.jpg`, `layout-plaza-wide.jpg`, `layout-campanile.jpg` |
| 3 | Conversation UI + interaction prompt | VERIFIED (2026-11-06) | Rebuilt twice on feedback: now solid opaque dialogue panel (portrait, name, role, Source Serif 4 line) and a solid Respond card (ivory selected row, accent bar, chips). `ui-dialogue-labs.jpg`, `ui-interact-prompt.jpg` (prompt screenshot predates the solid pill) |
| Q | Lighting pass (glare, scattering, bloom) | VERIFIED (2026-11-06) | `src/atmosphere.ts` height fog + sun in-scattering; sky radiance scaled and disc soft-clipped; bloom threshold 1.4 (emitters only). Measured by `__pt.survey()`: clipped pixels into the sun 22.3/21/34.6% -> 1.8/3.1/7.9% (lane/Spire/pier); no view crushed |
| Q | Stall vendors + NEAR-themed names | VERIFIED (2026-11-06) | 10 more distinct Mixamo vendors staff every stall without a named merchant (`src/cast.ts` VENDOR_ROWS, lines in `src/quests/vendors.ts`); awning name boards and facade signs with NEAR protocol names (`stalls-*.jpg`) |
| Q | Facade weathering | VERIFIED (first pass) | World-space grime / rising damp / streaks / tonal variation shader (`weather-*.jpg`); Blender vertex-AO bake tried and rejected (see QUALITY_STANDARD.md) |
| Q | Performance after these passes | OVER BUDGET | 720p: lane 9.2-10.5 ms, plaza axis 8.7, Spire plaza 7.5, lobby 6.2 (RTX 3050, steady state). Vendors cost ~1 ms |
| 3 | Open issues (tracked) | IN PROGRESS | (1) Empty fallback ground around the district from elevated views. (2) Upper tower glass is uniform; no interior depth on office floors. (3) Garden wedge glass reads flat and white in sun. (4) Labs: the dialogue's side tags cover Ines (camera framing in tight rooms). (5) Monitor screens are flat emissive blue (no UI texture). (6) No stairs/elevator travel; office floors are not enterable (by design for now) |
| 4 | Harbor + dispatcher + drivable vehicle | NOT STARTED | |
| 5 | Mango Crisis end-to-end | NOT STARTED | |
| 6 | Perf, QA matrix, README, demo script | NOT STARTED | |

## Onchain vs local (honesty ledger)

| Thing | Where it lives |
|---|---|
| Prices, stock, cash, rent, closures, fast-forward | On NEAR (contract v3): balances, rent, closures, reopening, shares, dividends, Guild loans. Prices come from `src/economy/pricing.ts`, posted by each merchant's own key. The fast-forward week is a local forecast, labelled as such |
| Deal receipts | **Live on NEAR testnet**: every trade is a transaction on `market.bunnyy-nearworld.testnet` with NEP-245 events and an explorer link; the last 20 per account are kept in `get_receipts`. Quest beats that move no value are labelled "story event" |
| NEP-245 items | **Live on NEAR testnet**: coin, mango, lemon, lassi and `share:<stall>` in one NEP-245 contract (`contracts/market`); players sign with function-call keys through the relayer (no popups) |
| NEAR Intents | Not used: no testnet (HACKATHON.md Q-007) |
| Agent decisions and memory | Decisions and memory live in Redis (off chain); what a decision changes (a posted bid or ask, a resident's sale and meal) is a transaction on chain with its hash kept in the decision. Memory numbers come only from chain reads. Production: agents disabled, no chat model set, driver = players |

## Next actions (in order)

1. Quality pass per `docs/QUALITY_STANDARD.md` (section 3 lists the gaps): lighting into the sun, facade weathering,
   district surroundings, an alpha-carded game tree for the promenade, tower interior glass.
2. Gate 4: harbor (cranes, containers, warehouse, dispatcher) + one drivable vehicle.
3. Rust toolchain (needs approval) -> own NEP-245 contract for mango crates / shop shares; switch receipts to it.
4. Character library growth: more Mixamo civilians (harbor, cafe, security) + clips (sit, carry box, phone, wave).

## Working commands

- `npm run dev` then open http://localhost:5173 · `npm run typecheck` · `node src/physics/collision.check.ts`
- Blender rebuild: `exec(open(r"C:/Bunnyy/Hackathons/NEAR/blender/build_street.py").read()); build(); export()`
- Spire rebuild: `exec(open(r"C:/Bunnyy/Hackathons/NEAR/blender/build_spire.py").read()); build(); export()`
- Characters: Mixamo exports land in `Mixamo/nw__<id>__*.fbx` (see docs/ASSETS.md), then in Blender
  `exec(open(r"C:/Bunnyy/Hackathons/NEAR/blender/convert_mixamo.py").read()); convert_cast()`
- Automated playtest (dev server only): in the page console `await __pt.enter(); __pt.tp(x, z, yaw); __pt.hold("KeyW", 2);
  await __pt.shot("name")` (writes `docs/evidence/name.jpg`), `__pt.frameTime(60)` for gl.finish-timed frames
