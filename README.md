# VIVOLITH: Saltlight Row

A browser 3D market-town game for NEAR HACKATHON 2026, track **Games With Real Economies** (`games`).
Every merchant is an agent with a wallet and stock, prices react to what players do, and the whole
street remembers your deals.

> Status: **Milestone 2 in progress (visual upgrade).** The district (Market Lane, plaza, Ledger Tower)
> is built in Blender from CC0 Poly Haven assets plus custom models and loaded as a GLB, with HDR image-based
> lighting, ground-truth AO, bloom and 4096 px shadows. You can walk it in third person and talk to one NPC.
> You play as Remy (Mixamo character, idle/walk/run blended by speed); Auntie Pema (Mixamo) turns to face
> you and plays a talking animation. The economy and NEAR testnet integration are **not built yet**.
> This README lists only what exists.

Rebuild the district (optional; the GLB is committed): fetch sources with `python -I tools/fetch_polyhaven.py`,
then in Blender run `exec(open("blender/build_street.py").read()); build(); export()`.

## Try it

Requirements: Node.js 20+ (tested on 24.19.0).

```bash
npm install
npm run dev
```

Open http://localhost:5173.

| Do | See |
|---|---|
| Wait on the title screen | Dusk shot of the Ledger Tower and plaza |
| Click **Click to enter** | The mouse locks and you control the character |
| WASD / Shift / Space / mouse | Walk, run, jump, orbit the camera (the camera pulls in when a wall blocks it) |
| Walk to the blue-and-white striped stall on your left, press **E** | Auntie Pema talks (press E to advance); her chalkboard shows prices |
| Add `?quality=low` to the URL | Skips AO and bloom on weak GPUs |
| Esc | Releases the mouse |

Checks:

```bash
node src/physics/collision.check.ts   # character collision self-check
npm run typecheck
```

## Design

- [Creative direction](docs/CREATIVE_DIRECTION.md): concept, signature mechanic, district, art, engine, risks
- [Economy design](docs/ECONOMY_DESIGN.md): pricing, chain reaction, loops, onchain scope, login
- [Asset sources](docs/ASSETS.md)

## The Mango Crisis (playable now)

| Do | See |
|---|---|
| Walk to the blue-striped stall, press **E** | Pema explains her shipment is stuck; pick 1-4 (choices change cash, stock, reputation) |
| Choice 1, then go south past the plaza to the **dispatch board** on the pier, press **E**, pay the fee | Coins -15, shipment goes in transit, a receipt card appears (on NEAR testnet if configured, otherwise clearly marked local) |
| Press **Tab** | Market inspector: every merchant's cash, stock, prices with reasons; fast-forward 1 day / 1 week |
| Fast-forward 1 day, talk to Pema again | Her table is restocked, her price is lower, she pays rent; the Tea House bought from her instead of Tomas |
| Skip the quest and fast-forward | Pema misses rent, her goods vanish and the chalkboard reads "Shutters down" until the harbor releases the crates |

Economy rules: `src/economy/pricing.ts` (one readable file). Self-check: `node src/economy/economy.check.ts`.

## NEAR setup (testnet only)

1. Create a testnet account with near-cli-rs (interactive): `npx near-cli-rs@0.31.1 account create-account`
   then choose *sponsor-by-faucet-service*, a name like `nearworld-<you>.testnet`, *autogenerate-new-keypair*,
   *save-to-legacy-keychain*, network *testnet*.
2. Create `.env.local` (gitignored) with `NEAR_ACCOUNT_ID=nearworld-<you>.testnet`. The relay reads the key from
   `~/.near-credentials/testnet/<account>.json` (or `NEAR_PRIVATE_KEY`). Mainnet accounts are refused.
3. Restart `npm run dev`. Paying the harbor fee now writes a receipt with `add_message` to the public testnet contract
   `guestbook.near-examples.testnet`; the in-game card links the tx on testnet.nearblocks.io.

### Verified testnet evidence

- Dev account: `bunnyy-nearworld.testnet`
- In-game harbor-fee receipt: [`uKV8uHTnwiWbDUj1yYpRxucK2H41cHQb9do4AQpM3co`](https://testnet.nearblocks.io/txns/uKV8uHTnwiWbDUj1yYpRxucK2H41cHQb9do4AQpM3co)
  (`add_message` on `guestbook.near-examples.testnet`, status `SuccessValue`, final). The same payment released
  Pema's shipment in the simulation, which restocked her stall and let her pay rent.

## NEAR integration

Planned, not implemented: an NEP-245 multi-token contract on testnet, merchant accounts with real
balances, and popup-free play through function-call access keys. See the economy design doc.

## Stack

Three.js 0.187, Vite 8, TypeScript 5.9. Blender 5.2 (via MCP for Blender) for 3D assets.

## License

MIT
