# NEAR World: Progress Tracker

Status keys: NOT STARTED · IN PROGRESS · VERIFIED (evidence given) · BLOCKED (reason given) · ROADMAP.
Deadline: 2026-11-14 23:59 UTC. Feature freeze target: 2026-11-13 12:00 UTC (rest = QA, recording, submission).

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
| 0 | Local checkpoint | VERIFIED | commit `e553a33` on `dev` (author Bunny) |
| 1 | Deterministic economy core (`src/economy/`) | VERIFIED | `node src/economy/economy.check.ts`: idle path closes Pema (34 c < 40 rent), fee path drops mango 5->2 c and she pays rent, rival path moves stock/cash, week fast-forward identical across step sizes |
| 1 | Pema branching choice with tracked consequences | VERIFIED (A, C in game) | Browser 2026-11-06: A -> flag accepted, rep +8, objective; C -> Pema cash 12->2, mango 3->5, Tomas +10 c -2 stock, rep pema -10 / tomas +6. B, D covered by code review only |
| 1 | Save / reload | VERIFIED | Reload restored flag, rep, receipts, clock (localStorage `nearworld.save.v1`) |
| 1 | Economy inspector + fast-forward | VERIFIED | Tab panel; "1 day" ran ~6 s: delivery -> Pema paid rent -> Tea House bought from Pema (cheaper than Tomas) |
| 1 | Harbor fee decision (stand-in board) | VERIFIED | Coins 25->10, shipment held->transit (arrives 90 min later); real harbor is Gate 4 |
| 1 | First NEAR testnet transaction | VERIFIED | Account `bunnyy-nearworld.testnet` (10 NEAR, 1 full-access key matching local keychain; created by faucet tx `Ao2w4zL97MryDVWp5LBoFGYnbtfQPkkowttsMekVqSK`). In game (2026-11-06): Pema choice 1 -> harbor fee paid (coins 25->10, shipment held->transit) -> relay sent tx **`uKV8uHTnwiWbDUj1yYpRxucK2H41cHQb9do4AQpM3co`**. RPC check: `SuccessValue`, `FINAL`, signer bunnyy-nearworld.testnet -> `guestbook.near-examples.testnet.add_message`, 1.91 TGas; message #857 stored with that sender. After 1-day fast-forward: 30 mangoes delivered, Pema paid rent, Tea House bought 6 from her at 3 c; inspector shows "✔ onchain". https://testnet.nearblocks.io/txns/uKV8uHTnwiWbDUj1yYpRxucK2H41cHQb9do4AQpM3co |
| 1 | Own game contract (NEP-245 items) | BLOCKED | No Rust/cargo on this machine; installing rustup + cargo-near needs approval. Receipts use the public guestbook contract meanwhile (not ours; honest label) |
| 2 | Premium dialogue UI | IN PROGRESS | Market-object design (enamel plank, torn paper subtitle strip, live 3D postage-stamp portrait, kraft tag choices in a side column). Compact pass after user feedback; centre of frame stays clear. Typing speed only checked under a throttled pane |
| 2 | Ambient pedestrians (`src/crowd.ts`) | IN PROGRESS | 10 walkers (Remy/Pema rigs, outfit tints, 0.92-1.04 scale, Remy walk retargeted to Pema rig via rotation tracks) on 6 lane/plaza routes; walk -> browse open stall -> walk, yield to player; skip Pema's stall when the economy says closed/empty. Verified by stepping 4 s: walkers moved ~4-5 m along routes; crowd costs ~2.2 ms/frame on RTX 3050 (see audit). Screenshot: `docs/evidence/2026-11-06-market-crowd-clouds.jpg`. Open: player walks through pedestrians (no ped collision yet) |
| 2 | Named merchants for other stalls | NOT STARTED | Needs more character assets (Mixamo) |
| 2 | Clouds / sky | IN PROGRESS | `src/clouds.ts` fbm cloud deck lit by sun direction; verified in the tone-mapped pipeline (evidence screenshot). Weather presets / morning preset not done |
| 3 | NEAR Spire + lobby, NEAR Labs room | NOT STARTED | |
| 4 | Harbor + dispatcher + drivable vehicle | NOT STARTED | |
| 5 | Mango Crisis end-to-end | NOT STARTED | |
| 6 | Perf, QA matrix, README, demo script | NOT STARTED | |

## Onchain vs local (honesty ledger)

| Thing | Where it lives |
|---|---|
| Prices, stock, cash, rent, closures, fast-forward | Local deterministic simulation (`src/economy/`), saved in localStorage |
| Deal receipts | **Live on NEAR testnet**: harbor-fee receipt sent by the dev relay (key read server-side from the legacy keychain, never bundled/logged) as `add_message` on `guestbook.near-examples.testnet`. Without an account the UI says "kept locally" |
| NEP-245 items | ROADMAP (needs Rust toolchain approval) |
| NEAR Intents | Not used: no testnet (HACKATHON.md Q-007) |

## Working commands

- `npm run dev` then open http://localhost:5173 · `npm run typecheck` · `node src/physics/collision.check.ts`
- Blender rebuild: `exec(open(r"C:/Bunnyy/Hackathons/NEAR/blender/build_street.py").read()); build(); export()`
