# Mixamo assets in Git history: cleanup plan (not executed)

Adobe's Mixamo terms allow the characters and animations inside a game, but not as stand-alone downloadable files.
The working tree no longer contains any Mixamo-derived file. The history still does, so a public push of the
current history would redistribute them. Nothing below has been run; history is unchanged.

## What is in history

44 blobs (about 92 MB uncompressed, 88 commits) at these paths, all converted from Mixamo FBX (no raw FBX was ever committed):

- `public/models/player.glb`, `pema.glb`, `npc_engineer.glb`, `npc_teahouse.glb`, `npc_tomas.glb`
- `public/models/ped_{abe,bryce,josh,megan,pete,porter,shannon,sophie}.glb`
- `public/models/vendor_{adam,brian,david,jennifer,jody,kate,louise,michelle,lewis,steve}.glb`
- `public/models/v2/cast/{folk1-6,ines,marta,pema,tomas}.glb` (older versions: own meshes on the Mixamo Remy rig)
- `public/models/v2/kavi.glb` (versions before commit `4dc8661`: Mixamo rig and clips)
- `blender/convert_mixamo.py`, `blender/convert_run_clip.py`, `blender/build_kavi.py` (scripts only, no Mixamo data)

Not in history: the raw `Mixamo/*.fbx` files (git-ignored, only on the developer machine).

## Options

1. **Fresh public repository (recommended).** Publish the current tree as a new single-commit history
   (`git checkout --orphan public && git add -A && git commit`). Zero Mixamo data, the private history stays as a
   local backup. Loses commit history for the judges.
2. **Rewrite history with git-filter-repo** on a fresh clone. Keeps commit history. `folkN.glb`, `ines.glb`, `tomas.glb`
   and `kavi.glb` exist as Tripo versions at HEAD, so dropping them by path would also remove the current files:
   drop the Mixamo blob ids instead (`git rev-list --objects --all`, filter-repo `--blob-callback`), or drop the paths
   and re-add the Tripo files in one new commit. The always-safe paths to drop:

   ```bash
   git clone --no-local C:/Bunnyy/Hackathons/NEAR vivolith-clean && cd vivolith-clean
   git filter-repo --invert-paths \
     --path public/models/player.glb --path public/models/pema.glb \
     --path-glob 'public/models/npc_*.glb' --path-glob 'public/models/ped_*.glb' --path-glob 'public/models/vendor_*.glb' \
     --path public/models/v2/cast/marta.glb --path public/models/v2/cast/pema.glb \
     --path blender/convert_mixamo.py --path blender/convert_run_clip.py
   ```

3. **Do nothing.** Not recommended: the files stay downloadable from any clone.

## Before either option

- Keep `.git/pre-email-rewrite.bundle` until the new public repository is verified.
- Rerun the secrets scan on the result and check `git count-objects -vH` (expect a much smaller pack).
- Rewriting changes every commit hash: docs that quote hashes (`docs/PROGRESS.md`) need updating.
- Needs explicit approval from Bunny before anything is run or pushed.
