# Asset sources and attribution

Every third-party asset used in VIVOLITH is listed here with its source and license.
Assets we created ourselves (Blender scripts in `blender/`, code-built geometry in `src/`) are MIT with the code.

## Licence scope

The MIT licence in `LICENSE` covers the code and the assets our Blender scripts build from scratch. It does not cover
the files below. They are included only so the game builds and runs; do not extract or reuse them outside VIVOLITH.

| Files | Source | Terms |
|---|---|---|
| `public/models/v2/kavi.glb`, `v2/cast/*.glb` (all characters), `v2/props/*.glb` | Generated with Tripo, then processed by our scripts | Tripo's terms for the plan used at generation time |
| `public/audio/**` | Generated with ElevenLabs on a paid (Starter) plan | ElevenLabs terms; paid plans allow commercial use |
| `public/brand/*` (except `vivolith-mark.svg`), `assets-src/brand/**`, the marks modelled into `spire.glb` and `v2/landmarks/*.glb` | NEAR, NEAR AI and NEAR Intents marks | Trademarks of their owners |
| `public/draco/*` | Draco decoder from three.js | Apache-2.0 |
| `public/hdri/*`, Poly Haven parts of `spire.glb`, `v2/plaza.glb` and `v2/town.glb` | Poly Haven | CC0 |

## NEAR brand assets (provided by the team, downloaded from official NEAR brand resources)

| File in repo | Original | Notes |
|---|---|---|
| `assets-src/brand/near-wordmark.svg` | `logo.svg` | NEAR wordmark + symbol (black). Used as `public/brand/near-wordmark-white.svg` (fill set to white) on the title card |
| `assets-src/brand/near-symbol.svg` | `favicon.svg` | NEAR symbol. Used as `public/brand/near-symbol.svg` (the tab icon is our own `public/brand/vivolith-mark.svg`) |
| `public/brand/nearai-primary-color.svg`, `nearai-tile-color.svg`, `nearintents-Logo-Icon.svg` | near.ai/brand; defuse-protocol/defuse-frontend | NEAR AI and NEAR Intents marks on the fictional landmark buildings (`blender/build_landmarks.py`); sources in `public/brand/README.md` |
| `assets-src/brand/kit/Tertiary/01_Color/tile-color.svg`, `tile-color@1x.png` | brand kit zip | NEAR app-tile symbol, read by `blender/build_street.py` |

Usage follows the NEAR brand guidelines (v2.0 PDF, not committed, 44 MB): no recoloring beyond the
official monochrome versions, no effects on the logo, and the symbol is used sparingly. Palette used: Blue
`#0091FD`, Sky `#83DCFF`, Dark Grey `#272727`, Grey 300 `#EEEEEB`. The brand typeface (PP Neue
Montreal) is commercial and not bundled; the UI uses system fonts.

## Poly Haven (CC0 1.0, no attribution required; credited anyway)

Downloaded by `tools/fetch_polyhaven.py` into `assets-src/downloads/polyhaven/` (not committed), then assembled,
decimated and texture-capped by the Blender builds (`blender/build_street.py` is the shared material and asset library
that `build_spire.py`, `build_v2_plaza.py` and `build_v2_town.py` load). The first table lists the street library's
assets; the second, those added for the NEAR Spire.
License: https://polyhaven.com/license

