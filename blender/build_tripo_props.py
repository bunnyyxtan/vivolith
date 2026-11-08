"""Tripo assets -> game-ready GLBs: real-world scale, forward = Blender -Y (glTF +Z), on the ground,
COL_ collision box, textures capped at 1024 px, Draco + WebP.

Sources: assets-src/tripo/out/ (API) and assets-src/tripo/library/ (Studio exports), both git-ignored;
see assets-src/tripo/PLAN.md. Run headless (preferred, no clash with other Blender users):
    blender -b --factory-startup --python-expr "exec(open(r'C:/Bunnyy/Hackathons/NEAR/blender/build_tripo_props.py').read()); build('<name>')"
In the live MCP Blender: exec(...); use()  then, in a second call, exec(...); build_all()
"""
import bpy, math, pathlib
import numpy as np
from mathutils import Matrix, Vector

REPO = pathlib.Path(r"C:/Bunnyy/Hackathons/NEAR")
SRC = REPO / "assets-src/tripo"  # out/ = API results, library/ = Studio exports
OUT = REPO / "public/models/v2/props"
MINT = np.array([0.62, 0.92, 0.82])  # body tint for NEAR City fleet paint (multiplies near-white texels)

# name: (source glb, size metres, measured axis "length"|"width"|"height", yaw to face -Y, collider)
PROPS = {
    "ev_sedan": ("out/ev/tripo-out/ev-p2-texture-35cad1e2/model.glb", 4.6, "length", -math.pi / 2, True),
    "ev_pickup": ("out/truck/tripo-out/truck-p2-texture-c86d8288/model.glb", 5.7, "length", 0.0, True),  # P2: flat panels (v3.1 was dented)
    "stall_fruit": ("out/stall/tripo-out/stall-p2-texture-6847743a/model.glb", 3.4, "width", 0.0, True),
    "vending_mint": ("library/vending_mint.fbx", 1.85, "height", -math.pi / 2, True),
    "kiosk_drinks": ("library/kiosk_drinks.fbx", 3.4, "width", -math.pi / 2, True),  # Spire Square drinks kiosk
    "shop_corner": ("out/shop/tripo-out/shop-v31-texture-551f6d27/model.glb", 7.2, "height", -math.pi / 2, True),
    "food_truck": ("library/food_truck.glb", 5.4, "width", 0.0, True),  # Studio H3.1 text-to-3D; hatch already faces -Y
    "coffee_truck": ("library/coffee_truck.glb", 5.0, "width", 0.0, True),  # Studio H3.1, the yard's second truck
}
MAX_TRIS = 40000  # v3.1 meshes arrive dense (the shop is ~1.4M triangles)


def decimate(obj):
    tris = sum(len(p.vertices) - 2 for p in obj.data.polygons)
    if tris <= MAX_TRIS:
        return
    m = obj.modifiers.new("dec", "DECIMATE")
    m.ratio = MAX_TRIS / tris
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(obj.evaluated_get(dg))
    obj.modifiers.remove(m)
    old = obj.data
    obj.data = me
    bpy.data.meshes.remove(old)


def import_mesh(rel):
    """GLB/GLTF (API outputs, gallery exports) or FBX (Studio Smart Mesh exports); several meshes are joined."""
    path = SRC / rel
    before = set(bpy.data.objects)
    if path.suffix.lower() == ".fbx":
        bpy.ops.import_scene.fbx(filepath=str(path))
    else:
        bpy.ops.import_scene.gltf(filepath=str(path))
    new = [o for o in bpy.data.objects if o not in before]
    meshes = [o for o in new if o.type == "MESH"]
    for o in meshes:  # bake parent/node transforms before dropping the empties
        o.data.transform(o.matrix_world)
        o.parent = None
        o.matrix_world = Matrix.Identity(4)
    for o in new:
        if o.type != "MESH":
            bpy.data.objects.remove(o)
    if len(meshes) > 1:
        with bpy.context.temp_override(active_object=meshes[0], selected_editable_objects=meshes):
            bpy.ops.object.join()
    return meshes[0]


def bounds(obj):
    co = np.array([v.co[:] for v in obj.data.vertices])
    return Vector(co.min(axis=0)), Vector(co.max(axis=0))


def bake_transform(obj, yaw, size, axis):
    """Data-level transform (no operators: they act on whichever view layer the context holds)."""
    obj.data.transform(obj.matrix_world)  # bake the import's node transform
    obj.matrix_world = Matrix.Identity(4)
    obj.data.transform(Matrix.Rotation(yaw, 4, "Z"))
    lo, hi = bounds(obj)
    d = hi - lo
    s = size / {"length": d.y, "width": d.x, "height": d.z}[axis]
    obj.data.transform(Matrix.Scale(s, 4))
    lo, hi = bounds(obj)
    obj.data.transform(Matrix.Translation(-Vector(((lo.x + hi.x) / 2, (lo.y + hi.y) / 2, lo.z))))
    obj.data.update()
    return hi - lo


