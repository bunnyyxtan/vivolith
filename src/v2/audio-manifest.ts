// Every audio file VIVOLITH can play, with what generates it (scripts/audio/generate.ts reads this; the game reads it
// to know which files exist to try). Files live in public/audio/; a missing file is simply silent.
// Voice lines are spoken exactly as the subtitle starts, so what you hear always matches what you read.
import type { MerchantId } from "../economy/state";
import { initialEconomy } from "../economy/state.ts";
import { CONVERSATIONS } from "../quests/mango.ts";

/** haggle_ok / haggle_no / refuse are short openers spoken before the live haggle text (which carries the numbers);
 *  bump is a reaction when Kavi walks into them. */
export type LineId = "hello" | "thanks" | "closed" | "reopen" | "rent_ok" | "rent_risk" | "rent_closed" | "haggle_ok" | "haggle_no" | "refuse" | "bump"
  | "invest_pitch" | "invest_done" | "shares_sold";

export interface Voice {
  /** Who they sound like (used to pick a pre-made ElevenLabs voice once). */
  readonly brief: string;
  /** The chosen ElevenLabs voice (filled in from `generate.ts --voices`; empty = not chosen yet). */
  readonly voiceId: string;
  /** Delivery direction for Eleven v4 (an audio tag, never spoken or shown). */
  readonly tag: string;
  readonly lines: Record<LineId, string>;
}

const shared = {
  closed: "The shutters are down: I couldn't make rent. Bring me stock and I can open again.",
  reopen: "We're open again, thanks to you!",
  rent_ok: "Lights on!",
  rent_risk: "I'm in trouble.",
  rent_closed: "Shutters down.",
};

/** Four recognisable merchants: one voice each, chosen once and kept. */
export const VOICES: Record<MerchantId, Voice> = {
  pema: { brief: "warm, kind older woman, motherly market auntie", voiceId: "pFZP5JQG7iQjIQuC4Bku", tag: "[warmly]", lines: { hello: "Fresh mangoes, when the harbor lets me have them.", thanks: "Thank you, dear. Come back soon.", ...shared,
    haggle_ok: "Oh, alright, dear.", haggle_no: "Now, now, be fair with me.", refuse: "That's my last word, dear.", bump: "Oh! Careful, dear!",
    invest_pitch: "Buy a few shares, dear, and you share in every mango I sell.", invest_done: "A partner! Thank you, dear.", shares_sold: "Of course, dear. Come back anytime." } },
  tomas: { brief: "smooth, confident middle-aged man, salesman's charm, a little smug", voiceId: "N2lVS1w4EtoT3dr4eOWO", tag: "[confidently]", lines: { hello: "Mangoes! More than this street can eat.", thanks: "Pleasure. Bring more coin next time.", ...shared,
    haggle_ok: "Fine, fine. You win this one.", haggle_no: "Ha! Not a chance.", refuse: "We're done here.", bump: "Watch the merchandise!",
    invest_pitch: "Want a piece of my stall? Every sale I make, you take your cut.", invest_done: "Welcome aboard, partner. Now let's sell some mangoes.", shares_sold: "Cashing out? Your loss." } },
  mira: { brief: "quick, bright young woman, playful and sharp", voiceId: "cgSgspJ2msm6clMCkdW9", tag: "[playfully]", lines: { hello: "Whatever Tomas charges, I'll do a coin cheaper.", thanks: "Good trade. Tell your friends.", ...shared,
    haggle_ok: "Ooh, sharp. Okay!", haggle_no: "Nice try!", refuse: "Nope, I'm out.", bump: "Hey, eyes up!",
    invest_pitch: "Own a slice of my stall and earn on every flip I make.", invest_done: "Partner! Let's make some coin.", shares_sold: "Sold back. No hard feelings!" } },
  // Arin: was "Will" with a [softly] tag, which came out breathy; now Chris, warm and confident (samples in tools/voice-samples)
  arin: { brief: "warm, confident, expressive tea house owner, a natural merchant", voiceId: "iP95p4xoKVk53GoZ742B", tag: "[warmly]", lines: { hello: "Lassi's fresh. And I always need mangoes.", thanks: "That's the afternoon's lassi sorted.", ...shared,
    haggle_ok: "That seems fair.", haggle_no: "I can't go that low.", refuse: "Let's leave it there.", bump: "Whoa, sorry about that!",
    invest_pitch: "Shares in the tea house pay out every time I sell a lassi.", invest_done: "Thank you. We'll do well together.", shares_sold: "That's alright. The door's always open." } },
};

export const voiceUrl = (id: MerchantId, line: LineId): string => `/audio/voice/${id}/${line}.mp3`;

/** Townsfolk reaction voices (pre-made ElevenLabs voices): each townsperson keeps one voice; bump lines are what the
 *  speech bubble shows, so sound and text match. Files: /audio/voice/folk<n>/bump_<k>.mp3. */
