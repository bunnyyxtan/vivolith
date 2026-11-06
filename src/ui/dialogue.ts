// Conversation UI, styled as objects from Saltlight Market: an enamel name plank, a torn paper slip
// for the spoken line, a postage-stamp portrait rendered live from the 3D scene, and kraft-paper
// price-tag choices with consequence chips. Keyboard (1-4, arrows, Enter/Space/E, Esc) and mouse.
import type { Choice, Conversation, DialogueContext } from "../quests/dialogue.ts";

const CHARS_PER_SECOND = 52;

export interface DialogueUI {
  open(conv: Conversation, ctx: DialogueContext, onClose: () => void, portrait: Promise<HTMLCanvasElement | null>): void;
  close(): void;
  isOpen(): boolean;
  update(dt: number): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent?: HTMLElement): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  parent?.appendChild(e);
  return e;
}

// Small inline icons for consequence chips (no emoji, no icon font).
const ICONS: Record<string, string> = {
  coin: `<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.2" fill="#e9b949" stroke="#8a5d12" stroke-width="1.4"/><path d="M8 4.6v6.8M6 6.2h3.1a1.2 1.2 0 0 1 0 2.4H6.9a1.2 1.2 0 0 0 0 2.4H10" fill="none" stroke="#8a5d12" stroke-width="1.2"/></svg>`,
  heart: `<svg viewBox="0 0 16 16"><path d="M8 13.6S2.2 10 2.2 6.1A2.9 2.9 0 0 1 8 4.6a2.9 2.9 0 0 1 5.8 1.5C13.8 10 8 13.6 8 13.6z" fill="#d4573b" stroke="#7a2a1a" stroke-width="1.1"/></svg>`,
  rival: `<svg viewBox="0 0 16 16"><path d="M3 12.5l4-4.2 2.4 2.2 3.6-5" fill="none" stroke="#2f6b4f" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M10.8 5.3h2.4v2.4" fill="none" stroke="#2f6b4f" stroke-width="1.6"/></svg>`,
  clock: `<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="#f3ead7" stroke="#3b2f25" stroke-width="1.4"/><path d="M8 4.8V8l2.3 1.4" fill="none" stroke="#3b2f25" stroke-width="1.4" stroke-linecap="round"/></svg>`,
  crate: `<svg viewBox="0 0 16 16"><rect x="2.5" y="4" width="11" height="8.5" rx="1" fill="#c48a45" stroke="#6b4420" stroke-width="1.2"/><path d="M2.5 7.2h11M6 4v8.5M10 4v8.5" stroke="#6b4420" stroke-width="1"/></svg>`,
};

function iconFor(chip: string): string {
  const c = chip.toLowerCase();
  if (/(-|\+)?\d+\s?c\b|reward|fee|coin|purse|pays/.test(c)) return ICONS.coin;
  if (/tomas|rival|gains/.test(c)) return ICONS.rival;
  if (/reputation|remember|trust|own tonight/.test(c)) return ICONS.heart;
  if (/arrive|min|day|wait|until/.test(c)) return ICONS.clock;
  return ICONS.crate;
}

/** Deterministic torn-paper top edge as a clip-path polygon. */
function tornEdge(seed: number): string {
  const pts: string[] = [];
  let s = seed;
  const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
  for (let x = 0; x <= 100; x += 2.5) pts.push(`${x}% ${(rnd() * 7).toFixed(1)}px`);
  return `polygon(${pts.join(",")}, 100% 100%, 0% 100%)`;
}

