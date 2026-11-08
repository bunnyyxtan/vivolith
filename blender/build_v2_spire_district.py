"""The N Spire district behind and beside the towers (exec'd by build_v2_town.py; uses its kit and materials).

Blender coords (three = (x, z, -y)). The Spire stands at x -32..32, y 54..72 on the forecourt (x -34..34, y 46..75).
Each area has one job, and paths tie them to the forecourt, Spire Gardens (west) and Spire Square (east):
  Demo Day Lawn   x -34.5..34.5, y 75..94: stage and screen with the N towers behind it, seating tiers, event lawn.
  Builders' Yard  x -59..-34.5, y 50..73: next to NEAR Labs, outdoor desks, two food trucks, pergola, notice board.
  Mango Orchard   x -59..-34.5, y 74..94: rows of mango trees and picking crates; pickers carry crates to market.
  Spire Station   x 34.5..59, y 50..73: transit canopy, taxi rank with EVs, bike share, ticket machines.
  Harbor Depot    x 34.5..59, y 74..94: warehouse and loading dock where harbor crates land before the stalls.
Spots carry an area tag (spire_amph_, spire_yard_, spire_orch_, spire_stn_, spire_depot_) for the NPC schedule.
"""

AMPH_Y0, AMPH_Y1 = 75.0, 94.0
ZL = 0.08   # lawn top
ZP = 0.11   # paved top in the district (a 3 cm lip over the lawn, well under a step)


def pave(M, x0, y0, x1, y1, mat="path", z=ZP):
    wbox(M[mat], x0, y0, ZL - 0.02, x1, y1, z)


def truss_column(M, x, y, z0, z1, w=0.25):
    """Square aluminium truss column: four chords and rungs every 0.5 m."""
    for dx in (0.0, w):
        for dy in (0.0, w):
            wbox(M["metal"], x + dx, y + dy, z0, x + dx + 0.05, y + dy + 0.05, z1)
    for k in range(int((z1 - z0) / 0.5)):
        zz = z0 + 0.25 + k * 0.5
        wbox(M["metal"], x, y, zz, x + w + 0.05, y + 0.05, zz + 0.04)
        wbox(M["metal"], x, y + w, zz, x + w + 0.05, y + w + 0.05, zz + 0.04)


def placard(ident, x, y, z, dx, dy, post=0.0):
    """Lettered sign face (text from src/v2/props.ts PLACARDS) centred at (x, y, z), readable from direction (dx, dy).
    post > 0 adds a black post of that height under it."""
    empty(f"PLACARD_{ident}", (x, y, z), face_rot(-dx, -dy))
    if post > 0:
        wbox(M_DISTRICT["black"], x - 0.05, y - 0.05, ZL, x + 0.05, y + 0.05, post)
        collider(f"placard_{ident}", x - 0.12, y - 0.12, x + 0.12, y + 0.12, 0, post)


def _face(T, lx, ly, tx, ty):
    """Direction (dx, dy) from local point (lx, ly) toward local point (tx, ty)."""
    a, b = T(lx, ly), T(tx, ty)
    return b[0] - a[0], b[1] - a[1]


