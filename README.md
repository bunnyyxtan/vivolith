# VIVOLITH

A 3D anime-style market city in the browser where every merchant is an agent with its own NEAR account, prices
move with real stock, and players trade, haggle and buy stall shares without ever seeing a wallet.

Built for NEAR HACKATHON 2026, track **Games With Real Economies** (`games`).

- Play: https://vivolith.vercel.app
- Market contract (NEAR testnet): [`market.bunnyy-nearworld.testnet`](https://testnet.nearblocks.io/address/market.bunnyy-nearworld.testnet)
- Merchant accounts: `pema`, `tomas`, `mira`, `arin` `.bunnyy-nearworld.testnet`

## First five minutes: do this, see that

| Do | See |
|---|---|
| Open the site, type a name, press **Enter** (or choose **Continue with Google**) | You arrive in the city with 40 coins. A NEAR testnet account was made for you in the background; no wallet, popup or gas prompt |
| Follow the gold marker to Pema, press **F** | Pema's fruit stall is nearly empty. Her chalkboard shows each price and the reason for it |
| Buy 3 mangoes from Tomas | Coins leave your purse, mangoes enter your bag (**B**). The trade is a testnet transaction |
| Bring them to Pema and sell at 6 c each | Her shelves fill and her price drops. You earn from buying cheap and selling where goods are missing |
| Buy again from Tomas, press **Haggle**, pick tactics | His patience bar reacts; the final price is one he signed, settled on chain |
| Open **Invest** at a stall and buy a pack of shares | You own part of the stall and earn from every sale it makes from then on |
| Press **T** | A week of the city in about a minute: rent nights, closures, restocks and what your shares would earn. Connected to NEAR this is labelled a forecast |
| Press **N** | Your NEAR account, balances and receipts with explorer links |

Controls: WASD move, Shift run, F talk or trade, B bag, J goals, H help, N NEAR account, T fast-forward, Esc menu.

## What is on NEAR, what is not

| On NEAR testnet (contract `contracts/market`, NEP-245) | Local, and labelled so |
|---|---|
| Coin, mango, lemon, lassi and `share:<stall>` tokens in one NEP-245 contract | The week fast-forward (a forecast run on a copy of the city) |
| Every player trade, haggled deal, share purchase and buyback | Walking townsfolk, cars, day rhythm |
| Merchant asks and bids, posted by each merchant's own key from `src/economy/pricing.ts` | The story flags and position (saved in the browser; on any device when signed in with Google) |
| Rent every two market days, stall closures and reopening, dividends, Market Guild loans | |
| Starter purse of 40 coins, once per account | |

- One market day on chain is 10 real minutes; rent is due every 2 market days. A market turn (`POST /api/near/tick`)
  reprices merchants, lets them trade with each other, and records street shoppers, harbor freight and the tea
  kitchen. Players' browsers trigger turns while they play, and `.github/workflows/tick.yml` runs one every 5 minutes
  so the city keeps trading when nobody plays. Only one turn runs at a time (an atomic lock held 75 s), and rent and
  settlement are once per market day in the contract, so missed, late or repeated triggers never double anything.
  The proof screen (**N**) shows when the last turn ran.
- Players sign moves with a function-call key limited to `buy`, `sell` and `deal`; the relayer pays gas (NEP-366
  meta-transactions). A display name is guest access only and never names an account or key.
- Signing in with Google moves a guest's coins, goods and shares into the Google account with one starter purse kept.
- Merchant pricing rules live in one readable file: `src/economy/pricing.ts`.
- Economy rules and proofs: [docs/ECONOMY_MATH.md](docs/ECONOMY_MATH.md).

## Run it

Requirements: Node.js 24.

```bash
npm install
npm run dev
```

Open http://localhost:5173. Without NEAR keys in `.env.local` the game runs fully local and says so.

## Checks

```bash
npm run typecheck
node src/economy/economy.check.ts
node src/physics/collision.check.ts
node scripts/near/resident-check.ts
```

The last one is a read-only dry run. With `--run` it proves on testnet that a resident account holding only a
`buy`/`sell` key earns coins by selling and spends them on food (needs the relayer keys; see `scripts/near/`).
`node scripts/near/e2e.ts` runs the full player journey against testnet.

## Stack

Three.js 0.187, Vite 8, TypeScript, Rust (near-sdk) contract, near-api-js 7.4, Auth0 for Google sign-in,
Upstash Redis for rate limits and cloud saves, Blender for the city and characters.

## Design docs

- [Build plan](docs/BUILD_PLAN.md) and [blueprint](docs/BLUEPRINT.md)
- [Economy math](docs/ECONOMY_MATH.md), [economy design](docs/ECONOMY_DESIGN.md)
- [Progress and evidence](docs/PROGRESS.md)

## License

MIT
