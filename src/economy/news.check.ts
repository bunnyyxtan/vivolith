// Town news reads as English, old and new.  node src/economy/news.check.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import { countOf, gossipLine, readableNews, type ChronicleEvent } from "./chronicle.ts";
import { initialEconomy } from "./state.ts";
import { SHARE_PACK, invest, playerBuy, sellShares } from "./sim.ts";

// one helper, every count
assert.equal(countOf(0, "mango"), "0 mangoes");
assert.equal(countOf(1, "mango"), "1 mango");
assert.equal(countOf(2, "mango"), "2 mangoes");
assert.equal(countOf(30, "mango"), "30 mangoes");
assert.equal(countOf(1, "lassi"), "1 lassi");
assert.equal(countOf(12, "lassi"), "12 lassis");
assert.equal(countOf(1, "share"), "1 share");
assert.equal(countOf(0, "crate"), "0 crates");

// historical entries as production stored them (vivolith.world chronicle, 2026-11-13), read for display
const OLD: Record<string, string> = {
  "Lin sold 2 mangos to Arin Okoye at 6 c.": "Lin sold 2 mangoes to Arin Okoye at 6 c.",
  "A player sold 2 mango to Pema at 4 c.": "A player sold 2 mangoes to Pema at 4 c.",
  "A player bought 3 mango from Tomas at 3 c.": "A player bought 3 mangoes from Tomas at 3 c.",
  "A player bought 12 mango from Tomas at 3 c.": "A player bought 12 mangoes from Tomas at 3 c.",
  "Auntie Pema could not pay 30 c rent with 15 c in the till and closed; it reopens after 1 mangoes are delivered.":
    "Auntie Pema could not pay 30 c rent with 15 c in the till and closed; it reopens after 1 mango is delivered.",
  "Mira Sol could not pay 30 c rent with 4 c in the till and closed; it reopens after 3 mango is delivered.":
    "Mira Sol could not pay 30 c rent with 4 c in the till and closed; it reopens after 3 mangoes are delivered.",
  "Lin sold 0 mango to Mira Sol at 5 c.": "Lin sold 0 mangoes to Mira Sol at 5 c.",
  "Dev sold 1 lemons to Mira Sol at 2 c.": "Dev sold 1 lemon to Mira Sol at 2 c.",
  "You bought 2 lassi from Arin for 6 c.": "You bought 2 lassis from Arin for 6 c.",
  "You bought 1 shares of Pema's Fruit for 9 c.": "You bought 1 share of Pema's Fruit for 9 c.",
  "1 pre-paid crates went from Pema to the Tea House.": "1 pre-paid crate went from Pema to the Tea House.",
};
for (const [stored, shown] of Object.entries(OLD)) assert.equal(readableNews(stored), shown, stored);

// correct or unrelated text is left exactly as it is: names, prices, other words, figures
const SAME = [
  "Lin sold 1 mango to Arin Okoye at 6 c.", "A player bought 3 mangoes from Pema at 5 c.", "Lin bought a lassi from Arin Okoye for 3 c.",
  "Arin Okoye raised the mango bid from 5 to 6 c.", "Auntie Pema lowered the mango bid from 5 to 4 c.",
  "Mira Sol's stall is open again: enough mangoes were delivered.", "Pema's stall reopened after a delivery.", "Arin Okoye paid 30 c rent.",
  "Tomas Vell's rent was waived once: the stall reopened 1 market day ago and has 12 c (recovery grace, once per reopening).",
  "Tomas brought 5 mango crates.", "Pema set 4 mango prices.", "+12 c dividends from Pema's Fruit (day 3: 40 c sales, 15/100 shares).",
  "Tea House pre-paid Pema 24 c for 3 crates on the held shipment.", "A player sold 2 mangoes to Pema at 4 c (Pema's own bid was 5 c).",
];
for (const t of SAME) assert.equal(readableNews(t), t, t);
for (const shown of Object.values(OLD)) assert.equal(readableNews(shown), shown, `idempotent: ${shown}`);
// numbers are never changed: every digit run of the stored text survives, in order
for (const stored of Object.keys(OLD)) assert.deepEqual(readableNews(stored).match(/\d+/g), stored.match(/\d+/g), stored);

// gossip (what townsfolk repeat) reads the same way; the event itself is not modified
const ev: ChronicleEvent = { id: "x", at: 1, day: 1, kind: "resident", actors: ["picker"], text: "Lin sold 2 mangos to Arin Okoye at 6 c.", changes: [{ who: "picker", good: "mango", delta: -2 }], status: "confirmed", txHash: "abc", decision: null, since: [], player: null };
const frozen = JSON.stringify(ev);
assert.equal(gossipLine(ev, (id) => id), "Lin sold 2 mangoes to Arin Okoye at 6 c.");
assert.equal(JSON.stringify(ev), frozen, "the stored event is unchanged");

// new offline entries: 1, 2 and more
const s = initialEconomy();
s.player.coins = 500;
assert.ok(playerBuy(s, "tomas", "mango", 1).ok); assert.ok(playerBuy(s, "tomas", "mango", 2).ok); assert.ok(playerBuy(s, "mira", "lemon", 1).ok);
const said = s.log.filter((l) => l.kind === "player").map((l) => l.text);
assert.ok(said.some((t) => /^You bought 1 mango from /.test(t)) && said.some((t) => /^You bought 2 mangoes from /.test(t)) && said.some((t) => /^You bought 1 lemon from /.test(t)), said.join(" | "));
const pack = SHARE_PACK.pema.per; // shares come in packs: never "1 share" in play, but the helper says it right
assert.ok(invest(s, "pema", pack).ok && sellShares(s, "pema", pack).ok);
assert.ok(s.log.some((l) => l.text.startsWith(`You bought ${countOf(pack, "share")} of `)) && s.log.some((l) => l.text.startsWith(`You sold ${countOf(pack, "share")} of `)));
for (const l of s.log) assert.equal(readableNews(l.text), l.text, `new entries need no correction: ${l.text}`);

// new server entries use the same helper (resident sales, player trades, delivery recall); rent closing agrees in number
const h = fs.readFileSync("server/near/handlers.ts", "utf8");
assert.ok(h.includes("const goodsText = (good: string, n: number): string => countOf(n, good);"));
assert.equal((h.match(/goodsText\(/g) ?? []).length, 4, "player sold, player bought, resident sold, delivery recall");
assert.ok(h.includes('${Math.max(1, need) === 1 ? "mango is" : "mangoes are"} delivered.'));
assert.ok(!/\$\{[^}]*\}\s+mangos\b|\}s\b to \$\{/.test(h), "no hand-made plurals left in Town news");
console.log("news.check: ok");
