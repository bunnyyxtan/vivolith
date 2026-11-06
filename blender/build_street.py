"""Builds Saltlight Row (Market Lane, plaza, Ledger Tower) in Blender and exports public/models/saltlight_row.glb.

Run inside Blender (MCP for Blender):  exec(open(r"<repo>/blender/build_street.py").read()); build(); export()
Sources: Poly Haven CC0 assets in assets-src/downloads/polyhaven (fetch with tools/fetch_polyhaven.py),
plus NEAR brand tile PNG from assets-src/brand. Everything else is modelled here.

Coordinates: Blender (x, y, z) exports to three.js (x, z, -y). Market Lane runs along +x at three z=0.
Conventions read by src/assets.ts / src/world.ts:
  COL_*                      invisible axis-aligned collider boxes
  SIGN_<id>                  price-board planes the game paints at runtime
  material "*__tint_rrggbb"  base-colour multiplier applied in three.js
"""
import bpy, bmesh, math, random, io, contextlib, pathlib
from mathutils import Vector, Matrix

REPO = pathlib.Path(r"C:/Bunnyy/Hackathons/NEAR")
PH = REPO / "assets-src" / "downloads" / "polyhaven"
BRAND_TILE = REPO / "assets-src" / "brand" / "kit" / "Tertiary" / "01_Color" / "tile-color@1x.png"
OUT = REPO / "public" / "models" / "saltlight_row.glb"
LANE_HALF = 8.0        # facade line distance from lane centre (m)
SIDEWALK = 3.2         # sidewalk depth in front of facades
CURB_H = 0.15
FLOOR_H = 3.0
LANE_X0, LANE_X1 = 12.0, 78.0
TOWER = (-20.0, 21.5)  # Blender xy (three: x=-20, z=-21.5): corner campanile, off the Spire view axis
rng = random.Random(42)


# ================================================================ library ====
def quiet():
    stack = contextlib.ExitStack()
    stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
    stack.enter_context(contextlib.redirect_stderr(io.StringIO()))
    return stack


def base_name(n):
    return n.rsplit(".", 1)[0] if len(n) > 4 and n[-4] == "." and n[-3:].isdigit() else n


def load_asset(aid, max_tris=None, only_prefixes=None):
    """Import a Poly Haven glTF once into the hidden Library scene; return {name: object}.
    max_tris: decimate each mesh of the asset to roughly this many triangles (browser budget).
    only_prefixes: limit decimation to meshes whose name starts with one of these."""
    coll = bpy.data.collections.get("LIB_" + aid)
    if coll is None:
        lib = bpy.data.scenes.get("Library") or bpy.data.scenes.new("Library")
        win = bpy.context.window
        prev = win.scene
        win.scene = lib
        before = set(bpy.data.objects)
        with quiet():
            bpy.ops.import_scene.gltf(filepath=str(PH / aid / f"{aid}.gltf"))
        coll = bpy.data.collections.new("LIB_" + aid)
        lib.collection.children.link(coll)
        for o in [o for o in bpy.data.objects if o not in before]:
            for c in list(o.users_collection):
                c.objects.unlink(o)
            coll.objects.link(o)
        if max_tris:
            for o in coll.objects:
                if o.type != "MESH" or (only_prefixes and not o.name.startswith(tuple(only_prefixes))):
                    continue
                tris = sum(len(p.vertices) - 2 for p in o.data.polygons)
                if tris > max_tris:
                    m = o.modifiers.new("dec", "DECIMATE")
                    m.ratio = max(0.01, max_tris / tris)
                    with bpy.context.temp_override(object=o, active_object=o):
                        bpy.ops.object.modifier_apply(modifier=m.name)
        win.scene = prev
    return {base_name(o.name): o for o in coll.objects}


def empty(name, loc=(0, 0, 0), rot_z=0.0, parent=None):
    e = bpy.data.objects.new(name, None)
    e.location = loc
    e.rotation_euler = (0, 0, rot_z)
    if parent:
        e.parent = parent
    bpy.context.scene.collection.objects.link(e)
    return e


def piece(src, parent, loc, rot=(0.0, 0.0, 0.0), scale=1.0):
    """Linked copy of a library object. Library objects keep their own origin, so `loc` is final."""
    o = src.copy()
    o.parent = parent
    o.matrix_parent_inverse = Matrix.Identity(4)
    o.location = Vector(loc)
    o.rotation_euler = rot if isinstance(rot, tuple) else (0, 0, rot)
    o.scale = (scale, scale, scale) if not isinstance(scale, tuple) else scale
    bpy.context.scene.collection.objects.link(o)
    return o


def asset_group(aid, parent, loc, rot_z=0.0, scale=1.0, only=None, max_tris=None):
    """Place a whole multi-mesh library asset (optionally a subset of its meshes) as one group."""
    lib = load_asset(aid, max_tris)
    g = empty(f"{aid}_grp", loc, rot_z, parent)
    g.scale = (scale, scale, scale)
    for name, o in lib.items():
        if o.type == "MESH" and (only is None or name in only):
            c = o.copy()
            c.parent = g
            c.matrix_parent_inverse = Matrix.Identity(4)
            c.matrix_basis = o.matrix_world.copy()
            bpy.context.scene.collection.objects.link(c)
    return g


def join_under(root, name):
    """Realise every mesh under root into one object (one draw call per material)."""
    bpy.context.view_layer.update()
    kids = [o for o in root.children_recursive if o.type == "MESH"]
    for o in kids:
        mw = o.matrix_world.copy()
        o.data = o.data.copy()
        o.data.transform(mw)
        o.parent = None
        o.matrix_world = Matrix.Identity(4)
    with bpy.context.temp_override(active_object=kids[0], object=kids[0],
                                   selected_objects=kids, selected_editable_objects=kids):
        bpy.ops.object.join()
    obj = kids[0]
    obj.name = name
    for e in [root] + [o for o in root.children_recursive]:
        if e.name in bpy.data.objects and e.type == "EMPTY":
            bpy.data.objects.remove(e)
    return obj


def planar_dissolve(obj, degrees=0.2):
    """Merge coplanar faces (the kit's flat walls are densely subdivided). Keeps material/UV borders."""
    m = obj.modifiers.new("planar", "DECIMATE")
    m.decimate_type = "DISSOLVE"
    m.angle_limit = math.radians(degrees)
    m.delimit = {"MATERIAL", "UV"}
    with bpy.context.temp_override(object=obj, active_object=obj):
        bpy.ops.object.modifier_apply(modifier=m.name)


def realize(obj, parent=None):
    """Convert a curve/text object to a mesh object (no operators, works off-screen)."""
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(obj.evaluated_get(dg))
    mo = bpy.data.objects.new(obj.name + "_mesh", me)
    mo.matrix_world = obj.matrix_world.copy()
    bpy.context.scene.collection.objects.link(mo)
    data = obj.data
    bpy.data.objects.remove(obj)
    if data and data.users == 0:
        bpy.data.curves.remove(data)
    if parent:
        mw = mo.matrix_world.copy()
        mo.parent = parent
        mo.matrix_world = mw
    return mo