def image_of(obj):
    return next(n.image for m in obj.data.materials for n in m.node_tree.nodes if n.type == "TEX_IMAGE" and n.image)


def pixels(img):
    return np.array(img.pixels[:], dtype=np.float32).reshape(img.size[1], img.size[0], 4)


def store(img, px):
    img.pixels.foreach_set(px.ravel())
    img.update()


def clean_badge(obj, img):
    """Paint out the maker's badge Tripo copied onto the hood (front centre, upward faces)."""
    me, uv = obj.data, obj.data.uv_layers.active.data
    lo, hi = bounds(obj)
    px = pixels(img)
    h, w = px.shape[:2]
    mask = np.zeros((h, w), bool)
    yy, xx = np.mgrid[0:h, 0:w]
    for p in me.polygons:  # rasterise only the hood-front faces' own UV triangles
        c = p.center
        if not (c.y < lo.y + 0.12 * (hi.y - lo.y) and abs(c.x) < 0.3 and p.normal.z > 0.2):
            continue
        t = [(uv[li].uv.x * w, uv[li].uv.y * h) for li in p.loop_indices]
        for a, b, cc in ((t[0], t[i], t[i + 1]) for i in range(1, len(t) - 1)):
            x0, x1 = int(min(a[0], b[0], cc[0])), int(max(a[0], b[0], cc[0])) + 2
            y0, y1 = int(min(a[1], b[1], cc[1])), int(max(a[1], b[1], cc[1])) + 2
            X, Y = xx[y0:y1, x0:x1] + 0.5, yy[y0:y1, x0:x1] + 0.5
            d = (b[1] - cc[1]) * (a[0] - cc[0]) + (cc[0] - b[0]) * (a[1] - cc[1])
            if abs(d) < 1e-9:
                continue
            l1 = ((b[1] - cc[1]) * (X - cc[0]) + (cc[0] - b[0]) * (Y - cc[1])) / d
            l2 = ((cc[1] - a[1]) * (X - cc[0]) + (a[0] - cc[0]) * (Y - cc[1])) / d
            mask[y0:y1, x0:x1] |= (l1 >= 0) & (l2 >= 0) & (1 - l1 - l2 >= 0)
    if not mask.any():
        print("badge: no hood faces found"); return
    rgb = px[..., :3]
    lum = rgb.mean(axis=2)
    body = np.median(rgb[mask & (lum > np.percentile(lum[mask], 50))], axis=0)
    dark = mask & (lum < body.mean() - 0.12)
    rgb[dark] = body
    store(img, px)
    print("badge: hood texels", int(mask.sum()), "cleaned", int(dark.sum()))


def tint_body(img):
    px = pixels(img)
    rgb = px[..., :3]
    lum, sat = rgb.mean(axis=2), rgb.max(axis=2) - rgb.min(axis=2)
    paint = (lum > 0.62) & (sat < 0.12)
    rgb[paint] *= MINT
    store(img, px)
    print("tint: painted", int(paint.sum()), "texels")


def sharpen(obj, degrees=35):
    """Hard-surface look: smooth inside panels, crisp split normals across edges sharper than `degrees`."""
    me = obj.data
    me.shade_smooth()
    me.set_sharp_from_angle(angle=math.radians(degrees))


def posterize(img, k=14, iters=8, seed=3):
    """Flat anime colour blocks: k-means the texture to k colours (removes generation noise and blotches)."""
    px = pixels(img)
    rgb = px[..., :3].reshape(-1, 3)
    rng = np.random.default_rng(seed)
    sample = rgb[rng.choice(len(rgb), 60000, replace=False)]
    cent = sample[rng.choice(len(sample), k, replace=False)]
    for _ in range(iters):
        lab = ((sample[:, None, :] - cent[None]) ** 2).sum(-1).argmin(1)
        for j in range(k):
            sel = sample[lab == j]
            if len(sel):
                cent[j] = sel.mean(0)
    out = np.empty(len(rgb), np.int64)
    for s in range(0, len(rgb), 262144):  # chunked nearest-centre assignment
        out[s:s + 262144] = ((rgb[s:s + 262144, None, :] - cent[None]) ** 2).sum(-1).argmin(1)
    px[..., :3] = cent[out].reshape(px.shape[0], px.shape[1], 3)
    store(img, px)


def cap_texture(img, max_px=1024):
    w, h = img.size
    if max(w, h) > max_px:
        img.scale(max_px, max_px)
    if img.is_dirty:
        img.pack()  # edited pixels are dropped by the exporter until repacked


def add_collider(sc, name, dims):
    x, y, z = dims.x / 2, dims.y / 2, dims.z
    me = bpy.data.meshes.new("COL_" + name)
    vs = [(sx * x, sy * y, sz) for sz in (0, z) for sy in (-1, 1) for sx in (-1, 1)]
    fs = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
    me.from_pydata(vs, [], fs)
    c = bpy.data.objects.new("COL_" + name, me)
    sc.collection.objects.link(c)
    return c


