// Dialogue data model. Trees are plain data + small effect functions; the UI never needs editing
// to add characters, choices or consequences.
import type { EconomyState } from "../economy/state.ts";

export interface DialogueContext {
  readonly econ: EconomyState;
  /** Show a short HUD message. */
  toast(text: string): void;
  /** Record a deal receipt on NEAR testnet (or report honestly why it could not). */
  settle(kind: string, detail: Record<string, string | number>): void;
}

export interface Choice {
  readonly label: string;
  /** Second line under the choice: cost, consequence hint, price reasoning. */
  readonly detail?: (s: EconomyState) => string;
  readonly available?: (s: EconomyState) => boolean;
  readonly effect?: (ctx: DialogueContext) => void;
  /** Next node id, or null to end the conversation. */
  readonly next: string | null;
}

export interface DialogueNode {
  readonly speaker: string;
  readonly text: (s: EconomyState) => string;
  readonly choices?: readonly Choice[];
  /** For nodes without choices: where "Continue" goes (null ends). */
  readonly next?: string | null;
  readonly onEnter?: (ctx: DialogueContext) => void;
}

export interface Conversation {
  readonly npcId: string;
  readonly name: string;
  readonly role: string;
  readonly accent: string;
  readonly nodes: Readonly<Record<string, DialogueNode>>;
  /** Which node to open with, given the current world state. */
  readonly entry: (s: EconomyState) => string;
}