def join_objects(prefixes, name):
    """Merge already-built scene objects (e.g. one street row) so they share material draw calls."""
    objs = [o for o in bpy.context.scene.objects if o.type == "MESH" and o.name.startswith(tuple(prefixes))]
    if not objs:
        return None
    for o in objs:  # linked copies share mesh data with the Library: never join into a shared mesh
        if o.data.users > 1:
            o.data = o.data.copy()
    with bpy.context.temp_override(active_object=objs[0], object=objs[0],
                                   selected_objects=objs, selected_editable_objects=objs):
        bpy.ops.object.join()
    objs[0].name = name
    return objs[0]


def collider(name, x0, y0, x1, y1, z0=0.0, z1=4.0):
    """Axis-aligned box in Blender coordinates; exported as COL_* and hidden in three.js."""
    me = bpy.data.meshes.new("COL_" + name)
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bm.to_mesh(me)
    bm.free()
    o = bpy.data.objects.new("COL_" + name, me)
    xa, xb = sorted((x0, x1))
    ya, yb = sorted((y0, y1))
    o.location = ((xa + xb) / 2, (ya + yb) / 2, (z0 + z1) / 2)
    o.scale = (xb - xa, yb - ya, z1 - z0)
    bpy.context.scene.collection.objects.link(o)
    return o


def footprint_collider(name, root, w, d, h):
    """Collider for a rectangle (0..w, 0..d) in root space, root rotated by a multiple of 90 degrees."""
    bpy.context.view_layer.update()
    mw = root.matrix_world
    pts = [mw @ Vector((x, y, 0)) for x in (0, w) for y in (0, d)]
    collider(name, min(p.x for p in pts), min(p.y for p in pts), max(p.x for p in pts), max(p.y for p in pts), 0, h)


# ============================================================== materials ====
def image(path, non_color=False):
    img = bpy.data.images.load(str(path), check_existing=True)
    if non_color:
        img.colorspace_settings.name = "Non-Color"
    return img


def pbr_material(name, asset, tint=None):
    """Principled material from a Poly Haven texture set (diffuse, GL normal, roughness)."""
    key = name + (f"__tint_{tint}" if tint else "")
    if key in bpy.data.materials:
        return bpy.data.materials[key]
    m = bpy.data.materials.new(key)
    m.use_nodes = True
    nt = m.node_tree
    bsdf = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")
    base = PH / asset
    d = nt.nodes.new("ShaderNodeTexImage"); d.image = image(base / f"{asset}_Diffuse_1k.jpg")
    r = nt.nodes.new("ShaderNodeTexImage"); r.image = image(base / f"{asset}_Rough_1k.jpg", True)
    n = nt.nodes.new("ShaderNodeTexImage"); n.image = image(base / f"{asset}_nor_gl_1k.jpg", True)
    nm = nt.nodes.new("ShaderNodeNormalMap")
    nt.links.new(d.outputs["Color"], bsdf.inputs["Base Color"])
    nt.links.new(r.outputs["Color"], bsdf.inputs["Roughness"])
    nt.links.new(n.outputs["Color"], nm.inputs["Color"])
    nt.links.new(nm.outputs["Normal"], bsdf.inputs["Normal"])
    return m


def flat_material(name, hexcolor, rough=0.8, metal=0.0, emit=None, emit_strength=0.0):
    if name in bpy.data.materials:
        return bpy.data.materials[name]
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = next(n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    bsdf.inputs["Base Color"].default_value = (*linear(hexcolor), 1)
    bsdf.inputs["Roughness"].default_value = rough
    bsdf.inputs["Metallic"].default_value = metal
    if emit:
        bsdf.inputs["Emission Color"].default_value = (*linear(emit), 1)
        bsdf.inputs["Emission Strength"].default_value = emit_strength
    return m


def image_material(name, path, emit_strength=0.0):
    if name in bpy.data.materials:
        return bpy.data.materials[name]
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    bsdf = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")
    t = nt.nodes.new("ShaderNodeTexImage"); t.image = image(path)
    nt.links.new(t.outputs["Color"], bsdf.inputs["Base Color"])
    if emit_strength:
        nt.links.new(t.outputs["Color"], bsdf.inputs["Emission Color"])
        bsdf.inputs["Emission Strength"].default_value = emit_strength
    bsdf.inputs["Roughness"].default_value = 0.35
    return m


def linear(hexstr):
    h = hexstr.lstrip("#")
    c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return tuple(((v + 0.055) / 1.055) ** 2.4 if v > 0.04045 else v / 12.92 for v in c)


def uv_box(mesh, tile):
    """Box-project UVs at `tile` metres per texture repeat."""
    bm = bmesh.new()
    bm.from_mesh(mesh)
    uv = bm.loops.layers.uv.verify()
    for f in bm.faces:
        ax = max(range(3), key=lambda i: abs(f.normal[i]))
        for l in f.loops:
            c = l.vert.co
            u, v = [(c.y, c.z), (c.x, c.z), (c.x, c.y)][ax]
            l[uv].uv = (u / tile, v / tile)
    bm.to_mesh(mesh)
    bm.free()


def box_mesh(name, x0, y0, z0, x1, y1, z1, mat, tile=1.0, parent=None, bevel=0.0):
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts:
        v.co = Vector((x0 + (v.co.x + 0.5) * (x1 - x0), y0 + (v.co.y + 0.5) * (y1 - y0), z0 + (v.co.z + 0.5) * (z1 - z0)))
    if bevel:
        bmesh.ops.bevel(bm, geom=bm.edges[:] + bm.verts[:], offset=bevel, segments=2, affect="EDGES")
    bm.to_mesh(me)
    bm.free()
    me.materials.append(mat)
    uv_box(me, tile)
    o = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(o)
    if parent:
        o.parent = parent
    return o


def cylinder(name, x, y, z0, z1, r, mat, parent=None, verts=12):
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, segments=verts, radius1=r, radius2=r, depth=z1 - z0)
    bmesh.ops.translate(bm, verts=bm.verts, vec=(x, y, (z0 + z1) / 2))
    bm.to_mesh(me)
    bm.free()
    me.materials.append(mat)
    uv_box(me, 1.0)
    o = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(o)
    if parent:
        o.parent = parent
    return o


# ================================================================= facade ====
FACADE = "modular_urban_apartments_facade"
WINDOW_TYPES = ["centered_large", "centered_small", "centered_double"]
# Paint colours over a neutral (greyscale) copy of the kit plaster: cream, ochre, terracotta, sage, pale blue, chalk, rose, butter.
TINTS = ["f1e3c6", "e2b878", "d08a62", "b9c6a6", "aec4d6", "f4f1ea", "e8b9a6", "f3d99a"]
NEUTRAL_PLASTER = REPO / "assets-src" / "generated" / "facade_plaster_neutral.png"


