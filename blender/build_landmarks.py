"""VIVOLITH landmarks: NEAR AI Lab (Innovation District) and NEAR Intents Exchange (Market Square).
Exports public/models/v2/landmarks/ai_lab.glb and intents_exchange.glb. Headless:

  blender -b --factory-startup --python-expr "exec(open(r'<this file>').read()); build_ai_lab(); export('ai_lab')"

Local frame: origin = ground centre of the footprint, front = Blender -Y (three.js +Z), real metres.
Geometry is merged into one object per material (few draw calls). COL_* boxes ship in the GLB.
Logos: official SVGs in public/brand (NEAR AI wordmark/tile from near.ai/brand, NEAR Intents icon from
defuse-protocol/defuse-frontend) imported as real curves -> extruded mesh; lettering = real font outlines.
These are fictional in-game buildings that use the marks; they are not official NEAR offices.
"""
import bpy, bmesh, math, random, pathlib
from mathutils import Vector, Matrix

exec(open(r"blender/build_spire.py").read())  # street library + procedural_tree/tree_materials (overridden helpers below)

LM_OUT = REPO / "public" / "models" / "v2" / "landmarks"
BRAND_DIR = REPO / "public" / "brand"
FONT = r"C:/Windows/Fonts/segoeuib.ttf"


# ============================================================ geometry ====
class Geo:
    """Per-material bmesh buckets."""
    def __init__(self):
        self.bms = {}

    def bm(self, k):
        if k not in self.bms:
            self.bms[k] = bmesh.new()
        return self.bms[k]


def _cube(bm, tf):
    vs = bmesh.ops.create_cube(bm, size=1.0)["verts"]
    for v in vs:
        v.co = tf(v.co.copy())
    return vs


def _bevel(bm, vs, b):
    bmesh.ops.bevel(bm, geom=list({e for v in vs for e in v.link_edges}) + vs, offset=b, segments=2, affect="EDGES")


def box(G, k, x0, y0, z0, x1, y1, z1, bev=0.0):
    bm = G.bm(k)
    vs = _cube(bm, lambda c: Vector((x0 + (c.x + .5) * (x1 - x0), y0 + (c.y + .5) * (y1 - y0), z0 + (c.z + .5) * (z1 - z0))))
    if bev > 0:
        _bevel(bm, vs, min(bev, (x1 - x0) / 2.3, (y1 - y0) / 2.3, (z1 - z0) / 2.3))


def obox(G, k, cx, cy, ang, sx, sy, z0, z1, bev=0.0):
    """Box rotated about z by ang; sx along the direction ang, sy across."""
    R = Matrix.Rotation(ang, 3, "Z")
    bm = G.bm(k)
    vs = _cube(bm, lambda c: R @ Vector((c.x * sx, c.y * sy, 0)) + Vector((cx, cy, (z0 + z1) / 2 + c.z * (z1 - z0))))
    if bev > 0:
        _bevel(bm, vs, min(bev, sx / 2.3, sy / 2.3, (z1 - z0) / 2.3))


def beam(G, k, p0, p1, w, h=None):
    h = h or w
    p0, p1 = Vector(p0), Vector(p1)
    d = p1 - p0
    q = Vector((1, 0, 0)).rotation_difference(d.normalized())
    mid = (p0 + p1) / 2
    _cube(G.bm(k), lambda c: q @ Vector((c.x * d.length, c.y * w, c.z * h)) + mid)


def prism(G, k, outline, z0, z1, smooth=False, caps=True):
    bm = G.bm(k)
    n = len(outline)
    lo = [bm.verts.new((x, y, z0)) for x, y in outline]
    hi = [bm.verts.new((x, y, z1)) for x, y in outline]
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new((lo[i], lo[j], hi[j], hi[i])).smooth = smooth
    if caps:
        bm.faces.new([bm.verts.new((x, y, z1)) for x, y in outline])
        bm.faces.new([bm.verts.new((x, y, z0)) for x, y in reversed(outline)])


def ring_poly(G, k, outer, inner, z0, z1, smooth=False):
    """Closed ring (outer and inner outlines with equal vertex counts)."""
    bm = G.bm(k)
    n = len(outer)
    ot = [bm.verts.new((x, y, z1)) for x, y in outer]
    ob = [bm.verts.new((x, y, z0)) for x, y in outer]
    it = [bm.verts.new((x, y, z1)) for x, y in inner]
    ib = [bm.verts.new((x, y, z0)) for x, y in inner]
    ow = [bm.verts.new((x, y, z0)) for x, y in outer]
    owt = [bm.verts.new((x, y, z1)) for x, y in outer]
    iw = [bm.verts.new((x, y, z0)) for x, y in inner]
    iwt = [bm.verts.new((x, y, z1)) for x, y in inner]
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new((ot[i], ot[j], it[j], it[i]))
        bm.faces.new((ib[j], ib[i], ob[i], ob[j]))
        bm.faces.new((ow[i], ow[j], owt[j], owt[i])).smooth = smooth
        bm.faces.new((iw[j], iw[i], iwt[i], iwt[j])).smooth = smooth


def extrude_xz(G, k, pts, y0, y1):
    """Polygon given in the x-z plane, extruded along y."""
    bm = G.bm(k)
    f0 = [bm.verts.new((x, y0, z)) for x, z in pts]
    f1 = [bm.verts.new((x, y1, z)) for x, z in pts]
    n = len(pts)
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new((f0[i], f0[j], f1[j], f1[i]))
    bm.faces.new(f0)
    bm.faces.new(list(reversed(f1)))


def circle(cx, cy, r, n=24):
    return [(cx + r * math.cos(2 * math.pi * i / n), cy + r * math.sin(2 * math.pi * i / n)) for i in range(n)]


def cyl(G, k, x, y, z0, z1, r, n=14, smooth=True):
    prism(G, k, circle(x, y, r, n), z0, z1, smooth=smooth)


def arch(cx, zb, rx, rz, n=18):
    """Points left base -> over the top -> right base (x, z)."""
    return [(cx + rx * math.cos(math.pi - math.pi * i / n), zb + rz * math.sin(math.pi - math.pi * i / n)) for i in range(n + 1)]


