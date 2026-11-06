// Economy inspector (Tab): demo/debug view of every merchant's cash, stock and price reasoning,
// shipments, recent events, daily price history, NEAR receipts, and the fast-forward controls.
import { clockOf, type EconomyState, type MerchantId } from "../economy/state.ts";
import { lassiPrice, quote } from "../economy/pricing.ts";
import { EXPLORER_TX } from "../near/receipts.ts";

export interface Inspector {
  toggle(): void;
  isOpen(): boolean;
  update(state: EconomyState): void;
}

export interface InspectorActions {
  fastForward(days: number): void;
  reset(): void;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export function createInspector(root: HTMLElement, act: InspectorActions): Inspector {
  const panel = document.createElement("aside");
  panel.className = "inspector";
  panel.hidden = true;
  const body = document.createElement("div");
  const controls = document.createElement("div");
  controls.className = "insp-controls";
  for (const [label, fn] of [
    ["▶▶ 1 day", () => act.fastForward(1)],
    ["▶▶ 1 week", () => act.fastForward(7)],
    ["New game", () => act.reset()],
  ] as const) {
    const b = document.createElement("button");
    b.textContent = label;
    b.addEventListener("click", fn);
    controls.appendChild(b);
  }
  const header = document.createElement("div");
  header.className = "insp-header";
  header.innerHTML = `<b>Market inspector</b><span>local deterministic simulation · Tab to close</span>`;
  panel.append(header, controls, body);
  root.appendChild(panel);
  let accum = 0;

  const merchantRow = (s: EconomyState, id: MerchantId) => {
    const m = s.merchants[id];
    const goods = m.sells.map((g) => {
      const q = g === "lassi" ? lassiPrice(s) : quote(s, id, g, false);
      return `<div class="insp-good"><span>${g} × ${m.stock[g]}</span><b>${q.price} c</b><small>${esc(q.factors.map((f) => f.label).join(" · "))}</small></div>`;
    }).join("");
    return `<section class="insp-m ${m.status}"><h4>${esc(m.shop)} <em>${m.status === "open" ? "open" : "CLOSED"}</em></h4>
      <div class="insp-cash">cash ${Math.round(m.cash)} c · rent ${m.rent} c / ${m.rentEveryDays}d · rep ${s.player.rep[id]}</div>${goods}</section>`;
  };

  return {
    toggle() { panel.hidden = !panel.hidden; accum = 1; },
    isOpen: () => !panel.hidden,
    update(s) {
      if (panel.hidden) return;
      accum += 1;
      if (accum % 10 !== 1) return; // ~6 Hz refresh is plenty for a table
      const ship = s.shipments.map((x) => `${x.qty} ${x.good} → ${x.to}: <b>${x.status}</b>${x.arriveAt ? ` (${clockOf(x.arriveAt)})` : ` (auto ${clockOf(x.autoReleaseAt)})`}`).join("<br>");
      const hist = s.history.slice(-7).map((d) => `<td class="${d.pemaOpen ? "" : "closed"}">D${d.day}<br>${d.pemaMango}/${d.tomasMango}/${d.lassi}</td>`).join("");
      const receipts = s.receipts.slice(-4).reverse().map((r) =>
        r.status === "onchain" && r.txHash
          ? `<li class="onchain">✔ onchain · <a href="${EXPLORER_TX}${encodeURIComponent(r.txHash)}" target="_blank" rel="noopener noreferrer">${esc(r.txHash.slice(0, 12))}…</a> · ${esc(r.summary)}</li>`
          : `<li class="${r.status}">${r.status} · ${esc(r.summary)}${r.message ? ` · ${esc(r.message)}` : ""}</li>`).join("") || "<li>none yet</li>";
      const log = s.log.slice(-6).reverse().map((e) => `<li><time>${clockOf(e.minute)}</time> ${esc(e.text)}</li>`).join("");
      body.innerHTML = `<div class="insp-clock">${clockOf(s.minute)} · you: ${Math.floor(s.player.coins)} c</div>
        ${merchantRow(s, "pema")}${merchantRow(s, "tomas")}${merchantRow(s, "teahouse")}
        <h5>Shipments</h5><p>${ship}</p>
        <h5>Daily close · Pema mango / Tomas mango / lassi</h5><table><tr>${hist || "<td>no full day yet</td>"}</tr></table>
        <h5>Receipts</h5><ul class="insp-receipts">${receipts}</ul>
        <h5>Recent</h5><ul class="insp-log">${log}</ul>`;
    },
  };
}
