// Audio: three buses (music, voice, effects; ambience rides the effects bus) under one master with mute.
// The context starts on the first click or key (browser autoplay rules). Files are fetched lazily and cached; a
// missing or broken file is silent, so the game never depends on audio. UI clicks, coins and footsteps are
// synthesised (tiny, no files). One voice at a time; music and ambience duck while someone speaks.
import type { MerchantId } from "../economy/state";
import { loopUrl, sfxUrl, voiceUrl, type AmbienceId, type LineId, type MusicId, type SfxFile } from "./audio-manifest";

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
  /** One merchant line; cuts off whoever was speaking. Without a recorded clip, a short pitched blip stands in. */
  async say(id: MerchantId, line: LineId, text: string): Promise<void> {
    if (!ctx) return;
    if (speaking) { try { speaking.stop(); } catch { /* already ended */ } speaking = null; }
    const buf = await fetchBuffer(voiceUrl(id, line));
    if (!ctx) return;
    if (!buf) { // fallback: a few syllable blips, never a stack of them
      const syl = Math.min(6, Math.max(2, Math.round(text.split(/\s+/).length / 2)));
      for (let i = 0; i < syl; i++) blip(BLIP[id] * (0.9 + Math.random() * 0.25), ctx.currentTime + i * 0.09, 0.07, "square", 0.05, voiceBus);
      return;
    }
    const s = ctx.createBufferSource(); s.buffer = buf; s.connect(voiceBus); s.start();
    speaking = s; s.onended = () => { if (speaking === s) speaking = null; };
    duckFor(buf.duration);
  },
  music: (id: MusicId): void => { void setLoop("music", id); },
  ambience: (id: AmbienceId): void => { void setLoop("ambience", id); },
};