export const FOLK_VOICES = [
  { voiceId: "FGY2WhTYpPnrIDTdsKH5", tag: "[surprised]", bump: ["Whoa!", "Hey, watch out!"] },   // Laura: young woman
  { voiceId: "IKne3meq5aSn9XLyUdCD", tag: "[startled]", bump: ["Oof!", "Easy there!"] },        // Charlie: young man
  { voiceId: "pqHfZKP75CvOlQylNhV4", tag: "[grumbling]", bump: ["Careful!", "Hey!"] },          // Bill: older man
  { voiceId: "XrExE9yKIg1WjnnlVkGX", tag: "[surprised]", bump: ["Excuse you!", "Oh my!"] },     // Matilda: woman
] as const;
/** Non-trading cast with a fixed post (Bram at the harbor, Ines in NEAR Labs): their recorded bump reactions, in the same
 *  voices SPEAKERS gives them. Files: /audio/voice/<id>/bump_<k>.mp3. */
export const CAST_BUMP = { harbor: ["Watch it, pal!", "Mind the crates!"], engineer: ["Oh! Careful!", "Excuse me!"] } as const;
export type CastBumpId = keyof typeof CAST_BUMP;
export const castBumpUrl = (id: CastBumpId, k: number): string => `/audio/voice/${id}/bump_${k}.mp3`;
export const folkVoiceUrl = (voice: number, k: number): string => `/audio/voice/folk${voice}/bump_${k}.mp3`;

/** Every voiced character, by speaker id: merchants, townsfolk voices (folk0..3) and the non-trading cast. The server
 *  voice route (server/near/voice.ts) speaks lines that have no recorded file with exactly these voices. */
export const SPEAKERS: Record<string, { voiceId: string; tag: string }> = {
  ...Object.fromEntries(Object.entries(VOICES).map(([id, v]) => [id, { voiceId: v.voiceId, tag: v.tag }])),
  ...Object.fromEntries(FOLK_VOICES.map((v, n) => [`folk${n}`, { voiceId: v.voiceId, tag: v.tag.replace(/\[(surprised|startled|grumbling)\]/, "[casually]") }])),
  engineer: { voiceId: "Xb7hH8MSUJpSbSDYk0k2", tag: "[thoughtfully]" }, // Alice: Ines Varga, NEAR Labs
  harbor: { voiceId: "CwhRBWXzGAHq8TQ4Fs17", tag: "[gruffly]" },         // Roger: the harbor dispatcher
  // residents (src/economy/residents.ts), voices no townsperson or merchant uses (premade list read 2026-11-13)
  picker: { voiceId: "EXAVITQu4vr4xnSDxMaL", tag: "[cheerfully]" },      // Sarah: Lin, the orchard picker
  porter: { voiceId: "nPczCjzI2devNBz1zQrb", tag: "[dryly]" },           // Brian: Dev, the harbor porter
};

/** How a line should be delivered, decided by the game from real events (never by the model). One restrained audio
 *  tag replaces the speaker's usual tag; "neutral" keeps it. */
export type Mood = "neutral" | "worried" | "relieved" | "down" | "grateful";
export const MOODS: readonly Mood[] = ["neutral", "worried", "relieved", "down", "grateful"];
const MOOD_TAG: Record<Exclude<Mood, "neutral">, string> = { worried: "[concerned]", relieved: "[relieved]", down: "[quietly]", grateful: "[warmly]" };
export const moodTag = (speaker: string, mood: Mood = "neutral"): string => (mood === "neutral" ? SPEAKERS[speaker]?.tag ?? "" : MOOD_TAG[mood]);

/** Speech text for a subtitle: the same words, only the coin unit read out ("15 c" -> "15 coins"). Word for word, so
 *  word n of the subtitle is word n of the speech (timings map back one to one). */
export const spokenText = (text: string): string => text.replace(/\b(\d+)\s?c\b/g, (_, n: string) => `${n} ${n === "1" ? "coin" : "coins"}`);

/** Fixed one-off lines spoken in the economy flow (the rest of that flow is live figures, voiced by an opener plus the server). */
const EVENT_LINES: Record<string, string[]> = {
  // "Oh, a new face! I'm Pema." is the fixed opening of her live greeting (its shelf count varies): recorded alone, it
  // plays whatever her stock, and the figures follow from the server (audio.ts opener)
  pema: ["Oh, a new face! I'm Pema.", "Oh, a new face! I'm Pema. Don't look at my shelves, dear: 3 mangoes left, and rent is coming.", "You saved my morning, Kavi!", "A partner! I've paid the harbor. My crates are coming!"],
  tomas: ["There you go. Don't tell Pema where you got them."],
  mira: [], arin: [],
};
const fnv = (t: string): string => { let h = 0x811c9dc5; for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(16).padStart(8, "0"); };
/** Every static line of every conversation (read with the opening economy) plus the fixed event lines, per speaker.
 *  Lines whose text carries live numbers differ from these and are voiced by the server instead. */
