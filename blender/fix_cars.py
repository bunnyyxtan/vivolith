# Turns the fused Tripo car GLBs into drivable cars (headless):
#   "C:/Program Files/Blender Foundation/Blender 5.2/blender.exe" -b --factory-startup --python blender/fix_cars.py
# - the four wheels become their own meshes (wheel_fl/fr/rl/rr, origin on the axle; the front ones under steer_fl /
#   steer_fr pivots), so the game can spin and steer them;
# - the body gets real materials, chosen per face from the baked texture: coated paint, glossy dark glass/trim;
#   tyres are matte. Same texture everywhere, so the look stays Tripo's; only the shading changes.
# Nose is -Y in Blender (+Z in three); wheels sit on z = 0. Blender x = three x, and +X is the car's left.
import bpy, bmesh
from mathutils import Vector

SRC = "C:/Bunnyy/Hackathons/NEAR/public/models/v2/props/{}.glb"
CARS = ["ev_sedan", "ev_pickup"]
DARK = 0.16  # texture luma below this is glass, trim or tyre rubber


def luma(px, w, h, uv):
    x = min(w - 1, max(0, int(uv.x % 1.0 * w))); y = min(h - 1, max(0, int(uv.y % 1.0 * h)))
    i = (y * w + x) * 4
    return 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]


def material(name, tex, rough, metal=0.0, coat=0.0):
    m = bpy.data.materials.new(name); m.use_nodes = True
    nt = m.node_tree; p = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")
    t = nt.nodes.new("ShaderNodeTexImage"); t.image = tex
    nt.links.new(t.outputs["Color"], p.inputs["Base Color"])
    p.inputs["Roughness"].default_value = rough
    p.inputs["Metallic"].default_value = metal
    if coat:
        p.inputs["Coat Weight"].default_value = coat
        p.inputs["Coat Roughness"].default_value = 0.08
    return m


def parts_of(bm):
    seen, parts = set(), []
    for v in bm.verts:
        if v.index in seen: continue
        stack, comp = [v], []
        seen.add(v.index)
        while stack:
            a = stack.pop(); comp.append(a)
            for e in a.link_edges:
                b = e.other_vert(a)
                if b.index not in seen: seen.add(b.index); stack.append(b)
        parts.append(comp)
    return parts


def mesh_from(src, keep_faces, offset, name):
    bmw = bmesh.new(); bmw.from_mesh(src); bmw.faces.ensure_lookup_table()
    bmesh.ops.delete(bmw, geom=[f for f in bmw.faces if f.index not in keep_faces], context="FACES")
    bmesh.ops.translate(bmw, verts=bmw.verts, vec=-offset)
    me = bpy.data.meshes.new(name); bmw.to_mesh(me); bmw.free()
    return me


def fix(name):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=SRC.format(name))
    body = next(o for o in bpy.data.objects if o.type == "MESH")
    tex = next(n.image for n in body.data.materials[0].node_tree.nodes if n.type == "TEX_IMAGE")
    px, (w, h) = list(tex.pixels), tex.size

    bm = bmesh.new(); bm.from_mesh(body.data)
    bm.verts.ensure_lookup_table(); bm.faces.ensure_lookup_table()
    ground = [v.co.copy() for v in bm.verts if v.co.z < 0.06]
    axle = {}
    for s in (-1, 1):
        ys = [c.y for c in ground if (c.y < 0) == (s < 0)]
        axle[s] = sum(ys) / len(ys)
    parts = parts_of(bm)
    wheels = {}
    for sx in (-1, 1):
        for sy in (-1, 1):
            region = [p for p in parts if all(abs(v.co.x) > 0.5 and v.co.x * sx > 0 and abs(v.co.y - axle[sy]) < 0.6 and v.co.z < 1.0 for v in p)]
            allv = [v for p in region for v in p]
            if not allv: raise SystemExit(f"{name}: no wheel at {sx},{sy}")
            # tyre pieces touch the ground: their extent is the wheel (arch trim never touches the ground)
            tyre = [p for p in region if min(v.co.z for v in p) < 0.08]
            tv = [v for p in tyre for v in p]
            r = max(v.co.z for v in tv) / 2
            cy = (min(v.co.y for v in tv) + max(v.co.y for v in tv)) / 2
            # Tyre and rim may be fused to the body (the sedan), so cut by face: inside the tyre's cylinder and outboard
            # of its inner wall. Wheel-well liner and arch trim fall outside one or the other.
            xin = min(abs(v.co.x) for v in tv) - 0.06
            inside = lambda v: v.co.x * sx > xin and ((v.co.y - cy) ** 2 + (v.co.z - r) ** 2) ** 0.5 <= r * 1.03
            faces = {f.index for f in bm.faces if all(inside(v) for v in f.verts)}
            xs = [v.co.x for f in bm.faces if f.index in faces for v in f.verts]
            tag = ("f" if sy < 0 else "r") + ("r" if sx < 0 else "l")
            wheels[tag] = (faces, Vector(((min(xs) + max(xs)) / 2, cy, r)), r)
    bm.free()

    paint = material(f"{name}_paint", tex, 0.32, 0.1, coat=0.7)
    dark = material(f"{name}_dark", tex, 0.18)
    tyre = material(f"{name}_tyre", tex, 0.8)
    orig = body.data.copy()
    report = []
    for tag, (idx, centre, r) in wheels.items():
        wm = mesh_from(orig, idx, centre, f"wheel_{tag}")
        wm.materials.clear(); wm.materials.append(tyre)
        wo = bpy.data.objects.new(f"wheel_{tag}", wm)
        bpy.context.scene.collection.objects.link(wo)
        if tag[0] == "f":
            piv = bpy.data.objects.new(f"steer_{tag}", None)
            bpy.context.scene.collection.objects.link(piv)
            piv.location = centre; wo.parent = piv
        else:
            wo.location = centre
        report.append(f"{tag} r={r:.3f} at ({centre.x:.2f},{centre.y:.2f}) faces={len(idx)}")

    # The body is everything that is not a wheel.
    every = set().union(*(i for i, _, _ in wheels.values()))
    bmb = bmesh.new(); bmb.from_mesh(orig); bmb.faces.ensure_lookup_table()
    bmesh.ops.delete(bmb, geom=[f for f in bmb.faces if f.index in every], context="FACES")
    bmb.to_mesh(body.data); bmb.free()
    body.data.materials.clear()
    for m in (paint, dark): body.data.materials.append(m)
    uv = body.data.uv_layers.active.data
    for poly in body.data.polygons:
        c = sum((uv[li].uv for li in poly.loop_indices), Vector((0, 0))) / poly.loop_total
        poly.material_index = 1 if luma(px, w, h, c) < DARK else 0
    body.name = "body"; body.data.name = "body"
    bpy.data.meshes.remove(orig)

    bpy.ops.export_scene.gltf(filepath=SRC.format(name), export_format="GLB", export_draco_mesh_compression_enable=True)
    n_dark = sum(1 for p in body.data.polygons if p.material_index == 1)
    print(f"FIXED {name}: {'; '.join(report)}; body faces {len(body.data.polygons)} ({n_dark} dark)")


for c in CARS:
    fix(c)
