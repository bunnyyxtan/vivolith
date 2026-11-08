"""VIVOLITH v2 town south of the Spire promenade. Exports public/models/v2/town.glb and public/models/v2/roads.json.

Run inside Blender:  exec(open(r"C:/Bunnyy/Hackathons/NEAR/blender/build_v2_town.py").read()); build(); export()

One designed town (Blender coords; three = (x, z, -y)). The promenade ends at y = -6; the town is x -76..85, y -6..-100.
  Market Avenue   N-S spine, road x -4..4, from the promenade to the town gate (y -100).
  Market Square   x -22..22, y -24..-54: stalls, fountain, planters; Intents Exchange (landmark empty) on the west,
                  round Community Hall on the east (East Court around it).
  Cafe Street     E-W, y -66..-74, tram tracks, terraces both sides, turning circles at both ends; the AI Lab
                  (landmark empty) closes the east end.
  Linden Park     x -76..-53.5, y -6..-63: pond, paths, bandshell stage, playground, fountain circle (west).
  Plum Lane       residential street y -86..-92 west of the avenue, townhouses with gardens.
  Crate Yard      Foundry Lane east of the avenue: workshops, loading bays, container yard.
  Innovation      east of East Lane (x 52..85, y -6..-55): glass buildings, Lab Green plaza, EV parking.
Roads: West Lane (x -48) and East Lane (x 47) run north from Cafe Street to turning circles.
Geometry is batched per material (few draw calls). Conventions: COL_* colliders, STALL_<id>/NPC_<id>, SPAWN_TOWN,
PROP_<asset>__<id>, SPOT_<kind>__<id>, LANDMARK_<id>. Lanes and parking go to roads.json.
"""
exec(open(r"C:/Bunnyy/Hackathons/NEAR/blender/build_v2_plaza.py").read())  # plaza materials, spire lib, street lib

OUT = REPO / "public" / "models" / "v2" / "town.glb"
ROADS_OUT = REPO / "public" / "models" / "v2" / "roads.json"
BRICK_PNG = REPO / "assets-src" / "generated" / "town_brick.png"
rt = random.Random(77)
BATCH = {}   # material name -> (material, [(verts, faces)])
LANES = []   # filled by the road network builder
PARKING = []
SPOTS = {}


# ------------------------------------------------------------ batching ----
def put(mat, verts, faces):
    BATCH.setdefault(mat.name, (mat, []))[1].append((verts, faces))


_HF = ((0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7))
_HFR = tuple(tuple(reversed(f)) for f in _HF)


def hexa(mat, c, skip=()):
    """c: 8 corners (u0d0z0, u1d0z0, u1d1z0, u0d1z0, then the same at z1). Orientation is fixed automatically."""
    (ax, ay, az), (bx, by, bz), (dx, dy, dz), (ex, ey, ez) = c[0], c[1], c[3], c[4]
    ux, uy, uz, vx, vy, vz, wx, wy, wz = bx - ax, by - ay, bz - az, dx - ax, dy - ay, dz - az, ex - ax, ey - ay, ez - az
    vol = (uy * vz - uz * vy) * wx + (uz * vx - ux * vz) * wy + (ux * vy - uy * vx) * wz
    fs = _HF if vol > 0 else _HFR
    put(mat, c, [f for i, f in enumerate(fs) if i not in skip] if skip else fs)


def wbox(mat, x0, y0, z0, x1, y1, z1):
    x0, x1 = sorted((x0, x1)); y0, y1 = sorted((y0, y1))
    hexa(mat, [(x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0), (x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)])


def tf(x, y, rot):
    c, s = math.cos(rot), math.sin(rot)
    return lambda lx, ly: (x + lx * c - ly * s, y + lx * s + ly * c)


def obox(mat, T, lx0, ly0, z0, lx1, ly1, z1):
    """Box in a rotated local frame T = tf(x, y, rot); local +Y is the object's front."""
    p = [T(lx0, ly0), T(lx1, ly0), T(lx1, ly1), T(lx0, ly1)]
    hexa(mat, [(*q, z0) for q in p] + [(*q, z1) for q in p])


def circle(cx, cy, r, n=12, a0=0.0):
    return [(cx + r * math.cos(a0 + 2 * math.pi * k / n), cy + r * math.sin(a0 + 2 * math.pi * k / n)) for k in range(n)]


def prism(mat, pts, z0, z1, top=None):
    """Convex polygon prism (top = optional polygon with the same point count, for tapers and cones)."""
    n = len(pts)
    area = sum(pts[i][0] * pts[(i + 1) % n][1] - pts[(i + 1) % n][0] * pts[i][1] for i in range(n))
    if area < 0:
        pts = pts[::-1]
        top = top[::-1] if top else None
    top = top or pts
    verts = [(x, y, z0) for x, y in pts] + [(x, y, z1) for x, y in top]
    faces = [tuple(range(n - 1, -1, -1)), tuple(range(n, 2 * n))]
    faces += [(i, (i + 1) % n, n + (i + 1) % n, n + i) for i in range(n)]
    put(mat, verts, faces)


def cyl(mat, x, y, z0, z1, r, n=8, r2=None):
    prism(mat, circle(x, y, r, n), z0, z1, circle(x, y, r2, n) if r2 is not None else None)


def ring(mat, cx, cy, r0, r1, z0, z1, n=24, a0=0.0, a1=2 * math.pi):
    for k in range(n):
        t0, t1 = a0 + (a1 - a0) * k / n, a0 + (a1 - a0) * (k + 1) / n
        c0, s0, c1, s1 = math.cos(t0), math.sin(t0), math.cos(t1), math.sin(t1)
        pts = [(cx + r0 * c0, cy + r0 * s0), (cx + r1 * c0, cy + r1 * s0), (cx + r1 * c1, cy + r1 * s1), (cx + r0 * c1, cy + r0 * s1)]
        hexa(mat, [(*p, z0) for p in pts] + [(*p, z1) for p in pts])


def smooth(pts, iters=2, closed=False):
    for _ in range(iters):
        out = []
        n = len(pts)
        for i in range(n if closed else n - 1):
            a, b = pts[i], pts[(i + 1) % n]
            out += [(a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25), (a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75)]
        pts = out if closed else [pts[0]] + out + [pts[-1]]
    return pts


def path_strip(mat, pts, w, z0, z1):
    """Ribbon along a polyline (mitred), e.g. a park path or a tram rail."""
    n = len(pts)
    left, right = [], []
    for i, p in enumerate(pts):
        segs = []
        if i > 0:
            segs.append((p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]))
        if i < n - 1:
            segs.append((pts[i + 1][0] - p[0], pts[i + 1][1] - p[1]))
        segs = [(sx / math.hypot(sx, sy), sy / math.hypot(sx, sy)) for sx, sy in segs]
        dx, dy = sum(s[0] for s in segs), sum(s[1] for s in segs)
        m = math.hypot(dx, dy) or 1.0
        dx, dy = dx / m, dy / m
        k = 1.0 / max(0.5, dx * segs[0][0] + dy * segs[0][1])
        nx, ny = -dy * w / 2 * k, dx * w / 2 * k
        left.append((p[0] + nx, p[1] + ny))
        right.append((p[0] - nx, p[1] - ny))
    for i in range(n - 1):
        q = [left[i], right[i], right[i + 1], left[i + 1]]
        hexa(mat, [(*a, z0) for a in q] + [(*a, z1) for a in q])


def quad(mat, pts, double=False):
    if double:
        put(mat, list(pts) + list(pts), [(0, 1, 2, 3), (7, 6, 5, 4)])
    else:
        put(mat, list(pts), [(0, 1, 2, 3)])


_ICO = {}


def blob(mat, c, rx, ry, rz, sub=1):
    if sub not in _ICO:
        bm = bmesh.new()
        bmesh.ops.create_icosphere(bm, subdivisions=sub, radius=1.0)
        bm.verts.index_update()
        _ICO[sub] = ([tuple(v.co) for v in bm.verts], [tuple(v.index for v in f.verts) for f in bm.faces])
        bm.free()
    vs, fs = _ICO[sub]
    put(mat, [(c[0] + x * rx, c[1] + y * ry, c[2] + z * rz) for x, y, z in vs], fs)


def wheel(mat, c, r, w, axis="x", n=10):
    """Disc of radius r and width w around centre c; axis = the axle direction (x or y)."""
    cx, cy, cz = c
    a, b = [], []
    for k in range(n):
        t = 2 * math.pi * k / n
        u, v = r * math.cos(t), r * math.sin(t)
        if axis == "x":
            a.append((cx - w / 2, cy + u, cz + v)); b.append((cx + w / 2, cy + u, cz + v))
        else:
            a.append((cx + u, cy - w / 2, cz + v)); b.append((cx + u, cy + w / 2, cz + v))
    sides = [(i, (i + 1) % n, n + (i + 1) % n, n + i) for i in range(n)]
    capa, capb = tuple(range(n)), tuple(range(2 * n - 1, n - 1, -1))
    if axis == "x":
        capa, capb = tuple(range(n - 1, -1, -1)), tuple(range(n, 2 * n))
    else:
        sides = [tuple(reversed(q)) for q in sides]
    faces = [capa, capb] + sides
    put(mat, a + b, faces)


def flush():
    """Turn the batch into one object per material."""
    for name, (mat, items) in BATCH.items():
        bm = bmesh.new()
        for verts, faces in items:
            vs = [bm.verts.new(p) for p in verts]
            for f in faces:
                try:
                    bm.faces.new([vs[i] for i in f])
                except ValueError:
                    pass
        textured = bool(mat.node_tree) and any(n.type == "TEX_IMAGE" for n in mat.node_tree.nodes)
        mesh_obj("TOWN_" + name, bm, mat, 1.0 if textured else None)
    BATCH.clear()


class Front:
    """Local frame on a building's street face: u along the face, d outward (+ = street), z up."""
    def __init__(self, x0, y0, x1, y1, side):
        self.b, self.side = (x0, y0, x1, y1), side
        self.len = (x1 - x0) if side in "NS" else (y1 - y0)
        self.depth = (y1 - y0) if side in "NS" else (x1 - x0)

    def w(self, u, d, z):
        x0, y0, x1, y1 = self.b
        return {"S": (x0 + u, y0 - d, z), "N": (x1 - u, y1 + d, z), "E": (x1 + d, y0 + u, z), "W": (x0 - d, y1 - u, z)}[self.side]

    def xy(self, u, d):
        p = self.w(u, d, 0)
        return p[0], p[1]

    def box(self, mat, u0, u1, d0, d1, z0, z1, dz_out=0.0, full=False):
        """Box in the local frame; dz_out lifts the outer (d1) edge (tilted awnings)."""
        c = [self.w(u, d, z + (dz_out if d == d1 and dz_out else 0)) for z in (z0, z1) for u, d in ((u0, d0), (u1, d0), (u1, d1), (u0, d1))]
        hexa(mat, c, () if full else ((2,) if z0 < 0.3 else (0, 2)))

    def quad(self, mat, pts, double=True):
        quad(mat, [self.w(*p) for p in pts], double)

    def outward(self):
        return {"S": (0, -1), "N": (0, 1), "E": (1, 0), "W": (-1, 0)}[self.side]


def face_rot(dx, dy):
    """Empty rotation_z whose +Y faces the direction (dx, dy)."""
    return math.atan2(-dx, dy)


def spot(kind, ident, x, y, dx, dy):
    n = SPOTS.get(kind, 0)
    SPOTS[kind] = n + 1
    empty(f"SPOT_{kind}__{ident}", (x, y, 0.14), face_rot(dx, dy))


# ----------------------------------------------------------- materials ----
def make_brick_png():
    import numpy as np
    S, rows, cols = 256, 8, 4
    bh, bw = S // rows, S // cols
    img = np.zeros((S, S, 4), np.float32)
    img[...] = (0.66, 0.62, 0.56, 1.0)
    rng = np.random.default_rng(5)
    pal = [(0.93, 0.83, 0.72), (0.90, 0.77, 0.67), (0.95, 0.88, 0.79), (0.87, 0.74, 0.65), (0.92, 0.81, 0.69)]
    for r in range(rows):
        off = bw // 2 if r % 2 else 0
        for c in range(-1, cols + 1):
            x0 = c * bw + off
            col = np.array(pal[int(rng.integers(len(pal)))]) * (1 + rng.uniform(-0.03, 0.03))
            xs, xe = max(0, x0 + 2), min(S, x0 + bw - 2)
            if xe > xs:
                img[r * bh + 2:(r + 1) * bh - 2, xs:xe, :3] = col
    BRICK_PNG.parent.mkdir(parents=True, exist_ok=True)
    im = bpy.data.images.new("town_brick_gen", S, S, alpha=False)
    im.pixels.foreach_set(img.ravel())
    im.filepath_raw = str(BRICK_PNG)
    im.file_format = "PNG"
    im.save()
    bpy.data.images.remove(im)


def town_materials():
    M = v2_materials()
    f = flat_material
    make_brick_png()
    M.update(
        walls=[f("town_cream", "f3ead8", 0.85), f("town_white", "f7f5f0", 0.85), f("town_peach", "f2d3b8", 0.85),
               f("town_mint", "cfe8dc", 0.85), f("town_sand", "e8d9bd", 0.85), f("town_sky", "d7e6ee", 0.85),
               f("town_blush", "f0cfc4", 0.85), f("town_butter", "f3e6b5", 0.85)],
        trim=f("town_trim", "fbfaf6", 0.7), teal=f("town_teal", "2f9a85", 0.6), tealdk=f("town_teal_dark", "1f6f60", 0.6),
        orange=f("town_orange", "f08a3c", 0.6), green=f("town_green_awning", "3f9a4e", 0.7), red=f("town_red", "d9573f", 0.6),
        win=f("town_window", "7ec6d2", 0.08, 0.3), shop=f("town_shopglass", "bfe8e4", 0.05, 0.2), door=f("town_door", "3a2e28", 0.6),
        interior=f("town_interior", "ffe6b4", 0.9, 0.0, "ffdca0", 0.5), shelf=f("town_shelf", "b98a5a", 0.8),
        roof=f("town_roof", "6c7a80", 0.8), roof_sage=f("town_roof_sage", "93ae93", 0.8), roof_clay=f("town_roof_clay", "b47a5e", 0.8), roof_mint=f("town_roof_mint", "a8cfc0", 0.8), roof_cream=f("town_roof_cream", "d9d0bc", 0.8), tile=f("town_roof_tile", "c9694a", 0.8), slate=f("town_roof_slate", "55656e", 0.8),
        brickw=f("town_brickwall", "c98a6e", 0.9), plinth=f("town_plinth", "b9ad98", 0.9),
        asphalt=f("town_asphalt", "4a4e55", 0.9), paint=f("town_paint", "f4f4f0", 0.7), yellowp=f("town_paint_yellow", "f2c230", 0.7),
        walk=M["plaza"], brick=image_material("town_brick", BRICK_PNG), curb=f("town_curb", "cfcac2", 0.8),
        tactile=f("town_tactile", "f2c230", 0.7), rail=f("town_rail", "8c9298", 0.4, 0.7),
        fabric_cream=f("town_fabric_cream", "f6efdd", 0.9), soil=f("town_soil", "5a4232", 0.95),
        petal_w=f("town_petal_white", "fbfbf6", 0.8), petal_p=f("town_petal_pink", "f59ab8", 0.8), petal_y=f("town_petal_yellow", "ffd84a", 0.8),
        petal_l=f("town_petal_lilac", "b79af0", 0.8), petal_c=f("town_petal_coral", "ff7a5c", 0.8), stem=f("town_stem", "3f8f3a", 0.9),
        tuft=f("town_tuft", "5cb049", 0.9),
        apple=f("town_apple", "d8322c", 0.5), orangef=f("town_orange_fruit", "f39a1e", 0.5), banana=f("town_banana", "f5d63c", 0.5),
        mango=f("town_mango", "f6b73c", 0.5), veg=f("town_veg", "5eb442", 0.6), metal=f("town_metal", "b9c0c6", 0.4, 0.6),
        greyd=f("town_grey_dark", "7d878d", 0.6, 0.3), sand=f("town_sandpit", "e8d29a", 0.95), lawn=f("town_lawn", "7fbf5a", 0.95),
        path=f("town_path", "ecdcc4", 0.9), stone=f("town_stone", "d8d2c6", 0.9), wood2=f("town_wood_dark", "7a5233", 0.8),
        hill=f("town_hill", "6fa64e", 0.95), hill2=f("town_hill_far", "8fbf7a", 0.95), cliff=f("town_cliff", "b9a88a", 0.95),
        tyre=f("town_tyre", "23252a", 0.8), car_w=f("town_car_white", "f7f7f4", 0.35), car_m=f("town_car_mint", "9fe3c8", 0.35),
        blue=f("town_blue", "3d7fd1", 0.6), yellow=f("town_yellow", "f2c230", 0.6), pink=f("town_pink", "f2a5b8", 0.7),
        cone=f("town_cone", "ff6a1f", 0.6), glassd=f("town_glass_dark", "2c5560", 0.1, 0.5),
        container1=f("town_container_teal", "2f8f86", 0.6), container2=f("town_container_orange", "e0793a", 0.6),
        container3=f("town_container_cream", "e9dfc8", 0.6), water2=f("town_water_pond", "4fb8d8", 0.05, 0.1), hedge_core=f("town_hedge_core", "2f6b33", 0.95),
    )
    for m in bpy.data.materials:  # viewport colour for headless Workbench inspection
        b = next((n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None) if m.node_tree else None
        if b:
            m.diffuse_color = b.inputs["Base Color"].default_value
    return M


# ----------------------------------------------------------- greenery ----
def solid(mat, verts, faces):
    """Add a convex solid, flipping all faces if the first one points inwards."""
    cx = sum(v[0] for v in verts) / len(verts); cy = sum(v[1] for v in verts) / len(verts); cz = sum(v[2] for v in verts) / len(verts)
    f = faces[0]
    a, b, c = (Vector(verts[i]) for i in f[:3])
    n = (b - a).cross(c - a)
    if n.dot(Vector((cx, cy, cz)) - a) > 0:
        faces = [tuple(reversed(q)) for q in faces]
    put(mat, verts, faces)


def town_tree(x, y, z0, h, seed, cards=12, spin=None, name="tree"):
    """Leaf-card tree: the plaza's procedural_tree (curved limbs, leaf cut-out cards) with fewer cards per tip."""
    rnd = random.Random(seed)
    bm = bmesh.new()
    uvl = bm.loops.layers.uv.verify()

    def tube(p0, p1, r0, r1, sides=6):
        axis = p1 - p0
        L = axis.length
        z = axis.normalized()
        xx = z.orthogonal().normalized()
        yy = z.cross(xx)
        rings = []
        for t, r in ((0.0, r0), (1.0, r1)):
            c = p0 + axis * t
            rings.append([bm.verts.new(c + (xx * math.cos(a) + yy * math.sin(a)) * r) for a in (2 * math.pi * k / sides for k in range(sides))])
        for k in range(sides):
            f = bm.faces.new((rings[0][k], rings[0][(k + 1) % sides], rings[1][(k + 1) % sides], rings[1][k]))
            f.material_index = 0
            for l, uv in zip(f.loops, ((k / sides, 0), ((k + 1) / sides, 0), ((k + 1) / sides, L / 1.5), (k / sides, L / 1.5))):
                l[uvl].uv = uv

    def card(c, size):
        n = Vector((rnd.uniform(-1, 1), rnd.uniform(-1, 1), rnd.uniform(-0.3, 1))).normalized()
        xx = n.orthogonal().normalized()
        yy = n.cross(xx)
        q = [bm.verts.new(c + (xx * sx + yy * sy) * size / 2) for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
        f = bm.faces.new(q)
        f.material_index = 1
        for l, uv in zip(f.loops, ((0, 0), (1, 0), (1, 1), (0, 1))):
            l[uvl].uv = uv

    def branch(p0, direction, length, radius, depth):
        p, d = p0, direction.normalized()
        for i in range(3):
            d = (d + Vector((rnd.uniform(-0.25, 0.25), rnd.uniform(-0.25, 0.25), rnd.uniform(-0.05, 0.2)))).normalized()
            q = p + d * (length / 3)
            tube(p, q, radius * (1 - i / 3 * 0.6), radius * (1 - (i + 1) / 3 * 0.6), 6)
            p = q
        if depth < 1:
            for k in range(rnd.randint(7, 9)):
                az = rnd.uniform(0, 2 * math.pi)
                tilt = rnd.uniform(0.5, 1.0)
                nd = Vector((math.cos(az) * math.sin(tilt), math.sin(az) * math.sin(tilt), math.cos(tilt)))
                start = p0 + (p - p0) * rnd.uniform(0.5, 1.0)
                branch(start, nd * 0.6 + d * 0.4, length * rnd.uniform(0.7, 1.0), radius * 0.45, depth + 1)
        else:
            for k in range(cards):
                card(p + Vector((rnd.gauss(0, 0.7), rnd.gauss(0, 0.7), rnd.gauss(0.2, 0.5))), rnd.uniform(1.5, 2.2))

    branch(Vector((0, 0, 0)), Vector((0.05, 0.03, 1)), h * 0.5, 0.17 * h / 7.0, 0)
    bmesh.ops.rotate(bm, verts=bm.verts, cent=(0, 0, 0), matrix=Matrix.Rotation(spin if spin is not None else rnd.uniform(0, 6.28), 3, "Z"))
    bmesh.ops.translate(bm, verts=bm.verts, vec=(x, y, z0))
    return mesh_obj(f"tree_{name}_{seed}", bm, [TREE_MATS[0], TREE_MATS[1]])


def tree(x, y, z0, h, M, pit=True, col=True, cards=8):
    seed = rt.randint(1, 10 ** 6)
    town_tree(x, y, z0, h * rt.uniform(0.9, 1.1), seed, cards)
    if pit:
        wbox(M["stone"], x - 1.0, y - 1.0, z0 - 0.02, x + 1.0, y + 1.0, z0 + 0.1)
        wbox(M["soil"], x - 0.85, y - 0.85, z0, x + 0.85, y + 0.85, z0 + 0.13)
        for _ in range(4):
            tuft(M, x + rt.uniform(-0.7, 0.7), y + rt.uniform(-0.7, 0.7), z0 + 0.13, 0.2)
    if col:
        collider(f"tree{seed}", x - 0.3, y - 0.3, x + 0.3, y + 0.3, 0, 3.0)


def tuft(M, x, y, z, h=0.25, w=0.14):
    h *= 0.6
    for a in (0.0, math.pi / 2):
        c, s = math.cos(a), math.sin(a)
        quad(M["tuft"], [(x - w * c, y - w * s, z), (x + w * c, y + w * s, z), (x + w * 0.6 * c, y + w * 0.6 * s, z + h), (x - w * 0.6 * c, y - w * 0.6 * s, z + h)], True)


def flower(M, x, y, z, rnd, mat=None, s=1.0):
    mat = mat or M[rnd.choice(("petal_w", "petal_p", "petal_y", "petal_l", "petal_c"))]
    h = rnd.uniform(0.22, 0.4) * s
    for a in (0.0,):
        c, sn = math.cos(a), math.sin(a)
        quad(M["stem"], [(x - 0.03 * c, y - 0.03 * sn, z), (x + 0.03 * c, y + 0.03 * sn, z), (x + 0.02 * c, y + 0.02 * sn, z + h), (x - 0.02 * c, y - 0.02 * sn, z + h)], True)
    r = rnd.uniform(0.09, 0.13) * s
    rot = rnd.uniform(0, 6.28)
    zc = z + h
    for k in range(5):
        a = rot + 2 * math.pi * k / 5
        p1 = (x + 0.5 * r * math.cos(a - 0.55), y + 0.5 * r * math.sin(a - 0.55), zc + 0.02)
        p2 = (x + r * math.cos(a), y + r * math.sin(a), zc - 0.01)
        p3 = (x + 0.5 * r * math.cos(a + 0.55), y + 0.5 * r * math.sin(a + 0.55), zc + 0.02)
        quad(mat, [(x, y, zc + 0.03), p1, p2, p3])
    q = 0.035 * s
    quad(M["petal_y"] if mat is not M["petal_y"] else M["petal_c"], [(x - q, y - q, zc + 0.035), (x + q, y - q, zc + 0.035), (x + q, y + q, zc + 0.035), (x - q, y + q, zc + 0.035)])


def flower_bed(M, x0, y0, x1, y1, z, per_m2=7, palette=None, tufts=True):
    rnd = rt
    n = max(3, int(abs((x1 - x0) * (y1 - y0)) * per_m2))
    pal = palette or ["petal_w", "petal_p", "petal_y", "petal_l", "petal_c"]
    base = rnd.choice(pal)
    for i in range(n):
        fx, fy = rnd.uniform(x0, x1), rnd.uniform(y0, y1)
        flower(M, fx, fy, z, rnd, M[base if rnd.random() < 0.55 else rnd.choice(pal)])
        if tufts and i % 2 == 0:
            tuft(M, rnd.uniform(x0, x1), rnd.uniform(y0, y1), z, 0.28)


def leaf_cards(x, y, z, rx, ry, rz, n, size, seed):
    """Cluster of crossed leaf-cut-out cards (tree leaf material, alpha tested); object joins the trees."""
    rnd = random.Random(seed)
    bm = bmesh.new()
    uvl = bm.loops.layers.uv.verify()
    for _ in range(n):
        c = Vector((x + rnd.gauss(0, rx), y + rnd.gauss(0, ry), z + abs(rnd.gauss(0, rz)) + rz * 0.3))
        nv = Vector((rnd.uniform(-1, 1), rnd.uniform(-1, 1), rnd.uniform(-0.3, 1))).normalized()
        xx = nv.orthogonal().normalized()
        yy = nv.cross(xx)
        sz = size * rnd.uniform(0.8, 1.2)
        f = bm.faces.new([bm.verts.new(c + (xx * sx + yy * sy) * sz / 2) for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1))])
        f.material_index = 1
        for l, uv in zip(f.loops, ((0, 0), (1, 0), (1, 1), (0, 1))):
            l[uvl].uv = uv
    return mesh_obj(f"tree_cards_{seed}", bm, [TREE_MATS[0], TREE_MATS[1]])


