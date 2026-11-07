// Character registry: every person in VIVOLITH, its model, clips, role, look, where/when it appears,
// what it can do, its collision and its performance tier. Models are Mixamo characters converted by
// blender/convert_mixamo.py (CAST table there). Positions are three.js coordinates.

export type Tier = "hero" | "named" | "crowd";

export interface CastMember {
  readonly id: string;
  readonly name: string;
  readonly role: string;
  /** Mixamo source character (provenance; see docs/ASSETS.md). */
  readonly source: string;
  readonly url: string;
  readonly height: number;
  readonly clips: readonly string[];
  readonly appearance: string;
  /** Fixed post for named characters (feet position, yaw facing at rest). */
  readonly post?: { readonly x: number; readonly y: number; readonly z: number; readonly yaw: number };
  /** Where the player stands to talk (radius in metres); the conversation id is the member id. */
  readonly talk?: { readonly x: number; readonly z: number; readonly radius: number; readonly focusY: number };
  readonly schedule: string;
  /** Collision radius in metres (vertical cylinder, see physics/collision.ts). */
  readonly radius: number;
  /** hero: player; named: 1k textures, own post + dialogue; crowd: 512 textures, budgeted count. */
  readonly tier: Tier;
}

const PEDESTRIAN_ROWS = [
  ["ped_sophie", "Sophie", "Resident · orange knit, jeans", 1.66],
  ["ped_shannon", "Shannon", "Student · texting while she walks", 1.64],
  ["ped_megan", "Megan", "Office worker · smart casual", 1.65],
  ["ped_bryce", "Bryce", "Tourist · red tee and shorts, looks around", 1.8],
  ["ped_josh", "Josh", "Courier · dark jacket, hurried walk", 1.78],
  ["ped_pete", "Pete", "Harbor worker · hi-vis vest", 1.8],
  ["ped_porter", "Peasant Man", "Market porter · carries a bag", 1.72],
  ["ped_abe", "Abe", "Resident · purple shirt", 1.74],
] as const;

/** Stall vendors: [id, display name, Mixamo source, stall title, stall x, north side?, height, look]. */
export const VENDOR_ROWS = [
  ["vendor_lewis", "Dev Anand", "Lewis", "Chunk & Shard", 38, true, 1.78, "Grey hoodie, rolled sleeves"],
  ["vendor_kate", "Kate Morrow", "Kate", "Yocto Citrus", 47.5, true, 1.66, "Denim jacket, ponytail"],
  ["vendor_david", "David Mensah", "David", "Epoch Roots", 57, true, 1.8, "Dark shirt, short beard"],
  ["vendor_jennifer", "Jen Alvarez", "Jennifer", "Nightshade Orchard", 66.5, true, 1.66, "Red top, dark hair"],
  ["vendor_steve", "Steve Rourke", "Steve", "Finality Fruit", 23.5, false, 1.8, "Olive field jacket"],
  ["vendor_louise", "Louise Tan", "Louise", "Sharded Citrus", 33, false, 1.66, "Navy blazer, jeans"],
  ["vendor_adam", "Adam Petrov", "Adam", "Rainbow Bridge Market", 42.5, false, 1.8, "White tee, work trousers"],
  ["vendor_jody", "Jody Nakamura", "Jody", "Validator Veg", 52, false, 1.66, "Pink cardigan"],
  ["vendor_brian", "Brian Kowalski", "Brian", "Blocktime Orchard", 61.5, false, 1.78, "Sweater over collar"],
  ["vendor_michelle", "Michelle Diallo", "Michelle", "Intents Grocer", 71, false, 1.66, "Yellow trousers, braids"],
] as const;

export const CAST: readonly CastMember[] = [
  {
    id: "player", name: "Remy", role: "Player · newcomer with a handcart", source: "Remy",
    url: "/models/player.glb", height: 1.76, clips: ["Idle", "Walk", "Run"],
    appearance: "Young man, dark jacket over a tee, jeans, trainers",
    schedule: "Player-controlled", radius: 0.35, tier: "hero",
  },
  {
    id: "pema", name: "Auntie Pema", role: "Fruit seller · Pema's Fruit (stall n0)", source: "Peasant Girl",
    url: "/models/pema.glb", height: 1.62, clips: ["Idle", "Talking"],
    appearance: "Market woman, headscarf, layered work dress",
    post: { x: 19, y: 0.15, z: -6.9, yaw: 0 }, talk: { x: 19, z: -4.3, radius: 2.4, focusY: 1.55 },
    schedule: "Behind her stall while it is open; the economy can close it", radius: 0.3, tier: "named",
  },
  {
    id: "tomas", name: "Tomas Vell", role: "Rival fruit seller · Vell's Fine Produce (stall n1)", source: "Joe",
    url: "/models/npc_tomas.glb", height: 1.82, clips: ["Idle", "Talking"],
    appearance: "Tall man in a dark tailored suit: the only merchant on the Row who dresses for the bank",
    post: { x: 28.5, y: 0.15, z: -6.9, yaw: 0 }, talk: { x: 28.5, z: -4.3, radius: 2.4, focusY: 1.7 },
    schedule: "At his stall all day; restocks from the harbor at 06:00 under his standing contract", radius: 0.3, tier: "named",
  },
  {
    id: "arin", name: "Arin Okoye", role: "Owner · Saltlight Tea House", source: "Martha",
    url: "/models/npc_teahouse.glb", height: 1.66, clips: ["Idle", "Talking"],
    appearance: "Woman in a soft blouse and slacks, hair tied back: front-of-house host",
    post: { x: 33.6, y: 0.15, z: -7.3, yaw: 0 }, talk: { x: 33.6, z: -5.2, radius: 2.0, focusY: 1.55 },
    schedule: "At the Tea House door; buys mangoes at 07:00 from the cheapest seller", radius: 0.3, tier: "named",
  },
  {
    id: "engineer", name: "Ines Varga", role: "Protocol engineer · NEAR Labs", source: "Elizabeth",
    url: "/models/npc_engineer.glb", height: 1.68, clips: ["Idle", "Talking", "Explain", "Walk"],
    appearance: "Engineer in a striped knit and jeans, short hair",
    post: { x: -18.9, y: 0.05, z: -66.6, yaw: -Math.PI / 2 }, talk: { x: -19.8, z: -65.4, radius: 2.2, focusY: 1.6 },
    schedule: "NEAR Labs, by the agent-feed wall", radius: 0.3, tier: "named",
  },
  ...VENDOR_ROWS.map(([id, name, source, shop, x, north, height, appearance]): CastMember => ({
    id, name, role: `Stall vendor · ${shop}`, source, url: `/models/${id}.glb`, height, clips: ["Idle", "Talking"], appearance,
    // Behind the table, facing the lane (north row faces +z, south row faces -z).
    post: { x, y: 0.15, z: north ? -6.9 : 6.9, yaw: north ? 0 : Math.PI },
    talk: { x, z: north ? -4.3 : 4.3, radius: 2.2, focusY: height - 0.1 },
    schedule: "At the stall during market hours", radius: 0.3, tier: "named",
  })),
  ...PEDESTRIAN_ROWS.map(([id, source, appearance, height]): CastMember => ({
    id, name: source, role: "Pedestrian", source, url: `/models/${id}.glb`, height, clips: ["Idle", "Walk"],
    appearance, schedule: "Walks the lane / plaza / Spire routes, browses open stalls", radius: 0.3, tier: "crowd",
  })),
];

export const NAMED_NPCS = CAST.filter((c) => c.tier === "named");
export const PEDESTRIANS = CAST.filter((c) => c.tier === "crowd");