def arch_band(G, k, cx, zb, rx0, rz0, rx1, rz1, y0, y1, n=18):
    """Arch-shaped band between outer (rx1, rz1) and inner (rx0, rz0) half-ellipses."""
    extrude_xz(G, k, arch(cx, zb, rx1, rz1, n) + arch(cx, zb, rx0, rz0, n)[::-1], y0, y1)


def annulus(G, k, M, r0, r1, th, n=36):
    """Flat ring around local z (thickness th), placed by matrix M (3x3 rot + translation via 4x4)."""
    bm = G.bm(k)
    rings = []
    for r in (r1, r0):
        for z in (th / 2, -th / 2):
            rings.append([bm.verts.new(M @ Vector((r * math.cos(2 * math.pi * i / n), r * math.sin(2 * math.pi * i / n), z))) for i in range(n)])
    ot, ob, it, ib = rings
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new((ot[i], ot[j], it[j], it[i]))
        bm.faces.new((ib[i], ib[j], ob[j], ob[i]))
        bm.faces.new((ob[i], ob[j], ot[j], ot[i]))
        bm.faces.new((it[i], it[j], ib[j], ib[i]))


def blob(G, k, c, r, seed, sub=1, squash=1.0):
    bm = G.bm(k)
    rnd = random.Random(seed)
    vs = bmesh.ops.create_icosphere(bm, subdivisions=sub, radius=r)["verts"]
    for v in vs:
        v.co = Vector((v.co.x, v.co.y, v.co.z * squash)) + Vector(c) + Vector((rnd.uniform(-1, 1), rnd.uniform(-1, 1), rnd.uniform(-1, 1))) * r * 0.1
    for f in {f for v in vs for f in v.link_faces}:
        f.smooth = True


def round_poly(pts, r, seg=4):
    n = len(pts)
    out = []
    for i in range(n):
        p, a, b = Vector(pts[i]), Vector(pts[i - 1]), Vector(pts[(i + 1) % n])
        da, db = a - p, b - p
        rr = min(r, da.length / 2, db.length / 2)
        p0, p1 = p + da.normalized() * rr, p + db.normalized() * rr
        for s in range(seg + 1):
            t = s / seg
            q = (1 - t) ** 2 * p0 + 2 * t * (1 - t) * p + t * t * p1
            out.append((q.x, q.y))
    return out


def rect(x0, y0, x1, y1, m=0.0):
    return [(x0 - m, y0 - m), (x1 + m, y0 - m), (x1 + m, y1 + m), (x0 - m, y1 + m)]


def step_poly(xa, xb, xc, ys, yf, yb, m=0.0):
    """Block x[xa..xc], y[ys..yb] with its front pushed out to yf for x >= xb."""
    return [(xa - m, ys - m), (xb - m, ys - m), (xb - m, yf - m), (xc + m, yf - m), (xc + m, yb + m), (xa - m, yb + m)]


def offset(outline, d):
    n = len(outline)
    out = []
    for i in range(n):
        p0, p1, p2 = Vector(outline[i - 1]), Vector(outline[i]), Vector(outline[(i + 1) % n])
        n0 = Vector(((p1 - p0).y, -(p1 - p0).x)).normalized()
        n1 = Vector(((p2 - p1).y, -(p2 - p1).x)).normalized()
        nn = (n0 + n1).normalized()
        out.append(tuple(p1 + nn * d / max(0.5, nn.dot(n0))))
    return out


def densify(poly, step):
    out = []
    n = len(poly)
    for i in range(n):
        a, b = Vector(poly[i]), Vector(poly[(i + 1) % n])
        k = max(1, math.ceil((b - a).length / step))
        out += [tuple(a.lerp(b, s / k)) for s in range(k)]
    return out


def along(poly, step, margin=0.5, sel=None, phase=0.0):
    """Yield (point, outward normal) at even spacing on every straight run of a CCW outline."""
    n = len(poly)
    for i in range(n):
        a, b = Vector(poly[i]), Vector(poly[(i + 1) % n])
        d = b - a
        L = d.length
        if L < margin * 2 + 0.3:
            continue
        d /= L
        nrm = Vector((d.y, -d.x))
        cnt = int((L - 2 * margin) // step) + 1 - (1 if phase else 0)
        t0 = (L - (cnt - 1) * step) / 2 + phase * step
        for j in range(max(cnt, 0)):
            p = a + d * (t0 + j * step)
            if sel is None or sel(p, nrm):
                yield p, nrm


def panels_on(G, k, poly, step, w, depth, z0, z1, margin=0.5, sel=None, bev=0.0, inset=0.0, phase=0.0, seed=1, prob=1.0):
    rnd = random.Random(seed)
    for p, nrm in along(poly, step, margin, sel, phase):
        if rnd.random() > prob:
            continue
        c = p + nrm * (depth / 2 - inset)
        obox(G, rnd.choice(k) if isinstance(k, (list, tuple)) else k, c.x, c.y, math.atan2(nrm.y, nrm.x), depth, w, z0, z1, bev)


def slab(G, polyfn, r, z0, z1, k="white", led="led"):
    prism(G, k, round_poly(polyfn(0), r), z0, z1)
    prism(G, led, round_poly(polyfn(0.035), r + 0.035), z0 + (z1 - z0) * 0.3, z0 + (z1 - z0) * 0.62, caps=False)


def glass_dress(G, poly, z0, z1, floor, sel=None, seed=0):
    """Sky-reflection bands, slim transoms and lit interior panels so the glass reads as glass."""
    z, i = z0, 0
    while z + floor <= z1 + 0.01:
        prism(G, "glass_hi", offset(poly, 0.03), z + floor * 0.6, z + floor * 0.94, caps=False)
        if z + floor < z1 - 0.05:
            prism(G, "white", offset(poly, 0.12), z + floor - 0.06, z + floor + 0.06, caps=False)
        panels_on(G, "glass_lit", poly, 1.5, 1.1, 0.05, z + 0.3, z + floor * 0.55, sel=sel, phase=0.5, prob=0.4, seed=seed + i)
        z += floor
        i += 1


def rail_poly(G, poly, z, sel=None, glass="glass_hi", bar="white", h=1.05):
    pts = densify(poly, 2.2)
    n = len(pts)
    for i in range(n):
        a, b = Vector(pts[i]), Vector(pts[(i + 1) % n])
        mid = (a + b) / 2
        if sel and not sel(mid):
            continue
        d = b - a
        ang = math.atan2(d.y, d.x)
        obox(G, glass, mid.x, mid.y, ang, d.length + 0.02, 0.05, z + 0.1, z + h)
        obox(G, bar, mid.x, mid.y, ang, d.length + 0.02, 0.1, z + h, z + h + 0.05)
        box(G, bar, a.x - 0.04, a.y - 0.04, z, a.x + 0.04, a.y + 0.04, z + h + 0.05)


FOL = {"bm": None, "mats": None}


def fol_bm():
    if FOL["bm"] is None:
        FOL["bm"] = bmesh.new()
        FOL["bm"].loops.layers.uv.verify()
    return FOL["bm"]


def tree_mats():
    """Bark + alpha-tested leaf cards (CC0 jacaranda textures, same convention as the plaza trees)."""
    if FOL["mats"] is None:
        bark, leaves = tree_materials()
        leaves.name = "lm_leaves__tint_c8f58c"
        FOL["mats"] = (bark, leaves)
    return FOL["mats"]


def leaf_card(c, size, rnd):
    bm = fol_bm()
    uvl = bm.loops.layers.uv.active
    n = Vector((rnd.uniform(-1, 1), rnd.uniform(-1, 1), rnd.uniform(-0.3, 1))).normalized()
    x = n.orthogonal().normalized()
    y = n.cross(x)
    f = bm.faces.new([bm.verts.new(Vector(c) + (x * sx + y * sy) * size / 2) for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1))])
    for l, uv in zip(f.loops, ((0, 0), (1, 0), (1, 1), (0, 1))):
        l[uvl].uv = uv


