// v2 HUD: soft paper cards with ink text, one type family (Inter Tight), a clear hierarchy that sits on the bright
// anime city instead of covering it. Pure DOM, no framework.
//   top-left   objective tracker        top-right  wallet (coins, bag) + a quiet NEAR status line
//   centre     trade / talk panel        bottom     interaction prompt, account chip
//   overlays   notebook (goals, bag, receipts, help) and reports, over a soft backdrop
const CSS = /* css */ `
:root { --paper:#fffaf1; --paper2:#f5eee2; --ink:#1d2433; --ink2:#4a5468; --mute:#808898; --line:#e8dfcf;
  --mint:#14b887; --mintd:#0a7f5d; --mints:#dcf6ec; --coral:#e2604a; --corals:#fde6e1; --gold:#f2b63c; --golds:#fff1cf;
  --shadow:0 8px 24px rgba(24,36,60,.16), 0 1px 3px rgba(24,36,60,.12); --r:14px; }
.hud { position:fixed; font-family:"Inter Tight",system-ui,sans-serif; color:var(--ink); font-variant-numeric:tabular-nums; z-index:5; }
.hud kbd { display:inline-flex; align-items:center; justify-content:center; min-width:20px; height:20px; padding:0 5px; margin-right:7px; border-radius:5px;
  font:700 11px "Inter Tight",system-ui,sans-serif; background:var(--ink); color:var(--paper); vertical-align:1px; box-sizing:border-box; }
.hud button { font:600 15px "Inter Tight",system-ui,sans-serif; color:var(--ink); background:var(--paper2); border:0; border-radius:10px; padding:11px 14px;
  cursor:pointer; text-align:left; transition:transform .08s, background .15s, box-shadow .15s; }
.hud button:hover { background:#efe6d6; } .hud button:active { transform:translateY(1px); }
.hud button.primary { background:var(--mint); color:#fff; box-shadow:0 3px 0 var(--mintd); } .hud button.primary:hover { background:#11a87b; }
.hud button.primary kbd { background:#fff; color:var(--mintd); }
.hud button.ghost { background:transparent; color:var(--ink2); padding:8px 10px; } .hud button.ghost:hover { background:var(--paper2); }
.hud button:disabled { opacity:.45; cursor:default; transform:none; }
.hud button small { display:block; font-weight:500; font-size:12px; opacity:.8; margin-top:2px; }

/* objective tracker */
/* mission card: accent rail, section + step, progress, title, copy, then the live economy panel */
.hud-obj { --acc:var(--mint); --accd:var(--mintd); left:20px; top:20px; width:min(330px, calc(100vw - 260px)); background:var(--paper); border-radius:var(--r);
  box-shadow:var(--shadow); padding:13px 16px 14px 19px; display:none; pointer-events:none; overflow:hidden; }
.hud-obj::before { content:""; position:absolute; left:0; top:0; bottom:0; width:4px; background:var(--acc); }
.hud-obj.tone-urgent { --acc:var(--coral); --accd:#b8402c; } .hud-obj.tone-chance { --acc:var(--gold); --accd:#a8740f; }
.hud-obj .oh { display:flex; align-items:baseline; justify-content:space-between; gap:12px; }
.hud-obj .sec { font-size:10.5px; font-weight:700; letter-spacing:.14em; text-transform:uppercase; color:var(--accd); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.hud-obj .step { font-size:11.5px; font-weight:700; color:var(--mute); }
.hud-obj .prog { height:3px; border-radius:2px; background:var(--line); margin:7px 0 0; overflow:hidden; }
.hud-obj .prog i { display:block; height:100%; background:var(--acc); border-radius:2px; }
.hud-obj .title { font-size:17px; font-weight:700; line-height:1.25; margin-top:9px; letter-spacing:-.005em; }
.hud-obj .desc { margin:5px 0 0; font-size:13.5px; line-height:1.45; color:var(--ink2); }
.hud-obj .stake { margin:11px -4px 0; padding:9px 11px 10px; border-radius:10px; background:var(--mints); }
.hud-obj .stake.short { background:var(--corals); }
.hud-obj .stake .sh { display:flex; justify-content:space-between; align-items:baseline; gap:10px; }
.hud-obj .stake .k { font-size:10px; font-weight:700; letter-spacing:.12em; text-transform:uppercase; color:var(--mintd); }
.hud-obj .stake.short .k { color:#b8402c; }
.hud-obj .stake .when { font-size:11.5px; font-weight:600; color:var(--ink2); text-align:right; }
.hud-obj .stake .meter { height:5px; border-radius:3px; background:rgba(29,36,51,.1); margin:7px 0 6px; overflow:hidden; }
.hud-obj .stake .meter i { display:block; height:100%; border-radius:3px; background:var(--mint); }
.hud-obj .stake.short .meter i { background:var(--coral); }
.hud-obj .stake .nums { display:flex; align-items:baseline; font-size:12.5px; color:var(--ink2); }
.hud-obj .stake .nums b { font-size:15px; color:var(--ink); }
.hud-obj .stake .nums span { white-space:pre; }
.hud-obj .stake .nums em { margin-left:auto; font-style:normal; font-weight:700; color:var(--mintd); }
.hud-obj .stake.short .nums em { color:#b8402c; }
.tp-compare b { font-weight:700; }
.hud-obj.done { animation:pop .5s ease; }
@keyframes pop { 30% { transform:scale(1.04); box-shadow:0 0 0 4px var(--mints), var(--shadow); } }

/* wallet */
.hud-wallet { right:20px; top:20px; display:flex; flex-direction:column; align-items:flex-end; gap:6px; }
.hud-wallet .row { display:flex; gap:8px; }
.hud .hud-pill { background:var(--paper); border-radius:999px; box-shadow:var(--shadow); padding:7px 14px 7px 9px; display:flex; align-items:center; gap:8px; font-weight:700; font-size:16px;
  cursor:pointer; pointer-events:auto; border:0; }
.hud .hud-pill:hover { background:#fff; }
.hud-pill .ico { width:20px; height:20px; border-radius:50%; flex:none; }
.ico.coin { background:radial-gradient(circle at 35% 35%, #ffe08a, var(--gold) 60%, #c98e1f); box-shadow:inset 0 -2px 0 #c98e1f; border-radius:50%; }
.ico.mango { background:radial-gradient(circle at 35% 30%, #ffd36b, #f59a1e 65%, #d9741a); border-radius:55% 45% 55% 45%; }
.ico.mango { position:relative; } .ico.mango::after { content:""; position:absolute; width:9px; height:6px; right:-1px; top:-3px; background:#3f9a4e; border-radius:0 8px 0 8px; transform:rotate(-15deg); }
.ico.lemon { background:radial-gradient(circle at 35% 30%, #fff59a, #f2d43c 65%, #c9a91c); border-radius:50% 40% 50% 40%; }
.ico.lassi { background:linear-gradient(#fff, #ffe3b0); border:2px solid #e8c88a; border-radius:3px 3px 8px 8px; }
.ico.share { background:var(--mint); border-radius:5px; }
.hud-pill.bump { animation:bump .45s ease; }
@keyframes bump { 40% { transform:scale(1.12); } }
.hud-clock { background:var(--paper); border-radius:999px; box-shadow:var(--shadow); padding:6px 12px; font-size:13px; font-weight:600; color:var(--ink2); }
.hud-clock em { font-style:normal; color:var(--coral); }
.hud-near { font-size:12px; font-weight:600; color:var(--ink2); background:rgba(255,250,241,.94); border-radius:999px; padding:4px 10px; box-shadow:var(--shadow);
  opacity:0; transition:opacity .4s; pointer-events:none; }
.hud-near.on { opacity:1; } .hud-near i { font-style:normal; color:var(--mintd); } .hud-near.bad i { color:var(--coral); }

/* prompt and hint */
.hud-prompt { left:50%; bottom:28px; transform:translateX(-50%); background:var(--paper); border-radius:999px; box-shadow:var(--shadow); padding:9px 18px 9px 10px;
  font-size:15px; font-weight:600; display:none; pointer-events:none; white-space:nowrap; }
.hud-prompt span + kbd { margin-left:14px; }
.hud-hint { left:50%; bottom:76px; transform:translateX(-50%); background:rgba(29,36,51,.86); color:#fff; border-radius:10px; padding:8px 14px; font-size:14px; font-weight:500;
  display:none; pointer-events:none; white-space:nowrap; }
.hud-hint kbd { background:#fff; color:var(--ink); }

/* world marker */
.hud-mark { width:30px; height:30px; margin:-15px 0 0 -15px; display:none; pointer-events:none; z-index:4; }
.hud-mark::before { content:""; position:absolute; inset:5px; background:var(--gold); border:3px solid #fff; transform:rotate(45deg); border-radius:4px; box-shadow:0 2px 6px rgba(0,0,0,.25);
  animation:bob 1.2s ease-in-out infinite; }
@keyframes bob { 50% { transform:translateY(-5px) rotate(45deg); } }
.hud-mark span { position:absolute; left:50%; top:32px; transform:translateX(-50%); font-size:12px; font-weight:700; color:#fff; text-shadow:0 1px 3px rgba(0,0,0,.7); white-space:nowrap; }

/* trade / talk panel. Talk: a dialogue box centred along the bottom, under the speaker's face. Trade: a card centred
   vertically on the side away from the merchant (the camera keeps them right of centre), below the objective.
   Narrow screens: both become a bottom sheet. */
.hud-panel { overflow:auto; background:var(--paper); border-radius:18px; box-shadow:var(--shadow); box-sizing:border-box;
  display:none; transform:translateY(12px); opacity:0; transition:transform .2s ease-out, opacity .2s; overscroll-behavior:contain; }
.hud-panel.show { transform:none; opacity:1; }
.hud-panel.talk { left:0; right:0; bottom:24px; margin:0 auto; width:min(720px, calc(100vw - 48px)); max-height:min(56vh, calc(100vh - 150px)); }
.hud-panel.talk .tp-acts { grid-template-columns:repeat(auto-fit, minmax(220px, 1fr)); }
.hud-panel.talk .tp-acts .full { grid-column:auto; } .hud-panel.talk .tp-acts .primary { grid-column:auto; text-align:left; }
.hud-panel.talk .tp-acts > :only-child { grid-column:1 / -1; text-align:center; }
.hud-panel.trade { --pt:150px; top:var(--pt); bottom:24px; margin:auto 0; height:fit-content; width:min(400px, calc(100vw - 48px)); max-height:calc(100vh - var(--pt) - 24px); }
.hud-panel.trade.left { left:clamp(24px, 6vw, 96px); }
/* a card (welcome, notebook, reports) covers the centre: the objective and corner pills step back behind it */
body.card-open .hud-obj, body.card-open .hud-prompt, body.card-open .hud-hint, body.card-open .hud-mark, body.card-open .hud-tip { display:none !important; }
body.panel-open .hud-prompt, body.panel-open .hud-hint, body.panel-open .hud-acct, body.panel-open .hud-mark, body.panel-open .hud-tip { display:none !important; }
@media (max-width:760px), (max-height:520px) {
  .hud-panel.trade, .hud-panel.talk { left:0 !important; right:0 !important; top:auto; bottom:12px; margin:0 auto; height:auto; width:min(520px, calc(100vw - 24px)); max-height:calc(100vh - 76px); --pt:0px; }
  /* the panel sits over where the objective is: it steps aside while a panel is open (like the prompt and account) */
  body.panel-open .hud-obj { display:none !important; }
  .hud-panel .tp-acts { position:sticky; bottom:0; background:var(--paper); padding:10px 14px 14px; gap:6px; box-shadow:0 -8px 12px -10px rgba(24,36,60,.25); }
  .hud-panel .tp-acts .full { grid-column:auto; } .hud-panel .tp-acts button { padding:9px 12px; } .hud-panel .tp-acts button small { display:none; }
  .hud-panel .tp-acts .tp-text { grid-column:1 / -1; padding:0; }
  body.panel-open .hud-obj { opacity:0; }
}
.tp-head { display:flex; gap:12px; align-items:center; padding:16px 18px 12px; }
.tp-ava { width:42px; height:42px; border-radius:50%; flex:none; display:flex; align-items:center; justify-content:center; font-weight:800; font-size:17px; color:#fff; }
.tp-head b { display:block; font-size:18px; font-weight:700; } .tp-head span { display:block; font-size:13px; color:var(--mute); margin-top:1px; }
.tp-say { margin:0 18px 12px; padding:10px 13px; background:var(--paper2); border-radius:12px; font-size:15px; line-height:1.45; color:var(--ink); }
.tp-say.good { background:var(--mints); } .tp-say.bad { background:var(--corals); animation:shake .3s; }
@keyframes shake { 25% { transform:translateX(-4px); } 75% { transform:translateX(4px); } }
.tp-tabs { display:flex; gap:4px; margin:0 18px 10px; background:var(--paper2); border-radius:10px; padding:3px; }
.tp-tabs button { flex:1; text-align:center; padding:7px; font-size:14px; background:transparent; border-radius:8px; }
.tp-tabs button.on { background:#fff; box-shadow:0 1px 3px rgba(0,0,0,.1); }
.tp-item { display:flex; align-items:center; gap:12px; margin:0 18px; padding:12px 0; border-top:1px solid var(--line); }
.tp-item .ico { width:28px; height:28px; flex:none; }
.tp-item b { display:block; font-size:16px; } .tp-item span { display:block; font-size:13px; color:var(--mute); }
.tp-item .price { margin-left:auto; text-align:right; } .tp-item .price b { font-size:22px; }
.tp-why { display:block; margin:0 18px; font-size:13px; color:var(--mintd); background:none !important; border:0; padding:0 0 10px !important; cursor:pointer; font-weight:600; }
.tp-reasons { margin:0 18px 10px; padding:10px 12px 10px 28px; background:var(--paper2); border-radius:10px; font-size:13px; line-height:1.55; color:var(--ink2); }
.tp-qty { display:flex; align-items:center; gap:10px; margin:2px 18px 12px; }
.tp-qty button { width:36px; height:36px; padding:0; text-align:center; font-size:20px; font-weight:700; }
.tp-qty b { min-width:28px; text-align:center; font-size:20px; }
.tp-qty span { margin-left:auto; font-size:13px; color:var(--mute); text-align:right; line-height:1.35; }
.tp-facts { display:grid; grid-template-columns:1fr 1fr; gap:6px; margin:0 18px 12px; }
.tp-facts div { background:var(--paper2); border-radius:10px; padding:8px 11px; }
.tp-facts span { display:block; font-size:12px; color:var(--mute); font-weight:600; }
.tp-facts b { display:block; font-size:16px; font-weight:700; margin-top:1px; }
.tp-shares { flex-wrap:wrap; }
.tp-shares button:disabled { opacity:.35; cursor:default; }
.tp-shares input { width:64px; height:36px; box-sizing:border-box; border:2px solid var(--line); border-radius:10px; background:#fff; color:var(--ink);
  font:700 18px "Inter Tight",system-ui,sans-serif; text-align:center; font-variant-numeric:tabular-nums; -moz-appearance:textfield; }
.tp-shares input::-webkit-outer-spin-button, .tp-shares input::-webkit-inner-spin-button { -webkit-appearance:none; margin:0; }
.tp-shares input:focus { outline:none; border-color:var(--mint); }
.hud .tp-shares .tp-max { width:auto; padding:0 10px; font-size:13px; font-weight:600; }
.tp-sum { margin-left:auto; text-align:right; }
.tp-qty .tp-sum b { display:block; min-width:0; text-align:right; font-size:20px; }
.tp-qty .tp-sum span { display:block; font-size:12px; }
.tp-stake { margin:0 18px 12px; }
.tp-stake i { position:relative; display:flex; height:8px; border-radius:4px; background:var(--paper2); overflow:hidden; }
.tp-stake i b { display:block; height:100%; background:var(--mint); transition:width .15s; } .tp-stake i b.mine { background:var(--mintd); }
.tp-stake span { display:block; font-size:13px; color:var(--ink2); margin-top:6px; line-height:1.4; }
.tp-note { font-size:12px; color:var(--mute); }
/* asking a merchant or resident your own question: one field and one button, in the panel's own type */
.tp-ask { display:flex; gap:8px; margin:0 18px 12px; }
.tp-ask input { flex:1; min-width:0; height:36px; box-sizing:border-box; border:2px solid var(--line); border-radius:10px; padding:0 11px; background:#fff; color:var(--ink); font:500 14px "Inter Tight",system-ui,sans-serif; }
.tp-ask input:focus { outline:none; border-color:var(--mint); }
.hud .tp-ask button { flex:none; height:36px; padding:0 14px; font-size:14px; font-weight:600; }
.tp-ask button:disabled { opacity:.5; cursor:default; }
.tp-proof { display:block; margin-top:4px; font-weight:600; }
.tp-proof.signed { color:var(--mintd); } .tp-proof.failed { color:var(--coral, #c0392b); }
@media (max-width:520px) { .tp-sum { flex-basis:100%; margin-left:0; text-align:left; } .tp-qty .tp-sum b { text-align:left; } }
.tp-acts { display:grid; gap:8px; padding:4px 18px 18px; grid-template-columns:1fr 1fr; }
.tp-acts .primary { grid-column:1 / -1; text-align:center; font-size:16px; padding:13px; }
.tp-acts .full { grid-column:1 / -1; }
.tp-pat { margin:0 18px 10px; } .tp-pat i { display:block; height:6px; border-radius:3px; background:var(--paper2); overflow:hidden; margin-top:4px; }
.tp-pat i b { display:block; height:100%; background:var(--mint); transition:width .15s linear; } .tp-pat i b.low { background:var(--coral); }
.tp-pat span { font-size:12px; color:var(--mute); font-weight:600; }
.tp-text { padding:0 18px 12px; font-size:15px; line-height:1.5; }

/* tooltip over chalkboards */
.hud-tip { background:var(--paper); border-radius:12px; box-shadow:var(--shadow); padding:11px 13px 11px 13px; width:260px; display:none; pointer-events:none; font-size:13px; line-height:1.45; color:var(--ink2); }
.hud-tip b { display:block; color:var(--ink); font-size:14px; margin-bottom:4px; }
.hud-tip ul { margin:0; padding-left:16px; }

/* overlays: notebook, reports */
.hud-back { inset:0; background:rgba(20,28,44,.35); display:none; z-index:7; }
.hud-card { left:50%; top:50%; transform:translate(-50%,-50%); width:min(600px, calc(100vw - 32px)); max-height:calc(100vh - 48px); overflow:auto; background:var(--paper);
  border-radius:20px; box-shadow:var(--shadow); display:none; z-index:8; }
.hud-card h2 { margin:0; padding:22px 26px 2px; font-size:26px; font-weight:800; letter-spacing:-.01em; }
.hud-card .sub { padding:0 26px 14px; font-size:14px; color:var(--mute); }
.hud-card section { padding:14px 26px; border-top:1px solid var(--line); }
.hud-card h4 { margin:0 0 8px; font-size:12px; font-weight:700; letter-spacing:.12em; text-transform:uppercase; color:var(--mintd); }
.hud-card p { margin:0 0 6px; font-size:15px; line-height:1.5; }
.hud-card .big { font-size:30px; font-weight:800; } .hud-card .pos { color:var(--mintd); } .hud-card .neg { color:var(--coral); }
.hud-card table { width:100%; border-collapse:collapse; font-size:14px; } .hud-card td { padding:7px 0; border-top:1px solid var(--line); vertical-align:top; }
.hud-card td.n { text-align:right; white-space:nowrap; font-weight:600; } .hud-card .why { display:block; font-size:12px; color:var(--mute); }
.hud-card ul { margin:0; padding-left:18px; font-size:14px; line-height:1.6; color:var(--ink2); }
.hud-card details { padding:12px 26px; border-top:1px solid var(--line); font-size:14px; }
.hud-card summary { cursor:pointer; font-weight:600; color:var(--ink2); }
.hud-card details > *:not(summary) { margin-top:10px; }
.hud-card footer { padding:14px 26px 22px; display:flex; gap:8px; justify-content:flex-end; border-top:1px solid var(--line); }
.hud-card footer .primary { padding:12px 22px; }
.hud-card a, .hud-near a { color:var(--mintd); font-weight:600; }
.nb-tabs { display:flex; gap:4px; padding:4px 22px 12px; flex-wrap:wrap; } .nb-tabs button { padding:8px 14px; font-size:14px; background:transparent; }
.nb-tabs button.on { background:var(--paper2); }
.goal { display:flex; gap:10px; padding:7px 0; font-size:15px; line-height:1.35; } .goal i { width:16px; height:16px; border-radius:50%; border:2px solid #d8ccb6; flex:none; margin-top:1px; }
.goal.done i { background:var(--mint); border-color:var(--mint); } .goal.done span { color:var(--mute); } .goal.now span { font-weight:700; }
.goal small { display:block; color:var(--mute); font-size:13px; font-weight:400; }
.bag { display:grid; grid-template-columns:repeat(auto-fill, minmax(150px, 1fr)); gap:10px; }
.bag span { display:block; line-height:1.3; }
.bag > div { background:var(--paper2); border-radius:12px; padding:12px; display:flex; gap:10px; align-items:center; } .bag .ico { width:26px; height:26px; flex:none; }
.bag b { display:block; font-size:18px; } .bag span { font-size:12px; color:var(--mute); }

/* account chip, toast */
.hud-acct { left:20px; bottom:20px; background:var(--paper); border-radius:999px; box-shadow:var(--shadow); padding:5px 5px 5px 14px; display:flex; gap:10px; align-items:center;
  font-size:13px; pointer-events:auto; max-width:min(420px, calc(50vw - 200px)); }
.hud-acct .who { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.hud-acct b { font-weight:700; } .hud-acct span { color:var(--mute); }
.hud-acct button { padding:6px 12px; font-size:13px; border-radius:999px; flex:none; white-space:nowrap; }
.hud-toast { left:50%; top:20px; transform:translateX(-50%); background:var(--ink); color:#fff; border-radius:999px; padding:9px 18px; font-size:14px; font-weight:600;
  display:none; box-shadow:var(--shadow); max-width:calc(100vw - 760px); min-width:220px; text-align:center; z-index:9; }
.hud-toast.good { background:var(--mintd); }
.coin-fly { position:fixed; width:16px; height:16px; border-radius:50%; background:radial-gradient(circle at 35% 35%, #ffe08a, var(--gold) 60%, #c98e1f); z-index:9; pointer-events:none;
  transition:transform .7s cubic-bezier(.5,-.4,.7,1), opacity .7s; }
.hud-rc { display:none !important; }
body.in-menu .hud { display:none !important; }
@media (max-width:1100px) { .hud-toast { max-width:calc(100vw - 40px); top:auto; bottom:126px; } }
@media (max-width:900px) { .hud-acct { max-width:calc(100vw - 40px); bottom:74px; } }
`;

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

