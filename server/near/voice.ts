// Spoken lines that cannot be recorded ahead of time (haggle numbers, conversation answers, Rent Night figures):
// ElevenLabs text-to-speech with each character's fixed voice, through the `with-timestamps` endpoint (verified in
// @elevenlabs/elevenlabs-js 2.77: POST /v1/text-to-speech/{voice_id}/with-timestamps returns audio_base64 plus a
// per-character alignment), so subtitles follow the real speech. Recorded files cover every frequent line; this route
// only voices what is left. The key stays on the server. Answers are cached by (speaker, mood, text); identical
// requests in flight share one paid call; a request timeout and a daily character budget bound the cost. Over budget
// or unavailable, the game shows subtitles without speech.
// Mock mode (VIVOLITH_VOICE_MOCK=1, never on a production deployment): a locally synthesised placeholder voice with
// exact word timings, so the whole pipeline can be played without credits. Responses say `mock: true`.
import { SPEAKERS, MOODS, moodTag, type Mood } from "../../src/v2/audio-manifest.ts";

const MODEL = "eleven_v4"; // the model every recorded line was made with: dynamic speech must sound the same
export const MAX_TEXT = 240;
const TIMEOUT_MS = 9000;
/** ponytail: per server instance and day; the handler adds a shared daily request cap (Redis) on top. */
const DAILY_CHARS = 6000;
const CACHE_MAX = 300;

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
}

const cache = new Map<string, VoiceBody>();
const inflight = new Map<string, Promise<VoiceResult>>();
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
  const text = raw.replace(/\s+/g, " ").trim().slice(0, MAX_TEXT);
  const mood: Mood = (MOODS as readonly string[]).includes(o.mood ?? "") ? (o.mood as Mood) : "neutral";
  if (!v) return { status: 400, body: { status: "error", message: "unknown speaker" } };
  if (!text) return { status: 400, body: { status: "error", message: "empty line" } };
  const key = `${speaker}|${mood}|${o.mock ? "mock" : "live"}|${text}`;
  const hit = cache.get(key);
  if (hit) return { status: 200, body: hit };
  const running = inflight.get(key);
  if (running) return running; // the same line asked twice at once: one call
  if (o.mock) return remember(key, { status: "ok", mime: "audio/wav", ...mockVoice(speaker, text), mock: true });
  if (!apiKey) return { status: 503, body: { status: "unconfigured", message: "voice not configured" } };
  const today = new Date((o.now ?? Date.now)()).toISOString().slice(0, 10);
  if (today !== day) { day = today; spent = 0; }
  if (spent + text.length > DAILY_CHARS) return { status: 429, body: { status: "budget", message: "voice budget used for today" } };
  spent += text.length;
  const p = (async (): Promise<VoiceResult> => {
    const r = await (o.fetchImpl ?? fetch)(`https://api.elevenlabs.io/v1/text-to-speech/${v.voiceId}/with-timestamps?output_format=mp3_44100_64`, {
      method: "POST",
      headers: { "xi-api-key": apiKey, "content-type": "application/json" },
      body: JSON.stringify({ text: `${moodTag(speaker, mood)} ${text}`, model_id: MODEL }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }).catch(() => null);
    if (!r || !r.ok) { spent -= text.length; return { status: 502, body: { status: "error", message: `voice service ${r?.status ?? "unreachable"}` } }; }
    const j = (await r.json().catch(() => null)) as { audio_base64?: string; alignment?: { characters?: string[]; character_start_times_seconds?: number[] } } | null;
    if (!j?.audio_base64) { spent -= text.length; return { status: 502, body: { status: "error", message: "voice service gave no audio" } }; }
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
