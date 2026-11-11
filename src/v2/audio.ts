// Audio: three buses (music, voice, effects; ambience rides the effects bus) under one master with mute.
// The context starts on the first click or key (browser autoplay rules). Files are fetched lazily and cached; a
// missing or broken file is silent, so the game never depends on audio. UI clicks, coins and footsteps are
// synthesised (tiny, no files). One voice at a time; music and ambience duck while someone speaks.
import type { MerchantId } from "../economy/state";
import { VOICES, loopUrl, recordedUrl, sfxUrl, type AmbienceId, type LineId, type MusicId, type SfxFile } from "./audio-manifest";

export interface Levels { music: number; voice: number; sfx: number; muted: boolean }
type Synth = "click" | "coin" | "pay" | "error" | "step";

const STORE = "vivolith.audio";
const STEPS: readonly SfxFile[] = ["step_1", "step_2", "step_3"];
/** Loudness match for the generated files (measured peaks: ambience beds ~0.05, quiet effects 0.04-0.16). */
const AMB_GAIN = 3.5;
const SFX_GAIN: Partial<Record<SfxFile, number>> = { car_pass: 4, rent_bell: 2.5, harbor_horn: 2.5, ui_close: 2, closed: 1.8, reopen: 1.8 };
const FADE_SEC = 2.5, DUCK = 0.35, MAX_SFX = 6;
/** Each merchant's pitch for the fallback "voice blips" when no recorded line exists. */
const BLIP: Record<MerchantId, number> = { pema: 330, tomas: 180, mira: 420, arin: 240 };

const load = (): Levels => {
  try { return { music: 0.5, voice: 0.9, sfx: 0.7, muted: false, ...(JSON.parse(localStorage.getItem(STORE) ?? "{}") as Partial<Levels>) }; }
  catch { return { music: 0.5, voice: 0.9, sfx: 0.7, muted: false }; }
};

let ctx: AudioContext | null = null;
let master: GainNode, music: GainNode, amb: GainNode, voiceBus: GainNode, sfxBus: GainNode, duck: GainNode;
const levels = load();
const buffers = new Map<string, Promise<AudioBuffer | null>>();
let live = 0;
let speaking: AudioBufferSourceNode | null = null;
const loops: Record<"music" | "ambience", { id: string; src: AudioBufferSourceNode; gain: GainNode } | null> = { music: null, ambience: null };
const want: Record<"music" | "ambience", string | null> = { music: null, ambience: null };

function start(): void {
  if (ctx) { void ctx.resume(); return; }
  try { ctx = new AudioContext(); } catch { return; } // no Web Audio: the game runs silent
  master = ctx.createGain(); duck = ctx.createGain();
  music = ctx.createGain(); amb = ctx.createGain(); voiceBus = ctx.createGain(); sfxBus = ctx.createGain();
  // music and ambience duck under voices; ambience follows the effects volume
  music.connect(duck); amb.connect(duck); duck.connect(master);
  sfxBus.connect(master); voiceBus.connect(master); master.connect(ctx.destination);
  apply();
  for (const k of ["music", "ambience"] as const) if (want[k]) void setLoop(k, want[k]!);
}
for (const ev of ["pointerdown", "keydown"]) window.addEventListener(ev, start, { capture: true });
// every button and menu item answers with the same soft click (one place, one style)
window.addEventListener("click", (e) => { if ((e.target as HTMLElement | null)?.closest("button, #menu li")) synth("click"); }, { capture: true });

function apply(): void {
  if (!ctx) return;
  master.gain.value = levels.muted ? 0 : 1;
  music.gain.value = levels.music; voiceBus.gain.value = levels.voice; sfxBus.gain.value = levels.sfx; amb.gain.value = levels.sfx * AMB_GAIN;
}

function fetchBuffer(url: string): Promise<AudioBuffer | null> {
  let p = buffers.get(url);
  if (!p) {
    p = fetch(url).then((r) => (r.ok ? r.arrayBuffer() : null)).then((b) => (b && ctx ? ctx.decodeAudioData(b) : null)).catch(() => null);
    buffers.set(url, p);
  }
  return p;
}

