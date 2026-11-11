# VIVOLITH build plan (work order)

Written 2026-11-10. Hand this file to the model that builds. It replaces the roadmap and demo in
`docs/BLUEPRINT.md` (sections 14 and 15). The research and evidence stay in BLUEPRINT.

Submission deadline: 2026-11-14 23:59 UTC. Feature freeze: 2026-11-13 12:00 UTC. Submit by 18:00 UTC on the 14th.

## 0. Read first, then obey

1. `AGENTS.md` (project rules), `docs/PROGRESS.md`, `docs/QUALITY_STANDARD.md`, `docs/ECONOMY_MATH.md`.
2. Local commits on `main` only, conventional messages, author Bunny, no Co-Authored-By. **No push and no deploy
   without Bunny's explicit approval.**
3. Never show an on-chain success that did not happen. Anything simulated is labelled as such in the UI and README.
4. No new buildings, characters, vehicles, interiors or Tripo generations. Repair and reuse.
5. No contract change unless WP0 proves one is required. Rust builds on this machine need a linker workaround.
6. After each work package: `npm run typecheck`, `node src/economy/economy.check.ts`,
   `node src/physics/collision.check.ts`, then play it in the browser and save a screenshot to `docs/evidence/`.
7. Keep `https://vivolith.vercel.app` working at all times. Work locally with `npm run dev`.

## 1. The game in one paragraph

**Rent Night.** Saltlight is a city where stalls must make rent and residents must earn before they can eat.
The player (Kavi) haggles, delivers and invests, and decides who keeps their lights on. Tourists bring coin in,
residents circulate it, rent and freight take it out. Players never see chain words. Every coin movement is a
real NEAR testnet transaction.

Protect this moment above every feature: the player helps one merchant, and then watches other people's
evening change because of it.

## 2. Facts about the code you must not rediscover

| Fact | Where |
|---|---|
| Chain market day = 10 real minutes (`MARKET_DAY_MS`). Derived from wall clock, so missed ticks do not shift it | `server/near/handlers.ts:44, 672` |
| `tick` runs one merchant turn: reprice, merchant trades, street shoppers, harbor, kitchen. Throttled to 1 per 60 s for everyone through `hit()` (Upstash when configured) | `handlers.ts:659` |
| Only the browser calls `tick` (`marketTick`). `vercel.json` has no schedule, so the world stops when nobody plays | `src/near/chain.ts:310` |
| `charge_rent` and `settle_day` are idempotent inside the contract (`last_rent`, `last_settled`) | `contracts/market/src/lib.rs:402, 429` |
| `street_sale` is **not** idempotent. It mints coin for anonymous shoppers | `lib.rs:351` |
| `buy` and `sell` work for any registered account and need no deposit | `lib.rs:516, 544` |
| `mt_transfer` needs exactly 1 yocto, so function-call keys cannot use it. **Wages by transfer are impossible without a contract change** | `lib.rs:605` |
| `operator_mint` can mint goods (never coin) to any registered account, with a reason | `lib.rs:322` |
| `register_player` mints a 40-coin starter purse once per account | `lib.rs:310` |
| Merchants are subaccounts `<id>.<relayer>` with keys derived from `NEAR_MERCHANT_SECRET`; function-call keys send one action per transaction | `handlers.ts:666, 723` |
| The player's own clock is local: 09:00 to 21:00 in five real minutes (`GAME_MIN_PER_SEC = 2.4`), with an evening report at 21:00 | `src/v2/play.ts:22, 1019` |
| Townsfolk already have an hourly rhythm and named areas; their purchases are visual only | `src/v2/npc.ts:1-37` |
| Only two car models exist (`ev_sedan`, `ev_pickup`). Neither has wheel nodes. The other three names 404 | `src/v2/traffic.ts:28`, `public/models/v2/props/` |
| The ink outline is a fixed world-space hull on every mesh; the toon conversion drops normal maps | `src/v2/toon.ts` |
| Sun direction and sky colours are constants | `src/v2/look.ts:26, 40` |
| There is no audio and no NEAR AI code | whole repo |
| `README.md` is stale: it says the economy and NEAR are not built | `README.md:7-12, 79-82` |

Two clocks exist on purpose. **Day and night visuals follow the player's local clock. Stall open or closed
follows the chain.** Do not merge them.

## 3. Work packages, in order

### WP0. Feasibility gate (do this before anything else, about 2 h)

Write `scripts/near/resident-check.ts`, modelled on `scripts/near/e2e.ts`:

1. Create resident `picker.<relayer>` the same way merchant subaccounts are made, with a function-call key
   limited to the market contract, methods `buy` and `sell`. Register it with `register_player`.