export const STATIC_LINES: Record<string, string[]> = (() => {
  const out: Record<string, Set<string>> = {};
  const eco = initialEconomy();
  for (const [id, c] of Object.entries(CONVERSATIONS)) {
    for (const n of Object.values(c.nodes)) { try { (out[id] ??= new Set()).add(n.text(eco)); } catch { /* node needs state this opening economy lacks */ } }
  }
  for (const [id, ls] of Object.entries(EVENT_LINES)) for (const l of ls) (out[id] ??= new Set()).add(l);
  return Object.fromEntries(Object.entries(out).map(([id, s]) => [id, [...s]]));
})();
export const staticUrl = (speaker: string, text: string): string => `/audio/voice/${speaker}/s${fnv(text)}.mp3`;

/** The recorded file for a line, when this speaker has one with exactly this text (else the server voices it). */
export function recordedUrl(speaker: string, text: string): string | null {
  const v = VOICES[speaker as MerchantId];
  if (v) {
    const line = (Object.keys(v.lines) as LineId[]).find((k) => v.lines[k] === text);
    if (line) return voiceUrl(speaker as MerchantId, line);
  }
  if (STATIC_LINES[speaker]?.includes(text)) return staticUrl(speaker, text);
  if (v) return null;
  const cb = CAST_BUMP[speaker as CastBumpId] as readonly string[] | undefined;
  if (cb) { const k = cb.indexOf(text); return k >= 0 ? castBumpUrl(speaker as CastBumpId, k) : null; }
  const m = /^folk(\d)$/.exec(speaker);
  const f = m ? FOLK_VOICES[Number(m[1])] : undefined;
  const k = f ? (f.bump as readonly string[]).indexOf(text) : -1;
  return k >= 0 ? folkVoiceUrl(Number(m![1]), k) : null;
}

/** One house style for every effect, so nothing sounds borrowed from another game. */
export const SFX_STYLE = "clean, warm, soft-edged, cosy anime slice-of-life game sound, close and dry, no music";

/** Sound effects generated once. UI clicks, coin chimes and footstep fallbacks are synthesised in code (audio.ts). */
export const SFX = {
  goods: { prompt: "small wooden crate of fruit set down on a market counter, soft thud", seconds: 1 },
  deal: { prompt: "a cheerful little market bell ding after a handshake, bright and short", seconds: 1.5 },
  coin_big: { prompt: "a small handful of coins poured into a cloth purse, pleasant jingle", seconds: 1.5 },
  closed: { prompt: "metal roller shutter pulled down on a small market stall", seconds: 2 },
  reopen: { prompt: "metal roller shutter rolled up on a market stall, then a small shop bell", seconds: 2.5 },
  ui_open: { prompt: "soft paper notebook opening, gentle whoosh", seconds: 0.6 },
  ui_close: { prompt: "soft paper notebook closing, gentle tap", seconds: 0.6 },
  step_done: { prompt: "short happy two-note marimba jingle for completing a task", seconds: 1.5 },
  rent_bell: { prompt: "an old town clock bell striking once in the evening, far off, warm", seconds: 3 },
  harbor_horn: { prompt: "a distant cargo ship horn across a harbor, soft and long", seconds: 3 },
  car_pass: { prompt: "a quiet electric car passing by slowly on a city street, tyre hiss, left to right", seconds: 3 },
  step_1: { prompt: "a single sneaker footstep on stone pavers", seconds: 0.5 },
  step_2: { prompt: "a single sneaker footstep on stone pavers, slightly different", seconds: 0.5 },
  step_3: { prompt: "a single sneaker footstep on stone pavers, light", seconds: 0.5 },
} as const;
export type SfxFile = keyof typeof SFX;
export const sfxUrl = (id: SfxFile): string => `/audio/sfx/${id}.mp3`;

/** Ambience beds (seamless loops) and music (looping, crossfaded by time of day and place). */
export const AMBIENCE = {
  day: { prompt: "bright city street in the daytime, distant light traffic, birds chirping, soft passing footsteps, no voices up close", seconds: 24 },
  market: { prompt: "lively open-air fruit market, friendly murmur of a crowd, crates set down, distant laughter, no clear words", seconds: 24 },
  night: { prompt: "calm city at night, crickets, faint distant traffic, a soft breeze", seconds: 24 },
} as const;
export type AmbienceId = keyof typeof AMBIENCE;

/** One musical identity: the same warm palette in every track, original, instrumental, loopable. */
export const MUSIC_STYLE = "original instrumental music for a cosy anime city game, warm and hopeful, seamless loop, no vocals";
export const MUSIC = {
  title: { prompt: "gentle title theme, warm piano and soft strings, a hint of marimba, slow and inviting", seconds: 90 },
  day: { prompt: "light cheerful city exploration, acoustic guitar, marimba, soft brushed drums, mid tempo", seconds: 90 },
  market: { prompt: "bouncy market day, pizzicato strings, hand percussion, playful flute, busy and friendly", seconds: 90 },
  sunset: { prompt: "nostalgic sunset, warm electric piano, soft synth pads, slow groove", seconds: 90 },
  night: { prompt: "calm night city lo-fi, mellow keys, vinyl warmth, gentle beat", seconds: 90 },
} as const;
export type MusicId = keyof typeof MUSIC;
export const loopUrl = (kind: "music" | "ambience", id: string): string => `/audio/${kind}/${id}.mp3`;
