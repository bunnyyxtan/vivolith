// "The Night Pema Almost Closed": the first story arc, read from the economy instead of a script timer.
// It starts when Kavi first hears Pema out, targets her next rent charge, and ends only when that charge has a result:
//   connected: the contract's own record (get_stalls: last_rent reached the due market day, open or closed),
//   offline:   the local market's 21:00 rent on the due game day.
// Until then it shows the real till, the real rent and when the charge comes (a forecast, said as one).
// Everything is kept in state.flags (saved), keys prefixed "night.".
import type { EconomyState } from "../economy/state.ts";
import { MINUTES_PER_DAY } from "../economy/state.ts";

export type NightOutcome = "kept" | "closed";
export interface Clock {
  /** Current on-chain market day, or null offline. */
  readonly day: number | null;
  /** Milliseconds per market day (connected only). */
  readonly dayMs: number | null;
  readonly now: number;
}
export interface Night {
  readonly phase: "off" | "waiting" | "charging" | NightOutcome;
  /** Pema's till and rent right now. */
  readonly till: number;
  readonly rent: number;
  /** Mangoes on her shelf: coins only once shoppers buy them (selling to her lowers the till and raises this). */
  readonly shelf: number;
  /** Connected: market day of the charge. Offline: game minute of the charge. */
  readonly due: number | null;
  /** When the charge comes: real minutes (connected) or the game clock (offline). */
  readonly when: string;
  readonly connected: boolean;
}

const RENT_HOUR = 21;
const num = (v: unknown, d = -1): number => (typeof v === "number" ? v : d);

/** The first chain market day >= from on which rent is charged (day % every === 0) and that was not charged yet. */
export const nextRentDay = (from: number, every: number, lastRent: number): number => {
  let d = Math.max(from, lastRent + 1);
  while (d % every !== 0) d++;
  return d;
};
/** Offline: the game minute of the next 21:00 rent (rent days are (day - 1) % every === 0, as in sim.ts). */
export const nextRentMinute = (minute: number, every: number): number => {
  for (let d = Math.floor(minute / MINUTES_PER_DAY); ; d++) {
    const at = d * MINUTES_PER_DAY + RENT_HOUR * 60;
    if (d % every === 0 && at > minute) return at;
  }
};

const resolve = (s: EconomyState, o: NightOutcome): void => {
  if (s.flags["night.outcome"]) return;
  s.flags["night.outcome"] = o;
  s.flags["night.till"] = Math.floor(s.merchants.pema.cash);
};

/** Starts the arc (once): fixes which rent charge decides Pema's night. */
export function startNight(s: EconomyState, c: Clock): void {
  if (s.flags["night.start"] !== undefined) return;
  const m = s.merchants.pema;
  s.flags["night.start"] = true;
  if (c.day !== null) {
    s.flags["night.mode"] = "chain";
    s.flags["night.due"] = nextRentDay(c.day, m.rentEveryDays, num(s.flags["lastRent.pema"]));
  } else {
    s.flags["night.mode"] = "local";
    s.flags["night.due"] = nextRentMinute(s.minute, m.rentEveryDays);
  }
  if (m.status !== "open") resolve(s, "closed"); // already shut: nothing to save tonight, only to reopen
}

/** Re-reads the arc against the economy; returns the outcome the moment it is first known (else null). */
export function updateNight(s: EconomyState, c: Clock): NightOutcome | null {
  if (!s.flags["night.start"]) return null;
  if (s.flags["night.outcome"]) {
    // after a closed night, the stall opening again is its own, later beat
    if (s.flags["night.outcome"] === "closed" && s.merchants.pema.status === "open") s.flags["night.recovered"] = true;
    return null;
  }
  const due = num(s.flags["night.due"]);
  const pema = s.merchants.pema;
  if (s.flags["night.mode"] === "chain") {
    if (c.day === null) return null; // signed out mid-arc: wait for the chain again
    if (num(s.flags["lastRent.pema"]) >= due || pema.status !== "open") resolve(s, pema.status === "open" ? "kept" : "closed");
  } else if (s.minute >= due) resolve(s, pema.status === "open" ? "kept" : "closed");
  return (s.flags["night.outcome"] as NightOutcome | undefined) ?? null;
}

export function night(s: EconomyState, c: Clock): Night {
  const m = s.merchants.pema;
  const base = { till: Math.floor(m.cash), rent: m.rent, shelf: m.stock.mango, connected: s.flags["night.mode"] === "chain" };
  if (!s.flags["night.start"]) return { ...base, phase: "off", due: null, when: "" };
  const out = s.flags["night.outcome"] as NightOutcome | undefined;
  const due = num(s.flags["night.due"]);
  if (out) return { ...base, phase: out, due, when: "" };
  if (base.connected) {
    if (c.day === null || c.dayMs === null) return { ...base, phase: "waiting", due, when: "when the market reconnects" };
    if (c.day >= due) return { ...base, phase: "charging", due, when: "at the next market turn" };
    const mins = Math.max(1, Math.ceil((due * c.dayMs - c.now) / 60_000));
    return { ...base, phase: "waiting", due, when: `in about ${mins} min` };
  }
  return { ...base, phase: "waiting", due, when: `at ${RENT_HOUR}:00 on Day ${Math.floor(due / MINUTES_PER_DAY) + 1}` };
}

/** One honest line for the HUD: the stake, never a verdict before the charge. */
export function stakeLine(n: Night): string {
  if (n.phase !== "waiting" && n.phase !== "charging") return "";
  const short = n.rent - n.till;
  return `Pema's till ${n.till} c · rent ${n.rent} c${short > 0 ? ` (${short} c short)` : ""} · ${n.connected ? "NEAR charges it" : "charged"} ${n.when}`;
}