2. Run one `tick` so bids and asks are posted.
3. Operator mints 6 `mango` to the picker, reason `orchard picking`.
4. Picker calls `sell` into the best mango bid.
5. Picker calls `buy` for 1 `lassi` from Arin. Operator burns that lassi, reason `eaten`.
6. Assert every balance with `mt_batch_balance_of`. Print explorer links.
7. Fire two `tick` requests at the same instant. Assert `street_sale` ran once. If it ran twice, make the
   throttle atomic (Upstash `SET NX`) before going on.
8. If `NEAR_AI_KEY` is in `.env.local`: five chat calls to `https://cloud-api.near.ai/v1/chat/completions`,
   print median and worst latency.

**Pass:** all asserts green, links open. **Fail:** stop and report to Bunny. Do not fake residents.

### WP1. README truth (1 h)

Rewrite `README.md` for a machine reader: one-sentence pitch, live URL, contract account, a "do X, see Y" table
for the first five minutes, what is on chain, what is local and labelled, how to run and check. Remove Remy,
"not built yet" and the guestbook section. Update again in WP13.

### WP2. Cars (4 h)

- In Blender (`blender/build_tripo_props.py` pipeline), split `ev_sedan` and `ev_pickup` into body, glass,
  lights and four wheels. Wheel nodes named `wheel_fl`, `wheel_fr`, `wheel_rl`, `wheel_rr`, origin at the axle
  centre, axle along local X. Front wheels sit under `steer_fl` and `steer_fr` pivots. Flat palette colours.
- `traffic.ts`: `MODELS` lists only the two that exist. Give each pooled car one of five body colours by
  cloning the body material.
- Rear-axle following: rear axle at path distance `s`, front axle at `s + wheelbase`, yaw from the two points.
  Steer pivots turn by the angle between heading and the path tangent at the front axle, clamped to 35 degrees.
  Body pitches a little with acceleration and rolls a little in turns.

**Done when:** a 10-second clip shows wheels spinning, front wheels steering, no sideways drift in a corner.

### WP3. Outlines, materials, midday glare (3 h)

- `toon.ts`: outline thickness constant in screen pixels (offset in clip space, clamped). `applyToon` gets an
  `outline` flag: on for characters, cars and stalls; off for buildings, landmarks, benches and plants. Skip the
  hull on transparent, alpha-tested and double-sided meshes. Ink is the surface colour darkened, not one navy.
  Keep `normalMap` in `toToon`.
- Emissive lamps and stall bulbs scale with a night factor (0 by day). Feeds WP4.
- A/B `NeutralToneMapping` against the current ACES plus grade at six fixed camera spots. Keep whichever Bunny
  picks from the screenshots.

**Done when:** a close-up of Kavi has a thin line and no black slabs; no lamp glows at noon.

### WP4. Day and night (4 h)

`look.ts` gains `setTime(minuteOfDay)`. Four keyframes (dawn 06:00, day 12:00, dusk 19:00, night 23:00) blend
sky colours (move them to uniforms), sun direction, colour and strength, hemisphere light, fog colour,
exposure and the night factor. Call it from `townHour` in `play.ts` beside `market.life.setHour`.

**Done when:** a fast-forward shows a clean sunset and lit windows, and frame time stays inside the PROGRESS
baseline (`__v2.frameTime(60)`).

### WP5. The world keeps running (2 h, needs Bunny's approval to push)

- `.github/workflows/tick.yml`: schedule `*/5 * * * *`, one POST to `/api/near/tick`. Missed or late runs are
  acceptable because the market day comes from the wall clock and rent and settlement are idempotent on chain.
- Log last successful tick time and day to Upstash; show it in the proof screen.
- Document the mapping in the README: 10 real minutes is one market day; rent every 2 market days.

### WP6. Two residents with real money (6 h, only after WP0 passes)

No contract change. Residents earn by piece work, because wage transfers are impossible (section 2).

| Resident | Earns | Spends |
|---|---|---|
| Orchard picker | Once per market day the operator mints 6 mangoes (`orchard picking`); the picker sells them into the best bid | Buys 1 lassi per market day if it can afford it; the lassi is burned as `eaten` |
| Harbor porter | Once per market day the operator mints 4 lemons (`harbor unloading`); sells into the best bid | Same |

- Add both to `tick` after merchant trades. Guard each action with `hit("<resident>:<action>:<day>")`.
- Reduce anonymous `street_sale` volume by what residents now buy, and rename those shoppers "tourists" in logs.
- Client: residents are two named townsfolk in `npc.ts`. **They walk to the stall as soon as the errand is
  planned. The hand-over animation, coin sound and balance change play only after the transaction confirms.**
  On failure or no money they shrug and a hunger icon appears.