| Asset | Author(s) | Used for |
|---|---|---|
| [Modular Urban Apartments Facade](https://polyhaven.com/a/modular_urban_apartments_facade) | James Ray Cock | Every building facade and the Ledger Tower shaft (plaster re-tinted via a generated greyscale copy, `assets-src/generated/facade_plaster_neutral.png`) |
| [Modular Fire Escape](https://polyhaven.com/a/modular_fire_escape) | Juniix | Market Lane north facade |
| [Street Lamp 01](https://polyhaven.com/a/street_lamp_01) | Josh Dean | Street and plaza lamps |
| [Fire Hydrant](https://polyhaven.com/a/fire_hydrant) | Gonçalo Felício | Sidewalk |
| [Metal Trash Can](https://polyhaven.com/a/metal_trash_can) | GurJas Studios | Sidewalk |
| [Utility Box 01](https://polyhaven.com/a/utility_box_01) | James Ray Cock | Sidewalk |
| [Exterior Aircon Unit](https://polyhaven.com/a/exterior_aircon_unit) | Monsta3D | Facades |
| [Water Manhole Cover](https://polyhaven.com/a/water_manhole_cover) | Raunox | Road |
| [Planter Box 01](https://polyhaven.com/a/planter_box_01) | James Ray Cock | Sidewalk, plaza |
| [Barrel 01](https://polyhaven.com/a/Barrel_01) | Jorge Camacho | Sidewalk |
| [Cardboard Box 01](https://polyhaven.com/a/cardboard_box_01) | Rahul Chaudhary | Sidewalk |
| [Plastic Crate 01](https://polyhaven.com/a/plastic_crate_01) | PierreB3D | Stall goods |
| [Wicker Basket 01](https://polyhaven.com/a/wicker_basket_01) | Kuutti Siitonen | Stall goods |
| [Wooden Lantern 01](https://polyhaven.com/a/wooden_lantern_01) | James Ray Cock | Stall lanterns |
| [Bananas](https://polyhaven.com/a/bananas) | Alexander Shulha | Stall goods |
| [Food Apple 01](https://polyhaven.com/a/food_apple_01), [Lime 01](https://polyhaven.com/a/food_lime_01), [Pomegranate 01](https://polyhaven.com/a/food_pomegranate_01) | Oliver Harries | Stall goods |
| [Lemon](https://polyhaven.com/a/lemon), [Yellow Onion](https://polyhaven.com/a/yellow_onion) | Kuutti Siitonen | Stall goods |
| [Cobblestone Floor 08](https://polyhaven.com/a/cobblestone_floor_08) | Rob Tuytel | Market Lane road |
| [Concrete Pavement](https://polyhaven.com/a/concrete_pavement) | Charlotte Baglioni | Sidewalks |
| [Patterned Paving](https://polyhaven.com/a/patterned_paving) | Charlotte Baglioni | Plaza |
| [Beige Wall 001](https://polyhaven.com/a/beige_wall_001) | Dimitrios Savva, Rico Cilliers | Tower stone, fountain |
| [Brown Planks 05](https://polyhaven.com/a/brown_planks_05) | Rob Tuytel | Stalls, benches |
| [Venice Sunset (HDRI)](https://polyhaven.com/a/venice_sunset) | Greg Zaal | Image-based lighting (`public/hdri/`) |

### Added for the NEAR Spire (Gate 3, 2026-11-06), CC0, fetched by `tools/fetch_polyhaven.py`

| Asset | Author(s) | Used for (in `spire.glb`) | Status |
|---|---|---|---|
| [Granite Tile](https://polyhaven.com/a/granite_tile) | Charlotte Baglioni | Protocol Plaza paving, gap paving | Integrated, verified in game |
| [Marble 01](https://polyhaven.com/a/marble_01) | Rob Tuytel | Lobby floor, reception desk top | Integrated, verified |
| [Terrazzo Tiles](https://polyhaven.com/a/terrazzo_tiles) | Amal Kumar | NEAR Labs floor | Integrated, verified |
| [Brushed Concrete](https://polyhaven.com/a/brushed_concrete) | Dario Barresi, Dimitrios Savva | Tower base course, lobby core, Labs walls, pool rim, planter walls | Integrated, verified |
| [Metal Plate](https://polyhaven.com/a/metal_plate) | Rob Tuytel | Spandrel bands, crowns, atrium roof, canopy | Integrated, verified |
| [Metal Office Desk](https://polyhaven.com/a/metal_office_desk) | Ulan Cabanilla | 4 Labs workbenches (measured top 0.788 m) | Integrated, verified |
| [Modern Arm Chair 01](https://polyhaven.com/a/modern_arm_chair_01) | Vibrant Nordic | Labs seating | Integrated, verified |
| [Desk Lamp Arm 01](https://polyhaven.com/a/desk_lamp_arm_01) | Yann Kervran, Kuutti Siitonen | Labs desks | Integrated, verified |
| [Office Notepads](https://polyhaven.com/a/office_notepads) | Ulan Cabanilla | Labs desks | Integrated, verified |
| [Sofa 03](https://polyhaven.com/a/sofa_03), [Modern Coffee Table 01](https://polyhaven.com/a/modern_coffee_table_01) | Fran Calvente; Amin | Lobby lounge | Integrated, verified |
| [Potted Plant 01](https://polyhaven.com/a/potted_plant_01), [Potted Plant 04](https://polyhaven.com/a/potted_plant_04) | Rico Cilliers; James Ray Cock | Lobby | Integrated, verified |
| [Planter Box 02](https://polyhaven.com/a/planter_box_02) | James Ray Cock | Precinct planter walls | Integrated, verified |
| [Street Lamp 02](https://polyhaven.com/a/street_lamp_02) | Josh Dean | Plaza approach lamps (was "downloaded, unused") | Integrated, verified |
| [Modern Ceiling Lamp 01](https://polyhaven.com/a/modern_ceiling_lamp_01) | James Ray Cock | Downloaded, not used yet | - |

Modelled by us in `blender/build_spire.py` (MIT): both towers (curtain wall, fins, spandrels, crowns, LED edges), the
inclined atrium and diagrid, both hook wedges, storefront frame and doors, canopy, reception, elevator bank, feature wall
(NEAR symbol extruded from the official SVG path, white, unmodified shape), monolith, totem, monitors, server racks,
agent-feed board, pool, planter walls, beacon mast.

Downloaded but not used yet: Rollershutter Door / Window 01 (planned: closed-shop shutters),
Modular Electricity Poles, Street Lamp 02, Modular Street Seating, Modular Metal Gutter, Wicker Basket 02,
Lantern 01, Modular Wooden Pier.

Built in Blender by us (MIT with the code): market stalls, awnings, benches, fountain, Ledger Tower
belfry/roof/lantern, string lights, shop signs.

## Generated with Tripo (AI 3D)

Generated on tripo3d.ai with the team's paid API credits, then made game-ready by `blender/build_kavi_tripo.py`,
`blender/build_tripo_props.py` and `blender/fix_cars.py` (scale, ground, collision, texture cap, wheel split, shading).
Raw outputs stay in `assets-src/tripo/out/` and `library/` (git-ignored, not redistributed).

| Game file | What |
|---|---|
| `public/models/v2/kavi.glb` | Kavi, the player (Tripo Studio model, humanoid auto-rig, preset clips) |
| `public/models/v2/cast/merchant_fruit.glb` | Pema's model |
| `public/models/v2/props/*.glb` | EV sedan, EV pickup, fruit stall, corner shop, kiosk, vending machine, food and coffee trucks |

Every other cast file in `public/models/v2/cast/` (Tomas, Mira, Arin, Ines, Bram, folk1-6) is a Tripo Studio character
built by `blender/build_studio_character.py` with Tripo's own preset clips.

## Audio (ElevenLabs, AI-generated)

All 50 files in `public/audio/` (merchant voices, effects, ambience, music) were generated once by
`scripts/audio/generate.ts` from `src/v2/audio-manifest.ts` with ElevenLabs `eleven_v4` (voices, ElevenLabs
pre-made voices), `eleven_text_to_sound_v3` (effects, ambience) and `music_v2_5` (music), on the ElevenLabs Starter plan.

## Other runtime files

`public/draco/`: Draco decoder copied from three.js (`three/examples/jsm/libs/draco/gltf`, Apache-2.0).

## Not used

No ripped or commercial game assets. Nothing from the GTA series.
