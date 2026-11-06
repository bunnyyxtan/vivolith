# Asset sources and attribution

Every third-party asset used in NEAR WORLD is listed here with its source and license.
Assets we created ourselves (Blender scripts in `blender/`, code-built geometry in `src/`) are MIT with the code.

## NEAR brand assets (provided by the team, downloaded from official NEAR brand resources)

| File in repo | Original | Notes |
|---|---|---|
| `assets-src/brand/near-wordmark.svg` | `logo.svg` | NEAR wordmark + symbol (black). Used as `public/brand/near-wordmark-white.svg` (fill set to white) on the title card |
| `assets-src/brand/near-symbol.svg` | `favicon.svg` | NEAR symbol. Used as `public/brand/favicon.svg` |
| `assets-src/brand/kit/Tertiary/*` | brand kit zip | NEAR app-tile symbol. `tile-color.svg` is the tower clock face |
| `assets-src/brand/kit/Primary/*`, `Secondary/*` | brand kit zip | **NEAR AI** wordmarks: kept for reference, not used in game (this is a NEAR game, not a NEAR AI product) |

Usage follows the NEAR brand guidelines (v2.0 PDF, not committed, 44 MB): no recoloring beyond the
official monochrome versions, no effects on the logo, and the symbol is used sparingly. Palette used: Blue
`#0091FD`, Sky `#83DCFF`, Dark Grey `#272727`, Grey 300 `#EEEEEB`. The brand typeface (PP Neue
Montreal) is commercial and not bundled; the UI uses system fonts.

## Poly Haven (CC0 1.0, no attribution required; credited anyway)

Downloaded by `tools/fetch_polyhaven.py` into `assets-src/downloads/polyhaven/` (not committed),
assembled, decimated and texture-capped by `blender/build_street.py` into `public/models/saltlight_row.glb`.
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

Downloaded but not used yet: Rollershutter Door / Window 01 (planned: closed-shop shutters),
Modular Electricity Poles, Street Lamp 02, Modular Street Seating, Modular Metal Gutter, Wicker Basket 02,
Lantern 01, Modular Wooden Pier.

Built in Blender by us (MIT with the code): market stalls, awnings, benches, fountain, Ledger Tower
belfry/roof/lantern, string lights, shop signs.

## Characters (Mixamo, Adobe)

Downloaded by the team from https://www.mixamo.com (Adobe account) into `Mixamo/` (gitignored), converted by
`blender/convert_mixamo.py` (root motion stripped from walk/run, textures capped at 1k). Mixamo characters and
animations are royalty-free for use in games under Adobe's terms; the raw FBX files are not redistributed.

| Game file | Character | Clips (source file) |
|---|---|---|
| `public/models/player.glb` | Remy | Idle (`pema_talking.fbx`, misnamed: Remy rig, weight-shift idle), Walk (`Walking.fbx`), Run (`Running.fbx`) |
| `public/models/pema.glb` | Peasant Girl (Auntie Pema) | Idle (`pema_idle.fbx`), Talking (`Talking.fbx`) |

Unused: `Stop Walking.fbx` (Remy, walk-to-stop transition; candidate for a stop animation).

## Other runtime files

`public/draco/`: Draco decoder copied from three.js (`three/examples/jsm/libs/draco/gltf`, Apache-2.0).

## Not used

No ripped or commercial game assets. Nothing from the GTA series.