def export(objs, name):
    """Exports exactly `objs` (selection is per view layer, so other scenes' selections never leak in)."""
    OUT.mkdir(parents=True, exist_ok=True)
    vl = active_scene().view_layers[0]
    for o in vl.objects:
        o.select_set(o in objs, view_layer=vl)
    path = OUT / f"{name}.glb"
    bpy.ops.export_scene.gltf(filepath=str(path), export_format="GLB", use_selection=True, use_active_scene=True,
                              export_draco_mesh_compression_enable=True, export_image_format="WEBP",
                              export_lights=False, export_cameras=False, export_animations=False)
    print("exported", path.name, round(path.stat().st_size / 1e6, 2), "MB")


def build(name):
    rel, size, axis, yaw, collide = PROPS[name]
    sc = active_scene()
    for o in list(sc.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    obj = import_mesh(rel)
    obj.name = name
    dims = bake_transform(obj, yaw, size, axis)
    decimate(obj)
    img = image_of(obj)
    img.name = name + "_tex"
    if name.startswith("ev_"):
        clean_badge(obj, img)
    if name == "ev_sedan":  # NEAR City fleet mint; the pickup keeps its stainless finish
        tint_body(img)
    if name.startswith("ev_"):  # vehicles: crisp panel edges and clean flat paint
        sharpen(obj)
        posterize(img)
    cap_texture(img, 2048 if name.startswith("shop") else 1024)  # facades are seen up close and large
    objs = [obj]
    if collide:
        objs.append(add_collider(sc, name, dims))
    print(name, "dims", tuple(round(v, 2) for v in dims), "tris", sum(len(p.vertices) - 2 for p in obj.data.polygons))
    export(objs, name)
    return obj


CHARACTERS = {  # name: Tripo retarget output (Mixamo-spec rig + preset clips)
    "merchant_fruit": "out/merchant/tripo-out/merchant-anim-25c784bf/model.glb",
}
CAST_OUT = REPO / "public/models/v2/cast"


def build_character(name):
    """Rigged Tripo character: face Blender -Y, clips renamed Idle/Walk/..., NLA-track export."""
    sc = active_scene()
    for o in list(sc.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    before_o, before_a = set(bpy.data.objects), set(bpy.data.actions)
    bpy.ops.import_scene.gltf(filepath=str(SRC / CHARACTERS[name]))
    for o in [o for o in bpy.data.objects if o not in before_o and o.name.startswith("Icosphere")]:
        bpy.data.objects.remove(o)
    arm = next(o for o in sc.objects if o.type == "ARMATURE")
    mesh = next(o for o in sc.objects if o.type == "MESH")
    arm.name, mesh.name = name + "_rig", name + "_body"
    toe = arm.data.bones["mixamorig:LeftToeBase"].head_local - arm.data.bones["mixamorig:LeftFoot"].head_local
    arm.rotation_mode = "XYZ"
    arm.rotation_euler = (0, 0, -math.pi / 2 - math.atan2(toe.y, toe.x))  # turn the toes toward -Y
    ad = arm.animation_data
    for t in list(ad.nla_tracks):
        ad.nla_tracks.remove(t)
    for act in [a for a in bpy.data.actions if a not in before_a]:
        clip = act.name.split(".")[0].capitalize()
        act.name = f"{name}_{clip}"
        act.use_fake_user = True
        track = ad.nla_tracks.new()
        track.name = clip
        strip = track.strips.new(clip, int(act.frame_range[0]), act)
        slots = getattr(act, "slots", None)
        if slots and hasattr(strip, "action_slot"):
            strip.action_slot = slots[0]
    ad.action = None
    cap_texture(image_of(mesh))
    path = CAST_OUT / f"{name}.glb"
    bpy.ops.export_scene.gltf(
        filepath=str(path), export_format="GLB", use_active_scene=True,
        export_animations=True, export_animation_mode="NLA_TRACKS", export_skins=True,
        export_force_sampling=True, export_optimize_animation_size=True,
        export_draco_mesh_compression_enable=True, export_image_format="WEBP",
        export_lights=False, export_cameras=False)
    print(name, "toe", tuple(round(v, 3) for v in toe), "clips", [t.name for t in ad.nla_tracks],
          "tris", sum(len(p.vertices) - 2 for p in mesh.data.polygons), round(path.stat().st_size / 1e6, 2), "MB")


def active_scene():
    """Headless (blender -b, preferred: no clash with other agents) uses the default scene; in the live UI the
    TripoProps scene must be made active in a separate call first (use()), since operators keep the old view layer."""
    if bpy.app.background or bpy.context.window is None:
        return bpy.context.scene
    sc = bpy.context.window.scene
    assert sc.name == "TripoProps", "live Blender: call use() in a separate call first"
    return sc


def use():
    bpy.context.window.scene = bpy.data.scenes.get("TripoProps") or bpy.data.scenes.new("TripoProps")


def build_all():
    for name in PROPS:
        build(name)
