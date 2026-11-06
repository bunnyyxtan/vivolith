# NEAR WORLD: Economy Design (v0.1, 2026-11-06)

This extends [CREATIVE_DIRECTION.md](CREATIVE_DIRECTION.md). The concept, district, art direction
and engine stay the same. This file defines how the economy reacts.

## What the track guidance changed

| Area | Before | Now |
|---|---|---|
| NPCs | Merchants with memory | Every NPC is an **economic agent**: account id, coin balance, inventory, needs, suppliers, customers |
| Prices | Haggle around a fixed base price | Price = f(stock, recent demand, cash pressure, your reputation). Rules live in **one file**: `src/economy/pricing.ts` |
| World | Static stalls | Stalls show live state: a chalkboard price, stock on the table, lights, a crowd, shutters |
| Time | Real time only | **Night Shift** fast-forward: a labelled demo mode, one simulated week in about 60 s |
| Chain | Receipt per deal | NEP-245 contract holds every item, coin and shop share; deals settle through a scoped key, so no popups |

Components that stay useful: the Three.js + Vite stack, the district layout, the Blender pipeline,
the haggle UI, the receipt flight and Ledger Tower, and the Night Shift idea, which is now central.

## The economy graph (first slice)

```
Fisherman --fish--> Fishmonger --fish--> Tea House (fish curry)
Orchard cart --mangoes--> Auntie Pema --mangoes--> Tea House (mango lassi)
Tea House --meals--> Plaza crowd (walkers with coin + hunger)
Plaza crowd --fares--> Rickshaw driver
Everyone --rent--> Landlord (the Quiet Fisherman owns the deeds)
```

Each merchant has `coins`, `stock{}`, `baseCost{}`, `demand{}` (decaying window of recent buys) and `rentDue`.
When `coins < rentDue` at rent time, the shop **closes**: shutters drop and the sign changes to
"Looking for investor". Anyone (player or NPC) can invest coins for **shop shares**, and the
shop reopens. Shareholders receive a share of profit at each day's close.

## Pricing (single readable file, the reason shown in a tooltip)

```
price = baseCost
      * scarcity(stock / targetStock)   // fewer items cost more
      * demand(recentBuys)              // hot items cost more
      * cashPressure(coins / rentDue)   // a broke merchant sells cheap, a rich one holds firm
      * relationship(rep)               // your history with them and their friends
```
Every factor returns `{ multiplier, reason }`. The tooltip lists the reasons, for example
"Only 2 crates left (+40%)" or "Rent due tonight, needs cash (-25%)".

## The chain reaction: "Corner the Mangoes"

This is one player decision that ripples visibly through the city within about 60 seconds of game time.

1. Pema is short of cash (rent due), so her mangoes are cheap. You can **buy her whole stock**
   at a lowball price, or pay fair.
2. **Buy out:** Pema has cash but no stock, and her table empties. The Tea House can't restock
   mangoes, so its lassi price on the chalkboard jumps 60%.
3. The plaza crowd can't afford lassi, so walkers reroute to the pier, and the plaza visibly thins.
4. Fewer walkers means fewer rickshaw fares. The driver cuts prices and complains about you by
   name, because the receipt is public.
5. You now hold every mango in town. The Tea House **has to buy from you**: you set the price.
   Profit, at a reputation cost the whole Row remembers.
6. **Pay fair instead:** Pema pays rent and gifts you a tip-off, the plaza stays lively, and the
   Fisherman notices.

Both paths are fun. The consequence is visible in the world (empty table, chalkboard, crowd
flow, driver dialogue), not in a menu.

## Gameplay loops

| Cadence | Loop |
|---|---|
| 30 s | Walk up, see the chalkboard price, open haggle, read the merchant's reasons, pick a tactic, settle, watch the receipt fly |
| 5 min | A trade run (buy at A, deliver to B) or a job (rickshaw fare, Fisherman's favor). One merchant booms or busts as a result |
| Session | Rescue or invest in a closed shop and own shares. Run the Night Shift to watch your shares pay or crash. Climb the Ledger Tower wealth board |

## What goes onchain (NEAR testnet)

- **One NEP-245 contract** (`mt_*` views, `mt_transfer`, NEP-297 events). Token ids: `coin`,
  `mango`, `fish`, `tea`, and so on, plus `share:<shop>`.
- **Game method `trade(merchant, give[], take[])`**, callable with a function-call key (no deposit, no popup). It moves the balances and emits `mt_transfer` events.
  The contract enforces a price band from onchain stock, so a player can't trade at a fake price.
- **Merchant accounts** are named accounts (`pema.<game>.testnet`) with real MT balances.
- **Night Shift** runs locally at speed, then settles a summary transaction (shares, closed
  shops) so the result is verifiable.
- Each receipt in the game links to the transaction on a testnet explorer.

## Login

1. **Guest (default):** a testnet account is created for the player with a function-call key
   restricted to the game contract. No seed phrase and no popups. Needs a small funding relayer
   (testnet only).
2. **Wallet (optional):** NEAR Connect with `function-call-key-plugin`. One approval at login,
   then no popups (verified in docs.near.org "Wallet Login").
3. Email/social login: add only if a provider is verified on testnet.

## Realistic by 2026-11-14

| Feature | Confidence |
|---|---|
| Playable district, controls, haggle UI with reasoning tooltip | High |
| Local economy sim, chain reaction, shutters, Night Shift | High |
| NEP-245 contract on testnet with `trade`, verified tx receipts | Medium-high (needs Rust toolchain) |
| Guest login with scoped key | Medium-high |
| Shop shares + dividends onchain | Medium |
| Email/social login | Low (unverified) |
| Drivable rickshaw | Low, stretch goal |
| AI-driven NPC dialogue | Not planned; scripted lines with economic variables |
