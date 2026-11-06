# VIVOLITH: Quality Standard (permanent, adopted 2026-11-06)

VIVOLITH is a long-term game; the hackathon build is its first milestone. Every asset, space and system we ship,
existing or new, is held to the craft of a premium production. This file is the bar. `docs/PROGRESS.md` tracks
where we are against it. Nothing is "done" because it exports or compiles: it is done when it passes the review
below in the running game.

## 1. The bar, by discipline

**Architecture.** Real proportions (3 m floors, 0.2-0.4 m walls, 0.9-1.2 m sills), modelled frames, sills, reveals,
cornices, plinths, roofs and foundations. Glass reflects (env) and, where you can see in, reveals an interior.
No box with a texture on it. Facades carry weathering: dirt at the base, streaks under sills, colour variation.

**Urban design.** Landmarks get view corridors: nothing stands on the axis between a public space and its
landmark. Buildings frame views instead of blocking them; every placement must have a reason (enclosure, framing,
wayfinding, shade). Blocks align to street walls; setbacks are deliberate.

**Ground.** Road, curb, sidewalk, paving and soil are distinct PBR materials with real scale (cobbles ~0.12 m,
pavers 0.3-0.6 m). Transitions are modelled (curb lips, drainage, worn edges), not hard texture seams.
No floating or sunk objects; no visible tiling at play distance.

**Materials.** PBR with albedo, roughness, normal and (where it matters) AO/metalness. Real-world texel density
(~512 px/m hero surfaces, ~256 px/m background). Albedo never pure black or white. No plastic look.

**Lighting.** Sun, sky and IBL agree. Shadows are soft and contact-grounded (GTAO). Practical lights sit in
fixtures that exist. Bloom only on true emitters. Exposure never blows a whole frame out when facing the sun.
Day, golden hour and night are separate tuned presets.

**Characters.** Each named character is a distinct model with a role-appropriate look. Feet on the ground,
no T-poses, no bind-pose freezes, no foot sliding at listed walk speeds, idle never frozen. No clones side by side.

**Physics and interaction.** The player cannot pass through walls, people, furniture or vehicles. Steps up to
0.4 m are climbable, anything taller blocks. Doors and interactive objects behave like their real counterpart.

**UI.** Solid, readable, premium: opaque panels, upright fonts (Cormorant Garamond names, Source Serif 4 lines,
Inter Tight labels), no italics for body text, no novelty textures (no torn paper, brush strokes, wood).
Prompts are short: key cap, verb, target.

**Performance.** 720p full pipeline at or under 8 ms on the RTX 3050 reference, 1080p at or under 16.7 ms. Every
milestone records measured numbers (`__pt.frameTime`, steady state), never an estimate.

## 2. Review before anything is called done

1. Look at it in the running game from street level, medium distance, the skyline and an elevated view.
2. Look at it facing into the sun and with the sun behind you; at golden hour and (when presets exist) at night.
3. Walk into it, around it and through it: collisions, steps, camera.
4. Capture evidence (`await __pt.shot("name")` -> `docs/evidence/`) and write down every defect you see.
5. Fix the defects, then repeat steps 1-4. Record what was fixed.
6. Measure frame time before and after. Run `npm run typecheck`, `node src/economy/economy.check.ts` and
   `node src/physics/collision.check.ts`.

Never ship a known-broken asset to fill space. Remove it and track the gap instead (see the jacaranda below).

## 3. Audit of the current build against this bar (2026-11-06)

| Area | State | Gap / next action |
|---|---|---|
| Spire view corridor | Fixed today | Ledger Tower moved to the plaza corner as a campanile; two axis-blocking blocks removed; 30 m promenade framed by P0/P3 (`docs/evidence/layout-plaza-axis.jpg`) |
| Conversation UI | Rebuilt today | Solid panels and readable type (`ui-dialogue-labs.jpg`). Open: camera framing in tight rooms can sit the NPC behind the response card |
| Facades (Saltlight Row) | Below bar | Clean kit plaster with no weathering, dirt or variation; tinted copies read flat. Add grime/AO masks, base staining, sill streaks |
| District surroundings | Below bar | From elevated views the district ends in flat fallback ground. Needs terrain, a coastline and distant blocks |
| Spire glass | Partial | Reflective and correct, but the office floors are opaque (no interior depth). Add interior-mapped glass |
| Vegetation | Missing | The Poly Haven jacaranda (312k tris, scanned) broke under decimation and was removed. Source an alpha-carded game tree with LODs |
| Lighting into the sun | Below bar | Facing west at golden hour, haze and bloom wash out half the frame. Tune fog colour/density by view angle and the bloom threshold |
| Interiors | Partial | Lobby and Labs furnished and lit; monitors are flat emissive; no stairs or elevator travel |
| Characters | Partial | 11 distinct Mixamo characters; foot sliding and clothing intersections not yet checked per clip |
| Physics props | Missing | Nothing reacts to touch (crates, chairs, doors). Needs a rigid-body layer |
