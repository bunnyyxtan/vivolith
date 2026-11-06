"""Builds the NEAR Spire (Protocol Plaza, lobby, NEAR Labs) and exports public/models/spire.glb.

Run inside Blender (MCP for Blender):
    exec(open(r"C:/Bunnyy/Hackathons/NEAR/blender/build_spire.py").read()); build(); export()

Design (original architecture, read from the official symbol assets-src/brand/near-symbol.svg):
  The symbol is two vertical bars joined by a stroke running from the top of the left bar to the foot of
  the right bar at ~58 degrees, plus two small hooks (inner top of the right bar, inner foot of the left
  bar). The Spire turns that into structure, not a logo on a box:
    - West + East towers: 16 x 18 m rounded-plan glass towers, 72 m, fins every 1.5 m, spandrel bands
      every floor, louvred crowns with an LED edge.
    - The diagonal: an inclined sky-atrium (60 deg) spanning the towers, glass with an exposed steel
      diagrid, top and bottom chords lit so the N reads at dusk; you walk beneath it on the plaza.
    - Hooks: an observation wedge cantilevered from the East tower crown, and a garden wedge rising
      from the West tower base.
    - West tower ground floor: double-height glass lobby (reception, NEAR symbol feature wall cut from
      the real SVG path, elevator bank, lounge, info totem) and the NEAR Labs room behind it.
Coordinates: Blender (x, y, z) -> three.js (x, z, -y). Plaza starts behind the Ledger Tower gap (y 30..39).
Conventions shared with build_street.py: COL_* colliders, SIGN_<id> runtime-painted planes.
"""
import bpy, bmesh, math, re, pathlib
from mathutils import Vector, Matrix

exec(open(r"C:/Bunnyy/Hackathons/NEAR/blender/build_street.py").read())  # library: materials, boxes, assets

OUT = REPO / "public" / "models" / "spire.glb"
SYMBOL_SVG = REPO / "assets-src" / "brand" / "near-symbol.svg"
H = 72.0            # glass top of both towers
FLOOR = 4.0         # office floor height above the lobby
LOBBY_H = 7.6       # double-height lobby
WX0, WX1 = -32.0, -16.0   # West tower
EX0, EX1 = 16.0, 32.0     # East tower
TY0, TY1 = 54.0, 72.0     # both towers (front face at y = 54 looks at the plaza)
DY0, DY1 = 57.0, 69.0     # the inclined atrium is recessed 3 m
DOOR = (-25.6, -22.4)     # lobby entrance in the West tower front
LABS_Y = 63.0             # lobby / Labs partition
LABS_DOOR = (-20.5, -18.5)


# ============================================================ geometry ====
def rrect(x0, y0, x1, y1, r, seg=4):
    """Rounded rectangle outline, counter-clockwise, as (x, y) tuples."""
    pts = []
    for cx, cy, a0 in ((x1 - r, y0 + r, -90), (x1 - r, y1 - r, 0), (x0 + r, y1 - r, 90), (x0 + r, y0 + r, 180)):
        for i in range(seg + 1):
            a = math.radians(a0 + 90 * i / seg)
            pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    return pts


def densify(outline, step):
    """Split long straight edges so each curtain-wall panel is at most `step` wide."""
    out = []
    n = len(outline)
    for i in range(n):
        a, b = Vector(outline[i]), Vector(outline[(i + 1) % n])
        k = max(1, math.ceil((b - a).length / step))
        out += [tuple(a.lerp(b, s / k)) for s in range(k)]
    return out


def mesh_obj(name, bm, mat, tile=None):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for m in (mat if isinstance(mat, (list, tuple)) else [mat]):
        me.materials.append(m)
    if tile:
        uv_box(me, tile)
    o = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(o)
    return o


def ring_walls(bm, outline, z0, z1, mat_index=0):
    """Vertical walls (no caps) around an outline."""
    lo = [bm.verts.new((x, y, z0)) for x, y in outline]
    hi = [bm.verts.new((x, y, z1)) for x, y in outline]
    n = len(outline)
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new((lo[i], lo[j], hi[j], hi[i])).material_index = mat_index


def prism(bm, outline, z0, z1, mat_index=0, caps=True):
    ring_walls(bm, outline, z0, z1, mat_index)
    if caps:
        bm.faces.new([bm.verts.new((x, y, z1)) for x, y in outline]).material_index = mat_index
        bm.faces.new([bm.verts.new((x, y, z0)) for x, y in reversed(outline)]).material_index = mat_index


def offset(outline, d):
    """Outline pushed outward by d (convex outlines only)."""
    n = len(outline)
    out = []
    for i in range(n):
        p0, p1, p2 = Vector(outline[i - 1]), Vector(outline[i]), Vector(outline[(i + 1) % n])
        n0 = Vector(((p1 - p0).y, -(p1 - p0).x)).normalized()
        n1 = Vector(((p2 - p1).y, -(p2 - p1).x)).normalized()
        nn = (n0 + n1).normalized()
        out.append(tuple(p1 + nn * d / max(0.5, nn.dot(n0))))
    return out


