// Audio: three buses (music, voice, effects; ambience rides the effects bus) under one master with mute.
// The context starts on the first click or key (browser autoplay rules). Files are fetched lazily and cached; a
// missing or broken file is silent, so the game never depends on audio. UI clicks, coins and footsteps are
// synthesised (tiny, no files). One voice at a time; music and ambience duck while someone speaks.
// Speech is hybrid: a recorded file when one exists for exactly the line (or its opening phrase), else the server
// voice (ElevenLabs with the same voices, server/near/voice.ts). A reply of several sentences plays as one: the next
// sentence is requested when the previous one starts, so the first is heard as soon as it is ready and an abandoned
// reply never generates more than one sentence ahead.
import type { MerchantId } from "../economy/state";
import { VOICES, loopUrl, recordedUrl, sfxUrl, spokenText, type AmbienceId, type LineId, type Mood, type MusicId, type SfxFile } from "./audio-manifest";

export interface Levels { music: number; voice: number; sfx: number; muted: boolean }
type Synth = "click" | "coin" | "pay" | "error" | "step";

const STORE = "vivolith.audio";
const STEPS: readonly SfxFile[] = ["step_1", "step_2", "step_3"];
/** Loudness match for the generated files (measured peaks: ambience beds ~0.05, quiet effects 0.04-0.16). */
const AMB_GAIN = 3.5;
const SFX_GAIN: Partial<Record<SfxFile, number>> = { car_pass: 4, rent_bell: 2.5, harbor_horn: 2.5, ui_close: 2, closed: 1.8, reopen: 1.8 };
const FADE_SEC = 2.5, DUCK = 0.35, MAX_SFX = 6;
/** A short breath between sentences of one reply, so joined clips sound like one person talking. */
const SENTENCE_GAP_SEC = 0.12;
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

/** A piece of speech: its audio and, when the voice service aligned it, when each of its words starts (s). */
interface Clip { buf: AudioBuffer; words?: number[] }
/** Server-voiced text (server/near/voice.ts), cached per speaker, mood and text; null when the voice is unavailable.
 *  The request carries the spoken form ("15 coins" for "15 c"), word for word the subtitle. An aborted request is
 *  dropped from the cache, so a replay asks again (the server's own cache answers without a second paid call). */
const tts = new Map<string, Promise<Clip | null>>();
function ttsClip(speaker: string, text: string, mood: Mood = "neutral", signal?: AbortSignal, token?: string): Promise<Clip | null> {
  const k = `${speaker}|${mood}|${text}`;
  let p = tts.get(k);
  if (!p) {
    p = fetch("/api/near/voice", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ speaker, text: spokenText(text), mood, token }), signal })
      .then((r) => (r.ok ? (r.json() as Promise<{ audio?: string; words?: unknown }>) : null))
      .then(async (j) => {
        if (!j?.audio || !ctx) return null;
        const buf = await ctx.decodeAudioData(Uint8Array.from(atob(j.audio), (c) => c.charCodeAt(0)).buffer);
        const words = Array.isArray(j.words) && j.words.every((w) => typeof w === "number") ? (j.words as number[]) : undefined;
        return { buf, words };
      })
      .catch(() => { tts.delete(k); return null; });
    tts.set(k, p);
  }
  return p;
}
const fileClip = (url: string): Promise<Clip | null> => fetchBuffer(url).then((buf) => (buf ? { buf } : null));

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
  /** Speech tokens from the server, one per part (a validated conversation answer): the voice route speaks those parts
   *  as they are. Parts without one must be sentences the game itself can say (server/near/lines.json). */
  tokens?: readonly (string | undefined)[];
  /** Delivery chosen by the game from real events (server voice only; recorded lines keep their take). */
  mood?: Mood;
  /** Subtitle pacing: how many words of the text have been spoken so far (provider timings when known, else spread
   *  evenly over the clip, which is pacing only). Called with the full count at the end or on failure. */
  onWords?: (spoken: number) => void;
  /** True when the voice starts, false when it stops (finished, cut or cancelled): mouth and gesture follow it. */
  onSpeaking?: (on: boolean) => void;
}
let lineSeq = 0, epoch = 0, chain: Promise<unknown> = Promise.resolve(), ambientUntil = 0;
let current: AbortController | null = null;
/** One listener for every dialogue voice starting and stopping (the game moves that character's mouth). */
let voiceHook: ((speaker: string, on: boolean) => void) | null = null;
const AMBIENT_GAP_SEC = 6;

