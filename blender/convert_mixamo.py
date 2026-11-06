"""Converts Mixamo FBX downloads (character + separate "Without Skin" animations) into one GLB per character.

Run inside Blender (MCP for Blender):
    exec(open(r"<repo>/blender/convert_mixamo.py").read())
    convert("player", r"C:/Users/<you>/Downloads/mixamo/Remy.fbx",
            {"Idle": ".../Breathing Idle.fbx", "Walk": ".../Walking.fbx", "Run": ".../Running.fbx"})
Output: public/models/<name>.glb with one animation per NLA track (Idle, Walk, Run, ...).
Mixamo assets: free for use in games under Adobe's Mixamo terms; raw files are not redistributed separately.
"""
import bpy, io, contextlib, pathlib

REPO = pathlib.Path(r"C:/Bunnyy/Hackathons/NEAR")
OUT_DIR = REPO / "public" / "models"


def _quiet():
    s = contextlib.ExitStack()
    s.enter_context(contextlib.redirect_stdout(io.StringIO()))
    s.enter_context(contextlib.redirect_stderr(io.StringIO()))
    return s


def _import_fbx(path):
    before = set(bpy.data.objects)
    with _quiet():
        bpy.ops.import_scene.fbx(filepath=str(path), use_anim=True, automatic_bone_orientation=False)
    return [o for o in bpy.data.objects if o not in before]


def _fcurves(act):
    """F-curves of an action (legacy list or Blender 4.4+ layered channelbags)."""
    legacy = getattr(act, "fcurves", None)
    if legacy is not None and len(legacy):
        return list(legacy)
    out = []
    for layer in getattr(act, "layers", []):
        for strip in layer.strips:
            for bag in getattr(strip, "channelbags", []):
                out += list(bag.fcurves)
    return out


def _strip_root_motion(act):
    """Mixamo clips exported without "In Place": remove the Hips' net travel (keep bob/sway) so loops stay put."""
    loc = [fc for fc in _fcurves(act) if fc.data_path.endswith('Hips"].location')]
    for fc in loc:
        pts = fc.keyframe_points
        if len(pts) < 2:
            continue
        (t0, v0), (t1, v1) = pts[0].co, pts[-1].co
        span = max(p.co[1] for p in pts) - min(p.co[1] for p in pts)
        if span < 20 and abs(v1 - v0) < 10:  # cm in Mixamo space: sway, not travel
            continue
        for p in pts:
            k = (p.co[0] - t0) / max(t1 - t0, 1e-6)
            drift = (v1 - v0) * k
            p.co[1] -= drift
            p.handle_left[1] -= drift
            p.handle_right[1] -= drift
        fc.update()


def _texture_budget(objs, max_px=1024):
    """Cap only this character's textures (other scenes in the .blend keep theirs)."""
    imgs = {n.image for o in objs if o.type == "MESH" for m in o.data.materials if m and m.use_nodes
            for n in m.node_tree.nodes if n.type == "TEX_IMAGE" and n.image}
    for img in imgs:
        w, h = img.size
        if w and max(w, h) > max_px:
            s = max_px / max(w, h)
            img.scale(int(w * s), int(h * s))


def convert(name, character_fbx, animations, max_tex=1024, in_place=("Walk", "Run")):
    sc = bpy.data.scenes.get("Char_" + name)
    if sc:
        for o in list(sc.objects):
            bpy.data.objects.remove(o)
    else:
        sc = bpy.data.scenes.new("Char_" + name)
    bpy.context.window.scene = sc
    sc.render.fps = 30

    objs = _import_fbx(character_fbx)
    arm = next(o for o in objs if o.type == "ARMATURE")
    arm.name = name + "_rig"
    if arm.animation_data is None:
        arm.animation_data_create()
    # The character FBX may carry its own T-pose action; drop it.
    arm.animation_data.action = None

    for clip, path in animations.items():
        new = _import_fbx(path)
        src = next(o for o in new if o.type == "ARMATURE")
        act = src.animation_data.action if src.animation_data else None
        if act is None:
            raise RuntimeError(f"{path}: no animation found")
        act.name = clip
        act.use_fake_user = True
        if clip in in_place:
            _strip_root_motion(act)
        track = arm.animation_data.nla_tracks.new()
        track.name = clip
        start = int(act.frame_range[0])
        strip = track.strips.new(clip, start, act)
        slots = getattr(act, "slots", None)
        if slots and hasattr(strip, "action_slot"):
            strip.action_slot = slots[0]
        track.mute = False
        for o in new:
            bpy.data.objects.remove(o)

    _texture_budget(objs, max_tex)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out = OUT_DIR / f"{name}.glb"
    with _quiet():
        bpy.ops.export_scene.gltf(
            filepath=str(out), export_format="GLB", use_active_scene=True,
            export_animations=True, export_animation_mode="NLA_TRACKS", export_skins=True,
            export_force_sampling=True, export_optimize_animation_size=True,
            export_image_format="JPEG", export_jpeg_quality=88,
            export_lights=False, export_cameras=False,
        )
    tracks = [t.name for t in arm.animation_data.nla_tracks]
    print(f"exported {out.name} {round(out.stat().st_size / 1e6, 2)} MB, clips: {tracks}")


# ---------------------------------------------------------------- cast ----
# Distinct Mixamo characters for NPCs. Files come from the Mixamo export flow documented in docs/ASSETS.md
# (Mixamo/nw__<id>__skin_Idle.fbx = character + idle, other files = "without skin" clips on the same rig).
# id: (Mixamo character, texture cap, clips)
CAST = {
    "npc_engineer": ("Elizabeth", 1024, ("Idle", "Talking", "Explain", "Walk")),
    "npc_tomas": ("Joe", 1024, ("Idle", "Talking")),
    "npc_teahouse": ("Martha", 1024, ("Idle", "Talking")),
    "ped_sophie": ("Sophie", 512, ("Idle", "Walk")),
    "ped_shannon": ("Shannon", 512, ("Idle", "Walk")),
    "ped_megan": ("Megan", 512, ("Idle", "Walk")),
    "ped_bryce": ("Bryce", 512, ("Idle", "Walk")),
    "ped_josh": ("Josh", 512, ("Idle", "Walk")),
    "ped_pete": ("Pete", 512, ("Idle", "Walk")),
    "ped_porter": ("Peasant Man", 512, ("Idle", "Walk")),
    "ped_abe": ("Abe", 512, ("Idle", "Walk")),
}
MIXAMO = REPO / "Mixamo"


def convert_cast(only=None):
    for cid, (_, cap, clips) in CAST.items():
        if only and cid not in only:
            continue
        key = cid.replace("npc_", "") if cid.startswith("npc_") else cid
        src = lambda clip: str(MIXAMO / f"nw__{key}__{'skin_' if clip == 'Idle' else ''}{clip}.fbx")
        convert(cid, src("Idle"), {c: src(c) for c in clips}, max_tex=cap)
        scene = bpy.data.scenes.get("Char_" + cid)
        bpy.data.scenes.remove(scene)  # keep the .blend light between characters
