// Conversation UI: a cinematic band across the bottom of the frame, a live 3D portrait bust in a cut-corner
// frame, an upright serif line that types in, and right-aligned choice lines; the selected one sits on a
// brush stroke with its consequences underneath. Keyboard (1-4, arrows/W/S, Space/Enter/E, Esc) and mouse.
import type { Choice, Conversation, DialogueContext } from "../quests/dialogue.ts";

const CHARS_PER_SECOND = 55;
const CHOOSE_DELAY_MS = 280;

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

/** Key-cap hint row, e.g. [["Space", "Next"], ["Esc", "Leave"]]. */
function hints(target: HTMLElement, items: ReadonlyArray<readonly [string, string]>): void {
  target.replaceChildren();
  for (const [key, label] of items) {
    const h = el("span", "dlg-key", target);
    el("kbd", "", h).textContent = key;
    h.append(label);
  }
}

export function createDialogueUI(root: HTMLElement): DialogueUI {
  const veil = el("div", "dlg-veil", root);
  const band = el("section", "dlg-band", root);
  const portraitFrame = el("figure", "dlg-portrait", band);
  const portraitImg = el("div", "dlg-portrait-img", portraitFrame);
  const body = el("div", "dlg-body", band);
  const head = el("header", "dlg-head", body);
  const nameEl = el("h2", "dlg-name", head);
  el("span", "dlg-rule", head);
  const roleEl = el("span", "dlg-role", head);
  const textEl = el("p", "dlg-text", body);
  const more = el("span", "dlg-more", body);
  more.innerHTML = `<svg viewBox="0 0 28 14" aria-hidden="true"><path d="M2 2l6 5-6 5M14 2l6 5-6 5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const keys = el("footer", "dlg-keys", band);
  // Choices stack at the right, above the band, so the centre of the frame stays on the characters.
  const list = el("ol", "dlg-choices", root);

  let conv: Conversation | null = null;
  let ctx: DialogueContext | null = null;
  let onClose: (() => void) | null = null;
  let full = "";
  let shown = 0;
  let choices: Choice[] = [];
  let selected = 0;
  let nextId: string | null = null;
  let locked = false;

  const typing = () => shown < full.length;
  const enabled = (c: Choice) => !c.available || c.available(ctx!.econ);

  function renderChoices(): void {
    list.replaceChildren();
    choices.forEach((c, i) => {
      const li = el("li", "dlg-choice", list);
      li.style.setProperty("--i", String(i));
      li.classList.toggle("disabled", !enabled(c));
      const line = el("span", "dlg-choice-line", li);
      el("span", "dlg-choice-label", line).textContent = c.label;
      el("span", "dlg-choice-num", line).textContent = String(i + 1);
      const detail = c.detail?.(ctx!.econ);
      if (detail || !enabled(c)) {
        const d = el("span", "dlg-choice-detail", li);
        d.textContent = enabled(c) ? detail!.split(/\s+·\s+|\s+—\s+/).filter(Boolean).slice(0, 3).join("   ·   ") : "Not available right now";
      }
      li.addEventListener("mouseenter", () => { selected = i; refreshSelection(); });
      li.addEventListener("click", (e) => { e.stopPropagation(); choose(i); });
    });
    refreshSelection();
    list.classList.toggle("shown", choices.length > 0 && !typing());
    more.classList.toggle("shown", !typing() && choices.length === 0);
    if (typing()) hints(keys, [["Space", "Skip"], ["Esc", "Leave"]]);
    else if (choices.length) hints(keys, [[`1–${choices.length}`, "Choose"], ["W / S", "Select"], ["Space", "Confirm"], ["Esc", "Leave"]]);
    else hints(keys, [["Space", nextId ? "Next" : "Close"], ["Esc", "Leave"]]);
  }

  function refreshSelection(): void {
    [...list.children].forEach((li, i) => li.classList.toggle("selected", i === selected));
  }

  function show(id: string | null): void {
    locked = false;
    if (!conv || !ctx || id === null) return close();
    const node = conv.nodes[id];
    if (!node) return close();
    node.onEnter?.(ctx);
    nameEl.textContent = node.speaker;
    full = node.text(ctx.econ);
    shown = 0;
    textEl.replaceChildren();
    choices = [...(node.choices ?? [])];
    selected = Math.max(0, choices.findIndex(enabled));
    nextId = node.next ?? null;
    body.classList.remove("swap");
    void body.offsetWidth;
    body.classList.add("swap");
    renderChoices();
  }

  function choose(i: number): void {
    const c = choices[i];
    if (!c || !ctx || typing() || locked || !enabled(c)) return;
    locked = true;
    selected = i;
    refreshSelection();
    list.children[i]?.classList.add("chosen");
    list.classList.add("committing");
    c.effect?.(ctx);
    setTimeout(() => {
      list.classList.remove("committing");
      show(c.next);
    }, CHOOSE_DELAY_MS);
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

  function step(delta: number): void {
    if (!choices.length) return;
    for (let k = 0; k < choices.length; k++) {
      selected = (selected + delta + choices.length) % choices.length;
      if (enabled(choices[selected])) break;
    }
    refreshSelection();
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
    if (e.code === "ArrowDown" || e.code === "KeyS") step(1);
    if (e.code === "ArrowUp" || e.code === "KeyW") step(-1);
  });
  band.addEventListener("click", () => advance());
  veil.addEventListener("click", () => advance());

  return {
    open(c, context, cb, portrait) {
      conv = c;
      ctx = context;
      onClose = cb;
      root.style.setProperty("--accent", c.accent);
      roleEl.textContent = c.role;
      portraitImg.replaceChildren();
      portraitFrame.classList.remove("ready");
      void portrait.then((canvas) => {
        if (!canvas || conv !== c) return;
        portraitImg.replaceChildren(canvas);
        portraitFrame.classList.add("ready");
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
        const span = document.createElement("span");
        span.className = "ink";
        span.textContent = full.slice(before, now);
        textEl.appendChild(span);
      }
      if (!typing()) renderChoices();
    },
  };
}
