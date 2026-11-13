// Shared by the approved-lines generator (scripts/audio/lines.ts) and the voice route: how a line is cut into sentences
// and what a slot may hold.
export const NUM = "\\d{1,6}(?:[.,:]\\d{1,3})?";
export const NAME = "[A-Z][a-z]{1,13}";
/** clockOf() in src/economy/state.ts: "Day 4 08:00". */
export const CLOCK = "Day \\d{1,4} \\d{2}:\\d{2}";

/** Sentences of a line: cut after . ! ? or … followed by a space. */
export const sentences = (text: string): string[] => text.split(/(?<=[.!?…])\s+/).map((s) => s.trim()).filter(Boolean);

/** The game writes "15 c"; the voice speaks "15 coins". Undo that before matching the game's own text. */
export const writtenForm = (text: string): string => text.replace(/\b(\d+) coins?\b/g, "$1 c");

/** A matcher over the approved sentences: true only when every sentence of the line is approved. */
export function approvedLines(a: { exact: readonly string[]; shapes: readonly string[] }): (line: string) => boolean {
  const exact = new Set(a.exact);
  const shapes = a.shapes.length ? new RegExp(`^(?:${a.shapes.join("|")})$`) : /$^/;
  const name = new RegExp(`^${NAME}$`);
  const whole = (s: string): boolean => exact.has(s) || shapes.test(s);
  // a sentence the game joins from listed fragments ("Rin, your 3 mangoes kept my shelves selling, and you bought into
  // the stall."): every comma clause must itself be game text or the player's name
  const one = (s: string): boolean => {
    if (whole(s)) return true;
    const cl = s.replace(/[.!?…]+$/, "").split(/,\s+/);
    return cl.length > 1 && cl.every((c) => whole(c) || name.test(c));
  };
  return (line) => {
    const ss = sentences(line.replace(/\s+/g, " ").trim());
    return ss.length > 0 && ss.every((s) => !/[\p{L}\p{N}]/u.test(s) || one(s) || one(writtenForm(s)));
  };
}
