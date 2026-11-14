# VIVOLITH: final integration and release checklist

Carried over from Phase 2 (closed 2026-11-13, see [PROGRESS.md](PROGRESS.md)). Every item needs the owner's
explicit approval before it runs: each one writes to testnet, production Redis or the live site, or spends NEAR AI
credits. Record evidence in `docs/evidence/` and the result in PROGRESS.md.

**2026-11-14:** live acceptance ran on `55a4121` (PROGRESS.md "Phase 6: live production acceptance"). Next release step:
deploy `d8443ba` (player never sees the chain; Rent Night voice lines; early rent result) and re-check the trade panels,
Town tab and Rent Night on vivolith.world. Done in that run: connected playthrough (§1), one live agent turn (§2), Redis
decisions/Chronicle (§3), live voice and chat (§4).

Production before that run: `c2ace0b`. Local commits not deployed: `86cf4be` (Lin grounding), `16ed7a5` (relayer bundle),
`f781fb2` (Rent Night journey), the Phase 3 voice commits (`30e1fff`, live voice and hardening), the Phase 4 characters commit, plus docs.

**2026-11-14 (later):** production is `db46f27`. Local and not deployed: `1c6a59c`, `d0c2a82`, `7673f2b`, `eaf3e03`
(trade panel recovery, operator batch stale stock, Chronicle signature status, rent wording) plus docs. Controlled
live checks for them are listed in PROGRESS.md "Known-issue resolution".

## 1. Connected playthrough (testnet)

- [ ] Preflight: read shared market state (stalls, tills, Guild, posted orders, last turn) without writing.
- [ ] Enumerate expected transaction types and accounts before the first market turn. The hard turn cap exists
      (Phase 6, `3c6a80a`): set `NEAR_TEST_TURNS=<n>` and a fresh `NEAR_TEST_RUN=<id>` on the relayer that serves the
      run, check `GET /api/near/status` shows `testTurns`, and deploy the rebuilt API bundle first.
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

Done locally on 2026-11-13 (36 generations, 1459 credits, see PROGRESS.md "Live voice pass"): six live voices, 26
recordings, alignment, in-game first audio 1.70 s, streaming comparison, route hardening. Remaining:

- [ ] Human listen (no credits): `docs/evidence/phase3-voice/*.mp3` (Arin's delivery, Lin and Dev for the first time,
      continuity with the recordings) and the two lines Whisper misheard: `public/audio/voice/pema/s583444d9.mp3`
      ("Thirty crates!") and `public/audio/voice/engineer/s71b0f56e.mp3` ("Your call."). Re-take only what sounds wrong
      (`rm` the file, then `generate.ts --run voice --one <file>`).
- [x] Pema's greeting opening `audio/voice/pema/sdc716855.mp3` "Oh, a new face! I'm Pema." generated 2026-11-14 (one
      call, 14 credits); plays at any shelf count, the figures follow from the server. The whole 3-mango take
      `sa43fc250.mp3` stays ungenerated (optional: offline new players only).
- [ ] Moods heard live: Pema relieved, down, grateful (only worried was generated); soften a tag in `MOOD_TAG` if one
      is exaggerated. Rent Night kept and closed outcomes and a haggle reaction in the real voice.
- [ ] Live talk route (NEAR AI, paid) plus voice: Ask to first audio with the pane visible (expected about 1.5-1.7 s
      talk + 1.7 s first sentence); confirm the `speech` tokens arrive and an AI answer outside the game's vocabulary is
      still voiced.
- [ ] Production env: `ELEVENLABS_API_KEY` set; `VIVOLITH_VOICE_MOCK` unset; `NEAR_MERCHANT_SECRET` set (also the
      speech-token secret); Upstash Redis configured, otherwise the shared `voice:chars` budget is per instance only.
- [ ] On the deployed site: an arbitrary line to `/api/near/voice` answers 403 "not a line of this game", and so does a new
      sentence made of game words (Phase 4: approved sentences, `server/near/lines.json`, replaced the word list).
- [x] A real Lin sale on testnet acted out in the street (Phase 4, 2026-11-13: 3 transactions, see PROGRESS.md).
- [ ] Connected session: the client's own receipt polling picks up a resident trade and sends them on the errand
      (needs the market-turn cap from §1 before a connected session runs). Dev has not traded live.

## 5. Production release

- [ ] Deploy from a clean worktree (`npm run deploy`; uncommitted audio not shipped); page meta matches the commit.
- [ ] 13/13 checks, client typecheck, build; API bundle built from the same tree.
- [ ] Status route: driver, agents, Redis; `market-turn` 401 without the secret.
- [ ] Browser pass on vivolith.world: welcome, guest, first trade, Rent Night, report. Frame time measured with the
      pane visible. Known: trade panel overlaps the objective card at 800x600 (`car_van.glb` 404 fixed in Phase 5).
- [ ] Phase 5 look at 1080p with the pane visible: frame time on the market, depot and avenue route, and a human listen
      to street sounds under a merchant conversation (passing car panned, ducked under the voice).
