"""VIVOLITH v2 level: the NEAR Spire and its plaza in the anime daytime style of the reference video.
Exports public/models/v2/plaza.glb.

Run inside Blender:  exec(open(r"C:/Bunnyy/Hackathons/NEAR/blender/build_v2_plaza.py").read()); build(); export()

Reuses the Spire geometry from build_spire.py (same N silhouette) with a bright restyle: vivid blue glass, white
fins/spandrels/diagrid, cyan LEDs, warm lobby. Around it: a 60 m granite promenade from the south, long reflecting
pools either side, benches, black lamp posts, rounded stylised trees, hedges, a NEAR sign pylon, and a grass
field ringed by trees so no view ends in empty ground.
Conventions: COL_* colliders (axis-aligned), SPAWN empty (player start; faces Blender +Y = three -Z).
"""
exec(open(r"C:/Bunnyy/Hackathons/NEAR/blender/build_spire.py").read())  # Spire builders + street library

OUT = REPO / "public" / "models" / "v2" / "plaza.glb"
PROM_X = 6.0          # promenade half width
PROM_Y0 = -6.0        # promenade start (south)
rngp = random.Random(21)


def v2_materials():
    M = mats()
    # NEAR Protocol brand green #00EC97 (PMS 7479c): emerald glass built around it, pure green on the LEDs.
    M["glass"] = flat_material("v2_glass_green", "16b884", 0.08, 0.55)
    M["glass_lit"] = flat_material("v2_glass_lit", "f6d79a", 0.4, 0.0, emit="ffd99a", emit_strength=2.2)
    M["glass_cool"] = flat_material("v2_glass_green_light", "6ff0c4", 0.1, 0.4)
    M["fin"] = flat_material("v2_white", "f4f6f8", 0.35, 0.1)
    M["band"] = M["fin"]
    M["steel"] = flat_material("v2_frame", "e8ecf0", 0.3, 0.2)
    M["led"] = flat_material("v2_led_near_green", "00ec97", 0.2, emit="00ec97", emit_strength=6.0)
    M["panel"] = flat_material("v2_lobby_light", "ffe3b0", 0.4, emit="ffd99a", emit_strength=3.0)
    M["dark"] = flat_material("v2_feature", "1f2a36", 0.5)
    M["plaza"] = pbr_material("v2_pavers", "concrete_pavement", "f6eee6")  # light warm pavers (reference)
    M["water"] = flat_material("v2_water", "39b6e6", 0.03, 0.2)
    M["rim"] = flat_material("v2_rim", "e9e6e1", 0.6)
    M["grass"] = flat_material("v2_grass", "7aa858", 0.95)  # natural, not neon
    M["leaf"] = flat_material("v2_leaf", "5cc44a", 0.85)
    M["leaf2"] = flat_material("v2_leaf_light", "8fdb5c", 0.85)
    M["hedge"] = flat_material("v2_hedge", "3f9e3c", 0.9)
    M["bark"] = flat_material("v2_bark", "7a5a3c", 0.9)
    M["wood"] = flat_material("v2_bench_wood", "b07a46", 0.7)
    M["black"] = flat_material("v2_lamp", "22252a", 0.4, 0.5)
    M["lampglow"] = flat_material("v2_lamp_glow", "fff1d0", 0.3, emit="fff1d0", emit_strength=4.0)
    M["gold"] = flat_material("v2_gold_strip", "ffd27a", 0.3, emit="ffc457", emit_strength=4.0)
    return M


def stylised_tree(name, x, y, h, M, seed):
    """Rounded cartoon canopy (clustered, softly displaced spheres) on a tapered trunk."""
    r = random.Random(seed)
    bm = bmesh.new()
    trunk = bmesh.ops.create_cone(bm, cap_ends=True, segments=8, radius1=0.22 * h / 6, radius2=0.12 * h / 6, depth=h * 0.55)
    bmesh.ops.translate(bm, verts=trunk["verts"], vec=(x, y, h * 0.275))
    tr = mesh_obj(name + "_trunk", bm, M["bark"])
    bm = bmesh.new()
    for k in range(7):
        c = Vector((x + r.uniform(-1, 1) * h * 0.16, y + r.uniform(-1, 1) * h * 0.16, h * (0.62 + r.uniform(-0.05, 0.22))))
        rad = h * r.uniform(0.17, 0.25)
        g = bmesh.ops.create_icosphere(bm, subdivisions=2, radius=rad)["verts"]
        for v in g:
            v.co += Vector((r.uniform(-1, 1), r.uniform(-1, 1), r.uniform(-1, 1))) * rad * 0.08
            v.co += c
    can = mesh_obj(name + "_canopy", bm, [M["leaf"], M["leaf2"]])
    for p in can.data.polygons:
        p.use_smooth = True
        if p.normal.z > 0.45:
            p.material_index = 1  # sunlit tops read lighter
    collider(name, x - 0.3, y - 0.3, x + 0.3, y + 0.3, 0, 3.0)
    return [tr, can]