def beam_xz(bm, p0, p1, t, y0, y1, mat_index=0):
    """Straight member between two points in the x-z plane, thickness t, spanning y0..y1."""
    a, b = Vector((p0[0], p0[1])), Vector((p1[0], p1[1]))
    d = (b - a).normalized()
    nrm = Vector((-d.y, d.x)) * (t / 2)
    poly_xz(bm, [(q.x, q.y) for q in (a - nrm, b - nrm, b + nrm, a + nrm)], y0, y1, mat_index)


def poly_xz(bm, pts, y0, y1, mat_index=0):
    """Extrude a convex polygon given in the x-z plane along y."""
    f0 = [bm.verts.new((x, y0, z)) for x, z in pts]
    f1 = [bm.verts.new((x, y1, z)) for x, z in pts]
    n = len(pts)
    faces = [bm.faces.new((f0[i], f0[(i + 1) % n], f1[(i + 1) % n], f1[i])) for i in range(n)]
    faces += [bm.faces.new(f0), bm.faces.new(list(reversed(f1)))]
    for f in faces:
        f.material_index = mat_index
    bmesh.ops.recalc_face_normals(bm, faces=faces)


def box_bm(bm, x0, y0, z0, x1, y1, z1, mat_index=0):
    prism(bm, [(x0, y0), (x1, y0), (x1, y1), (x0, y1)], z0, z1, mat_index)


# ============================================================ materials ====
def glass_clear():
    m = bpy.data.materials.get("spire_glass_clear")
    if m:
        return m
    m = flat_material("spire_glass_clear", "9fb4c0", 0.03, 0.0)
    b = next(n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    b.inputs["Alpha"].default_value = 0.18
    m.surface_render_method = "BLENDED"
    return m


def mats():
    return {
        "glass": flat_material("spire_glass", "27313d", 0.06, 0.92),
        "glass_lit": flat_material("spire_glass_lit", "4a3826", 0.35, 0.0, emit="ffc48a", emit_strength=1.8),
        "glass_cool": flat_material("spire_glass_cool", "2a3a46", 0.25, 0.0, emit="b9e6ff", emit_strength=0.9),
        "clear": glass_clear(),
        "fin": flat_material("spire_fin", "2b2f34", 0.35, 0.85),
        "band": pbr_material("spire_metal_plate", "metal_plate", "6b7178"),
        "steel": flat_material("spire_steel", "1e2328", 0.3, 0.9),
        "led": flat_material("spire_led", "83dcff", 0.2, emit="83dcff", emit_strength=8.0),
        "led_warm": flat_material("spire_led_warm", "ffd3a0", 0.3, emit="ffd3a0", emit_strength=4.0),
        "beacon": flat_material("spire_beacon", "ff3b2f", 0.3, emit="ff3b2f", emit_strength=12.0),
        "stone": pbr_material("spire_concrete", "brushed_concrete", "d9d4cc"),
        "plaza": pbr_material("spire_granite", "granite_tile"),
        "marble": pbr_material("spire_marble", "marble_01"),
        "terrazzo": pbr_material("spire_terrazzo", "terrazzo_tiles"),
        "dark": flat_material("spire_feature_dark", "16191d", 0.55, 0.1),
        "ceiling": flat_material("spire_ceiling", "e9e6e0", 0.8),
        "panel": flat_material("spire_light_panel", "fff4e4", 0.5, emit="fff4e4", emit_strength=2.0),
        "symbol": flat_material("spire_symbol", "eeeeeb", 0.3, emit="eeeeeb", emit_strength=6.0),
        "water": flat_material("spire_water", "0f2a36", 0.02, 0.6),
        "screen": flat_material("spire_screen", "0b1a2a", 0.3, emit="1f6fb2", emit_strength=1.6),
        "rack": flat_material("spire_rack", "202428", 0.45, 0.7),
    }


# ============================================================== towers ====
def tower(name, x0, x1, M, lobby=False):
    """Glass tower: per-floor curtain wall (some floors lit), fins, spandrels, crown, LED edge."""
    plan = rrect(x0, TY0, x1, TY1, 2.6)
    panels = densify(plan, 3.0)
    bm = bmesh.new()
    ring_walls(bm, plan, 0.0, LOBBY_H, 2 if lobby else 3)  # lobby: clear storefront, east: cool gallery glow
    z, k = LOBBY_H, 0
    seed = random.Random(7 if lobby else 11)
    while z < H - 0.01:
        z1 = min(H, z + FLOOR)
        first = len(bm.faces)
        ring_walls(bm, panels, z, z1, 0)
        bm.faces.ensure_lookup_table()
        run = 0
        for f in list(bm.faces)[first:]:  # occupied offices come in short runs of 2-4 panels
            if run == 0 and seed.random() < 0.09:
                run = seed.randint(2, 4)
            if run:
                f.material_index, run = 1, run - 1
        z, k = z1, k + 1
    bm.faces.new([bm.verts.new((x, y, H)) for x, y in plan]).material_index = 0
    if lobby:  # open the doorway in the storefront
        bmesh.ops.bisect_plane(bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:], plane_co=(DOOR[0], 0, 0), plane_no=(1, 0, 0))
        bmesh.ops.bisect_plane(bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:], plane_co=(DOOR[1], 0, 0), plane_no=(1, 0, 0))
        bm.faces.ensure_lookup_table()
        doomed = [f for f in bm.faces if f.material_index == 2 and abs(f.calc_center_median().y - TY0) < 0.05
                  and DOOR[0] < f.calc_center_median().x < DOOR[1]]
        bmesh.ops.delete(bm, geom=doomed, context="FACES")
    glass = mesh_obj(f"SPIRE_{name}_glass", bm, [M["glass"], M["glass_lit"], M["clear"], M["glass_cool"]])

    # Fins (vertical mullions) every 1.5 m along the perimeter, from the lobby fascia up.
    bm = bmesh.new()
    pts = [Vector(p) for p in plan]
    n = len(pts)
    segs = [(pts[i], pts[(i + 1) % n]) for i in range(n)]
    lengths = [(b - a).length for a, b in segs]
    s, step, total = 0.4, 1.5, sum(lengths)
    while s < total:
        acc, i = 0.0, 0
        while acc + lengths[i] < s:
            acc += lengths[i]
            i += 1
        a, b = segs[i]
        p = a.lerp(b, (s - acc) / max(lengths[i], 1e-6))
        d = (b - a).normalized()
        nrm = Vector((d.y, -d.x))
        quad = [p - d * 0.06, p + d * 0.06, p + d * 0.06 + nrm * 0.42, p - d * 0.06 + nrm * 0.42]
        prism(bm, [(q.x, q.y) for q in quad], LOBBY_H if lobby else 1.0, H + 0.6, 0)
        s += step
    fins = mesh_obj(f"SPIRE_{name}_fins", bm, M["fin"])

    # Spandrel bands each office floor, louvred crown, roof-edge LED band.
    bm = bmesh.new()
    z = LOBBY_H
    while z <= H - 0.01:
        prism(bm, offset(plan, 0.14), z - 0.35, z + 0.25, 0)
        z += FLOOR
    crown = offset(plan, -0.5)
    ring_walls(bm, crown, H, H + 5.0, 1)
    bm.faces.new([bm.verts.new((x, y, H + 5.0)) for x, y in crown]).material_index = 1
    for zz in (H + 1.0, H + 2.0, H + 3.0, H + 4.0):
        prism(bm, offset(crown, 0.18), zz - 0.12, zz + 0.12, 0)
    prism(bm, offset(plan, 0.2), H - 0.1, H + 0.35, 2)
    bands = mesh_obj(f"SPIRE_{name}_bands", bm, [M["band"], M["steel"], M["led"]], tile=2.0)

    bm = bmesh.new()
    if lobby:
        prism(bm, offset(plan, 0.25), LOBBY_H - 0.2, LOBBY_H + 0.6, 0)  # lobby fascia
    else:
        prism(bm, offset(plan, 0.25), 0.0, 1.0, 0)                      # stone base course
    base = mesh_obj(f"SPIRE_{name}_base", bm, M["stone"], tile=2.0)

    collider(f"{name}_upper", x0, TY0, x1, TY1, LOBBY_H, H + 5.0)
    if not lobby:
        collider(f"{name}_ground", x0 - 0.25, TY0 - 0.25, x1 + 0.25, TY1 + 0.25, 0.0, LOBBY_H)
    return [glass, fins, bands, base]


