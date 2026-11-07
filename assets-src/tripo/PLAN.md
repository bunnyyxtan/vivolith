# Tripo asset plan (API balance 805 credits = $8.05 after Kavi)

Measured prices: P2 generation 110, v3.1 generation ~20-30, texture 10, rig 25, preset animation 10 each.

## Done
| Asset | Cost | Output |
|---|---|---|
| Kavi (P2 multiview from turnaround, texture, Mixamo-spec rig, idle/walk/run/jump/turn) | 205 | `public/models/v2/kavi.glb` via `blender/build_kavi_tripo.py` |
| EV sedan (P2 text, Model-3-like, badge painted out, NEAR mint) | 120 | `props/ev_sedan.glb` |
| EV pickup (v3.1 from user photo, badge cleaned) | 40 | `props/ev_pickup.glb` |
| Fruit stall (image edit of scene crop 5 + P2 120) | 125 | `props/stall_fruit.glb` |
| Corner shop (v3.1, decimated 1.4M -> 40k tris) | 40 | `props/shop_corner.glb` |
| Fruit merchant (P2 text 120, rig 25, idle/walk 20) | 165 | `cast/merchant_fruit.glb` (Pema) |

Props: `blender/build_tripo_props.py`; placed on `PROP_<asset>__<id>` empties in `build_v2_town.py` by `src/v2/props.ts`,
which also adds the lettered NEAR boards (canvas text, official N symbol). Balance after this round: 325.

## Proposed batch (v3.1 + texture, ~30 each unless noted)
Image inputs are crops of the reference scenes (`ref/scene_market.webp`), so the result matches the look.

| # | Asset | Input | Est. |
|---|---|---|---|
| 1 | Mint compact EV | text + ref | 30 |
| 2 | Teal/white delivery mini-van | text | 30 |
| 3 | Fruit stall, teal canopy, crates | crop | 30 |
| 4 | Plant stall, orange canopy | crop | 30 |
| 5 | Gadget kiosk, cream canopy | crop | 30 |
| 6 | NEAR vending machine | text | 30 |
| 7 | Black lamp post with N banner | crop | 30 |
| 8 | Concrete and wood bench | text | 30 |
| 9 | Tram/bus stop shelter | text | 30 |
| 10 | Utility pole with transformer and wires | text | 30 |
| 11 | Barrier and traffic cones set | text | 30 |
| 12 | Parked scooter | text | 30 |
| 13 | Cafe table set with umbrella | text | 30 |
| 14 | Storefront module A (awning, shutter) | text | 30 |
| 15 | Storefront module B (glass, sign board) | text | 30 |
| 16-19 | NPCs: Pema (fruit), Tomas (harbor), Ines (Labs), citizen; each gen + rig + idle/walk | text | 75 each = 300 |

Total ~750, leaves ~55 for one retry.

Buildings stay Blender-built (modular, bevelled, with Tripo storefront modules on the ground floor):
a whole generated building loses detail at city scale and costs more.
Roads, crosswalks, sidewalks, curbs: Blender script (free).
