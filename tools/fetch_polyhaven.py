"""Download CC0 assets from Poly Haven (https://polyhaven.com, license: CC0).

Usage:  python -I tools/fetch_polyhaven.py
Writes to assets-src/downloads/polyhaven/<asset_id>/ and records authors in
assets-src/downloads/polyhaven/manifest.json (used for docs/ASSETS.md).
"""
import json
import pathlib
import urllib.request

API = "https://api.polyhaven.com"
UA = {"User-Agent": "NEARWorld-hackathon-asset-fetch/0.1"}
OUT = pathlib.Path(__file__).resolve().parent.parent / "assets-src" / "downloads" / "polyhaven"

MODELS_2K = ["modular_urban_apartments_facade", "rollershutter_door", "rollershutter_window_01"]
MODELS_1K = [
    "modular_fire_escape", "modular_electricity_poles", "street_lamp_01", "street_lamp_02",
    "fire_hydrant", "metal_trash_can", "utility_box_01", "exterior_aircon_unit",
    "modular_street_seating", "water_manhole_cover", "modular_metal_gutter",
    "wicker_basket_01", "wicker_basket_02", "plastic_crate_01", "cardboard_box_01", "Barrel_01",
    "planter_box_01", "Lantern_01", "wooden_lantern_01", "modular_wooden_pier",
    "bananas", "food_apple_01", "food_lime_01", "food_pomegranate_01", "lemon", "yellow_onion",
    # NEAR Spire lobby + Labs (Gate 3)
    "metal_office_desk", "desk_lamp_arm_01", "modern_arm_chair_01", "potted_plant_01", "potted_plant_04",
    "modern_ceiling_lamp_01", "sofa_03", "modern_coffee_table_01", "office_notepads", "planter_box_02",
    # Protocol Promenade planting
    "jacaranda_tree", "shrub_03",
]
TEXTURES_1K = ["cobblestone_floor_08", "concrete_pavement", "patterned_paving", "beige_wall_001", "brown_planks_05",
               "marble_01", "granite_tile", "metal_plate", "brushed_concrete", "terrazzo_tiles"]
TEXTURE_MAPS = ["Diffuse", "nor_gl", "Rough", "arm"]
HDRIS_2K = ["venice_sunset"]


def get_json(url: str) -> dict:
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r:
        return json.load(r)


def download(url: str, dest: pathlib.Path) -> None:
    if dest.exists() and dest.stat().st_size > 0:
        return
    dest.parent.mkdir(parents=True, exist_ok=True)
    if not url.startswith("https://dl.polyhaven.org/"):
        raise ValueError(f"unexpected download host: {url}")
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=300) as r:
        dest.write_bytes(r.read())


def fetch_model(asset: str, res: str) -> None:
    gltf = get_json(f"{API}/files/{asset}")["gltf"][res]["gltf"]
    folder = OUT / asset
    download(gltf["url"], folder / f"{asset}.gltf")
    for rel, item in gltf.get("include", {}).items():
        target = (folder / rel).resolve()
        if folder.resolve() not in target.parents:
            raise ValueError(f"path escapes asset folder: {rel}")
        download(item["url"], target)


def fetch_texture(asset: str, res: str) -> None:
    files = get_json(f"{API}/files/{asset}")
    for key in TEXTURE_MAPS:
        if key in files:
            download(files[key][res]["jpg"]["url"], OUT / asset / f"{asset}_{key}_{res}.jpg")


def fetch_hdri(asset: str, res: str) -> None:
    download(get_json(f"{API}/files/{asset}")["hdri"][res]["hdr"]["url"], OUT / asset / f"{asset}_{res}.hdr")


def main() -> None:
    manifest = {}
    jobs = [(a, "2k", fetch_model) for a in MODELS_2K] + [(a, "1k", fetch_model) for a in MODELS_1K]
    jobs += [(a, "1k", fetch_texture) for a in TEXTURES_1K] + [(a, "2k", fetch_hdri) for a in HDRIS_2K]
    for asset, res, fn in jobs:
        try:
            fn(asset, res)
            info = get_json(f"{API}/info/{asset}")
            manifest[asset] = {"name": info.get("name"), "authors": list(info.get("authors", {})), "res": res,
                               "url": f"https://polyhaven.com/a/{asset}", "license": "CC0"}
            print("ok  ", asset)
        except Exception as exc:  # report and continue; missing assets are listed at the end
            print("FAIL", asset, exc)
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(f"{len(manifest)}/{len(jobs)} assets in {OUT}")


if __name__ == "__main__":
    main()
