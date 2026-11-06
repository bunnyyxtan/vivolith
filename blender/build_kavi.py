"""Builds Kavi, VIVOLITH's hero, on the Mixamo skeleton and exports public/models/v2/kavi.glb.

Run inside Blender (MCP for Blender):
    exec(open(r"C:/Bunnyy/Hackathons/NEAR/blender/build_kavi.py").read()); build(); export()

Look (reference videos, 2026-11-06): anime-styled teen, spiky black hair, cream hoodie with teal colour blocks and
a cream hood, tan crossbody bag on a dark strap, black cargo joggers cuffed at the ankle, cream/teal sneakers.
Method: the Remy Mixamo armature (rest T-pose) is the skeleton, so every Mixamo clip we own drives Kavi. Body parts
are skin-modifier tubes along the bones (smooth, closed, quad topology), plus modelled head, face, hair spikes,
hood, bag and shoes; weights come from distance to each part's own bones (top-3, normalised).
Units: the imported armature's world space (head top at ~3.72); the game scales him to 1.70 m.
"""
import bpy, bmesh, math, random, io, contextlib, pathlib
from mathutils import Vector, Matrix

REPO = pathlib.Path(r"C:/Bunnyy/Hackathons/NEAR")
MIX = REPO / "Mixamo"
OUT = REPO / "public" / "models" / "v2" / "kavi.glb"
ANIMS = {"Idle": MIX / "pema_talking.fbx", "Walk": MIX / "Walking.fbx", "Run": MIX / "Running.fbx"}
rng = random.Random(7)


def quiet():
    s = contextlib.ExitStack()
    s.enter_context(contextlib.redirect_stdout(io.StringIO()))
    s.enter_context(contextlib.redirect_stderr(io.StringIO()))
    return s


def lin(h):
    h = h.lstrip("#")
    c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return tuple(((v + 0.055) / 1.055) ** 2.4 if v > 0.04045 else v / 12.92 for v in c)


def mat(name, hexc, rough=0.7, metal=0.0, emit=None):
    m = bpy.data.materials.get("kavi_" + name) or bpy.data.materials.new("kavi_" + name)
    m.use_nodes = True
    b = next(n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    b.inputs["Base Color"].default_value = (*lin(hexc), 1)
    b.inputs["Roughness"].default_value = rough
    b.inputs["Metallic"].default_value = metal
    if emit:
        b.inputs["Emission Color"].default_value = (*lin(emit), 1)
        b.inputs["Emission Strength"].default_value = 1.0
    return m


M = {}


def materials():
    M.update(
        cream=mat("hoodie_cream", "ebe2cf", 0.85), teal=mat("hoodie_teal", "2f9a85", 0.8),
        tealdark=mat("cuff_teal", "236f62", 0.8), pants=mat("pants", "24272d", 0.85),
        skin=mat("skin", "f3cbb0", 0.6), hair=mat("hair", "15171e", 0.45),
        eye=mat("eye", "1d2430", 0.3), iris=mat("iris", "2d6f8f", 0.3), shine=mat("eye_shine", "ffffff", 0.2, emit="ffffff"),
        brow=mat("brow", "1a1b20", 0.6), mouth=mat("mouth", "b5675d", 0.6),
        shoe=mat("shoe", "efe9de", 0.6), shoeteal=mat("shoe_teal", "43c2a0", 0.55), sole=mat("sole", "f7f7f4", 0.7),
        bag=mat("bag", "d6c39f", 0.75), strap=mat("strap", "3b3027", 0.7), metal=mat("buckle", "c9ccd2", 0.3, 0.9),
        band=mat("wristband", "1c1e23", 0.5),
    )


# ------------------------------------------------------------------ rig ----
def rig():
    sc = bpy.data.scenes.get("Kavi") or bpy.data.scenes.new("Kavi")
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
    arm.name = "kavi_rig"
    if arm.animation_data:
        arm.animation_data.action = None
    return arm


def joints(arm):
    mw = arm.matrix_world
    J = {}
    for b in arm.data.bones:
        n = b.name.replace("mixamorig:", "")
        J[n] = (mw @ b.head_local, mw @ b.tail_local)
    return J


# ------------------------------------------------------------- builders ----
def obj_from_bm(name, bm, material):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    me.materials.append(material)
    o = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(o)
    return o


def skin_tube(name, pts, radii, material, edges=None, subdiv=2):
    """Skin-modifier tube through points with per-point (rx, ry) radii, subdivided and applied."""
    me = bpy.data.meshes.new(name)
    edges = edges or [(i, i + 1) for i in range(len(pts) - 1)]
    me.from_pydata([tuple(p) for p in pts], edges, [])
    o = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(o)
    sk = o.modifiers.new("skin", "SKIN")
    sk.use_smooth_shade = True
    for v, r in zip(me.skin_vertices[0].data, radii):
        v.radius = r
    me.skin_vertices[0].data[0].use_root = True
    sd = o.modifiers.new("sub", "SUBSURF")
    sd.levels = subdiv
    sd.render_levels = subdiv
    dg = bpy.context.evaluated_depsgraph_get()
    new_me = bpy.data.meshes.new_from_object(o.evaluated_get(dg))
    o.modifiers.clear()
    o.data = new_me
    bpy.data.meshes.remove(me)
    o.data.materials.append(material)
    for p in o.data.polygons:
        p.use_smooth = True
    return o


def ellipsoid(name, c, r, material, segs=24, rings=16, rot=None):
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=segs, v_segments=rings, radius=1.0)
    bmesh.ops.scale(bm, vec=Vector(r), verts=bm.verts)
    if rot:
        bmesh.ops.rotate(bm, verts=bm.verts, cent=(0, 0, 0), matrix=rot)
    bmesh.ops.translate(bm, vec=Vector(c), verts=bm.verts)
    o = obj_from_bm(name, bm, material)
    for p in o.data.polygons:
        p.use_smooth = True
    return o