def shrub(cx, cy, z, r, seed, n=26):
    rnd = random.Random(seed)
    for _ in range(n):
        leaf_card((cx + rnd.gauss(0, r * 0.45), cy + rnd.gauss(0, r * 0.45), z + abs(rnd.gauss(0, r * 0.4)) + r * 0.15), rnd.uniform(0.55, 0.9), rnd)


def card_tree(G, x, y, z, h, seed):
    """Light tree: tapered trunk + three leaf-card clumps."""
    rnd = random.Random(seed)
    cyl(G, "bark", x, y, z, z + h * 0.55, 0.07 + h * 0.012, 7, False)
    for i in range(3):
        c = (x + rnd.uniform(-1, 1) * h * 0.1, y + rnd.uniform(-1, 1) * h * 0.1, z + h * (0.5 + 0.17 * i))
        for _ in range(34):
            leaf_card((c[0] + rnd.gauss(0, h * 0.11), c[1] + rnd.gauss(0, h * 0.11), c[2] + rnd.gauss(0.05, h * 0.08)), rnd.uniform(0.7, 1.1), rnd)


HERO = []


def hero_tree(x, y, z, h, seed):
    """The game's procedural_tree (branches + leaf cards, ~5k tris)."""
    bm = procedural_tree(seed, h)
    bmesh.ops.rotate(bm, verts=bm.verts, cent=(0, 0, 0), matrix=Matrix.Rotation(seed * 1.3, 3, "Z"))
    bmesh.ops.translate(bm, verts=bm.verts, vec=(x, y, z))
    bark, leaves = tree_mats()
    HERO.append(mesh_obj(f"HT_{len(HERO)}", bm, [bark, leaves]))


def tree(G, x, y, z, h, seed, hero=False):
    (hero_tree(x, y, z, h * 1.25, seed) if hero else card_tree(G, x, y, z, h, seed))


def planter(G, x0, y0, x1, y1, z, h=0.5, hh=0.5, tree_h=0, seed=0, hedge="hedge"):
    box(G, "planter", x0, y0, z, x1, y1, z + h, 0.04)
    box(G, "soil", x0 + 0.1, y0 + 0.1, z + h - 0.02, x1 - 0.1, y1 - 0.1, z + h + 0.05)
    L = max(x1 - x0, y1 - y0)
    k = max(1, int(L / 0.9))
    for i in range(k):
        t = (i + 0.5) / k
        shrub(x0 + (x1 - x0) * (t if x1 - x0 >= y1 - y0 else 0.5), y0 + (y1 - y0) * (t if y1 - y0 > x1 - x0 else 0.5), z + h, 0.5 + hh * 0.3, seed * 31 + i)
    if tree_h:
        tree(G, (x0 + x1) / 2, (y0 + y1) / 2, z + h + 0.05, tree_h, seed, hero=(z == 0))


def vine(G, x, y, ztop, ln, seed):
    rnd = random.Random(seed)
    box(G, "vine", x - 0.03, y - 0.03, ztop - ln, x + 0.03, y + 0.03, ztop)
    for i in range(int(ln / 0.3)):
        leaf_card((x + rnd.uniform(-0.08, 0.08), y + rnd.uniform(-0.08, 0.08), ztop - 0.15 - i * 0.3), rnd.uniform(0.38, 0.55), rnd)


def hang_vines(G, poly, ztop, lo, hi, step, seed, sel=None):
    rnd = random.Random(seed)
    for p, nrm in along(poly, step, 0.8, sel):
        q = p + nrm * 0.06
        vine(G, q.x, q.y, ztop, rnd.uniform(lo, hi), rnd.randint(0, 9999))


# ====================================================== logos and text ====
def _ev_bm(o):
    bpy.context.view_layer.update()
    dg = bpy.context.evaluated_depsgraph_get()
    oe = o.evaluated_get(dg)
    me = oe.to_mesh()
    bm = bmesh.new()
    bm.from_mesh(me)
    bm.transform(o.matrix_world)
    oe.to_mesh_clear()
    return bm


def _place(bm, M, centre):
    """Face -Y (rotate +90 about X so z -> -y, y -> z), then rotate about z, then translate."""
    bm.transform(Matrix.Translation(Vector(centre)) @ M @ Matrix.Rotation(math.pi / 2, 4, "X"))


