"""One Tripo Studio character export -> one game GLB (no Mixamo data anywhere).

Studio workflow per character (credits: image 0 on the free image quota, HD model 45 at 30k faces, rig 20;
preset animations and GLB export are free): concept image (T-pose, white background) -> HD Model -> Rig
(Humanoid, skeleton naming "Mixamo" so the game's bone lookups match) -> Animate presets -> Export GLB with
"Animation stay in Place" on. The raw export goes to assets-src/tripo/library/studio/<name>_studio.glb (git-ignored).

This script: drops Tripo helper objects, faces the character down -Y (glTF +Z, the game's forward), renames clips
to the game's names, trims one-shot clips, caps textures at 1024 px, exports Draco + WebP.
Headless (one or more characters per run):
    blender -b --factory-startup --python blender/build_studio_character.py -- kavi
"""
import bpy, math, pathlib, sys

REPO = pathlib.Path(r"C:/Bunnyy/Hackathons/NEAR")
SRC = REPO / "assets-src/tripo/library/studio"
TEX_MAX = 1024

# name: (output path, {studio clip: game clip}, {game clip: (first frame, last frame)} trims). Clips missing from an
# export are skipped (listed in the log), so a character can gain clips by re-exporting from Studio.
CAST = {
    "kavi": ("public/models/v2/kavi.glb",
             {"idle": "Idle", "walk": "Walk", "run": "Run", "turn": "Turn", "jump": "Jump", "jump_down": "JumpDown",
              "fall": "Fall", "sit": "Sit", "scared_01": "Startled", "greet_01": "Wave", "look_around": "Look"},
             {"Jump": (13, 29)}),  # the preset hops more than once; the game holds one hop while airborne
    # named merchants and the NEAR Labs engineer: idle, walk, a talking gesture (complain_01), wave, nod, flinch, look
    **{name: (f"public/models/v2/cast/{name}.glb",
              {"idle": "Idle", "walk": "Walk", "complain_01": "Talking", "greet_01": "Wave", "agree": "Agree",
               "scared_01": "Startled", "look_around": "Look"}, {})
       for name in ("tomas", "mira", "arin", "ines", "bram")},
    # townsfolk (market.ts cycles folk1..6 over the 24 walkers): idle, walk, run, sit, talk, startled, look, wave
    **{name: (f"public/models/v2/cast/folk{n}.glb",
              {"idle": "Idle", "walk": "Walk", "run": "Run", "sit": "Sit", "complain_01": "Talking",
               "scared_01": "Startled", "look_around": "Look", "greet_01": "Wave"}, {})
       for n, name in ((2, "joon"), (3, "hadi"), (4, "lena"), (5, "suki"), (6, "rafa"))},
    "noor": ("public/models/v2/cast/folk1.glb",
             {"idle": "Idle", "walk": "Walk", "run": "Run", "sit": "Sit", "complain_01": "Talking", "scared_01": "Startled",
              "look_around": "Look", "greet_01": "Wave"}, {}),
}


def fcurves(act):
    legacy = getattr(act, "fcurves", None)
    if legacy is not None and len(legacy):
        return list(legacy)
    return [fc for layer in getattr(act, "layers", []) for strip in layer.strips
            for bag in getattr(strip, "channelbags", []) for fc in bag.fcurves]


def trim(act, f0, f1):
    for fc in fcurves(act):
        pts = fc.keyframe_points
        for i in reversed(range(len(pts))):
            if not f0 <= pts[i].co[0] <= f1:
                pts.remove(pts[i])
        for p in pts:
            for co in (p.co, p.handle_left, p.handle_right):
                co[0] -= f0 - 1
        fc.update()


def cap_textures():
    for img in bpy.data.images:
        w, h = img.size
        if max(w, h) > TEX_MAX:
            k = TEX_MAX / max(w, h)
            img.scale(max(1, int(w * k)), max(1, int(h * k)))


def build(name):
    out, clips, trims = CAST[name]
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    for a in list(bpy.data.actions):
        bpy.data.actions.remove(a)
    bpy.ops.import_scene.gltf(filepath=str(SRC / f"{name}_studio.glb"))
    for o in list(bpy.data.objects):
        if o.type not in ("ARMATURE", "MESH") or o.name.startswith("Icosphere"):
            bpy.data.objects.remove(o, do_unlink=True)
    arm = next(o for o in bpy.data.objects if o.type == "ARMATURE")
    meshes = [o for o in bpy.data.objects if o.type == "MESH"]
    arm.name = f"{name}_rig"
    for i, m in enumerate(meshes):
        m.name = f"{name}_body" if i == 0 else f"{name}_body{i}"
    # face -Y: both feet's rest direction, averaged so natural toe-out cancels, tells which way the character looks
    d = sum(((arm.matrix_world.to_3x3() @ (b.tail_local - b.head_local)).normalized() for b in arm.data.bones
             if b.name.endswith(("LeftToeBase", "RightToeBase"))), start=type(arm.location)((0, 0, 0)))
    yaw = round(math.atan2(d.x, -d.y) / (math.pi / 2)) * (math.pi / 2)  # exports face an axis: snap to 90 deg
    arm.rotation_mode = "XYZ"
    arm.rotation_euler.z -= yaw
    bpy.context.view_layer.update()

    ad = arm.animation_data or arm.animation_data_create()
    for t in list(ad.nla_tracks):
        ad.nla_tracks.remove(t)
    acts = {a.name.split(".")[0].split("|")[-1].lower(): a for a in bpy.data.actions}
    skipped = [k for k in clips if k not in acts]
    for src, clip in clips.items():
        if src not in acts:
            continue
        act = acts[src]
        act.name = clip
        act.use_fake_user = True
        if clip in trims:
            trim(act, *trims[clip])
        track = ad.nla_tracks.new()
        track.name = clip
        strip = track.strips.new(clip, int(act.frame_range[0]), act)
        slots = getattr(act, "slots", None)
        if slots and hasattr(strip, "action_slot"):
            strip.action_slot = slots[0]
    ad.action = None
    cap_textures()

    path = REPO / out
    bpy.ops.export_scene.gltf(
        filepath=str(path), export_format="GLB", export_animations=True, export_animation_mode="NLA_TRACKS",
        export_skins=True, export_force_sampling=True, export_optimize_animation_size=True,
        export_draco_mesh_compression_enable=True, export_image_format="WEBP", export_lights=False, export_cameras=False,
    )
    tris = sum(len(p.vertices) - 2 for m in meshes for p in m.data.polygons)
    print("STUDIO", name, "tris", tris, "yaw", round(math.degrees(yaw)), "clips", [t.name for t in ad.nla_tracks],
          "skipped", skipped, "MB", round(path.stat().st_size / 1e6, 2))


if __name__ == "__main__":
    for n in sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []:
        build(n)