# ============================================================ diagonal ====
def upper_z(x):
    return H - (x - WX1) * (H - 16.0) / (EX0 - WX1)


def lower_z(x):
    return (H - 16.0) - (x - WX1) * (H - 16.0) / (EX0 - WX1)


def atrium(M):
    """Inclined sky-atrium between the towers: glass box with exposed diagrid and lit chords."""
    x0, x1 = WX1 - 0.4, EX0 + 0.4
    bm = bmesh.new()
    poly_xz(bm, [(x0, lower_z(x0)), (x1, lower_z(x1)), (x1, upper_z(x1)), (x0, upper_z(x0))], DY0, DY1, 0)
    for f in bm.faces:
        if abs(f.normal.y) < 0.5:
            f.material_index = 1 if f.normal.z > 0 else 2
    skin = mesh_obj("SPIRE_atrium_skin", bm, [M["glass"], M["band"], M["steel"]], tile=3.0)

    bm = bmesh.new()
    n = 8
    U = lambda u: (WX1 + (EX0 - WX1) * u, upper_z(WX1 + (EX0 - WX1) * u))
    L = lambda u: (WX1 + (EX0 - WX1) * u, lower_z(WX1 + (EX0 - WX1) * u))
    for ya, yb, face in ((DY0 - 0.55, DY0 + 0.05, DY0 - 0.6), (DY1 - 0.05, DY1 + 0.55, DY1 + 0.6)):
        for i in range(n):
            u0, u1 = i / n, (i + 1) / n
            beam_xz(bm, U(u0), L(u1), 0.55, ya, yb, 0)
            beam_xz(bm, L(u0), U(u1), 0.55, ya, yb, 0)
        beam_xz(bm, U(0), U(1), 1.0, ya, yb, 0)
        beam_xz(bm, L(0), L(1), 1.0, ya, yb, 0)
        ly0, ly1 = sorted((face, face + (0.08 if face < DY0 else -0.08)))
        for P, dz in ((U, -0.62), (L, 0.62)):  # LED reveal along each chord
            beam_xz(bm, (P(0)[0], P(0)[1] + dz), (P(1)[0], P(1)[1] + dz), 0.14, ly0, ly1, 1)
    grid = mesh_obj("SPIRE_atrium_diagrid", bm, [M["steel"], M["led"]])

    steps = 8
    for i in range(steps):  # camera-blocking steps under the soffit
        xa = WX1 + (EX0 - WX1) * i / steps
        xb = WX1 + (EX0 - WX1) * (i + 1) / steps
        collider(f"atrium{i}", xa, DY0, xb, DY1, max(0.0, lower_z(xb)), upper_z(xa))
    return [skin, grid]


