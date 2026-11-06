// Client side of NEAR receipts. Talks only to our dev relay (/api/near/*); never holds keys.
// A receipt is marked "onchain" only when the relay returns a real testnet transaction hash.
import type { EconomyState, Receipt } from "../economy/state.ts";

export const EXPLORER_TX = "https://testnet.nearblocks.io/txns/";

export interface NearStatus {
  readonly configured: boolean;
  readonly accountId: string | null;
  readonly contractId: string;
}

export async function nearStatus(): Promise<NearStatus> {
  try {
    const r = await fetch("/api/near/status");
    if (!r.ok) throw new Error(String(r.status));
    return (await r.json()) as NearStatus;
  } catch {
    return { configured: false, accountId: null, contractId: "unavailable (static build: no relay)" };
  }
}

/** Creates a receipt in the save, then tries to settle it on testnet. Resolves with the final receipt. */
export async function settleReceipt(state: EconomyState, kind: string, summary: string): Promise<Receipt> {
  const receipt: Receipt = { id: `${kind}-${state.minute}`, kind, minute: state.minute, summary, status: "pending" };
  state.receipts.push(receipt);
  try {
    const r = await fetch("/api/near/receipt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind, summary }),
    });
    const body = (await r.json()) as { status: string; txHash?: string; accountId?: string; contractId?: string; message?: string };
    if (body.status === "onchain" && body.txHash) {
      Object.assign(receipt, { status: "onchain", txHash: body.txHash, accountId: body.accountId, contractId: body.contractId });
    } else {
      Object.assign(receipt, { status: body.status === "unconfigured" ? "local" : "failed", message: body.message });
    }
  } catch (e) {
    Object.assign(receipt, { status: "local", message: e instanceof Error ? e.message : "relay unreachable" });
  }
  return receipt;
}
