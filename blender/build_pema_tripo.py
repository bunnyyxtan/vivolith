"""Auntie Pema from Tripo only: Tripo mesh, Tripo rig v1.0, six Tripo preset clips -> public/models/v2/cast/merchant_fruit.glb.
No Mixamo data. Bone names follow the Mixamo naming spec (`mixamorig:`) so the game's bone lookups keep working.

Source (assets-src/tripo/out/, git-ignored) came from (2026-11-11, 85 API credits):
    tripo anim rig 23df3c00-e101-4dba-b14a-1f965f37a835 --model v1.0 --rig-type biped --spec mixamo
    tripo anim retarget <rig> --animation preset:biped:idle preset:biped:walk preset:biped:run preset:biped:sit \
        preset:biped:complain_01 --animate-in-place
    tripo anim retarget <rig> --animation preset:biped:scared_01 --animate-in-place
Headless:
    "C:/Program Files/Blender Foundation/Blender 5.2/blender.exe" -b --factory-startup --python blender/build_pema_tripo.py
"""
import bpy, math, pathlib

REPO = pathlib.Path(r"C:/Bunnyy/Hackathons/NEAR")
P = REPO / "assets-src/tripo/out/merchant/pilot/tripo-out"
SRC_A = P / "pema-v1-anim-a-8352d615/model.glb"  # idle walk run sit complain_01
SRC_B = P / "pema-v1-anim-b-340e3d8c/model.glb"  # scared_01
OUT = REPO / "public/models/v2/cast/merchant_fruit.glb"
NAMES = {"idle": "Idle", "walk": "Walk", "run": "Run", "sit": "Sit", "complain_01": "Talking", "scared_01": "Startled"}

for o in list(bpy.data.objects):
    bpy.data.objects.remove(o, do_unlink=True)

bpy.ops.import_scene.gltf(filepath=str(SRC_A))
keep = set(bpy.data.objects)
bpy.ops.import_scene.gltf(filepath=str(SRC_B))
for o in set(bpy.data.objects) - keep:  # the second import only donates its action
    bpy.data.objects.remove(o, do_unlink=True)
for o in list(bpy.data.objects):
    if o.name.startswith("Icosphere"):  # stray helper in Tripo exports
        bpy.data.objects.remove(o, do_unlink=True)

arm = next(o for o in bpy.data.objects if o.type == "ARMATURE")
mesh = next(o for o in bpy.data.objects if o.type == "MESH")
arm.name, mesh.name = "pema_rig", "pema_body"
arm.rotation_mode = "XYZ"
arm.rotation_euler = (0, 0, -math.pi / 2)  # Tripo faces +X; the game's forward is Blender -Y

ad = arm.animation_data or arm.animation_data_create()
for t in list(ad.nla_tracks):
    ad.nla_tracks.remove(t)
acts = {a.name.split(".")[0].split("|")[-1]: a for a in bpy.data.actions}
missing = [k for k in NAMES if k not in acts]
assert not missing, f"missing clips {missing}; have {list(acts)}"
for src, clip in NAMES.items():
    act = acts[src]
    act.name = clip
    act.use_fake_user = True
    track = ad.nla_tracks.new()
    track.name = clip
    strip = track.strips.new(clip, int(act.frame_range[0]), act)
    slots = getattr(act, "slots", None)
    if slots and hasattr(strip, "action_slot"):
        strip.action_slot = slots[0]
ad.action = None

bpy.ops.export_scene.gltf(
    filepath=str(OUT), export_format="GLB", export_animations=True, export_animation_mode="NLA_TRACKS",
    export_skins=True, export_force_sampling=True, export_optimize_animation_size=True,
    export_draco_mesh_compression_enable=True, export_image_format="WEBP", export_lights=False, export_cameras=False,
)
print("PEMA tris", sum(len(p.vertices) - 2 for p in mesh.data.polygons),
      "clips", [t.name for t in ad.nla_tracks], "MB", round(OUT.stat().st_size / 1e6, 2))