def cone(bm, base, tip, r, segs=6):
    axis = (tip - base)
    z = axis.normalized()
    x = z.orthogonal().normalized()
    y = z.cross(x)
    ring = [bm.verts.new(base + (x * math.cos(a) + y * math.sin(a)) * r) for a in (2 * math.pi * k / segs for k in range(segs))]
    t = bm.verts.new(tip)
    for k in range(segs):
        bm.faces.new((ring[k], ring[(k + 1) % segs], t))
    bm.faces.new(list(reversed(ring)))


def recolor_below(o, z, material, above=True):
    """Assign `material` to faces whose centre is below (above=False) / above z."""
    if material.name not in [m.name for m in o.data.materials]:
        o.data.materials.append(material)
    idx = [m.name for m in o.data.materials].index(material.name)
    mw = o.matrix_world
    for p in o.data.polygons:
        cz = (mw @ p.center).z
        if (cz > z) == above:
            p.material_index = idx


# ----------------------------------------------------------------- body ----
def body(J):
    parts = {}
    H, Sp, S1, S2, Nk, Hd = (J[k][0] for k in ("Hips", "Spine", "Spine1", "Spine2", "Neck", "Head"))
    lift = lambda p, dz=0.0, dy=0.0, dx=0.0: Vector((p.x + dx, p.y + dy, p.z + dz))
    # Hoodie torso + sleeves (one skin mesh with branches at the upper chest).
    chest = lift(S2, 0.18)
    pts = [lift(H, -0.16, 0.02), lift(H, 0.02, 0.02), lift(Sp, 0, 0.02), lift(S1, 0, 0.01), lift(S2, 0, 0.0), chest, lift(Nk, 0.02)]
    rad = [(0.37, 0.26), (0.35, 0.25), (0.33, 0.235), (0.355, 0.25), (0.39, 0.265), (0.36, 0.24), (0.17, 0.16)]
    edges = [(i, i + 1) for i in range(6)]
    for side in ("Left", "Right"):
        sh, ar, fa, hd = (J[f"{side}{k}"][0] for k in ("Shoulder", "Arm", "ForeArm", "Hand"))
        s = 1 if side == "Left" else -1
        base = len(pts)
        pts += [lift(ar, -0.02, 0.01, -0.06 * s), lift(ar.lerp(fa, 0.5), 0, 0.01), lift(fa, 0, 0.01), lift(hd, 0, 0.0, -0.06 * s)]
        rad += [(0.135, 0.135), (0.12, 0.115), (0.105, 0.1), (0.092, 0.09)]
        edges += [(5, base), (base, base + 1), (base + 1, base + 2), (base + 2, base + 3)]
    torso = skin_tube("kavi_hoodie", pts, rad, M["cream"], edges)
    # Colour blocking (reference): teal mid-torso panel, cream shoulders/chest, dark teal hem and cuffs.
    recolor_below(torso, S1.z + 0.18, M["teal"], above=False)
    recolor_below(torso, H.z - 0.02, M["tealdark"], above=False)
    mw = torso.matrix_world
    idx_cuff = len(torso.data.materials)
    torso.data.materials.append(M["tealdark"])
    for p in torso.data.polygons:
        c = mw @ p.center
        if abs(c.x) > J["LeftHand"][0].x - 0.14 and c.z > H.z + 0.3:
            p.material_index = idx_cuff
    parts["hoodie"] = (torso, ["Hips", "Spine", "Spine1", "Spine2", "Neck", "LeftShoulder", "LeftArm", "LeftForeArm", "LeftHand",
                               "RightShoulder", "RightArm", "RightForeArm", "RightHand"])
    # Hood bunched behind the neck (a horseshoe tube), cream with a teal centre stripe.
    hood_pts, hood_r = [], []
    for k in range(9):
        a = math.pi * (0.1 + 0.8 * k / 8)
        hood_pts.append(Vector((math.cos(a) * 0.2, 0.1 + math.sin(a) * 0.16, Nk.z - 0.04 + math.sin(a) * 0.05)))
        hood_r.append((0.085, 0.085))
    hood = skin_tube("kavi_hood", hood_pts, hood_r, M["cream"])
    parts["hood"] = (hood, ["Spine2", "Neck"])
    # Neck.
    neck = skin_tube("kavi_neck", [lift(Nk, -0.05), lift(Nk, 0.2, -0.02)], [(0.085, 0.085), (0.08, 0.08)], M["skin"], subdiv=1)
    parts["neck"] = (neck, ["Neck", "Head"])
    # Joggers.
    hipc = lift(H, 0.02, 0.02)
    lp, lr, le = [hipc], [(0.27, 0.2)], []
    for side in ("Left", "Right"):
        ul, lg, ft = (J[f"{side}{k}"][0] for k in ("UpLeg", "Leg", "Foot"))
        b = len(lp)
        lp += [lift(ul, -0.08), lift(ul.lerp(lg, 0.5)), lift(lg), lift(lg.lerp(ft, 0.6)), lift(ft, 0.04)]
        lr += [(0.175, 0.17), (0.158, 0.152), (0.13, 0.13), (0.112, 0.112), (0.098, 0.098)]
        le += [(0, b), (b, b + 1), (b + 1, b + 2), (b + 2, b + 3), (b + 3, b + 4)]
    pants = skin_tube("kavi_pants", lp, lr, M["pants"], le)
    parts["pants"] = (pants, ["Hips", "LeftUpLeg", "LeftLeg", "RightUpLeg", "RightLeg", "LeftFoot", "RightFoot"])
    # Ankle cuffs + cargo pockets.
    bm = bmesh.new()
    for side, s in (("Left", 1), ("Right", -1)):
        ft = J[f"{side}Foot"][0]
        ul, lg = J[f"{side}UpLeg"][0], J[f"{side}Leg"][0]
        pk = ul.lerp(lg, 0.45)
        geom = bmesh.ops.create_cube(bm, size=1.0)["verts"]
        bmesh.ops.scale(bm, vec=(0.06, 0.2, 0.24), verts=geom)
        bmesh.ops.translate(bm, vec=(pk.x + 0.16 * s, pk.y + 0.0, pk.z), verts=geom)
    pockets = obj_from_bm("kavi_pockets", bm, M["pants"])
    parts["pockets"] = (pockets, ["LeftUpLeg", "RightUpLeg"])
    for side in ("Left", "Right"):
        ft = J[f"{side}Foot"][0]
        cuff = skin_tube(f"kavi_cuff_{side}", [lift(ft, -0.1), lift(ft, 0.1)], [(0.108, 0.108), (0.104, 0.104)], M["pants"], subdiv=1)
        parts[f"cuff_{side}"] = (cuff, [f"{side}Foot", f"{side}Leg"])
    # Sneakers: chunky rounded shoes with a teal panel and white sole.
    for side in ("Left", "Right"):
        ft, te = J[f"{side}Foot"][0], J[f"{side}ToeBase"][1]
        heel = Vector((ft.x, ft.y + 0.1, 0.13))
        toe = Vector((te.x, te.y + 0.06, 0.1))
        shoe = skin_tube(f"kavi_shoe_{side}", [heel, heel.lerp(toe, 0.45), toe], [(0.12, 0.125), (0.13, 0.11), (0.11, 0.088)], M["shoe"])
        recolor_below(shoe, 0.045, M["sole"], above=False)
        sm = shoe.matrix_world
        ti = len(shoe.data.materials)
        shoe.data.materials.append(M["shoeteal"])
        for p in shoe.data.polygons:
            c = sm @ p.center
            if 0.07 < c.z < 0.17 and abs(c.x - ft.x) > 0.06 and c.y > ft.y - 0.2:
                p.material_index = ti
        parts[f"shoe_{side}"] = (shoe, [f"{side}Foot", f"{side}ToeBase"])
    # Hands (stylised mitts with a thumb) and wristbands.
    for side, s in (("Left", 1), ("Right", -1)):
        hd, tip = J[f"{side}Hand"]
        hand = ellipsoid(f"kavi_hand_{side}", hd + Vector((0.1 * s, 0, 0)), (0.11, 0.05, 0.075), M["skin"])
        th = ellipsoid(f"kavi_thumb_{side}", hd + Vector((0.06 * s, -0.06, 0.0)), (0.06, 0.03, 0.03), M["skin"], 12, 8)
        band = skin_tube(f"kavi_band_{side}", [hd + Vector((-0.07 * s, 0, 0)), hd + Vector((-0.02 * s, 0, 0))], [(0.09, 0.09), (0.09, 0.09)], M["band"], subdiv=1)
        parts[f"hand_{side}"] = (hand, [f"{side}Hand"])
        parts[f"thumb_{side}"] = (th, [f"{side}Hand"])
        parts[f"band_{side}"] = (band, [f"{side}Hand", f"{side}ForeArm"])
    # Crossbody bag (back-right hip) and strap from the left shoulder.
    bag_c = Vector((-0.28, 0.2, H.z + 0.12))
    bm = bmesh.new()
    g = bmesh.ops.create_cube(bm, size=1.0)["verts"]
    bmesh.ops.scale(bm, vec=(0.26, 0.11, 0.2), verts=g)
    bmesh.ops.translate(bm, vec=bag_c, verts=g)
    bmesh.ops.bevel(bm, geom=bm.edges[:], offset=0.025, segments=3, affect="EDGES")
    bag = obj_from_bm("kavi_bag", bm, M["bag"])
    for p in bag.data.polygons:
        p.use_smooth = True
    parts["bag"] = (bag, ["Hips", "Spine"])
    strap_pts = [Vector((0.2, -0.05, S2.z + 0.15)), Vector((0.05, -0.27, S1.z + 0.05)), Vector((-0.2, -0.2, H.z + 0.3)),
                 Vector((-0.3, 0.05, H.z + 0.2)), Vector((0.18, 0.28, S2.z + 0.12))]
    strap = skin_tube("kavi_strap", strap_pts, [(0.022, 0.01)] * 5, M["strap"], [(0, 1), (1, 2), (2, 3), (4, 0)], subdiv=1)
    parts["strap"] = (strap, ["Spine2", "Spine1", "Spine", "Hips"])
    return parts