def _copy_into(bm_src, bm_dst):
    vmap = {v: bm_dst.verts.new(v.co) for v in bm_src.verts}
    for f in bm_src.faces:
        bm_dst.faces.new([vmap[v] for v in f.verts]).smooth = False
    bm_src.free()


def svg_geo(G, svgname, keymap, centre, width, depth, rotz=0.0, lift=None):
    """Import an official SVG as curves, extrude, scale to `width`, face -Y (rotz turns it), classify by fill colour."""
    before = set(bpy.data.objects)
    bpy.ops.import_curve.svg(filepath=str(BRAND_DIR / svgname))
    objs = [o for o in bpy.data.objects if o not in before]
    parts = []
    for o in objs:
        c = o.data.materials[0].diffuse_color if o.data.materials else (0, 0, 0, 1)
        r, g, b = c[0], c[1], c[2]
        cls = "white" if min(r, g, b) > 0.8 else "orange" if (r > 0.5 and b < 0.2) else "blue" if (b > 0.5 and r < 0.2) else "black"
        parts.append((cls, _ev_bm(o)))
    xs = [v.co.x for _, bm in parts for v in bm.verts]
    ys = [v.co.y for _, bm in parts for v in bm.verts]
    s = width / (max(xs) - min(xs))
    cx, cy = (max(xs) + min(xs)) / 2, (max(ys) + min(ys)) / 2
    for i, (cls, bm) in enumerate(parts):
        bm.transform(Matrix.Translation((-cx, -cy, 0)))
        bm.transform(Matrix.Scale(s, 4))
        layer = depth * 0.5 if cls in (lift or ()) else 0.0
        bmesh.ops.solidify(bm, geom=list(bm.faces), thickness=depth * (0.5 if layer else 1.0))
        zs = [v.co.z for v in bm.verts]
        bm.transform(Matrix.Translation((0, 0, -(max(zs) + min(zs)) / 2 + layer)))
        _place(bm, Matrix.Rotation(rotz, 4, "Z"), centre)
        _copy_into(bm, G.bm(keymap[cls]))
    for o in objs:
        data = o.data
        bpy.data.objects.remove(o)
        bpy.data.curves.remove(data)


def text_geo(G, k, txt, centre, width, depth, rotz=0.0, spacing=1.0):
    cu = bpy.data.curves.new("t", "FONT")
    cu.body = txt
    cu.size = 1.0
    cu.extrude = depth / 2
    cu.align_x = cu.align_y = "CENTER"
    cu.space_character = spacing
    cu.font = bpy.data.fonts.load(FONT)
    o = bpy.data.objects.new("t", cu)
    bpy.context.scene.collection.objects.link(o)
    bm = _ev_bm(o)
    bpy.data.objects.remove(o)
    xs = [v.co.x for v in bm.verts]
    bm.transform(Matrix.Scale(width / (max(xs) - min(xs)), 4))
    _place(bm, Matrix.Rotation(rotz, 4, "Z"), centre)
    _copy_into(bm, G.bm(k))


# ================================================================ output ====
def mat_table(prefix, spec):
    M = {}
    for k, (hexc, rough, metal, emit, es) in spec.items():
        m = flat_material(f"lm_{prefix}_{k}", hexc, rough, metal, emit, es)
        m.diffuse_color = (*linear(hexc), 1)
        M[k] = m
    return M


def emit_geo(G, M, name):
    for k, bm in G.bms.items():
        if not bm.faces:
            bm.free()
            continue
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
        me = bpy.data.meshes.new(f"{name}_{k}")
        bm.to_mesh(me)
        bm.free()
        me.materials.append(M[k])
        o = bpy.data.objects.new(f"{name}_{k}", me)
        bpy.context.scene.collection.objects.link(o)


def emit_foliage():
    bm = FOL["bm"]
    if bm is None or not bm.faces:
        return
    me = bpy.data.meshes.new("FOLIAGE")
    bm.to_mesh(me)
    bm.free()
    me.materials.append(tree_mats()[1])
    bpy.context.scene.collection.objects.link(bpy.data.objects.new("FOLIAGE", me))
    FOL["bm"] = None


def clear():
    HERO.clear()
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o)
    for me in [m for m in bpy.data.meshes if m.users == 0]:
        bpy.data.meshes.remove(me)


def tri_count():
    t = 0
    for o in bpy.context.scene.objects:
        if o.type == "MESH" and not o.name.startswith("COL_"):
            t += sum(len(p.vertices) - 2 for p in o.data.polygons)
    print("TRIS", t)


def export(name):
    LM_OUT.mkdir(parents=True, exist_ok=True)
    out = LM_OUT / f"{name}.glb"
    with quiet():
        bpy.ops.export_scene.gltf(
            filepath=str(out), export_format="GLB", use_active_scene=True, export_apply=True, export_image_format="WEBP",
            export_draco_mesh_compression_enable=True, export_draco_mesh_compression_level=6,
            export_lights=False, export_cameras=False,
        )
    print("exported", out.name, round(out.stat().st_size / 1e6, 2), "MB")


# ================================================================ AI Lab ====
AI_MATS = {
    "white": ("f4f6f3", 0.55, 0.05, None, 0), "stone": ("d8d3c6", 0.7, 0, None, 0), "wood": ("c48a50", 0.6, 0, None, 0),
    "glass": ("6cc4f0", 0.08, 0.35, None, 0), "glass_dk": ("3f86c0", 0.1, 0.4, None, 0),
    "glass_hi": ("c9ecfb", 0.1, 0.2, None, 0), "glass_lit": ("ffe2ad", 0.4, 0, "ffd99a", 1.2),
    "led": ("0091fd", 0.2, 0, "0091fd", 2.2), "ledg": ("00ec97", 0.2, 0, "00ec97", 4.0), "orb": ("e8f6ff", 0.3, 0, "9fd8ff", 3.0),
    "ink": ("1d2530", 0.5, 0.2, None, 0), "gold": ("ffd27a", 0.3, 0, "ffc457", 1.6), "planter": ("ece8e1", 0.6, 0, None, 0),
    "leaf": ("5cc44a", 0.85, 0, None, 0), "leaf2": ("8fdb5c", 0.85, 0, None, 0), "hedge": ("3f9e3c", 0.9, 0, None, 0),
    "vine": ("48a838", 0.9, 0, None, 0), "soil": ("5a4331", 0.95, 0, None, 0), "bark": ("7a5a3c", 0.9, 0, None, 0), "grass": ("7fb85a", 0.95, 0, None, 0),
}