def hooks(M):
    """The symbol's two hooks: an observation wedge at the East crown, a garden wedge at the West foot."""
    top = [(EX0 + 0.2, 69.5), (EX0 + 0.2, 57.5), (4.5, 47.0)]
    foot = [(WX1 - 0.2, 2.5), (WX1 - 0.2, 14.5), (-4.5, 25.0)]
    bm = bmesh.new()
    poly_xz(bm, top, 58.5, 67.5, 0)
    poly_xz(bm, foot, 58.5, 67.5, 0)
    wedge = mesh_obj("SPIRE_hooks", bm, [M["glass_cool"]], tile=2.0)  # all glass; the steel frame carries the edges
    bm = bmesh.new()
    for tri in (top, foot):
        for ya, yb in ((58.0, 58.6), (67.4, 68.0)):
            for i in range(3):
                beam_xz(bm, tri[i], tri[(i + 1) % 3], 0.5, ya, yb, 0)
        beam_xz(bm, tri[1], tri[2], 0.14, 57.88, 57.98, 1)
    frame = mesh_obj("SPIRE_hooks_frame", bm, [M["steel"], M["led"]])
    collider("hook_foot", WX1 - 0.2, 58.5, WX1 + 1.6, 67.5, 0.0, 5.0)
    return [wedge, frame]


# =============================================================== symbol ====
def symbol_outline(samples=6):
    """Parse the single closed path of the official NEAR symbol SVG into a polygon (SVG units, y down)."""
    d = re.search(r'\sd="([^"]+)"', SYMBOL_SVG.read_text()).group(1)
    toks = re.findall(r"[MmCcLlVvHhZz]|-?(?:\d+\.?\d*|\.\d+)", d)
    pts, cur, cmd, i = [], Vector((0, 0)), None, 0
    while i < len(toks):
        if re.match(r"[A-Za-z]", toks[i]):
            cmd = toks[i]
            i += 1
            if cmd in "Zz":
                continue
        nums = lambda k: [float(toks[i + j]) for j in range(k)]
        rel = cmd.islower()
        if cmd in "Mm":
            x, y = nums(2); i += 2
            cur = Vector((x, y)) + (cur if rel and pts else Vector((0, 0)))
            pts.append(cur.copy())
            cmd = "l" if rel else "L"
        elif cmd in "Ll":
            x, y = nums(2); i += 2
            cur = Vector((x, y)) + (cur if rel else Vector((0, 0)))
            pts.append(cur.copy())
        elif cmd in "Hh":
            (x,) = nums(1); i += 1
            cur = Vector((x + (cur.x if rel else 0), cur.y)); pts.append(cur.copy())
        elif cmd in "Vv":
            (y,) = nums(1); i += 1
            cur = Vector((cur.x, y + (cur.y if rel else 0))); pts.append(cur.copy())
        elif cmd in "Cc":
            v = nums(6); i += 6
            base = cur if rel else Vector((0, 0))
            p0, p1, p2, p3 = cur.copy(), base + Vector(v[0:2]), base + Vector(v[2:4]), base + Vector(v[4:6])
            for s in range(1, samples + 1):
                t = s / samples
                pts.append(p0 * (1 - t) ** 3 + p1 * 3 * t * (1 - t) ** 2 + p2 * 3 * t * t * (1 - t) + p3 * t ** 3)
            cur = p3
        else:
            raise ValueError(f"unsupported SVG command {cmd}")
    out = []
    for p in pts:
        if not out or (p - out[-1]).length > 0.3:
            out.append(p)
    if (out[0] - out[-1]).length < 0.3:
        out.pop()
    return out


