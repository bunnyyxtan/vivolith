// Spoken lines that cannot be recorded ahead of time (haggle numbers, conversation answers, Rent Night figures):
// ElevenLabs text-to-speech with each character's fixed voice, through the `with-timestamps` endpoint (verified in
// @elevenlabs/elevenlabs-js 2.77: POST /v1/text-to-speech/{voice_id}/with-timestamps returns audio_base64 plus a
// per-character alignment), so subtitles follow the real speech. Recorded files cover every frequent line; this route
// only voices what is left. The key stays on the server. Answers are cached by (speaker, mood, text); identical
// requests in flight share one paid call; a request timeout and a daily character budget bound the cost. Over budget
// or unavailable, the game shows subtitles without speech.
// Mock mode (VIVOLITH_VOICE_MOCK=1, never on a production deployment): a locally synthesised placeholder voice with
// exact word timings, so the whole pipeline can be played without credits. Responses say `mock: true`.
// Who may spend: a line the server itself validated carries a short-lived speech token (HMAC over speaker, mood and
// text, see speechToken); any other line must be made only of the game's own words (lexicon.json, numbers, one name),
// so the route cannot be used as a general text-to-speech service. Spend is charged before the provider is called and
// is only returned when the provider refused the request outright (4xx): a timeout or a broken answer may still be
// billed, so it stays spent, and the same line is not retried for a minute.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { SPEAKERS, MOODS, moodTag, type Mood } from "../../src/v2/audio-manifest.ts";
import LEXICON from "./lexicon.json" with { type: "json" };

const MODEL = "eleven_v4"; // the model every recorded line was made with: dynamic speech must sound the same
export const MAX_TEXT = 240;
const TIMEOUT_MS = 9000;
/** ponytail: per server instance and day; the handler adds a shared daily request cap (Redis) on top. */
const DAILY_CHARS = 6000;
const CACHE_MAX = 300;
/** Provider calls running at once on this instance (ElevenLabs plans cap concurrency too). */
const MAX_INFLIGHT = 4;
const RETRY_AFTER_MS = 60_000;
const TOKEN_TTL_MS = 15 * 60_000;

export interface VoiceBody {
  status: string; message?: string; audio?: string; mime?: string;
  /** Start time (s) of each whitespace-separated word of the text, from the provider's alignment; absent when unknown. */
  words?: number[];
  mock?: boolean;
}
export interface VoiceResult { status: number; body: VoiceBody }
export interface VoiceOptions {
  readonly mood?: string;
  readonly mock?: boolean;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  /** A shared spend counter (the handler's Redis budget): false refuses the call before it is made. */
  readonly charge?: (chars: number) => Promise<boolean>;
}

/** Normal form of a line for signing and checking (what synthesize speaks). */
export const voiceText = (raw: string): string => raw.replace(/\s+/g, " ").trim();

/** A token for one line the server validated (a conversation answer): lets the browser have exactly this line voiced,
 *  by this speaker and mood, for 15 minutes. */
export function speechToken(secret: string, speaker: string, mood: string, text: string, now = Date.now()): string {
  const exp = now + TOKEN_TTL_MS;
  return `${exp}.${createHmac("sha256", secret).update(`${speaker}|${mood}|${exp}|${voiceText(text)}`).digest("base64url")}`;
}
export function speechTokenOk(secret: string, token: unknown, speaker: string, mood: string, text: string, now = Date.now()): boolean {
  if (typeof token !== "string") return false;
  const [exp, sig] = token.split(".");
  if (!sig || !(Number(exp) > now) || Number(exp) > now + TOKEN_TTL_MS) return false;
  const want = createHmac("sha256", secret).update(`${speaker}|${mood}|${exp}|${voiceText(text)}`).digest();
  const got = Buffer.from(sig, "base64url");
  return got.length === want.length && timingSafeEqual(got, want);
}
/** The signing secret: derived from the relayer's merchant secret; without one, random per instance (dev only). */
let devSecret = "";
export function voiceSecret(merchantSecret: string | undefined): string {
  const s = merchantSecret?.trim();
  if (s) return createHmac("sha256", s).update("vivolith-voice").digest("hex");
  return (devSecret ||= randomBytes(32).toString("hex"));
}

const WORDS = new Set<string>(LEXICON as string[]);
/** True when every word of the line is the game's own (string literals of the game's text), a number or a time, with
 *  at most one other capitalised word (the player's chosen name). */
export function gameWords(text: string): boolean {
  let names = 0;
  for (const raw of voiceText(text).split(/[\s/‐-—-]+/)) {
    const w = raw.replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}]+$/gu, "");
    if (!w || /^\d{1,6}(?:[:.,]\d{1,3})?%?$/.test(w) || WORDS.has(w.toLowerCase())) continue;
    if (/^[A-Z][a-z]{1,13}$/.test(w) && names++ === 0) continue;
    return false;
  }
  return true;
}

const cache = new Map<string, VoiceBody>();
const inflight = new Map<string, Promise<VoiceResult>>();
const failed = new Map<string, number>();
let day = "", spent = 0;

/** Word start times from a character alignment: where each word of `text` begins in the aligned characters. */
export function wordStarts(text: string, chars: readonly string[], starts: readonly number[]): number[] | undefined {
  const joined = chars.join("");
  const at = joined.indexOf(text);
  if (at < 0 || starts.length !== chars.length) return undefined;
  const out: number[] = [];
  for (const m of text.matchAll(/\S+/g)) out.push(Math.max(0, starts[at + (m.index ?? 0)] ?? 0));
  return out;
}