def head(J):
    parts = {}
    hd, top = J["Head"][0], J["HeadTop_End"][0]
    c = Vector((hd.x, hd.y - 0.02, hd.z + 0.19))
    skull = ellipsoid("kavi_head", c, (0.27, 0.285, 0.31), M["skin"], 32, 20)
    parts["head"] = (skull, ["Head"])
    # Chin/jaw softening: a slightly forward lower face.
    jaw = ellipsoid("kavi_jaw", c + Vector((0, -0.07, -0.13)), (0.2, 0.2, 0.17), M["skin"], 24, 14)
    parts["jaw"] = (jaw, ["Head"])
    # Ears.
    for s in (1, -1):
        parts[f"ear{s}"] = (ellipsoid(f"kavi_ear{s}", c + Vector((0.27 * s, 0.02, -0.02)), (0.04, 0.07, 0.09), M["skin"], 12, 8), ["Head"])
    # Anime eyes: dark almond, coloured iris, two highlights; brows; small mouth; nose hint.
    fy = c.y - 0.27
    tilt = lambda s: Matrix.Rotation(-0.12 * s, 3, "Y")
    for s in (1, -1):
        e = c + Vector((0.105 * s, -0.255, -0.03))
        parts[f"eye{s}"] = (ellipsoid(f"kavi_eye{s}", e, (0.068, 0.02, 0.085), M["eye"], 16, 10, tilt(s)), ["Head"])
        parts[f"iris{s}"] = (ellipsoid(f"kavi_iris{s}", e + Vector((0, -0.012, -0.012)), (0.045, 0.012, 0.055), M["iris"], 14, 8), ["Head"])
        parts[f"shine{s}"] = (ellipsoid(f"kavi_shine{s}", e + Vector((0.02 * s, -0.022, 0.03)), (0.017, 0.006, 0.017), M["shine"], 8, 6), ["Head"])
        bm = bmesh.new()
        g = bmesh.ops.create_cube(bm, size=1.0)["verts"]
        bmesh.ops.scale(bm, vec=(0.09, 0.015, 0.016), verts=g)
        bmesh.ops.rotate(bm, verts=g, cent=(0, 0, 0), matrix=Matrix.Rotation(0.15 * s, 3, "Y"))
        bmesh.ops.translate(bm, vec=e + Vector((0.005 * s, 0.0, 0.115)), verts=g)
        parts[f"brow{s}"] = (obj_from_bm(f"kavi_brow{s}", bm, M["brow"]), ["Head"])
    parts["mouth"] = (ellipsoid("kavi_mouth", c + Vector((0, -0.262, -0.17)), (0.035, 0.008, 0.01), M["mouth"], 10, 6), ["Head"])
    parts["nose"] = (ellipsoid("kavi_nose", c + Vector((0, -0.285, -0.085)), (0.018, 0.015, 0.025), M["skin"], 8, 6), ["Head"])
    # Hair: a cap plus spiky locks (messy top, longer at the back, fringe falling over the forehead).
    cap = ellipsoid("kavi_hair_cap", c + Vector((0, 0.02, 0.045)), (0.295, 0.305, 0.31), M["hair"], 32, 20)
    bm = bmesh.new()
    bm.from_mesh(cap.data)
    doomed = [v for v in bm.verts if (v.co.z < c.z - 0.02 and v.co.y < c.y - 0.05) or v.co.z < c.z - 0.22]
    bmesh.ops.delete(bm, geom=doomed, context="VERTS")
    bm.to_mesh(cap.data)
    bm.free()
    parts["hair_cap"] = (cap, ["Head"])
    bm = bmesh.new()
    for k in range(70):
        u = rng.uniform(0, 2 * math.pi)
        v = rng.uniform(-0.15, 1.0)
        front = math.cos(u - (-math.pi / 2))  # 1 at the face (-Y)
        n = Vector((math.cos(u) * math.cos(v * 1.2), math.sin(u) * math.cos(v * 1.2), math.sin(v * 1.2))).normalized()
        if front > 0.55 and v < 0.35:
            continue  # keep the face clear
        base = c + Vector((n.x * 0.27, n.y * 0.285 + 0.02, n.z * 0.3 + 0.04))
        out = (n + Vector((rng.uniform(-0.25, 0.25), rng.uniform(-0.25, 0.25), rng.uniform(0.0, 0.35)))).normalized()
        if front > 0.4:  # fringe: falls down over the forehead
            out = (Vector((n.x * 0.4, -0.6, -0.9)) + Vector((rng.uniform(-0.2, 0.2), 0, 0))).normalized()
            base += Vector((0, -0.03, 0.02))
        elif n.z < 0.2:  # back/sides: sweep down and out
            out = (out + Vector((0, 0.3, -0.6))).normalized()
        length = rng.uniform(0.14, 0.26) if front < 0.4 else rng.uniform(0.15, 0.22)
        cone(bm, base, base + out * length, rng.uniform(0.05, 0.08), 8)
    spikes = obj_from_bm("kavi_hair_spikes", bm, M["hair"])
    for p in spikes.data.polygons:
        p.use_smooth = True
    parts["hair_spikes"] = (spikes, ["Head"])
    return parts


