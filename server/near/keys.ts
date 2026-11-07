// Server-side key material for scripts and the relayer. Never logs or returns secrets.
import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { baseEncode, KeyPair, type KeyPairString } from "near-api-js";

export const MERCHANTS = ["pema", "tomas", "mira", "arin"] as const;
export type MerchantId = (typeof MERCHANTS)[number];

const PKCS8_ED25519 = Buffer.from("302e020100300506032b657004220420", "hex");

/** Deterministic ed25519 key pair from a 32-byte seed (NEAR extended secret = seed || public key). */
export function keyPairFromSeed(seed: Buffer): KeyPair {
  const priv = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, seed]), format: "der", type: "pkcs8" });
  const pub = Buffer.from(createPublicKey(priv).export({ format: "jwk" }).x as string, "base64url");
  return KeyPair.fromString(`ed25519:${baseEncode(Buffer.concat([seed, pub]))}` as KeyPairString);
}

/** A merchant's function-call key, derived from NEAR_MERCHANT_SECRET so only one secret lives in env. */
export function merchantKey(id: MerchantId, secret: string): KeyPair {
  if (secret.length < 32) throw new Error("NEAR_MERCHANT_SECRET too short");
  return keyPairFromSeed(createHash("sha256").update(`vivolith-merchant:${id}:${secret}`).digest());
}
