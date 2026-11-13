// Checks that a NEAR AI decision really came from NEAR AI Cloud, using the documented response-signature protocol
// (docs.near.ai/cloud/verification/cloud-api/response-signatures): the Gateway signs
//   gateway:      "<sha256(request bytes)>:<sha256(response bytes)>"
//   provider_tee: "<model id>:<sha256(request bytes)>:<sha256(response bytes)>"
// We hash the exact bytes we sent and received, fetch the signature for the decision id (X-Generation-Id), check the
// text binds those hashes, check the ed25519 signature, and require the signer to be the key named in NEAR AI's
// attestation report. What this does NOT do: validate the Intel TDX / GPU quote inside that report. The official
// @nearai/inference-sdk does that (verifyResponse); it is not bundled here, so the strongest status this module can give
// is "signed", never "verified".
import { createHash, createPublicKey, randomBytes, verify as verifySignature } from "node:crypto";

/** none: the rule decided (no model). pending: not checked yet. signed: signature over our exact bytes from the attested
 *  Gateway key. unverified: no signature could be obtained. failed: the evidence contradicts the decision. */
export type VerifyStatus = "none" | "pending" | "signed" | "unverified" | "failed";

export interface Evidence { readonly requestHash: string; readonly responseHash: string; readonly model: string }

export const sha256hex = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

export const evidenceOf = (requestBody: string, responseText: string, model: string): Evidence => ({ requestHash: sha256hex(requestBody), responseHash: sha256hex(responseText), model });

/** Attempts before a missing signature counts as "unverified" (signatures can lag the response by a few seconds). */
export const MAX_ATTEMPTS = 3;

export interface VerifyResult { readonly status: VerifyStatus; readonly note: string; readonly signer: string | null; readonly kind: string | null }

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

const hex = (s: string): Buffer | null => { const h = s.replace(/^0x/i, ""); return /^[0-9a-f]*$/i.test(h) && h.length % 2 === 0 ? Buffer.from(h, "hex") : null; };

/** Ed25519 check of `text` (UTF-8) against a 32-byte hex public key and a 64-byte hex signature. */
export function ed25519Ok(text: string, signatureHex: string, publicKeyHex: string): boolean {
  const sig = hex(signatureHex), pk = hex(publicKeyHex);
  if (!sig || sig.length !== 64 || !pk || pk.length !== 32) return false;
  try {
    const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: pk.toString("base64url") }, format: "jwk" });
    return verifySignature(null, Buffer.from(text, "utf8"), key, sig);
  } catch { return false; }
}

/** The text the Gateway must have signed for these exact bytes, by signature kind. */
export function expectedText(kind: string, ev: Evidence): string | null {
  if (kind === "gateway") return `${ev.requestHash}:${ev.responseHash}`;
  if (kind === "provider_tee") return `${ev.model}:${ev.requestHash}:${ev.responseHash}`;
  return null; // unknown kinds are never guessed from the text's shape (docs: treat as unavailable)
}

/** Every `signing_address` in the report: only those under `gateway_attestation` for a gateway signature, any (the model
 *  reports) for a provider_tee signature, whose report was requested for that model. Field layout read defensively. */
export function attestedSigners(report: unknown, kind: "gateway" | "provider_tee" = "gateway"): string[] {
  const out: string[] = [];
  const walk = (x: unknown, underGateway: boolean): void => {
    if (!x || typeof x !== "object") return;
    for (const [k, v] of Object.entries(x as Record<string, unknown>)) {
      const g = underGateway || k === "gateway_attestation";
      if (k === "signing_address" && (g || kind === "provider_tee") && typeof v === "string") out.push(v.replace(/^0x/i, "").toLowerCase());
      else walk(v, g);
    }
  };
  walk(report, false);
  return out;
}

/** One verification attempt. Network trouble or a missing signature is "pending" (retry later), never "failed". */
export async function verifyDecision(base: string, key: string, decisionId: string, ev: Evidence, fetchImpl: Fetch, timeoutMs = 5000): Promise<VerifyResult> {
  const origin = new URL(base).origin;
  const headers = { authorization: `Bearer ${key}`, accept: "application/json" };
  const pending = (note: string): VerifyResult => ({ status: "pending", note, signer: null, kind: null });
  let sig: { text?: unknown; signature?: unknown; signing_address?: unknown; signing_algo?: unknown; signature_kind?: unknown };
  try {
    const r = await fetchImpl(`${origin}/v1/signature/${encodeURIComponent(decisionId)}?signing_algo=ed25519`, { method: "GET", headers, signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return pending(`signature not available (${r.status})`);
    sig = (await r.json()) as typeof sig;
  } catch { return pending("signature request failed"); }
  const text = typeof sig.text === "string" ? sig.text : "", s = typeof sig.signature === "string" ? sig.signature : "";
  const signer = typeof sig.signing_address === "string" ? sig.signing_address.replace(/^0x/i, "").toLowerCase() : "";
  const kind = typeof sig.signature_kind === "string" ? sig.signature_kind : null;
  if (!text || !s || !signer) return pending("signature incomplete");
  if (sig.signing_algo !== undefined && sig.signing_algo !== "ed25519") return { status: "failed", note: `unexpected signing algorithm ${String(sig.signing_algo)}`, signer, kind };
  const want = kind ? expectedText(kind, ev) : null;
  // without signature_kind, accept only an exact match with one of the two documented forms
  const matches = want !== null ? text === want : text === expectedText("gateway", ev) || text === expectedText("provider_tee", ev);
  if (!matches) return { status: "failed", note: "signed text does not match the bytes this server sent and received", signer, kind };
  if (!ed25519Ok(text, s, signer)) return { status: "failed", note: "signature does not verify", signer, kind };
  // the signer must be a key NEAR AI's attestation report names: the Gateway's, or (provider_tee) the model's
  const tee = text === expectedText("provider_tee", ev);
  try {
    const nonce = randomBytes(32).toString("hex");
    const r = await fetchImpl(`${origin}/v1/attestation/report?signing_algo=ed25519&nonce=${nonce}${tee ? `&model=${encodeURIComponent(ev.model)}` : ""}`, { method: "GET", headers, signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return pending(`attestation report not available (${r.status})`);
    if (!attestedSigners(await r.json(), tee ? "provider_tee" : "gateway").includes(signer)) return { status: "failed", note: `signer is not a ${tee ? "model" : "Gateway"} key in NEAR AI's attestation report`, signer, kind };
  } catch { return pending("attestation request failed"); }
  return { status: "signed", note: `${tee ? "Model TEE" : "Gateway"} signature over our exact request and response, from a key in NEAR AI's attestation report; the TEE quote itself is not checked here`, signer, kind };
}
