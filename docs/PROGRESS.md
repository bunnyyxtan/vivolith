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