async function setLoop(kind: "music" | "ambience", id: string): Promise<void> {
  want[kind] = id;
  if (!ctx || loops[kind]?.id === id) return;
  const buf = await fetchBuffer(loopUrl(kind, id));
  if (!ctx || want[kind] !== id) return; // changed while loading
  const now = ctx.currentTime, old = loops[kind];
  if (old) { old.gain.gain.setTargetAtTime(0, now, FADE_SEC / 3); old.src.stop(now + FADE_SEC * 2); }
  loops[kind] = null;
  if (!buf) return; // not generated yet: silence, never an error
  const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;
  const gain = ctx.createGain(); gain.gain.value = 0; gain.gain.setTargetAtTime(1, now, FADE_SEC / 3); // crossfade in
  src.connect(gain).connect(kind === "music" ? music : amb);
  src.start();
  loops[kind] = { id, src, gain };
}

function blip(freq: number, at: number, len: number, type: OscillatorType, vol: number, out: GainNode): void {
  const o = ctx!.createOscillator(), g = ctx!.createGain();
  o.type = type; o.frequency.setValueAtTime(freq, at);
  g.gain.setValueAtTime(0, at); g.gain.linearRampToValueAtTime(vol, at + 0.008); g.gain.exponentialRampToValueAtTime(0.0001, at + len);
  o.connect(g).connect(out); o.start(at); o.stop(at + len + 0.02);
}

function synth(id: Synth): void {
  if (!ctx || live >= MAX_SFX) return;
  live++; window.setTimeout(() => live--, 400);
  const t = ctx.currentTime;
  if (id === "click") blip(880, t, 0.05, "triangle", 0.15, sfxBus);
  else if (id === "coin") { blip(1318, t, 0.12, "triangle", 0.2, sfxBus); blip(1760, t + 0.07, 0.18, "triangle", 0.18, sfxBus); }
  else if (id === "pay") { blip(988, t, 0.1, "triangle", 0.16, sfxBus); blip(784, t + 0.06, 0.14, "triangle", 0.14, sfxBus); }
  else if (id === "error") { blip(220, t, 0.14, "square", 0.08, sfxBus); blip(185, t + 0.1, 0.18, "square", 0.07, sfxBus); }
  else if (id === "step") { // a soft scuff: short filtered noise
    const n = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.06), ctx.sampleRate), d = n.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length) ** 2;
    const s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    f.type = "lowpass"; f.frequency.value = 900 + Math.random() * 300; g.gain.value = 0.18;
    s.buffer = n; s.connect(f).connect(g).connect(sfxBus); s.start(t);
  }
}

/** Server-voiced line (server/near/voice.ts): cached per speaker and text; null when the voice is unavailable. */
const tts = new Map<string, Promise<AudioBuffer | null>>();
function ttsBuffer(speaker: string, text: string): Promise<AudioBuffer | null> {
  const k = `${speaker}|${text}`;
  let p = tts.get(k);
  if (!p) {
    p = fetch("/api/near/voice", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ speaker, text }) })
      .then((r) => (r.ok ? (r.json() as Promise<{ audio?: string }>) : null))
      .then((j) => (j?.audio && ctx ? ctx.decodeAudioData(Uint8Array.from(atob(j.audio), (c) => c.charCodeAt(0)).buffer) : null))
      .catch(() => null);
    tts.set(k, p);
  }
  return p;
}

/** The longest recorded line of this merchant that the text starts with (an opener such as "Ha! Not a chance."). */
function opener(speaker: string, text: string): string | null {
  const v = VOICES[speaker as MerchantId];
  if (!v) return null;
  return Object.values(v.lines).filter((l) => text.startsWith(`${l} `)).sort((a, b) => b.length - a.length)[0] ?? null;
}

