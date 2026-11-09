"""Converts one Mixamo animation FBX (no skin) into a clip-only GLB for loadCharacter's clip sources.

blender -b --python blender/convert_run_clip.py -- <in.fbx> <out.glb> <ClipName>

A "Without Skin" export has no mesh, and glTF only marks joints as bones when a skin uses them, so a 1 cm hidden
triangle is skinned to the hips to keep the rig a skeleton. Hips translation stays in the file; the game copies
rotations only, so the clip plays in place and its ground speed is measured from the planted foot.
"""
import sys
import bpy

argv = sys.argv[sys.argv.index("--") + 1:]
src, out, name = argv[0], argv[1], argv[2]

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.fbx(filepath=src, use_anim=True, automatic_bone_orientation=False)
arm = next(o for o in bpy.data.objects if o.type == "ARMATURE")
act = arm.animation_data.action
act.name = name
start, end = (int(v) for v in act.frame_range)
print(f"CLIP {name}: frames {start}-{end} fps {bpy.context.scene.render.fps} bones {len(arm.data.bones)}")

if not any(o.type == "MESH" for o in bpy.data.objects):
    mesh = bpy.data.meshes.new("ClipAnchor")
    mesh.from_pydata([(0, 0, 0), (0.01, 0, 0), (0, 0.01, 0)], [], [(0, 1, 2)])
    anchor = bpy.data.objects.new("ClipAnchor", mesh)
    bpy.context.scene.collection.objects.link(anchor)
    anchor.parent = arm
    hips = next(b.name for b in arm.data.bones if b.name.endswith("Hips"))
    anchor.vertex_groups.new(name=hips).add([0, 1, 2], 1.0, "REPLACE")
    anchor.modifiers.new("Armature", "ARMATURE").object = arm

bpy.context.scene.frame_start, bpy.context.scene.frame_end = start, end
bpy.ops.export_scene.gltf(filepath=out, export_format="GLB", export_animations=True, export_animation_mode="ACTIONS",
                          export_materials="NONE", export_yup=True)
print(f"WROTE {out}")