export function createDialogueUI(root: HTMLElement): DialogueUI {
  const bars = el("div", "dlg-letterbox", root);
  const stage = el("div", "dlg-stage", root);
  const stamp = el("figure", "dlg-stamp", stage);
  const stampImg = el("div", "dlg-stamp-img", stamp);
  const postmark = el("figcaption", "dlg-postmark", stamp);
  const paper = el("div", "dlg-paper", stage);
  paper.style.clipPath = tornEdge(7);
  const plank = el("div", "dlg-plank", stage);
  const plankName = el("span", "dlg-plank-name", plank);
  const plankRole = el("span", "dlg-plank-role", plank);
  const textEl = el("p", "dlg-text", paper);
  const more = el("span", "dlg-more", paper);
  more.innerHTML = `<svg viewBox="0 0 24 14"><path d="M2 3l10 8 10-8" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  // Choices live in their own column at the right edge so the centre of the frame stays on the characters.
  const tags = el("ol", "dlg-tags", root);
  const hint = el("div", "dlg-hint", stage);

  let conv: Conversation | null = null;
  let ctx: DialogueContext | null = null;
  let onClose: (() => void) | null = null;
  let full = "";
  let shown = 0;
  let choices: Choice[] = [];
  let selected = 0;
  let nextId: string | null = null;

  const typing = () => shown < full.length;

  function renderChoices(): void {
    tags.replaceChildren();
    choices.forEach((c, i) => {
      const li = el("li", "dlg-tag", tags);
      li.style.setProperty("--tilt", `${(i % 2 ? 1 : -1) * (0.6 + (i % 3) * 0.35)}deg`);
      li.style.setProperty("--delay", `${i * 70}ms`);
      const enabled = !c.available || c.available(ctx!.econ);
      li.classList.toggle("disabled", !enabled);
      li.classList.toggle("selected", i === selected);
      el("span", "dlg-num", li).textContent = String(i + 1);
      const body = el("span", "dlg-tag-body", li);
      el("span", "dlg-tag-label", body).textContent = c.label;
      const detail = c.detail?.(ctx!.econ);
      if (detail) {
        const chips = el("span", "dlg-chips", body);
        for (const part of detail.split(/\s+·\s+|\s+—\s+/).filter(Boolean).slice(0, 3)) {
          const chip = el("span", "dlg-chip", chips);
          chip.innerHTML = iconFor(part);
          chip.append(document.createTextNode(part));
        }
      }
      li.addEventListener("mouseenter", () => { selected = i; refreshSelection(); });
      li.addEventListener("click", () => choose(i));
    });
    const waiting = choices.length === 0 || typing();
    tags.classList.toggle("shown", !waiting);
    more.classList.toggle("shown", !typing() && choices.length === 0);
    hint.textContent = typing() ? "space · finish the line" : choices.length ? "pick a tag · 1–4 · esc to walk away" : "space · go on   esc · walk away";
  }

  function refreshSelection(): void {
    [...tags.children].forEach((li, i) => li.classList.toggle("selected", i === selected));
  }

  function show(id: string | null): void {
    if (!conv || !ctx || id === null) return close();
    const node = conv.nodes[id];
    if (!node) return close();
    node.onEnter?.(ctx);
    plankName.textContent = node.speaker;
    full = node.text(ctx.econ);
    shown = 0;
    textEl.replaceChildren();
    choices = [...(node.choices ?? [])];
    selected = Math.max(0, choices.findIndex((c) => !c.available || c.available(ctx!.econ)));
    nextId = node.next ?? null;
    paper.classList.remove("swap");
    void paper.offsetWidth;
    paper.classList.add("swap");
    renderChoices();
  }

  function choose(i: number): void {
    const c = choices[i];
    if (!c || !ctx || typing()) return;
    if (c.available && !c.available(ctx.econ)) return;
    const li = tags.children[i] as HTMLElement | undefined;
    li?.classList.add("stamped");
    c.effect?.(ctx);
    setTimeout(() => show(c.next), 260); // let the stamp land
  }

  function advance(): void {
    if (typing()) {
      shown = full.length;
      textEl.textContent = full;
      renderChoices();
      return;
    }
    if (choices.length) return choose(selected);
    show(nextId);
  }

  function close(): void {
    if (!conv) return;
    conv = null;
    root.classList.remove("in-dialogue");
    const cb = onClose;
    onClose = null;
    cb?.();
  }

  window.addEventListener("keydown", (e) => {
    if (!conv) return;
    if (e.code === "Escape") { e.preventDefault(); close(); return; }
    if (e.code === "Space" || e.code === "Enter" || e.code === "KeyE") { e.preventDefault(); advance(); return; }
    if (typing()) return;
    const n = Number(e.key);
    if (n >= 1 && n <= choices.length) choose(n - 1);
    if (!choices.length) return;
    if (e.code === "ArrowDown" || e.code === "KeyS") { selected = (selected + 1) % choices.length; refreshSelection(); }
    if (e.code === "ArrowUp" || e.code === "KeyW") { selected = (selected - 1 + choices.length) % choices.length; refreshSelection(); }
  });
  paper.addEventListener("click", () => advance());
  bars.addEventListener("click", () => advance());

  return {
    open(c, context, cb, portrait) {
      conv = c;
      ctx = context;
      onClose = cb;
      stage.style.setProperty("--accent", c.accent);
      plankRole.textContent = c.role;
      postmark.textContent = c.role.split("·")[0].trim();
      stampImg.replaceChildren();
      stamp.classList.remove("ready");
      void portrait.then((canvas) => {
        if (!canvas || conv !== c) return;
        stampImg.replaceChildren(canvas);
        stamp.classList.add("ready");
      });
      root.classList.add("in-dialogue");
      show(c.entry(context.econ));
    },
    close,
    isOpen: () => conv !== null,
    update(dt) {
      if (!conv || !typing()) return;
      const before = Math.floor(shown);
      shown = Math.min(full.length, shown + dt * CHARS_PER_SECOND);
      const now = Math.floor(shown);
      if (now > before) {
        // Each new character fades in like ink soaking into paper.
        const span = document.createElement("span");
        span.className = "ink";
        span.textContent = full.slice(before, now);
        textEl.appendChild(span);
      }
      if (!typing()) renderChoices();
    },
  };
}
