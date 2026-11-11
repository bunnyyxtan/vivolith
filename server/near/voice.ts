// Spoken lines that cannot be recorded ahead of time (haggle numbers, NEAR AI answers, residents' trades):
// ElevenLabs text-to-speech with each character's fixed voice. Recorded files cover every frequent line; this route
// only voices what is left. The key stays on the server. Every answer is cached by (speaker, text), and a daily
// character budget stops the route from spending more than intended: over budget the game falls back to subtitles.
import { SPEAKERS } from "../../src/v2/audio-manifest.ts";

const MODEL = "eleven_v4";
const MAX_TEXT = 240;
/** ponytail: per server instance and day; move to Redis (shared counter) if many instances run at once. */
const DAILY_CHARS = 6000;
const cache = new Map<string, string>(); // speaker|text -> base64 mp3
const CACHE_MAX = 300;
let day = "", spent = 0;

export interface VoiceResult { status: number; body: { status: string; message?: string; audio?: string; mime?: string } }

export async function synthesize(speaker: string, raw: string, apiKey: string | undefined): Promise<VoiceResult> {
  const v = SPEAKERS[speaker];
  const text = raw.replace(/\s+/g, " ").trim().slice(0, MAX_TEXT);
  if (!v) return { status: 400, body: { status: "error", message: "unknown speaker" } };
  if (!text) return { status: 400, body: { status: "error", message: "empty line" } };
  const key = `${speaker}|${text}`;
  const hit = cache.get(key);
  if (hit) return { status: 200, body: { status: "ok", mime: "audio/mpeg", audio: hit } };
  if (!apiKey) return { status: 503, body: { status: "unconfigured", message: "voice not configured" } };
  const today = new Date().toISOString().slice(0, 10);
  if (today !== day) { day = today; spent = 0; }
  if (spent + text.length > DAILY_CHARS) return { status: 429, body: { status: "budget", message: "voice budget used for today" } };
  spent += text.length;
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${v.voiceId}?output_format=mp3_44100_64`, {
    method: "POST",
    headers: { "xi-api-key": apiKey, "content-type": "application/json", accept: "audio/mpeg" },
    body: JSON.stringify({ text: `${v.tag} ${text}`, model_id: MODEL }),
  }).catch(() => null);
  if (!r || !r.ok) { spent -= text.length; return { status: 502, body: { status: "error", message: `voice service ${r?.status ?? "unreachable"}` } }; }
  const audio = Buffer.from(await r.arrayBuffer()).toString("base64");
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
  cache.set(key, audio);
  return { status: 200, body: { status: "ok", mime: "audio/mpeg", audio } };
}
