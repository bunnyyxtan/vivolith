// Creates a dedicated, revocable relayer key for production (Vercel) so the owner's original key never leaves
// this machine. Adds it as a full-access key on the owner account (the relayer creates guest sub-accounts and
// calls operator methods) and appends NEAR_RELAYER_KEY to .env.local. Prints only the public key.
//   node scripts/near/relayer-key.ts
// Revoke later with: near-cli `delete-key`, or Account.deleteKey(publicKey).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Account, JsonRpcProvider, KeyPair, type KeyPairString } from "near-api-js";

const OWNER = "bunnyy-nearworld.testnet";
const ENV_FILE = path.resolve(".env.local");
const env = fs.readFileSync(ENV_FILE, "utf8");
if (/^NEAR_RELAYER_KEY=/m.test(env)) {
  console.log("NEAR_RELAYER_KEY already in .env.local; nothing to do");
  process.exit(0);
}
const ownerKey = (JSON.parse(fs.readFileSync(path.join(os.homedir(), ".near-credentials", "testnet", `${OWNER}.json`), "utf8")) as { private_key: string }).private_key;
const owner = new Account(OWNER, new JsonRpcProvider({ url: "https://rpc.testnet.fastnear.com" }), ownerKey as KeyPairString);
const key = KeyPair.fromRandom("ed25519");
const r = (await owner.addFullAccessKey(key.getPublicKey())) as { transaction?: { hash?: string } };
fs.appendFileSync(ENV_FILE, `${env.endsWith("\n") ? "" : "\n"}NEAR_RELAYER_KEY=${key.toString()}\n`);
console.log(`added relayer key ${key.getPublicKey().toString()} (tx ${r.transaction?.hash ?? "?"}); saved to .env.local`);