def build_ai_lab():
    clear()
    G, M = Geo(), mat_table("ai", AI_MATS)
    P = 0.8
    Z0, Z1 = P, 7.0          # lobby wings
    ZS0 = (7.0, 7.6)         # slab 0
    ZV1 = (7.6, 12.9)
    ZS1 = (12.9, 13.5)
    ZV2 = (13.5, 18.4)
    ZS2 = (18.4, 19.0)
    ZV3 = (19.0, 22.6)
    ZS3 = (22.6, 23.2)

    # plinth + wide entrance steps with glowing risers
    box(G, "stone", -15, -7.3, 0, 15, 10, P, 0.08)
    box(G, "white", -7.4, -9.9, 0, 7.4, -8.6, 0.4, 0.05)
    box(G, "white", -7.4, -8.6, 0, 7.4, -7.3, 0.8, 0.05)
    box(G, "gold", -7.3, -9.93, 0.1, 7.3, -9.9, 0.3)
    box(G, "gold", -7.3, -8.63, 0.5, 7.3, -8.6, 0.7)

    # lobby wings (rounded plan), core and the recessed entrance loggia
    for x0, x1 in ((-14, -3.6), (3.6, 14)):
        w = round_poly(rect(x0, -6, x1, 9), 1.6)
        prism(G, "glass", w, Z0, Z1)
        glass_dress(G, w, Z0, Z1, 3.1, seed=5)
        prism(G, "stone", offset(w, 0.12), Z0, Z0 + 0.45)
        prism(G, "white", offset(w, 0.1), 3.5, 3.66, caps=False)
        panels_on(G, "white", w, 1.5, 0.18, 0.5, Z0 + 0.45, Z1)
        panels_on(G, "glass_dk", w, 1.5, 0.5, 0.06, 1.6, 3.4, phase=0.5)
    box(G, "glass", -13.8, 1.5, Z0, 13.8, 9.0, Z1)
    box(G, "glass_lit", -3.6, 1.38, Z0, 3.6, 1.5, 6.9)
    for x in (-3.5, -1.75, 0, 1.75, 3.5):
        box(G, "ink", x - 0.06, 1.28, Z0, x + 0.06, 1.4, 5.6)
    box(G, "ink", -3.6, 1.28, 5.5, 3.6, 1.4, 5.64)
    cyl(G, "glass_hi", 0, -0.2, Z0, 4.8, 1.4, 16)
    cyl(G, "ink", 0, -0.2, 4.8, 4.95, 1.5, 16)
    for a in (0, 60, 120):
        obox(G, "ink", 0, -0.2, math.radians(a), 2.8, 0.06, Z0, 4.8)
    for x in (-2.4, 0, 2.4):
        box(G, "led", x - 0.07, -6.0, 6.93, x + 0.07, 1.3, 7.0)
    # NEAR AI tile marks on the inner loggia walls (rotz +90: faces +x, -90: faces -x)
    svg_geo(G, "nearai-tile-color.svg", {"blue": "led", "white": "white", "black": "ink", "orange": "gold"}, (-3.55, -2.4, 3.9), 2.3, 0.08, rotz=math.pi / 2, lift=("white",))
    svg_geo(G, "nearai-tile-color.svg", {"blue": "led", "white": "white", "black": "ink", "orange": "gold"}, (3.55, -2.4, 3.9), 2.3, 0.08, rotz=-math.pi / 2, lift=("white",))

    # slabs
    s0 = lambda m: step_poly(-14, -6, 14, -6, -8.5, 9, 0.6 + m)
    s1 = lambda m: step_poly(-11, -6, 14, -3, -8.5, 9.2, 0.6 + m) if False else [
        (-11 - m, -3 - m), (-6 - m, -3 - m), (-6 - m, -8.5 - m), (14 + m, -8.5 - m), (14 + m, 9.2 + m), (-11 - m, 9.2 + m)]
    slab(G, s0, 1.8, *ZS0)
    # V1: cantilevered glass volume over the entrance, wordmark band on its front
    v1 = round_poly(rect(-6, -8.5, 14, 9.2), 1.4)
    prism(G, "glass", v1, *ZV1)
    glass_dress(G, v1, ZV1[0] + 2.3, ZV1[1], 2.65, seed=15)
    front = lambda p, n: n.y < -0.5
    panels_on(G, "white", v1, 1.5, 0.18, 0.5, 9.9, ZV1[1], sel=front)
    panels_on(G, "white", v1, 1.5, 0.18, 0.5, ZV1[0], ZV1[1], sel=lambda p, n: n.y >= -0.5)
    box(G, "white", -5.7, -8.64, ZV1[0], 13.7, -8.5, 9.9, 0.05)
    box(G, "led", -5.7, -8.68, 9.82, 13.7, -8.64, 9.9)
    box(G, "led", -5.7, -8.68, ZV1[0], 13.7, -8.64, ZV1[0] + 0.08)
    # Wordmark on the entrance axis (x 0), not the band's middle (x 4): in town the band's right end (x > 7, behind
    # the next block on the street) is hidden, so a sign centred at x 4 lost "AI" behind it. x 0 is also the middle of
    # the band's visible part (-5.7 .. ~7).
    svg_geo(G, "nearai-primary-color.svg", {"blue": "led", "black": "ink", "white": "white", "orange": "gold"}, (0.0, -8.71, 8.75), 8.2, 0.14)
    slab(G, s1, 1.8, *ZS1)
    for x, y in ((-10.4, -2.3), (-10.4, 8.4)):  # pilotis under the overhanging upper volume
        cyl(G, "white", x, y, ZS0[1], ZS1[0], 0.3, 14)
    # V2
    v2 = round_poly(rect(-11, -3, 5, 9.2), 1.4)
    prism(G, "glass", v2, *ZV2)
    glass_dress(G, v2, ZV2[0], ZV2[1], 2.45, seed=25)
    panels_on(G, "white", v2, 1.5, 0.18, 0.5, *ZV2)
    prism(G, "white", offset(v2, 0.1), 15.8, 15.96, caps=False)
    slab(G, lambda m: [(-11 - m, -3 - m), (5 + m, -3 - m), (5 + m, 9.2 + m), (-11 - m, 9.2 + m)], 1.6, *ZS2)
    # V3
    v3 = round_poly(rect(-5, 0, 5, 9.2), 1.3)
    prism(G, "glass_dk", v3, *ZV3)
    glass_dress(G, v3, ZV3[0], ZV3[1], 3.6, seed=35)
    panels_on(G, "white", v3, 1.2, 0.16, 0.9, *ZV3, sel=front, bev=0.03)
    panels_on(G, "led", v3, 1.2, 0.07, 0.95, *ZV3, sel=front)
    panels_on(G, "white", v3, 1.5, 0.18, 0.5, *ZV3, sel=lambda p, n: n.y >= -0.5)
    slab(G, lambda m: rect(-5, 0, 5, 9.2, 0.6 + m), 1.4, *ZS3)

    # terraces: lawns, planters, trees, glass rails, hanging greenery
    tz = ZS0[1]
    box(G, "grass", -12.6, -4.9, tz, -7.2, 7.7, tz + 0.1, 0.04)
    planter(G, -14.0, -6.3, -7.2, -5.0, tz, tree_h=0, seed=1)
    planter(G, -14.0, -5.0, -12.7, 7.7, tz, seed=2)
    planter(G, -14.0, 7.7, -7.2, 9.2, tz, seed=3)
    for i, (x, y) in enumerate(((-13.35, -1.5), (-13.35, 3.2), (-9.5, 8.45), (-13.0, -5.6))):
        tree(G, x, y, tz + 0.95, 4.6 - i * 0.3, 10 + i, hero=(i == 0))
    rail_poly(G, round_poly(s0(-0.15), 1.8), tz, sel=lambda mid: mid.x < -6.8)
    tz = ZS1[1]
    box(G, "grass", 5.6, -6.8, tz, 12.6, 9.0, tz + 0.1, 0.04)
    box(G, "grass", -5.6, -7.4, tz, 5.4, -3.5, tz + 0.1, 0.04)
    planter(G, 12.8, -8.4, 14.1, 9.2, tz, seed=4)
    planter(G, -5.6, -8.6, 14.1, -7.4, tz, seed=5)
    planter(G, 5.6, 7.8, 12.6, 9.2, tz, seed=6)
    for i, (x, y) in enumerate(((13.45, -3), (13.45, 3), (13.45, 8.2), (-3.5, -8.0), (4.5, -8.0), (11, -8.0), (8.5, 8.4))):
        tree(G, x, y, tz + 0.95, 5.6 - (i % 3) * 0.5, 20 + i, hero=(i in (3, 5)))
    rail_poly(G, round_poly(s1(-0.15), 1.8), tz)
    tz = ZS2[1]
    planter(G, -10.6, -3.1 - 0.4, 4.6, -1.6, tz, seed=7)
    planter(G, -10.6, -1.6, -9.3, 8.8, tz, seed=8)
    for i, (x, y) in enumerate(((-8.5, -2.5), (-2.5, -2.5), (3.2, -2.5), (-9.9, 4.0))):
        tree(G, x, y, tz + 0.95, 4.2, 30 + i)
    box(G, "grass", -9.0, -1.4, tz, 4.6, 0.0, tz + 0.08, 0.03)
    rail_poly(G, round_poly(rect(-11, -3, 5, 9.2, 0.45), 1.6), tz)
    tz = ZS3[1]
    planter(G, -4.7, 0.3, 4.7, 1.5, tz, seed=9)
    planter(G, -4.7, 7.6, 4.7, 8.9, tz, seed=11)
    tree(G, -3.8, 4.5, tz + 0.1, 2.6, 41)
    tree(G, 3.8, 4.5, tz + 0.1, 2.5, 42)
    rail_poly(G, round_poly(rect(-5, 0, 5, 9.2, 0.45), 1.3), tz)
    # greenery curtains hanging from the slab edges
    hang_vines(G, round_poly(s0(0.06), 1.8), 7.6, 1.0, 3.0, 1.1, 51, sel=lambda p, n: p.x < -6.0)
    hang_vines(G, round_poly(s1(0.06), 1.8), 13.5, 1.0, 2.8, 1.0, 52, sel=lambda p, n: n.y < -0.5 or n.x > 0.5 or p.x < -7)
    hang_vines(G, round_poly(rect(-11, -3, 5, 9.2, 0.66), 1.6), 19.0, 1.2, 4.2, 1.1, 53, sel=lambda p, n: n.y < -0.5 or n.x < -0.5)

    # crown: AI core orb with orbit rings, pergola
    zc = 24.3
    blob(G, "orb", (0, 4.6, zc), 0.7, 77, sub=2)
    for tilt, r in ((0, 1.1), (60, 1.35), (-60, 1.6)):
        annulus(G, "led", Matrix.Translation((0, 4.6, zc)) @ Matrix.Rotation(math.radians(tilt), 4, "X"), r - 0.05, r, 0.08, 40)
    cyl(G, "white", 0, 4.6, 23.2, zc - 0.65, 0.12, 8)
    for x in (-4.4, 4.4):
        for y in (1.7, 7.4):
            box(G, "white", x - 0.07, y - 0.07, 23.2, x + 0.07, y + 0.07, 24.9, 0.02)
        box(G, "white", x - 0.08, 1.7, 25.0, x + 0.08, 7.4, 24.9)
        box(G, "led", x - 0.04, 1.7, 24.9, x + 0.04, 7.4, 24.96)

    # colliders (walls solid, steps low)
    collider("step_a", -7.4, -9.9, 7.4, -8.6, 0, 0.4)
    collider("step_b", -7.4, -8.6, 7.4, -7.3, 0, 0.8)
    collider("plinth", -15, -7.3, 15, 10, 0, P)
    collider("wing_l", -14, -6, -3.6, 9, 0, 7.0)
    collider("wing_r", 3.6, -6, 14, 9, 0, 7.0)
    collider("core", -13.8, 1.5, 13.8, 9, 0, 7.0)
    collider("upper", -14.6, -9.1, 14.6, 9.8, 7.0, 26)
    for s in (-1, 1):  # ground planters flanking the steps
        x0, x1 = sorted((s * 7.6, s * 15))
        planter(G, x0, -9.7, x1, -7.3, 0, h=0.9, hh=0.45, tree_h=4.6, seed=80 + s)
        collider(f"planter{s}", x0, -9.7, x1, -7.3, 0, 1.2)
    emit_geo(G, M, "AI")
    emit_foliage()
    tri_count()