/** Plays one clip; resolves when it ends or is cut. Reports spoken words (offset by the words before this clip). */
function playClip(c: Clip, words: number, before: number, my: number, o: LineOptions): Promise<void> {
  const s = ctx!.createBufferSource();
  s.buffer = c.buf;
  if (o.at) {
    const p = ctx!.createPanner();
    p.panningModel = "equalpower"; p.distanceModel = "inverse"; p.refDistance = 2.5; p.rolloffFactor = 1.1; p.maxDistance = 40;
    p.positionX.value = o.at.x; p.positionY.value = o.at.y; p.positionZ.value = o.at.z;
    s.connect(p).connect(voiceBus);
  } else s.connect(voiceBus);
  const marks = c.words && c.words.length === words ? c.words : Array.from({ length: words }, (_, i) => (c.buf.duration * i) / Math.max(1, words));
  const t0 = ctx!.currentTime;
  let shown = -1, raf = 0;
  const tick = (): void => {
    if (my !== lineSeq || !ctx) return;
    const t = ctx.currentTime - t0;
    let n = 0;
    while (n < marks.length && marks[n] <= t + 0.02) n++;
    if (n !== shown) { shown = n; o.onWords?.(before + n); }
    raf = requestAnimationFrame(tick);
  };
  if (o.onWords) tick();
  return new Promise((done) => { s.onended = () => { cancelAnimationFrame(raf); done(); }; s.start(); speaking = s; });
}

/** Speak one character's text (one or several sentences, played as one reply). Per sentence: the recorded file when
 *  it exists, else a recorded opener plus the server voice for the rest, else the server voice; voice unavailable =
 *  a few pitched blips, so the subtitle never appears in silence. Resolves when the speech ends, with its length. */
