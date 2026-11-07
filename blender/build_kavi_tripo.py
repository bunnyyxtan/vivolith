"""Kavi from Tripo: multiview P2 model, Mixamo-spec rig, preset clips -> public/models/v2/kavi.glb.

Source (assets-src/tripo/out/, git-ignored) came from:
    tripo make ref/kavi/front.png ref/kavi/side.png ref/kavi/back.png --model tripo-p2 --then texture
    tripo anim rig @kavi-p2-texture --rig-type biped --spec mixamo
    tripo anim retarget @kavi-rig --animation preset:idle preset:walk preset:run preset:jump preset:turn --animate-in-place
Run inside Blender (MCP for Blender):
    exec(open(r"C:/Bunnyy/Hackathons/NEAR/blender/build_kavi_tripo.py").read()); build(); export()
"""
import bpy, math, pathlib

REPO = pathlib.Path(r"C:/Bunnyy/Hackathons/NEAR")
SRC = REPO / "assets-src/tripo/out/kavi/tripo-out/kavi-anim-903fe5eb/model.glb"
OUT = REPO / "public/models/v2/kavi.glb"
CLIPS = {"idle": "Idle", "walk": "Walk", "run": "Run", "turn": "Turn"}
JUMP_RANGE = (13, 29)  # the preset is a run of hops; keep one: crouch, peak (21), land


def fcurves(act):
    legacy = getattr(act, "fcurves", None)
    if legacy is not None and len(legacy):
        return list(legacy)
    return [fc for layer in getattr(act, "layers", []) for strip in layer.strips
            for bag in getattr(strip, "channelbags", []) for fc in bag.fcurves]


def trimmed(act, name, f0, f1):
    new = act.copy()
    new.name = name
    for fc in fcurves(new):
        pts = fc.keyframe_points
        for i in reversed(range(len(pts))):
            if not f0 <= pts[i].co[0] <= f1:
                pts.remove(pts[i])
        for p in pts:
            for co in (p.co, p.handle_left, p.handle_right):
                co[0] -= f0 - 1
        fc.update()
    return new


def build():
    sc = bpy.data.scenes.get("KaviTripo") or bpy.data.scenes.new("KaviTripo")
    bpy.context.window.scene = sc
    for o in list(sc.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    before = set(bpy.data.actions)
    bpy.ops.import_scene.gltf(filepath=str(SRC))
    for o in list(sc.objects):
        if o.name.startswith("Icosphere"):  # stray helper in Tripo exports
            bpy.data.objects.remove(o)
    arm = next(o for o in sc.objects if o.type == "ARMATURE")
    mesh = next(o for o in sc.objects if o.type == "MESH")
    arm.name, mesh.name = "kavi_rig", "kavi_body"
    # Tripo exports the character facing +X; the game expects Blender -Y (glTF +Z) as forward.
    arm.rotation_mode = "XYZ"
    arm.rotation_euler = (0, 0, -math.pi / 2)
    acts = {a.name.split(".")[0]: a for a in bpy.data.actions if a not in before}  # re-runs import "idle.001"
    ad = arm.animation_data
    for t in list(ad.nla_tracks):
        ad.nla_tracks.remove(t)
    out = {CLIPS[k]: acts[k] for k in CLIPS}
    out["Jump"] = trimmed(acts["jump"], "Jump", *JUMP_RANGE)
    for clip, act in out.items():
        act.name = clip
        act.use_fake_user = True
        track = ad.nla_tracks.new()
        track.name = clip
        strip = track.strips.new(clip, int(act.frame_range[0]), act)
        slots = getattr(act, "slots", None)
        if slots and hasattr(strip, "action_slot"):
            strip.action_slot = slots[0]
    ad.action = None
    print("kavi tris", sum(len(p.vertices) - 2 for p in mesh.data.polygons),
          "clips", {t.name: tuple(t.strips[0].action.frame_range) for t in ad.nla_tracks})


def export():
    bpy.ops.export_scene.gltf(
        filepath=str(OUT), export_format="GLB", use_active_scene=True,
        export_animations=True, export_animation_mode="NLA_TRACKS", export_skins=True,
        export_force_sampling=True, export_optimize_animation_size=True,
        export_draco_mesh_compression_enable=True, export_image_format="WEBP",
        export_lights=False, export_cameras=False,
    )
    print("exported", OUT.name, round(OUT.stat().st_size / 1e6, 2), "MB")