# ----------------------------------------------------------- Demo Day Lawn ----
def demo_day_lawn(M):
    z = ZL
    # event plaza along the back of the forecourt, linking both flanks behind the towers
    pave(M, -34.5, AMPH_Y0, 34.5, 78.0)
    for x in range(-33, 34, 6):
        wbox(M["brick"], x, AMPH_Y0, ZP, x + 1.0, 78.0, ZP + 0.006)
    # stage: stone platform, timber deck, LED lip toward the audience (+y), steps up the middle
    sx0, sx1, sy0, sy1, sh = -8.0, 8.0, 78.0, 82.0, 0.85
    wbox(M["stone"], sx0, sy0, ZP - 0.02, sx1, sy1, sh)
    wbox(M["wood"], sx0 + 0.1, sy0 + 0.1, sh, sx1 - 0.1, sy1 - 0.1, sh + 0.04)
    wbox(M["led"], sx0, sy1 - 0.02, sh - 0.12, sx1, sy1 + 0.02, sh - 0.04)
    collider("amph_stage", sx0, sy0, sx1, sy1, 0, sh + 0.04)
    for i in range(5):
        h = min(ZP + (i + 1) * 0.15, sh)
        y0 = sy1 + 1.2 - i * 0.3
        wbox(M["stone"], -1.6, y0, ZP - 0.02, 1.6, y0 + 0.3, h)
        collider(f"amph_step{i}", -1.6, y0, 1.6, y0 + 0.3, 0, h)
    # screen: dark panel in a white frame, the NEAR symbol lit green, held by two truss towers and a top truss
    wbox(M["trim"], -7.4, sy0 + 0.25, sh, 7.4, sy0 + 0.55, sh + 5.4)
    wbox(M["dark"], -7.0, sy0 + 0.55, sh + 0.4, 7.0, sy0 + 0.6, sh + 5.0)
    wbox(M["led"], -7.0, sy0 + 0.6, sh + 0.4, 7.0, sy0 + 0.63, sh + 0.5)
    symbol_mesh("amph_sym", 0.0, sy0 + 0.66, sh + 2.7, 3.0, -0.08, M["led"])
    for tx in (-8.6, 8.35):
        truss_column(M, tx, sy0 + 0.2, ZP, sh + 6.6)
        collider(f"amph_truss{tx:.0f}", tx - 0.1, sy0 + 0.1, tx + 0.35, sy0 + 0.55, 0, sh + 6.6)
    for dy in (0.0, 0.25):
        for zz in (6.35, 6.6):
            wbox(M["metal"], -8.6, sy0 + 0.2 + dy, sh + zz, 8.6, sy0 + 0.25 + dy, sh + zz + 0.05)
    for k in range(6):  # stage spotlights hanging from the top truss
        lx = -6.0 + k * 2.4
        wbox(M["black"], lx - 0.18, sy0 + 0.6, sh + 6.0, lx + 0.18, sy0 + 0.95, sh + 6.35)
        wbox(M["glass_lit"], lx - 0.13, sy0 + 0.95, sh + 6.05, lx + 0.13, sy0 + 0.97, sh + 6.3)
    for sxp in (-10.2, 10.2):  # speaker stacks either side
        wbox(M["dark"], sxp - 0.6, sy0 + 0.6, ZP, sxp + 0.6, sy0 + 1.6, ZP + 2.6)
        for zz in (0.6, 1.4, 2.1):
            wbox(M["black"], sxp - 0.35, sy0 + 1.6, ZP + zz - 0.3, sxp + 0.35, sy0 + 1.63, ZP + zz + 0.3)
        collider(f"amph_spk{sxp:.0f}", sxp - 0.6, sy0 + 0.6, sxp + 0.6, sy0 + 1.6, 0, ZP + 2.6)
    # event lawn in front of the stage, then three seating tiers (stone, timber seat edge) facing the stage
    wbox(M["lawn"], -34.5, 78.0, -0.1, 34.5, AMPH_Y1, z)
    ty0, depth, rise = 86.0, 2.4, 0.45
    for blk, (bx0, bx1) in enumerate(((-21.0, -1.3), (1.3, 21.0))):
        for i in range(3):
            y0 = ty0 + i * depth
            top = z + rise * (i + 1)
            wbox(M["stone"], bx0, y0, z - 0.02, bx1, AMPH_Y1 - 0.4, top)
            wbox(M["wood"], bx0, y0, top, bx1, y0 + 0.55, top + 0.04)
            collider(f"amph_tier{blk}_{i}", bx0, y0, bx1, AMPH_Y1 - 0.4, 0, top + 0.04)
        for k in range(int((bx1 - bx0) / 2.6)):  # audience seats on the front edge of tier one
            spot("bench", f"spire_amph_{blk}{k}", bx0 + 1.3 + k * 2.6, ty0 - 0.35, 0, -1)
    # centre aisle: 0.15 m steps up to the top tier, handrails either side
    for i in range(9):
        y0 = ty0 + i * (depth * 3 / 9)
        h = z + min(rise * 3, 0.15 * (i + 1))
        wbox(M["stone"], -1.3, y0, z - 0.02, 1.3, AMPH_Y1 - 0.4, h)
        collider(f"amph_aisle{i}", -1.3, y0, 1.3, AMPH_Y1 - 0.4, 0, h)
    for x in (-1.25, 1.25):
        railing(x, ty0 + 0.6, x, AMPH_Y1 - 0.6, M, z + 0.5, 0.9, 1.2)
    # top terrace: a lookout with lamps over the stage and the towers
    for x in (-18.0, -9.0, 9.0, 18.0):
        town_lamp(f"amph_lamp{x:.0f}", x, AMPH_Y1 - 0.9, M, False, z + rise * 3 + 0.04, 4.0)
    railing(-21.0, AMPH_Y1 - 0.45, 21.0, AMPH_Y1 - 0.45, M, z + rise * 3 + 0.04, 1.0, 2.0)
    # string lights from the screen trusses out to masts at the lawn corners
    for mx in (-20.0, 20.0):
        cyl(M["black"], mx, 84.6, z, z + 5.2, 0.07, 8)
        collider(f"amph_mast{mx:.0f}", mx - 0.12, 84.48, mx + 0.12, 84.72, 0, 5.2)
        string_lights(mx, 84.6, 8.6 if mx > 0 else -8.6, sy0 + 0.3, z + 5.0, M, 8, 0.6)
    for k, (x, y, dx, dy) in enumerate([(-14.0, 83.5, 1, -1), (14.0, 83.5, -1, -1), (0.0, 84.6, 0, -1)]):
        spot("photo", f"spire_amph_view{k}", x, y, dx, dy)
    for k, (x, y) in enumerate([(-26.0, 76.5), (26.0, 76.5), (-14.0, 76.6), (14.0, 76.6)]):
        spot("chat", f"spire_amph_chat{k}", x, y, 1, 0)
    for x in (-30.0, -22.0, 22.0, 30.0):
        town_lamp(f"amph_plaza_lamp{x:.0f}", x, 77.4, M, True, ZP)
    # fingerposts where the flank paths meet the gardens, the square and the event plaza
    placard("way_w", -33.5, 76.3, 2.1, 1, 0, post=2.5)
    placard("way_e", 33.5, 76.3, 2.1, -1, 0, post=2.5)
    placard("way_gw", -39.0, 48.2, 2.1, 0, -1, post=2.5)
    placard("way_ge", 39.0, 48.2, 2.1, 0, -1, post=2.5)
    for x, y in ((-29.0, 88.0), (-25.5, 92.0), (29.0, 88.0), (25.5, 92.0)):  # shade trees at the lawn ends
        tree(x, y, z, 9.5, M, pit=False)
    lawn_dress(M, -34.0, 82.0, 34.0, 93.5, z, 160, ((-21.5, 82, 21.5, 94), (-12, 78, 12, 86)))


