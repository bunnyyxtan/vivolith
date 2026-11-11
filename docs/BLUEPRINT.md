# VIVOLITH Blueprint: living economy, visuals, audio

Written 2026-11-10. Research and diagnosis only. No code was changed. Nothing here is approved yet.

Evidence labels used throughout:

- **[repo]** read in this repository today.
- **[live]** observed on https://vivolith.vercel.app today (screenshots and page state).
- **[source]** fetched today, link in the last section.
- **[memory]** from my training knowledge, not re-fetched today. Treat as a lead, not a citation.
- **[inference]** my judgement.

Coverage limit, stated plainly: I verified the repo, the live game, the track rules, Worldo, NEAR AI pricing and 67.js. I did not re-fetch developer talks or player reviews for the twenty-plus reference games. Those lessons are marked [memory]. I did not read 67.js source beyond its README, package.json and file tree.

---

## 1. Current state, honestly

### What is real and strong

| Fact | Evidence |
|---|---|
| One NEP-245 contract holds coin, goods and stall shares; merchants post prices with their own keys; players sign through a relayer with no popups | [repo] `contracts/market/src/lib.rs`, `docs/PROGRESS.md` |
| Exact dividends, reserve-backed shares, Guild loans, idempotent rent and settlement, live audit | [repo] `docs/ECONOMY_MATH.md`, PROGRESS table of 2026-11-09 |
| Guided first day (7 steps), gold world marker, haggle with tactics, invest, week fast-forward with report, proof screen | [repo] `src/v2/guide.ts`, `src/v2/play.ts`; [live] objective card and marker |
| 30 townsfolk with an hourly rhythm, queues that react to stall pull, gossip from the live economy, porters carrying crates | [repo] `src/v2/npc.ts`; [live] `__npcs.length === 30` |
| Named areas already built: Harbor Depot, Mango Orchard, Builders' Yard with food trucks, Spire Station, Demo Day Lawn, NEAR AI Lab, Intents Exchange | [repo] `src/v2/props.ts`; [live] placard and landmark positions |
| 108 to 119 fps at 1080p on the RTX 3050 | [repo] PROGRESS |

### What is weak

| Problem | Evidence |
|---|---|
| `README.md` says the economy and NEAR integration "are not built yet" and that you play as Remy. AI judges verify README claims | [repo] README lines 7 to 12, 79 to 82; [source] hackathon Q-017 |
| Coin enters from nowhere. `street_sale` mints coin for anonymous shoppers. Townsfolk purchases are "visual only (no economy demand hook)" | [repo] `lib.rs:351`, `npc.ts:5` |
| No NEAR AI use anywhere | [repo] grep, zero hits in `src` and `server` |
| The landmark buildings have no interaction | [repo] `src/v2/landmarks.ts` only loads meshes |
| No night. Sun direction and sky colours are constants | [repo] `src/v2/look.ts:26, 40` |
| No audio at all | [repo] zero audio code, no audio files |
| Google sign-in and pointer lock in a normal Chrome tab are untested | [repo] PROGRESS |

### Why it may lose today

A judge sees a pretty street, four stalls, buy, sell, invest. That is the track's own starter template, and Worldo already ships logistics on top of it. [inference]

---

## 2. Competitors

| | VIVOLITH | Worldo | NIMS |
|---|---|---|---|
| Verified today | repo and live | README only [source] | Repo returns 404 today. Details below come from your earlier report, unverified |
| World | One 3D anime city, on foot | Three 3D cities | Market-town UI |
| Loop | Haggle, deliver, invest | Gather, refine, carry fuel, build a station | Trade with 8 merchants, odd jobs |
| AI | None yet | NEAR AI mayors set wages, bounties, reserves, price within 15% | AI rewrites price explanations |
| Default local run | Chain live on testnet | Chain and AI off, scripted replies | Unknown |
| Skill mechanic | Real-time haggle | None described | None described |
| Ledger rigor | Proofs, invariants, live audit | Not described | Not described |

Overlap that no longer differentiates: wallets for NPCs, dynamic prices, shares, social login, fast-forward. [inference]

Gaps we can own:

1. **A skill verb.** Nobody else has one. Haggling is ours.
2. **Individual residents whose money you can follow.** Worldo has three mayors. NIMS has merchants. Neither has ordinary people with wallets.
3. **Provable conservation.** We already have the audit. Nobody else shows one.
4. **Look and sound.** A cohesive anime city with audio beats both on first impression.

---

## 3. What reference games teach (compressed)

All [memory] unless marked.