export async function synthesize(speaker: string, raw: string, apiKey: string | undefined, o: VoiceOptions = {}): Promise<VoiceResult> {
  const v = SPEAKERS[speaker];
  const text = voiceText(raw);
  const mood: Mood = (MOODS as readonly string[]).includes(o.mood ?? "") ? (o.mood as Mood) : "neutral";
  if (!v) return { status: 400, body: { status: "error", message: "unknown speaker" } };
  if (!text) return { status: 400, body: { status: "error", message: "empty line" } };
  if (text.length > MAX_TEXT) return { status: 413, body: { status: "error", message: "line too long" } };
  const key = `${speaker}|${mood}|${o.mock ? "mock" : "live"}|${text}`;
  const hit = cache.get(key);
  if (hit) return { status: 200, body: hit };
  const running = inflight.get(key);
  if (running) return running; // the same line asked twice at once: one call
  if (o.mock) return remember(key, { status: "ok", mime: "audio/wav", ...mockVoice(speaker, text), mock: true });
  if (!apiKey) return { status: 503, body: { status: "unconfigured", message: "voice not configured" } };
  const now = (o.now ?? Date.now)();
  if ((failed.get(key) ?? 0) > now) return { status: 502, body: { status: "error", message: "voice failed for this line, try later" } };
  if (inflight.size >= MAX_INFLIGHT) return { status: 503, body: { status: "busy", message: "voice busy" } };
  const today = new Date(now).toISOString().slice(0, 10);
  if (today !== day) { day = today; spent = 0; }
  if (spent + text.length > DAILY_CHARS) return { status: 429, body: { status: "budget", message: "voice budget used for today" } };
  spent += text.length;
  const p = (async (): Promise<VoiceResult> => {
    if (o.charge && !(await o.charge(text.length).catch(() => false))) { spent -= text.length; return { status: 429, body: { status: "budget", message: "voice budget used for today" } }; }
    const fail = (message: string, refund: boolean): VoiceResult => {
      if (refund) spent -= text.length; // the provider refused outright: nothing was generated
      failed.set(key, now + RETRY_AFTER_MS);
      return { status: 502, body: { status: "error", message } };
    };
    const r = await (o.fetchImpl ?? fetch)(`https://api.elevenlabs.io/v1/text-to-speech/${v.voiceId}/with-timestamps?output_format=mp3_44100_64`, {
      method: "POST",
      headers: { "xi-api-key": apiKey, "content-type": "application/json" },
      body: JSON.stringify({ text: `${moodTag(speaker, mood)} ${text}`, model_id: MODEL }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }).catch(() => null);
    if (!r) return fail("voice service unreachable", false); // may have been generated (timeout): stays spent
    if (!r.ok) return fail(`voice service ${r.status}`, r.status >= 400 && r.status < 500);
    const j = (await r.json().catch(() => null)) as { audio_base64?: string; alignment?: { characters?: string[]; character_start_times_seconds?: number[] } } | null;
    if (!j?.audio_base64) return fail("voice service gave no audio", false);
    const a = j.alignment;
    const words = a?.characters && a.character_start_times_seconds ? wordStarts(text, a.characters, a.character_start_times_seconds) : undefined;
    return remember(key, { status: "ok", mime: "audio/mpeg", audio: j.audio_base64, words });
  })().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

function remember(key: string, body: VoiceBody): VoiceResult {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
  cache.set(key, body);
  return { status: 200, body };
}

/** Placeholder speech for mock mode: one soft voiced syllable per word at the speaker's pitch, pauses at punctuation,
 *  as a 16 kHz mono WAV, with the exact start of every word. Not a voice: it only exercises timing and playback. */
function mockVoice(speaker: string, text: string): { audio: string; words: number[] } {
  const RATE = 16000, WORD = 0.26, GAP = 0.06;
  const pitch = 140 + (([...speaker].reduce((n, c) => n + c.charCodeAt(0), 0) * 37) % 140);
  const words = text.split(/\s+/);
  const starts: number[] = [];
  let t = 0.05;
  for (const w of words) { starts.push(t); t += WORD + GAP + (/[.!?]$/.test(w) ? 0.3 : /[,;:]$/.test(w) ? 0.15 : 0); }
  const n = Math.ceil((t + 0.1) * RATE), pcm = new Int16Array(n);
  starts.forEach((s, i) => {
    const f = pitch * (1 + 0.08 * Math.sin(i * 1.7));
    for (let k = 0; k < WORD * RATE; k++) {
      const x = k / RATE, env = Math.sin((Math.PI * x) / WORD) ** 2;
      const y = env * (0.6 * Math.sin(2 * Math.PI * f * x) + 0.25 * Math.sin(4 * Math.PI * f * x) + 0.1 * Math.sin(6 * Math.PI * f * x));
      pcm[Math.floor(s * RATE) + k] = Math.round(y * 6000);
    }
  });
  const head = Buffer.alloc(44);
  head.write("RIFF", 0); head.writeUInt32LE(36 + pcm.byteLength, 4); head.write("WAVEfmt ", 8);
  head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22); head.writeUInt32LE(RATE, 24);
  head.writeUInt32LE(RATE * 2, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34); head.write("data", 36); head.writeUInt32LE(pcm.byteLength, 40);
  return { audio: Buffer.concat([head, Buffer.from(pcm.buffer)]).toString("base64"), words: starts.map((s) => Math.round(s * 1000) / 1000) };
}