def neutral_plaster_image():
    """Greyscale copy of the kit's (orange) plaster diffuse so tints read as real paint colours."""
    if not NEUTRAL_PLASTER.exists():
        import numpy as np
        src = load_asset(FACADE)["wall_standard_standard_01"].data.materials[0]
        img = next(n.image for n in src.node_tree.nodes if n.type == "TEX_IMAGE" and "plaster_diff" in n.image.name)
        w, h = img.size
        px = np.array(img.pixels[:], dtype=np.float32).reshape(-1, 4)
        lum = px[:, :3] @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
        g = np.clip(lum / max(float(lum.mean()), 1e-4) * 0.62, 0, 1)
        out = np.stack([g, g, g, np.ones_like(g)], axis=1)
        dst = bpy.data.images.new("facade_plaster_neutral", w, h)
        dst.pixels.foreach_set(out.ravel())
        NEUTRAL_PLASTER.parent.mkdir(parents=True, exist_ok=True)
        dst.filepath_raw = str(NEUTRAL_PLASTER)
        dst.file_format = "PNG"
        dst.save()
    return image(NEUTRAL_PLASTER)


def facade_row(K, root, bays, floors, shop_bays, lit_ratio, tinted, glass, lit, plaster):
    column = [rng.choice(WINDOW_TYPES) for _ in range(bays)]
    height = FLOOR_H * floors
    for b in range(bays):
        bx = 3.0 * (b + 1)  # pieces are anchored at their right edge
        if b in shop_bays:
            piece(K["wall_door_centered_large_01"], root, (bx, 0, 0))
            piece(K["door_centered_large_01"], root, (bx, 0, 0))
        else:
            piece(K["wall_window_centered_large_01"], root, (bx, 0, 0))
            piece(K["window_centered_large_01"], root, (bx, 0, 0))
        piece(K["base_standard_01"], root, (bx, 0, 0))
        for f in range(1, floors):
            variant = "03" if f == floors - 1 and floors > 2 else ("01" if f == 1 else "02")
            t = column[b]
            piece(K[f"wall_window_{t}_{variant}"], root, (bx, 0, FLOOR_H * f))
            win = piece(K[f"window_{t}_{variant}"], root, (bx, 0, FLOOR_H * f))
            if rng.random() < lit_ratio:
                win.data = win.data.copy()
                for i, m in enumerate(win.data.materials):
                    if m == glass:
                        win.data.materials[i] = lit
            piece(K["dado_standard_standard_01"], root, (bx, 0, FLOOR_H * f - 0.25))
        piece(K["cornice_standard_standard_01"], root, (bx, 0, height - 0.25))
        piece(K["crown_standard_standard_01"], root, (bx, 0, height))
    for f in range(floors):
        piece(K["wall_pier_standard_01"], root, (0.0, 0, FLOOR_H * f))
        piece(K["wall_pier_standard_01"], root, (3.0 * bays, 0, FLOOR_H * f))
    for o in root.children:
        if o.data and len(o.data.materials) and o.data.materials[0] == plaster:
            o.data = o.data.copy()
            o.data.materials[0] = tinted


