# Verification: every claim, where it lives, how to check it

Each row names the code that implements a claim, the check that exercises it, and public evidence on NEAR testnet.
Anything not in this table is not claimed. Commands need no keys.

| Claim | Code | Check | Public evidence |
|---|---|---|---|
| Coins, goods and stall shares are tokens in one NEP-245 multi-token contract (`mt_transfer`, balance and supply views, standard `nep245` events) | `contracts/market/src/lib.rs` | `cd contracts/market && cargo test --features upgrade` (55 unit tests; run in CI) | `npm run verify` prints the code hash, NEP-245 supply and decoded events |
| Each merchant is its own NEAR account and posts its own asks and bids | `server/near/keys.ts` (a function-call key per merchant), contract `list` / `bid` (merchant-only) | `npm test` (`turn.check.ts`) | `pema`, `tomas`, `mira`, `arin` `.bunnyy-nearworld.testnet`; tx `CznTaWJh…` is signed by `arin.bunnyy-nearworld.testnet` |
| A player trade is a real transaction, signed by the player's own key and relayed: no wallet popup, the relayer pays gas | `src/near/chain.ts` (signs a NEP-366 delegate), `server/near/handlers.ts` `relay` (our contract only, `buy`/`sell`/`deal` only, zero deposit, bounded gas, game accounts only) | `npm test` (`turn.check.ts` case 14, `inspect.check.ts`) | tx `2eXEpbbC…`: a new player buys 3 mangoes for 9 c |
| A haggled price is one the merchant signed: the contract checks an ed25519 signature, an expiry and a per-player nonce | contract `deal` / `deal_message`; `server/near/handlers.ts` `deal`; `src/economy/haggle.ts` | `npm test` (`haggle.check.ts` tries every 3-move tactic sequence on 96 stall states) | `verify.mjs`: "player sells 3 mangoes to Pema at a price Pema signed" |
| Rent is charged on chain; a stall that cannot pay closes, and a delivery reopens it | contract `charge_rent`, `deal`; `src/economy/recovery.ts` (rules shared by relayer and model) | `npm test` (`recovery.check.ts`, `turn.check.ts`) | rent turn `GNcCYF74…` (Mira closes 1 c short); delivery `7ywzZnoq…` reopens Pema; the Chronicle records "Pema's stall reopened after a delivery." |
| Shares pay dividends from every later sale, backed by a reserve; a buy-back pays exactly the backing | contract `settle_day`, `claim`, `get_pending` | `cargo test --features upgrade` | `verify.mjs`: invest `eyF1JCdx…`, buy-back `HzKujJMX…`, settlement `7g4zoX9s…`, claim `J3qmH7oT…` |
| NEAR AI makes bounded economic decisions for the four merchants and resident Lin; the rule decides whenever the AI cannot | `server/near/agent.ts` (Jev `typesafe/jev-1.13` on `cloud-api.near.ai/v1/systemone`: picks one named option built from real orders, inside a price band, with a 0.5 confidence floor; otherwise `src/economy/pricing.ts`) | `npm test` (`agent.check.ts`, `autonomy.check.ts`) | Chronicle (`GET https://vivolith.world/api/near/chronicle`): 13 of the last 40 events were decisions, each labelled `source: ai` or `rule`; tx `CznTaWJh…` (AI lowers Arin's bid 6 → 5 c), `CqWCNMNa…` (Lin's AI-chosen meal) |
| A decision's NEAR AI signature is checked against the exact request and response bytes | `server/near/verify.ts` (ed25519 over the hashed bytes; the signer must appear in NEAR AI's attestation report) | `npm test` (`autonomy.check.ts`: altered response, unattested signer and wrong signature all fail) | Chronicle decision events carry `verification: signed`. Not checked: the TEE quote inside the attestation report |
| Free-form conversation is phrased by a NEAR AI chat model but cannot invent facts | `server/near/talk.ts` (every number must appear in the chain facts, no chain or AI words, 280 characters; otherwise a scripted line) | `npm test` (`autonomy.check.ts`) | `docs/media/ask-merchant-grounded.jpg`: Pema's answer matches her on-chain till and rent |
| Voice is generated only for sentences the game can produce | `server/near/voice.ts`, `server/near/lines.json` (built by `scripts/audio/lines.ts`), `lines-match.ts` | `npm test` (`voice.check.ts`) | `POST /api/near/voice` with arbitrary text answers 403 |
| Coin is conserved: it enters only as starter purses and street shoppers and leaves only as rent and harbor freight | contract `audit`; `src/economy/turn.ts` (a model of the market turn) | `npm test` (`recovery.check.ts`, `economy.check.ts`) | `npm run verify`: "Audit (computed by the contract from live state): OK" |
| Anyone can inspect any player's wallet without writing anything | `src/near/inspect.ts` (refuses every write route in the page) | `npm test` (`inspect.check.ts`: 15 write routes refused) | `https://vivolith.world/?inspect=<account>` |

## Simulated, and labelled so in the game

- The week fast-forward (key T) runs on a copy of the town; its clock reads "forecast, not real trades".
- Walking townsfolk, cars and the day-night look.
- Offline play (`?offline`, or no relayer configured) runs the same rules locally and says "Playing offline".

## Not built or not verified

- Resident Dev (`porter`) is configured as an agent but has no NEAR account, so his choices change nothing on chain; only Lin trades on chain.
- Google sign-in (Auth0): the authorize redirect is verified; a completed sign-in needs a person's Google account and
  was not tested end to end.
- NEAR Intents and Chain Signatures are not used.
- The TEE quote in NEAR AI's attestation report is not validated, so the game never says "verified".
- Haggle reputation and the tactic list come from the client; the relayer replays them and only signs a price inside
  the stall's window, so a modified client can reach no price outside it.
- The contract's unit tests could not run on the author's Windows machine on 2026-11-14 (Application Control blocks
  Cargo build scripts); they run in CI.

## The transactions above

NEAR testnet, decoded by `npm run verify` through public archival RPC:
[`GNcCYF74…`](https://testnet.nearblocks.io/txns/GNcCYF74wPsEEYTnMJayb5sp8aWuHsemQVbL2eV3WHnr) rent turn ·
[`2eXEpbbC…`](https://testnet.nearblocks.io/txns/2eXEpbbCjnU3UeGXB29bEC8XsijDNphf6gBH76Zx9dog) buy ·
[`7ywzZnoq…`](https://testnet.nearblocks.io/txns/7ywzZnoq1c5UxqYMZRQGpFXMX5zmXGh2A8hrKap6PS4F) reopening delivery ·
[`CznTaWJh…`](https://testnet.nearblocks.io/txns/CznTaWJhctgxL7RSMYubwUMyU5vGJBJUb62uaZEXuFBa) AI-priced order ·
[`CqWCNMNa…`](https://testnet.nearblocks.io/txns/CqWCNMNaYgqE3mpj2bRxDEPfhUTmkCRuhZZduSy1ynsE) Lin's meal.