| Game or work | Lesson for VIVOLITH |
|---|---|
| EVE Online | Track faucets and sinks explicitly; trade only moves money. CCP publishes both monthly [source] |
| Offworld Trading Company | Economics can be the conflict if consequences show within seconds |
| Anno 1800 | Places matter when they are steps in a chain |
| Eco | Specialisation creates reasons to trade |
| RimWorld | Believable life comes from needs plus a priority scheduler, not from a language model. A director adds pressure and recovery |
| Dwarf Fortress | An economy needs enough jobs and goods to make sense. Do not simulate what nobody will see |
| Oblivion Radiant AI | Schedules sold the world. Free-form needs caused chaos and were cut back [source, secondary] |
| Stardew Valley, Animal Crossing | Fixed daily schedules, shops with hours, and one small thing changed each day bring players back |
| Zelda BotW | Teach by doing in a safe space. Landmarks pull you across the map |
| Generative Agents (Park et al., 2023) | Memory, reflection and planning each add believability, with 25 agents [memory, arXiv 2304.03442] |
| AI Town | Game loop stays rule-based; model calls are asynchronous side jobs |
| Victoria 3 | Depth behind menus exhausts new players |

Design rule that follows: **deep simulation underneath, one simple verb on top, and every state change visible in the street.**

---

## 4. Three directions

### A. Rent Night (living supply city)

- **Fantasy:** a city where everyone must make rent by 21:00, and you can change who makes it.
- **Loop:** see who is short, deliver or haggle or lend, watch the street react, face rent night.
- **Economy:** tourists bring money in, residents circulate it, rent and freight take it out.
- **Agents:** about 12 residents and 4 merchants with wallets, jobs, hunger, and one daily plan.
- **World:** every existing area is a step in the chain.
- **Progression:** courier, trader, shareholder, lender, agent owner.
- **Risk:** breadth. Effort: about 25 hours.

### B. Agent Boss

- **Fantasy:** build a company of autonomous agents and manage it.
- **Loop:** set rules and budgets, check results, tune.
- **Strength:** fits NEAR's agent themes. **Weakness:** becomes a dashboard, and the 3D city turns into decoration. Effort: about 20 hours, but it discards the on-foot game.

### C. Everything Is Negotiable

- **Fantasy:** a negotiation role-playing game. Wages, rents, loans and prices are all haggled.
- **Loop:** read a person's situation, pick tactics, close a deal that both ledgers honour.
- **Strength:** deepens our one unique verb. **Weakness:** less of a "living city", closer to a duel game. Effort: about 15 hours.

### Recommendation

**Build A as the spine. Use C's haggle as the 30-second verb. Take one agent slot from B only if time remains.**

Why: A answers the track sentence word for word, reuses the areas and townsfolk that already exist, and needs no contract change (section 5). C alone leaves the city unused. B alone discards the game.

Where I disagree with the brief:

- **Interiors:** no. A door, a counter and a panel give the same gameplay for a tenth of the cost.
- **Hundreds of AI NPCs:** no. Twelve with real wallets beat three hundred chatbots.
- **New characters, buildings, vehicles:** none. Fix the ones that exist.

---

## 5. Economy architecture

### Money and goods

| Flow | Rule | Where |
|---|---|---|
| Faucet | Tourists arrive at Spire Station and buy at stalls | existing `street_sale` [repo] |
| Circulation | Residents earn wages from merchants and landmarks, buy food at stalls and trucks | existing `buy` and `mt_transfer` |
| Sink | Rent to the Guild, harbor freight, spoilage | existing `charge_rent`, `operator_burn` |
| Goods in | Orchard picking at 07:00, harbor shipments | existing `operator_mint` (goods only) |
| Goods out | Eaten by residents and tourists | burn on purchase |

Key design move: **shrink the anonymous faucet, add named residents.** Today all demand is minted coin. After the change, tourists are the only faucet and they are visible (they get off the tram). Residents spend only what they earned. [inference]

No contract change is needed: `register_player` accepts any account, and residents can be server-held accounts like guests. [repo] `lib.rs:310`. Still to confirm: that each resident's 40-coin starter purse is acceptable as their opening balance, and the storage cost of about 16 accounts.

### Chain of consequences (example that is not the mango one)

1. A tram strike event halves tourists for a day.
2. Stall revenue drops. Tomas cuts his porter's hours.
3. The porter skips lassi that evening. Arin's Tea House sells less.
4. Arin lowers his mango bid. Pema is left with unsold fruit.
5. The player can haggle Pema's surplus cheap and sell to the night food trucks, or lend the porter rent money at interest.
6. Rent night: whoever the player helped keeps their lights on.