def shrub(M, x, y, z, r, light=False):
    cyl(M["soil"], x, y, z, z + r * 0.35, r * 0.25, 6)
    leaf_cards(x, y, z, r * 0.45, r * 0.45, r * 0.5, 12, r * 1.5, rt.randint(1, 10 ** 6))


def leafy_hedge(M, x0, y0, x1, y1, z, h=1.2):
    """Hedge of leaf-card clumps on a dark core (no faceted blobs, no flat slab)."""
    x0, x1 = sorted((x0, x1)); y0, y1 = sorted((y0, y1))
    wbox(M["hedge"], x0 + 0.2, y0 + 0.2, z, x1 - 0.2, y1 - 0.2, z + h * 0.5)
    along_x = (x1 - x0) >= (y1 - y0)
    L = (x1 - x0) if along_x else (y1 - y0)
    n = max(1, int(L / 0.9))
    for i in range(n):
        t = (i + 0.5) / n
        cx, cy = ((x0 + (x1 - x0) * t), (y0 + y1) / 2) if along_x else ((x0 + x1) / 2, y0 + (y1 - y0) * t)
        leaf_cards(cx, cy, z + h * 0.2, 0.22 + 0.15 * ((x1 - x0) if not along_x else (y1 - y0)), 0.22 + 0.15 * ((y1 - y0) if along_x else (x1 - x0)), h * 0.3, 9, 0.9, rt.randint(1, 10 ** 6))


def hedge_b(M, x0, y0, x1, y1, z, h=0.95, inset=0.12):
    leafy_hedge(M, x0, y0, x1, y1, z, max(h, 0.8))


def planter(name, x0, y0, x1, y1, M, flowers=True, z=0.14, col=True, h=0.5):
    """Raised stone planter with bright soil, flower petals and grass tufts (never cubes)."""
    wbox(M["rim"], x0, y0, z - 0.02, x1, y1, z + h)
    wbox(M["soil"], x0 + 0.14, y0 + 0.14, z + h, x1 - 0.14, y1 - 0.14, z + h + 0.05)
    if col:
        collider(name, x0, y0, x1, y1, z - 0.02, z + h)
    if flowers:
        flower_bed(M, x0 + 0.25, y0 + 0.25, x1 - 0.25, y1 - 0.25, z + h + 0.05, 8)


def planter_round(name, x, y, r, M, z=0.14, tree_h=0.0):
    prism(M["rim"], circle(x, y, r, 16), z - 0.02, z + 0.5)
    prism(M["soil"], circle(x, y, r - 0.18, 16), z + 0.5, z + 0.56)
    collider(name, x - r, y - r, x + r, y + r, z - 0.02, z + 0.5)
    flower_bed(M, x - r * 0.6, y - r * 0.6, x + r * 0.6, y + r * 0.6, z + 0.56, 5)


# ------------------------------------------------------ facade details ----
RECESS = 0.35


def ac_unit(F, M, u, z, d=0.0):
    F.box(M["metal"], u, u + 0.75, d, d + 0.38, z, z + 0.5)
    F.box(M["greyd"], u + 0.08, u + 0.67, d + 0.38, d + 0.4, z + 0.08, z + 0.42)
    F.box(M["trim"], u + 0.05, u + 0.12, d - 0.0, d + 0.1, z - 0.12, z)


def pipe(F, M, u, z0, z1):
    F.box(M["metal"], u, u + 0.1, 0.0, 0.1, z0, z1)
    for z in (z0 + 0.6, (z0 + z1) / 2, z1 - 0.6):
        F.box(M["greyd"], u - 0.02, u + 0.12, -0.02, 0.12, z, z + 0.06)


def window(F, M, u0, u1, zb, zt, shutter=None, fbox=False, sill=True):
    T = M["trim"]
    R = RECESS
    F.box(T, u0 - 0.08, u1 + 0.08, -R, -R + 0.14, zb - 0.08, zt + 0.08)        # frame
    F.box(M["win"], u0, u1, -R + 0.14, -R + 0.17, zb, zt)                       # glass
    um = (u0 + u1) / 2
    F.box(T, um - 0.025, um + 0.025, -R + 0.17, -R + 0.21, zb, zt)              # mullion
    F.box(T, u0, u1, -R + 0.17, -R + 0.21, zt - 0.5, zt - 0.45)                 # transom
    if sill:
        F.box(T, u0 - 0.14, u1 + 0.14, -R, 0.14, zb - 0.14, zb - 0.05)
    if shutter is not None:
        for a, b in ((u0 - 0.38, u0 - 0.03), (u1 + 0.03, u1 + 0.38)):
            F.box(shutter, a, b, -R + 0.05, -R + 0.13, zb - 0.02, zt + 0.02)
            for k in range(1, 5):
                F.box(M["trim"], a + 0.03, b - 0.03, -R + 0.13, -R + 0.15, zb + (zt - zb) * k / 5, zb + (zt - zb) * k / 5 + 0.03)
    if fbox:
        F.box(M["wood2"], u0 - 0.1, u1 + 0.1, 0.0, 0.32, zb - 0.45, zb - 0.1)
        rnd = rt
        n = max(2, int((u1 - u0) / 0.22))
        for k in range(n):
            u = u0 + (k + 0.5) * (u1 - u0) / n
            x, y, z = F.w(u, 0.16, zb - 0.1)
            if k % 2:
                flower(M, x, y, z, rnd, None, 0.9)
            else:
                tuft(M, x, y, z, 0.3, 0.1)


def balcony(F, M, u0, u1, z, acc, depth=1.0):
    T = M["trim"]
    F.box(T, u0, u1, -0.1, depth, z - 0.14, z)
    F.box(T, u0, u1, depth - 0.05, depth, z, z + 0.06)          # kick
    n = max(3, int((u1 - u0) / 0.3))
    for k in range(n + 1):
        u = u0 + 0.03 + (u1 - u0 - 0.06) * k / n
        F.box(acc, u - 0.015, u + 0.015, depth - 0.05, depth - 0.02, z + 0.06, z + 1.02)
    F.box(T, u0, u1, depth - 0.07, depth, z + 1.0, z + 1.08)
    F.box(T, u0, u0 + 0.06, -0.1, depth, z + 1.0, z + 1.08)
    F.box(T, u1 - 0.06, u1, -0.1, depth, z + 1.0, z + 1.08)
    if rt.random() < 0.6:
        x, y, zz = F.w((u0 + u1) / 2, depth * 0.6, z)
        shrub(M, x, y, zz, 0.26, True)


def awning(F, M, L, col, z=3.3, proj=1.7, scallop=True):
    stripes = max(3, int(L / 0.7))
    for s in range(stripes):
        m = col if s % 2 == 0 else M["fabric_cream"]
        F.box(m, s * L / stripes, (s + 1) * L / stripes, 0.1, proj, z, z + 0.08, -0.5)
        if scallop:
            u0, u1 = s * L / stripes, (s + 1) * L / stripes
            F.quad(m, [(u0, proj, z - 0.5), (u1, proj, z - 0.5), (u1, proj, z - 0.42), (u0, proj, z - 0.42)], True)
            F.quad(m, [(u0, proj, z - 0.5), (u1, proj, z - 0.5), ((u0 + u1) / 2, proj, z - 0.72), (u0, proj, z - 0.5)], True)


GOODS = ("orange", "red", "teal", "green", "blue", "yellow", "pink", "fabric_cream")


