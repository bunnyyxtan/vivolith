"""VIVOLITH v2 cast: parametric anime characters on the Remy Mixamo rig (same skeleton as Kavi, so all clips are shared).
Exports public/models/v2/cast/<id>.glb with NLA clips Idle, Walk, Run, Talking.

Run inside Blender:
    exec(open(r"C:/Bunnyy/Hackathons/NEAR/blender/build_cast_v2.py").read()); build_all()
    (or build_one("pema"); export_one("pema"))

Method: reuses build_kavi.py (rig joints, skin-tube body, anime head/eyes, distance weights, clip import), then per
character swaps the palette, drops Kavi-only parts (hood, bag, strap, spikes) and adds a hair style and props.
Body colour roles from build_kavi.body(): cream = chest/shoulders/sleeves, teal = mid torso (apron, vest),
tealdark = hem + cuffs, pants, shoe/shoeteal/sole.
"""
import bpy, bmesh, math, random
from mathutils import Vector, Matrix

exec(open(r"C:/Bunnyy/Hackathons/NEAR/blender/build_kavi.py").read())  # rig, body, head, bind, add_clips, helpers

CAST_DIR = REPO / "public" / "models" / "v2" / "cast"
ANIMS = {"Idle": MIX / "Idle.fbx", "Walk": MIX / "Walking.fbx", "Run": MIX / "Running.fbx", "Talking": MIX / "Talking.fbx"}

# palette: top, mid, hem, pants, skin, hair, iris, shoe, accent ; hair style ; props
CAST_V2 = {
    "pema":    dict(c=("efe4cc", "3f8f4e", "2f6e3c", "6b4a35", "d9a27f", "2a1d17", "5a3a22", "8a5a3a", "2f9a85"), hair="bun", props=["scarf"]),
    "tomas":   dict(c=("f2f2ee", "23262d", "1a1c21", "2b2e36", "e8bc9a", "121318", "3b4a5a", "1d1d20", "c29a4a"), hair="slick", props=["tie"]),
    "marta":   dict(c=("f4ede0", "b8553a", "8f3f2a", "3c3a44", "f0c7a8", "6b3b23", "6b8f3a", "5a3d2c", "e8c36a"), hair="bob", props=[]),
    "ines":    dict(c=("fbfbf8", "f2f2ef", "dfe3e6", "2e3a4a", "c98e6c", "1a1a22", "2f9a85", "e9ebee", "00ec97"), hair="short", props=["badge"]),
    "folk1":   dict(c=("f2c94c", "e0a83a", "b88628", "34495e", "f3cbb0", "a0522d", "4a6fa5", "f2f2f2", "e74c3c"), hair="ponytail", props=["backpack"]),
    "folk2":   dict(c=("5dade2", "3d8bc0", "2c6e99", "e8e0cc", "8d5a3b", "141414", "3a2a1a", "2b2b2b", "ffffff"), hair="cap", props=["cap"]),
    "folk3":   dict(c=("e98aa6", "d0668a", "a84d6c", "2a2a33", "f6d5c0", "d8b25c", "7a5ab8", "f7f7f4", "f7f7f4"), hair="bob", props=[]),
    "folk4":   dict(c=("7dcea0", "52b37e", "3a8a5e", "4a4a52", "e8b890", "3a2418", "2a6a3a", "f0e6d2", "ffd27a"), hair="spiky", props=["backpack"]),
    "folk5":   dict(c=("cfc6e8", "9b8cc9", "7565a8", "1e2a3a", "b47a55", "0f0f14", "2a1a10", "dcdcdc", "e8c36a"), hair="ponytail", props=["cap"]),
    "folk6":   dict(c=("e67e22", "c0651a", "974f14", "2f3640", "f3cbb0", "5a4a3a", "3a6a8a", "34495e", "ffffff"), hair="short", props=["backpack"]),
}


def palette(cid, c):
    top, mid, hem, pants, skin, hair, iris, shoe, acc = c
    m = lambda n, h, r=0.7, e=None: _cmat(cid, n, h, r, e)
    M.clear()
    M.update(cream=m("top", top, 0.85), teal=m("mid", mid, 0.8), tealdark=m("hem", hem, 0.8), pants=m("pants", pants, 0.85),
             skin=m("skin", skin, 0.6), hair=m("hair", hair, 0.45), eye=m("eye", "1d2430", 0.3), iris=m("iris", iris, 0.3),
             shine=m("eye_shine", "ffffff", 0.2, "ffffff"), brow=m("brow", hair, 0.6), mouth=m("mouth", "b5675d", 0.6),
             shoe=m("shoe", shoe, 0.6), shoeteal=m("shoe_acc", acc, 0.55), sole=m("sole", "f7f7f4", 0.7),
             bag=m("bag", acc, 0.75), strap=m("strap", "3b3027", 0.7), metal=m("metal", "c9ccd2", 0.3), band=m("band", acc, 0.5),
             acc=m("acc", acc, 0.6))


