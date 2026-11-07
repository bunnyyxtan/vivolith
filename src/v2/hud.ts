// v2 HUD: solid panels, one type family (Inter Tight), strict hierarchy. Pure DOM, no framework.
const CSS = /* css */ `
:root { --ink:#10151f; --ink2:#1a2130; --line:#2a3344; --fg:#eef2f0; --mute:#93a3b0; --near:#00ec97; --warn:#ff7a6b; --gold:#ffc94a; }
.hud { position:fixed; font-family:"Inter Tight",system-ui,sans-serif; color:var(--fg); font-variant-numeric:tabular-nums; z-index:5; }
.hud-top { left:16px; top:16px; display:flex; gap:0; background:var(--ink); border-left:3px solid var(--near); pointer-events:none; }
.hud-top > div { padding:10px 16px; border-right:1px solid var(--line); }
.hud-top b { display:block; font-size:20px; font-weight:700; letter-spacing:.01em; }
.hud-top span { display:block; font-size:11px; color:var(--mute); letter-spacing:.12em; text-transform:uppercase; margin-top:2px; }
.hud-top .rent b { color:var(--gold); }
.hud-top .ff b { color:var(--near); }
.hud-prompt { left:50%; bottom:64px; transform:translateX(-50%); background:var(--ink); padding:10px 18px; font-size:15px; font-weight:600; display:none; pointer-events:none; }
.hud-prompt kbd, .hud kbd { font:700 12px "Inter Tight",system-ui,sans-serif; background:var(--fg); color:var(--ink); padding:2px 6px; margin-right:8px; border-radius:2px; }
.hud-tip { background:var(--ink); padding:12px 14px; width:280px; display:none; pointer-events:none; border-top:3px solid var(--gold); }
.hud-tip h4 { margin:0 0 8px; font-size:13px; font-weight:700; letter-spacing:.08em; text-transform:uppercase; }
.hud-tip .row { display:flex; justify-content:space-between; font-size:13px; padding:3px 0; color:var(--mute); }
.hud-tip .row i { font-style:normal; color:var(--fg); }
.hud-tip .eq { border-top:1px solid var(--line); margin-top:6px; padding-top:6px; font-size:12px; color:var(--mute); }
.hud-panel { bottom:24px; width:400px; background:var(--ink); display:none; transform:translateY(12px); opacity:0; transition:transform .22s ease-out, opacity .22s; }
.hud-panel.show { transform:none; opacity:1; }
.hud-panel.left { left:24px; } .hud-panel.right { right:24px; }
.hud-panel header { padding:14px 18px 10px; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; align-items:baseline; }
.hud-panel header b { font-size:18px; font-weight:700; }
.hud-panel header span { font-size:11px; letter-spacing:.14em; text-transform:uppercase; color:var(--mute); }
.hp-price { padding:14px 18px 4px; display:flex; align-items:baseline; gap:12px; }
.hp-price b { font-size:44px; font-weight:700; line-height:1; transition:color .3s; }
.hp-price b.down { color:var(--near); } .hp-price b.up { color:var(--warn); }
.hp-price span { color:var(--mute); font-size:14px; }
.hp-thought { padding:6px 18px 12px; font-size:14px; color:var(--mute); }
.hp-thought i { font-style:normal; color:var(--fg); }
.hp-pat { margin:0 18px; height:6px; background:var(--ink2); }
.hp-pat div { height:100%; background:var(--near); transition:width .15s linear, background .3s; }
.hp-pat div.low { background:var(--warn); }
.hp-patl { padding:4px 18px 0; font-size:11px; letter-spacing:.14em; text-transform:uppercase; color:var(--mute); }
.hp-line { margin:12px 18px 0; padding:10px 12px; background:var(--ink2); font-size:15px; min-height:20px; border-left:3px solid var(--line); }
.hp-line.good { border-left-color:var(--near); } .hp-line.bad { border-left-color:var(--warn); animation:shake .3s; }
@keyframes shake { 25%{transform:translateX(-4px)} 75%{transform:translateX(4px)} }
.hp-acts { padding:12px 18px 16px; display:grid; grid-template-columns:1fr 1fr; gap:6px; }
.hud button { font:600 14px "Inter Tight",system-ui,sans-serif; color:var(--fg); background:var(--ink2); border:1px solid var(--line); padding:10px 12px; text-align:left; cursor:pointer; border-radius:2px; }
.hud button:hover { border-color:var(--near); }
.hud button.primary { background:var(--near); color:var(--ink); border-color:var(--near); grid-column:span 2; }
.hud button.used { color:var(--mute); }
.hud button small { display:block; font-weight:400; font-size:12px; color:var(--mute); margin-top:3px; }
.hud button.primary small { color:#0d3b2b; }
.hp-text { padding:14px 18px 4px; font-size:16px; line-height:1.45; }
.hud-card { left:50%; top:50%; transform:translate(-50%,-50%); width:min(640px,calc(100vw - 32px)); background:var(--ink); display:none; border-top:4px solid var(--gold); max-height:calc(100vh - 48px); overflow:auto; }
.hud-card h2 { margin:0; padding:20px 24px 4px; font-size:28px; font-weight:700; }
.hud-card h3 { margin:0; padding:0 24px 14px; font-size:12px; letter-spacing:.14em; text-transform:uppercase; color:var(--mute); font-weight:600; }
.hud-card table { width:100%; border-collapse:collapse; font-size:14px; }
.hud-card td { padding:9px 24px; border-top:1px solid var(--line); vertical-align:top; }
.hud-card td.n { text-align:right; white-space:nowrap; }
.hud-card .ok { color:var(--near); font-weight:700; } .hud-card .bad { color:var(--warn); font-weight:700; }
.hud-card .why { color:var(--mute); font-size:12px; display:block; margin-top:2px; }
.hud-card ul { margin:0; padding:10px 24px 4px 42px; color:var(--mute); font-size:13px; line-height:1.6; }
.hud-card footer { padding:14px 24px 20px; }
.hud-card a, .hud-rc a { color:var(--near); }
.hud-acct { left:16px; bottom:16px; background:var(--ink); border-left:3px solid var(--near); padding:8px 8px 8px 12px; display:flex; gap:12px; align-items:center; pointer-events:auto; }
.hud-acct b { display:block; font-size:13px; font-weight:600; } .hud-acct span { display:block; font-size:11px; letter-spacing:.12em; text-transform:uppercase; color:var(--mute); margin-top:2px; }
.hud-acct button { padding:7px 10px; font-size:13px; }
.hud-rc { right:16px; top:16px; width:300px; display:flex; flex-direction:column; gap:4px; pointer-events:auto; }
.hud-rc div { background:var(--ink); padding:8px 12px; font-size:12px; color:var(--mute); border-left:3px solid var(--line); animation:slide .3s ease-out; }
.hud-rc div b { color:var(--fg); font-weight:600; display:block; font-size:13px; }
.hud-rc div.onchain { border-left-color:var(--near); } .hud-rc div.failed { border-left-color:var(--warn); } .hud-rc div.pending { border-left-color:var(--gold); }
@keyframes slide { from { transform:translateX(20px); opacity:0 } }
.hud-toast { left:50%; top:84px; transform:translateX(-50%); background:var(--ink); padding:10px 18px; font-size:15px; font-weight:600; display:none; border-bottom:3px solid var(--near); }
.coin { position:fixed; width:14px; height:14px; border-radius:50%; background:var(--gold); box-shadow:inset -2px -2px 0 #c8922a; z-index:6; pointer-events:none;
  transition:transform .7s cubic-bezier(.5,-.4,.7,1), opacity .7s; }
`;

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