export interface LineOptions {
  /** World position: the line pans and fades with distance from the camera. */
  at?: { x: number; y: number; z: number };
  /** Background chatter (gossip, residents): never interrupts dialogue, rate-limited across the street. */
  ambient?: boolean;
  /** Wait for the current line to finish instead of cutting it (several merchants in turn). */
  queue?: boolean;
  /** Speak only the recorded opener; the rest of the subtitle is interface detail (figures), not speech. */
  openerOnly?: boolean;
}
let lineSeq = 0, chain: Promise<unknown> = Promise.resolve(), ambientUntil = 0;
const AMBIENT_GAP_SEC = 6;

function playBuffer(buf: AudioBuffer, at?: LineOptions["at"]): Promise<void> {
  const s = ctx!.createBufferSource();
  s.buffer = buf;
  if (at) {
    const p = ctx!.createPanner();
    p.panningModel = "equalpower"; p.distanceModel = "inverse"; p.refDistance = 2.5; p.rolloffFactor = 1.1; p.maxDistance = 40;
    p.positionX.value = at.x; p.positionY.value = at.y; p.positionZ.value = at.z;
    s.connect(p).connect(voiceBus);
  } else s.connect(voiceBus);
  return new Promise((done) => { s.onended = () => done(); s.start(); speaking = s; });
}

/** Speak one character's line: the recorded file when it exists, else a recorded opener plus the server voice for the
 *  rest, else (voice unavailable) a few pitched blips. Resolves when the speech ends, with its length in seconds. */
async function speakLine(speaker: string, text: string, o: LineOptions): Promise<number> {
  if (!ctx || !text) return 0;
  const my = ++lineSeq;
  if (speaking) { try { speaking.stop(); } catch { /* already ended */ } speaking = null; }
  const whole = recordedUrl(speaker, text);
  const op = whole ? null : opener(speaker, text);
  const parts: Promise<AudioBuffer | null>[] = [];
  if (whole) parts.push(fetchBuffer(whole));
  else if (op) {
    parts.push(fetchBuffer(recordedUrl(speaker, op)!));
    if (!o.openerOnly) parts.push(ttsBuffer(speaker, text.slice(op.length).trim()));
  } else if (!o.openerOnly) parts.push(ttsBuffer(speaker, text));
  let total = 0;
  for (const p of parts) { // all fetched at once; played in order, the server line usually ready by the time the opener ends
    const buf = await p;
    if (my !== lineSeq || !ctx) return total; // a newer line took over
    if (!buf) continue;
    duckFor(buf.duration);
    await playBuffer(buf, o.at);
    total += buf.duration;
  }
  if (!total && parts.length && my === lineSeq) { // voice unavailable: short blips, so the subtitle never appears in silence
    const syl = Math.min(6, Math.max(2, Math.round(text.split(/\s+/).length / 2)));
    const f = BLIP[speaker as MerchantId] ?? 260;
    for (let i = 0; i < syl; i++) blip(f * (0.9 + Math.random() * 0.25), ctx.currentTime + i * 0.09, 0.07, "square", 0.05, voiceBus);
  }
  if (my === lineSeq) speaking = null;
  return total;
}

function duckFor(sec: number): void {
  if (!ctx) return;
  const t = ctx.currentTime;
  duck.gain.cancelScheduledValues(t);
  duck.gain.setTargetAtTime(DUCK, t, 0.08);
  duck.gain.setTargetAtTime(1, t + sec, 0.4);
}