def _cmat(cid, name, hexc, rough, emit):
    full = f"cast_{cid}_{name}"
    mm = bpy.data.materials.get(full) or bpy.data.materials.new(full)
    mm.use_nodes = True
    b = next(n for n in mm.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    b.inputs["Base Color"].default_value = (*lin(hexc), 1)
    b.inputs["Roughness"].default_value = rough
    b.inputs["Metallic"].default_value = 0.0
    if emit:
        b.inputs["Emission Color"].default_value = (*lin(emit), 1)
        b.inputs["Emission Strength"].default_value = 1.0
    return mm


def cast_rig(cid):
    sc = bpy.data.scenes.get("Cast_" + cid) or bpy.data.scenes.new("Cast_" + cid)
    bpy.context.window.scene = sc
    for o in list(sc.objects):
        bpy.data.objects.remove(o)
    before = set(bpy.data.objects)
    with quiet():
        bpy.ops.import_scene.fbx(filepath=str(MIX / "Remy.fbx"), automatic_bone_orientation=False)
    new = [o for o in bpy.data.objects if o not in before]
    arm = next(o for o in new if o.type == "ARMATURE")
    for o in new:
        if o is not arm:
            bpy.data.objects.remove(o)
    arm.name = cid + "_rig"
    if arm.animation_data:
        arm.animation_data.action = None
    return arm


def _box(name, c, s, material, rot=None, bevel=0.02):
    bm = bmesh.new()
    g = bmesh.ops.create_cube(bm, size=1.0)["verts"]
    bmesh.ops.scale(bm, vec=s, verts=g)
    if rot:
        bmesh.ops.rotate(bm, verts=g, cent=(0, 0, 0), matrix=rot)
    bmesh.ops.translate(bm, vec=c, verts=g)
    if bevel:
        bmesh.ops.bevel(bm, geom=bm.edges[:], offset=bevel, segments=2, affect="EDGES")
    o = obj_from_bm(name, bm, material)
    for p in o.data.polygons:
        p.use_smooth = True
    return o


def hair_style(cid, style, J, parts, rnd):
    hd = J["Head"][0]
    c = Vector((hd.x, hd.y - 0.02, hd.z + 0.19))
    H = M["hair"]
    if style == "spiky":
        return  # keep Kavi's spikes
    bpy.data.objects.remove(parts.pop("hair_spikes")[0])
    if style in ("bun", "ponytail", "bob"):  # longer volume: fuller cap over the back of the head
        parts[f"hair_back"] = (ellipsoid(f"{cid}_hair_back", c + Vector((0, 0.07, -0.02)), (0.3, 0.26, 0.3), H, 24, 16), ["Head"])
    if style == "bun":
        parts["bun"] = (ellipsoid(f"{cid}_bun", c + Vector((0, 0.2, 0.22)), (0.15, 0.14, 0.14), H, 16, 12), ["Head"])
    if style == "ponytail":
        tail = skin_tube(f"{cid}_tail", [c + Vector((0, 0.27, 0.12)), c + Vector((0, 0.36, -0.08)), c + Vector((0, 0.34, -0.38))],
                         [(0.09, 0.09), (0.08, 0.07), (0.03, 0.03)], H, subdiv=1)
        parts["tail"] = (tail, ["Head", "Neck"])
    if style == "bob":
        bob = ellipsoid(f"{cid}_bob", c + Vector((0, 0.04, -0.06)), (0.34, 0.32, 0.3), H, 28, 18)
        bm = bmesh.new(); bm.from_mesh(bob.data)
        bmesh.ops.delete(bm, geom=[v for v in bm.verts if v.co.y < c.y - 0.12 and v.co.z < c.z + 0.12 or v.co.z < c.z - 0.3], context="VERTS")
        bm.to_mesh(bob.data); bm.free()
        parts["bob"] = (bob, ["Head"])
    if style in ("bob", "bun", "ponytail", "short"):  # soft fringe bangs over the forehead
        bm = bmesh.new()
        for k in range(9):
            x = -0.2 + 0.4 * k / 8
            base = c + Vector((x, -0.2, 0.21 - abs(x) * 0.3))
            cone(bm, base, base + Vector((x * 0.2, -0.08, -rnd.uniform(0.1, 0.16))), 0.06, 6)
        fr = obj_from_bm(f"{cid}_fringe", bm, H)
        parts["fringe"] = (fr, ["Head"])
    if style == "slick":  # swept back: a smooth crest over the cap
        parts["slick"] = (ellipsoid(f"{cid}_slick", c + Vector((0, 0.05, 0.12)), (0.29, 0.31, 0.24), H, 24, 14), ["Head"])
    if style == "short":
        bm = bmesh.new()
        for k in range(26):
            u = rnd.uniform(0, 2 * math.pi); v = rnd.uniform(0.2, 1.0)
            n = Vector((math.cos(u) * math.cos(v), math.sin(u) * math.cos(v), math.sin(v)))
            if n.y < -0.5 and v < 0.5:
                continue
            base = c + Vector((n.x * 0.28, n.y * 0.29 + 0.02, n.z * 0.3 + 0.04))
            cone(bm, base, base + n * rnd.uniform(0.06, 0.1), 0.06, 6)
        parts["tufts"] = (obj_from_bm(f"{cid}_tufts", bm, H), ["Head"])


def props(cid, items, J, parts):
    hd = J["Head"][0]
    c = Vector((hd.x, hd.y - 0.02, hd.z + 0.19))
    S2, Nk, Hp = J["Spine2"][0], J["Neck"][0], J["Hips"][0]
    for it in items:
        if it == "scarf":  # headscarf band (bandana) around the crown
            parts["scarf"] = (skin_tube(f"{cid}_scarf", [c + Vector((0.31, 0.0, 0.1)), c + Vector((0, -0.27, 0.2)), c + Vector((-0.31, 0.0, 0.1)), c + Vector((0, 0.31, 0.12))],
                                        [(0.05, 0.05)] * 4, M["acc"], [(0, 1), (1, 2), (2, 3), (3, 0)], subdiv=1), ["Head"])
        if it == "cap":
            parts["cap"] = (ellipsoid(f"{cid}_cap", c + Vector((0, 0.01, 0.09)), (0.3, 0.31, 0.24), M["acc"], 24, 12), ["Head"])
            parts["brim"] = (_box(f"{cid}_brim", c + Vector((0, -0.33, 0.12)), (0.3, 0.2, 0.025), M["acc"], Matrix.Rotation(-0.15, 3, "X")), ["Head"])
        if it == "backpack":
            parts["pack"] = (_box(f"{cid}_pack", Vector((0, 0.32, (S2.z + Hp.z) / 2 + 0.12)), (0.42, 0.2, 0.5), M["acc"], bevel=0.05), ["Spine1", "Spine2"])
        if it == "tie":
            parts["tie"] = (_box(f"{cid}_tie", Vector((0, -0.27, S2.z + 0.02)), (0.07, 0.03, 0.4), M["acc"], bevel=0.0), ["Spine1", "Spine2"])
        if it == "badge":
            parts["badge"] = (_box(f"{cid}_badge", Vector((0.15, -0.27, S2.z + 0.08)), (0.08, 0.02, 0.1), M["acc"], bevel=0.0), ["Spine2"])


def build_one(cid):
    spec = CAST_V2[cid]
    rnd = random.Random(hash(cid) & 0xffff)
    palette(cid, spec["c"])
    arm = cast_rig(cid)
    J = joints(arm)
    parts = body(J)
    for k in ("hood", "bag", "strap", "pockets"):
        o, _ = parts.pop(k)
        bpy.data.objects.remove(o)
    parts.update(head(J))
    hair_style(cid, spec["hair"], J, parts, rnd)
    props(cid, spec["props"], J, parts)
    b = bind(arm, J, parts)
    b.name = cid + "_body"
    add_clips(arm)
    for t in arm.animation_data.nla_tracks:
        for s in t.strips:
            s.action.name = f"{cid}_{t.name}"
    print(cid, "tris", sum(len(p.vertices) - 2 for p in b.data.polygons), "mats", len(b.data.materials),
          "clips", [t.name for t in arm.animation_data.nla_tracks])


def export_one(cid):
    CAST_DIR.mkdir(parents=True, exist_ok=True)
    out = CAST_DIR / f"{cid}.glb"
    with quiet():
        bpy.ops.export_scene.gltf(
            filepath=str(out), export_format="GLB", use_active_scene=True,
            export_animations=True, export_animation_mode="NLA_TRACKS", export_skins=True,
            export_force_sampling=True, export_optimize_animation_size=True,
            export_lights=False, export_cameras=False,
        )
    print("exported", out.name, round(out.stat().st_size / 1e6, 2), "MB")


def build_all():
    for cid in CAST_V2:
        build_one(cid)
        export_one(cid)
