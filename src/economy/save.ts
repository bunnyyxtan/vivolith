// Save/load of the economy + quest state (localStorage). Corrupt or old saves fall back to a new game.
import { initialEconomy, type EconomyState } from "./state.ts";

const KEY = "nearworld.save.v1"; // pre-rename key, kept so existing saves still load

export function loadGame(): { state: EconomyState; restored: boolean } {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as EconomyState;
      if (parsed && parsed.version === 1 && parsed.merchants?.pema) {
        parsed.receipts ??= []; // saves from before receipts existed
        return { state: parsed, restored: true };
      }
    }
  } catch {
    /* storage blocked or corrupt save: start fresh */
  }
  return { state: initialEconomy(), restored: false };
}

export function saveGame(state: EconomyState): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

export function clearSave(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nothing to clear */
  }
}