# -------------------------------------------------------------- weights ----
def seg_dist(p, a, b):
    ab = b - a
    t = max(0.0, min(1.0, (p - a).dot(ab) / max(ab.length_squared, 1e-9)))
    return (p - (a + ab * t)).length


def bind(arm, J, parts):
    objs = []
    for key, (o, bones) in parts.items():
        mw = o.matrix_world
        segs = {b: J[b] for b in bones}
        for b in bones:
            o.vertex_groups.new(name="mixamorig:" + b)
        for v in o.data.vertices:
            p = mw @ v.co
            w = sorted(((1.0 / (seg_dist(p, *segs[b]) ** 4 + 1e-5), b) for b in bones), reverse=True)[:3]
            tot = sum(x for x, _ in w)
            for x, b in w:
                o.vertex_groups["mixamorig:" + b].add([v.index], x / tot, "REPLACE")
        objs.append(o)
    # One mesh object for the character (fewer draw calls), skinned to the rig.
    with bpy.context.temp_override(active_object=objs[0], object=objs[0], selected_objects=objs, selected_editable_objects=objs):
        bpy.ops.object.join()
    body = objs[0]
    body.name = "kavi_body"
    mw = body.matrix_world.copy()
    body.parent = arm
    body.matrix_world = mw
    mod = body.modifiers.new("rig", "ARMATURE")
    mod.object = arm
    return body