def bench(name, x, y, rot, M):
    root = empty(name, (x, y, 0), rot)
    box_mesh(name + "_seat", -0.95, -0.25, 0.42, 0.95, 0.25, 0.48, M["wood"], 1.0, root, 0.01)
    box_mesh(name + "_back", -0.95, 0.2, 0.55, 0.95, 0.25, 0.85, M["wood"], 1.0, root, 0.01)
    for sx in (-0.8, 0.8):
        box_mesh(name + "_leg", sx - 0.05, -0.23, 0, sx + 0.05, 0.23, 0.42, M["rim"], 1.0, root, 0.01)
    c, s = abs(math.cos(rot)), abs(math.sin(rot))
    hx, hy = 1.0 * c + 0.3 * s, 1.0 * s + 0.3 * c
    collider(name, x - hx, y - hy, x + hx, y + hy, 0, 0.5)
    return join_under(root, "V2_" + name)


def lamp(name, x, y, M):
    cylinder(name + "_post", x, y, 0, 3.4, 0.07, M["black"], None, 12)
    box_mesh(name + "_head", x - 0.13, y - 0.13, 3.4, x + 0.13, y + 0.13, 3.9, M["black"], 1.0, None, 0.02)
    box_mesh(name + "_glow", x - 0.1, y - 0.14, 3.45, x + 0.1, y + 0.14, 3.85, M["lampglow"], 1.0)
    collider(name, x - 0.15, y - 0.15, x + 0.15, y + 0.15, 0, 3.9)


def hedge(name, x0, y0, x1, y1, M, h=0.9):
    box_mesh(name + "_planter", x0, y0, 0.0, x1, y1, 0.45, M["rim"], 1.0, None, 0.03)
    box_mesh(name, x0 + 0.1, y0 + 0.1, 0.45, x1 - 0.1, y1 - 0.1, h, M["hedge"], 1.0, None, 0.12)
    collider(name, x0, y0, x1, y1, 0, h)


