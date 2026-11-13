# VIVOLITH: final integration and release checklist

Carried over from Phase 2 (closed 2026-11-13, see [PROGRESS.md](PROGRESS.md)). Every item needs the owner's
explicit approval before it runs: each one writes to testnet, production Redis or the live site, or spends NEAR AI
credits. Record evidence in `docs/evidence/` and the result in PROGRESS.md.

Production today: `c2ace0b`. Local commits not deployed: `86cf4be` (Lin grounding), `16ed7a5` (relayer bundle),
`f781fb2` (Rent Night journey), the Phase 3 voice commit, plus docs.

## 1. Connected playthrough (testnet)

- [ ] Preflight: read shared market state (stalls, tills, Guild, posted orders, last turn) without writing.
- [ ] Enumerate expected transaction types and accounts before the first market turn; enforce a hard turn cap
      (browser 60 s ticks are not bounded today: a cap must exist in code or the run must not start).
- [ ] One guest (40 c starter purse), recorded and kept for reuse.
- [ ] Play: intro, Pema's problem, orchard, buy, offer comparison, haggle or invest, Rent Night, report, Chronicle.
- [ ] Verify against chain: player balances, merchant tills/stock/orders, shopper purchases, Guild dues and
      repayment, rent charge and grace, closure and reopening, Lin's actions, Dev's only if his account exists.
- [ ] Check duplicates, attribution, unexpected issuance. Keep visual 21:00 separate from on-chain rent day.

## 2. Live scheduler activation

- [ ] `CRON_SECRET`, `vercel.json` cron for `/api/near/market-turn` (plan must allow it), optionally
      `NEAR_MARKET_DRIVER=scheduler`.
- [ ] One agent at a time (`NEAR_AGENT_MERCHANTS=arin`), low `NEAR_AI_DAILY_DECISIONS` / `NEAR_AI_DAILY_VERIFIES`.
- [ ] Kill switch tested live (`scripts/near/agents.ts halt/resume`).

## 3. Redis persistence verification (production)

- [ ] Chronicle events, bonds, decisions and memory rows written by a live turn survive a cold start.
- [ ] No duplicate events by id or transaction; decision rows carry their tx hash and signature status.

## 4. Live voice (Phase 3; paid ElevenLabs and NEAR AI calls)

- [ ] `node --env-file=.env.local scripts/audio/generate.ts --account` (free) to see credits, then generate the 30 missing
      static lines (`--run voice`, about $0.20 at published prices). The 4 `sdf58f4d1` ("We're open again") jobs duplicate
      the recorded `reopen.mp3` and can be skipped.
- [ ] One dynamic line per economic character through `/api/near/voice` (Pema, Tomas, Mira, Arin, Lin, Dev): listen for
      timbre continuity with the recorded opener, Arin's delivery (no breathiness), Lin and Dev for the first time.
- [ ] Moods heard live: Pema worried, relieved, down, grateful; soften a tag in `MOOD_TAG` if one is exaggerated.
- [ ] Latency with the pane visible: talk round trip, then Ask to first audio (target about 2 s); record in PROGRESS.md.
- [ ] Confirm `alignment` arrives and lights words in step with the voice (with-timestamps on `eleven_v4`).
- [ ] Production env: `ELEVENLABS_API_KEY` set; `VIVOLITH_VOICE_MOCK` unset.

## 5. Production release

- [ ] Deploy from a clean worktree (`npm run deploy`; uncommitted audio not shipped); page meta matches the commit.
- [ ] 12/12 checks, client typecheck, build; API bundle built from the same tree.
- [ ] Status route: driver, agents, Redis; `market-turn` 401 without the secret.
- [ ] Browser pass on vivolith.world: welcome, guest, first trade, Rent Night, report. Frame time measured with the
      pane visible. Known: `car_van.glb` 404, trade panel overlaps the objective card at 800x600.