### Invariants (all testable headless)

- Total coin changes only by starter purses, tourist sales, rent and freight burns.
- Goods minted equal goods held plus goods eaten.
- No balance below zero. No wage paid from an empty till.
- Each rent, wage and dividend settles exactly once per day.

### Making it visible

- Hunger icon over a resident who could not afford food.
- Stall lights dim when the till is under rent.
- **Follow the coin:** tap any payment and a gold thread traces where that coin went next, across the street, for ten seconds.

---

## 6. Agent architecture and NEAR AI

### Layers

| Layer | Runs | Does |
|---|---|---|
| Deterministic sim | every game minute | balances, stock, prices, hunger, schedules |
| Utility rules | every game half hour | work, eat cheapest acceptable food, go home |
| NEAR AI plan | once per game day per named agent | pick one action from an allowed list, with a reason |
| NEAR AI talk | when the player speaks to someone | reply in character from real state and memory |
| Validator | on every AI action | bounds, funds, cooldown; reject or fall back |
| Chain | on money or goods moving | existing relayer and contract |

### Per-agent state

`id, role, account, cash, inventory, home, workplace, hunger, mood, plan, relation to player, last 10 events`.

### Allowed actions (examples)

`raise_bid, lower_price, post_bounty, cut_hours, hire, switch_supplier, ask_loan, do_nothing`. Each has numeric limits. The model returns JSON. Prose replies never move money.

### Failure rules

- 4 second timeout, then the scripted rule decides.
- Malformed or out-of-bounds output is dropped and logged.
- Plans are cached per world day. The world is shared, so plans are per world, not per player.

### Cost [source for rates; arithmetic mine]

NEAR AI Cloud is OpenAI-compatible at `cloud-api.near.ai`, pay per token, no minimum. A snapshot about 25 days old lists GLM 5.3 Flash at $0.08 in and $0.50 out per million tokens. Check the live catalog before buying.

| Load | Calls | Cost at that rate |
|---|---|---|
| One conversation turn (1,500 in, 150 out) | 1 | about $0.0002 |
| 16 agents, one plan per game day, 100 game days | 1,600 | about $0.32 |
| 10,000 conversation turns during judging | 10,000 | about $2 |

**Buy $10 to $20 of credits, after one latency test.** Cost is not the constraint. Latency and reliability are, and both are unmeasured.

---

## 7. Districts (existing geometry only)

| Place | Role | Player does | Cost |
|---|---|---|---|
| Saltlight Market | Retail | Haggle, sell, invest | exists |
| Mango Orchard | Production at 07:00 | Buy at source, cheaper | low |
| Harbor Depot | Imports and freight | Release shipments, carry crates | exists |
| Spire Station | Tourist arrivals (the faucet) | Read today's arrivals board | low |
| Builders' Yard | Night market, food trucks | Supply trucks after 21:00 | medium |
| N Spire | Guild bank and City Ledger | Borrow, lend, read the audit | medium |
| NEAR AI Lab | The city's mind | Ask why something happened; read an agent's plan | medium |
| Intents Exchange | Order board | Fill "6 mangoes under 4c by 18:00" | medium |
| Agent Plaza | One agent trades by your rule | Set rule and budget | high, Tier 2 |

Real NEAR Intents stays out: it has no testnet. [repo] PROGRESS. The board is an in-game solver and is labelled as such.

---

## 8. Player journey and interface

| Time | Experience |
|---|---|
| 15 seconds | Spire in frame, music starts, one objective, gold marker |
| 60 seconds | Reach Pema, see empty shelves and a customer leaving, accept |
| 5 minutes | First haggle, first delivery, shelves refill, queue returns, coins sound |
| 15 minutes | Sunset. Rent night. One stall you ignored goes dark |
| 1 hour | Shares, loans, the night market, the order board |
| Next day | "While you were away" told by a resident, with real numbers |

Rules: one objective on screen; icons over heads instead of panels; no words such as wallet, gas, token or transaction in the normal flow; proof lives behind one "Receipt" object.

---

## 9. Visual diagnosis

The world is better than you fear. Trees, pavers, signage, the Spire and Kavi at mid distance read well. [live] Five defects cause most of the cheap look.