def shop_front(F, M, L, wall, acc, aw, rnd=rt):
    R = RECESS
    T = M["trim"]
    F.box(M["plinth"], 0, L, -R, 0.06, 0, 0.45)
    bays = max(1, int(L // 2.7))
    bw = L / bays
    door = bays // 2 if bays > 1 else 0
    for i in range(bays + 1):
        F.box(wall, max(0, i * bw - 0.22), min(L, i * bw + 0.22), -R, 0.0, 0.45, 3.45)
    for i in range(bays):
        u0, u1 = i * bw + 0.22, (i + 1) * bw - 0.22
        if i == door:
            F.box(T, u0, u1, -R, -R + 0.1, 0.45, 2.65)
            F.box(M["door"], u0 + 0.12, u1 - 0.12, -R + 0.1, -R + 0.16, 0.45, 2.5)
            F.box(M["win"], u0 + 0.3, u1 - 0.3, -R + 0.16, -R + 0.18, 1.0, 2.3)
            F.box(T, u1 - 0.3, u1 - 0.24, -R + 0.16, -R + 0.24, 1.1, 1.5)
            F.box(M["shop"], u0 + 0.1, u1 - 0.1, -R, -R + 0.06, 2.7, 3.4)
            F.box(T, u0, u1, -R, -R + 0.1, 2.65, 2.72)
            lx, ly, lz = F.w((u0 + u1) / 2, 0.1, 2.9)
        else:
            F.box(M["interior"], u0, u1, -R, -R + 0.04, 0.55, 3.35)
            for sz in (1.1, 2.0):
                F.box(M["shelf"], u0 + 0.08, u1 - 0.08, -R + 0.04, -R + 0.32, sz, sz + 0.05)
                for k in range(4):
                    ua = u0 + 0.15 + rnd.uniform(0, 1) * (u1 - u0 - 0.5)
                    hh = rnd.uniform(0.2, 0.45)
                    F.box(M[rnd.choice(GOODS)], ua, ua + 0.22, -R + 0.1, -R + 0.28, sz + 0.05, sz + 0.05 + hh)
            for ua in (u0 - 0.03, u1 - 0.0):
                F.box(T, ua, ua + 0.03, -R + 0.32, -R + 0.38, 0.5, 3.4)
            F.box(T, u0, u1, -R + 0.32, -R + 0.38, 3.35, 3.42)
            F.box(T, u0, u1, -R + 0.32, -R + 0.38, 0.5, 0.57)
            F.box(T, (u0 + u1) / 2 - 0.02, (u0 + u1) / 2 + 0.02, -R + 0.32, -R + 0.38, 0.55, 3.4)
            F.box(T, u0, u1, -R + 0.32, -R + 0.38, 2.5, 2.54)
    F.box(T, 0, L, -R, 0.3, 3.98, 4.12)                                  # cornice over the sign band
    F.box(acc, L * 0.16, L * 0.84, 0.0, 0.14, 3.5, 3.93)                # sign board
    F.box(T, L * 0.16 - 0.04, L * 0.84 + 0.04, 0.0, 0.12, 3.46, 3.5)
    if aw:
        awning(F, M, L, aw)
    ub = L * 0.92
    F.box(M["black"], ub, ub + 0.04, 0.0, 0.95, 3.05, 3.1)
    F.box(acc, ub + 0.005, ub + 0.035, 0.12, 0.92, 2.5, 3.05)
    F.box(M["lampglow"], ub - 0.03, ub + 0.07, 0.4, 0.5, 3.1, 3.3)


def upper_floors(F, M, L, floors, wall, acc, rnd, balcony_on, shutters, fboxes, ac=True):
    T = M["trim"]
    R = RECESS
    n = max(1, int(L // 2.5))
    ww = L / n
    wwin = min(1.55, max(1.0, ww * 0.52))
    for fl in range(1, floors):
        z = 4.0 + 3.2 * (fl - 1)
        F.box(wall, 0, L, -R, 0.0, z + 0.12, z + 0.9)
        F.box(wall, 0, L, -R, 0.0, z + 2.55, z + 3.2)
        F.box(T, 0, L, -R, 0.12, z - 0.02, z + 0.12)                    # floor line
        edges = [0.0]
        wins = []
        for i in range(n):
            u0 = i * ww + (ww - wwin) / 2
            wins.append((u0, u0 + wwin))
            edges += [u0, u0 + wwin]
        edges.append(L)
        for k in range(0, len(edges), 2):
            if edges[k + 1] - edges[k] > 0.02:
                F.box(wall, edges[k], edges[k + 1], -R, 0.0, z + 0.9, z + 2.55)
        for i, (u0, u1) in enumerate(wins):
            sh = rnd.choice([M["teal"], M["tealdk"], M["green"], M["orange"]]) if shutters and (i + fl) % 2 == 0 else None
            fb = fboxes and (i + fl) % 3 == 0
            window(F, M, u0, u1, z + 0.9, z + 2.55, sh, fb)
            if balcony_on and (i + fl) % 2 == 0 and not sh:
                balcony(F, M, u0 - 0.3, u1 + 0.3, z + 0.12, acc if rnd.random() < 0.5 else M["teal"])
            elif ac and rnd.random() < 0.22 and not sh and not fb:
                ac_unit(F, M, u1 + 0.18, z + 0.5)


def solar(F, M, u, d, top, n=2):
    for k in range(n):
        u0 = u + k * 2.1
        lo, hi = top + 0.35, top + 1.0
        p = [F.w(u0, d, lo), F.w(u0 + 1.9, d, lo), F.w(u0 + 1.9, d - 1.1, hi), F.w(u0, d - 1.1, hi)]
        t = [(a, b, c + 0.05) for a, b, c in p]
        hexa(M["glassd"], p + t)
        for uu in (u0 + 0.1, u0 + 1.7):
            q0 = F.w(uu, d, top + 0.12)
            wbox(M["metal"], q0[0] - 0.03, q0[1] - 0.03, top + 0.12, q0[0] + 0.03, q0[1] + 0.03, lo)


def roof_flat(F, M, wall, top, rnd, big=False, rail=False):
    L, depth, R = F.len, F.depth, RECESS
    T = M["trim"]
    x0, y0, x1, y1 = F.b
    wbox(rnd.choice([M["roof"], M["roof_sage"], M["roof_clay"], M["roof_mint"], M["roof_cream"]]), x0 + 0.15, y0 + 0.15, top, x1 - 0.15, y1 - 0.15, top + 0.12)
    F.box(T, 0, L, -R, 0.38, top - 0.3, top)                             # cornice
    F.box(wall, 0, L, -R, 0.0, top, top + 0.7)
    F.box(T, 0, L, -R, 0.14, top + 0.7, top + 0.82)
    F.box(wall, 0, L, -depth, -depth + 0.15, top, top + 0.6)
    F.box(wall, 0, 0.15, -depth, -R, top, top + 0.6)
    F.box(wall, L - 0.15, L, -depth, -R, top, top + 0.6)
    for _ in range(rnd.randint(2, 4)):
        kind = rnd.random()
        if kind > 0.75 and L > 4.5:
            if rnd.random() < 0.5:
                solar(F, M, rnd.uniform(0.6, max(0.7, L - 4.4)), -rnd.uniform(2.6, max(2.7, depth - 1.0)), top, 2)
            else:
                x, y, _z = F.w(rnd.uniform(1.5, max(1.6, L - 2.5)), -depth * 0.55, top)
                hedge_b(M, x - 1.0, y - 0.7, x + 1.0, y + 0.7, top + 0.12, 0.55, 0.1)
                flower_bed(M, x - 0.8, y - 0.5, x + 0.8, y + 0.5, top + 0.67, 6)
            continue
        u, d = rnd.uniform(0.9, max(1.0, L - 1.5)), -rnd.uniform(1.8, max(2.0, depth - 1.5))
        x, y, _z = F.w(u, d, top)
        if kind < 0.35:
            for dx, dy in ((-0.5, -0.5), (0.5, -0.5), (0.5, 0.5), (-0.5, 0.5)):
                wbox(M["metal"], x + dx * 0.9 - 0.04, y + dy * 0.9 - 0.04, top + 0.12, x + dx * 0.9 + 0.04, y + dy * 0.9 + 0.04, top + 1.0)
            cyl(rnd.choice([M["greyd"], M["wood2"], M["tealdk"], M["wood"]]), x, y, top + 1.0, top + 2.3, 0.8, 10)
            cyl(M["roof"], x, y, top + 2.3, top + 2.7, 0.82, 10, 0.1)
        elif kind < 0.6:
            wbox(M["metal"], x - 0.6, y - 0.45, top + 0.12, x + 0.6, y + 0.45, top + 0.95)
            wbox(M["greyd"], x - 0.5, y - 0.46, top + 0.2, x + 0.5, y - 0.4, top + 0.85)
        elif kind < 0.8:
            wbox(M["metal"], x - 0.03, y - 0.03, top + 0.12, x + 0.03, y + 0.03, top + 3.4)
            for hh, w in ((2.2, 0.5), (2.8, 0.38), (3.3, 0.25)):
                wbox(M["metal"], x - w, y - 0.015, top + hh, x + w, y + 0.015, top + hh + 0.03)
        else:
            wbox(wall, x - 0.9, y - 0.8, top + 0.12, x + 0.9, y + 0.8, top + 2.3)
            wbox(M["door"], x - 0.35, y - 0.82, top + 0.12, x + 0.35, y - 0.8, top + 1.9)
            wbox(T, x - 1.0, y - 0.9, top + 2.3, x + 1.0, y + 0.9, top + 2.42)
    if big:
        for k in range(3):
            u = L * (0.2 + 0.3 * k)
            x, y, _z = F.w(u, -depth * 0.5, top)
            hedge_b(M, x - 0.8, y - 0.8, x + 0.8, y + 0.8, top + 0.12, 0.7)


def roof_gable(F, M, top, mat, rnd, chimney=True):
    L, depth = F.len, F.depth
    rh = min(2.4, depth * 0.3)
    ov = 0.5
    A0, A1 = F.w(-0.3, ov, top - 0.12), F.w(L + 0.3, ov, top - 0.12)
    B0, B1 = F.w(-0.3, -depth - 0.4, top - 0.12), F.w(L + 0.3, -depth - 0.4, top - 0.12)
    C0, C1 = F.w(-0.3, -depth / 2, top + rh), F.w(L + 0.3, -depth / 2, top + rh)
    solid(mat, [A0, A1, B0, B1, C0, C1], [(0, 1, 5, 4), (3, 2, 4, 5), (0, 4, 2), (1, 3, 5), (0, 2, 3, 1)])
    ridge = F.w(0, 0, 0)
    for u in (0.0, L):  # barge boards
        pass
    F.box(M["trim"], -0.32, L + 0.32, -depth / 2 - 0.1, -depth / 2 + 0.1, top + rh, top + rh + 0.1)
    if chimney:
        u = rnd.uniform(0.6, max(0.7, L - 1.0))
        F.box(M["brickw"], u, u + 0.6, -depth * 0.6, -depth * 0.6 + 0.6, top, top + rh + 0.9)
        F.box(M["stone"], u - 0.06, u + 0.66, -depth * 0.6 - 0.06, -depth * 0.6 + 0.66, top + rh + 0.9, top + rh + 1.0)
    # dormer
    if L > 5 and rnd.random() < 0.7:
        u = L / 2
        F.box(M["trim"], u - 0.7, u + 0.7, ov - 0.3, ov + 0.05 - 0.05, top + 0.05, top + 1.3)
        F.box(M["win"], u - 0.5, u + 0.5, ov - 0.28, ov - 0.22, top + 0.25, top + 1.1)


def building(name, x0, y0, x1, y1, side, floors, M, wall, style="shop", balcony_on=False, awning_c=None, accent=None,
             col=True, body=True, roof=None, fboxes=None, shutters=None, rnd=None):
    """Terrace building with a modelled facade on `side`. Ground floor 4 m, uppers 3.2 m. style: shop, resi, modern, ind."""
    rnd = rnd or rt
    F = Front(x0, y0, x1, y1, side)
    L, depth = F.len, F.depth
    top = 4.0 + 3.2 * (floors - 1)
    acc = accent or rnd.choice([M["teal"], M["teal"], M["tealdk"], M["orange"], M["green"], M["blue"]])
    T = M["trim"]
    R = RECESS
    if body:
        F.box(wall, 0, L, -depth, -R, 0, top, full=True)
        if col:
            collider(name, x0, y0, x1, y1, 0, top)
    if style == "shop":
        shop_front(F, M, L, wall, acc, awning_c)
        upper_floors(F, M, L, floors, wall, acc, rnd, balcony_on, shutters if shutters is not None else rnd.random() < 0.4, fboxes if fboxes is not None else rnd.random() < 0.5)
        F.box(T, -0.05, 0.28, -R, 0.14, 0, top)
        F.box(T, L - 0.28, L + 0.05, -R, 0.14, 0, top)
        if body and rnd.random() < 0.4:
            pipe(F, M, L - 0.5, 0.45, top)
        if (roof or "flat") == "flat":
            roof_flat(F, M, wall, top, rnd, big=floors >= 3 and rnd.random() < 0.4)
        else:
            roof_gable(F, M, top, M["tile"], rnd)
    elif style == "resi":
        resi_front(F, M, L, floors, wall, acc, rnd, fboxes)
        F.box(T, -0.05, 0.25, -R, 0.1, 0, top)
        F.box(T, L - 0.25, L + 0.05, -R, 0.1, 0, top)
        if body:
            roof_gable(F, M, top, rnd.choice([M["tile"], M["tile"], M["slate"]]), rnd)
    elif style == "modern":
        modern_front(F, M, L, floors, wall, acc, rnd)
        if body:
            roof_flat(F, M, M["trim"], top, rnd, big=True)
    elif style == "ind":
        ind_front(F, M, L, floors, wall, acc, rnd)
        if body:
            roof_saw(F, M, top, rnd)
    return top


def resi_front(F, M, L, floors, wall, acc, rnd, fboxes):
    R = RECESS
    T = M["trim"]
    F.box(M["plinth"], 0, L, -R, 0.06, 0, 0.4)
    n = max(1, int(L // 2.6))
    ww = L / n
    wwin = min(1.4, ww * 0.5)
    door_i = rnd.randrange(n)
    for fl in range(floors):
        z = 0.4 if fl == 0 else 3.4 + 3.0 * (fl - 1)
        zt = 3.4 if fl == 0 else z + 3.0
        if fl:
            F.box(T, 0, L, -R, 0.1, z - 0.05, z + 0.1)
        F.box(wall, 0, L, -R, 0.0, z, zt)
        for i in range(n):
            u0 = i * ww + (ww - wwin) / 2
            u1 = u0 + wwin
            if fl == 0 and i == door_i:
                F.box(T, u0 - 0.1, u1 + 0.1, -R, 0.1, 0.4, 2.7)
                F.box(acc, u0 + 0.05, u1 - 0.05, -R + 0.1, -R + 0.16, 0.4, 2.6)
                F.box(M["win"], u0 + 0.2, u1 - 0.2, -R + 0.16, -R + 0.18, 1.3, 2.4)
                F.box(T, u0 - 0.2, u1 + 0.2, 0.0, 0.8, 0.0, 0.4)                 # stoop
                F.box(M["metal"], u0 - 0.2, u0 - 0.15, 0.0, 0.8, 0.4, 1.2)
                F.box(M["metal"], u1 + 0.15, u1 + 0.2, 0.0, 0.8, 0.4, 1.2)
                F.box(M["lampglow"], u1 + 0.25, u1 + 0.4, 0.0, 0.12, 2.0, 2.3)
            else:
                zb = z + 0.85 if fl == 0 else z + 0.5
                sh = [M["teal"], M["tealdk"], M["green"], M["blue"], M["orange"]][(i + fl) % 5]
                window(F, M, u0, u1, zb + 0.4 if fl == 0 else zb, zb + 2.0 if fl == 0 else zb + 2.05, sh, fboxes is not False and (i + fl) % 2 == 0)


def modern_front(F, M, L, floors, wall, acc, rnd):
    R = RECESS
    T = M["trim"]
    F.box(M["plinth"], 0, L, -R, 0.05, 0, 0.35)
    F.box(M["glassd"], 0.4, L - 0.4, -R, -R + 0.06, 0.35, 3.8)
    for k in range(int(L // 1.6) + 1):
        u = min(L - 0.4, 0.4 + k * 1.6)
        F.box(T, u - 0.05, u + 0.05, -R, 0.2, 0.35, 3.8)
    F.box(T, 0, L, -R, 0.5, 3.8, 4.05)
    door_u = L / 2
    F.box(M["interior"], door_u - 1.0, door_u + 1.0, -R + 0.06, -R + 0.1, 0.35, 3.0)
    F.box(M["led"], 0, L, 0.5, 0.56, 3.95, 4.0)
    for fl in range(1, floors):
        z = 4.0 + 3.2 * (fl - 1)
        F.box(T, 0, L, -R, 0.4, z + 0.05, z + 0.32)
        F.box(M["win"], 0.15, L - 0.15, -R + 0.1, -R + 0.15, z + 0.32, z + 3.2)
        F.box(wall, 0, L, -R, 0.0, z + 0.32, z + 0.8)
        for k in range(int(L // 1.5) + 1):
            u = min(L - 0.15, 0.15 + k * 1.5)
            F.box(T, u - 0.05, u + 0.05, -R, 0.24, z + 0.3, z + 3.2)
        F.box(T, 0, 0.2, -R, 0.3, z, z + 3.2)
        F.box(T, L - 0.2, L, -R, 0.3, z, z + 3.2)
    top = 4.0 + 3.2 * (floors - 1)
    F.box(M["led"], 0, L, 0.4, 0.46, top - 0.05, top + 0.0)


def ind_front(F, M, L, floors, wall, acc, rnd):
    R = RECESS
    T = M["trim"]
    F.box(M["plinth"], 0, L, -R, 0.08, 0, 0.7)
    n = max(1, int(L // 3.6))
    bw = L / n
    for i in range(n + 1):
        F.box(T, max(0, i * bw - 0.18), min(L, i * bw + 0.18), -R, 0.12, 0.7, 4.0)
    for i in range(n):
        u0, u1 = i * bw + 0.2, (i + 1) * bw - 0.2
        if i % 2 == 0:
            F.box(M["greyd"], u0, u1, -R, -R + 0.08, 0.7, 3.4)
            for k in range(1, 9):
                F.box(M["metal"], u0, u1, -R + 0.08, -R + 0.12, 0.7 + k * 0.3, 0.7 + k * 0.3 + 0.04)
            F.box(acc, u0 - 0.05, u1 + 0.05, -R, -R + 0.14, 3.4, 3.55)
        else:
            F.box(M["door"], u0 + 0.5, u1 - 0.5, -R, -R + 0.07, 0.7, 2.6)
            F.box(M["win"], u0 + 0.1, u1 - 0.1, -R + 0.0, -R + 0.05, 2.9, 3.7)
            F.box(T, u0 + 0.5, u1 - 0.5, -R, 0.15, 2.65, 2.75)
        F.box(M["lampglow"], (u0 + u1) / 2 - 0.1, (u0 + u1) / 2 + 0.1, 0.0, 0.2, 3.7, 3.9)
    F.box(acc, 0, L, 0.0, 0.1, 3.9, 4.0)
    for fl in range(1, floors):
        z = 4.0 + 3.2 * (fl - 1)
        F.box(T, 0, L, -R, 0.1, z, z + 0.12)
        for i in range(n):
            u0, u1 = i * bw + 0.5, (i + 1) * bw - 0.5
            window(F, M, u0, u1, z + 1.0, z + 2.5, None, False)


def roof_saw(F, M, top, rnd):
    L, depth = F.len, F.depth
    x0, y0, x1, y1 = F.b
    wbox(M["roof"], x0 + 0.1, y0 + 0.1, top, x1 - 0.1, y1 - 0.1, top + 0.12)
    F.box(M["trim"], 0, L, -RECESS, 0.2, top - 0.2, top + 0.4)
    n = max(2, int(depth // 3.5))
    for k in range(n):
        d1, d0 = -k * depth / n, -(k + 1) * depth / n
        A, B = F.w(-0.0, d1, top + 0.12), F.w(-0.0, d0, top + 0.12)
        A2, B2 = F.w(L, d1, top + 0.12), F.w(L, d0, top + 0.12)
        Ct, Dt = F.w(0, d1, top + 1.3), F.w(L, d1, top + 1.3)
        solid(M["roof"], [A, A2, B, B2, Ct, Dt], [(0, 1, 5, 4), (3, 2, 4, 5)[::-1], (0, 4, 2), (1, 3, 5), (0, 2, 3, 1)])
    for _ in range(2):
        u = rnd.uniform(1, max(1.5, L - 1.5))
        x, y, _z = F.w(u, -rnd.uniform(2, max(3, depth - 2)), top)
        cyl(M["greyd"], x, y, top, top + 3.2, 0.3, 8)
        cyl(M["metal"], x, y, top + 3.2, top + 3.4, 0.4, 8)


# ------------------------------------------------------- street furniture ----
def aabb(x, y, hx, hy, rot):
    c, s = abs(math.cos(rot)), abs(math.sin(rot))
    return hx * c + hy * s, hx * s + hy * c


_COL_N = [0]


def col_rot(x, y, hx, hy, rot, z0, z1, name="c"):
    ex, ey = aabb(x, y, hx, hy, rot)
    _COL_N[0] += 1
    collider(f"{name}{_COL_N[0]}", x - ex, y - ey, x + ex, y + ey, z0, z1)


def town_lamp(name, x, y, M, banner=True, z0=0.14, h=4.6):
    """Black lamp post with gold collar, lantern head and an optional cream NEAR banner (symbol in teal)."""
    cyl(M["black"], x, y, z0, z0 + h, 0.08, 8)
    cyl(M["black"], x, y, z0, z0 + 0.7, 0.16, 8, 0.1)
    cyl(M["gold"], x, y, z0 + 2.4, z0 + 2.55, 0.11, 8)
    wbox(M["black"], x - 0.16, y - 0.16, z0 + h, x + 0.16, y + 0.16, z0 + h + 0.1)
    wbox(M["lampglow"], x - 0.12, y - 0.12, z0 + h + 0.1, x + 0.12, y + 0.12, z0 + h + 0.5)
    prism(M["black"], circle(x, y, 0.2, 4, math.pi / 4), z0 + h + 0.5, z0 + h + 0.62, circle(x, y, 0.06, 4, math.pi / 4))
    if banner:
        wbox(M["black"], x, y - 0.02, z0 + 3.76, x + 0.75, y + 0.02, z0 + 3.81)
        wbox(M["fabric_cream"], x + 0.1, y - 0.015, z0 + 2.56, x + 0.72, y + 0.015, z0 + 3.76)
        sym = symbol_mesh(name + "_sym", x + 0.41, y - 0.03, z0 + 3.16, 0.42, 0.01, M["teal"])
        sym2 = symbol_mesh(name + "_sym2", x + 0.41, y + 0.03, z0 + 3.16, 0.42, -0.01, M["teal"])
        cx = x + 0.41
        sym2.data.transform(Matrix.Translation((cx, 0, 0)) @ Matrix.Scale(-1, 4, (1, 0, 0)) @ Matrix.Translation((-cx, 0, 0)))
        sym2.data.flip_normals()
    collider(name, x - 0.18, y - 0.18, x + 0.18, y + 0.18, z0, z0 + h)


def bollard(name, x, y, M, z0=0.14):
    cyl(M["trim"], x, y, z0, z0 + 0.9, 0.1, 8)
    cyl(M["teal"], x, y, z0 + 0.7, z0 + 0.78, 0.105, 8)
    collider(name, x - 0.12, y - 0.12, x + 0.12, y + 0.12, z0, z0 + 0.9)


def bench_t(ident, x, y, rot, M, z0=0.14, sit=True):
    """Slatted bench; local +Y is where the sitter faces. Registers a SPOT_bench."""
    T = tf(x, y, rot)
    for a, b in ((-0.22, -0.08), (-0.04, 0.1), (0.14, 0.28)):
        obox(M["wood"], T, -0.9, a, z0 + 0.42, 0.9, b, z0 + 0.47)
    for a, b, za in ((-0.26, -0.22, 0.62), (-0.26, -0.22, 0.8)):
        obox(M["wood"], T, -0.9, a, z0 + za, 0.9, b, z0 + za + 0.12)
    for lx in (-0.78, 0.78):
        obox(M["black"], T, lx - 0.04, -0.27, z0, lx + 0.04, -0.2, z0 + 0.95)
        obox(M["black"], T, lx - 0.04, -0.2, z0 + 0.42, lx + 0.04, 0.28, z0 + 0.47)
        obox(M["black"], T, lx - 0.04, 0.2, z0, lx + 0.04, 0.27, z0 + 0.42)
    col_rot(x, y, 1.0, 0.32, rot, z0, z0 + 0.5, "bench")
    if sit:
        spot("bench", ident, *T(0, 0.0), -math.sin(rot), math.cos(rot))


def bin_t(x, y, M, z0=0.14, col=None):
    cyl(col or M["tealdk"], x, y, z0, z0 + 0.85, 0.28, 8, 0.25)
    cyl(M["black"], x, y, z0 + 0.85, z0 + 0.95, 0.3, 8)
    collider(f"bin{x:.1f}_{y:.1f}", x - 0.3, y - 0.3, x + 0.3, y + 0.3, z0, z0 + 0.95)


def vending(x, y, rot, M, col=None, z0=0.14):
    T = tf(x, y, rot)
    col = col or rt.choice([M["red"], M["blue"], M["teal"], M["orange"]])
    obox(col, T, -0.45, -0.35, z0, 0.45, 0.35, z0 + 1.85)
    obox(M["interior"], T, -0.36, 0.35, z0 + 0.6, 0.15, 0.37, z0 + 1.7)
    for k in range(4):
        obox(M[rt.choice(GOODS)], T, -0.3 + k * 0.14, 0.37, z0 + 0.95 + (k % 2) * 0.35, -0.2 + k * 0.14, 0.4, z0 + 1.2 + (k % 2) * 0.35)
    obox(M["dark"], T, 0.2, 0.35, z0 + 0.7, 0.4, 0.38, z0 + 1.6)
    obox(M["trim"], T, -0.45, 0.0, z0 + 1.85, 0.45, 0.4, z0 + 1.92)
    col_rot(x, y, 0.45, 0.4, rot, z0, z0 + 1.9, "vend")


def bike_rack(x, y, rot, M, z0=0.14, n=5):
    T = tf(x, y, rot)
    for k in range(n):
        lx = (k - (n - 1) / 2) * 0.55
        obox(M["rail"], T, lx - 0.025, -0.03, z0, lx + 0.025, 0.03, z0 + 0.75)
        obox(M["rail"], T, lx - 0.025, -0.03, z0 + 0.7, lx + 0.025, 0.4, z0 + 0.76)
        obox(M["rail"], T, lx - 0.025, 0.37, z0, lx + 0.025, 0.43, z0 + 0.76)
    col_rot(x, y, n * 0.28 + 0.1, 0.5, rot, z0, z0 + 0.8, "rack")


def bike(x, y, rot, M, z0=0.14, col_m=None):
    """Mint city bike with real wheels; rot a multiple of 90 degrees."""
    m = col_m or rt.choice([M["car_m"], M["teal"], M["orange"], M["blue"], M["pink"]])
    T = tf(x, y, rot)
    along_y = abs(math.sin(rot)) < 0.5
    for ly in (-0.55, 0.55):
        wx, wy = T(0, ly)
        wheel(M["tyre"], (wx, wy, z0 + 0.33), 0.33, 0.05, "x" if along_y else "y", 10)
        wheel(M["trim"], (wx, wy, z0 + 0.33), 0.2, 0.06, "x" if along_y else "y", 8)
    obox(m, T, -0.02, -0.5, z0 + 0.5, 0.02, 0.5, z0 + 0.56)
    obox(m, T, -0.02, -0.12, z0 + 0.5, 0.02, -0.06, z0 + 0.98)
    obox(m, T, -0.02, 0.44, z0 + 0.35, 0.02, 0.5, z0 + 1.0)
    obox(M["dark"], T, -0.07, -0.25, z0 + 0.98, 0.07, 0.0, z0 + 1.03)
    obox(M["dark"], T, -0.28, 0.46, z0 + 1.0, 0.28, 0.5, z0 + 1.05)
    obox(M["shelf"], T, -0.1, 0.62, z0 + 0.7, 0.1, 0.8, z0 + 0.85)  # basket
    col_rot(x, y, 0.3, 0.9, rot, z0, z0 + 1.1, "bike")


def crate(x, y, rot, M, z0=0.14, n=1, goods=None):
    T = tf(x, y, rot)
    for k in range(n):
        z = z0 + k * 0.4
        obox(M["shelf"], T, -0.4, -0.3, z, 0.4, 0.3, z + 0.38)
        obox(M["wood2"], T, -0.42, -0.32, z + 0.17, 0.42, 0.32, z + 0.21)
        if goods:
            for j in range(5):
                bx, by = T(rt.uniform(-0.3, 0.3), rt.uniform(-0.2, 0.2))
                blob(M[goods], (bx, by, z + 0.4), 0.09, 0.09, 0.08, 1)
    col_rot(x, y, 0.42, 0.32, rot, z0, z0 + 0.4 * n, "crate")


def cone(x, y, M, z0=0.02):
    wbox(M["black"], x - 0.17, y - 0.17, z0, x + 0.17, y + 0.17, z0 + 0.04)
    cyl(M["cone"], x, y, z0 + 0.04, z0 + 0.62, 0.13, 8, 0.04)
    cyl(M["trim"], x, y, z0 + 0.3, z0 + 0.4, 0.09, 8, 0.075)


def barrier(x, y, rot, M, z0=0.02):
    """Striped road barrier: two planks of red/white stripes on A-frame posts with feet."""
    T = tf(x, y, rot)
    for lx in (-0.75, 0.75):
        obox(M["metal"], T, lx - 0.03, -0.03, z0, lx + 0.03, 0.03, z0 + 1.05)
        for ly in (-0.45, 0.45):
            obox(M["metal"], T, lx - 0.035, min(0, ly) - 0.03, z0, lx + 0.035, max(0, ly) + 0.03, z0 + 0.05)
            obox(M["black"], T, lx - 0.04, ly - 0.05, z0, lx + 0.04, ly + 0.05, z0 + 0.03)
    for zz in (0.62, 0.9):
        for j in range(8):
            obox(M["red"] if j % 2 == 0 else M["trim"], T, -0.88 + j * 0.22, -0.04, z0 + zz - 0.12, -0.88 + (j + 1) * 0.22, 0.04, z0 + zz + 0.12)
    cyl(M["yellow"], *T(-0.75, 0.0), z0 + 1.05, z0 + 1.15, 0.06, 6)
    col_rot(x, y, 0.95, 0.5, rot, z0, z0 + 1.1, "barrier")


def cafe_table(ident, x, y, M, umbrella=None, z0=0.14, seats=2, spots=True):
    cyl(M["black"], x, y, z0, z0 + 0.72, 0.03, 6)
    cyl(M["black"], x, y, z0, z0 + 0.04, 0.22, 8)
    cyl(M["trim"], x, y, z0 + 0.72, z0 + 0.77, 0.42, 12)
    for k in range(seats):
        a = k * 2 * math.pi / seats + math.pi / 2 * (ident.__hash__() % 2)
        cx, cy = x + math.cos(a) * 0.72, y + math.sin(a) * 0.72
        cyl(M["black"], cx, cy, z0, z0 + 0.42, 0.025, 6)
        cyl(M["teal"] if k % 2 else M["orange"], cx, cy, z0 + 0.42, z0 + 0.47, 0.2, 8)
        if spots:
            spot("cafe", f"{ident}_{k}", cx, cy, -math.cos(a), -math.sin(a))
    if umbrella:
        cyl(M["black"], x, y, z0, z0 + 2.4, 0.025, 6)
        n = 8
        apex = (x, y, z0 + 2.75)
        pts = [(x + 1.25 * math.cos(2 * math.pi * k / n), y + 1.25 * math.sin(2 * math.pi * k / n), z0 + 2.3) for k in range(n + 1)]
        for k in range(n):
            put(umbrella if k % 2 == 0 else M["fabric_cream"], [apex, pts[k], pts[k + 1], apex, pts[k + 1], pts[k]], [(0, 1, 2), (3, 4, 5)])
    collider(f"cafe{ident}", x - 0.5, y - 0.5, x + 0.5, y + 0.5, z0, z0 + 0.8)


def railing(x0, y0, x1, y1, M, z0=0.14, h=1.0, step=2.0, mat=None, top=True):
    mat = mat or M["black"]
    L = math.hypot(x1 - x0, y1 - y0)
    n = max(1, int(L // step))
    for k in range(n + 1):
        t = k / n
        px, py = x0 + (x1 - x0) * t, y0 + (y1 - y0) * t
        wbox(mat, px - 0.04, py - 0.04, z0, px + 0.04, py + 0.04, z0 + h + 0.05)
    for zz in ((h, 0.55, 0.15) if top else (h * 0.5,)):
        a = (x0, y0); b = (x1, y1)
        path_strip(mat, [a, b], 0.05, z0 + zz - 0.025, z0 + zz + 0.025)


def pole(x, y, M, z0=0.14, h=8.0, arms=2):
    cyl(M["wood2"], x, y, z0, z0 + h, 0.1, 8, 0.07)
    for k in range(arms):
        z = z0 + h - 0.4 - k * 0.7
        wbox(M["wood2"], x - 0.6, y - 0.05, z, x + 0.6, y + 0.05, z + 0.08)
        for dx in (-0.55, 0.55):
            cyl(M["trim"], x + dx, y, z + 0.08, z + 0.2, 0.04, 6)
    wbox(M["greyd"], x + 0.12, y - 0.16, z0 + h - 2.6, x + 0.5, y + 0.16, z0 + h - 1.8)   # transformer
    collider(f"pole{x:.1f}_{y:.1f}", x - 0.15, y - 0.15, x + 0.15, y + 0.15, z0, z0 + h)
    return (x, y, z0 + h)


def wire_span(p, q, M, sag=0.5, n=6, lanes=((-0.55, 0.0), (0.55, 0.0), (-0.55, -0.7), (0.55, -0.7))):
    """Hanging wires between two pole tops (cross-arms run along x)."""
    for dx, dz in lanes:
        a = (p[0] + dx, p[1], p[2] - 0.4 + dz + 0.08)
        b = (q[0] + dx, q[1], q[2] - 0.4 + dz + 0.08)
        for i in range(n):
            t0, t1 = i / n, (i + 1) / n
            za = a[2] + (b[2] - a[2]) * t0 - sag * 4 * t0 * (1 - t0)
            zb = a[2] + (b[2] - a[2]) * t1 - sag * 4 * t1 * (1 - t1)
            pa = (a[0] + (b[0] - a[0]) * t0, a[1] + (b[1] - a[1]) * t0)
            pb = (a[0] + (b[0] - a[0]) * t1, a[1] + (b[1] - a[1]) * t1)
            hexa(M["black"], [(pa[0] - .015, pa[1] - .015, za), (pb[0] - .015, pb[1] - .015, zb), (pb[0] + .015, pb[1] + .015, zb), (pa[0] + .015, pa[1] + .015, za),
                              (pa[0] - .015, pa[1] - .015, za + 0.03), (pb[0] - .015, pb[1] - .015, zb + 0.03), (pb[0] + .015, pb[1] + .015, zb + 0.03), (pa[0] + .015, pa[1] + .015, za + 0.03)])


def string_lights(x0, y0, x1, y1, z, M, n=7, sag=0.5):
    for i in range(n * 2):
        t0, t1 = i / (n * 2), (i + 1) / (n * 2)
        pa = (x0 + (x1 - x0) * t0, y0 + (y1 - y0) * t0, z - sag * 4 * t0 * (1 - t0))
        pb = (x0 + (x1 - x0) * t1, y0 + (y1 - y0) * t1, z - sag * 4 * t1 * (1 - t1))
        hexa(M["black"], [(pa[0] - .012, pa[1] - .012, pa[2]), (pb[0] - .012, pb[1] - .012, pb[2]), (pb[0] + .012, pb[1] + .012, pb[2]), (pa[0] + .012, pa[1] + .012, pa[2]),
                          (pa[0] - .012, pa[1] - .012, pa[2] + .025), (pb[0] - .012, pb[1] - .012, pb[2] + .025), (pb[0] + .012, pb[1] + .012, pb[2] + .025), (pa[0] + .012, pa[1] + .012, pa[2] + .025)])
    for i in range(n):
        t = (i + 0.5) / n
        px, py, pz = x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, z - sag * 4 * t * (1 - t)
        blob(M["lampglow"], (px, py, pz - 0.1), 0.1, 0.1, 0.12, 0)


def shelter(ident, x, y, rot, M, z0=0.14, spots=True):
    """Tram/bus stop shelter, back at local y=-0.6, open to +Y."""
    T = tf(x, y, rot)
    obox(M["trim"], T, -1.9, -0.7, z0 + 2.55, 1.9, 0.9, z0 + 2.68)
    obox(M["teal"], T, -1.9, -0.7, z0 + 2.68, 1.9, 0.9, z0 + 2.74)
    for lx in (-1.75, 1.75):
        obox(M["black"], T, lx - 0.05, -0.65, z0, lx + 0.05, -0.55, z0 + 2.55)
        obox(M["black"], T, lx - 0.05, 0.75, z0, lx + 0.05, 0.85, z0 + 2.55)
    obox(M["glassd"], T, -1.7, -0.62, z0 + 0.4, 1.7, -0.58, z0 + 2.45)
    obox(M["trim"], T, -0.9, -0.55, z0 + 0.45, 0.9, -0.1, z0 + 0.5)
    obox(M["wood"], T, -0.9, -0.55, z0 + 0.5, 0.9, -0.1, z0 + 0.54)
    obox(M["led"], T, -1.7, 0.86, z0 + 2.5, 1.7, 0.9, z0 + 2.55)
    obox(M["interior"], T, 1.0, -0.58, z0 + 1.0, 1.65, -0.54, z0 + 2.2)
    col_rot(x, y, 1.95, 0.9, rot, z0, z0 + 2.7, "shelter")
    if spots:
        for k, lx in enumerate((-1.0, 0.0, 1.0)):
            px, py = T(lx, 1.6)
            spot("wait", f"{ident}_{k}", px, py, -math.sin(rot), math.cos(rot))
        return T


def fountain(name, x, y, r, M, z0=0.14, jets=True):
    prism(M["rim"], circle(x, y, r, 24), z0 - 0.02, z0 + 0.55)
    prism(M["water"], circle(x, y, r - 0.3, 24), z0 + 0.3, z0 + 0.58)
    cyl(M["rim"], x, y, z0 + 0.3, z0 + 1.1, 0.35, 10)
    prism(M["rim"], circle(x, y, r * 0.55, 16), z0 + 0.95, z0 + 1.1)
    cyl(M["rim"], x, y, z0 + 1.1, z0 + 1.8, 0.2, 10, 0.12)
    prism(M["water"], circle(x, y, r * 0.5, 16), z0 + 1.1, z0 + 1.18)
    prism(M["rim"], circle(x, y, 0.55, 12), z0 + 1.75, z0 + 1.85)
    if jets:
        for k in range(8):
            a = 2 * math.pi * k / 8
            px, py = x + math.cos(a) * 0.4, y + math.sin(a) * 0.4
            cyl(M["water"], px, py, z0 + 1.85, z0 + 2.2, 0.035, 5, 0.012)
    collider(name, x - r, y - r, x + r, y + r, z0, z0 + 0.6)


def tactile(M, x0, y0, x1, y1, z=0.14):
    wbox(M["tactile"], x0, y0, z, x1, y1, z + 0.015)


# --------------------------------------------------------------- stalls ----
TRIPO_FRUIT = {"mango", "apple", "orange", "banana", "veg"}


def prop(asset, pid, x, y, rot_z, z=0.0):
    """Runtime placement point for a GLB (public/models/v2/props/<asset>.glb, front = -Y)."""
    empty(f"PROP_{asset}__{pid}", (x, y, z), rot_z)


def leaf_quad(M, x, y, z, ang, ln, w, tilt, mat):
    dx, dy = math.cos(ang), math.sin(ang)
    px, py = -dy * w, dx * w
    mid = (x + dx * ln * 0.5, y + dy * ln * 0.5, z + ln * 0.5 * tilt)
    tip = (x + dx * ln, y + dy * ln, z + ln * tilt * 1.1)
    quad(mat, [(x, y, z), (mid[0] + px, mid[1] + py, mid[2]), tip, (mid[0] - px, mid[1] - py, mid[2])], True)


def plant_pot(M, x, y, z, col, r=0.13, big=1.0):
    cyl(col, x, y, z, z + 0.24 * big, r, 10, r * 0.75)
    cyl(M["trim"], x, y, z + 0.24 * big, z + 0.27 * big, r * 1.05, 10)
    for k in range(9):
        leaf_quad(M, x, y, z + 0.27 * big, 2 * math.pi * k / 9 + rt.uniform(0, 0.4), rt.uniform(0.28, 0.42) * big, 0.07 * big, rt.uniform(0.8, 1.4), M["leaf"] if k % 2 else M["leaf2"])


def teapot(M, x, y, z, col):
    blob(col, (x, y, z + 0.1), 0.11, 0.11, 0.09, 1)
    cyl(M["gold"], x, y, z + 0.18, z + 0.23, 0.045, 8)
    wbox(col, x + 0.09, y - 0.015, z + 0.08, x + 0.2, y + 0.015, z + 0.15)


def stall_proc(x, y, face, canopy, goods, M):
    """Framed market stall: posts with brass caps, striped canopy with drape and scalloped valance, trimmed counter,
    real goods (teapots and cups, gadget boxes with screens, potted plants), hanging lantern."""
    W, D, z0, f = 1.6, 1.0, 0.14, face
    cf = x + f * D
    wood, dk = M["wood"], M["wood2"]
    wbox(wood, x - D, y - W, z0, x + D, y + W, z0 + 0.06)
    wbox(dk, cf - f * 0.5, y - W, z0, cf, y + W, 0.9)
    wbox(M["trim"], cf - f * 0.55, y - W - 0.05, 0.9, cf + f * 0.07, y + W + 0.05, 0.96)
    wbox(M["gold"], cf - f * 0.5, y - W - 0.04, 0.96, cf + f * 0.07, y + W + 0.04, 0.99)
    for k in range(5):
        yy = y - W + 0.25 + k * (2 * W - 0.5) / 4
        wbox(wood, cf - f * 0.02, yy - 0.2, 0.2, cf + f * 0.03, yy + 0.2, 0.8)
    for px in (x - D + 0.06, x + D - 0.06):
        for py in (y - W + 0.06, y + W - 0.06):
            wbox(dk, px - 0.05, py - 0.05, z0, px + 0.05, py + 0.05, 2.45)
            cyl(M["gold"], px, py, 2.45, 2.55, 0.07, 8)
            cyl(M["gold"], px, py, z0, z0 + 0.1, 0.08, 8)
    for yy in (y - W + 0.06, y + W - 0.06):
        wbox(dk, x - D, yy - 0.04, 2.4, x + D, yy + 0.04, 2.48)
    wbox(dk, x - f * (D - 0.06) - 0.04, y - W, 2.4, x - f * (D - 0.06) + 0.04, y + W, 2.48)
    wbox(wood, x - f * (D - 0.03) - 0.03, y - W, z0, x - f * (D - 0.03) + 0.03, y + W, 2.4)
    for zz in (1.15, 1.7):
        wbox(M["shelf"], x - f * (D - 0.06), y - W + 0.1, zz, x - f * (D - 0.5), y + W - 0.1, zz + 0.05)
    n = 6
    xb, xf = x - f * (D + 0.1), x + f * (D + 0.6)
    for sgi in range(n):
        m = canopy if sgi % 2 == 0 else M["fabric_cream"]
        ya, yb = y - W - 0.2 + sgi * (2 * W + 0.4) / n, y - W - 0.2 + (sgi + 1) * (2 * W + 0.4) / n
        hexa(m, [(xb, ya, 2.75), (xf, ya, 2.35), (xf, yb, 2.35), (xb, yb, 2.75), (xb, ya, 2.82), (xf, ya, 2.42), (xf, yb, 2.42), (xb, yb, 2.82)])
        quad(m, [(xf, ya, 2.35), (xf, yb, 2.35), (xf, yb, 2.15), (xf, ya, 2.15)], True)
        quad(m, [(xf, ya, 2.15), (xf, yb, 2.15), (xf, (ya + yb) / 2, 1.93), (xf, ya, 2.15)], True)
    wbox(M["gold"], xf - 0.02, y - W - 0.2, 2.34, xf + 0.02, y + W + 0.2, 2.38)
    for sy in (-1, 1):   # side drapes
        yy = y + sy * (W + 0.2)
        quad(canopy, [(xb, yy, 2.75), (xf, yy, 2.35), (xf, yy, 1.9), (xb, yy, 2.2)], True)
    wbox(M["dark"], x - f * 0.7, y - 0.65, 1.35, x - f * 0.66, y + 0.65, 2.0)
    wbox(M["trim"], x - f * 0.7, y - 0.7, 1.95, x - f * 0.66, y + 0.7, 2.0)
    lx = x + f * 0.75
    wbox(M["black"], lx - 0.01, y - 0.01, 2.0, lx + 0.01, y + 0.01, 2.4)
    cyl(M["black"], lx, y, 2.0, 2.04, 0.1, 8)
    cyl(M["lampglow"], lx, y, 1.82, 2.0, 0.09, 8)
    cyl(M["black"], lx, y, 1.78, 1.82, 0.07, 8)
    rr = random.Random(int(abs(y) * 10))
    for i, g in enumerate(goods):
        gy = y - W + 0.5 + i * (2 * W - 1.0) / max(1, len(goods) - 1)
        gx = cf - f * 0.25
        if g == "tea":
            wbox(M["fabric_cream"], gx - 0.25, gy - 0.35, 0.99, gx + 0.25, gy + 0.35, 1.01)
            teapot(M, gx, gy - 0.1, 1.01, [M["teal"], M["orange"], M["car_m"]][i % 3])
            for k in range(4):
                cyl(M["trim"], gx + rr.uniform(-0.15, 0.15), gy + 0.12 + k * 0.07 - 0.1, 1.01, 1.07, 0.035, 8)
            for k in range(3):
                cyl([M["red"], M["green"], M["yellow"]][k], x - f * (D - 0.3), gy - 0.3 + k * 0.3, 1.2, 1.45, 0.08, 8)
                cyl(M["gold"], x - f * (D - 0.3), gy - 0.3 + k * 0.3, 1.45, 1.49, 0.07, 8)
        elif g == "gadget":
            for k in range(2):
                bx, by, zk = gx + 0.1 - k * 0.12, gy - 0.2 + k * 0.3, k * 0.1
                wbox(M["trim"], bx - 0.14, by - 0.12, 0.99, bx + 0.14, by + 0.12, 1.07 + zk)
                wbox(M["dark"], bx - 0.12, by - 0.2, 1.1 + zk, bx - 0.05, by + 0.2, 1.35 + zk)
                wbox(M["led"], bx - 0.125, by - 0.15, 1.15 + zk, bx - 0.11, by + 0.15, 1.3 + zk)
            for k in range(3):
                wbox([M["orange"], M["teal"], M["pink"]][k], x - f * (D - 0.25), gy - 0.3 + k * 0.3, 1.2, x - f * (D - 0.5), gy - 0.05 + k * 0.3, 1.5)
        elif g == "plant":
            plant_pot(M, gx, gy, 0.99, [M["orange"], M["teal"], M["red"]][i % 3], 0.14, 1.0)
            plant_pot(M, gx + 0.05, gy + 0.3, 0.99, M["car_m"], 0.1, 0.8)
            plant_pot(M, x - f * (D - 0.3), gy, 1.2, M["orange"], 0.12, 1.2)
        else:
            wbox(wood, gx - 0.22, gy - 0.3, 0.99, gx + 0.22, gy + 0.3, 1.1)
            for k in range(8):
                blob(M[{"apple": "apple", "orange": "orangef", "mango": "mango", "veg": "veg", "banana": "banana"}[g]], (gx + rr.uniform(-0.15, 0.15), gy + rr.uniform(-0.22, 0.22), 1.17), 0.055, 0.055, 0.05, 1)


def stall(sid, x, y, face, canopy, goods, M):
    """3.2 m stall; counter top 0.9 m on the customer side. face = +1 opens to +x, -1 to -x.
    Places STALL_<sid> 1.0 m in front of the counter (facing the stall) and NPC_<sid> behind it."""
    W, D = 1.6, 1.0
    cf = x + face * D
    rot = math.pi / 2 if face > 0 else -math.pi / 2
    if all(g in TRIPO_FRUIT for g in goods):
        prop("stall_fruit", sid, x, y, rot)
        collider("stall_" + sid, x - D - 0.05, y - W - 0.05, x + D + 0.05, y + W + 0.05, 0, 2.5)
        empty("STALL_" + sid, (cf + face * 1.0, y, 0.14), rot)
        empty("NPC_" + sid, (x - face * 0.35, y, 0.18), -rot)
        spot("stallq", sid + "_a", cf + face * 2.0, y - 0.7, -face, 0)
        spot("stallq", sid + "_b", cf + face * 2.0, y + 0.8, -face, 0)
        return
    stall_proc(x, y, face, canopy, goods, M)
    collider("stall_" + sid, x - D - 0.05, y - W - 0.05, x + D + 0.05, y + W + 0.05, 0, 2.5)
    empty("STALL_" + sid, (cf + face * 1.0, y, 0.14), rot)
    empty("NPC_" + sid, (x - face * 0.35, y, 0.18), -rot)
    spot("stallq", sid + "_a", cf + face * 2.0, y - 0.7, -face, 0)
    spot("stallq", sid + "_b", cf + face * 2.0, y + 0.8, -face, 0)


def kiosk(name, x, y, M):
    """Coffee kiosk with a counter, stools and a striped awning (open to -y)."""
    wbox(M["walls"][0] if name.startswith("sq_") else M["orange"], x - 1.6, y - 1.2, 0.14, x + 1.6, y + 1.2, 2.8)
    wbox(M["trim"], x - 1.8, y - 1.6, 2.8, x + 1.8, y + 1.4, 3.0)
    wbox(M["tealdk"], x - 1.8, y - 1.6, 3.0, x + 1.8, y + 1.4, 3.1)
    wbox(M["interior"], x - 1.2, y - 1.22, 1.2, x + 1.2, y - 1.2, 2.4)
    wbox(M["trim"], x - 1.25, y - 1.25, 1.15, x + 1.25, y - 1.2, 1.2)
    wbox(M["trim"], x - 1.25, y - 1.25, 2.4, x + 1.25, y - 1.2, 2.45)
    wbox(M["wood"], x - 1.5, y - 1.6, 1.05, x + 1.5, y - 1.2, 1.12)
    for s in range(8):
        m = M["teal"] if s % 2 == 0 else M["fabric_cream"]
        hexa(m, [(x - 1.7 + s * 0.425, y - 1.2, 2.55), (x - 1.7 + (s + 1) * 0.425, y - 1.2, 2.55), (x - 1.7 + (s + 1) * 0.425, y - 2.4, 2.25), (x - 1.7 + s * 0.425, y - 2.4, 2.25),
                 (x - 1.7 + s * 0.425, y - 1.2, 2.62), (x - 1.7 + (s + 1) * 0.425, y - 1.2, 2.62), (x - 1.7 + (s + 1) * 0.425, y - 2.4, 2.32), (x - 1.7 + s * 0.425, y - 2.4, 2.32)])
    for k in (-1, 0, 1):
        cyl(M["black"], x + k, y - 2.1, 0.14, 0.75, 0.03, 6)
        cyl(M["teal"], x + k, y - 2.1, 0.75, 0.82, 0.2, 10)
    for lx in (-1.7, 1.7):
        wbox(M["black"], x + lx - 0.04, y - 2.4, 0.14, x + lx + 0.04, y - 2.32, 2.5)
    collider(name, x - 1.6, y - 1.6, x + 1.6, y + 1.2, 0, 3.0)


def produce_display(x0, x1, y, M):
    """Greengrocer racks on the pavement (front at y, racks towards -y)."""
    x = x0
    while x < x1 - 0.5:
        wbox(M["wood"], x, y - 0.8, 0.14, x + 1.2, y, 0.8)
        wbox(M["wood2"], x, y - 0.8, 0.14, x + 1.2, y - 0.75, 0.9)
        for k in range(6):
            fx = x + 0.15 + k * 0.18
            m = (M["apple"], M["orangef"], M["veg"], M["banana"])[int(x + k) % 4]
            blob(m, (fx, y - 0.4, 0.88), 0.09, 0.1, 0.08, 1)
        x += 1.4
    collider(f"produce_{x0}", x0, y - 0.8, min(x1, x), y, 0, 0.92)


# ------------------------------------------------------------- streets ----
def spans_minus(a, b, gaps):
    out = [(a, b)]
    for g0, g1 in gaps:
        new = []
        for s0, s1 in out:
            if g1 <= s0 or g0 >= s1:
                new.append((s0, s1)); continue
            if g0 > s0:
                new.append((s0, g0))
            if g1 < s1:
                new.append((g1, s1))
        out = new
    return out


def walk_h(M, x0, x1, y0, y1, curb=None, z=0.14, mat="brick"):
    """Raised pavement run along x. curb = 'S' or 'N' puts the kerb stone on that edge (the road side)."""
    if curb == "S":
        wbox(M["curb"], x0, y0, 0, x1, y0 + 0.2, z + 0.01); wbox(M[mat], x0, y0 + 0.2, -0.1, x1, y1, z)
    elif curb == "N":
        wbox(M["curb"], x0, y1 - 0.2, 0, x1, y1, z + 0.01); wbox(M[mat], x0, y0, -0.1, x1, y1 - 0.2, z)
    else:
        wbox(M[mat], x0, y0, -0.1, x1, y1, z)


def walk_v(M, x0, x1, y0, y1, curb=None, z=0.14, mat="brick"):
    if curb == "W":
        wbox(M["curb"], x0, y0, 0, x0 + 0.2, y1, z + 0.01); wbox(M[mat], x0 + 0.2, y0, -0.1, x1, y1, z)
    elif curb == "E":
        wbox(M["curb"], x1 - 0.2, y0, 0, x1, y1, z + 0.01); wbox(M[mat], x0, y0, -0.1, x1 - 0.2, y1, z)
    else:
        wbox(M[mat], x0, y0, -0.1, x1, y1, z)


def h_street(M, yc, x0, x1, half, wd, gaps_n=(), gaps_s=(), skips=()):
    """E-W road: asphalt, both pavements (gaps where side streets join), edge lines and centre dashes."""
    wbox(M["asphalt"], x0, yc - half, -0.1, x1, yc + half, 0.02)
    for a, b in spans_minus(x0, x1, gaps_n):
        walk_h(M, a, b, yc + half, yc + half + wd, "S")
    for a, b in spans_minus(x0, x1, gaps_s):
        walk_h(M, a, b, yc - half - wd, yc - half, "N")
    for a, b in spans_minus(x0, x1, skips):
        for s in (1, -1):
            wbox(M["paint"], a, yc + s * (half - 0.45), 0.02, b, yc + s * (half - 0.37), 0.025)
        x = a + 1
        while x < b - 3:
            wbox(M["paint"], x, yc - 0.06, 0.02, x + 2.0, yc + 0.06, 0.025)
            x += 5


def v_street(M, xc, y0, y1, half, wd, gaps_w=(), gaps_e=(), skips=()):
    wbox(M["asphalt"], xc - half, y0, -0.1, xc + half, y1, 0.02)
    for a, b in spans_minus(y0, y1, gaps_w):
        walk_v(M, xc - half - wd, xc - half, a, b, "E")
    for a, b in spans_minus(y0, y1, gaps_e):
        walk_v(M, xc + half, xc + half + wd, a, b, "W")
    for a, b in spans_minus(y0, y1, skips):
        for s in (1, -1):
            wbox(M["paint"], xc + s * (half - 0.45), a, 0.02, xc + s * (half - 0.37), b, 0.025)
        y = a + 1
        while y < b - 3:
            wbox(M["paint"], xc - 0.06, y, 0.02, xc + 0.06, y + 2.0, 0.025)
            y += 5


def zebra(M, c, d, s0, s1, halfw):
    """Zebra crossing across the arm leaving junction centre c in direction d (stripes run with the traffic)."""
    (cx, cy), (dx, dy) = c, d
    nx, ny = -dy, dx
    k = -halfw
    while k < halfw - 0.05:
        a = (cx + dx * s0 + nx * k, cy + dy * s0 + ny * k)
        b = (cx + dx * s1 + nx * (k + 0.5), cy + dy * s1 + ny * (k + 0.5))
        wbox(M["paint"], a[0], a[1], 0.02, b[0], b[1], 0.03)
        k += 1.0


def stopline(M, c, d, s, lane_off, w=3.0):
    (cx, cy), (dx, dy) = c, d
    nx, ny = -dy, dx
    a = (cx + dx * s + nx * (lane_off - w / 2), cy + dy * s + ny * (lane_off - w / 2))
    b = (cx + dx * (s + 0.4) + nx * (lane_off + w / 2), cy + dy * (s + 0.4) + ny * (lane_off + w / 2))
    wbox(M["paint"], a[0], a[1], 0.02, b[0], b[1], 0.03)


def bulb(M, cx, cy, r, ri, arm, arm_half, walk_r, name):
    """Turning circle: asphalt disc, kerb ring + brick apron (open where the street joins), planted island."""
    prism(M["asphalt"], circle(cx, cy, r, 36), -0.1, 0.02)
    a_arm = math.atan2(arm[1], arm[0])
    gap = 0.62
    n = 36
    for k in range(n):
        t0, t1 = 2 * math.pi * k / n, 2 * math.pi * (k + 1) / n
        mid = (t0 + t1) / 2
        d = abs((mid - a_arm + math.pi) % (2 * math.pi) - math.pi)
        if d < gap:
            continue
        ring(M["curb"], cx, cy, r, r + 0.2, 0, 0.15, 1, t0, t1)
        ring(M["brick"], cx, cy, r + 0.2, walk_r, -0.1, 0.14, 1, t0, t1)
    prism(M["curb"], circle(cx, cy, ri + 0.25, 24), 0, 0.2)
    prism(M["lawn"], circle(cx, cy, ri, 24), 0.2, 0.26)
    for k in range(6):
        a = 2 * math.pi * k / 6
        shrub(M, cx + math.cos(a) * (ri - 0.7), cy + math.sin(a) * (ri - 0.7), 0.26, 0.45, k % 2 == 0)
    flower_bed(M, cx - ri * 0.55, cy - ri * 0.55, cx + ri * 0.55, cy + ri * 0.55, 0.26, 8)
    collider(name, cx - ri - 0.25, cy - ri - 0.25, cx + ri + 0.25, cy + ri + 0.25, 0, 0.3)


def tram_tracks(M, y, x0, x1):
    wbox(M["greyd"], x0, y - 1.15, 0.02, x1, y + 1.15, 0.03)
    for yy in (y - 0.72, y + 0.72):
        wbox(M["rail"], x0, yy - 0.05, 0.03, x1, yy + 0.05, 0.08)
    x = x0 + 0.3
    while x < x1:
        wbox(M["asphalt"], x, y - 1.05, 0.03, x + 0.14, y + 1.05, 0.045)
        x += 0.9
    for xe, s in ((x0, 1), (x1, -1)):   # buffer stops
        wbox(M["red"], xe - 0.1 * s, y - 1.0, 0.03, xe + 0.2 * s, y + 1.0, 0.5)


# -------------------------------------------------------- lane network ----
LW = 1.6
LANE_STEP = 9.0


def _unit(v):
    m = math.hypot(*v)
    return (v[0] / m, v[1] / m)


def _arm_point(c, d, s, which):
    t = (-d[0], -d[1]) if which == "in" else d
    rx, ry = t[1], -t[0]
    return (c[0] + d[0] * s + rx * LW, c[1] + d[1] * s + ry * LW)


def _line(p, q):
    n = max(1, int(math.hypot(q[0] - p[0], q[1] - p[1]) / LANE_STEP))
    return [(p[0] + (q[0] - p[0]) * i / n, p[1] + (q[1] - p[1]) * i / n) for i in range(n + 1)]


def _lane(lid, pts, speed, nxt=None):
    LANES.append({"id": lid, "points": [[round(x, 2), round(-y, 2)] for x, y in pts], "next": nxt if nxt is not None else [], "speed": speed})
    return LANES[-1]


def build_lanes():
    """Right-hand traffic lanes (Blender coords in, three coords out): straights between nodes, turn connectors at
    junctions, full ring lanes around turning circles so every lane has a successor."""
    nodes = {}

    def node(nid, c, kind, rr=0.0, R=5.0):
        nodes[nid] = {"c": c, "kind": kind, "rr": rr, "R": R, "arms": {}}

    node("cw", (-58, -70), "bulb", 4.8); node("jb", (-48, -70), "junc"); node("ja", (0, -70), "junc"); node("jc", (47, -70), "junc")
    node("ce", (58, -70), "bulb", 4.8)
    node("wl_n", (-48, -14), "bulb", 3.8); node("el_n", (47, -14), "bulb", 3.8)
    node("jd", (0, -89), "junc", R=4.6); node("gate", (0, -97), "bulb", 2.6)
    node("pw", (-70, -89), "bulb", 3.8); node("fe", (56, -89), "bulb", 3.8)

    def arm_s(n):
        return math.sqrt(n["rr"] ** 2 - LW ** 2) if n["kind"] == "bulb" else n["R"]

    roads = [("cafe", ["cw", "jb", "ja", "jc", "ce"]), ("wl", ["jb", "wl_n"]), ("el", ["jc", "el_n"]),
             ("avs", ["ja", "jd", "gate"]), ("plum", ["pw", "jd"]), ("fnd", ["jd", "fe"])]
    for road, ids in roads:
        for i in range(len(ids) - 1):
            A, B = nodes[ids[i]], nodes[ids[i + 1]]
            d = _unit((B["c"][0] - A["c"][0], B["c"][1] - A["c"][1]))
            nd = (-d[0], -d[1])
            f, b = f"{road}_f{i}", f"{road}_b{i}"
            _lane(f, _line(_arm_point(A["c"], d, arm_s(A), "out"), _arm_point(B["c"], nd, arm_s(B), "in")), 8.0)
            _lane(b, _line(_arm_point(B["c"], nd, arm_s(B), "out"), _arm_point(A["c"], d, arm_s(A), "in")), 8.0)
            A["arms"][d] = {"out": f, "in": b}
            B["arms"][nd] = {"out": b, "in": f}
    by_id = lambda lid: next(l for l in LANES if l["id"] == lid)
    for nid, n in nodes.items():
        c = n["c"]
        if n["kind"] == "bulb":
            (d, arm), = n["arms"].items()
            s = arm_s(n)
            pin, pout = _arm_point(c, d, s, "in"), _arm_point(c, d, s, "out")
            a0 = math.atan2(pin[1] - c[1], pin[0] - c[0])
            a1 = math.atan2(pout[1] - c[1], pout[0] - c[0])
            if a1 <= a0:
                a1 += 2 * math.pi
            k = max(8, int((a1 - a0) / math.radians(15)))
            pts = [(c[0] + n["rr"] * math.cos(a0 + (a1 - a0) * i / k), c[1] + n["rr"] * math.sin(a0 + (a1 - a0) * i / k)) for i in range(k + 1)]
            rid = f"ring_{nid}"
            _lane(rid, pts, 4.0, [arm["out"]])
            by_id(arm["in"])["next"].append(rid)
            continue
        for da, aa in n["arms"].items():
            for db, ab in n["arms"].items():
                if da == db:
                    continue
                s = n["R"]
                p, q = _arm_point(c, da, s, "in"), _arm_point(c, db, s, "out")
                tin, tout = (-da[0], -da[1]), db
                cr = tin[0] * tout[1] - tin[1] * tout[0]
                if abs(cr) < 1e-6:
                    pts = [p, q]
                else:
                    lam = ((q[0] - p[0]) * tout[1] - (q[1] - p[1]) * tout[0]) / cr
                    ctl = (p[0] + tin[0] * lam, p[1] + tin[1] * lam)
                    pts = [((1 - t) ** 2 * p[0] + 2 * t * (1 - t) * ctl[0] + t * t * q[0], (1 - t) ** 2 * p[1] + 2 * t * (1 - t) * ctl[1] + t * t * q[1]) for t in [i / 6 for i in range(7)]]
                cid = f"turn_{nid}_{aa['in']}_{ab['out']}"
                _lane(cid, pts, 5.0, [ab["out"]])
                by_id(aa["in"])["next"].append(cid)
    return nodes, arm_s


def junction_marks(M, nodes, arm_s, half_of):
    """Zebra crossings and stop lines on every junction arm."""
    for nid, n in nodes.items():
        if n["kind"] != "junc":
            continue
        for d in n["arms"]:
            hw = half_of[(nid, d)]
            zebra(M, n["c"], d, n["R"], n["R"] + 2.6, hw - 0.6)
            stopline(M, n["c"], d, n["R"] + 2.9, LW, 3.0)


def write_roads():
    import json
    data = {"note": "Blender (x, y) -> three (x, -y). yaw = three rotation.y for a model facing -Z; (dx, dz) = world facing.",
            "laneWidth": 3.2, "lanes": LANES, "parking": PARKING}
    ROADS_OUT.parent.mkdir(parents=True, exist_ok=True)
    ROADS_OUT.write_text(json.dumps(data, separators=(",", ":")))
    print("roads.json", len(LANES), "lanes", len(PARKING), "parking")


def parked(asset, pid, x, y, fx, fy, record=True):
    """Parked EV: prop empty + collider + parking record. Car front = Blender -Y at rot 0; (fx, fy) = facing."""
    rot = math.atan2(fx, -fy)
    L, W = {"ev_sedan": (2.3, 1.05), "ev_pickup": (2.85, 1.2), "car_hatch": (2.0, 0.95), "car_van": (2.6, 1.1), "car_taxi": (2.3, 1.0)}.get(asset, (2.3, 1.05))
    prop(asset, pid, x, y, rot)
    col_rot(x, y, W, L, rot, 0, 1.8, "car")
    if record:
        PARKING.append({"x": round(x, 2), "z": round(-y, 2), "yaw": round(math.atan2(-fx, fy), 3), "dx": round(fx, 3), "dz": round(-fy, 3)})


# ---------------------------------------------------------------- rows ----
OPP = {"N": "S", "S": "N", "E": "W", "W": "E"}


def _door_spot(name, F, L):
    bays = max(1, int(L // 2.7))
    door = bays // 2 if bays > 1 else 0
    ud = (door + 0.5) * L / bays
    x, y = F.xy(ud, 1.1)
    ox, oy = F.outward()
    spot("shopdoor", name, x, y, -ox, -oy)


def row_building(name, x0, y0, x1, y1, side, floors, M, style, awn, rear, corners, rnd, balc):
    wall = rnd.choice(M["walls"])
    acc = rnd.choice([M["teal"], M["teal"], M["tealdk"], M["orange"], M["green"], M["blue"]])
    aw = rnd.choice(awn) if (awn and style == "shop") else None
    building(name, x0, y0, x1, y1, side, floors, M, wall, style, balcony_on=balc, awning_c=aw, accent=acc, rnd=rnd)
    F = Front(x0, y0, x1, y1, side)
    if style == "shop":
        _door_spot(name, F, F.len)
    if rear:
        building(name + "r", x0, y0, x1, y1, OPP[side], floors, M, wall, rear, balcony_on=False, accent=acc, col=False, body=False, rnd=rnd,
                 awning_c=rnd.choice(awn) if (awn and rear == "shop") else None)
    for cs in corners:
        building(name + "c" + cs, x0, y0, x1, y1, cs, floors, M, wall, "shop", accent=acc, col=False, body=False, rnd=rnd)


def terrace(prefix, x0, x1, yfront, depth, side, M, floors=(2, 3), style="shop", alley_every=3, awn=True, gaps=(), rear=None,
            first=None, last=None, balc=0.4, widths=(6.0, 7.5, 9.0)):
    """Row of buildings along x with the front on y = yfront (side N: building south of yfront, side S: north of it)."""
    rnd = random.Random(sum(map(ord, prefix)) * 131 + 7)
    awn_l = [M["teal"], M["teal"], M["orange"], M["green"], M["red"]] if awn else None
    y_in = yfront - depth if side == "N" else yfront + depth
    ya, yb = sorted((yfront, y_in))
    x, k = x0, 0
    while x < x1 - 3.5:
        for g0, g1 in gaps:
            if g0 <= x < g1:
                x = g1
        if x >= x1 - 3.5:
            break
        nxt = min([g0 for g0, g1 in gaps if g0 > x] + [x1])
        w = min(rnd.choice(widths), nxt - x)
        if nxt - (x + w) < 3.5:
            w = nxt - x
        cs = tuple(c for c, cond in ((first, x <= x0 + 0.01), (last, x + w >= x1 - 0.01)) if c and cond)
        row_building(f"{prefix}{k}", x, ya, x + w, yb, side, rnd.choice(floors), M, style, awn_l, rear, cs, rnd, rnd.random() < balc)
        x += w
        k += 1
        if alley_every and k % alley_every == 0 and x < nxt - 6 and style == "shop":
            alley_x(f"{prefix}a{k}", x, x + 1.5, yfront, y_in, M)
            x += 1.5


def terrace_y(prefix, y0, y1, xfront, depth, side, M, floors=(2, 3), style="shop", awn=True, gaps=(), rear=None, first=None, last=None,
              balc=0.4, widths=(6.0, 7.5, 9.0)):
    """Same along y with the front on x = xfront (side E: building west of xfront, side W: east of it)."""
    rnd = random.Random(sum(map(ord, prefix)) * 131 + 11)
    awn_l = [M["teal"], M["teal"], M["orange"], M["green"], M["red"]] if awn else None
    x_in = xfront - depth if side == "E" else xfront + depth
    xa, xb = sorted((xfront, x_in))
    y, k = y0, 0
    while y < y1 - 3.5:
        for g0, g1 in gaps:
            if g0 <= y < g1:
                y = g1
        if y >= y1 - 3.5:
            break
        nxt = min([g0 for g0, g1 in gaps if g0 > y] + [y1])
        w = min(rnd.choice(widths), nxt - y)
        if nxt - (y + w) < 3.5:
            w = nxt - y
        cs = tuple(c for c, cond in ((first, y <= y0 + 0.01), (last, y + w >= y1 - 0.01)) if c and cond)
        row_building(f"{prefix}{k}", xa, y, xb, y + w, side, rnd.choice(floors), M, style, awn_l, rear, cs, rnd, rnd.random() < balc)
        y += w
        k += 1


def alley_x(name, x0, x1, yfront, y_in, M):
    """1.5 m service alley between two buildings: brick floor, vending machine, AC units, bin, crates, closed by a gate."""
    s = 1 if y_in > yfront else -1
    cx = (x0 + x1) / 2
    wbox(M["brick"], x0, min(yfront, y_in), -0.1, x1, max(yfront, y_in), 0.14)
    vy = yfront + s * 1.5
    vending(x0 + 0.5, vy, face_rot(0, -s) if False else (math.pi if s > 0 else 0.0), M)
    bin_t(x1 - 0.45, yfront + s * 3.5, M)
    crate(x1 - 0.5, yfront + s * 5.0, 0.3, M, n=2, goods="orange")
    for z in (2.8, 5.8):
        wbox(M["metal"], x1 - 0.5, yfront + s * 3, z, x1, yfront + s * 3.8, z + 0.55)
    wbox(M["black"], x0, y_in - s * 0.1, 0, x1, y_in, 2.2)
    collider(name + "_gate", x0, y_in - s * 0.2, x1, y_in, 0, 2.2)


def facade_gap_fill(M, x0, y0, x1, y1, h, wall=None):
    """Plain back block (for edges nobody walks to)."""
    wbox(wall or M["walls"][0], x0, y0, 0, x1, y1, h)
    wbox(M["roof"], x0 + 0.1, y0 + 0.1, h, x1 - 0.1, y1 - 0.1, h + 0.2)
    collider(f"fill{x0:.0f}_{y0:.0f}", x0, y0, x1, y1, 0, h)


def street_tree(M, x, y, h=7.0, z0=0.14, cards=7):
    tree(x, y, z0, h, M, True, True, cards)


def lamp_pair(prefix, xs, y, M, banner=False):
    for x in xs:
        town_lamp(f"{prefix}{x:.0f}", x, y, M, banner)


# --------------------------------------------------------- market square ----
def roundel(M, cx, cy):
    """Planted roundel with a small tree and four benches; a pale paving band around it."""
    ring(M["plinth"], cx, cy, 5.0, 5.4, 0.15, 0.153, 36)
    ring(M["rim"], cx, cy, 1.8, 2.3, 0.14, 0.42, 20)
    prism(M["soil"], circle(cx, cy, 1.85, 20), 0.14, 0.4)
    prism(M["lawn"], circle(cx, cy, 1.8, 20), 0.4, 0.44)
    collider("roundel", cx - 2.3, cy - 2.3, cx + 2.3, cy + 2.3, 0, 0.42)
    town_tree(cx, cy, 0.44, 5.0, 4242, 10)
    flower_bed(M, cx - 1.4, cy - 1.4, cx + 1.4, cy + 1.4, 0.44, 5)
    for k in range(5):
        a = 2 * math.pi * k / 5
        shrub(M, cx + math.cos(a) * 1.5, cy + math.sin(a) * 1.5, 0.42, 0.4, k % 2 == 0)
    for dx, dy in ((3.6, 0), (-3.6, 0), (0, 3.6), (0, -3.6)):
        bench_t(f"rd{dx}{dy}", cx + dx, cy + dy, face_rot(-dx, -dy), M, 0.15)


def market_square(M):
    wbox(M["walk"], -22, -54, -0.1, 22, -24, 0.15)
    roundel(M, 0, -39)
    stalls = [("pema", M["teal"], ["mango", "apple", "orange"]), ("tomas", M["orange"], ["veg", "orange", "banana"]),
              ("teahouse", M["green"], ["tea", "tea", "tea"]), ("gadget", M["fabric_cream"], ["gadget", "gadget", "gadget"]),
              ("plants", M["teal"], ["plant", "plant", "plant"]), ("v1", M["orange"], ["apple", "banana", "apple"]),
              ("v2", M["red"], ["orange", "mango", "veg"]), ("v3", M["teal"], ["banana", "apple", "veg"])]
    for i, (sid, can, goods) in enumerate(stalls):
        side = -1 if i % 2 == 0 else 1
        y = -29.5 - (i // 2) * 6.0
        stall(sid, side * 7.5, y, -side, can, goods, M)
    for s in (1, -1):
        for y0 in (-34, -46):
            planter(f"pl{s}_{y0}", s * 13 - 2, y0 - 2, s * 13 + 2, y0 + 2, M, True, 0.15, True)
            town_tree(s * 13, y0, 0.65, 6.5, 900 + y0 * s, 8)
        for y in (-26, -40, -52):
            town_lamp(f"lamp_sq{s}_{y}", s * 4.2, y, M, z0=0.15)
        for y in (-31, -43):
            bench_t(f"sq{s}_{y}", s * 10.5, y, s * math.pi / 2, M, 0.15)
        bin_t(s * 10.5, -37.0, M, 0.15)
        bike_rack(s * 18.5, -48, math.pi / 2, M, 0.15, 4)
    for y in (-28, -34, -40, -46):
        string_lights(-4.2, y + 1, 4.2, y + 1, 4.7, M, 6, 0.55)
    fountain("sq_fountain", 0, -50.5, 2.3, M, 0.15)
    for s in (1,):    # NEAR banner between two poles on the east side (west side stays clear for the landmark doors)
        wbox(M["fabric_cream"], s * 18.5 - 0.02, -45.8, 2.0, s * 18.5 + 0.02, -42.2, 5.5)
        for k, rz in ((0, math.pi / 2), (1, -math.pi / 2)):
            o = symbol_mesh(f"sqban{s}_{k}", 0, 0, 0, 2.0, 0.01, M["teal"])
            o.data.transform(Matrix.Rotation(rz, 4, "Z"))
            o.location = (s * 18.5 + (0.03 if k == 0 else -0.03), -44.0, 3.9)
        cyl(M["black"], s * 18.5, -46, 0.15, 6, 0.06, 8)
        cyl(M["black"], s * 18.5, -42, 0.15, 6, 0.06, 8)
        collider(f"sqban{s}", s * 18.5 - 0.1, -46.1, s * 18.5 + 0.1, -41.9, 0, 6)
    spot("chat", "sq_a", -2.5, -44.0, 1, 0); spot("chat", "sq_b", 2.5, -33.0, -1, 0); spot("chat", "sq_c", 0.0, -27.0, 0, -1)


def community_hall(M):
    """Round glass community hall on the square's east side: roof garden, teal bands, N mural pylon."""
    cx, cy, r = 32.0, -39.0, 9.0
    prism(M["shop"], circle(cx, cy, r, 32), 0.15, 7.0)
    for z0, z1, rr, m in ((0.15, 0.55, r + 0.2, M["trim"]), (7.0, 8.6, r + 0.4, M["teal"]), (8.6, 9.0, r + 0.6, M["trim"])):
        prism(m, circle(cx, cy, rr, 32), z0, z1)
    prism(M["trim"], circle(cx, cy, r - 1.0, 32), 9.0, 9.4)
    prism(M["lawn"], circle(cx, cy, r - 1.3, 32), 9.4, 9.5)
    for k in range(16):
        a = 2 * math.pi * k / 16
        mx, my = cx + math.cos(a) * (r + 0.05), cy + math.sin(a) * (r + 0.05)
        wbox(M["trim"], mx - 0.08, my - 0.08, 0.5, mx + 0.08, my + 0.08, 7.0)
        hx, hy = cx + math.cos(a) * (r - 1.1), cy + math.sin(a) * (r - 1.1)
        if k % 2 == 0:
            shrub(M, hx, hy, 9.4, 0.5)
    for k in range(10):
        a = 2 * math.pi * k / 10
    flower_bed(M, cx - 3, cy - 3, cx + 3, cy + 3, 9.5, 3)
    wbox(M["trim"], cx - r - 0.6, cy - 2.0, 0.15, cx - r + 0.6, cy + 2.0, 6.5)
    wbox(M["door"], cx - r - 0.62, cy - 0.9, 0.15, cx - r - 0.55, cy + 0.9, 2.4)
    s = symbol_mesh("round_sym", 0, 0, 0, 2.2, 0.05, M["teal"])
    s.data.transform(Matrix.Rotation(-math.pi / 2, 4, "Z"))
    s.location = (cx - r - 0.62, cy, 4.4)
    collider("round_hall", cx - r - 0.6, cy - r, cx + r, cy + r, 0, 10.5)
    spot("shopdoor", "round_hall", cx - r - 1.6, cy, 1, 0)
    # East Court dressing: tree pits, benches facing the hall, planters
    for x in (25.0, 32.0, 39.0):
        for y in (-26.5, -51.5):
            street_tree(M, x, y, 6.5, 0.15, 6)
    for k in range(5):
        a = math.radians(-70 + k * 35)
    for a_deg in (20, 60, 100, 140, 190, 235, 280, 330):
        a = math.radians(a_deg)
        bx, by = cx + math.cos(a) * (r + 2.0), cy + math.sin(a) * (r + 2.0)
        if 22.0 < bx < 41.0 and -54 < by < -24:
            bench_t(f"hall{a_deg}", bx, by, face_rot(-math.cos(a), -math.sin(a)), M, 0.15)
    for x in (22.6, 41.0):
        for y in (-34.0, -44.0):
            town_lamp(f"lamp_hall{x:.0f}_{y:.0f}", x, y, M, False, 0.15)


# ----------------------------------------------------------------- park ----
def ellipse(cx, cy, rx, ry, n=32, a0=0.0, a1=2 * math.pi):
    return [(cx + rx * math.cos(a0 + (a1 - a0) * k / n), cy + ry * math.sin(a0 + (a1 - a0) * k / n)) for k in range(n)]


def ring_ell(mat, cx, cy, rx0, ry0, rx1, ry1, z0, z1, n=32):
    for k in range(n):
        t0, t1 = 2 * math.pi * k / n, 2 * math.pi * (k + 1) / n
        p = [(cx + rx0 * math.cos(t0), cy + ry0 * math.sin(t0)), (cx + rx1 * math.cos(t0), cy + ry1 * math.sin(t0)),
             (cx + rx1 * math.cos(t1), cy + ry1 * math.sin(t1)), (cx + rx0 * math.cos(t1), cy + ry0 * math.sin(t1))]
        hexa(mat, [(*q, z0) for q in p] + [(*q, z1) for q in p])


def bed(M, x0, y0, x1, y1, z, per=8, palette=None):
    wbox(M["stone"], x0, y0, z - 0.02, x1, y1, z + 0.16)
    wbox(M["soil"], x0 + 0.12, y0 + 0.12, z, x1 - 0.12, y1 - 0.12, z + 0.2)
    flower_bed(M, x0 + 0.2, y0 + 0.2, x1 - 0.2, y1 - 0.2, z + 0.2, per, palette)
    collider(f"bed{x0:.0f}_{y0:.0f}", x0, y0, x1, y1, z - 0.02, z + 0.16)


def picnic(x, y, rot, M, z0=0.08):
    T = tf(x, y, rot)
    obox(M["wood"], T, -1.0, -0.4, z0 + 0.72, 1.0, 0.4, z0 + 0.78)
    for ly in (-0.7, 0.7):
        obox(M["wood"], T, -1.0, ly - 0.15, z0 + 0.42, 1.0, ly + 0.15, z0 + 0.47)
    for lx in (-0.8, 0.8):
        obox(M["wood2"], T, lx - 0.05, -0.8, z0, lx + 0.05, 0.8, z0 + 0.1)
        obox(M["wood2"], T, lx - 0.05, -0.35, z0, lx + 0.05, 0.35, z0 + 0.72)
    col_rot(x, y, 1.1, 0.9, rot, z0, z0 + 0.8, "picnic")
    for sgn, nm in ((-1, "a"), (1, "b")):
        px, py = T(0, 0.7 * sgn)
        fx, fy = T(0, 0.0)
        spot("bench", f"pic{x:.0f}_{y:.0f}{nm}", px, py, fx - px, fy - py)


def swing_set(x, y, M, z0=0.1):
    for sx in (-1.7, 1.7):
        for dy in (-0.5, 0.5):
            wbox(M["tealdk"], x + sx - 0.05, y + dy * 0.2 - 0.05 + dy * 0.5, z0, x + sx + 0.05, y + dy * 0.2 + 0.05 + dy * 0.5, z0 + 2.4)
    wbox(M["teal"], x - 1.85, y - 0.05, z0 + 2.35, x + 1.85, y + 0.05, z0 + 2.48)
    for sx in (-0.7, 0.7):
        for dx in (-0.2, 0.2):
            wbox(M["rail"], x + sx + dx - 0.01, y - 0.01, z0 + 0.55, x + sx + dx + 0.01, y + 0.01, z0 + 2.35)
        wbox(M["orange"], x + sx - 0.25, y - 0.1, z0 + 0.5, x + sx + 0.25, y + 0.1, z0 + 0.56)
    collider(f"swing{x:.0f}", x - 1.9, y - 0.6, x + 1.9, y + 0.6, z0, z0 + 2.4)


def slide(x, y, M, z0=0.1):
    for dx in (-0.55, 0.55):
        for dy in (-0.55, 0.55):
            wbox(M["wood2"], x + dx - 0.05, y + dy - 0.05, z0, x + dx + 0.05, y + dy + 0.05, z0 + 1.7)
    wbox(M["wood"], x - 0.6, y - 0.6, z0 + 1.6, x + 0.6, y + 0.6, z0 + 1.7)
    for sy in (-0.6, 0.6):
        wbox(M["tealdk"], x - 0.6, y + sy - 0.03, z0 + 1.7, x + 0.6, y + sy + 0.03, z0 + 2.3)
    hexa(M["orange"], [(x + 0.6, y - 0.3, z0 + 1.7), (x + 3.2, y - 0.3, z0 + 0.1), (x + 3.2, y + 0.3, z0 + 0.1), (x + 0.6, y + 0.3, z0 + 1.7),
                       (x + 0.6, y - 0.3, z0 + 1.78), (x + 3.2, y - 0.3, z0 + 0.18), (x + 3.2, y + 0.3, z0 + 0.18), (x + 0.6, y + 0.3, z0 + 1.78)])
    for sy in (-0.3, 0.3):
        hexa(M["tealdk"], [(x + 0.6, y + sy - 0.02, z0 + 1.78), (x + 3.2, y + sy - 0.02, z0 + 0.18), (x + 3.2, y + sy + 0.02, z0 + 0.18), (x + 0.6, y + sy + 0.02, z0 + 1.78),
                           (x + 0.6, y + sy - 0.02, z0 + 2.0), (x + 3.2, y + sy - 0.02, z0 + 0.4), (x + 3.2, y + sy + 0.02, z0 + 0.4), (x + 0.6, y + sy + 0.02, z0 + 2.0)])
    for k in range(5):  # ladder rungs
        wbox(M["rail"], x - 0.6, y + 0.6, z0 + 0.3 + k * 0.3, x - 0.0, y + 0.64, z0 + 0.34 + k * 0.3)
    prism(M["tealdk"], [(x - 0.75, y - 0.75), (x + 0.75, y - 0.75), (x + 0.75, y + 0.75), (x - 0.75, y + 0.75)], z0 + 2.3, z0 + 2.7,
          [(x - 0.1, y - 0.1), (x + 0.1, y - 0.1), (x + 0.1, y + 0.1), (x - 0.1, y + 0.1)])
    collider(f"slide{x:.0f}", x - 0.8, y - 0.8, x + 3.3, y + 0.8, z0, z0 + 1.7)


def seesaw(x, y, M, z0=0.1):
    wbox(M["tealdk"], x - 0.06, y - 1.2, z0 + 0.45, x + 0.06, y + 1.2, z0 + 0.5)
    wbox(M["rail"], x - 0.08, y - 0.1, z0, x + 0.08, y + 0.1, z0 + 0.45)
    for s in (-1, 1):
        wbox(M["orange"], x - 0.12, y + s * 1.15 - 0.05, z0 + 0.5, x + 0.12, y + s * 1.15 + 0.05, z0 + 0.7)
    collider(f"seesaw{x:.0f}", x - 0.3, y - 1.3, x + 0.3, y + 1.3, z0, z0 + 0.6)


def duck(x, y, z, M, rot=0.0):
    T = tf(x, y, rot)
    bx, by = T(0, 0)
    blob(M["trim"], (bx, by, z + 0.08), 0.12, 0.17, 0.09, 1)
    hx, hy = T(0, 0.14)
    blob(M["trim"], (hx, hy, z + 0.2), 0.07, 0.07, 0.07, 1)
    obox(M["orange"], T, -0.03, 0.2, z + 0.17, 0.03, 0.27, z + 0.21)


def park_gate(M):
    """Linden Park gate on Cafe Street: brick piers with stone caps and lanterns, wrought-iron arch with scrolls,
    plaque lettered by brand.ts (fascia 'Linden Park' at z 63.3)."""
    gy = -63.2
    for gx in (-64.2, -59.8):
        wbox(M["stone"], gx - 0.55, gy - 0.55, 0.14, gx + 0.55, gy + 0.55, 0.6)
        wbox(M["brickw"], gx - 0.42, gy - 0.42, 0.6, gx + 0.42, gy + 0.42, 3.0)
        for zz in (1.2, 2.0):
            wbox(M["stone"], gx - 0.46, gy - 0.46, zz, gx + 0.46, gy + 0.46, zz + 0.07)
        wbox(M["stone"], gx - 0.55, gy - 0.55, 3.0, gx + 0.55, gy + 0.55, 3.15)
        prism(M["stone"], [(gx - 0.45, gy - 0.45), (gx + 0.45, gy - 0.45), (gx + 0.45, gy + 0.45), (gx - 0.45, gy + 0.45)], 3.15, 3.5,
              [(gx - 0.1, gy - 0.1), (gx + 0.1, gy - 0.1), (gx + 0.1, gy + 0.1), (gx - 0.1, gy + 0.1)])
        wbox(M["black"], gx - 0.15, gy - 0.15, 3.5, gx + 0.15, gy + 0.15, 3.58)
        wbox(M["lampglow"], gx - 0.12, gy - 0.12, 3.58, gx + 0.12, gy + 0.12, 3.95)
        wbox(M["black"], gx - 0.16, gy - 0.16, 3.95, gx + 0.16, gy + 0.16, 4.03)
        collider(f"gatepier{gx}", gx - 0.55, gy - 0.55, gx + 0.55, gy + 0.55, 0, 3.5)
    cx, r = -62.0, 2.2
    pts = [(cx + r * math.cos(math.pi - math.pi * k / 14), 3.1 + 1.5 * math.sin(math.pi * k / 14)) for k in range(15)]
    for (xa, za), (xb, zb) in zip(pts, pts[1:]):
        rod(M["black"], (xa, gy, za), (xb, gy, zb), 0.035)
        rod(M["black"], (xa, gy, za - 0.35), (xb, gy, zb - 0.35), 0.02)
    for xa, za in pts[1:-1]:
        rod(M["black"], (xa, gy, za), (xa, gy, za - 0.35), 0.02)
    for k, xx in enumerate((-63.3, -62.0, -60.7)):   # gate bars below the plaque
        pass
    wbox(M["black"], cx - 0.05, gy - 0.03, 3.1, cx + 0.05, gy + 0.03, 4.6)
    for sgn in (-1, 1):
        for k in range(4):
            ax = cx + sgn * (0.35 + k * 0.45)
            ztop = 3.1 + 1.5 * math.sin(math.acos(min(1.0, abs(ax - cx) / r)))
            rod(M["black"], (ax, gy, 3.1), (ax, gy, ztop - 0.35), 0.02)
    wbox(M["trim"], cx - 1.65, gy - 0.1, 3.3, cx + 1.65, gy - 0.02, 4.1)
    wbox(M["teal"], cx - 1.7, gy - 0.12, 3.25, cx + 1.7, gy - 0.1, 3.3)
    wbox(M["teal"], cx - 1.7, gy - 0.12, 4.1, cx + 1.7, gy - 0.1, 4.15)
    for sx in (-5.2, 5.2):
        town_lamp(f"gate_lamp{sx}", cx + sx, -64.3, M, False, 0.14, 4.0)
    for sx in (-3.4, 3.4):
        planter(f"gate_pl{sx}", cx + sx - 0.6, -65.0, cx + sx + 0.6, -64.2, M, True, 0.14, True)


def park(M):
    z = 0.08
    X0, X1, Y0, Y1 = -76.0, -53.5, -63.0, -6.5
    wbox(M["lawn"], X0, Y0, -0.1, X1, Y1, z)
    pc = (-65.5, -33.0)

    def path(pts, w=2.6, sm=2):
        path_strip(M["path"], smooth(pts, sm), w, z - 0.01, z + 0.03)

    loop = ellipse(pc[0], pc[1], 8.8, 7.4, 32)
    path(loop + [loop[0], loop[1]], 2.4, 0)
    path([(-53.5, -33), (-56, -33), (-57.4, -33)], 2.8, 0)
    path([(-62, -63), (-62, -58)], 3.0, 0)
    path([(-62, -47.5), (-63.5, -44), (-65.5, -40.6)], 2.4, 2)
    path([(-53.5, -52.5), (-57.2, -52.5)], 2.6, 0)
    path([(-65.5, -25.6), (-65.5, -20.0)], 2.4, 0)
    path([(-53.5, -18), (-57, -18), (-61, -19.5), (-65.5, -20)], 2.4, 2)
    path([(-66.5, -52.5), (-69.0, -52.5)], 2.4, 0)
    # pond
    ring_ell(M["stone"], pc[0], pc[1], 5.8, 4.2, 6.4, 4.8, z - 0.02, z + 0.16, 28)
    prism(M["water2"], ellipse(pc[0], pc[1], 5.85, 4.25, 28), z - 0.1, z + 0.05)
    collider("pond", pc[0] - 6.5, pc[1] - 4.9, pc[0] + 6.5, pc[1] + 4.9, 0, 0.2)
    for k in range(9):
        a = rt.uniform(0, 6.28)
        rr = rt.uniform(0.2, 0.85)
        px, py = pc[0] + math.cos(a) * 5.0 * rr, pc[1] + math.sin(a) * 3.5 * rr
        prism(M["leaf"], circle(px, py, rt.uniform(0.25, 0.4), 8), z + 0.05, z + 0.065)
        if k % 3 == 0:
            flower(M, px, py, z + 0.065, rt, M["petal_p"], 0.7)
    for k in range(10):  # reeds along the rim
        a = 2 * math.pi * k / 10 + 0.3
        tuft(M, pc[0] + math.cos(a) * 6.5, pc[1] + math.sin(a) * 5.0, z, 0.7, 0.14)
        tuft(M, pc[0] + math.cos(a) * 6.7, pc[1] + math.sin(a) * 5.2, z, 0.55, 0.12)
    duck(pc[0] - 1.5, pc[1] + 1.0, z + 0.05, M, 0.6)
    duck(pc[0] + 2.0, pc[1] - 1.4, z + 0.05, M, 2.4)
    # fountain circle
    fc = (-62.0, -52.5)
    prism(M["path"], circle(fc[0], fc[1], 5.2, 32), z - 0.01, z + 0.03)
    ring(M["stone"], fc[0], fc[1], 5.2, 5.5, z - 0.02, z + 0.1, 32)
    ring(M["tealdk"], fc[0], fc[1], 3.6, 3.8, z + 0.03, z + 0.04, 32)
    fountain("park_fountain", fc[0], fc[1], 1.9, M, z + 0.03)
    for a_deg in (45, 135, 225, 315):
        a = math.radians(a_deg)
        bench_t(f"fc{a_deg}", fc[0] + math.cos(a) * 4.3, fc[1] + math.sin(a) * 4.3, face_rot(-math.cos(a), -math.sin(a)), M, z + 0.03)
    for a_deg in (0, 90, 180, 270):
        a = math.radians(a_deg + 0)
        if a_deg in (90, 0, 270, 180):
            pass
    for sx, sy in ((1, 1), (-1, 1), (1, -1)):
        bed(M, fc[0] + sx * 5.9 - 1.0, fc[1] + sy * 4.6 - 0.9, fc[0] + sx * 5.9 + 1.0, fc[1] + sy * 4.6 + 0.9, z, 9) if not (sx == -1 and sy == 1) else None
    # stage and forecourt
    sc = (-65.5, -10.5)
    ring_pts = ellipse(sc[0], sc[1], 9.5, 9.5, 18, math.pi, 2 * math.pi) + [(sc[0] + 9.5, sc[1])]
    prism(M["path"], ring_pts, z - 0.01, z + 0.03)
    prism(M["stone"], ellipse(sc[0], sc[1], 5.0, 5.0, 14, math.pi, 2 * math.pi) + [(sc[0] + 5.0, sc[1])], 0.0, 0.75)
    ring(M["trim"], sc[0], sc[1], 4.0, 4.4, 0.75, 5.3, 12, 0, math.pi)
    ring(M["tealdk"], sc[0], sc[1], 3.9, 4.0, 0.75, 5.1, 12, 0, math.pi)
    ring(M["trim"], sc[0], sc[1], 0.0, 5.0, 5.3, 5.55, 12, 0, math.pi)
    ring(M["teal"], sc[0], sc[1], 4.6, 5.0, 5.55, 5.75, 12, 0, math.pi)
    ring(M["led"], sc[0], sc[1], 4.4, 4.46, 5.1, 5.18, 12, 0, math.pi)
    for sx in (-4.7, 4.7):
        wbox(M["trim"], sc[0] + sx - 0.2, sc[1] - 0.25, 0.75, sc[0] + sx + 0.2, sc[1] + 0.25, 5.3)
        wbox(M["black"], sc[0] + sx * 0.8 - 0.4, sc[1] - 2.0, 0.75, sc[0] + sx * 0.8 + 0.4, sc[1] - 1.2, 2.0)
    for k in range(5):
        wbox(M["black"], sc[0] - 3.2 + k * 1.6 - 0.15, sc[1] - 4.3, 5.0, sc[0] - 3.2 + k * 1.6 + 0.15, sc[1] - 4.0, 5.3)
    wbox(M["tealdk"], sc[0] - 3.0, sc[1] + 2.0, 0.75, sc[0] + 3.0, sc[1] + 2.05, 4.0)
    for i in range(2):
        wbox(M["stone"], sc[0] - 2.0, sc[1] - 5.5 - 0.5 * i, 0.0, sc[0] + 2.0, sc[1] - 5.0 - 0.5 * i, 0.5 - 0.25 * i)
        collider(f"stage_step{i}", sc[0] - 2.0, sc[1] - 5.5 - 0.5 * i, sc[0] + 2.0, sc[1] - 5.0 - 0.5 * i, 0, 0.5 - 0.25 * i)
    collider("stage_a", sc[0] - 5.0, sc[1], sc[0] + 5.0, -6.2, 0, 0.75)
    collider("stage_b", sc[0] - 4.1, sc[1] - 2.5, sc[0] + 4.1, sc[1], 0, 0.75)
    collider("stage_c", sc[0] - 2.1, sc[1] - 5.0, sc[0] + 2.1, sc[1] - 2.5, 0, 0.75)
    collider("stage_wall", sc[0] - 4.5, -6.9, sc[0] + 4.5, -6.2, 0, 5.3)
    for a_deg in (215, 235, 305, 325):
        a = math.radians(a_deg)
        bench_t(f"st{a_deg}", sc[0] + math.cos(a) * 7.6, sc[1] + math.sin(a) * 7.6, face_rot(-math.cos(a), -math.sin(a)), M, z + 0.03)
    # playground
    pgx0, pgx1, pgy0, pgy1 = -75.5, -69.0, -58.5, -46.5
    wbox(M["walls"][2], pgx0, pgy0, z - 0.02, pgx1, pgy1, z + 0.04)
    wbox(M["sand"], -75.0, -49.8, z, -72.0, -47.2, z + 0.12)
    for (a, b, c_, d) in ((-75.1, -49.9, -71.9, -49.8), (-75.1, -47.2, -71.9, -47.1), (-75.1, -49.9, -75.0, -47.1), (-72.0, -49.9, -71.9, -47.1)):
        wbox(M["wood2"], a, b, z, c_, d, z + 0.22)
    collider("sandbox", -75.1, -49.9, -71.9, -47.1, z, z + 0.22)
    swing_set(-72.2, -57.0, M, z + 0.04)
    slide(-74.8, -53.0, M, z + 0.04)
    seesaw(-70.6, -52.2, M, z + 0.04)
    for k in range(3):
        railing(pgx0, pgy1 + 0.0 if False else pgy1, pgx1, pgy1, M, z, 0.8, 2.0, M["teal"], True) if k == 0 else None
    railing(pgx1, pgy0, pgx1, -50.0, M, z, 0.8, 2.0, M["teal"])
    railing(pgx1, -48.0, pgx1, pgy1, M, z, 0.8, 2.0, M["teal"])
    bench_t("pg0", -69.5, -57.0, math.pi / 2, M, z)
    # picnic lawn
    picnic(-72.0, -23.5, 0.0, M, z)
    picnic(-72.0, -28.0, 0.0, M, z)
    spot("chat", "park_a", -58.5, -26.0, 1, 0); spot("chat", "park_b", -60.5, -40.5, 0, 1); spot("chat", "park_c", -57.5, -57.5, 0, 1)
    # beds, hedges, fences, gates
    bed(M, -57.2, -11.5, -55.0, -9.0, z, 9); bed(M, -75.0, -11.5, -72.8, -9.0, z, 9)
    bed(M, -62.0, -60.8, -58.0, -59.4, z, 10)
    for y0, y1 in ((-63.0, -54.0), (-51.0, -34.5), (-31.5, -19.5), (-16.5, -6.5)):
        railing(-53.7, y0, -53.7, y1, M, 0.14, 1.1, 2.0, M["black"])
    for y0, y1 in ((-60.5, -55.5), (-49.5, -36.0), (-30.0, -21.0), (-15.0, -8.0)):
        leafy_hedge(M, -55.2, y0, -54.0, y1, z, 1.0)
    for a, b in ((-76.0, -64.0), (-60.0, -53.5)):
        railing(a, -63.2, b, -63.2, M, 0.14, 1.1, 2.0, M["black"])
    leafy_hedge(M, -76.2, -62.6, -74.6, -6.8, z, 1.8)
    for a, b in ((-76.0, -53.5),):
        railing(a, -6.5, b, -6.5, M, z, 1.2, 2.0, M["black"])
    park_gate(M)
    for gy in (-33.0, -52.5, -18.0):  # side gate piers on West Lane
        for dy in (-1.6, 1.6):
            wbox(M["stone"], -54.1, gy + dy - 0.25, 0.14, -53.3, gy + dy + 0.25, 2.2)
            collider(f"sidepier{gy}{dy}", -54.1, gy + dy - 0.25, -53.3, gy + dy + 0.25, 0, 2.2)
        wbox(M["teal"], -54.0, gy - 1.85, 2.2, -53.4, gy + 1.85, 2.45)
    # trees, lamps, bins, benches
    for (tx, ty, th) in ((-74.2, -9.5, 8), (-74.2, -19, 7.5), (-74.4, -28, 8), (-74.4, -38, 7), (-74.4, -45, 8), (-74.2, -61, 7),
                         (-69.5, -61, 7), (-57.5, -61, 6.5), (-57.5, -10.5, 7), (-60.0, -27, 7.5), (-71.0, -39.5, 7), (-59.0, -38.5, 7.5),
                         (-68.5, -26.0, 8), (-62.0, -9.0, 6), (-57.0, -46.0, 7), (-69.0, -17.0, 7), (-56.0, -23.0, 6.5), (-72.5, -61.5, 6), (-72.5, -13.0, 8), (-66.0, -8.5, 7.5), (-73.5, -33.0, 8), (-74.0, -52.0, 7.5), (-60.0, -8.5, 7), (-74.2, -23.5, 7.5)):
        town_tree(tx, ty, z, th, rt.randint(1, 10 ** 6), 8)
        collider(f"ptree{tx}{ty}", tx - 0.3, ty - 0.3, tx + 0.3, ty + 0.3, 0, 3)
    for a_deg in range(0, 360, 60):
        a = math.radians(a_deg)
        town_lamp(f"plamp{a_deg}", pc[0] + math.cos(a) * 10.3, pc[1] + math.sin(a) * 8.9, M, False, z + 0.03, 4.0)
    for a_deg in (0, 120, 240):
        a = math.radians(a_deg + 30)
        town_lamp(f"flamp{a_deg}", fc[0] + math.cos(a) * 5.5, fc[1] + math.sin(a) * 5.5, M, False, z + 0.03, 4.0)
    for a_deg in (30, 150, 270):
        a = math.radians(a_deg)
        bench_t(f"pond{a_deg}", pc[0] + math.cos(a) * 7.6, pc[1] + math.sin(a) * 6.2, face_rot(-math.cos(a), -math.sin(a)), M, z + 0.03)
    for bx, by in ((-56.3, -35.0), (-56.3, -50.0), (-64.0, -22.0), (-66.5, -61.5)):
        bin_t(bx, by, M, z)
    bench_t("pk_n", -61.0, -22.4, face_rot(0, -1), M, z + 0.03)


# ---------------------------------------------------------- districts ----
def rod(mat, p, q, t=0.05):
    hexa(mat, [(p[0] - t, p[1] - t, p[2]), (q[0] - t, q[1] - t, q[2]), (q[0] + t, q[1] - t, q[2]), (p[0] + t, p[1] - t, p[2]),
               (p[0] - t, p[1] + t, p[2]), (q[0] - t, q[1] + t, q[2]), (q[0] + t, q[1] + t, q[2]), (p[0] + t, p[1] + t, p[2])])


def bunting(M, x0, y0, x1, y1, z, n=10, sag=0.5):
    cols = [M["teal"], M["orange"], M["fabric_cream"], M["pink"], M["yellow"]]
    pts = []
    for i in range(n + 1):
        t = i / n
        pts.append((x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, z - sag * 4 * t * (1 - t)))
    for a, b in zip(pts, pts[1:]):
        rod(M["black"], a, b, 0.012)
    dx, dy = (x1 - x0), (y1 - y0)
    L = math.hypot(dx, dy)
    ux, uy = dx / L, dy / L
    for i in range(n):
        m = ((pts[i][0] + pts[i + 1][0]) / 2, (pts[i][1] + pts[i + 1][1]) / 2, (pts[i][2] + pts[i + 1][2]) / 2)
        w = 0.28
        a = (m[0] - ux * w, m[1] - uy * w, m[2]); b = (m[0] + ux * w, m[1] + uy * w, m[2]); c = (m[0], m[1], m[2] - 0.4)
        put(cols[i % len(cols)], [a, b, c, a, c, b], [(0, 1, 2), (3, 4, 5)])


def tech_pole(x, y, M, z0=0.14):
    pole(x, y, M, z0, 8.0, 2)


def innovation(M):
    z = 0.15
    wbox(M["walk"], 52.5, -55, -0.1, 85, -25, z)
    for k in range(6):   # LED grid lines in the paving
        wbox(M["led"], 55 + k * 5.6, -55, z, 55.07 + k * 5.6, -25, z + 0.012)
    for k in range(5):
        wbox(M["led"], 52.5, -53 + k * 6, z, 85, -52.93 + k * 6, z + 0.012)
    c = (68.5, -40.0)
    for x0, y0, x1, y1 in ((-6.5, -6.5, 6.5, -5.9), (-6.5, 5.9, 6.5, 6.5), (-6.5, -5.9, -5.9, 5.9), (5.9, -5.9, 6.5, 5.9)):
        wbox(M["rim"], c[0] + x0, c[1] + y0, z - 0.02, c[0] + x1, c[1] + y1, z + 0.5)
    wbox(M["water2"], c[0] - 5.9, c[1] - 5.9, z - 0.05, c[0] + 5.9, c[1] + 5.9, z + 0.38)
    prism(M["rim"], circle(c[0], c[1], 1.4, 16), z + 0.3, z + 1.1)
    prism(M["trim"], circle(c[0], c[1], 1.5, 16), z + 1.1, z + 1.2)
    collider("inno_pool", c[0] - 6.5, c[1] - 6.5, c[0] + 6.5, c[1] + 6.5, 0, 0.5)
    nodes_ = [(c[0] + 2.6 * math.cos(a), c[1] + 2.6 * math.sin(a), 2.0 + h) for a, h in ((0.2, 0.0), (1.2, 1.4), (2.3, 0.6), (3.3, 1.9), (4.4, 0.3), (5.3, 1.1))]
    top = (c[0], c[1], 5.2)
    for i, p in enumerate(nodes_):
        rod(M["trim"], (c[0], c[1], z + 1.2), p, 0.03)
        rod(M["led"], p, nodes_[(i + 1) % len(nodes_)], 0.025)
        blob(M["led"] if i % 2 else M["trim"], p, 0.28, 0.28, 0.28, 1)
    rod(M["trim"], (c[0], c[1], z + 1.2), top, 0.05)
    blob(M["led"], top, 0.45, 0.45, 0.45, 1)
    ring(M["led"], c[0], c[1], 2.55, 2.62, 3.1, 3.16, 24)
    for k in range(4):
        a = math.pi / 4 + k * math.pi / 2
    for bx, by, rot in ((68.5, -48.2, face_rot(0, 1)), (68.5, -31.8, face_rot(0, -1)), (56.5, -40.0, face_rot(1, 0)), (80.5, -40.0, face_rot(-1, 0)),
                        (58, -48.2, face_rot(0, 1)), (79, -31.8, face_rot(0, -1))):
        bench_t(f"inno{bx:.0f}{by:.0f}", bx, by, rot, M, z)
    for tx, ty in ((57.5, -28.5), (64, -28.5), (73, -28.5), (80, -28.5), (57.5, -52.5), (64, -52.5), (73, -52.5), (80, -52.5)):
        street_tree(M, tx, ty, 6.5, z, 6)
    for tx, ty in ((60, -46), (77, -34)):
        town_lamp(f"inno_l{tx}", tx, ty, M, False, z, 4.4)
    for lx in (56, 62, 75, 82):
        town_lamp(f"inno_ll{lx}", lx, -26.2, M, False, z, 4.4)
    spot("chat", "inno_a", 62.0, -37.0, 1, 0); spot("chat", "inno_b", 75.0, -43.0, -1, 0); spot("chat", "inno_c", 68.5, -52.0, 0, 1)
    # buildings along the north edge
    for nm, x0, x1, fl in (("tech_a", 54.0, 68.0, 5), ("tech_b", 71.0, 84.5, 4)):
        building(nm, x0, -25.0, x1, -9.0, "S", fl, M, M["walls"][1], "modern", accent=M["teal"], rnd=rt)
        building(nm + "w", x0, -25.0, x1, -9.0, "W", fl, M, M["walls"][1], "modern", accent=M["teal"], rnd=rt, col=False, body=False) if x0 < 60 else None
    wbox(M["walls"][3], 68.0, -25.0, 0.0, 71.0, -9.0, 3.2)     # link block between the two
    wbox(M["glassd"], 68.0, -25.05, 0.4, 71.0, -25.0, 3.0)
    collider("tech_link", 68.0, -25.0, 71.0, -9.0, 0, 3.2)
    for x0, x1 in ((52.6, 53.8), (84.6, 85.0)):
        hedge_b(M, x0, -24.0, x1, -7.0, 0.14, 1.2, 0.1)
    for tx, ty in ((53.0, -8.0), (84.0, -7.5)):
        pass
    # EV parking (north of the Cafe Street turning circle)
    wbox(M["asphalt"], 52.5, -63, -0.1, 64.8, -55, 0.02)
    for k in range(5):
        wbox(M["paint"], 52.5 + 0.0 + k * 2.6 + 0.0, -63, 0.02, 52.5 + k * 2.6 + 0.1, -57.6, 0.03)
    for k, (asset, fy) in enumerate((("ev_sedan", 1), ("ev_pickup", 1), ("ev_sedan", 1), (None, 0))):
        bx = 53.8 + k * 2.6
        if asset:
            parked(asset, f"inno_p{k}", bx, -60.2, 0, 1)
        wbox(M["greyd"], bx - 0.12, -56.9, 0.02, bx + 0.12, -56.7, 1.35)
        wbox(M["led"], bx - 0.1, -56.92, 1.1, bx + 0.1, -56.88, 1.3)
        wbox(M["teal"], bx - 0.2, -57.0, 0.02, bx + 0.2, -56.7, 0.15)
    PARKING.append({"x": round(53.8 + 3 * 2.6, 2), "z": 60.2, "yaw": 3.142, "dx": 0.0, "dz": 1.0})
    railing(52.5, -55.0, 64.8, -55.0, M, 0.02, 0.9, 2.0, M["teal"])
    for tx in (54.0, 62.5):
        pass
    tech_pole(52.0, -57.0, M)
    # north verge trees
    for tx in (58.0, 66.0, 74.0, 82.0):
        town_tree(tx, -7.8, 0.14, 7.5, rt.randint(1, 10 ** 6), 6)


def crate_yard(M):
    wall = M["brickw"]
    # dock pocket between the workshops (x 22..36)
    wbox(M["asphalt"], 22, -100, -0.1, 36, -94.5, 0.02)
    wbox(wall, 22, -101, 0, 36, -100, 5.0)
    for k in range(3):
        wbox(M["greyd"], 23.2 + k * 4.2, -100.05, 0.02, 25.8 + k * 4.2, -99.95, 3.2)
        for j in range(8):
            wbox(M["metal"], 23.2 + k * 4.2, -100.1, 0.3 + j * 0.38, 25.8 + k * 4.2, -99.95, 0.34 + j * 0.38)
        wbox(M["lampglow"], 24.3 + k * 4.2, -100.2, 3.5, 24.7 + k * 4.2, -99.9, 3.7)
    wbox(M["yellow"], 22, -100.05, 0.0, 36, -99.95, 0.4)
    wbox(M["trim"], 21.8, -101.1, 5.0, 36.2, -99.9, 5.25)
    collider("dock_wall", 22, -101, 36, -99.5, 0, 5.0)
    parked("car_van", "dock_v0", 24.5, -97.0, 0, 1)
    parked("car_van", "dock_v1", 33.5, -97.2, 0, 1)
    for k, (x, y) in enumerate(((28.2, -96.8), (28.8, -98.4), (30.0, -97.4))):
        crate(x, y, rt.uniform(-0.3, 0.3), M, 0.02, rt.choice((2, 3)), rt.choice(("orange", "apple", "veg")))
        spot("crate", f"dock{k}", x + (0.0 if k else 0.0), y + 1.1 if y < -97 else y - 1.1, 0, -1 if y < -97 else 1)
    for x in (22.3, 35.7):
        cone(x, -95.2, M)
    # container yard east of the workshops
    wbox(M["asphalt"], 50.5, -100, -0.1, 64.8, -94.5, 0.02)
    cx = 51.5
    for k, (m, w, y, st) in enumerate((("container1", 6.0, -98.4, 2), ("container2", 6.0, -98.4, 1), ("container3", 5.0, -96.0, 1))):
        x0 = cx if k != 1 else cx + 6.2
        if k == 2:
            x0 = cx + 1.0
        for lvl in range(st):
            z0 = 0.02 + lvl * 2.65
            wbox(M[m], x0, y - 1.2, z0, x0 + w, y + 1.2, z0 + 2.6)
            for j in range(int(w / 0.5)):
                wbox(M["trim"], x0 + 0.15 + j * 0.5, y - 1.23, z0 + 0.1, x0 + 0.22 + j * 0.5, y - 1.2, z0 + 2.5)
            wbox(M["black"], x0 + w - 0.05, y - 1.2, z0, x0 + w, y + 1.2, z0 + 2.6)
        collider(f"cont{k}", x0, y - 1.2, x0 + w, y + 1.2, 0, 2.65 * st)
    for k, (x, y) in enumerate(((60.5, -95.6), (62.2, -95.6), (63.6, -96.0))):
        crate(x, y, 0.1 * k, M, 0.02, 2 + k % 2, "mango" if k % 2 else "apple")
    spot("crate", "yard0", 61.4, -94.5, 0, 1)
    railing(50.5, -94.3, 64.8, -94.3, M, 0.02, 1.4, 2.0, M["rail"])
    tech_pole(50.8, -94.8, M, 0.02)


LOTS = [(-62.0, -48.0), (-42.0, -28.0), (38.0, 50.0)]


def lots(M):
    """Three kerb-side parking lots cut into the south rows of Plum and Foundry Lane (bays nose-in, a few cars parked)."""
    assets = ["ev_sedan", "car_hatch", "ev_pickup", "ev_sedan", "car_hatch"]
    for li, (x0, x1) in enumerate(LOTS):
        n = max(4, int((x1 - x0) // 2.8))
        bw = (x1 - x0) / n
        wbox(M["asphalt"], x0, -100.0, -0.1, x1, -92.0, 0.02)
        wbox(M["curb"], x0 - 0.2, -100.0, 0, x0, -92.0, 0.15)
        wbox(M["curb"], x1, -100.0, 0, x1 + 0.2, -92.0, 0.15)
        wbox(M["brickw"], x0 - 0.2, -101.0, 0, x1 + 0.2, -100.0, 3.4)
        wbox(M["trim"], x0 - 0.3, -101.1, 3.4, x1 + 0.3, -99.9, 3.55)
        collider(f"lot_wall{li}", x0 - 0.2, -101.0, x1 + 0.2, -100.0, 0, 3.4)
        for k in range(n + 1):
            wbox(M["paint"], x0 + k * bw - 0.05, -99.0, 0.02, x0 + k * bw + 0.05, -94.5, 0.03)
        leafy_hedge(M, x0 - 0.2, -100.0, x1 + 0.2, -99.0, 0.02, 1.3)
        for k in range(n):
            bx = x0 + (k + 0.5) * bw
            if (k + li) % 3 != 1:
                parked(assets[(k + li) % len(assets)], f"lot{li}_{k}", bx, -96.6, 0, -1, record=False)
            else:
                PARKING.append({"x": round(bx, 2), "z": 96.6, "yaw": round(math.atan2(0, -1), 3), "dx": 0.0, "dz": 1.0})
        spot("chat", f"lot{li}", (x0 + x1) / 2, -93.2, 0, -1)


def plum_dress(M):
    for x in range(-60, -10, 11):
        town_lamp(f"plum_l{x}", x, -84.2, M, False)
        if not any(a - 1 < x + 3 < b + 1 for a, b in LOTS):
            street_tree(M, x + 3, -93.4, 6.0, 0.14, 6)
    for x in (-62, -34, -12):
        bike_rack(x, -84.2, 0.0, M, 0.14, 4)
        for k in range(3):
            bike(x - 0.55 + k * 0.55, -84.3, 0.0, M, 0.14)
    for x in (-68, -24):
        bench_t(f"plum{x}", x, -93.0, 0.0, M, 0.14)
        bin_t(x + 1.5, -93.2, M)
    for x in (-58, -46, -30, -18):
        bunting(M, x, -83.4, x, -95.0, 6.2, 8, 0.8)
    for x in (-66, -25):
        # second span ends at x=-3, off the spawn line at x=0 (a pole there blocked the walk north)
        p = pole(x, -85.2, M)
        q = pole(x + 22, -85.2, M)
        wire_span(p, q, M, 0.7)
    # house front gardens: low hedges + flower beds at the stoops
    for x in range(-74, -8, 6):
        hedge_b(M, x + 0.2, -94.6, x + 1.8, -94.1, 0.14, 0.45, 0.04)
        flower_bed(M, x + 3.6, -94.5, x + 5.2, -94.1, 0.14, 12)
    for x in (-40, -16):
        vending(x, -83.9, math.pi, M)
    spot("chat", "plum_a", -48, -90, 1, 0); spot("chat", "plum_b", -20, -88, -1, 0)


def foundry_dress(M):
    for x in range(12, 50, 12):
        town_lamp(f"fnd_l{x}", x, -84.2, M, False)
    for x in (14, 30):
        street_tree(M, x, -93.4, 6.0, 0.14, 6)
    for x in (10, 34):
        bin_t(x, -93.3, M)
    for x in (16, 44):
        bunting(M, x, -83.4, x, -95.0, 6.2, 8, 0.8)
    for x in (9, 38):
        p = pole(x, -85.3, M)
        q = pole(x + 24, -85.3, M)
        wire_span(p, q, M, 0.7)
    bench_t("fnd_b0", 12.0, -93.0, 0.0, M)
    for k in range(3):
        crate(18.0 + k * 0.9, -93.1, 0.2 * k, M, 0.14, 1 + k % 2, "orange")
    spot("crate", "fnd_0", 18.4, -91.9, 0, 1)
    spot("chat", "fnd_a", 30, -88, 1, 0)
    # roadworks patch on the lane edge (not in a driving lane)
    for k in range(3):
        cone(28.0 + k * 0.6, -85.9, M)
    barrier(30.4, -85.7, 0.0, M)


def cafe_dress(M):
    # trees and lamps on both pavements, kept off the crossings and side-street mouths
    for x in (-40.0, -26.0, -14.0, 16.0, 30.0, 40.0):
        street_tree(M, x, -64.8, 6.5, 0.14, 7)
    for x in (-41.0, -29.0, -13.0, 13.0, 29.0, 42.0):
        street_tree(M, x, -75.9, 6.5, 0.14, 7) if abs(x) > 10 and x not in (-29.0, 29.0) else None
    for x in (-42, -28, -14, 14, 28):
        town_lamp(f"lamp_cafe_n{x}", x, -65.4, M, True) if x not in (-28, 28) else None
    for x in (-49, -35, -21, -7, 7, 21, 35, 49):
        town_lamp(f"lamp_cafe_s{x}", x, -74.6, M, False)
    # cafe terraces with umbrellas (south pavement) and benches/bins
    for k in range(4):
        cafe_table(f"cs{k}", -40 + k * 2.8, -75.9, M, M["teal"] if k % 2 == 0 else M["orange"])
    for k in range(3):
        cafe_table(f"ce{k}", 10.5 + k * 3.0, -75.9, M, M["green"] if k % 2 == 0 else M["red"])
    for x, rot in ((-17.5, 0.0), (17.5, 0.0)):
        bike_rack(x, -75.9, rot, M, 0.14, 5)
        for k in range(3):
            bike(x - 0.55 + k * 0.55, -75.9, rot, M, 0.14)
    bin_t(-9.5, -75.3, M); bin_t(9.5, -75.3, M); bin_t(-44, -64.6, M); bin_t(43, -64.6, M)
    # tram stops: shelter on the south pavement, wait spots on the pavement edge
    for nm, x in (("tram_w", -24.0), ("tram_e", 38.0)):
        T = shelter(nm, x, -75.6, 0.0, M, 0.14, False)
        for k, lx in enumerate((-1.0, 0.0, 1.0)):
            spot("wait", f"{nm}_{k}", x + lx, -74.45, 0, 1)
    tram_tracks(M, -70.0, -54.6, 54.6)
    # string lights and wires across the street
    for x in (-38.0, -10.0, 10.0, 38.0):
        string_lights(x, -63.2, x, -76.8, 6.3, M, 9, 0.9)
    for x0 in (-40.0, -16.0, 16.0):
        p = pole(x0, -66.0, M, 0.14, 8.0, 2)
        q = pole(x0 + 24.0, -66.0, M, 0.14, 8.0, 2)
        wire_span(p, q, M, 0.8)
    # Cafe Court (west pocket)
    wbox(M["walk"], -28, -63, -0.1, -20, -54, 0.145)
    kiosk("kiosk", -24.0, -60.3, M)
    for k, (tx, ty) in enumerate(((-26.8, -56.0), (-21.2, -56.0), (-24.0, -55.2))):
        cafe_table(f"cc{k}", tx, ty, M, M["teal"] if k % 2 == 0 else M["orange"])
    street_tree(M, -27.0, -62.0, 6.0, 0.145, 6); street_tree(M, -21.0, -62.0, 6.0, 0.145, 6)
    spot("chat", "cc_a", -24.0, -57.5, 1, 0)
    # Grocer's Court (east pocket)
    wbox(M["walk"], 22, -63, -0.1, 30, -54, 0.145)
    produce_display(22.6, 29.6, -61.6, M)
    bike_rack(27.0, -56.6, 0.0, M, 0.145, 4)
    for k in range(2):
        bike(26.45 + k * 0.55, -56.6, 0.0, M, 0.145)
    bench_t("gc0", 23.3, -55.5, math.pi / 2 * 0 + face_rot(1, 0), M, 0.145)
    street_tree(M, 22.8, -59.0, 6.0, 0.145, 6); street_tree(M, 29.3, -59.0, 6.0, 0.145, 6)
    spot("chat", "gc_a", 26.0, -58.5, 0, 1)


def gate_zone(M):
    wbox(M["trim"], -6.5, -100.5, 0.14, -5.5, -99.5, 6.0)
    wbox(M["trim"], 5.5, -100.5, 0.14, 6.5, -99.5, 6.0)
    wbox(M["teal"], -6.5, -100.5, 6.0, 6.5, -99.5, 6.8)
    symbol_mesh("gate_sym", 0, -100.55, 6.4, 0.6, 0.02, M["trim"])
    collider("gate_w", -6.5, -100.5, -5.5, -99.5, 0, 6.0)
    collider("gate_e", 5.5, -100.5, 6.5, -99.5, 0, 6.0)
    for s in (1, -1):    # hedge wings and planters flanking the gate
        a, b = sorted((s * 6.6, s * 10.0))
        hedge_b(M, a, -101.0, b, -100.0, 0.14, 1.6, 0.15)
        town_lamp(f"gate_l{s}", s * 4.6, -97.0, M, False)
    for x in (-3.4, 3.4):
        pass
    bike_rack(5.6, -97.5, math.pi / 2, M, 0.14, 4)
    for k in range(3):
        bike(5.3, -96.5 - k * 0.55 + 0.0, math.pi / 2, M, 0.14)
    bench_t("gate0", -5.6, -97.0, face_rot(1, 0), M)
    street_tree(M, -5.4, -81.0, 6.5, 0.14, 7)


# ------------------------------------------------------- Spire district ----
# The N Spire's surroundings (plaza.glb holds the Spire, promenade and forecourt). West: Spire Gardens, a park
# around a fountain plaza, continuing Linden Park to the south. East: Spire Square, a paved square with a cafe
# terrace, drinks kiosk, vending, a NEAR sculpture and bikes. North: a quiet grove behind the towers.
# Paths join the promenade (hedge gaps at y 10-14 / 30-34), the forecourt and the town streets.
SG_C = (-41.5, 22.0)      # Spire Gardens fountain plaza centre
SQ_X0, SQ_X1 = 25.0, 58.5  # Spire Square extent
SQ_Y0, SQ_Y1 = -5.5, 50.0


def sg_path(M, pts, w=2.8, sm=2, z=0.08):
    path_strip(M["path"], smooth(pts, sm), w, z - 0.01, z + 0.03)


def pergola(M, x, y, w, d, rot=0.0, z0=0.08):
    """Timber pergola with a slatted roof and warm string lights; two benches face each other under it."""
    T = tf(x, y, rot)
    for lx in (-w / 2, w / 2):
        for ly in (-d / 2, d / 2):
            obox(M["wood2"], T, lx - 0.1, ly - 0.1, z0, lx + 0.1, ly + 0.1, z0 + 2.7)
    for ly in (-d / 2, d / 2):
        obox(M["wood2"], T, -w / 2 - 0.3, ly - 0.08, z0 + 2.7, w / 2 + 0.3, ly + 0.08, z0 + 2.88)
    for k in range(int(w / 0.5) + 1):
        lx = -w / 2 + k * 0.5
        obox(M["wood"], T, lx - 0.05, -d / 2 - 0.3, z0 + 2.88, lx + 0.05, d / 2 + 0.3, z0 + 2.98)
    a, b = T(-w / 2, 0), T(w / 2, 0)
    string_lights(a[0], a[1], b[0], b[1], z0 + 2.75, M, 6, 0.25)
    for side in (-1, 1):
        bx, by = T(0, side * (d / 2 - 0.6))
        bench_t(f"spire_pergola{side}_{x:.0f}", bx, by, rot + (0 if side < 0 else math.pi), M, z0)
    for lx in (-w / 2, w / 2):
        for ly in (-d / 2, d / 2):
            px, py = T(lx, ly)
            collider(f"pergola{px:.1f}_{py:.1f}", px - 0.12, py - 0.12, px + 0.12, py + 0.12, z0, z0 + 2.7)


def sg_bed(M, name, x0, y0, x1, y1, z=0.08, pal=None):
    """Low stone-edged flower bed (walkers go round it)."""
    wbox(M["stone"], x0, y0, z - 0.02, x1, y1, z + 0.22)
    wbox(M["soil"], x0 + 0.15, y0 + 0.15, z + 0.22, x1 - 0.15, y1 - 0.15, z + 0.25)
    flower_bed(M, x0 + 0.3, y0 + 0.3, x1 - 0.3, y1 - 0.3, z + 0.25, 9, pal)
    collider(name, x0, y0, x1, y1, z - 0.02, z + 0.3)


def sculpture(M, x, y, z0=0.14):
    """NEAR symbol on a stepped plinth, the square's landmark and photo spot."""
    prism(M["stone"], circle(x, y, 2.2, 20), z0 - 0.02, z0 + 0.3)
    prism(M["plinth"], circle(x, y, 1.1, 16), z0 + 0.3, z0 + 1.2)
    wbox(M["trim"], x - 1.2, y - 0.25, z0 + 1.2, x + 1.2, y + 0.25, z0 + 1.35)
    symbol_mesh("sq_sym_a", x, y - 0.2, z0 + 2.75, 2.6, 0.18, M["teal"])
    symbol_mesh("sq_sym_b", x, y + 0.2, z0 + 2.75, 2.6, -0.18, M["teal"])
    ring_ell(M["led"], x, y, 1.1, 1.1, 1.18, 1.18, z0 + 1.2, z0 + 1.26, 20)
    collider("sculpture", x - 1.3, y - 1.3, x + 1.3, y + 1.3, z0, z0 + 4.2)


def sp_hedge(M, name, x0, y0, x1, y1, z=0.08, h=1.1):
    """Leaf-card hedge with a collider (the plaza's box hedges are gone)."""
    x0, x1 = sorted((x0, x1)); y0, y1 = sorted((y0, y1))
    wbox(M["stone"], x0, y0, z - 0.02, x1, y1, z + 0.3)
    wbox(M["hedge_core"], x0 + 0.25, y0 + 0.25, z + 0.3, x1 - 0.25, y1 - 0.25, z + 0.3 + h * 0.45)
    along_x = (x1 - x0) >= (y1 - y0)
    L = (x1 - x0) if along_x else (y1 - y0)
    for i in range(max(1, int(L / 0.7))):
        t = (i + 0.5) / max(1, int(L / 0.7))
        cx, cy = ((x0 + (x1 - x0) * t), (y0 + y1) / 2) if along_x else ((x0 + x1) / 2, y0 + (y1 - y0) * t)
        w = (y1 - y0) if along_x else (x1 - x0)
        leaf_cards(cx, cy, z + 0.3 + h * 0.15, 0.3 if along_x else w * 0.32, w * 0.32 if along_x else 0.3, h * 0.28, 14, 0.85, rt.randint(1, 10 ** 6))
    collider(name, x0, y0, x1, y1, z - 0.02, z + 0.3 + h)


def lawn_dress(M, x0, y0, x1, y1, z, n, keep_out=()):
    """Tufts and a few daisies so lawns are not flat green; skips the given rectangles (paths, plazas)."""
    r = random.Random(int(x0 * 7 + y0 * 13))
    for _ in range(n):
        x, y = r.uniform(x0, x1), r.uniform(y0, y1)
        if any(a <= x <= b and c <= y <= d for a, c, b, d in keep_out):
            continue
        tuft(M, x, y, z, r.uniform(0.25, 0.4), 0.16)
        if r.random() < 0.25:
            flower(M, x + 0.2, y, z, r, M[r.choice(("petal_w", "petal_y"))], 0.6)


def cafe_pavilion(M, x, y, z0):
    """Small glass-fronted cafe on the terrace: mint walls, white roof with an overhang, striped awning, menu board.
    Front faces -y (toward the terrace tables)."""
    w, d, h = 6.0, 3.6, 3.2
    x0, x1, y0, y1 = x - w / 2, x + w / 2, y - d / 2, y + d / 2
    wbox(M["walls"][3], x0, y0 + 0.15, z0, x1, y1, z0 + h)                 # mint walls
    wbox(M["shop"], x0 + 0.4, y0 + 0.1, z0 + 0.25, x1 - 0.4, y0 + 0.16, z0 + h - 0.45)  # glass front
    wbox(M["interior"], x0 + 0.45, y0 + 0.16, z0 + 0.3, x1 - 0.45, y0 + 0.2, z0 + h - 0.5)
    for k in range(5):  # mullions
        mx = x0 + 0.4 + k * (w - 0.8) / 4
        wbox(M["trim"], mx - 0.05, y0 + 0.08, z0 + 0.2, mx + 0.05, y0 + 0.17, z0 + h - 0.4)
    wbox(M["wood"], x0 + 0.5, y0 - 0.35, z0 + 0.95, x1 - 0.5, y0 + 0.1, z0 + 1.05)   # outside counter ledge
    wbox(M["trim"], x0 - 0.5, y0 - 0.6, z0 + h, x1 + 0.5, y1 + 0.3, z0 + h + 0.28)   # roof slab with overhang
    wbox(M["teal"], x0 - 0.5, y0 - 0.62, z0 + h + 0.05, x1 + 0.5, y0 - 0.55, z0 + h + 0.23)
    for s in range(12):  # striped awning
        m = M["teal"] if s % 2 == 0 else M["fabric_cream"]
        ax = x0 + s * w / 12
        hexa(m, [(ax, y0 + 0.1, z0 + h - 0.35), (ax + w / 12, y0 + 0.1, z0 + h - 0.35), (ax + w / 12, y0 - 1.1, z0 + h - 0.75), (ax, y0 - 1.1, z0 + h - 0.75),
                 (ax, y0 + 0.1, z0 + h - 0.3), (ax + w / 12, y0 + 0.1, z0 + h - 0.3), (ax + w / 12, y0 - 1.1, z0 + h - 0.7), (ax, y0 - 1.1, z0 + h - 0.7)])
    wbox(M["dark"], x1 + 0.2, y0 - 0.6, z0, x1 + 0.28, y0 - 0.1, z0 + 1.3)          # chalk menu board
    wbox(M["tealdk"], x1 + 0.15, y0 - 0.65, z0 + 0.35, x1 + 0.2, y0 - 0.05, z0 + 1.25)
    for px in (x0 + 0.3, x1 - 0.3):
        plant_pot(M, px, y0 - 0.45, z0, M["orange"], 0.22, 1.6)
    string_lights(x0 - 0.4, y0 - 1.1, x1 + 0.4, y0 - 1.1, z0 + h - 0.8, M, 7, 0.2)
    collider("cafe_pavilion", x0, y0, x1, y1, z0, z0 + h + 0.3)
    spot("shopdoor", "spire_cafe_door", x, y0 - 0.9, 0, 1)


def spire_edges(M):
    """Leafy hedges along the promenade and forecourt (gaps where paths cross), lawn dressing, backdrop belt."""
    for k, (ya, yb) in enumerate(((8.0, 13.0), (20.0, 25.0), (32.0, 37.0))):  # flower beds on the promenade axis
        sg_bed(M, f"prom_bed{k}", -1.4, ya, 1.4, yb, 0.02, ["petal_w", "petal_p", "petal_l"])  # low: the axis view to the Spire stays open
    for s in (1, -1):
        xa, xb = sorted((s * 22.0, s * 24.0))
        for k, (ya, yb) in enumerate(((-6.0, 10.0), (14.0, 30.0), (34.0, 44.0))):
            sp_hedge(M, f"prom_hedge{s}_{k}", xa, ya, xb, yb, 0.02)
        xa, xb = sorted((s * 17.0, s * 31.0))
        sp_hedge(M, f"fore_hedge{s}", xa, 47.0, xb, 48.4, 0.03)
    sp_hedge(M, "district_e", 58.6, -5.5, 59.6, 50.0, 0.14)  # the district's outer edges are planted, not cut off
    sp_hedge(M, "district_w", -59.6, -2.0, -58.6, 50.0, 0.08)
    lawn_dress(M, -59.0, -6.0, -24.5, 50.0, 0.08, 700, ((-51, 13, -32, 31), (-57.5, -4, -26.5, -2), (-57.5, 45.5, -26.5, 47.5)))
    # backdrop: tree belt and hills beyond the district edge, so no view ends on a bare field
    r = random.Random(11)
    belt = [(s * r.uniform(62, 70), y + r.uniform(-2, 2)) for y in range(-4, 104, 6) for s in (1, -1)]
    belt += [(s * r.uniform(72, 82), y + r.uniform(-3, 3)) for y in range(0, 104, 9) for s in (1, -1)]
    belt += [(x + r.uniform(-2, 2), r.uniform(98, 106)) for x in range(-66, 67, 7)]
    for x, y in belt:
        h, seed = r.uniform(9, 14), r.randint(1, 10 ** 6)  # drawn even when skipped: the hills below keep their shapes
        if abs(x) < 82 and y > -7:
            continue  # the backdrop streets and terraces stand there now (build_v2_spire_district.py)
        town_tree(x, y, -0.05, h, seed, 5)
    for k in range(18):
        a = math.radians(-15 + 210 * k / 17)
        rr = r.uniform(115, 150)
        x, y = math.cos(a) * rr * 1.1, 45 + math.sin(a) * rr * 0.7
        bm = bmesh.new()
        bmesh.ops.create_icosphere(bm, subdivisions=3, radius=1.0)
        bmesh.ops.scale(bm, vec=(r.uniform(26, 40), r.uniform(18, 28), r.uniform(14, 26)), verts=bm.verts)
        bmesh.ops.translate(bm, verts=bm.verts, vec=(x, y, -6))
        h = mesh_obj(f"hill_n{k}", bm, M["hill"] if k % 3 else M["hill2"])
        for p in h.data.polygons:
            p.use_smooth = True


def spire_gardens(M):
    z = 0.08
    X0, X1, Y0, Y1 = -59.0, -24.5, -6.0, 50.0
    cx, cy = SG_C
    wbox(M["lawn"], X0, Y0, -0.1, X1, Y1, z)
    # fountain plaza: paved round with a fountain and a ring of benches facing it
    prism(M["path"], circle(cx, cy, 9.0, 32), z - 0.02, 0.14)
    ring_ell(M["brick"], cx, cy, 5.2, 5.2, 6.0, 6.0, 0.14, 0.146, 32)
    ring_ell(M["stone"], cx, cy, 9.0, 9.0, 9.35, 9.35, z - 0.02, 0.17, 32)
    fountain("sg_fountain", cx, cy, 3.6, M)
    for k in range(6):
        a = math.radians(30 + k * 60)
        bx, by = cx + math.cos(a) * 6.6, cy + math.sin(a) * 6.6
        bench_t(f"spire_ring{k}", bx, by, face_rot(cx - bx, cy - by), M)
    for k in range(6):
        a = math.radians(k * 60)
        town_lamp(f"sg_lamp{k}", cx + math.cos(a) * 8.4, cy + math.sin(a) * 8.4, M, banner=False)
    # paths: promenade gaps -> plaza, plaza -> forecourt, plaza -> Linden Park (town), and the jogging loop
    sg_path(M, [(-24.5, 12.0), (-28.0, 13.5), (-32.5, 16.5)], 3.0)
    sg_path(M, [(-24.5, 32.0), (-28.5, 30.5), (-33.0, 27.5)], 3.0)
    sg_path(M, [(cx, cy + 9.0), (cx, 38.0), (-38.0, 45.0), (-34.5, 49.5)], 3.0)
    sg_path(M, [(cx - 6.0, cy - 6.5), (-50.0, 8.0), (-55.0, 0.0), (-57.0, -6.0)], 2.8)
    loop = smooth([(-56.5, -3.0), (-27.5, -3.0), (-27.5, 46.5), (-56.5, 46.5)], 3, closed=True)
    path_strip(M["path"], loop + loop[:2], 2.2, z - 0.01, z + 0.03)
    for k, (px, py) in enumerate(loop[::6]):
        spot("jog", f"spire_loop{k:02d}", px, py, 0, 1)
    # beds and planting in the four lawns between the paths
    pal_warm, pal_cool = ["petal_p", "petal_c", "petal_y"], ["petal_l", "petal_w", "petal_p"]
    sg_bed(M, "sg_bed1", -36.0, 4.0, -29.5, 8.5, z, pal_warm)
    sg_bed(M, "sg_bed2", -53.5, 30.0, -47.0, 34.0, z, pal_cool)
    sg_bed(M, "sg_bed3", -36.5, 34.5, -30.0, 39.0, z, pal_cool)
    sg_bed(M, "sg_bed4", -54.0, 10.0, -48.5, 14.0, z, pal_warm)
    for i, (tx, ty, h) in enumerate([(-31.5, 0.5, 9.5), (-45.0, 4.0, 10.5), (-53.0, 20.5, 9.0), (-52.5, 41.0, 11.0), (-30.5, 22.5, 8.5),
                                     (-44.5, 42.0, 9.5), (-32.5, 43.5, 10.0), (-55.5, 6.5, 8.5), (-38.0, 1.0, 8.0), (-48.5, 26.5, 7.5)]):
        tree(tx, ty, z, h, M, pit=False)
    for sx, sy, r in [(-34.0, 10.0, 0.9), (-29.0, 9.5, 0.8), (-50.0, 35.5, 0.9), (-46.0, 30.0, 0.7), (-37.5, 33.0, 0.8), (-49.5, 15.5, 0.9),
                      (-55.0, 15.0, 0.8), (-33.5, 30.5, 0.7), (-41.0, 5.5, 0.9), (-27.5, 20.0, 0.8)]:
        shrub(M, sx, sy, z, r)
    pergola(M, -49.5, 44.0, 4.4, 3.4, 0.0, z)
    # quiet picnic corner: two benches and a table under the trees
    cafe_table("spire_picnic", -36.0, -0.5, M, None, z, 4)
    town_lamp("sg_lamp_s", -30.0, -1.5, M, banner=False)
    for k, (wx, wy, wdx, wdy) in enumerate([(-36.5, 20.0, 1, 0), (-41.5, 15.0, 0, 1), (-47.0, 23.5, 1, -0.3)]):
        spot("photo", f"spire_fountain{k}", wx, wy, wdx, wdy)


def spire_square(M):
    z = 0.14
    wbox(M["path"], SQ_X0, SQ_Y0, -0.1, SQ_X1, SQ_Y1, z)
    for y in range(-4, 50, 7):  # brick bands give the square a rhythm
        wbox(M["brick"], SQ_X0, y, z, SQ_X1, y + 1.1, z + 0.006)
    for x in (33.0, 50.0):
        wbox(M["brick"], x, SQ_Y0, z, x + 1.1, SQ_Y1, z + 0.006)
    # raised cafe terrace with three steps, cafe kiosk at its back
    tx0, tx1, ty0, ty1 = 38.0, 57.5, 26.0, 40.0
    for i, h in enumerate((0.15, 0.3, 0.45)):
        wbox(M["stone"], tx0 - (2 - i) * 0.45, ty0 - (2 - i) * 0.45, z - 0.02, tx1, ty1, z + h)
        collider(f"terrace{i}", tx0 - (2 - i) * 0.45, ty0 - (2 - i) * 0.45, tx1, ty1, 0, z + h)
    tz = z + 0.45
    wbox(M["stone"], tx0, ty0, tz, tx1, ty1, tz + 0.02)
    sp_hedge(M, "terrace_e", tx1 - 0.9, ty0, tx1, ty1 - 6.0, tz)
    cafe_pavilion(M, 50.5, 36.0, tz)
    for k, (x, y) in enumerate([(40.5, 28.5), (44.5, 28.5), (48.5, 28.5), (41.5, 32.5), (45.5, 32.5), (40.5, 36.5)]):
        cafe_table(f"spire_terrace{k}", x, y, M, M["teal"] if k % 2 else M["orange"], tz, 2)
    railing(tx0, ty1, tx1, ty1, M, tz, 0.95)
    for x in (tx0 + 1.0, tx1 - 1.0):
        plant_pot(M, x, ty0 + 0.6, tz, M["orange"], 0.3, 2.2)
    # drinks kiosk facing the promenade, with a two-place queue
    prop("kiosk_drinks", "sq", 31.5, 8.0, 0.0, 0.14)  # Tripo kiosk, serving window to -y
    collider("sq_kiosk", 29.8, 6.6, 33.2, 9.5, 0, 2.9)
    for k, dy in enumerate((0.0, 1.0)):
        spot("stallq", f"spire_kiosk_{'ab'[k]}", 31.5, 8.0 - 2.9 - dy, 0, 1)
    for k, y in enumerate((13.6, 15.1, 16.6)):  # Tripo vending machines (front faces the square, -x)
        prop("vending_mint", f"sq{k}", 57.6, y, -math.pi / 2, 0.14)
        collider(f"sq_vend{k}", 57.0, y - 0.55, 58.3, y + 0.55, 0, 1.9)
    spot("stallq", "spire_vend_a", 56.0, 15.1, 1, 0)
    # the NEAR sculpture, with places to take a photo of it and of the Spire
    sculpture(M, 42.0, 14.0)
    ring_ell(M["stone"], 42.0, 14.0, 3.6, 3.6, 4.2, 4.2, z - 0.02, z + 0.35, 28)
    collider("sculpture_ring", 37.8, 9.8, 46.2, 18.2, 0, 0.35)
    ring_ell(M["soil"], 42.0, 14.0, 3.7, 3.7, 4.1, 4.1, z + 0.35, z + 0.38, 28)
    for k in range(24):
        a = 2 * math.pi * k / 24
        fx, fy = 42.0 + math.cos(a) * 3.9, 14.0 + math.sin(a) * 3.9
        flower_bed(M, fx - 0.4, fy - 0.4, fx + 0.4, fy + 0.4, z + 0.38, 22, ["petal_p", "petal_y", "petal_w"], True)
    for k, a in enumerate((0.0, math.pi)):
        bx, by = 42.0 + math.cos(a) * 6.0, 14.0 + math.sin(a) * 6.0
        bench_t(f"spire_sculpt{k}", bx, by, face_rot(42.0 - bx, 14.0 - by), M, z)
    for k, (px, py, dx, dy) in enumerate([(42.0, 8.5, 0, 1), (37.5, 11.0, 1, 0.4), (46.0, 9.5, -0.5, 1), (36.0, 20.0, -1, 1.2)]):
        spot("photo", f"spire_sculpture{k}", px, py, dx, dy)
    # trees in round planters on a grid, benches between them
    for x in (29.0, 37.0, 45.0, 53.0):
        for y in (-1.5, 21.0, 45.5):
            if (x, y) in ((45.0, 21.0), (53.0, 21.0)):
                continue
            planter_round(f"sq_pl{x:.0f}_{y:.0f}", x, y, 1.3, M, z)
            tree(x, y, z + 0.5, 8.0, M, pit=False, col=False)
            if y != 21.0:
                bench_t(f"spire_sq{x:.0f}_{y:.0f}", x + 2.6, y, face_rot(0, 1 if y < 20 else -1), M, z)
    for x, y in ((30.5, 26.0), (30.5, 34.0), (35.5, 44.0), (57.0, 2.0), (57.0, 44.0)):
        town_lamp(f"sq_lamp{x:.0f}_{y:.0f}", x, y, M, banner=True)
    # bikes and the city map board by the north edge
    bike_rack(48.0, 47.5, 0.0, M, z, 5)
    for k in range(3):
        bike(46.9 + k * 1.1, 47.5, 0.0, M, z)
    wbox(M["tealdk"], 27.5, 44.0, z, 29.5, 44.3, z + 2.2)
    wbox(M["trim"], 27.6, 43.95, z + 0.9, 29.4, 44.0, z + 2.1)
    collider("mapboard", 27.5, 43.9, 29.5, 44.4, 0, 2.3)
    spot("wait", "spire_map", 28.5, 42.6, 0, 1)
    for k, (x, y, dx, dy) in enumerate([(34.0, 2.0, 0, 1), (51.0, 6.0, -1, 0), (33.0, 30.0, 1, 0)]):
        spot("chat", f"spire_square{k}", x, y, dx, dy)
    for k, (x, y) in enumerate([(56.0, 22.0), (56.0, 24.0)]):
        crate(x, y, 0.0, M, z, 2, "orangef")
        spot("crate", f"spire_cafe{k}", x - 1.0, y, -1, 0)


def spire_grove(M):
    """Behind the towers: tree grove, a path joining the two sides, benches for a quiet lunch."""
    z = 0.08
    wbox(M["lawn"], -59.0, 50.0, -0.1, -34.5, 94.0, z)
    wbox(M["lawn"], 34.5, 50.0, -0.1, 59.0, 94.0, z)
    wbox(M["lawn"], -34.5, 75.5, -0.1, 34.5, 94.0, z)
    sg_path(M, [(-34.5, 60.0), (-40.0, 66.0), (-42.0, 78.0), (-30.0, 84.0), (0.0, 85.5), (30.0, 84.0), (42.0, 78.0), (40.0, 66.0), (34.5, 60.0)], 2.6, 3)
    sg_path(M, [(-42.0, 66.0), (-48.0, 58.0), (-50.0, 50.0)], 2.4)
    sg_path(M, [(42.0, 66.0), (46.0, 58.0), (46.0, 50.0)], 2.4)
    for i, (x, y, h) in enumerate([(-52.0, 60.0, 11), (-47.5, 72.0, 10), (-55.0, 82.0, 12), (-38.5, 90.0, 10), (-20.0, 90.5, 11), (-8.0, 79.5, 9),
                                   (8.0, 79.5, 9), (20.0, 90.5, 11), (38.5, 90.0, 10), (55.0, 82.0, 12), (51.5, 70.0, 10), (52.5, 57.0, 11), (-25.0, 79.0, 9.5), (25.0, 79.0, 9.5)]):
        tree(x, y, z, h, M, pit=False)
    for k, (x, y, r) in enumerate([(-44.0, 62.0, 0.9), (-36.0, 80.0, 0.8), (44.0, 62.0, 0.9), (36.0, 80.0, 0.8), (-12.0, 82.0, 0.8), (12.0, 82.0, 0.8)]):
        shrub(M, x, y, z, r)
    for k, (x, y, fy) in enumerate([(-6.0, 87.3, -1), (6.0, 87.3, -1), (-44.0, 74.0, 0), (44.0, 74.0, 0)]):
        rot = face_rot(0, fy) if fy else face_rot(1 if x < 0 else -1, 0)
        bench_t(f"spire_grove{k}", x, y, rot, M, z)
    sg_bed(M, "gr_bed1", -4.0, 80.0, 4.0, 82.5, z, ["petal_w", "petal_l", "petal_p"])


def outer_ring(M):
    """Tree belt just outside the town limits so no street ends on a bare field."""
    r = random.Random(5)
    spots = []
    for y in range(-8, -104, -6):
        spots += [(-79 - r.uniform(0, 5), y + r.uniform(-2, 2)), (-88 - r.uniform(0, 6), y + r.uniform(-3, 3)), (89 + r.uniform(0, 8), y + r.uniform(-2, 2))]
    for x in range(-74, -52, 5):
        spots.append((x + r.uniform(-1, 1), -4.5 - r.uniform(0, 3)))
    for x in range(-70, 86, 12):
        spots.append((x + r.uniform(-2, 2), -104.5 - r.uniform(0, 6)))
        if abs(x) > 28:
            spots.append((x + r.uniform(-2, 2), -3.5 - r.uniform(0, 4)))
    for x, y in spots:
        if y > -9 and -61 < x < 61:  # the Spire district is laid out there now
            continue
        town_tree(x, y, -0.05, r.uniform(8, 13), r.randint(1, 10 ** 6), 5)


def hills(M):
    """Green hills closing the horizon; far town blocks between the district and the hills."""
    for k in range(34):
        a = math.radians(180 + 180 * k / 33)
        rr = rt.uniform(120, 160)
        x, y = math.cos(a) * rr * 1.1, -40 + math.sin(a) * rr * 0.75
        bm = bmesh.new()
        bmesh.ops.create_icosphere(bm, subdivisions=3, radius=1.0)
        bmesh.ops.scale(bm, vec=(rt.uniform(26, 42), rt.uniform(18, 30), rt.uniform(16, 30)), verts=bm.verts)
        bmesh.ops.translate(bm, verts=bm.verts, vec=(x, y, -6))
        h = mesh_obj(f"hill{k}", bm, M["hill"] if k % 3 else M["hill2"])
        for p in h.data.polygons:
            p.use_smooth = True
    for k in range(34):
        a = math.radians(185 + 170 * k / 33)
        rr = rt.uniform(105, 120)
        x, y = math.cos(a) * rr, -40 + math.sin(a) * rr * 0.7
        w, d, h = rt.uniform(6, 12), rt.uniform(6, 10), rt.uniform(6, 16)
        wbox(rt.choice(M["walls"]), x - w / 2, y - d / 2, 0, x + w / 2, y + d / 2, h)
        wbox(M["teal"] if k % 2 else M["roof"], x - w / 2 - 0.2, y - d / 2 - 0.2, h, x + w / 2 + 0.2, y + d / 2 + 0.2, h + 0.5)
        for z in range(1, int(h / 3.2)):
            wbox(M["win"], x - w / 2 + 0.8, y - d / 2 - 0.05, z * 3.2, x + w / 2 - 0.8, y - d / 2, z * 3.2 + 1.4)


# ---------------------------------------------------------------- layout ----
def town(M):
    global symbol_outline
    if not getattr(symbol_outline, 'cheap', False):
        _so = symbol_outline
        symbol_outline = lambda samples=2: _so(samples)
        symbol_outline.cheap = True
    nodes, arm_s = build_lanes()
    wbox(M["grass"], -110, -125, -0.25, 110, -6, -0.03)
    wbox(M["walk"], -76, -100, -0.15, 85, -6, -0.005)
    # ---- roads, pavements, markings
    h_street(M, -70, -58, 58, 4, 3, [(-58, -45), (-4, 4), (44, 58)], [(-58, -51), (-4, 4), (51, 58)], [(-70, -43), (-5.5, 5.5), (42, 70)])
    v_street(M, -48, -70, -14, 3, 2.5, [(-70, -63), (-19.5, -14)], [(-70, -63), (-19.5, -14)], [(-70, -60), (-24, -14)])
    v_street(M, 47, -70, -14, 3, 2.5, [(-70, -63), (-19.5, -14)], [(-70, -63), (-19.5, -14)], [(-70, -60), (-24, -14)])
    v_street(M, 0, -24, -6, 4, 3, [], [], [(-24, -22), (-8, -6)])
    v_street(M, 0, -100, -54, 4, 3, [(-92, -86), (-77, -63)], [(-92, -86), (-77, -63)], [(-77.5, -62.5), (-100, -83.5)])
    h_street(M, -89, -70, -4, 3, 2.5, [(-70, -64.5), (-7, -4)], [(-70, -64.5), (-7, -4), (-62.2, -47.8), (-42.2, -27.8)], [(-70, -63), (-9, -4)])
    h_street(M, -89, 4, 56, 3, 2.5, [(4, 7), (50.5, 56)], [(4, 7), (50.5, 56), (37.8, 50.2)], [(4, 9), (49, 56)])
    bulb(M, -58, -70, 7, 2.6, (1, 0), 4, 10.2, "isl_cw")
    bulb(M, 58, -70, 7, 2.6, (-1, 0), 4, 10.2, "isl_ce")
    bulb(M, -48, -14, 5.5, 2.0, (0, -1), 3, 8.5, "isl_wl")
    bulb(M, 47, -14, 5.5, 2.0, (0, -1), 3, 8.5, "isl_el")
    bulb(M, -70, -89, 5.5, 2.0, (1, 0), 3, 8.5, "isl_pw")
    bulb(M, 56, -89, 5.5, 2.0, (-1, 0), 3, 8.5, "isl_fe")
    half_of = {}
    for nid, n in nodes.items():
        for d in n["arms"]:
            half_of[(nid, d)] = 3.0 if ((nid in ("jb", "jc") and d == (0, 1)) or (nid == "jd" and d in ((-1, 0), (1, 0)))) else 4.0
    junction_marks(M, nodes, arm_s, half_of)
    zebra(M, (0, -59.5), (0, 1), 0, 3.0, 3.4)
    zebra(M, (0, -22.0), (0, 1), 0, 3.0, 3.4)
    # ---- civic slab (square, west verge, East Court) and Market Square
    wbox(M["brick"], -42.5, -54, -0.1, 41.5, -24, 0.14)
    market_square(M)
    community_hall(M)
    for y in (-23.4, -54.6):
        for x in (-5.0, -3.0, 3.0, 5.0):
            bollard(f"boll{x}_{y}", x, y, M, 0.14)
    # landmarks are placed at runtime on these empties (agent B builds the GLBs)
    empty("LANDMARK_intents_exchange", (-31.0, -39.0, 0.0), math.pi / 2)
    empty("LANDMARK_ai_lab", (75.0, -70.0, 0.0), -math.pi / 2)
    for y in (-30.0, -48.0):   # verge behind the Intents Exchange
        street_tree(M, -41.3, y, 6.5, 0.14, 7)
    # ---- building rows
    for i, y in enumerate((-12.0, -20.0)):   # Tripo corner shops, awnings to the avenue
        prop("shop_corner", f"av_e{i}", 7.0 + 3.9, y, -math.pi / 2)
        collider(f"shop_av_e{i}", 7.0, y - 4.0, 7.0 + 7.8, y + 4.0, 0, 7.2)
    terrace_y("av_w", -24, -6.5, -7.0, 10.0, "E", M, (3, 4), first="S")
    hedge_b(M, 7.0, -8.0, 14.8, -6.4, 0.14, 1.2, 0.1)
    terrace("sqn_w", -27.5, -17.0, -24.0, 9.0, "S", M, (2, 3), alley_every=0)
    terrace("sqn_e", 14.8, 41.5, -24.0, 9.0, "S", M, (2, 3), alley_every=0, last="E")
    terrace("north_w", -27.5, -17.0, -6.0, 9.0, "N", M, (2, 3), alley_every=0)
    terrace("north_e", 14.8, 41.5, -6.0, 9.0, "N", M, (3, 4), alley_every=0, last="E")
    terrace_y("lc", -27, -6.5, -42.5, 15.0, "W", M, (3, 4), first="S", last="N", balc=0.7, widths=(6.5, 7.0, 7.5))
    terrace("mid_w1", -42.5, -28, -63, 9.0, "S", M, (2, 3), alley_every=2, rear="shop", first="W", last="E")
    terrace("mid_w2", -20, -7.0, -63, 9.0, "S", M, (2, 3), alley_every=2, rear="shop", first="W", last="E")
    terrace("mid_e1", 7.0, 22.0, -63, 9.0, "S", M, (2, 3), alley_every=2, rear="shop", first="W", last="E")
    terrace("mid_e2", 30.0, 41.5, -63, 9.0, "S", M, (2, 3), alley_every=0, rear="shop", first="W", last="E")
    terrace("cafe_w", -76, -7.0, -77.0, 6.5, "N", M, (2, 3), alley_every=3, rear="resi", last="E")
    terrace("cafe_e", 7.0, 64.0, -77.0, 6.5, "N", M, (2, 3), alley_every=3, rear="ind", first="W")
    terrace("plum_s", -76, -7.0, -95.0, 5.0, "N", M, (2, 3), style="resi", alley_every=0, last="E", widths=(5.5, 6.0, 6.5), gaps=[(-62, -48), (-42, -28)])
    terrace("fnd_s", 7.0, 50.5, -95.0, 5.0, "N", M, (1, 2), style="ind", alley_every=0, gaps=[(22, 36), (38, 50)], first="W", widths=(7.2, 7.2, 10.8))
    building("lab_annex", 66.0, -100.0, 84.5, -86.0, "N", 3, M, M["walls"][1], "modern", accent=M["teal"], rnd=rt)
    # West Lane / East Lane dressing, bulbs
    for y in (-30.0, -46.0, -58.0):
        street_tree(M, -43.8, y, 6.5, 0.14, 7)
    for y in (-30.0, -48.0, -58.0):
        street_tree(M, 42.8, y, 6.5, 0.14, 7)
    for y in (-30.0, -46.0):
        street_tree(M, 51.3, y, 6.5, 0.14, 7)
    for y in (-26.0, -40.0, -56.0):
        town_lamp(f"wl_l{y}", -52.4, y, M, False); town_lamp(f"el_l{y}", 52.2, y, M, False)
    for y in (-38.0, -54.0):
        bench_t(f"wl_b{y}", -52.4, y, face_rot(1, 0), M, 0.14)
    for k, (ex, ey) in enumerate(((-48, -14), (47, -14), (-70, -89), (56, -89), (-58, -70), (58, -70))):
        town_tree(ex, ey, 0.26, 5.5, 3000 + k, 6)
    # avenue dressing
    for y in (-12, -20, -56.5, -79.0, -96.0):
        for s in (1, -1):
            if not (y == -96.0 and s == 1):
                town_lamp(f"lamp_av{s}_{y}", s * 4.6, y, M, True if y in (-12, -20) else False)
    for s in (1, -1):
        for y in (-15.5, -22.0):
            street_tree(M, s * 5.4, y, 6.5, 0.14, 7)
        street_tree(M, s * 5.4, -59.0, 6.5, 0.14, 7)
    cafe_dress(M)
    crate_yard(M)
    plum_dress(M)
    lots(M)
    foundry_dress(M)
    gate_zone(M)
    park(M)
    innovation(M)
    collider("bound_s", -100, -101.5, 100, -100.5, 0, 8)
    collider("bound_w", -77, -101, -76, -6, 0, 8)
    collider("bound_e", 85, -101, 86, -6, 0, 8)
    # The town opens north into the Spire district (Spire Gardens west, Spire Square east).
    collider("bound_nw", -76, -7, -60, -6, 0, 8)
    collider("bound_ne", 59, -7, 85, -6, 0, 8)
    spire_gardens(M)
    spire_square(M)
    spire_district(M)  # Demo Day Lawn, Builders' Yard, Mango Orchard, Spire Station, Harbor Depot
    spire_edges(M)
    outer_ring(M)
    hills(M)
    empty("SPAWN_TOWN", (0.0, -95.0, 0.14), 0.0)


def reset():
    sc = bpy.data.scenes.get("V2Town")
    if sc:
        for o in list(sc.objects):
            bpy.data.objects.remove(o)
    else:
        sc = bpy.data.scenes.new("V2Town")
    bpy.context.window.scene = sc
    for me in [me for me in bpy.data.meshes if me.users == 0]:
        bpy.data.meshes.remove(me)
    return sc


def build():
    global TREE_MATS
    reset()
    BATCH.clear(); LANES.clear(); PARKING.clear(); SPOTS.clear()
    M = town_materials()
    bark, leaves = tree_materials()
    leaves.name = "v2_leaves__tint_c8f58c"
    TREE_MATS = (bark, leaves)
    town(M)
    flush()
    join_objects(["tree_"], "TOWN_trees")
    small = [o.name for o in bpy.context.scene.objects if o.type == "MESH" and not o.name.startswith(("COL_", "TOWN_", "hill"))]
    join_objects(small, "TOWN_props") if small else None
    join_objects(["hill"], "TOWN_hills")
    write_roads()
    print("spots", dict(SPOTS), "total", sum(SPOTS.values()))
    stats()


exec(open(r"C:/Bunnyy/Hackathons/NEAR/blender/build_v2_spire_district.py").read())  # the district behind and beside the Spire