export interface Hud {
  /** Objective tracker (top-left). */
  readonly obj: HTMLDivElement;
  /** Wallet column (top-right): coins, bag, clock, NEAR status. */
  readonly wallet: HTMLDivElement;
  readonly prompt: HTMLDivElement;
  /** One-line contextual hint above the prompt (the controls the player needs right now). */
  readonly hint: HTMLDivElement;
  readonly tip: HTMLDivElement;
  readonly panel: HTMLDivElement;
  readonly card: HTMLDivElement;
  readonly back: HTMLDivElement;
  readonly mark: HTMLDivElement;
  readonly acct: HTMLDivElement;
  toast(text: string, good?: boolean): void;
  coins(fromX: number, fromY: number, n: number): void;
}

export function createHud(): Hud {
  const style = el("style");
  style.textContent = CSS;
  document.head.appendChild(style);
  const mk = (cls: string): HTMLDivElement => { const d = el("div", `hud ${cls}`); document.body.appendChild(d); return d; };
  const obj = mk("hud-obj"), wallet = mk("hud-wallet"), prompt = mk("hud-prompt"), hint = mk("hud-hint"), tip = mk("hud-tip"),
    panel = mk("hud-panel"), back = mk("hud-back"), card = mk("hud-card"), mark = mk("hud-mark"), acct = mk("hud-acct"), toastEl = mk("hud-toast");
  let toastTimer = 0;
  return {
    obj, wallet, prompt, hint, tip, panel, card, back, mark, acct,
    toast(text, good = false) {
      toastEl.textContent = text;
      toastEl.className = `hud hud-toast${good ? " good" : ""}`;
      toastEl.style.display = "block";
      clearTimeout(toastTimer);
      toastTimer = window.setTimeout(() => { toastEl.style.display = "none"; }, 3400);
    },
    coins(fx, fy, n) {
      const target = wallet.querySelector<HTMLElement>(".coinpill")?.getBoundingClientRect();
      const tx = target ? target.left + 18 : innerWidth - 80, ty = target ? target.top + 16 : 36;
      for (let i = 0; i < Math.min(n, 14); i++) {
        const c = el("div", "coin-fly");
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
