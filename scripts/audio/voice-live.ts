// Live voice probe (spends ElevenLabs credits: one generation per line). Calls the local voice route exactly as the
// game does, then saves the audio and the route's word timings to docs/evidence/phase3-voice/ for listening.
//   node scripts/audio/voice-live.ts [--base http://localhost:5177] [--only pema,tomas]
// Needs a dev server with a real ELEVENLABS_API_KEY and VIVOLITH_VOICE_MOCK unset (launch config near-world-voice-live).
// The key never leaves that server; this script only sees the route's answers.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { spokenText } from "../../src/v2/audio-manifest.ts";
import { gameLine } from "../../server/near/voice.ts";

/** One representative line per economic character, in its usual delivery (mood from game events, never invented). */
export const PROBES: { speaker: string; who: string; mood: string; text: string }[] = [
  { speaker: "pema", who: "Pema", mood: "worried", text: "Rent is due tonight and my till holds only 18 c. Every mango you buy helps." },
  { speaker: "tomas", who: "Tomas", mood: "neutral", text: "My cart is full again. 12 mangoes at 4 c each, and I want them sold before the harbor opens." },
  { speaker: "mira", who: "Mira", mood: "neutral", text: "Tomas sells fast. I sell fair. Think about which one of us you want to come back to." },
  { speaker: "arin", who: "Arin", mood: "neutral", text: "I buy my mangoes from whoever is cheapest at seven. That's how the Tea House stays open." },
  { speaker: "picker", who: "Lin", mood: "neutral", text: "Six mangoes a day from the orchard, picked by hand. It's slow work, but the trees always pay me back." },
  { speaker: "porter", who: "Dev", mood: "neutral", text: "Every crate off the harbor goes past me first. Pay the porter, and your mangoes move." },
];

const args = process.argv.slice(2);
const base = args.includes("--base") ? args[args.indexOf("--base") + 1] : "http://localhost:5177";
const only = args.includes("--only") ? args[args.indexOf("--only") + 1].split(",") : null;
const OUT = "docs/evidence/phase3-voice";

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const list = PROBES.filter((p) => !only || only.includes(p.speaker));
  const bad = list.filter((p) => !gameLine(spokenText(p.text)));
  if (bad.length) { console.error("not game words (the route would refuse):", bad.map((p) => p.text)); process.exit(1); }
  fs.mkdirSync(OUT, { recursive: true });
  for (const p of list) {
    const spoken = spokenText(p.text);
    const t0 = performance.now();
    const r = await fetch(`${base}/api/near/voice`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ speaker: p.speaker, text: spoken, mood: p.mood }) });
    const j = (await r.json()) as { audio?: string; mime?: string; words?: number[]; mock?: boolean; message?: string };
    const ms = Math.round(performance.now() - t0);
    if (!r.ok || !j.audio) { console.log(`${p.who}: ${r.status} ${j.message ?? ""} (${ms} ms)`); continue; }
    if (j.mock) { console.error("the server answered with the mock voice: stop, this is not a live test"); process.exit(1); }
    const file = path.join(OUT, `${p.speaker}.mp3`);
    fs.writeFileSync(file, Buffer.from(j.audio, "base64"));
    const dur = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]).toString().trim());
    const words = spoken.split(/\s+/).length;
    const row = { who: p.who, speaker: p.speaker, mood: p.mood, text: spoken, ms, bytes: Buffer.from(j.audio, "base64").length, seconds: dur, words, timed: j.words?.length ?? 0, firstWord: j.words?.[0], lastWord: j.words?.at(-1), starts: j.words };
    fs.writeFileSync(path.join(OUT, `${p.speaker}.json`), JSON.stringify(row, null, 1) + "\n");
    console.log(`${p.who}: ${ms} ms, ${dur.toFixed(2)} s audio, ${row.timed}/${words} words timed, first ${row.firstWord}s, last ${row.lastWord}s`);
  }
}
