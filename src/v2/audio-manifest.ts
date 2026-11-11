// Every audio file VIVOLITH can play, with what generates it (scripts/audio/generate.ts reads this; the game reads it
// to know which files exist to try). Files live in public/audio/; a missing file is simply silent.
// Voice lines are spoken exactly as the subtitle starts, so what you hear always matches what you read.
import type { MerchantId } from "../economy/state";

export type LineId = "hello" | "thanks" | "closed" | "reopen" | "rent_ok" | "rent_risk" | "rent_closed";

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
  pema: { brief: "warm, kind older woman, motherly market auntie", voiceId: "pFZP5JQG7iQjIQuC4Bku", tag: "[warmly]", lines: { hello: "Fresh mangoes, when the harbor lets me have them.", thanks: "Thank you, dear. Come back soon.", ...shared } },
  tomas: { brief: "smooth, confident middle-aged man, salesman's charm, a little smug", voiceId: "N2lVS1w4EtoT3dr4eOWO", tag: "[confidently]", lines: { hello: "Mangoes! More than this street can eat.", thanks: "Pleasure. Bring more coin next time.", ...shared } },
  mira: { brief: "quick, bright young woman, playful and sharp", voiceId: "cgSgspJ2msm6clMCkdW9", tag: "[playfully]", lines: { hello: "Whatever Tomas charges, I'll do a coin cheaper.", thanks: "Good trade. Tell your friends.", ...shared } },
  arin: { brief: "calm, gentle young man, soft-spoken tea house owner", voiceId: "bIHbv24MWmeRgasZH58o", tag: "[softly]", lines: { hello: "Lassi's fresh. And I always need mangoes.", thanks: "That's the afternoon's lassi sorted.", ...shared } },
};

export const voiceUrl = (id: MerchantId, line: LineId): string => `/audio/voice/${id}/${line}.mp3`;

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