def facade_building(name, x, y, rot, bays, floors, shop_bays=(), depth=9.0, back=False, lit_ratio=0.4, tint=None):
    """Kit-built building. Root at (x, y), facade along local +x facing local -Y, body toward local +Y.
    back=True also puts a facade on the rear side (for blocks seen from both streets)."""
    K = load_asset(FACADE, 700, ("window_", "door_", "crown_"))
    width = 3.0 * bays
    height = FLOOR_H * floors
    root = empty(name + "_root", (x, y, 0), rot)
    plaster = K["wall_standard_standard_01"].data.materials[0]
    tinted = plaster.copy()
    tinted.name = f"facade_plaster__tint_{tint or rng.choice(TINTS)}"
    neutral = neutral_plaster_image()
    for n in tinted.node_tree.nodes:
        if n.type == "TEX_IMAGE" and n.image and "plaster_diff" in n.image.name:
            n.image = neutral
    glass = K["window_centered_large_01"].data.materials[1]
    lit = bpy.data.materials.get("facade_glass_lit")
    if lit is None:
        lit = glass.copy()
        lit.name = "facade_glass_lit"
        b = next(n for n in lit.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
        b.inputs["Emission Color"].default_value = (1.0, 0.55, 0.25, 1)
        b.inputs["Emission Strength"].default_value = 3.0
    facade_row(K, root, bays, floors, set(shop_bays), lit_ratio, tinted, glass, lit, plaster)
    if back:
        rear = empty(name + "_rear", (width, depth, 0), math.pi, root)
        facade_row(K, rear, bays, floors, set(), lit_ratio, tinted, glass, lit, plaster)
    # Body starts behind the window recess (glass sits ~0.24 m behind the facade line).
    box_mesh(name + "_body", 0, 0.35, 0, width, max(0.4, depth - (0.35 if back else 0)), height + 0.3, tinted, 3.0, root)
    footprint_collider(name, root, width, depth, height)
    obj = join_under(root, "BLD_" + name)
    planar_dissolve(obj)
    return obj


# ================================================================= ground ====
def build_ground():
    road = pbr_material("road_cobble", "cobblestone_floor_08")
    walk = pbr_material("sidewalk", "concrete_pavement")
    plaza = pbr_material("plaza_paving", "patterned_paving")
    curb = flat_material("curb_stone", "9a958c", 0.7)
    inner = LANE_HALF - SIDEWALK
    box_mesh("GND_road", LANE_X0, -inner, -0.2, LANE_X1, inner, 0.0, road, 1.7)
    for s in (+1, -1):
        y0, y1 = sorted((s * inner, s * (LANE_HALF + 0.3)))
        box_mesh(f"GND_walk_{s}", LANE_X0, y0, -0.2, LANE_X1, y1, CURB_H, walk, 3.0)
        box_mesh(f"GND_curb_{s}", LANE_X0, s * inner - 0.12, -0.2, LANE_X1, s * inner + 0.12, CURB_H + 0.01, curb, 1.0)
        collider(f"walk_{s}", LANE_X0, y0, LANE_X1, y1, -0.2, CURB_H)
    box_mesh("GND_plaza", -30.0, -30.0, -0.2, LANE_X0, 30.0, 0.02, plaza, 2.5)


# ================================================================= stalls ====
AWNINGS = [("0091fd", "eeeeeb"), ("d9572b", "f2e6d0"), ("2f8f6b", "efe7d2"), ("e8b33a", "fbf3df"),
           ("b83f5e", "f4e8de"), ("83dcff", "f7f3ea")]
FRUIT = ["food_apple_01", "food_lime_01", "food_pomegranate_01", "lemon", "yellow_onion"]


def awning(name, parent, w, d, z, colors, tilt=0.22, stripes=8):
    """Sagging striped canopy with a scalloped valance, local x 0..w, y 0..d (y=0 is the front)."""
    a = flat_material(f"awning_{colors[0]}", colors[0], 0.85)
    b = flat_material(f"awning_{colors[1]}", colors[1], 0.85)
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    nx, ny = stripes * 2, 6
    grid = [[bm.verts.new((w * i / nx, d * j / ny, z + d * (j / ny) * math.tan(tilt) - 0.12 * math.sin(math.pi * i / nx) * (1 - j / ny * 0.5)))
             for j in range(ny + 1)] for i in range(nx + 1)]
    for i in range(nx):
        for j in range(ny):
            f = bm.faces.new((grid[i][j], grid[i + 1][j], grid[i + 1][j + 1], grid[i][j + 1]))
            f.material_index = (i // 2) % 2
    # Valance: scallops hanging from the front edge.
    for i in range(nx):
        x0, x1 = w * i / nx, w * (i + 1) / nx
        top0, top1 = grid[i][0].co.z, grid[i + 1][0].co.z
        v0, v1 = bm.verts.new((x0, -0.01, top0)), bm.verts.new((x1, -0.01, top1))
        v2 = bm.verts.new((x1, -0.01, top1 - 0.18))
        v3 = bm.verts.new(((x0 + x1) / 2, -0.01, (top0 + top1) / 2 - 0.27))
        v4 = bm.verts.new((x0, -0.01, top0 - 0.18))
        f = bm.faces.new((v0, v4, v3, v2, v1))
        f.material_index = (i // 2) % 2
    bm.normal_update()
    bm.to_mesh(me)
    bm.free()
    me.materials.append(a)
    me.materials.append(b)
    uv_box(me, 1.0)
    o = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(o)
    o.parent = parent
    me.polygons.foreach_set("use_smooth", [True] * len(me.polygons))
    return o


def fruit_pile(parent, cx, cy, z, w, d, kinds, count=26, layers=2):
    for k in range(count):
        aid = rng.choice(kinds)
        lib = load_asset(aid, 160)
        src = next(o for o in lib.values() if o.type == "MESH")
        layer = k % layers
        piece(src, parent, (cx + rng.uniform(-w / 2, w / 2), cy + rng.uniform(-d / 2, d / 2), z + layer * 0.05),
              (rng.uniform(0, 0.6), rng.uniform(0, 0.6), rng.uniform(0, 6.28)), rng.uniform(0.95, 1.1))


def market_stall(name, x, y, facing, colors, goods, sign_id=None):
    """Wooden stall at Blender (x, y). facing=+1 means the customer side is +Y (south row), -1 means -Y."""
    rot = 0.0 if facing < 0 else math.pi
    root = empty(name + "_root", (x, y, CURB_H), rot)
    wood = pbr_material("stall_wood", "brown_planks_05")
    dark = flat_material("stall_frame", "4a3626", 0.7)
    cloth = flat_material(f"skirt_{colors[0]}", colors[0], 0.9)
    W, D, H = 3.0, 1.0, 0.86
    # Table, front cloth skirt, back shelf, posts.
    box_mesh(name + "_top", -W / 2, -D / 2, H - 0.06, W / 2, D / 2, H, wood, 1.2, root, 0.01)
    box_mesh(name + "_skirt", -W / 2 + 0.02, -D / 2 - 0.02, 0.08, W / 2 - 0.02, -D / 2, H - 0.06, cloth, 1.0, root)
    box_mesh(name + "_shelf", -W / 2, D / 2 - 0.35, H + 0.25, W / 2, D / 2, H + 0.3, wood, 1.2, root, 0.01)
    for px in (-W / 2 + 0.05, W / 2 - 0.05):
        for py in (-D / 2 + 0.05, D / 2 - 0.05):
            box_mesh(name + "_leg", px - 0.04, py - 0.04, 0, px + 0.04, py + 0.04, H - 0.06, dark, 1.0, root)
        for py in (-D / 2 - 0.25, D / 2 + 0.05):
            box_mesh(name + "_post", px - 0.035, py - 0.035, 0, px + 0.035, py + 0.035, 2.55 if py < 0 else 2.75, dark, 1.0, root)
    aw = awning(name + "_awning", root, W + 0.5, D + 0.9, 2.5, colors)
    aw.location = (-(W + 0.5) / 2, -D / 2 - 0.45, 0)
    # Goods (own object GOODS_<name>, so the game can empty a sold-out table): crates/baskets of fruit.
    stock = empty(name + "_goods", (x, y, CURB_H), rot)
    crate = load_asset("plastic_crate_01", 400)["plastic_crate_01"]
    basket = load_asset("wicker_basket_01", 500)["wicker_basket_01"]
    for i, sx in enumerate((-1.0, 0.0, 1.0)):
        if goods == "bananas" and i == 1:
            piece(load_asset("bananas", 900)["bananas_bunch"], stock, (sx, 0.0, H), (0, 0, rng.uniform(0, 3)))
            continue
        holder = basket if (i + len(name)) % 2 else crate
        piece(holder, stock, (sx, -0.05, H), (0, 0, math.pi / 2 if holder is crate else 0.0))
        fruit_pile(stock, sx, -0.05, H + (0.16 if holder is crate else 0.07), 0.22, 0.28,
                   goods if isinstance(goods, list) else FRUIT[:2], count=14)
    join_under(stock, "GOODS_" + name)
    for i in range(3):
        piece(crate, root, (-0.9 + i * 0.6, 0.15, 0.0), (0, 0, math.pi / 2))
    # Hanging lantern from the awning frame.
    lan = load_asset("wooden_lantern_01", 900)
    g = empty(name + "_lantern", (0.0, -0.35, 1.95), 0.0, root)
    for o in lan.values():
        if o.type == "MESH":
            c = piece(o, g, tuple(o.location))
    glow = flat_material("lantern_glow", "ffb56b", 0.4, emit="ffb56b", emit_strength=1.2)
    me = bpy.data.meshes.new(name + "_bulb")
    bm = bmesh.new(); bmesh.ops.create_icosphere(bm, subdivisions=2, radius=0.06); bm.to_mesh(me); bm.free()
    me.materials.append(glow)
    bulb = bpy.data.objects.new(name + "_bulb", me); bpy.context.scene.collection.objects.link(bulb)
    bulb.parent = root; bulb.location = (0.0, -0.35, 2.12)
    # Price board hung from the awning beam beside the lantern (the game paints live prices onto SIGN_<id>).
    if sign_id:
        board = flat_material("chalkboard", "1f2421", 0.9)
        bx, by, bz0, bz1 = 0.95, -D / 2 - 0.32, 1.72, 2.22
        box_mesh(name + "_board", bx - 0.36, by + 0.01, bz0 - 0.03, bx + 0.36, by + 0.04, bz1 + 0.03, dark, 1.0, root)
        for hx in (bx - 0.25, bx + 0.25):
            box_mesh(name + "_hanger", hx - 0.006, by + 0.02, bz1, hx + 0.006, by + 0.03, 2.42, dark, 1.0, root)
        me = bpy.data.meshes.new("SIGN_" + sign_id)
        bm = bmesh.new()
        verts = [bm.verts.new(v) for v in ((bx - 0.33, by, bz0), (bx + 0.33, by, bz0),
                                           (bx + 0.33, by, bz1), (bx - 0.33, by, bz1))]
        f = bm.faces.new(verts)
        uv = bm.loops.layers.uv.verify()
        for l, c in zip(f.loops, ((0, 0), (1, 0), (1, 1), (0, 1))):
            l[uv].uv = c
        bm.to_mesh(me); bm.free()
        me.materials.append(board)
        sign = bpy.data.objects.new("SIGN_" + sign_id, me)
        bpy.context.scene.collection.objects.link(sign)
        sign.parent = root
        sign.matrix_parent_inverse = Matrix.Identity(4)
    footprint = (W + 0.1, D + 0.6)
    obj_sign = bpy.data.objects.get("SIGN_" + sign_id) if sign_id else None
    if obj_sign:  # keep the sign as its own object so the game can find it
        bpy.context.view_layer.update()
        mw = obj_sign.matrix_world.copy()
        obj_sign.parent = None
        obj_sign.matrix_world = mw
    obj = join_under(root, "STALL_" + name)
    collider(name, x - footprint[0] / 2, y - footprint[1] / 2, x + footprint[0] / 2, y + footprint[1] / 2, 0, 1.0)
    return obj


# ================================================================== props ====
def street_lamp(name, x, y, rot_z):
    lib = load_asset("street_lamp_01", 900)
    root = empty(name, (x, y, CURB_H), rot_z)
    piece(lib["street_lamp_01"], root, (0, 0, 0))
    glow = flat_material("lamp_glow", "ffc98a", 0.4, emit="ffb36b", emit_strength=8.0)
    me = bpy.data.meshes.new(name + "_glow")
    bm = bmesh.new(); bmesh.ops.create_uvsphere(bm, u_segments=12, v_segments=8, radius=0.13); bm.to_mesh(me); bm.free()
    me.materials.append(glow)
    g = bpy.data.objects.new(name + "_glow", me); bpy.context.scene.collection.objects.link(g)
    g.parent = root
    g.location = (0.0, -0.33, 3.55)
    collider(name, x - 0.15, y - 0.15, x + 0.15, y + 0.15, 0, 3.5)
    return root


def string_lights(name, x, y0, y1, z, sag=0.9, bulbs=14):
    """Catenary cable across the lane with warm bulbs."""
    wire = flat_material("cable", "151515", 0.6)
    glow = flat_material("string_bulb", "ffd9a0", 0.4, emit="ffcf8a", emit_strength=10.0)
    cu = bpy.data.curves.new(name, "CURVE")
    cu.dimensions = "3D"
    cu.bevel_depth = 0.012
    cu.bevel_resolution = 1
    sp = cu.splines.new("POLY")
    n = 24
    sp.points.add(n)
    pts = []
    for i in range(n + 1):
        t = i / n
        p = (x, y0 + (y1 - y0) * t, z - sag * 4 * t * (1 - t))
        sp.points[i].co = (*p, 1)
        pts.append(p)
    ob = bpy.data.objects.new(name, cu)
    bpy.context.scene.collection.objects.link(ob)
    cu.materials.append(wire)
    root = empty(name + "_root")
    realize(ob, root)
    for k in range(1, bulbs):
        t = k / bulbs
        p = (x, y0 + (y1 - y0) * t, z - sag * 4 * t * (1 - t) - 0.08)
        me = bpy.data.meshes.new("bulb")
        bm = bmesh.new(); bmesh.ops.create_icosphere(bm, subdivisions=1, radius=0.05); bm.to_mesh(me); bm.free()
        me.materials.append(glow)
        b = bpy.data.objects.new("bulb", me); bpy.context.scene.collection.objects.link(b)
        b.parent = root
        b.location = p
    return join_under(root, "LIGHTS_" + name)


def props_group(name, items):
    """items: (asset_id, x, y, z, rot_z, only_meshes, max_tris)"""
    root = empty(name)
    for aid, x, y, z, rz, only, mt in items:
        asset_group(aid, root, (x, y, z), rz, 1.0, only, mt)
    return join_under(root, "PROPS_" + name)


def shop_sign(name, x, y, z, rot_z, text, board_hex, text_hex, glow=0.0, width=2.6):
    """Painted fascia sign with raised letters, mounted flat on a facade (local -Y is the street)."""
    root = empty(name, (x, y, z), rot_z)
    board = flat_material(f"sign_board_{board_hex}", board_hex, 0.6)
    letters = flat_material(f"sign_text_{text_hex}_{int(glow)}", text_hex, 0.4,
                            emit=text_hex if glow else None, emit_strength=glow)
    box_mesh(name + "_board", -width / 2, -0.08, -0.28, width / 2, 0.0, 0.28, board, 1.0, root, 0.015)
    cu = bpy.data.curves.new(name + "_txt", "FONT")
    cu.body = text
    cu.size = 0.3
    cu.extrude = 0.015
    cu.align_x = "CENTER"
    cu.align_y = "CENTER"
    cu.materials.append(letters)
    t = bpy.data.objects.new(name + "_txt", cu)
    bpy.context.scene.collection.objects.link(t)
    t.parent = root
    t.location = (0, -0.1, 0)
    t.rotation_euler = (math.pi / 2, 0, 0)
    bpy.context.view_layer.update()
    realize(t, root)
    return join_under(root, "SIGN3D_" + name)


def near_sign(name, x, y, z, rot_z, text):
    """The Ledger Exchange: sky-blue neon NEAR symbol tile + lettering on a dark board."""
    root = empty(name, (x, y, z), rot_z)
    board = flat_material("near_board", "272727", 0.5)
    tile = image_material("near_tile", BRAND_TILE, emit_strength=1.6)
    neon = flat_material("near_neon", "83dcff", 0.3, emit="83dcff", emit_strength=7.0)
    box_mesh(name + "_board", -1.9, -0.1, -0.42, 1.9, 0.0, 0.42, board, 1.0, root, 0.02)
    me = bpy.data.meshes.new(name + "_tile")
    bm = bmesh.new()
    vs = [bm.verts.new(v) for v in ((-1.8, -0.11, -0.34), (-1.12, -0.11, -0.34), (-1.12, -0.11, 0.34), (-1.8, -0.11, 0.34))]
    f = bm.faces.new(vs)
    uv = bm.loops.layers.uv.verify()
    for l, c in zip(f.loops, ((0, 0), (1, 0), (1, 1), (0, 1))):
        l[uv].uv = c
    bm.to_mesh(me); bm.free()
    me.materials.append(tile)
    to = bpy.data.objects.new(name + "_tile", me); bpy.context.scene.collection.objects.link(to); to.parent = root
    cu = bpy.data.curves.new(name + "_txt", "FONT")
    cu.body = text
    cu.size = 0.34
    cu.extrude = 0.02
    cu.align_x = "LEFT"
    cu.align_y = "CENTER"
    cu.materials.append(neon)
    t = bpy.data.objects.new(name + "_txt", cu); bpy.context.scene.collection.objects.link(t)
    t.parent = root
    t.location = (-0.98, -0.12, 0.0)
    t.rotation_euler = (math.pi / 2, 0, 0)
    bpy.context.view_layer.update()
    realize(t, root)
    return join_under(root, "SIGN3D_" + name)


def plaza_fountain(x, y):
    """Octagonal stone fountain with a tiered bowl: the plaza's social anchor."""
    root = empty("fountain", (x, y, 0.02))
    stone = pbr_material("tower_stone", "beige_wall_001")
    water = flat_material("water", "2f6f8f", 0.05, 0.1)
    accent = flat_material("near_mosaic", "0091fd", 0.3, emit="0091fd", emit_strength=0.6)
    cylinder("basin", 0, 0, 0, 0.62, 3.2, stone, root, 8)
    cylinder("rim", 0, 0, 0.62, 0.74, 3.35, stone, root, 8)
    cylinder("pool", 0, 0, 0.74, 0.76, 2.95, water, root, 32)
    cylinder("pedestal", 0, 0, 0.74, 2.1, 0.45, stone, root, 8)
    cylinder("mosaic", 0, 0, 1.2, 1.5, 0.47, accent, root, 8)
    cylinder("bowl", 0, 0, 2.1, 2.35, 1.25, stone, root, 8)
    cylinder("bowl_water", 0, 0, 2.35, 2.37, 1.12, water, root, 24)
    cylinder("spout", 0, 0, 2.35, 3.0, 0.18, stone, root, 8)
    collider("fountain", x - 3.3, y - 3.3, x + 3.3, y + 3.3, 0, 0.75)
    return join_under(root, "PLAZA_fountain")


def bench(name, x, y, rot_z):
    root = empty(name, (x, y, 0.02), rot_z)
    wood = pbr_material("stall_wood", "brown_planks_05")
    iron = flat_material("bench_iron", "22252a", 0.45, 0.7)
    for i in range(4):
        box_mesh("seat", -0.9, -0.22 + i * 0.12, 0.43, 0.9, -0.13 + i * 0.12, 0.47, wood, 1.0, root, 0.008)
    for i in range(2):
        box_mesh("back", -0.9, 0.24, 0.6 + i * 0.16, 0.9, 0.28, 0.72 + i * 0.16, wood, 1.0, root, 0.008)
    for sx in (-0.75, 0.75):
        box_mesh("leg", sx - 0.03, -0.24, 0, sx + 0.03, 0.26, 0.45, iron, 1.0, root)
        box_mesh("arm", sx - 0.03, 0.24, 0.45, sx + 0.03, 0.29, 0.95, iron, 1.0, root)
    c, s = abs(math.cos(rot_z)), abs(math.sin(rot_z))
    hx, hy = 0.95 * c + 0.3 * s, 0.95 * s + 0.3 * c
    collider(name, x - hx, y - hy, x + hx, y + hy, 0, 0.5)
    return join_under(root, "PLAZA_" + name)


# ============================================================ Ledger Tower ====
def ledger_tower():
    """Landmark: kit-faced stone shaft, open belfry with NEAR clock faces, copper pyramid, sky-blue lantern."""
    tx, ty = TOWER
    S = 6.0
    floors = 7
    shaft_h = FLOOR_H * floors
    stone = pbr_material("tower_stone", "beige_wall_001")
    copper = flat_material("tower_copper", "3f6f66", 0.45, 0.6)
    dark = flat_material("tower_dark", "2a2622", 0.8)
    lantern = flat_material("tower_lantern", "83dcff", 0.2, emit="83dcff", emit_strength=9.0)
    clock = image_material("tower_clock", BRAND_TILE, emit_strength=1.8)
    # Four kit faces (2 bays x 7 floors), shallow bodies, square core.
    for i, rot in enumerate((0.0, math.pi / 2, math.pi, -math.pi / 2)):
        c, s = math.cos(rot), math.sin(rot)
        # local (0,0) at the face's left corner, face looks outward
        ox = tx + (-S / 2) * c - (-S / 2) * s
        oy = ty + (-S / 2) * s + (-S / 2) * c
        facade_building(f"TWR{i}", ox, oy, rot, 2, floors, shop_bays=(0, 1) if i == 0 else (), depth=0.2,
                        lit_ratio=0.25, tint="efe6d6")
    for o in [o for o in bpy.context.scene.objects if o.name.startswith("COL_TWR")]:
        bpy.data.objects.remove(o)
    collider("tower", tx - S / 2 - 0.4, ty - S / 2 - 0.4, tx + S / 2 + 0.4, ty + S / 2 + 0.4, 0, shaft_h)
    root = empty("tower_top", (tx, ty, 0))
    box_mesh("core", -S / 2 + 0.45, -S / 2 + 0.45, 0, S / 2 - 0.45, S / 2 - 0.45, shaft_h + 0.8, stone, 2.0, root)
    box_mesh("plinth", -S / 2 - 0.5, -S / 2 - 0.5, 0, S / 2 + 0.5, S / 2 + 0.5, 0.9, stone, 2.0, root, 0.03)
    # Belfry: four corner piers, arches implied by lintels, clock faces above.
    z0 = shaft_h + 0.8
    bh = 4.2
    for cx in (-1, 1):
        for cy in (-1, 1):
            box_mesh("pier", cx * S / 2 - (0.9 if cx > 0 else -0.0) * 1, cy * S / 2 - (0.9 if cy > 0 else 0.0), z0,
                     cx * S / 2 + (0.0 if cx > 0 else 0.9), cy * S / 2 + (0.0 if cy > 0 else 0.9), z0 + bh, stone, 2.0, root, 0.03)
    box_mesh("belfry_floor", -S / 2, -S / 2, z0 - 0.3, S / 2, S / 2, z0, stone, 2.0, root, 0.03)
    box_mesh("bell", -0.7, -0.7, z0 + 1.6, 0.7, 0.7, z0 + 2.8, copper, 1.0, root, 0.25)
    box_mesh("lintel", -S / 2 - 0.15, -S / 2 - 0.15, z0 + bh, S / 2 + 0.15, S / 2 + 0.15, z0 + bh + 2.6, stone, 2.0, root, 0.04)
    box_mesh("cornice_top", -S / 2 - 0.45, -S / 2 - 0.45, z0 + bh + 2.6, S / 2 + 0.45, S / 2 + 0.45, z0 + bh + 3.0, dark, 1.0, root, 0.05)
    # Clock faces: NEAR tile on all four sides of the lintel block.
    cz = z0 + bh + 1.3
    for k, rot in enumerate((0.0, math.pi / 2, math.pi, -math.pi / 2)):
        me = bpy.data.meshes.new(f"clock{k}")
        bm = bmesh.new()
        r = 1.22
        vs =[bm.verts.new((-r, -S / 2 - 0.17, cz - r)), bm.verts.new((r, -S / 2 - 0.17, cz - r)),
              bm.verts.new((r, -S / 2 - 0.17, cz + r)), bm.verts.new((-r, -S / 2 - 0.17, cz + r))]
        f = bm.faces.new(vs)
        uv = bm.loops.layers.uv.verify()
        for l, c in zip(f.loops, ((0, 0), (1, 0), (1, 1), (0, 1))):
            l[uv].uv = c
        bmesh.ops.rotate(bm, verts=bm.verts, cent=(0, 0, 0), matrix=Matrix.Rotation(rot, 3, "Z"))
        bm.to_mesh(me); bm.free()
        me.materials.append(clock)
        o = bpy.data.objects.new(f"clock{k}", me); bpy.context.scene.collection.objects.link(o); o.parent = root
        box_mesh(f"clock_rim{k}", -r - 0.12, -S / 2 - 0.16, cz - r - 0.12, r + 0.12, -S / 2 - 0.15, cz + r + 0.12, dark, 1.0, root)
        bpy.context.view_layer.update()
        rim = root.children[-1]
        rim.data.transform(Matrix.Rotation(rot, 4, "Z"))
    # Copper pyramid roof and glowing lantern.
    zr = z0 + bh + 3.0
    me = bpy.data.meshes.new("roof")
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, segments=4, radius1=S * 0.78, radius2=0.35, depth=6.5)
    bmesh.ops.rotate(bm, verts=bm.verts, cent=(0, 0, 0), matrix=Matrix.Rotation(math.pi / 4, 3, "Z"))
    bmesh.ops.translate(bm, verts=bm.verts, vec=(0, 0, zr + 3.25))
    bm.to_mesh(me); bm.free()
    me.materials.append(copper)
    uv_box(me, 1.5)
    ro = bpy.data.objects.new("roof", me); bpy.context.scene.collection.objects.link(ro); ro.parent = root
    box_mesh("lantern", -0.55, -0.55, zr + 6.5, 0.55, 0.55, zr + 8.0, lantern, 1.0, root, 0.08)
    cylinder("spire", 0, 0, zr + 8.0, zr + 10.5, 0.06, dark, root, 8)
    join_under(root, "LANDMARK_ledger_tower")


# ================================================================== build ====
def reset_scene():
    sc = bpy.data.scenes.get("SaltlightRow")
    if sc:
        for o in list(sc.objects):
            bpy.data.objects.remove(o)
    else:
        sc = bpy.data.scenes.new("SaltlightRow")
    bpy.context.window.scene = sc
    return sc


NORTH = [(5, 4, {1, 3}), (4, 5, {0, 2}), (6, 4, {1, 4}), (4, 3, {1}), (3, 5, {0})]
SOUTH = [(4, 3, {1}), (5, 5, {0, 3}), (4, 4, {2}), (6, 4, {1, 4}), (3, 3, {1})]


def build_buildings():
    for side, rows in ((+1, NORTH), (-1, SOUTH)):
        x = LANE_X0
        for i, (bays, floors, shops) in enumerate(rows):
            w = 3.0 * bays
            if side > 0:
                facade_building(f"N{i}", x, LANE_HALF, 0.0, bays, floors, shops)
            else:
                facade_building(f"S{i}", x + w, -LANE_HALF, math.pi, bays, floors, shops)
            x += w + 0.3
    # Close the lane's east end (facing -X, toward the lane).
    facade_building("E0", LANE_X1, LANE_HALF + 3.0, -math.pi / 2, 7, 5, {3})
    # Plaza: west row facing +X, north row facing -Y behind the tower.
    facade_building("W0", -27.0, -24.0, math.pi / 2, 5, 4, {2})
    facade_building("W1", -27.0, -8.7, math.pi / 2, 5, 5, {1, 3})
    facade_building("W2", -27.0, 6.6, math.pi / 2, 6, 4, {2})
    # North side: two blocks frame a 30 m promenade on the NEAR Spire's axis (x -15..15); nothing stands on
    # the axis, so the Spire reads whole from the plaza and the Ledger Tower is the corner campanile.
    facade_building("P0", -27.0, 30.0, 0.0, 4, 5, {1}, back=True)
    facade_building("P3", 15.0, 30.0, 0.0, 3, 5, {1}, back=True)
    # Promenade-facing side facades, 5 cm proud of the blocks.
    facade_building("P0p", -14.95, 30.0, math.pi / 2, 3, 5, {1}, depth=0.2, lit_ratio=0.35)
    facade_building("P3p", 14.95, 39.0, -math.pi / 2, 3, 5, {1}, depth=0.2, lit_ratio=0.35)
    # Corner block between the plaza and Market Lane (seen from both).
    # Facade runs from y=LANE_HALF+12.3 down to the lane's north building line; body extends east (+X) behind it.
    facade_building("C0", LANE_X0 - 0.3, LANE_HALF + 12.3, -math.pi / 2, 4, 4, {1}, depth=8.0)
    facade_building("C1", LANE_X0 - 0.3, -LANE_HALF - 0.3, -math.pi / 2, 4, 3, {2}, depth=8.0)


def build_stalls():
    north = [(19.0, AWNINGS[0], ["food_apple_01", "lemon"], "pema"), (28.5, AWNINGS[1], ["food_pomegranate_01", "food_apple_01"], None),
             (38.0, AWNINGS[2], "bananas", None), (47.5, AWNINGS[3], ["lemon", "food_lime_01"], None),
             (57.0, AWNINGS[4], ["yellow_onion"], None), (66.5, AWNINGS[5], ["food_lime_01", "food_apple_01"], None)]
    for i, (x, colors, goods, sign) in enumerate(north):
        market_stall(f"n{i}", x, 5.75, -1, colors, goods, sign)
    for i in range(6):
        x = 23.5 + i * 9.5
        market_stall(f"s{i}", x, -5.75, +1, AWNINGS[(i + 3) % 6], [rng.choice(FRUIT), rng.choice(FRUIT)], None)


def build_props():
    for i, x in enumerate(range(16, 78, 12)):
        street_lamp(f"lamp_n{i}", x, LANE_HALF - SIDEWALK + 0.4, math.pi)
        street_lamp(f"lamp_s{i}", x + 6, -(LANE_HALF - SIDEWALK + 0.4), 0.0)
    for i, x in enumerate((-14, -4, 6)):
        street_lamp(f"lamp_p{i}", x, -12.0, 0.0)
    plaza_fountain(0.0, 0.0)
    for i, a in enumerate((0.4, 2.0, 3.6, 5.2)):
        bench(f"bench{i}", 6.2 * math.cos(a), 6.2 * math.sin(a), a + math.pi / 2)
    for i, (px, py) in enumerate(((-8.0, 9.0), (8.0, 9.0), (-8.0, -9.0))):
        props_group(f"planter{i}", [("planter_box_01", px, py, 0.02, 0.0, None, 1500)])
    for i, x in enumerate(range(21, 78, 9)):
        string_lights(f"sl{i}", x + 2.2, LANE_HALF - 0.1, -(LANE_HALF - 0.1), 7.2)
    side_items = []
    for x in (14.0, 33.0, 52.0, 71.0):
        side_items.append(("metal_trash_can", x, LANE_HALF - 0.7, CURB_H, 0.0, {"metal_trash_can", "metal_trash_can_lid", "metal_trash_can_handle_left", "metal_trash_can_handle_right"}, 1500))
    side_items += [
        ("fire_hydrant", 24.5, -(LANE_HALF - SIDEWALK + 0.5), CURB_H, 0.0, {"fire_hydrant", "fire_hydrant_cap_01", "fire_hydrant_cap_02"}, 1500),
        ("utility_box_01", 42.0, LANE_HALF - 0.4, CURB_H, math.pi, None, 1200),
        ("utility_box_01", 61.0, -(LANE_HALF - 0.4), CURB_H, 0.0, None, 1200),
        ("planter_box_01", 16.5, LANE_HALF - 0.4, CURB_H, 0.0, None, 1500),
        ("planter_box_01", 31.0, -(LANE_HALF - 0.4), CURB_H, 0.0, None, 1500),
        ("Barrel_01", 25.0, LANE_HALF - 0.5, CURB_H, 0.0, None, 1500),
        ("Barrel_01", 25.6, LANE_HALF - 0.6, CURB_H, 1.0, None, 1500),
        ("cardboard_box_01", 44.5, -(LANE_HALF - 0.6), CURB_H, 0.3, None, 800),
        ("cardboard_box_01", 44.9, -(LANE_HALF - 0.6), CURB_H + 0.34, 1.1, None, 800),
        ("water_manhole_cover", 30.0, 1.5, 0.0, 0.0, None, 800),
        ("water_manhole_cover", 55.0, -2.0, 0.0, 0.0, None, 800),
    ]
    props_group("street", side_items)
    # Air-con units hung on upper facades (facade face is at y=+-LANE_HALF).
    ac = []
    for x, side, z in ((15.0, 1, 4.2), (27.0, 1, 7.2), (40.0, -1, 4.2), (49.0, 1, 10.2), (58.0, -1, 7.2), (70.0, 1, 4.2)):
        ac.append(("exterior_aircon_unit", x, side * (LANE_HALF - 0.19), z, 0.0 if side > 0 else math.pi, {"exterior_aircon_unit"}, 1500))
    props_group("aircon", ac)
    # A fire escape on the lane's tallest north building.
    asset_group("modular_fire_escape", None, (34.0, LANE_HALF - 0.05, 3.2), 0.0, 1.0, None, 4000)
    root = empty("fe")
    for o in [o for o in bpy.context.scene.objects if o.name.startswith("modular_fire_escape_grp")]:
        o.parent = root
    join_under(root, "PROPS_fire_escape")
    # Shop signs on the lane, one NEAR-branded exchange facing the plaza corner.
    shop_sign("tea", 33.0, LANE_HALF - 0.02, 3.55, 0.0, "SALTLIGHT TEA HOUSE", "2b3a33", "e8d7a8")
    shop_sign("fish", 41.0, -(LANE_HALF - 0.02), 3.55, math.pi, "PIER FRESH FISH", "1e3a52", "f2e6d0")
    shop_sign("tools", 60.0, LANE_HALF - 0.02, 3.55, 0.0, "RAVI TOOLS & ROPE", "5a2b23", "f4e1c2")
    near_sign("ledger", 22.5, -(LANE_HALF - 0.02), 3.6, math.pi, "LEDGER EXCHANGE")


def merge_for_draw_calls():
    """One object per street row / prop family: shared materials collapse into shared draw calls."""
    join_objects(["BLD_N"], "ROW_lane_north")
    join_objects(["BLD_S"], "ROW_lane_south")
    join_objects(["BLD_W", "BLD_P", "BLD_C", "BLD_E"], "ROW_plaza")
    join_objects(["BLD_TWR", "LANDMARK_"], "LANDMARK_ledger_tower")
    join_objects(["STALL_"], "STALLS")
    join_objects(["street_lamp_01", "lamp_"], "PROPS_lamps")
    join_objects(["LIGHTS_"], "PROPS_string_lights")
    join_objects(["SIGN3D_"], "PROPS_signs")
    join_objects(["GND_"], "GROUND")
    join_objects(["PLAZA_", "PROPS_planter"], "PLAZA_furniture")


def build():
    reset_scene()
    build_ground()
    build_buildings()
    ledger_tower()
    build_stalls()
    build_props()
    merge_for_draw_calls()
    stats()


HERO_TEXTURES = ("modular_urban", "facade_plaster","cobblestone", "concrete_pavement", "patterned_paving", "beige_wall", "brown_planks", "tile-color")
SMALL_TEXTURES = ("food_", "lemon", "yellow_onion", "bananas")


def cap_textures():
    """Browser budget (in-memory only, sources untouched): 1k for surfaces seen large, 512 for props, 256 for fruit."""
    for img in bpy.data.images:
        w, h = img.size
        if not w:
            continue
        cap = 1024 if img.name.startswith(HERO_TEXTURES) else (256 if img.name.startswith(SMALL_TEXTURES) else 512)
        if max(w, h) > cap:
            s = cap / max(w, h)
            img.scale(max(1, int(w * s)), max(1, int(h * s)))


def export():
    OUT.parent.mkdir(parents=True, exist_ok=True)
    cap_textures()
    with quiet():
        bpy.ops.export_scene.gltf(
            filepath=str(OUT), export_format="GLB", use_active_scene=True,
            export_apply=True, export_image_format="JPEG", export_jpeg_quality=85,
            export_draco_mesh_compression_enable=True, export_draco_mesh_compression_level=6,
            export_lights=False, export_cameras=False,
        )
    print("exported", OUT.name, round(OUT.stat().st_size / 1e6, 2), "MB")


def stats():
    meshes = [o for o in bpy.context.scene.objects if o.type == "MESH" and not o.name.startswith("COL_")]
    tris = sum(sum(len(p.vertices) - 2 for p in o.data.polygons) for o in meshes)
    slots = sum(len(o.data.materials) for o in meshes)
    print(f"objects {len(meshes)}  tris {tris}  material slots (~draw calls) {slots}")