| # | Defect | Root cause | Evidence |
|---|---|---|---|
| 1 | Cars are clay blobs that slide | Each car is one fused mesh of 78 to 136 KB. No wheel nodes, so nothing spins. No steering, no body motion. Three of five models are missing | [live] `wheels.length === 0` on all 7 cars; 404 for `car_van.glb`; [repo] `traffic.ts:297, 425` |
| 2 | Thick, ugly outlines | The ink hull has a fixed world thickness and is applied to every mesh. Close up it becomes a slab; on hair it turns into black shards | [repo] `toon.ts:69 to 99`; [live] close-up screenshot |
| 3 | Flat, plastic surfaces | The toon conversion drops normal and roughness maps. Tripo props ship with baked-light colour only | [repo] `toon.ts:30 to 42`; GLB check: no `normalTexture` in props |
| 4 | Glare at midday | Street lamps and stall bulbs are emissive all day and bloom | [live] market screenshots |
| 5 | Silence | No audio | [repo] |

Smaller: flat untextured ground in the market square; primitive flowers; visible flat planes past the map edge at about (45, 96). [live]

Hypothesis, not confirmed: ACES tone mapping followed by a saturation boost of 1.3 fights the anime palette. Three.js ships `NeutralToneMapping`, built to keep base colours. [source] Test by A/B screenshot before deciding.

### Tripo raw versus finished

| Step | Raw import (today) | Finished asset |
|---|---|---|
| Parts | One fused mesh | Split: body, glass, lights, 4 wheels with pivots |
| Normals | As generated, lumpy | Smoothed, hard edges marked |
| Colour | Baked light and shadow | Flat palette colours from the art bible |
| Scale | Arbitrary | Checked against Kavi (1.8 m) |
| Check | None | Screenshot in game at 3 distances before commit |

**Stop generating assets. Repair the two cars and the stall first.**

---

## 10. Art direction and render stack

- **Palette:** sky blue, NEAR mint, cream, warm wood, one accent gold. Shadows cool blue, never grey or black.
- **Outlines:** characters and hero props only. Thickness constant in screen pixels, clamped. Ink is a darker shade of the surface colour, not one navy for everything.
- **Shading:** two or three band ramp, warm light, cool shadow, soft rim.
- **Smallest stack that works:** toon materials, one sun with shadows, hemisphere fill, fog, bloom on emissives only, blob contact shadows under characters and cars. Skip ambient occlusion passes, cascaded shadows and reflections.
- **Day and night:** four keyframes (dawn, day, dusk, night) that blend sky colours, sun colour and strength, fog, exposure and emissive strength from the game clock. This also fixes defect 4.

Targets: 60 fps at 1080p on the RTX 3050, measured with `__v2.frameTime(60)` on the same route as PROGRESS.

---

## 11. Motion

| Thing | Change | Technique |
|---|---|---|
| Cars | Wheels spin, front wheels steer, body leans and dips | Rear-axle path following; steer angle from path curvature; pitch from acceleration |
| Merchants | Greet, gesture in haggle, restock | Reuse existing Mixamo clips, triggered by sim events |
| Townsfolk | Already good | Keep |
| Kavi | Already tuned | Keep |

No physics engine. [inference]

---

## 12. Audio

| Layer | Content | Source |
|---|---|---|
| Music | One day loop, one night loop, crossfaded by the clock | Pixabay Content License or CC0. Verify on the licence page at download |
| Ambience | City bed, market murmur, birds by day, crickets by night | Freesound, CC0 filter only |
| Interface and coins | Click, confirm, error, coin, deal struck | Kenney Interface Sounds, reported CC0 [source, secondary] |
| Footsteps | Two surfaces | Freesound CC0 |
| Voices | Procedural babble per letter, pitched per character | Generated in code, no licence, no latency |

Three volume buses with ducking during dialogue. Three.js `AudioListener` and `PositionalAudio` cover it. Keep a `CREDITS.md` with each file's source and licence. Text-to-speech is rejected for now: cost, latency and voice drift.

---

## 13. 67.js

**Reject for this project.**

- It is its own 3D engine that AI agents drive through an MCP server, with PNG previews and image or video export. It is not a Three.js add-on. [source] README, package.json
- Version 0.17.0, MIT, 340 stars, 31 open issues. Three.js appears only in its dev dependencies.
- Adopting it means replacing our renderer four days before the deadline.
- I did not read its source, so I cannot rule out a borrowable technique.

---

## 14. Priorities and roadmap

### Tiers

| Tier | Items |
|---|---|
| 1, must ship | README truth. Car repair and steering. Outline fix. Day and night. Residents with wallets and wages. NEAR AI talk and daily plan. Audio pass. Follow the coin |
| 2, if stable | Spire Ledger panel. AI Lab "ask the city". Order board. One Agent Plaza slot |
| 3, after | Interiors, more characters, council, real Intents, text-to-speech, multiplayer |
| Rejected now | 67.js, new Tripo assets, physics engine, ambient occlusion pass |