def symbol_mesh(name, cx, y, cz, size, depth, mat):
    """Extruded NEAR symbol facing -Y, centred at (cx, y, cz), `size` metres tall."""
    poly = symbol_outline()
    xs, ys = [p.x for p in poly], [p.y for p in poly]
    mx, my = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2
    k = size / (max(ys) - min(ys))
    bm = bmesh.new()
    front = [bm.verts.new((cx + (p.x - mx) * k, y, cz - (p.y - my) * k)) for p in poly]
    back = [bm.verts.new((v.co.x, y + depth, v.co.z)) for v in front]
    caps = [bm.faces.new(front), bm.faces.new(list(reversed(back)))]
    n = len(front)
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new((front[i], back[i], back[j], front[j]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bmesh.ops.triangulate(bm, faces=caps, quad_method="BEAUTY", ngon_method="EAR_CLIP")
    return mesh_obj(name, bm, mat)


# ================================================================ lobby ====
def runtime_plane(name, x0, x1, y, z0, z1, mat, facing=-1):
    """Quad facing -Y (facing=-1) or +Y with 0..1 UVs (left->right as seen by the viewer); the game paints it."""
    bm = bmesh.new()
    xa, xb = (x0, x1) if facing < 0 else (x1, x0)
    vs = [bm.verts.new(v) for v in ((xa, y, z0), (xb, y, z0), (xb, y, z1), (xa, y, z1))]
    f = bm.faces.new(vs)
    uv = bm.loops.layers.uv.verify()
    for l, c in zip(f.loops, ((0, 0), (1, 0), (1, 1), (0, 1))):
        l[uv].uv = c
    return mesh_obj(name, bm, mat)


def lobby(M):
    x0, x1 = WX0 + 0.35, WX1 - 0.35
    y0, y1 = TY0 + 0.35, TY1 - 0.35
    box_mesh("SPIRE_lobby_floor", WX0 + 0.1, TY0 + 0.1, -0.2, WX1 - 0.1, LABS_Y, 0.05, M["marble"], 2.0)
    box_mesh("SPIRE_labs_floor", x0, LABS_Y, -0.2, x1, y1, 0.05, M["terrazzo"], 1.5)
    box_mesh("SPIRE_lobby_ceiling", WX0 + 0.1, TY0 + 0.1, LOBBY_H, WX1 - 0.1, TY1 - 0.1, LOBBY_H + 0.3, M["ceiling"], 2.0)
    bm = bmesh.new()
    for i in range(4):  # lobby: long light strips
        xa = x0 + 1.5 + i * 3.6
        box_bm(bm, xa, y0 + 1.0, LOBBY_H - 0.04, xa + 0.4, LABS_Y - 1.0, LOBBY_H, 0)
    for gx in range(3):  # Labs: panel grid in the 4 m ceiling
        for gy in range(2):
            xa, ya = x0 + 2.0 + gx * 4.5, LABS_Y + 1.6 + gy * 3.6
            box_bm(bm, xa, ya, 3.95, xa + 2.4, ya + 0.6, 4.0, 0)
    mesh_obj("SPIRE_light_panels", bm, M["panel"])
    box_mesh("SPIRE_labs_ceiling", x0, LABS_Y + 0.4, 4.0, x1, y1, 4.15, M["ceiling"], 2.0)

    # Storefront frame: slim mullions every ~2 m, transoms, door frame, parked sliding leaves.
    bm = bmesh.new()
    plan = rrect(WX0, TY0, WX1, TY1, 2.6)
    for (ax, ay), (bx, by) in zip(plan, plan[1:] + plan[:1]):
        L = math.hypot(bx - ax, by - ay)
        k = max(1, int(L / 2.0))
        for s in range(k):
            px, py = ax + (bx - ax) * s / k, ay + (by - ay) * s / k
            if abs(py - TY0) < 0.05 and DOOR[0] - 0.1 < px < DOOR[1] + 0.1:
                continue
            box_bm(bm, px - 0.05, py - 0.05, 0.0, px + 0.05, py + 0.05, LOBBY_H, 0)
    for zz in (0.0, 3.4, LOBBY_H - 0.1):
        for xa, xb in ((WX0 + 2.6, DOOR[0]), (DOOR[1], WX1 - 2.6)):
            box_bm(bm, xa, TY0 - 0.06, zz, xb, TY0 + 0.06, zz + 0.1, 0)
    box_bm(bm, DOOR[0], TY0 - 0.06, 3.4, DOOR[1], TY0 + 0.06, LOBBY_H, 1)  # glass above the door
    box_bm(bm, DOOR[0] - 0.12, TY0 - 0.12, 0.0, DOOR[0], TY0 + 0.12, 3.5, 0)
    box_bm(bm, DOOR[1], TY0 - 0.12, 0.0, DOOR[1] + 0.12, TY0 + 0.12, 3.5, 0)
    box_bm(bm, DOOR[0], TY0 - 0.12, 3.4, DOOR[1], TY0 + 0.12, 3.5, 0)
    for sx in (DOOR[0] - 1.45, DOOR[1] + 0.15):
        box_bm(bm, sx, TY0 + 0.15, 0.05, sx + 1.3, TY0 + 0.2, 3.3, 1)
    mesh_obj("SPIRE_storefront", bm, [M["steel"], M["clear"]])
    box_mesh("SPIRE_canopy", DOOR[0] - 1.6, TY0 - 3.2, 3.9, DOOR[1] + 1.6, TY0, 4.2, M["band"], 2.0)
    box_mesh("SPIRE_canopy_light", DOOR[0] - 1.2, TY0 - 2.9, 3.86, DOOR[1] + 1.2, TY0 - 2.6, 3.9, M["led_warm"], 1.0)
    # Lobby walls (glass storefront) as colliders, leaving the doorway open.
    collider("lobby_front_a", WX0, TY0 - 0.25, DOOR[0], TY0 + 0.25, 0, LOBBY_H)
    collider("lobby_front_b", DOOR[1], TY0 - 0.25, WX1, TY0 + 0.25, 0, LOBBY_H)
    collider("lobby_west", WX0 - 0.25, TY0, WX0 + 0.35, TY1, 0, LOBBY_H)
    collider("lobby_east", WX1 - 0.35, TY0, WX1 + 0.25, TY1, 0, LOBBY_H)
    collider("lobby_back", WX0, TY1 - 0.35, WX1, TY1 + 0.25, 0, LOBBY_H)

    # Feature wall on the partition facing the entrance, with the NEAR symbol cut from the SVG path.
    box_mesh("SPIRE_partition_a", x0, LABS_Y, 0.0, LABS_DOOR[0], LABS_Y + 0.4, LOBBY_H, M["dark"], 2.0)
    box_mesh("SPIRE_partition_b", LABS_DOOR[1], LABS_Y, 0.0, x1, LABS_Y + 0.4, LOBBY_H, M["dark"], 2.0)
    box_mesh("SPIRE_partition_head", LABS_DOOR[0], LABS_Y, 3.0, LABS_DOOR[1], LABS_Y + 0.4, LOBBY_H, M["dark"], 2.0)
    symbol_mesh("SPIRE_symbol_wall", -26.2, LABS_Y - 0.08, 4.1, 3.6, 0.08, M["symbol"])
    box_mesh("SPIRE_labs_sign", LABS_DOOR[0] - 0.05, LABS_Y - 0.06, 3.1, LABS_DOOR[1] + 0.05, LABS_Y, 3.3, M["led"], 1.0)
    collider("partition_a", x0, LABS_Y, LABS_DOOR[0], LABS_Y + 0.4, 0, LOBBY_H)
    collider("partition_b", LABS_DOOR[1], LABS_Y, x1, LABS_Y + 0.4, 0, LOBBY_H)
    collider("partition_head", LABS_DOOR[0], LABS_Y, LABS_DOOR[1], LABS_Y + 0.4, 3.0, LOBBY_H)

    # Reception desk: concrete body, marble top, blue kick light.
    box_mesh("SPIRE_desk_body", -28.6, 59.4, 0.05, -23.8, 60.3, 1.05, M["stone"], 1.0, None, 0.03)
    box_mesh("SPIRE_desk_top", -28.7, 59.3, 1.05, -23.7, 60.4, 1.12, M["marble"], 1.0, None, 0.01)
    box_mesh("SPIRE_desk_kick", -28.5, 59.36, 0.06, -23.9, 59.4, 0.12, M["led"], 1.0)
    collider("desk", -28.7, 59.3, -23.7, 60.4, 0, 1.12)

    # Elevator bank on the west wall: brushed-metal doors, frames, floor indicators.
    bm = bmesh.new()
    for ya in (55.6, 57.9, 60.2):
        box_bm(bm, x0, ya - 0.15, 0.05, x0 + 0.12, ya + 1.55, 2.95, 1)
        box_bm(bm, x0 + 0.12, ya, 0.05, x0 + 0.16, ya + 1.4, 2.8, 0)
        box_bm(bm, x0 + 0.12, ya + 0.5, 3.1, x0 + 0.15, ya + 0.9, 3.3, 2)
    mesh_obj("SPIRE_elevators", bm, [M["band"], M["steel"], M["led"]])
    box_mesh("SPIRE_core_wall", WX0 + 0.1, TY0 + 1.2, 0.0, x0, LABS_Y, LOBBY_H, M["stone"], 2.0)

    # Info totem (runtime painted: SIGN_spire_info) facing the entrance.
    # (left of the entrance, clear of the reception -> Labs corridor)
    box_mesh("SPIRE_totem", -30.0, 56.5, 0.05, -27.6, 56.8, 2.6, M["steel"], 1.0, None, 0.02)
    runtime_plane("SIGN_spire_info", -29.85, -27.75, 56.48, 0.4, 2.45, M["screen"])
    collider("totem", -30.0, 56.5, -27.6, 56.8, 0, 2.6)

    lounge = empty("lounge")
    # Lounge against the east glass, south of the reception -> Labs corridor (x ~ -21.5).
    asset_group("sofa_03", lounge, (-17.6, 57.2, 0.05), math.pi / 2, 1.0, None, 6000)
    asset_group("modern_coffee_table_01", lounge, (-19.3, 57.2, 0.05), 0.0, 1.0, None, 3000)
    asset_group("potted_plant_01", lounge, (-17.3, 55.0, 0.05), 0.0, 1.0, None, 4000)
    asset_group("potted_plant_04", lounge, (-30.6, 62.3, 0.05), 0.0, 1.0, None, 4000)
    asset_group("potted_plant_04", lounge, (-17.3, 62.3, 0.05), 1.3, 1.0, None, 4000)
    join_under(lounge, "SPIRE_lounge")
    collider("sofa", -18.6, 56.0, -16.4, 58.4, 0, 0.9)
    collider("table", -20.0, 56.6, -18.6, 57.8, 0, 0.5)


def labs(M):
    """NEAR Labs: workbenches with monitors, server racks, a live agent-feed wall (SIGN_labs_board)."""
    root = empty("labs_furniture")
    desks = [(-28.2, 66.0, 0.0), (-24.4, 66.0, 0.0), (-28.2, 69.6, math.pi), (-24.4, 69.6, math.pi)]
    DESK_TOP = 0.05 + 0.788  # Poly Haven metal_office_desk top (measured), drawers face local -Y
    for i, (x, y, r) in enumerate(desks):
        s = 1 if r == 0 else -1  # +1: the sitter is on -Y and the monitors stand at the +Y edge
        asset_group("metal_office_desk", root, (x, y, 0.05), r, 1.0, None, 4000)
        asset_group("modern_arm_chair_01", root, (x + 0.35, y - s * 0.85, 0.05), r + math.pi, 1.0, None, 3000)
        if i % 2 == 0:
            asset_group("desk_lamp_arm_01", root, (x + 0.75, y + s * 0.2, DESK_TOP), r, 1.0, None, 2000)
        asset_group("office_notepads", root, (x - 0.6, y - s * 0.1, DESK_TOP), r, 1.0, None, 1500)
    join_under(root, "SPIRE_labs_furniture")
    # Dual monitors per desk (modelled): bezel, emissive screen facing the sitter, neck, foot.
    bm = bmesh.new()
    for x, y, r in desks:
        s = 1 if r == 0 else -1
        yy = y + s * 0.24
        for dx in (-0.31, 0.31):
            cx = x + 0.1 + dx
            box_bm(bm, cx - 0.29, yy - 0.02, DESK_TOP + 0.14, cx + 0.29, yy + 0.02, DESK_TOP + 0.5, 0)
            sy0, sy1 = sorted((yy - s * 0.021, yy - s * 0.026))
            box_bm(bm, cx - 0.27, sy0, DESK_TOP + 0.16, cx + 0.27, sy1, DESK_TOP + 0.48, 1)
            box_bm(bm, cx - 0.025, yy + s * 0.02, DESK_TOP, cx + 0.025, yy + s * 0.06, DESK_TOP + 0.2, 0)
            box_bm(bm, cx - 0.12, yy - 0.06, DESK_TOP, cx + 0.12, yy + 0.1, DESK_TOP + 0.012, 0)
    mesh_obj("SPIRE_monitors", bm, [M["steel"], M["screen"]])
    for x, y, r in desks:
        s = 1 if r == 0 else -1
        collider(f"labdesk_{x}_{y}", x - 1.0, y - 0.48, x + 1.0, y + 0.48, 0, 0.9)
        cy = y - s * 0.85
        collider(f"labchair_{x}_{y}", x + 0.35 - 0.4, cy - 0.4, x + 0.35 + 0.4, cy + 0.4, 0, 0.9)
    racks_x = WX0 + 0.4
    bm = bmesh.new()
    for i in range(4):
        y = 64.4 + i * 0.75
        box_bm(bm, racks_x, y, 0.05, racks_x + 1.0, y + 0.7, 2.15, 0)
        for row in range(10):
            z = 0.35 + row * 0.17
            box_bm(bm, racks_x + 1.0, y + 0.08, z, racks_x + 1.02, y + (0.6 if row % 3 else 0.3), z + 0.03, 1 if row % 4 else 2)
    mesh_obj("SPIRE_racks", bm, [M["rack"], M["led"], M["led_warm"]])
    collider("racks", racks_x - 0.05, 64.3, racks_x + 1.05, 67.5, 0, 2.15)
    # Agent-feed board on the east wall of the Labs, facing west into the room (runtime painted).
    box_mesh("SPIRE_board_frame", WX1 - 0.6, 64.4, 0.9, WX1 - 0.4, 71.0, 3.6, M["steel"], 1.0)
    bm = bmesh.new()
    xb = WX1 - 0.62
    vs = [bm.verts.new(v) for v in ((xb, 64.55, 1.02), (xb, 70.85, 1.02), (xb, 70.85, 3.48), (xb, 64.55, 3.48))]
    f = bm.faces.new(vs)  # faces -X into the room; a viewer looking +X has +Y (north) on the left: u=0 at y=70.85
    uv = bm.loops.layers.uv.verify()
    for l, c in zip(f.loops, ((1, 0), (0, 0), (0, 1), (1, 1))):
        l[uv].uv = c
    bm.normal_update()
    if f.normal.x > 0:
        f.normal_flip()
    mesh_obj("SIGN_labs_board", bm, M["screen"])
    box_mesh("SPIRE_labs_backwall", WX0 + 0.3, TY1 - 0.35, 0.0, WX1 - 0.3, TY1 - 0.2, 4.0, M["stone"], 2.0)
    # Solid west wall behind the racks: the low western sun otherwise floods the room through the glass.
    box_mesh("SPIRE_labs_westwall", WX0 + 0.1, LABS_Y, 0.0, WX0 + 0.35, TY1 - 0.2, 4.0, M["stone"], 2.0)
    box_mesh("SPIRE_labs_above", WX0 + 0.1, LABS_Y, 4.15, WX1 - 0.1, TY1 - 0.1, LOBBY_H, M["dark"], 2.0)


# ================================================================ plaza ====
def plaza(M):
    box_mesh("SPIRE_plaza", -32.0, 39.0, -0.2, 32.0, 84.0, 0.02, M["plaza"], 2.0)
    box_mesh("SPIRE_gap_paving", -15.0, 29.8, -0.2, 15.0, 39.0, 0.02, M["plaza"], 2.0)  # the promenade
    # Planting: deliberately none yet. Poly Haven's scanned jacaranda (312k tris) cannot be decimated to a
    # game budget without breaking (trunk -> stick, leaf cards -> shards); needs an alpha-carded game tree.
    box_mesh("SPIRE_pool_rim", -6.0, 44.0, 0.0, 6.0, 51.0, 0.45, M["stone"], 1.0, None, 0.03)
    box_mesh("SPIRE_pool_water", -5.6, 44.4, 0.0, 5.6, 50.6, 0.4, M["water"], 2.0)
    collider("pool", -6.0, 44.0, 6.0, 51.0, 0, 0.45)
    # Precinct edges; the first closes the yard between the corner block C0 and the promenade's east block.
    walls = [(14.2, 20.3, 15.0, 30.0), (15.4, 39.0, 16.2, 54.0), (-32.8, 39.0, -32.0, 84.0), (-32.0, 83.2, 32.8, 84.0), (32.0, 72.0, 32.8, 84.0)]
    root = empty("hedges")
    for i, (a, b, c, d) in enumerate(walls):
        box_mesh(f"hedge{i}", a, b, 0.0, c, d, 0.9, M["stone"], 1.5, root, 0.02)
        collider(f"bound{i}", a, b, c, d, 0, 6.0)
    for y in (41.5, 45.5, 49.5):
        asset_group("planter_box_02", root, (15.8, y, 0.9), math.pi / 2, 1.0, None, 3000)
    for x in (-28.0, -20.0, -12.0, -4.0, 4.0, 12.0, 20.0, 28.0):
        asset_group("planter_box_02", root, (x, 83.6, 0.9), 0.0, 1.0, None, 3000)
    join_under(root, "SPIRE_hedges")
    root = empty("lamps")
    for x in (-7.5, 7.5):
        for y in (41.0, 47.5):
            asset_group("street_lamp_02", root, (x, y, 0.02), 0.0 if x < 0 else math.pi, 1.0, None, 3000)
            collider(f"lamp{x}_{y}", x - 0.2, y - 0.2, x + 0.2, y + 0.2, 0, 4.0)
    join_under(root, "SPIRE_lamps")
    box_mesh("SPIRE_monolith", -1.0, 40.2, 0.0, 1.0, 40.8, 3.2, M["dark"], 1.0, None, 0.03)
    symbol_mesh("SPIRE_monolith_symbol", 0.0, 40.17, 2.1, 1.2, 0.03, M["symbol"])
    collider("monolith", -1.0, 40.2, 1.0, 40.8, 0, 3.2)
    cylinder("SPIRE_mast", 28.0, 68.0, H + 5.0, H + 13.0, 0.18, M["steel"], None, 8)
    box_mesh("SPIRE_beacon", 27.75, 67.75, H + 13.0, 28.25, 68.25, H + 13.5, M["beacon"], 1.0)


# ================================================================ build ====
def reset():
    sc = bpy.data.scenes.get("NEARSpire")
    if sc:
        for o in list(sc.objects):
            bpy.data.objects.remove(o)
    else:
        sc = bpy.data.scenes.new("NEARSpire")
    # Rebuilds must pick up edited material values (flat_material/pbr_material reuse by name).
    for me in [me for me in bpy.data.meshes if me.users == 0]:  # orphans still reference materials
        bpy.data.meshes.remove(me)
    for m in [m for m in bpy.data.materials if m.name.startswith("spire_") and m.users == 0]:
        bpy.data.materials.remove(m)
    bpy.context.window.scene = sc
    return sc


def build():
    reset()
    M = mats()
    tower("west", WX0, WX1, M, lobby=True)
    tower("east", EX0, EX1, M)
    atrium(M)
    hooks(M)
    lobby(M)
    labs(M)
    plaza(M)
    stats()


HERO_TEXTURES = HERO_TEXTURES + ("granite_tile", "marble_01", "terrazzo_tiles", "brushed_concrete", "metal_plate")


def export():
    OUT.parent.mkdir(parents=True, exist_ok=True)
    for img in bpy.data.images:  # start from the source resolution (other exports may have capped in memory)
        if img.source == "FILE" and img.filepath and img.name.startswith(HERO_TEXTURES):
            img.reload()
    cap_textures()
    with quiet():
        bpy.ops.export_scene.gltf(
            filepath=str(OUT), export_format="GLB", use_active_scene=True,
            export_apply=True, export_image_format="JPEG", export_jpeg_quality=85,  # use "AUTO" once cut-out foliage needs PNG alpha
            export_draco_mesh_compression_enable=True, export_draco_mesh_compression_level=6,
            export_lights=False, export_cameras=False,
        )
    print("exported", OUT.name, round(OUT.stat().st_size / 1e6, 2), "MB")