async function speakLine(speaker: string, parts: readonly string[], o: LineOptions): Promise<number> {
  const all = parts.join(" ").trim();
  if (!ctx || !all) { o.onWords?.(Number.MAX_SAFE_INTEGER); return 0; }
  const my = ++lineSeq;
  current?.abort();
  const ac = new AbortController();
  current = ac;
  if (speaking) { try { speaking.stop(); } catch { /* already ended */ } speaking = null; }
  // each piece: its words and a lazy fetch (recorded files are free and start at once; server lines are asked for one
  // sentence ahead of playback)
  const pieces: { words: number; free: boolean; get: () => Promise<Clip | null> }[] = [];
  const count = (t: string): number => t.split(/\s+/).filter(Boolean).length;
  for (const [i, raw] of parts.entries()) {
    const text = raw.trim(), token = o.tokens?.[i];
    if (!text) continue;
    const whole = recordedUrl(speaker, text);
    const op = whole || token ? null : opener(speaker, text); // a signed sentence is voiced whole, as signed
    if (whole) pieces.push({ words: count(text), free: true, get: () => fileClip(whole).then((c) => c ?? ttsClip(speaker, text, o.mood, ac.signal)) });
    else if (op) {
      pieces.push({ words: count(op), free: true, get: () => fileClip(recordedUrl(speaker, op)!) });
      const rest = text.slice(op.length).trim();
      if (!o.openerOnly) pieces.push({ words: count(rest), free: false, get: () => ttsClip(speaker, rest, o.mood, ac.signal) });
    } else if (!o.openerOnly) pieces.push({ words: count(text), free: false, get: () => ttsClip(speaker, text, o.mood, ac.signal, token) });
  }
  const asked: (Promise<Clip | null> | null)[] = pieces.map(() => null);
  const ask = (i: number): Promise<Clip | null> | null => (i < pieces.length ? (asked[i] ??= pieces[i].get()) : null);
  // free pieces and the first server piece now; each later server piece when the one before it starts playing
  let firstServer = true;
  pieces.forEach((p, i) => { if (p.free || firstServer) ask(i); if (!p.free) firstServer = false; });
  let total = 0, said = 0, on = false;
  const stop = (): number => { if (on) { o.onSpeaking?.(false); voiceHook?.(speaker, false); } return total; };
  for (let i = 0; i < pieces.length; i++) {
    const c = await ask(i);
    if (my !== lineSeq || !ctx) return stop(); // a newer line or a cancel took over
    if (!c) { said += pieces[i].words; o.onWords?.(said); continue; }
    ask(i + 1);
    if (!on) { on = true; o.onSpeaking?.(true); voiceHook?.(speaker, true); }
    duckFor(c.buf.duration);
    if (total > 0 && pieces[i].words) await new Promise((r) => window.setTimeout(r, SENTENCE_GAP_SEC * 1000));
    if (my !== lineSeq) return stop();
    await playClip(c, pieces[i].words, said, my, o);
    said += pieces[i].words;
    total += c.buf.duration;
    if (my !== lineSeq) return stop();
  }
  o.onWords?.(Number.MAX_SAFE_INTEGER);
  if (!total && pieces.length && my === lineSeq) { // voice unavailable: short blips, so the subtitle never appears in silence
    const syl = Math.min(6, Math.max(2, Math.round(count(all) / 2)));
    const f = BLIP[speaker as MerchantId] ?? 260;
    for (let i = 0; i < syl; i++) blip(f * (0.9 + Math.random() * 0.25), ctx.currentTime + i * 0.09, 0.07, "square", 0.05, voiceBus);
  }
  if (my === lineSeq) { speaking = null; if (current === ac) current = null; }
  return stop();
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
  /** Any character's line (speaker: a merchant id, folk0..3, engineer, harbor, picker, porter). The text is exactly
   *  what the subtitle shows. Dialogue cuts the previous line (or queues after it); ambient chatter waits its turn
   *  and never interrupts. */
  line(speaker: string, text: string, o: LineOptions = {}): Promise<number> {
    return audio.reply(speaker, [text], o);
  },
  /** A reply of several sentences, spoken as one line (conversation answers: the validated sentences, exactly). */
  reply(speaker: string, sentences: readonly string[], o: LineOptions = {}): Promise<number> {
    if (!ctx) { o.onWords?.(Number.MAX_SAFE_INTEGER); return Promise.resolve(0); }
    if (o.ambient) {
      const text = sentences.join(" ");
      if (speaking || ctx.currentTime < ambientUntil) return Promise.resolve(0);
      ambientUntil = ctx.currentTime + AMBIENT_GAP_SEC;
      const url = recordedUrl(speaker, text);
      return (url ? fileClip(url) : ttsClip(speaker, text)).then(async (c) => {
        if (!c || !ctx || speaking) return 0;
        ambientUntil = ctx.currentTime + c.buf.duration + AMBIENT_GAP_SEC;
        const s = ctx.createBufferSource(), p = ctx.createPanner();
        p.panningModel = "equalpower"; p.distanceModel = "inverse"; p.refDistance = 2; p.rolloffFactor = 1.4; p.maxDistance = 25;
        if (o.at) { p.positionX.value = o.at.x; p.positionY.value = o.at.y; p.positionZ.value = o.at.z; }
        s.buffer = c.buf; s.connect(p).connect(voiceBus); s.start();
        return c.buf.duration;
      });
    }
    if (o.queue) { // a queued line still waiting when stop() runs never plays
      const e = epoch;
      const run = chain.then(() => (e === epoch ? speakLine(speaker, sentences, o) : 0)); chain = run.catch(() => 0); return run;
    }
    const run = speakLine(speaker, sentences, o); chain = run.catch(() => 0); return run;
  },
  /** Cuts whatever is being said (conversation closed, player left, another character addressed): the voice stops,
   *  pending server requests for it are cancelled, and its callbacks report "not speaking". */
  stop(): void {
    lineSeq++; epoch++;
    current?.abort(); current = null;
    if (speaking) { try { speaking.stop(); } catch { /* already ended */ } speaking = null; }
    chain = Promise.resolve();
  },
  /** Called with (speaker, true) when a dialogue voice starts and (speaker, false) when it stops or is cut. */
  onVoice(f: (speaker: string, on: boolean) => void): void { voiceHook = f; },
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