# ============================================================ Exchange ====
EX_MATS = {
    "cream": ("f1e8d4", 0.6, 0, None, 0), "stone": ("d9cfb8", 0.7, 0, None, 0), "mint": ("b9ecd9", 0.5, 0, None, 0),
    "ink": ("1b2a35", 0.5, 0.2, None, 0), "glass": ("7fd9c4", 0.08, 0.35, None, 0), "glass_dk": ("2f9c88", 0.1, 0.4, None, 0),
    "glass_hi": ("c8f5ea", 0.1, 0.2, None, 0), "glass_lit": ("ffe2ad", 0.4, 0, "ffd99a", 1.2),
    "ledg": ("00ec97", 0.2, 0, "00ec97", 1.8), "orange": ("f76b15", 0.3, 0, "f76b15", 1.5), "white": ("f9f9f8", 0.4, 0, "f9f9f8", 0.6),
    "brass": ("d9b36a", 0.35, 0.7, None, 0), "planter": ("ece6d6", 0.6, 0, None, 0), "gold": ("ffd27a", 0.3, 0, "ffc457", 1.6),
    "leaf": ("5cc44a", 0.85, 0, None, 0), "leaf2": ("8fdb5c", 0.85, 0, None, 0), "hedge": ("3f9e3c", 0.9, 0, None, 0),
    "bark": ("7a5a3c", 0.9, 0, None, 0), "vine": ("48a838", 0.9, 0, None, 0), "soil": ("5a4331", 0.95, 0, None, 0), "grass": ("7fb85a", 0.95, 0, None, 0),
}