### Days (UTC). Freeze is Nov 13 12:00

| Day | Work | Done when |
|---|---|---|
| Nov 10 | README rewrite (1 h). Two cars rebuilt with wheels, steering in `traffic.ts` (4 h). Outline fix, tone-map A/B (3 h) | Wheels spin and steer on video. Close-up of Kavi has a thin line |
| Nov 11 | Day and night lighting (4 h). Residents, wages, tourists, headless 100-day check (6 h) | Coin total moves only by listed faucets and sinks |
| Nov 12 | NEAR AI talk, plan, validator, fallback (5 h). Audio (4 h). Follow the coin (2 h) | Game plays the same with the AI key removed |
| Nov 13 | Tier 2 in listed order until 12:00. Then three cold playtests | No tester asks what to do |
| Nov 14 | Video, final README, submit by 18:00 | Submitted |

This is the edge of what fits. Each item ships alone, so a slip costs one feature. Cut order: Agent Plaza, order board, AI Lab panel, follow the coin.

---

## 15. The 90-second demo

1. Dawn over the Spire. Music. A tram lets tourists off.
2. Pema's shelves are empty. A porter with a hunger icon walks away.
3. Kavi haggles Tomas down. Timing bar, a win.
4. Delivery. Shelves fill. The queue returns. Coins sound.
5. Tap a coin. A gold thread runs from tourist to Pema to the porter to the Tea House.
6. Sunset. Lamps come on. The night market opens.
7. 21:00, rent night. Pema's lights stay on. A stall you skipped goes dark.
8. Ask Pema why. She answers from real numbers.
9. One receipt object. Explorer link. End card.

---

## 16. Verification

| Claim | Test |
|---|---|
| NPC actions change state | Headless run: resident buys, stock and both balances move |
| Conservation | 100-day run, assert the invariants in section 5 |
| AI cannot cheat | Hostile outputs (negative price, huge bounty, prose) all rejected |
| AI down | Remove key, play the first day |
| No duplicates | Replay the same settlement, balances unchanged (exists for rent) |
| Interface matches chain | Purse equals `mt_balance_of` after every step (exists) |
| Reload | Refresh mid-day, state restored |
| Visuals | Same six camera spots before and after, plus `frameTime` |
| Demo | Run the 90-second path five times from a fresh guest |

---

## 17. Skeptical judge, after all of this

1. **Depth past day one.** One strike event is thin. Add two more events if time allows.
2. **Are residents real or theatre?** Show the audit and follow the coin, or it reads as flavour.
3. **Character art.** Mixamo bodies still look like Mixamo. Not fixable this week.
4. **AI latency.** Unmeasured. A slow reply breaks the scene.
5. **Fresh-account reliability on judging day.** Relayer limits, sign-in, pointer lock.

This does not guarantee a win. It removes the reasons to lose and adds two things nobody else shows.

---

## Sources fetched today

- [Track prompt 09-games](https://github.com/nearai/near-hackathon-prompt-examples/blob/main/tracks/09-games.md)
- [Starter prompts README, AI judges](https://github.com/nearai/near-hackathon-prompt-examples)
- [nearhackathon.com](https://nearhackathon.com/)
- [Worldo README](https://github.com/Sacura1/Worldo)
- [NIMS repo, 404 today](https://github.com/EmekaManuel/nims)
- [NEAR AI pricing](https://near.ai/pricing), [models](https://near.ai/models), [quickstart](https://docs.near.ai/cloud/quickstart)
- [67.js](https://github.com/codepawl/67.js)
- [Three.js forum, tone mapping overview](https://discourse.threejs.org/t/tone-mapping-overview/75204)
- [Khronos PBR Neutral announcement](https://www.jonpeddie.com/news/khronos-releases-tone-mapper-specifications/)
- [GDC Vault, Genshin Impact: Crafting an Anime Style Open World (2021)](https://gdcvault.com/play/1027538/-Genshin-Impact-Crafting-an). Found, not watched
- [EVE Online economy update, sinks defined (2015)](https://www.eveonline.com/news/view/eve-economy-update-eve-vegas-2015-report)
- [UESP, Oblivion Radiant AI](https://en.uesp.net/wiki/Oblivion:Radiant)
- [Free game audio guide, licences (secondary)](https://app.cinevva.com/guides/free-sound-effects-music)
