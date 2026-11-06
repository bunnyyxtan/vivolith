// Gameplay HUD: clock, purse, current objective, toasts and receipt cards.
import { clockOf, type EconomyState, type Receipt } from "../economy/state.ts";
import { EXPLORER_TX } from "../near/receipts.ts";

export interface Hud {
  update(state: EconomyState, objective: string | null, fastForward: boolean): void;
  toast(text: string): void;
  receipt(r: Receipt): void;
  prompt(text: string | null): void;
}

export function createHud(root: HTMLElement): Hud {
  const top = document.createElement("div");
  top.className = "hud-top";
  const clock = document.createElement("div");
  clock.className = "hud-clock";
  const purse = document.createElement("div");
  purse.className = "hud-purse";
  const objective = document.createElement("div");
  objective.className = "hud-objective";
  top.append(clock, purse);
  const toasts = document.createElement("div");
  toasts.className = "hud-toasts";
  const prompt = document.createElement("div");
  prompt.className = "hud-prompt";
  prompt.hidden = true;
  root.append(top, objective, toasts, prompt);

  let lastObjective = "";
  const push = (node: HTMLElement, ms: number) => {
    toasts.appendChild(node);
    setTimeout(() => node.classList.add("out"), ms);
    setTimeout(() => node.remove(), ms + 600);
  };

  return {
    update(state, obj, ff) {
      clock.textContent = `${clockOf(state.minute)}${ff ? "  ▶▶" : ""}`;
      purse.textContent = `${Math.floor(state.player.coins)} c`;
      const text = obj ?? "";
      if (text !== lastObjective) {
        lastObjective = text;
        objective.replaceChildren();
        if (text) {
          const label = document.createElement("span");
          label.className = "hud-objective-label";
          label.textContent = "The Mango Crisis";
          const body = document.createElement("span");
          body.textContent = text;
          objective.append(label, body);
        }
        objective.hidden = !text;
      }
    },
    toast(text) {
      const t = document.createElement("div");
      t.className = "hud-toast";
      t.textContent = text;
      push(t, 3200);
    },
    receipt(r) {
      const card = document.createElement("div");
      card.className = `hud-receipt ${r.status}`;
      const title = document.createElement("div");
      title.className = "hud-receipt-title";
      title.textContent = r.status === "onchain" ? "Receipt recorded on NEAR testnet" : r.status === "local" ? "Receipt kept locally (NEAR not configured)" : "NEAR receipt failed";
      const body = document.createElement("div");
      body.textContent = r.summary;
      card.append(title, body);
      if (r.status === "onchain" && r.txHash) {
        const link = document.createElement("a");
        link.href = EXPLORER_TX + r.txHash;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = `tx ${r.txHash.slice(0, 10)}…`;
        card.append(link);
      } else if (r.message) {
        const m = document.createElement("div");
        m.className = "hud-receipt-msg";
        m.textContent = r.message;
        card.append(m);
      }
      push(card, 9000);
    },
    prompt(text) {
      prompt.hidden = !text;
      if (text) prompt.innerHTML = `<kbd>E</kbd>${text.replace(/[<>&]/g, "")}`;
    },
  };
}
