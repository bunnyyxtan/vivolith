# VIVOLITH state machines

Where each piece of game state lives, who may change it, and the rules that must always hold. Read this before
changing trades, rent, the story, the voice or the market turn. Audited 2026-11-14 against production play.

Rule of thumb: **connected, the chain decides value and open/closed; the browser only mirrors it.** Offline
(`?offline`, or the relayer unconfigured), `src/economy/sim.ts` decides the same things locally and every receipt says
"local".

## Value moves (player trades, haggled deals, shares)

| | |
|---|---|
| Code | `src/near/moves.ts` (`relaySigned`, `moves()`; checked by `moves.check.ts`), `src/near/chain.ts` `act`, `src/v2/play.ts` `record`, `server/near/handlers.ts` `relay`/`deal`, contract `deal` |
| States | Receipt: `pending` -> `onchain` / `failed` / `unconfirmed` (`local` offline). TxOutcome `unknown` maps to `unconfirmed` |
| Source of truth | NEAR. The game applies coins and goods only in the `confirmed` callback, then re-reads the wallet |
| Invariants | A move is signed once; retries resend the same bytes (delegate nonce: at most one lands). A haggled deal is single-use (contract nonce per merchant and player, expiry). `duplicate` after an earlier send is `unknown`, never success. A rejected promise is `unknown` (never stuck). A wallet read older than a move sent or answered is dropped (`ledgerEpoch`, `inFlight`). Pending receipts become `unconfirmed` on reload and are never resent (`save.ts`) |
| Panel lock | `mode.done = AWAITING` while a move with that stall is unanswered. `settling` counts them per stall: reopening the panel after Esc stays locked. Only answer callbacks for the same stall (`mode.id === id`) unlock it |

## Market turn (server)

| | |
|---|---|
| Code | `handlers.ts` `tick`, `claimTick`, `claimOnce`/`releaseOnce`, `ops.ts` |
| Rules | One turn at a time everywhere: Redis `SET NX EX 75` (outlasts the 60 s function limit). Once-per-market-day claims: orchard pick, each resident's day, rent grace. A claim is released only after a final refusal (nothing happened); a send with no answer keeps it. Rent and settlement are also once per day in the contract. A batch of actions is all or nothing: the operator batch re-reads stock after the residents' and merchants' trades, because one street sale past real stock reverts every action in it (turn.check case 9) |
| Fails closed | Store down = no turn, no paid call, agents halted. Test caps `NEAR_TEST_TURNS`/`NEAR_TEST_TXS` reserve before signing |
| Posted book | `ruleOrders()` is the one rule for every merchant's standing orders. The turn posts them in step 1 and re-posts the changed ones at its end (3b); a player's confirmed trade calls `reprice` for that stall. A lever order stays at its NEAR AI price for the day only when the decision was genuinely AI (`source: ai`, tx); the turn plans its merchant trades and shoppers with that price, and the game shows it (`syncAgentPrice`, refreshed on every sync) |
| Autonomy | `NEAR_AGENT_MERCHANTS` (which agents) + `NEAR_AGENTS_IN_PLAY=1` (turns driven by players' browsers may ask NEAR AI, not only scheduler turns). Bounded by one decision per agent per market day and `NEAR_AI_DAILY_DECISIONS/VERIFIES/CHATS` (defaults 200/200/300); kill switch `scripts/near/agents.ts halt` |
| Dangerous | `tick`, `settle`, `claim`, `pick`, `guest`, `register`, `relay`, `deal`, `reprice`, `market-turn` all write to testnet. Opening the connected game at a bare URL creates a guest and ticks every 60 s. For QA use `?inspect=<account>` with a dev server started with `VIVOLITH_READ_ONLY=1`, or `?offline` |

## Merchant lifecycle

| | |
|---|---|
| States | `open` / `closed` (`state.merchants[id].status`). "Struggling" (till under rent) is a mood shown by the lantern, not a state |
| Connected | Written only by `syncMerchants` from `get_stalls` (and only if no move was sent or answered during the read). `reopenNeed.<id>` = need minus delivered |
| Offline | `sim.ts`: rent at 21:00 closes a stall that cannot pay; `tryReopen` opens it when `reopenGap` is 0 |
| Invariants | A closed stall shows its shutter, no goods, its reopen meter; buying from it is refused (`haggle.ts`), selling to it is a delivery toward reopening |

## Pema's night (story) and the tutorial

| | |
|---|---|
| Code | `src/v2/story.ts` (`night.outcome`), `src/v2/guide.ts` (`flags.tut`, index into `STEPS`) |
| States | Night: not started -> running -> `kept` / `closed` (+ `night.recovered` once she reopens). Write-once: `resolve` never overwrites |
| Rule | Connected, only the chain's rent (`lastRent.pema` >= due day) or her closure decides; the clock alone never does (`story.check.ts`). Tutorial steps advance only on their completion test against the state |

## Agent decisions (NEAR AI merchants and residents)

| | |
|---|---|
| Code | `server/near/agent.ts`, `memory.ts`, `verify.ts`, `ops.ts` |
| Separation | Model output is a *decision* (stored in Redis with source, confidence, band). It becomes an economic action only as a transaction signed by the merchant's own key inside today's price band; the decision row then carries the tx hash. `live` = confirmed, this market day, and still posted |
| Signature | `none` (rule) / `pending` -> `signed` / `unverified` (no signature after 3 tries) / `failed`. Never shown as "verified" (TEE quote not checked) |
| Repeats | Browser ticks only replay a decision already stored for the day (no paid call). Memory rows are one per agent per market day, idempotent |
| Chronicle copy | A decision event copies the status when the turn writes it; `verifyPass` carries the final status (signed, unverified, failed) onto it with `settleVerification` (ledger.ts). "pending" means the check has not finished, never that it passed. Events stored before this fix (2026-11-14) keep "pending" until they age out |

## Conversation, voice and UI mode

| | |
|---|---|
| UI mode | `play.ts` `Mode`: `walk` / `trade` / `talk` / `card`. `endPanel`, `openCard`, `closeOverlay` are the only exits; leaving a trade or talk panel calls `hush()` (stops voice, drops the pending answer) |
| Voice | `audio.ts`: every new line bumps `lineSeq` and aborts the previous request; a stale piece checks `my !== lineSeq` and stops. The mouth moves only while audio plays (`onVoice`). Server voice speaks only approved sentences (`server/near/lines.json`, generated: run `node scripts/audio/lines.ts` after changing any game text, or `voice.check.ts` fails) |
| Connection | `chainStatus()` is read once per page: configured -> connected, else offline for the session (chip says "Offline"). `?inspect` shows "read-only, nothing saved" |

## Checks (no network, no credits)

`npm run typecheck`; every `*.check.ts` with `node <file>` (17 files, including `moves.check.ts` for trade failures, including `turn.check.ts` for turn caps and locks,
`inspect.check.ts` for the read-only guards, `story.check.ts`, `voice.check.ts`); `npm run build` rebuilds
`api/near/[route].js`.
