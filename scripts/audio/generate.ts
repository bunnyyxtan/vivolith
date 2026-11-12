// Generates VIVOLITH's audio once with ElevenLabs, from src/v2/audio-manifest.ts, into public/audio/.
//   node --env-file=.env.local scripts/audio/generate.ts            plan: every file, what exists, estimated cost (no API call)
//   node --env-file=.env.local scripts/audio/generate.ts --account  plan tier and credits left (free read)
//   node --env-file=.env.local scripts/audio/generate.ts --voices   pre-made voices to choose from (free read)
//   node --env-file=.env.local scripts/audio/generate.ts --run [voice|sfx|ambience|music]   generate MISSING files (spends credits)
//   ... --run --one audio/voice/pema/hello.mp3   just that one file
// The key comes only from ELEVENLABS_API_KEY in the environment; it is never printed or written anywhere.
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import { AMBIENCE, CAST_BUMP, SPEAKERS, FOLK_VOICES, MUSIC, MUSIC_STYLE, SFX, SFX_STYLE, VOICES, type LineId } from "../../src/v2/audio-manifest.ts";

const OUT = path.resolve("public");
const TTS_MODEL = "eleven_v4", SFX_MODEL = "eleven_text_to_sound_v3", MUSIC_MODEL = "music_v2_5";
// Published API prices (elevenlabs.io/pricing/api, read 2026-11-11): estimates only, the account is billed in credits.
const USD = { ttsPer1kChars: 0.08, sfxPerMin: 0.12, musicPerMin: 0.15 };

interface Job { kind: "voice" | "sfx" | "ambience" | "music"; file: string; detail: string; chars?: number; seconds?: number; make: (c: ElevenLabsClient) => Promise<unknown> }

const jobs: Job[] = [];
for (const [id, v] of Object.entries(VOICES)) {
  for (const [line, text] of Object.entries(v.lines) as [LineId, string][]) {
    jobs.push({
      kind: "voice", file: `audio/voice/${id}/${line}.mp3`, detail: `${id}: "${text}"`, chars: text.length,
      make: (c) => c.textToSpeech.convert(v.voiceId, { text: `${v.tag} ${text}`, modelId: TTS_MODEL, outputFormat: "mp3_44100_128" }),
    });
  }
}
FOLK_VOICES.forEach((v, n) => v.bump.forEach((text, k) => jobs.push({
  kind: "voice", file: `audio/voice/folk${n}/bump_${k}.mp3`, detail: `folk${n}: "${text}"`, chars: text.length,
  make: (c) => c.textToSpeech.convert(v.voiceId, { text: `${v.tag} ${text}`, modelId: TTS_MODEL, outputFormat: "mp3_44100_128" }),
})));
for (const [id, lines] of Object.entries(CAST_BUMP)) lines.forEach((text, k) => jobs.push({
  kind: "voice", file: `audio/voice/${id}/bump_${k}.mp3`, detail: `${id}: "${text}"`, chars: text.length,
  make: (c) => c.textToSpeech.convert(SPEAKERS[id].voiceId, { text: `${SPEAKERS[id].tag} ${text}`, modelId: TTS_MODEL, outputFormat: "mp3_44100_128" }),
}));
for (const [id, s] of Object.entries(SFX)) {
  jobs.push({ kind: "sfx", file: `audio/sfx/${id}.mp3`, detail: s.prompt, seconds: s.seconds, make: (c) => c.textToSoundEffects.convert({ text: `${s.prompt}. ${SFX_STYLE}`, modelId: SFX_MODEL, durationSeconds: s.seconds, promptInfluence: 0.6 }) });
}
for (const [id, s] of Object.entries(AMBIENCE)) {
  jobs.push({ kind: "ambience", file: `audio/ambience/${id}.mp3`, detail: s.prompt, seconds: s.seconds, make: (c) => c.textToSoundEffects.convert({ text: `${s.prompt}. ${SFX_STYLE}`, modelId: SFX_MODEL, durationSeconds: s.seconds, promptInfluence: 0.5, loop: true }) });
}
for (const [id, m] of Object.entries(MUSIC)) {
  jobs.push({ kind: "music", file: `audio/music/${id}.mp3`, detail: m.prompt, seconds: m.seconds, make: (c) => c.music.compose({ prompt: `${m.prompt}. ${MUSIC_STYLE}`, musicLengthMs: m.seconds * 1000, modelId: MUSIC_MODEL, forceInstrumental: true }) });
}