# ----------------------------------------------------------- Builders' Yard ----
def food_truck(M, ident, x, y, rot, asset="food_truck"):
    """Tripo food truck (props/food_truck.glb, hatch on the model's -Y) with its serving side toward local +Y of
    tf(x, y, rot); body collider and two queue spots in front of the hatch."""
    T = tf(x, y, rot)
    prop(asset, ident, x, y, rot + math.pi, ZP)
    col_rot(x, y, 2.7, 1.15, rot, 0, ZP + 3.0, "truck")
    for k, ly in enumerate((2.4, 3.3)):
        px, py = T(0.0, ly)
        spot("stallq", f"spire_yard_{ident}_{'ab'[k]}", px, py, *_face(T, 0.0, ly, 0.0, 0.0))


def builders_yard(M):
    z = ZL
    wbox(M["lawn"], -59.0, 50.0, -0.1, -34.5, 94.0, z)
    pave(M, -57.5, 52.0, -36.0, 72.0)
    for y in range(53, 72, 5):  # timber deck bands under the desks
        wbox(M["wood"], -52.0, y, ZP, -40.0, y + 2.6, ZP + 0.03)
    pave(M, -36.0, 60.0, -34.0, 66.0)                       # door to the forecourt's west edge
    sg_path(M, [(-42.0, 49.0), (-43.0, 52.2)], 3.0)          # and to Spire Gardens
    for r, y in enumerate((54.3, 59.3, 64.3)):               # outdoor desks under umbrellas, two neat rows
        for c, x in enumerate((-49.0, -43.0)):
            cafe_table(f"spire_yard_desk{r}{c}", x, y, M, M["teal"] if (r + c) % 2 else M["orange"], ZP + 0.03, 4)
    food_truck(M, "truck_a", -55.4, 56.0, -math.pi / 2)   # hatches face the desks (+x)
    food_truck(M, "truck_b", -55.4, 65.0, -math.pi / 2, "coffee_truck")
    pergola(M, -45.0, 70.0, 8.0, 3.2, 0.0, ZP)
    # the Labs notice board: what people are building, facing the yard
    wbox(M["tealdk"], -37.4, 53.8, ZP, -37.0, 58.8, ZP + 2.4)
    wbox(M["trim"], -37.45, 54.0, ZP + 0.9, -37.4, 58.6, ZP + 2.25)
    for k in range(6):
        wbox(M[("petal_y", "petal_p", "fabric_cream", "petal_l", "petal_y", "fabric_cream")[k]], -37.5, 54.3 + (k % 3) * 1.4, ZP + 1.1 + (k // 3) * 0.55,
             -37.45, 55.3 + (k % 3) * 1.4, ZP + 1.55 + (k // 3) * 0.55)
    collider("yard_board", -37.5, 53.8, -37.0, 58.8, 0, ZP + 2.4)
    wbox(M["tealdk"], -37.4, 53.8, ZP + 2.4, -37.0, 58.8, ZP + 3.15)
    placard("yard", -37.52, 56.3, ZP + 2.77, 1, 0)
    spot("wait", "spire_yard_board0", -38.6, 55.3, 1, 0)
    spot("wait", "spire_yard_board1", -38.6, 57.4, 1, 0)
    spot("chat", "spire_yard_chat0", -46.0, 67.0, 1, 0)
    spot("chat", "spire_yard_chat1", -40.0, 52.8, 1, 0)
    for mx, my in ((-52.5, 52.6), (-39.5, 52.6), (-52.5, 67.4), (-39.5, 67.4)):  # string lights on black masts
        cyl(M["black"], mx, my, ZP, ZP + 4.4, 0.06, 8)
        collider(f"yard_mast{mx:.0f}_{my:.0f}", mx - 0.1, my - 0.1, mx + 0.1, my + 0.1, 0, 4.4)
    string_lights(-52.5, 52.6, -39.5, 67.4, ZP + 4.2, M, 9, 0.5)
    string_lights(-39.5, 52.6, -52.5, 67.4, ZP + 4.2, M, 9, 0.5)
    for x, y in ((-36.8, 53.0), (-36.8, 71.0), (-57.8, 71.0)):
        town_lamp(f"yard_lamp{x:.0f}_{y:.0f}", x, y, M, True, ZP)
    bin_t(-38.0, 71.2, M, ZP); bin_t(-53.0, 61.0, M, ZP)  # off the entrance line (y 60..66)
    bike_rack(-38.2, 69.0, math.pi / 2, M, ZP, 4)
    for k in range(2):
        bike(-38.2, 68.4 + k * 1.1, math.pi / 2, M, ZP)
    for x0, x1 in ((-58.5, -45.0), (-40.5, -36.5)):          # planted edge toward the gardens, gap for the path
        sp_hedge(M, f"yard_hedge{x0:.0f}", x0, 50.4, x1, 51.4, z)


# ------------------------------------------------------------ Mango Orchard ----
def mango_tree(M, x, y, h, seed):
    town_tree(x, y, ZL, h, seed, 9)
    r = random.Random(seed)
    for _ in range(14):  # ripe mangoes in the lower canopy
        a = r.uniform(0, 2 * math.pi)
        rr = r.uniform(0.9, 2.2)
        blob(M["mango"], (x + math.cos(a) * rr, y + math.sin(a) * rr, ZL + h * r.uniform(0.42, 0.62)), 0.11, 0.11, 0.15, 1)
    collider(f"mango{seed}", x - 0.3, y - 0.3, x + 0.3, y + 0.3, 0, 3.0)


def mango_orchard(M):
    z = ZL
    sg_path(M, [(-46.5, 72.0), (-46.5, 93.5)], 2.6, 0)       # picking lane north-south
    for y in (79.5, 86.5):                                      # cross lanes between the rows
        sg_path(M, [(-58.0, y), (-35.0, y)], 2.0, 0)
    k = 0
    for row, y in enumerate((76.0, 83.0, 90.0)):
        for x in (-56.0, -51.5, -41.5, -37.5):
            mango_tree(M, x + (0.6 if row % 2 else -0.6), y, 6.0 + (k % 3) * 0.6, 5100 + k)
            k += 1
    # picking crates by the lane: pickers carry full ones to the market, empty stacks wait under the trees
    for k, (x, y) in enumerate([(-48.3, 77.5), (-48.3, 84.5), (-44.7, 81.5), (-44.7, 88.5)]):
        spot("crate", f"spire_orch_{k}", x, y, 1 if x < -46.5 else -1, 0)
    for x, y in ((-48.8, 91.6), (-44.2, 74.8)):
        crate(x, y, 0.0, M, z, 3, None)
    crate(-49.0, 81.4, 0.3, M, z, 2, "mango")
    T = tf(-51.0, 83.0, 0.4)                                   # picker's ladder against a tree
    for lx in (-0.25, 0.25):
        obox(M["wood"], T, lx - 0.03, -0.05, z, lx + 0.03, 0.05, z + 2.6)
    for i in range(7):
        obox(M["wood"], T, -0.25, -0.03, z + 0.3 + i * 0.33, 0.25, 0.03, z + 0.34 + i * 0.33)
    T = tf(-43.4, 77.2, 1.2)                                   # wheelbarrow
    obox(M["teal"], T, -0.35, -0.6, z + 0.35, 0.35, 0.3, z + 0.7)
    wheel(M["tyre"], T(0, 0.45) + (z + 0.2,), 0.2, 0.08, "x", 10)
    collider("barrow", -44.0, 76.6, -42.8, 77.8, 0, 0.7)
    lawn_dress(M, -58.5, 74.0, -35.0, 93.5, z, 260, ((-48, 72, -45, 94), (-59, 78.4, -35, 80.6), (-59, 85.4, -35, 87.6)))
    town_lamp("orch_lamp0", -48.3, 92.4, M, False, z)
    placard("orchard", -44.4, 72.6, 2.0, 0, -1, post=2.35)


# ------------------------------------------------------------- Spire Station ----
def spire_station(M):
    z = ZL
    wbox(M["lawn"], 34.5, 50.0, -0.1, 59.0, 94.0, z)
    pave(M, 36.0, 52.0, 51.0, 72.0)
    pave(M, 34.0, 60.0, 36.0, 66.0)                         # door to the forecourt's east edge
    sg_path(M, [(42.5, 49.0), (43.0, 52.2)], 3.0)            # and to Spire Square
    # the canopy: a long white roof on slim columns with a NEAR green LED edge, seen from the square
    cx0, cx1, cy0, cy1, ch = 37.5, 50.0, 56.0, 68.0, 4.2
    wbox(M["trim"], cx0 - 0.6, cy0 - 0.6, ch, cx1 + 0.6, cy1 + 0.6, ch + 0.35)
    wbox(M["led"], cx0 - 0.62, cy0 - 0.62, ch + 0.05, cx1 + 0.62, cy1 + 0.62, ch + 0.12)
    wbox(M["glass_cool"], cx0 + 2.0, cy0 + 2.0, ch + 0.35, cx1 - 2.0, cy1 - 2.0, ch + 0.4)
    for x in (cx0, (cx0 + cx1) / 2, cx1):
        for y in (cy0, cy1):
            cyl(M["trim"], x, y, ZP, ch, 0.14, 10)
            collider(f"stn_col{x:.0f}_{y:.0f}", x - 0.18, y - 0.18, x + 0.18, y + 0.18, 0, ch)
    # platform edge, benches back to back, departure board, ticket machines
    wbox(M["tactile"], 50.4, 52.0, ZP, 50.9, 72.0, ZP + 0.015)
    for k, y in enumerate((58.5, 62.5, 66.0)):
        bench_t(f"spire_stn_b{k}a", 47.6, y, face_rot(1, 0), M, ZP)
        bench_t(f"spire_stn_b{k}b", 46.9, y, face_rot(-1, 0), M, ZP)
    for x in (41.9, 45.6):  # station name hung under the canopy's south edge
        wbox(M["black"], x - 0.02, cy0 - 0.12, ch - 0.95, x + 0.02, cy0 - 0.08, ch)
    placard("station", 43.75, cy0 - 0.14, ch - 1.25, 0, -1)
    wbox(M["dark"], 41.0, 61.7, ch - 1.2, 44.5, 62.3, ch - 0.25)
    wbox(M["glass_lit"], 41.1, 61.65, ch - 1.1, 44.4, 61.7, ch - 0.35)
    wbox(M["glass_lit"], 41.1, 62.3, ch - 1.1, 44.4, 62.35, ch - 0.35)
    for k, y in enumerate((53.5, 54.7)):
        prop("vending_mint", f"stn{k}", 36.7, y, math.pi / 2, ZP)
        collider(f"stn_vend{k}", 36.1, y - 0.55, 37.4, y + 0.55, 0, 1.9)
    spot("stallq", "spire_stn_vend_a", 38.2, 54.1, -1, 0)
    for k, y in enumerate((57.5, 60.0, 63.0, 66.5)):
        spot("wait", f"spire_stn_wait{k}", 49.8, y, 1, 0)
    spot("chat", "spire_stn_chat0", 38.6, 64.0, 1, 0)
    # taxi rank: a drive-through lane with EVs waiting at the kerb
    wbox(M["asphalt"], 51.6, 51.0, ZL - 0.02, 57.6, 93.0, ZL + 0.01)
    wbox(M["curb"], 51.0, 51.0, ZL - 0.02, 51.6, 93.0, ZP + 0.02)
    for y in range(54, 92, 6):
        wbox(M["paint"], 54.5, y, ZL + 0.01, 54.7, y + 3.0, ZL + 0.015)
    for k, y in enumerate((57.0, 63.5)):
        prop("ev_sedan", f"stn_taxi{k}", 53.2, y, 0.0, ZL)
        collider(f"stn_taxi{k}", 52.2, y - 2.4, 54.2, y + 2.4, 0, 1.6)
    for k in range(2):                                          # bike share dock on the canopy's north side
        bike_rack(42.0 + k * 3.4, 70.6, math.pi, M, ZP, 5)
        for j in range(4):
            bike(40.9 + k * 3.4 + j * 0.55, 70.6, math.pi, M, ZP, M["car_m"])
    for x, y in ((36.6, 70.8), (36.6, 57.0)):
        town_lamp(f"stn_lamp{x:.0f}_{y:.0f}", x, y, M, True, ZP)
    # station totem facing the square: the NEAR symbol on a white slab
    wbox(M["trim"], 47.4, 50.6, ZP, 49.6, 51.2, ZP + 3.4)      # beside the path from the square, not on it
    symbol_mesh("stn_sym", 48.5, 50.55, ZP + 2.4, 1.1, 0.06, M["teal"])
    collider("stn_totem", 47.4, 50.6, 49.6, 51.2, 0, ZP + 3.4)


# -------------------------------------------------------------- Harbor Depot ----
def harbor_depot(M):
    pave(M, 36.0, 73.0, 51.0, 93.0, "walk")
    # warehouse: cream walls, teal roller doors on the dock side (west), clerestory lights
    wx0, wx1, wy0, wy1, wh = 41.0, 50.5, 80.0, 92.5, 5.2
    wbox(M["walls"][0], wx0, wy0, ZP, wx1, wy1, wh)
    wbox(M["roof"], wx0 - 0.3, wy0 - 0.3, wh, wx1 + 0.3, wy1 + 0.3, wh + 0.3)
    for k in range(3):
        y = wy0 + 1.6 + k * 3.6
        wbox(M["tealdk"], wx0 - 0.05, y, ZP + 1.0, wx0, y + 2.6, ZP + 4.0)
        for s in range(10):
            wbox(M["teal"], wx0 - 0.07, y, ZP + 1.1 + s * 0.29, wx0 - 0.05, y + 2.6, ZP + 1.16 + s * 0.29)
        wbox(M["glass_lit"], wx0 - 0.08, y + 0.3, ZP + 4.2, wx0 - 0.05, y + 2.3, ZP + 4.4)
    wbox(M["stone"], wx0 - 2.0, wy0, ZP, wx0, wy1, ZP + 1.0)    # loading dock
    collider("depot_dock", wx0 - 2.0, wy0, wx0, wy1, 0, ZP + 1.0)
    collider("depot_shed", wx0, wy0, wx1, wy1, 0, wh + 0.3)
    wbox(M["trim"], wx0 - 0.1, wy0 + 2.0, wh - 0.9, wx0 - 0.05, wy1 - 2.0, wh - 0.2)  # sign band
    placard("depot", wx0 - 0.13, (wy0 + wy1) / 2, wh - 0.55, -1, 0)
    # crates on pallets along the dock: the harbor's mangoes waiting for the stalls
    for k, y in enumerate((80.8, 84.4, 88.0, 91.4)):
        wbox(M["wood2"], wx0 - 3.6, y - 0.6, ZP, wx0 - 2.4, y + 0.6, ZP + 0.14)
        crate(wx0 - 3.0, y - 0.3, 0.0, M, ZP + 0.14, 2 + k % 2, "mango")
        crate(wx0 - 3.0, y + 0.35, 0.0, M, ZP + 0.14, 1 + (k + 1) % 2, "mango" if k % 2 else None)
    for k, (x, y) in enumerate([(38.4, 79.0), (38.4, 86.0), (38.4, 90.0)]):
        spot("crate", f"spire_depot_{k}", x, y, 1, 0)
    prop("ev_pickup", "depot", 48.0, 76.2, -math.pi / 2, ZP)   # the delivery pickup, parked clear of the walking lines
    collider("depot_pickup", 45.2, 75.2, 50.8, 77.2, 0, 1.9)
    T = tf(42.5, 78.4, 0.0)                                     # dispatcher's desk by the first door
    obox(M["shelf"], T, -0.7, -0.4, ZP, 0.7, 0.4, ZP + 0.85)
    obox(M["trim"], T, -0.8, -0.5, ZP + 0.85, 0.8, 0.5, ZP + 0.9)
    collider("depot_desk", 41.7, 77.9, 43.3, 78.9, 0, 0.9)
    spot("wait", "spire_depot_desk", 42.5, 77.0, 0, 1)
    for k in range(3):
        cone(36.8 + k * 0.6, 92.4, M, ZP)
    for x, y in ((36.6, 74.0), (36.6, 92.0)):
        town_lamp(f"depot_lamp{x:.0f}_{y:.0f}", x, y, M, False, ZP)


def district_bounds():
    """Planted outer edges: the district ends at hedges, not walls."""
    sp_hedge(M_DISTRICT, "district_e2", 58.6, 50.0, 59.6, 95.0, ZL)
    sp_hedge(M_DISTRICT, "district_w2", -59.6, 50.0, -58.6, 95.0, ZL)
    sp_hedge(M_DISTRICT, "district_n", -59.6, 94.0, 59.6, 95.0, ZL)


def district_backdrop(M):
    """The city goes on past the district's hedges: a street with a terrace row facing the district on the north,
    east and west sides (seen, not entered), instead of an empty field running to the hills."""
    # north: Lumen Street, shops at street level and flats above, facing the Demo Day Lawn and the orchard/depot
    wbox(M["walk"], -80.0, 95.0, -0.05, 80.0, 97.6, ZP)
    wbox(M["asphalt"], -80.0, 97.6, -0.05, 80.0, 103.4, 0.02)
    wbox(M["walk"], -80.0, 103.4, -0.05, 80.0, 106.0, ZP)
    for x in range(-78, 79, 6):
        wbox(M["paint"], x, 100.42, 0.02, x + 3.0, 100.58, 0.026)
    terrace("bk_n", -80.0, 80.0, 106.0, 11.0, "S", M, (3, 4, 5), style="shop", alley_every=0, balc=0.6)
    for x in range(-74, 75, 12):
        street_tree(M, x, 96.3, 7.0, ZP, 6)
        town_lamp(f"bk_n_lamp{x}", x + 6, 104.4, M, False, ZP)
    for k, x in enumerate((-52.0, -18.0, 24.0, 61.0)):
        prop("ev_sedan", f"bk_n{k}", x, 102.2, math.pi / 2 if k % 2 else -math.pi / 2, 0.02)
    # east and west: Tideway and Orchard Row, flats with gardens behind the district hedges
    for s, nm in ((1, "bk_e"), (-1, "bk_w")):
        x_walk0, x_road0, x_road1, x_walk1 = s * 59.6, s * 62.2, s * 68.0, s * 70.6
        a, b = sorted((x_walk0, x_road0)); wbox(M["walk"], a, -6.0, -0.05, b, 95.0, ZP)
        a, b = sorted((x_road0, x_road1)); wbox(M["asphalt"], a, -6.0, -0.05, b, 97.6, 0.02)
        a, b = sorted((x_road1, x_walk1)); wbox(M["walk"], a, -6.0, -0.05, b, 106.0, ZP)
        for y in range(-4, 95, 6):
            c = s * 65.1
            wbox(M["paint"], c - 0.08, y, 0.02, c + 0.08, y + 3.0, 0.026)
        terrace_y(nm, -6.0, 106.0, x_walk1, 11.0, "W" if s > 0 else "E", M, (3, 4, 5), style="resi", balc=0.7)
        for y in range(0, 95, 12):
            street_tree(M, s * 61.0, y, 7.0, ZP, 6)
            town_lamp(f"{nm}_lamp{y}", s * 69.6, y + 6, M, False, ZP)


def spire_district(M):
    global M_DISTRICT
    M_DISTRICT = M
    demo_day_lawn(M)
    builders_yard(M)
    mango_orchard(M)
    spire_station(M)
    harbor_depot(M)
    district_bounds()
    district_backdrop(M)