- A resident who cannot afford food says so, with the real price.

**Done when:** one resident's sale and purchase are visible in the explorer and in the street within the same
minute, and `economy.check.ts` has a headless case for it.

### WP7. Rent Night, with upside (3 h)

- A closed stall (from chain) has dark lamps and shutters. An open stall lights up at dusk.
- At 21:00 local time, before the evening report, the camera holds on the street while each stall's light
  comes on or stays dark.
- Upside: a trader rank in the HUD from net worth (four named tiers), and the existing stall upgrade
  (`UPGRADE_AT` in `sim.ts`) made visible on the stall the player rescued.
- First mission target: keep Pema if she is the stall nearest to missing rent; otherwise point the guide at
  whichever stall is. `guide.ts` already takes a target per step.

### WP8. NEAR AI talk (5 h, needs the key)

- New relayer route `talk`: input `npcId` and an optional question. Build facts from chain state and that
  NPC's receipts. Call NEAR AI (model from `NEAR_AI_MODEL`), 4 second abort, 10 calls per minute per player.
- Reply rule: every number in the reply must appear in the facts. Otherwise, or on timeout or error, return
  the scripted line. Response carries `source: "ai" | "script"`.
- Client: one "Ask why" choice in the talk panel for merchants and residents.
- Only if this is stable: one bounded decision per merchant per market day, a price nudge within plus or minus
  10 percent, with its reason shown on the chalkboard. Validator rejects anything else.

**Done when:** the first day plays identically with the key removed.

### WP9. Audio (4 h)

`src/v2/audio.ts` with three buses (music, ambience, effects) and ducking during talk.

- Effects generated in code with Web Audio (click, confirm, error, coin, deal struck, footsteps, voice babble
  pitched per character). No files, no licence.
- One day loop, one night loop, one city ambience as CC0 or Pixabay-licensed files in `public/audio/`.
  Record each file's source and licence in `CREDITS.md`. Downloads need Bunny's approval.
- Sound starts on the first click (browser rule). A mute toggle in the menu.

### WP10. Orchard as the second place (3 h)

At the Mango Orchard placard, in the morning, the player can pick up to 3 mangoes per market day. On chain:
operator mints them to the player, reason `orchard picking`, capped with `hit`. The player then carries them to
whoever bids best. State the cap in `src/economy/pricing.ts`.

### WP11. Cold playtests (Nov 12 evening)

Three people who have never seen the game, no instructions. Record: did they find the first objective, finish
a trade, want to continue. Fix only what blocked them.

### WP12. Money trail (only if everything above is stable)

Tap a payment in the receipt list and a gold line links the people involved, in the order of the recorded
events. Name it "money trail". Never claim it follows one specific coin.

### WP13. Demo and submission (Nov 13 afternoon, Nov 14)

Before recording, reset the testnet ledger with `scripts/near/reset-state.ts` (Bunny approves and runs it).

**"The Night Pema Almost Closed", 90 seconds:**

1. 0 to 15 s: sunset city, Pema's shelves nearly empty, one objective.
2. 15 to 35 s: orchard pickup, then a five-second haggle with Tomas for the rest.
3. 35 to 50 s: deliver. Shelves fill. The picker arrives and buys. Coin sound.
4. 50 to 65 s: the picker spends her earnings at the Tea House.
5. 65 to 80 s: night. Rent is due. Pema's lights stay on. Another stall stays dark.
6. 80 to 90 s: ask Pema why. She answers from real numbers. One receipt with an explorer link.

Then: final README, X post with the video, submit by 18:00 UTC.

## 4. Schedule and cuts

| Day (UTC) | Packages |
|---|---|
| Nov 10 | WP0, WP1, WP2, WP3 |
| Nov 11 | WP4, WP5, WP6, WP7 |
| Nov 12 | WP8, WP9, WP10, WP11 |
| Nov 13 | Fix playtest blockers, WP12 if stable, freeze at 12:00, five clean demo runs from a fresh guest |
| Nov 14 | WP13 |

Cut order when behind: WP12, the AI price nudge, the porter (keep the picker), WP10.
Never cut: WP0, WP1, WP2, WP4, one resident, audio, the demo runs.

## 5. Needs from Bunny

- `NEAR_AI_KEY` and `NEAR_AI_MODEL` in `.env.local` and in Vercel. Never in chat or in git.
- One Google sign-in test and one pointer-lock test in normal Chrome on the live site.
- Approval for: pushing the GitHub workflow, each deploy, audio downloads, the ledger reset.

## 6. Out of scope

Interiors, Agent Plaza, the order board, real NEAR Intents, twelve residents, text-to-speech, 67.js, new assets,
a physics engine, multiplayer.