const exists = (j: Job): boolean => fs.existsSync(path.join(OUT, j.file));
const cost = (js: Job[]): number => js.reduce((n, j) => n + (j.chars ? (j.chars / 1000) * USD.ttsPer1kChars : 0) + (j.seconds ? (j.seconds / 60) * (j.kind === "music" ? USD.musicPerMin : USD.sfxPerMin) : 0), 0);

const args = process.argv.slice(2);
const key = process.env.ELEVENLABS_API_KEY;
const client = (): ElevenLabsClient => {
  if (!key) throw new Error("ELEVENLABS_API_KEY is not set (run with node --env-file=.env.local)");
  return new ElevenLabsClient({ apiKey: key });
};

if (args.includes("--account")) {
  const s = await client().user.subscription.get();
  console.log(JSON.stringify({ tier: s.tier, status: s.status, characterCount: s.characterCount, characterLimit: s.characterLimit, nextReset: s.nextCharacterCountResetUnix }, null, 1));
} else if (args.includes("--voices")) {
  const v = await client().voices.getAll();
  for (const x of v.voices.filter((y) => y.category === "premade")) {
    console.log(`${x.voiceId}  ${x.name}  ${JSON.stringify(x.labels ?? {})}`);
  }
} else if (args.includes("--run")) {
  const only = args.find((a) => ["voice", "sfx", "ambience", "music"].includes(a));
  const oneAt = args.indexOf("--one"), one = oneAt >= 0 ? args[oneAt + 1] : null; // a single file, e.g. a sample
  const todo = jobs.filter((j) => !exists(j) && (!only || j.kind === only) && (!one || j.file === one));
  const unvoiced = todo.filter((j) => j.kind === "voice" && j.file.split("/")[2] in VOICES && !VOICES[j.file.split("/")[2] as keyof typeof VOICES].voiceId);
  if (unvoiced.length) throw new Error(`choose voices first (--voices, then set voiceId in src/v2/audio-manifest.ts): ${[...new Set(unvoiced.map((j) => j.file.split("/")[2]))].join(", ")}`);
  console.log(`generating ${todo.length} files, about $${cost(todo).toFixed(2)}`);
  const c = client();
  for (const j of todo) {
    const out = path.join(OUT, j.file);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    try {
      const audio = (await j.make(c)) as ReadableStream<Uint8Array> | NodeJS.ReadableStream;
      const src = "getReader" in audio ? Readable.fromWeb(audio as import("node:stream/web").ReadableStream) : (audio as NodeJS.ReadableStream);
      await pipeline(src, fs.createWriteStream(out));
      console.log(`  ok   ${j.file}`);
    } catch (e) {
      fs.rmSync(out, { force: true });
      console.log(`  FAIL ${j.file}: ${e instanceof Error ? e.message.slice(0, 160) : "error"}`);
    }
  }
} else {
  for (const kind of ["voice", "sfx", "ambience", "music"] as const) {
    const js = jobs.filter((j) => j.kind === kind);
    const missing = js.filter((j) => !exists(j));
    console.log(`\n${kind}: ${js.length} files, ${missing.length} missing, about $${cost(missing).toFixed(2)}`);
    for (const j of js) console.log(`  ${exists(j) ? "have" : "need"}  ${j.file}  ${j.chars ? `${j.chars} chars` : `${j.seconds} s`}  ${j.detail}`);
  }
  const all = jobs.filter((j) => !exists(j));
  console.log(`\nTOTAL ${all.length} files to generate, about $${cost(all).toFixed(2)} at published API prices. Nothing was sent.`);
}
