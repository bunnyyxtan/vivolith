# NEAR WORLD: Creative Direction (v0.1, 2026-11-06)

Track: **Games With Real Economies** (`games`). Its brief says judges score the game loop first,
and give a bonus when players never notice the chain. The track prompt also suggests:
NEP-245 items, social/email login with no wallet popups, merchant pricing rules in one readable
file with the reasoning shown in a tooltip, and a fast-forward mode (one week in one minute).

## 1. Concept

**NEAR WORLD: Saltlight Row.** This is a coastal market district at dusk, made of stalls, cafes,
a pier, rickshaws and a clock tower. Every merchant is an agent with a real wallet, real stock and
a memory. You arrive with a few coins and a rented handcart. You leave owning part of the street.

Tagline: *Everyone has a wallet. Everyone remembers.*

## 2. Signature WOW mechanic: "The Row Remembers"

Familiar interaction: haggling at a street stall.
Unexpected mechanic: **every deal becomes a receipt the whole street can read.**

1. You haggle with Auntie Pema at the mango stall. When you open a deal, her thoughts appear in a
   tooltip, for example "2 crates left, rent due tonight, you undercut my nephew yesterday".
   You pick a tactic: Lowball, Fair, Flatter, Bundle, or Mention the rival.
2. The deal settles. A glowing paper receipt folds itself and **flies over the rooftops** to the
   Ledger Tower, whose face flickers with the new trade.
3. Heads turn along the street. A rickshaw driver 60 m away, whom you have never met, quotes the
   deal back to you: "Three coins for Pema's last crate? Then you can afford my fare." His
   price for you has already changed.

What players learn without being told: their history is public, permanent and shared, so
reputation is real. Under the hood, the receipt is a real NEAR testnet transaction, and the NPCs
read the same chain state.

### Supporting surprises
- **Shutters drop.** If you flood the market or bleed a merchant dry, the shop closes on screen
  with a sign: "Looking for an investor". If you invest, you get a share token, the sign is
  repainted with your name, and dividends follow.
- **The Quiet Fisherman.** A scruffy NPC on the pier asks for a small favor. Later the tower's
  wealth board reveals he holds stakes in half the Row. How you treated him decides whether he backs you.
- **Night Shift (fast-forward).** Sleep on the bench. The camera rises, and one week of
  NPC-to-NPC trading plays out in one minute: prices swing, shutters open and close, the tower
  ticker races.

## 3. Core loop

| Cadence | Player does |
|---|---|
| Every 30 s | Walk or ride, talk, haggle one deal, watch the street react |
| Every 5 min | Finish a run: buy low at one stall, deliver to a buyer, take a rickshaw job. Reputation shifts and a merchant booms or busts |
| Every session | Invest in or rescue a shop and own a share. Run a Night Shift. Climb the tower's wealth board |

The money loop: **coins -> stock -> deals -> reputation -> better prices -> shares -> dividends.**

## 4. District layout (first playable slice, about 160 x 120 m)

- **Ledger Tower** (landmark): a clock tower at the plaza. Its face is a live trade ticker.
- **Market Lane**: a curved street of 6 to 8 stalls (fruit, spice, fish, tools, tea, lanterns).
- **Tea Plaza** (social hub): string lights, benches, a fountain, idle NPCs.
- **Pier Road**: a waterfront with boats, crates, the Fisherman, and a sunset view.
- **Back Alley**: a narrow shortcut with a shady trader and a rickshaw stand.

## 5. Art direction

- Golden hour turning into blue dusk, with warm sodium lamps against cool sky blue.
- NEAR palette as the district's light, not as billboards. **Blue `#0091FD`** and **Sky `#83DCFF`**
  appear in neon trims, tower glow and receipt trails. **Dark grey `#272727`** and **warm off-white
  `#EEEEEB`** are the base. The NEAR symbol appears only in a few earned places: the tower face,
  receipts, and the share-token sign.
- Stylised-realistic, chunky readable silhouettes, bevelled edges, hand-tuned materials, and
  dense props (awnings, crates, cables, plants, signage). The goal is a dense little district,
  not a big empty one.
- UI: clean, minimal, monospace numbers, thin 1 px micrographic lines (from the brand guide).

## 6. NEAR's role (honest scope)

| Onchain (testnet) | Local game logic |
|---|---|
| NEP-245 multi-token contract: every item type, coins and shop shares | Movement, physics, animation |
| Merchant agent accounts (`pema.<game>.testnet`) holding real stock | Moment-to-moment haggling UI |
| Deal settlement, which produces the receipt (tx hash, viewable in an explorer) | Fast-forward simulation (summary settled onchain) |
| Reputation counters and shop-share ownership | NPC dialogue |

Login: the player never sees a seed phrase or a popup. The plan is a game-created testnet
sub-account with a function-call access key that is restricted to the game contract. A
social/email login provider will be added if one is verified to work on testnet (open risk).
NEAR Intents is not used, because Intents has no testnet (HACKATHON.md Q-007).

## 7. Engine

**Three.js + Vite + TypeScript, browser-native.** Judges open a URL and play. It gives full
control of the render loop, glTF from Blender loads natively, NEAR JS libraries plug in
directly, and the code is easy to automate and test. Godot's web export is heavier, and Babylon
offers no decisive advantage. Physics uses custom capsule-vs-box collision for now; Rapier only if
vehicles need it.

Pipeline: Blender (procedural Python scripts in `blender/`) -> GLB -> `public/models/` -> Three.js.

## 8. Main delivery risks

1. **Time.** Deadline 2026-11-14 23:59 UTC, 8 days. Mitigation: milestone order is fixed and the game stays playable every day.
2. **Characters.** Rigged, animated humans are the hardest asset. Mitigation: CC0 animated
   characters (Quaternius/Kenney, license to be verified) plus our own Blender props and buildings.
3. **Social login on testnet.** Unverified. Fallback: auto-created testnet account with a scoped key, so there are still no popups.
4. **Rust toolchain missing.** A contract needs `rustup` (install requires your approval) or `near-sdk-js`.
5. **Browser performance** with dense props. Mitigation: instancing, baked lighting where possible, LOD, and a draw-call budget.
6. **Scope creep.** Vehicles are drivable rickshaws only after the haggle loop is fun.
