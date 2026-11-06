// Stall vendors on Market Lane: short in-character exchanges, as data. Their stalls are scenery for now
// (only Pema, Tomas and the Tea House trade in the economy), so nothing here changes economy state.
import type { Conversation } from "./dialogue.ts";
import { VENDOR_ROWS } from "../cast.ts";

const LINES: Record<string, readonly [string, string]> = {
  vendor_lewis: ["Bananas by the chunk, priced by the shard. Buy a bunch and it splits four ways. That's the theory, anyway.", "Every hand on this Row has a wallet now. Mine mostly holds banana stickers."],
  vendor_kate: ["Yocto Citrus. The smallest unit of sour you can buy on the Row. Ten to the minus twenty-four of a lemon; nobody's managed it yet.", "Pema's crates are stuck again? The harbor moves at its own epoch."],
  vendor_david: ["Onions, roots, things that keep. Every epoch the prices settle, and every epoch Tomas undercuts them.", "Buy roots. They outlast rumours."],
  vendor_jennifer: ["Nightshade Orchard. Split the harvest into shards, sell each shard to a different street. It's the only way I keep up.", "The Spire people buy limes by the crate. Engineers and citrus, I don't ask."],
  vendor_steve: ["Finality Fruit. Once it's in your bag, it's yours. No take-backs, no reorgs.", "Two seconds and the deal's final. Faster than Tomas counts change."],
  vendor_louise: ["Sharded Citrus. I sell half a lemon on Tuesdays and the other half on Thursdays.", "The receipts go up the Ledger Tower now. Everyone reads them over breakfast."],
  vendor_adam: ["Rainbow Bridge Market: goods from across the water, brought over the long bridge and sold here for a fair markup.", "If it crossed the bridge, I've got it. If it didn't, give it a week."],
  vendor_jody: ["Validator Veg. Every carrot checked twice before it reaches your basket.", "Keep your stake on the good stalls. The Row remembers who it can trust."],
  vendor_brian: ["Blocktime Orchard. A new crate every second, if the harbor would let them through.", "Apples, pomegranates. Fast blocks, slow customers."],
  vendor_michelle: ["Intents Grocer. Tell me what you want, I'll find the cheapest way to get it to you. Even if that's from Pema.", "Say the intent, not the route. That's how this town shops now."],
};

export const VENDOR_CONVERSATIONS: Record<string, Conversation> = Object.fromEntries(
  VENDOR_ROWS.map(([id, name, , shop]) => {
    const [hello, more] = LINES[id];
    const conv: Conversation = {
      npcId: id,
      name,
      role: shop,
      accent: "#83dcff",
      entry: () => "hello",
      nodes: {
        hello: {
          speaker: name,
          text: () => hello,
          choices: [
            { label: "How's trade today?", next: "more" },
            { label: "Just passing through.", next: null },
          ],
        },
        more: { speaker: name, text: () => more, next: null },
      },
    };
    return [id, conv];
  }),
);