export interface Hud {
  readonly top: HTMLDivElement;
  readonly prompt: HTMLDivElement;
  readonly tip: HTMLDivElement;
  readonly panel: HTMLDivElement;
  readonly card: HTMLDivElement;
  readonly receipts: HTMLDivElement;
  /** Bottom-left account chip: who is playing (guest or signed in) and the sign-in button. */
  readonly acct: HTMLDivElement;
  toast(text: string): void;
  coins(fromX: number, fromY: number, n: number): void;
}

export function createHud(): Hud {
  const style = el("style");
  style.textContent = CSS;
  document.head.appendChild(style);
  const mk = (cls: string): HTMLDivElement => { const d = el("div", `hud ${cls}`); document.body.appendChild(d); return d; };
  const top = mk("hud-top"), prompt = mk("hud-prompt"), tip = mk("hud-tip"), panel = mk("hud-panel"), card = mk("hud-card"), receipts = mk("hud-rc"), acct = mk("hud-acct"), toastEl = mk("hud-toast");
  let toastTimer = 0;
  return {
    top, prompt, tip, panel, card, receipts, acct,
    toast(text) {
      toastEl.textContent = text;
      toastEl.style.display = "block";
      clearTimeout(toastTimer);
      toastTimer = window.setTimeout(() => { toastEl.style.display = "none"; }, 2600);
    },
    coins(fx, fy, n) {
      const target = top.querySelector<HTMLElement>(".coins")?.getBoundingClientRect();
      const tx = target ? target.left + 20 : 60, ty = target ? target.top + 14 : 30;
      for (let i = 0; i < Math.min(n, 14); i++) {
        const c = el("div", "coin");
        c.style.left = `${fx + Math.cos(i * 2.4) * 30}px`;
        c.style.top = `${fy + Math.sin(i * 2.4) * 20}px`;
        document.body.appendChild(c);
        window.setTimeout(() => {
          c.style.transform = `translate(${tx - fx}px, ${ty - fy}px) scale(.6)`;
          c.style.opacity = "0.2";
        }, 30 + i * 45);
        window.setTimeout(() => c.remove(), 900 + i * 45);
      }
    },
  };
}