def build_exchange():
    clear()
    G, M = Geo(), mat_table("ix", EX_MATS)
    PL, FY = 1.05, -3.6          # plinth top, facade plane
    ZB, RX, RZ = 11.0, 7.4, 8.5  # vault spring line and half-ellipse radii
    WZ = 14.5                    # wing roof
    HUB = 15.4                   # hub of the radial mullions (above the cornice)

    # plinth, three wide steps, side planters
    box(G, "stone", -12.4, -6.6, 0, 12.4, 9.4, PL, 0.08)
    for i, (y0, y1) in enumerate(((-9.0, -8.2), (-8.2, -7.4), (-7.4, -6.6))):
        top = 0.35 * (i + 1)
        box(G, "cream", -8.6, y0, 0, 8.6, y1, top, 0.04)
        box(G, "ledg", -8.5, y0 - 0.03, top - 0.27, 8.5, y0, top - 0.1)
    for s in (-1, 1):
        x0, x1 = sorted((s * 8.9, s * 12.4))
        planter(G, x0, -8.8, x1, -6.6, 0, h=0.9, hh=0.35, tree_h=4.2, seed=60 + s, hedge="hedge")

    # colonnade
    for i in range(8):
        x = -10.5 + 3 * i
        cyl(G, "cream", x, -5.6, PL, 9.8, 0.45, 12, False)
        box(G, "cream", x - 0.62, -6.22, PL, x + 0.62, -4.98, PL + 0.35, 0.05)
        box(G, "cream", x - 0.7, -6.3, 9.35, x + 0.7, -4.9, 9.8, 0.06)
        cyl(G, "mint", x, -5.6, PL + 0.35, PL + 0.42, 0.52, 12, False)
        collider(f"col{i}", x - 0.55, -6.15, x + 0.55, -5.05, 0, 10)
    # entablature: ink frieze with converging-route LED lines, lettering, cornice
    box(G, "cream", -12.3, -6.4, 9.8, 12.3, FY, 13.0, 0.08)
    box(G, "cream", -12.5, -6.7, 13.0, 12.5, FY, 13.5, 0.06)
    box(G, "mint", -12.4, -6.74, 13.5, 12.4, FY, 13.62)
    box(G, "ink", -11.8, -6.47, 10.2, 11.8, -6.4, 12.6, 0.03)
    for s in (-1, 1):
        for z in (10.5, 10.95, 11.4, 11.85, 12.3):
            beam(G, "ledg", (s * 11.5, -6.5, z), (s * 6.0, -6.5, 11.4), 0.06)
        for z in (10.5, 12.3):
            blob(G, "ledg", (s * 11.5, -6.5, z), 0.1, int(z * 10), sub=1)
    text_geo(G, "cream", "NEAR INTENTS", (0, -6.53, 11.6), 8.0, 0.08)
    text_geo(G, "mint", "EXCHANGE", (0, -6.53, 10.65), 4.4, 0.08, spacing=1.35)

    # nave: arched glass front, nested archivolts, converging radial mullions, hub with the Intents mark
    pts = [(-RX, PL)] + arch(0, ZB, RX, RZ) + [(RX, PL)]
    extrude_xz(G, "glass", pts, FY, FY + 0.25)
    extrude_xz(G, "glass", pts, 8.75, 9.0)
    arch_band(G, "glass_hi", 0, ZB, RX - 0.15, RZ - 0.15, RX + 0.15, RZ + 0.15, FY, 9.0)
    arch_band(G, "cream", 0, ZB, RX + 0.12, RZ + 0.12, RX + 1.05, RZ + 1.05, FY - 0.4, FY)
    arch_band(G, "mint", 0, ZB, RX + 0.2, RZ + 0.2, RX + 0.62, RZ + 0.62, FY - 0.52, FY - 0.4)
    arch_band(G, "ledg", 0, ZB, RX + 0.2, RZ + 0.2, RX + 0.3, RZ + 0.3, FY - 0.58, FY - 0.52)
    for s in (-1, 1):
        x0, x1 = sorted((s * (RX + 0.12), s * (RX + 1.05)))
        box(G, "cream", x0, FY - 0.4, PL, x1, FY, ZB, 0.05)
        x0, x1 = sorted((s * (RX + 0.2), s * (RX + 0.62)))
        box(G, "mint", x0, FY - 0.52, PL, x1, FY - 0.4, ZB)
    arch_band(G, "cream", 0, ZB, RX + 0.12, RZ + 0.12, RX + 0.95, RZ + 0.95, 8.9, 9.3)
    for yy in (0.2, 2.8, 5.4, 8.0):  # vault ribs
        arch_band(G, "cream", 0, ZB, RX + 0.1, RZ + 0.1, RX + 0.6, RZ + 0.6, yy - 0.25, yy + 0.25)
    box(G, "ledg", -0.12, FY, ZB + RZ + 0.15, 0.12, 9.0, ZB + RZ + 0.32)
    for a in (35, 70, 110, 145):
        x, z = (RX + 0.4) * math.cos(math.radians(a)), ZB + (RZ + 0.4) * math.sin(math.radians(a))
        box(G, "ledg", x - 0.06, FY, z - 0.06, x + 0.06, 9.0, z + 0.06)
    for x in (-6.0, -4.5, -3.0, -1.5, 0, 1.5, 3.0, 4.5, 6.0):  # lower mullions
        box(G, "cream", x - 0.05, FY - 0.14, PL, x + 0.05, FY, 9.4)
    for z in (4.2, 6.6, 9.4):
        box(G, "cream", -RX, FY - 0.14, z - 0.05, RX, FY, z + 0.05)
    for a in range(10, 171, 10):  # radial mullions from the hub
        r = math.radians(a)
        beam(G, "cream", (0, FY - 0.08, HUB), ((RX - 0.1) * math.cos(r), FY - 0.08, ZB + (RZ - 0.1) * math.sin(r)), 0.07)
    box(G, "cream", -RX, FY - 0.14, ZB - 0.05, RX, FY, ZB + 0.05)
    for r in (2.4, 3.3):  # concentric route rings
        annulus(G, "ledg", Matrix.Translation((0, FY - 0.1, HUB)) @ Matrix.Rotation(math.pi / 2, 4, "X"), r - 0.04, r, 0.06, 48)
    svg_geo(G, "nearintents-Logo-Icon.svg", {"white": "white", "orange": "orange", "blue": "white", "black": "ink"}, (0, FY - 0.3, HUB), 3.0, 0.22, lift=("orange",))
    annulus(G, "ledg", Matrix.Translation((0, FY - 0.28, HUB)) @ Matrix.Rotation(math.pi / 2, 4, "X"), 1.55, 1.72, 0.1, 48)
    # doors under the arch
    box(G, "glass_lit", -2.4, FY - 0.12, PL, 2.4, FY, 6.5)
    for x in (-2.4, -1.2, 0, 1.2, 2.4):
        box(G, "brass", x - 0.06, FY - 0.2, PL, x + 0.06, FY - 0.1, 6.5)
    box(G, "brass", -2.46, FY - 0.2, 6.4, 2.46, FY - 0.1, 6.55)
    box(G, "brass", -2.6, FY - 0.55, 6.55, 2.6, FY, 6.85, 0.05)

    # wings: rounded cream blocks, pilasters, glass slots, mint belt, parapet, LED ticker, roof gardens
    for x0, x1 in ((-12.0, -7.2), (7.2, 12.0)):
        w = round_poly(rect(x0, FY, x1, 9.0), 1.2)
        prism(G, "cream", w, PL, WZ)
        panels_on(G, "cream", w, 3.0, 0.5, 0.3, PL, WZ, bev=0.04)
        panels_on(G, "glass", w, 3.0, 2.0, 0.14, 2.7, 12.9, phase=0.5, inset=0.0)
        panels_on(G, "glass_dk", w, 3.0, 2.0, 0.16, 12.9, 13.2, phase=0.5)
        prism(G, "mint", offset(w, 0.07), 5.2, 5.5, caps=False)
        prism(G, "stone", offset(w, 0.12), PL, PL + 0.6)
        ring_poly(G, "cream", offset(w, 0.14), offset(w, -0.3), WZ, WZ + 0.45)
        prism(G, "ledg", offset(w, 0.15), WZ + 0.1, WZ + 0.2, caps=False)
        panels_on(G, ["ledg", "ledg", "orange", "white"], w, 0.55, 0.3, 0.08, 13.55, 13.8, margin=0.9, seed=3)
        box(G, "grass", x0 + 0.5, FY + 0.5, WZ, x1 - 0.5, 8.5, WZ + 0.08, 0.03)
        for i, (tx, ty) in enumerate((((x0 + x1) / 2, 1.0), ((x0 + x1) / 2, 6.5))):
            tree(G, tx, ty, WZ, 3.8, 70 + i + int(x0))
        collider("wing_" + ("l" if x0 < 0 else "r"), x0, FY, x1, 9.0, 0, WZ + 0.5)
    for s in (-1, 1):  # signal masts
        cyl(G, "cream", s * 11.0, 8.0, WZ, 20.6, 0.1, 8, False)
        blob(G, "ledg", (s * 11.0, 8.0, 20.8), 0.28, 90 + s, sub=2)

    # colliders
    collider("step_a", -8.6, -9.0, 8.6, -8.2, 0, 0.35)
    collider("step_b", -8.6, -8.2, 8.6, -7.4, 0, 0.7)
    collider("step_c", -8.6, -7.4, 8.6, -6.6, 0, 1.05)
    collider("plinth", -12.4, -6.6, 12.4, 9.4, 0, PL)
    collider("planter_l", -12.4, -8.8, -8.9, -6.6, 0, 1.0)
    collider("planter_r", 8.9, -8.8, 12.4, -6.6, 0, 1.0)
    collider("entab", -12.5, -6.7, 12.5, FY, 9.8, 14.0)
    collider("nave", -RX - 1.1, FY - 0.6, RX + 1.1, 9.4, 0, ZB + RZ + 1.0)
    emit_geo(G, M, "IX")
    emit_foliage()
    tri_count()