def v2_plaza(M):
    # Ground: granite promenade and forecourt, grass beyond.
    box_mesh("V2_grass", -140, -60, -0.3, 140, 150, -0.02, M["grass"], 4.0)
    box_mesh("V2_promenade", -24, PROM_Y0, -0.2, 24, 54.5, 0.02, M["plaza"], 3.2)
    box_mesh("V2_forecourt", -34, 46, -0.2, 34, 75, 0.03, M["plaza"], 2.0)
    # Reflecting pools either side of the promenade (water slightly below the rim).
    for s in (1, -1):
        x0, x1 = sorted((s * (PROM_X + 2.0), s * (PROM_X + 9.0)))
        box_mesh(f"V2_pool_rim{s}", x0 - 0.35, 4.0, 0.0, x1 + 0.35, 44.0, 0.35, M["rim"], 1.0, None, 0.03)
        box_mesh(f"V2_pool{s}", x0, 4.35, 0.0, x1, 43.65, 0.3, M["water"], 2.0)
        collider(f"pool{s}", x0 - 0.35, 4.0, x1 + 0.35, 44.0, 0, 0.35)
    # Gold light strips along the promenade edges (the reference's warm ground lines).
    for s in (1, -1):
        box_mesh(f"V2_strip{s}", s * PROM_X - 0.06, PROM_Y0, 0.02, s * PROM_X + 0.06, 50.0, 0.035, M["gold"], 1.0)
    # Benches and lamps rhythmically along the promenade.
    for i, y in enumerate(range(6, 46, 8)):
        for s in (1, -1):
            bench(f"bench{i}_{s}", s * (PROM_X + 1.0), y + 2.0, -s * math.pi / 2, M)
            lamp(f"lamp{i}_{s}", s * (PROM_X + 0.9), y - 1.0, M)
    # Hedges framing the forecourt and the outer plaza edge.
    for s in (1, -1):
        xa, xb = sorted((s * 22.0, s * 24.0))
        hedge(f"hedge_outer{s}", xa, -6.0, xb, 44.0, M)
        xa, xb = sorted((s * 17.0, s * 31.0))
        hedge(f"hedge_fore{s}", xa, 47.0, xb, 49.0, M)
    # Stylised trees: lining the outer edge and ringing the field.
    trees = []
    bark, leaves = tree_materials()
    leaves.name = "v2_leaves__tint_c8f58c"  # brighter spring green (runtime tint), leaf cut-out kept
    for i, y in enumerate(range(0, 46, 9)):
        for s in (1, -1):
            x = s * 18.5
            bm = procedural_tree(300 + i * 2 + (s > 0), rngp.uniform(6.8, 8.2))
            bmesh.ops.rotate(bm, verts=bm.verts, cent=(0, 0, 0), matrix=Matrix.Rotation(i * 1.1 + s, 3, "Z"))
            bmesh.ops.translate(bm, verts=bm.verts, vec=(x, y + 2, 0.0))
            trees.append(mesh_obj(f"tree_p{i}_{s}", bm, [bark, leaves]))
            collider(f"tree_p{i}_{s}", x - 0.3, y + 1.7, x + 0.3, y + 2.3, 0, 3.0)
    k = 0
    for a in range(0, 360, 9):
        rad = rngp.uniform(85, 110)
        x, y = math.cos(math.radians(a)) * rad, 40 + math.sin(math.radians(a)) * rad
        h = rngp.uniform(7, 12)
        if y > -8 or abs(x) > 62:  # south arc is the town district (build_v2_town.py)
            trees += stylised_tree(f"tree_r{k}", x, y, h, M, 500 + k)
        k += 1
    # NEAR sign pylon at the promenade entrance (wayfinding, as in the reference).
    box_mesh("V2_pylon", -9.2, 0.0, 0.0, -8.0, 0.35, 3.0, M["fin"], 1.0, None, 0.06)
    symbol_mesh("V2_pylon_symbol", -8.6, -0.02, 2.2, 0.7, 0.02, M["led"])
    box_mesh("V2_pylon_arrow", -8.95, -0.02, 1.35, -8.25, 0.0, 1.45, M["led"], 1.0)
    collider("pylon", -9.2, 0.0, -8.0, 0.35, 0, 3.0)
    # World edge: hedges + low walls far out (believable boundary, never visible as a wall).
    for name, a, b, c, d in (("edge_n", -60, 95, 60, 96), ("edge_w", -60, -6, -59, 96), ("edge_e", 59, -6, 60, 96)):
        collider(name, a, b, c, d, 0, 6.0)
    gold_glass = flat_material("v2_lobby_glass", "f5d9a0", 0.25, 0.0, emit="ffcf80", emit_strength=1.6)
    box_mesh("V2_entry_hall", -7.5, 53.0, 0.6, 7.5, 58.0, 5.6, gold_glass, 2.0)
    for x in [x * 1.5 for x in range(-5, 6)]:  # mullions
        box_mesh("V2_entry_mullion", x - 0.06, 52.9, 0.6, x + 0.06, 53.0, 5.6, M["fin"], 1.0)
    box_mesh("V2_entry_canopy", -9.0, 50.6, 5.6, 9.0, 58.5, 6.1, M["fin"], 1.0, None, 0.05)
    box_mesh("V2_entry_led", -9.0, 50.55, 5.6, 9.0, 50.65, 5.75, M["led"], 1.0)
    for i in range(3):  # three steps up to the hall (0.2 m each, walkable)
        y0 = 50.0 + i * 0.7
        box_mesh(f"V2_step{i}", -10.0, y0, 0.0, 10.0, 53.0, 0.2 * (i + 1), M["rim"], 1.0)
        collider(f"step{i}", -10.0, y0, 10.0, 53.0, 0, 0.2 * (i + 1))
    box_mesh("V2_step_glow", -10.0, 49.95, 0.18, 10.0, 50.02, 0.2, M["gold"], 1.0)
    collider("entry_hall", -7.5, 53.0, 7.5, 58.0, 0, 5.6)
    sp = empty("SPAWN", (0.0, 2.0, 0.0), 0.0)
    return trees


def reset():
    sc = bpy.data.scenes.get("V2Plaza")
    if sc:
        for o in list(sc.objects):
            bpy.data.objects.remove(o)
    else:
        sc = bpy.data.scenes.new("V2Plaza")
    bpy.context.window.scene = sc
    for me in [me for me in bpy.data.meshes if me.users == 0]:
        bpy.data.meshes.remove(me)
    return sc


def build():
    reset()
    M = v2_materials()
    tower("west", WX0, WX1, M, lobby=True)
    tower("east", EX0, EX1, M)
    atrium(M)
    hooks(M)
    lobby(M)
    labs(M)
    v2_plaza(M)
    # Merge small repeated pieces into few objects (draw calls).
    join_objects(["tree_"], "V2_trees")
    join_objects(["lamp"], "V2_lamps")
    join_objects(["V2_bench"], "V2_benches")
    join_objects(["hedge"], "V2_hedges")
    stats()


def export():
    OUT.parent.mkdir(parents=True, exist_ok=True)
    cap_textures()
    with quiet():
        bpy.ops.export_scene.gltf(
            filepath=str(OUT), export_format="GLB", use_active_scene=True,
            export_apply=True, export_image_format="AUTO", export_jpeg_quality=88,
            export_draco_mesh_compression_enable=True, export_draco_mesh_compression_level=6,
            export_lights=False, export_cameras=False,
        )
    print("exported", OUT.name, round(OUT.stat().st_size / 1e6, 2), "MB")
