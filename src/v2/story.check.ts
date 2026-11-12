// Run: node src/v2/story.check.ts   (Pema's night ends only on a real rent result, never on a timer)
import assert from "node:assert/strict";
import { initialEconomy, MINUTES_PER_DAY } from "../economy/state.ts";
import { advance } from "../economy/sim.ts";
import { night, nextRentDay, nextRentMinute, stakeLine, startNight, updateNight } from "./story.ts";

const DAY_MS = 600_000;
assert.equal(nextRentDay(101, 2, -1), 102);
assert.equal(nextRentDay(102, 2, 102), 104, "a day already charged is not charged again");
assert.equal(nextRentMinute(9 * 60, 2), 21 * 60, "Day 1 is a rent day");
assert.equal(nextRentMinute(22 * 60, 2), 2 * MINUTES_PER_DAY + 21 * 60, "Day 2 is not");

// Connected: the due day passing changes nothing until the chain records the charge.
const s = initialEconomy();
s.flags["lastRent.pema"] = 100;
startNight(s, { day: 101, dayMs: DAY_MS, now: 101 * DAY_MS });
assert.equal(s.flags["night.due"], 102);
assert.match(stakeLine(night(s, { day: 101, dayMs: DAY_MS, now: 101.5 * DAY_MS })), /in about 5 min/);
assert.equal(updateNight(s, { day: 105, dayMs: DAY_MS, now: 105 * DAY_MS }), null, "time alone is no verdict");
assert.equal(night(s, { day: 105, dayMs: DAY_MS, now: 105 * DAY_MS }).phase, "charging");
s.flags["lastRent.pema"] = 102;
assert.equal(updateNight(s, { day: 105, dayMs: DAY_MS, now: 0 }), "kept");
assert.equal(updateNight(s, { day: 105, dayMs: DAY_MS, now: 0 }), null, "reported once");

// Connected, closed by the charge; later deliveries reopen it: recovered.
const c = initialEconomy();
startNight(c, { day: 7, dayMs: DAY_MS, now: 0 });
c.flags["lastRent.pema"] = 8; c.merchants.pema.status = "closed";
assert.equal(updateNight(c, { day: 8, dayMs: DAY_MS, now: 0 }), "closed");
c.merchants.pema.status = "open";
updateNight(c, { day: 9, dayMs: DAY_MS, now: 0 });
assert.equal(c.flags["night.recovered"], true);

// Offline: decided by the local market's own 21:00 rent, the till against the rent.
const o = initialEconomy();
startNight(o, { day: null, dayMs: null, now: 0 });
o.merchants.pema.cash = 0;
advance(o, 21 * 60 - o.minute - 1);
assert.equal(updateNight(o, { day: null, dayMs: null, now: 0 }), null, "not before 21:00");
advance(o, 2);
assert.equal(updateNight(o, { day: null, dayMs: null, now: 0 }), o.merchants.pema.status === "open" ? "kept" : "closed");
console.log("story.check: ok");