# ----------------------------------------------------------- animation ----
def add_clips(arm):
    exec(open(str(REPO / "blender" / "convert_mixamo.py")).read(), globals())
    if arm.animation_data is None:
        arm.animation_data_create()
    for t in list(arm.animation_data.nla_tracks):
        arm.animation_data.nla_tracks.remove(t)
    for clip, path in ANIMS.items():
        new = _import_fbx(path)
        src = next(o for o in new if o.type == "ARMATURE")
        act = src.animation_data.action
        act.name = "kavi_" + clip
        act.use_fake_user = True
        if clip in ("Walk", "Run"):
            _strip_root_motion(act)
        track = arm.animation_data.nla_tracks.new()
        track.name = clip
        strip = track.strips.new(clip, int(act.frame_range[0]), act)
        slots = getattr(act, "slots", None)
        if slots and hasattr(strip, "action_slot"):
            strip.action_slot = slots[0]
        for o in new:
            bpy.data.objects.remove(o)
    arm.animation_data.action = None


def build():
    materials()
    arm = rig()
    J = joints(arm)
    parts = body(J)
    parts.update(head(J))
    bind(arm, J, parts)
    add_clips(arm)
    me = bpy.data.objects["kavi_body"].data
    print("kavi faces", len(me.polygons), "materials", len(me.materials), "tracks", [t.name for t in arm.animation_data.nla_tracks])


def export():
    OUT.parent.mkdir(parents=True, exist_ok=True)
    with quiet():
        bpy.ops.export_scene.gltf(
            filepath=str(OUT), export_format="GLB", use_active_scene=True,
            export_animations=True, export_animation_mode="NLA_TRACKS", export_skins=True,
            export_force_sampling=True, export_optimize_animation_size=True,
            export_lights=False, export_cameras=False,
        )
    print("exported", OUT.name, round(OUT.stat().st_size / 1e6, 2), "MB")