export const audio = {
  levels: (): Levels => ({ ...levels }),
  set(next: Partial<Levels>): void {
    Object.assign(levels, next);
    try { localStorage.setItem(STORE, JSON.stringify(levels)); } catch { /* storage blocked: this session only */ }
    apply();
  },
  /** Synthesised effects (always available once audio has started). */
  synth,
  /** A generated effect file; silent until it exists. */
  async sfx(id: SfxFile): Promise<void> {
    if (!ctx || live >= MAX_SFX) return;
    const buf = await fetchBuffer(sfxUrl(id));
    if (!buf || !ctx) return;
    live++;
    const s = ctx.createBufferSource(), g = ctx.createGain();
    s.buffer = buf; g.gain.value = SFX_GAIN[id] ?? 1;
    s.connect(g).connect(sfxBus); s.onended = () => live--; s.start();
  },
  /** A footstep: one of the generated steps at random, else the synthesised scuff. */
  async step(): Promise<void> {
    if (!ctx || live >= MAX_SFX) return;
    const buf = await fetchBuffer(sfxUrl(STEPS[Math.floor(Math.random() * STEPS.length)]));
    if (!ctx) return;
    if (!buf) { synth("step"); return; }
    live++;
    const s = ctx.createBufferSource(), g = ctx.createGain();
    s.buffer = buf; s.playbackRate.value = 0.94 + Math.random() * 0.12; g.gain.value = 0.55; // variety, sits under everything
    s.connect(g).connect(sfxBus); s.onended = () => live--; s.start();
  },
  /** One merchant line by id (kept for callers that know the line). */
  async say(id: MerchantId, _line: LineId, text: string): Promise<void> { await audio.line(id, text); },
  /** Any character's line (speaker: a merchant id, folk0..3, engineer, harbor). The text is exactly what the subtitle
   *  shows. Dialogue cuts the previous line (or queues after it); ambient chatter waits its turn and never interrupts. */
  line(speaker: string, text: string, o: LineOptions = {}): Promise<number> {
    if (!ctx) return Promise.resolve(0);
    if (o.ambient) {
      if (speaking || ctx.currentTime < ambientUntil) return Promise.resolve(0);
      ambientUntil = ctx.currentTime + AMBIENT_GAP_SEC;
      const url = recordedUrl(speaker, text);
      return (url ? fetchBuffer(url) : ttsBuffer(speaker, text)).then(async (b) => {
        if (!b || !ctx || speaking) return 0;
        ambientUntil = ctx.currentTime + b.duration + AMBIENT_GAP_SEC;
        const s = ctx.createBufferSource(), p = ctx.createPanner();
        p.panningModel = "equalpower"; p.distanceModel = "inverse"; p.refDistance = 2; p.rolloffFactor = 1.4; p.maxDistance = 25;
        if (o.at) { p.positionX.value = o.at.x; p.positionY.value = o.at.y; p.positionZ.value = o.at.z; }
        s.buffer = b; s.connect(p).connect(voiceBus); s.start();
        return b.duration;
      });
    }
    if (o.queue) { const run = chain.then(() => speakLine(speaker, text, o)); chain = run.catch(() => 0); return run; }
    const run = speakLine(speaker, text, o); chain = run.catch(() => 0); return run;
  },
  /** Where the ears are (the camera): set every frame so reactions pan and fade with distance. */
  listen(x: number, y: number, z: number, fx: number, fz: number): void {
    if (!ctx) return;
    const l = ctx.listener;
    if (l.positionX) {
      l.positionX.value = x; l.positionY.value = y; l.positionZ.value = z;
      l.forwardX.value = fx; l.forwardY.value = 0; l.forwardZ.value = fz; l.upX.value = 0; l.upY.value = 1; l.upZ.value = 0;
    } else { l.setPosition(x, y, z); l.setOrientation(fx, 0, fz, 0, 1, 0); } // older Safari
  },
  /** A short voiced reaction at a world position (a bump): panned, quieter with distance, on the voice bus.
   *  Never cuts a merchant's line; silent until the file exists. */
  async at(url: string, x: number, y: number, z: number): Promise<void> {
    if (!ctx || live >= MAX_SFX) return;
    const buf = await fetchBuffer(url);
    if (!buf || !ctx) return;
    live++;
    const s = ctx.createBufferSource(), p = ctx.createPanner();
    p.panningModel = "equalpower"; p.distanceModel = "inverse"; p.refDistance = 2; p.rolloffFactor = 1.2; p.maxDistance = 40;
    p.positionX.value = x; p.positionY.value = y; p.positionZ.value = z;
    s.buffer = buf; s.connect(p).connect(voiceBus); s.onended = () => live--; s.start();
  },
  music: (id: MusicId): void => { void setLoop("music", id); },
  ambience: (id: AmbienceId): void => { void setLoop("ambience", id); },
};
