# AGENTS.md

Guide for coding agents working on VIVOLITH. Start with [README.md](README.md) (what the game is and how to try it),
then [docs/VERIFICATION.md](docs/VERIFICATION.md) (every claim mapped to code, checks and transactions).

## What this is

A browser 3D trading game. Four merchants with their own NEAR testnet accounts sell fruit and lassi; stalls pay rent on
chain and close when they cannot; players trade, haggle and buy stall shares through a relayer, with no wallet. NEAR AI
makes bounded price and resident decisions. Production: https://vivolith.world.

## Entry points

| Concern | Start here |
|---|---|
| Game boot | `index.html` → `src/v2/main.ts` → `game.ts` (renderer, level) and `play.ts` (gameplay, trades, story, HUD wiring) |
| Pricing (one readable file, the reasons shown in game) | `src/economy/pricing.ts` |
| Haggling | `src/economy/haggle.ts` |
| Rent, Guild, recovery rules (shared by relayer and offline model) | `src/economy/recovery.ts`; a model of the market turn in `src/economy/turn.ts` |
| Browser side of NEAR (player key, relayer calls, views) | `src/near/chain.ts`; read-only mode `src/near/inspect.ts` |
| Relayer (all HTTP routes) | `server/near/vercel.ts` (Vercel entry), `server/near/handlers.ts` (router: `handle`) |
| Market turn | `handlers.ts` routes `tick` (players' browsers) and `market-turn` (scheduler, bearer secret) |
| NEAR AI decisions, memory, signature check | `server/near/agent.ts`, `autonomy.ts`, `memory.ts`, `verify.ts`; budgets and kill switch in `ops.ts` |
| Conversation and voice | `server/near/talk.ts`, `voice.ts`; approved sentences in `lines.json` |
| Chronicle (town history) and player bonds | `src/economy/chronicle.ts`, `server/near/ledger.ts` |
| Contract | `contracts/market/src/lib.rs`, tests in `tests.rs` |
| Who owns which state | `docs/STATE_MACHINES.md` |

## Invariants (do not break)

- Connected, the chain decides value and open/closed; the browser only mirrors it. Never show an on-chain result that
  did not happen.
- Player keys may call only `buy`, `sell`, `deal`. `relay` accepts only delegates to the market contract with those
  methods, zero deposit, bounded gas, and senders the relayer created (`isGameAccount`).
- A negotiated price must be inside the stall's window (`dealBounds`) and signed by the merchant; the contract checks
  signature, expiry and nonce.
- AI chooses among named options built from real orders, inside a band; anything else falls back to the rule. AI never
  moves coins or signs player trades. Decisions are labelled `source: ai | rule`.
- Paid calls are budgeted per UTC day and stop on the kill switch; market turns never retry a paid request.
- Rent, Guild and settlement happen once per market day however many turns run (turn lock plus contract checks).
- Coin is conserved (contract `audit`): it enters as starter purses and street shoppers, leaves as rent and freight.
- Spoken lines must be game text: after changing a line, rebuild `server/near/lines.json` (`npm run build`).

## Check your change

```bash
npm run typecheck
npm test                 # the 17 *.check.ts files via node --test, no network
npm run build            # also regenerates server/near/lines.json and api/near/[route].js
npm run verify           # public on-chain state, no keys
cd contracts/market && cargo test
```

`api/near/[route].js` is generated from `server/near/` by `npm run build:api`. Never edit it by hand; commit it with
the source change (Vercel deploys it as is).

## Caution

- Anything that signs (scripts in `scripts/near/` run with `--yes`, `e2e.ts`, a dev server with keys in `.env.local`)
  writes to the shared testnet market. Use `?offline`, or `?inspect=<account>` for a read-only connected view.
- A connected page load creates a guest account and can trigger a market turn.
- Secrets belong in `.env.local` (git-ignored); `.env.example` lists every variable.
- Blender scripts run from the repository root (`blender -b --python blender/<script>.py`). Poly Haven inputs are
  fetched by `tools/fetch_polyhaven.py`; Tripo source files are not in the repository.
