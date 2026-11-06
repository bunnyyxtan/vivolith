// Dev-server relay for NEAR testnet receipts. Runs in Node inside Vite; the private key never reaches
// the browser bundle, the console or git.
//
// Configure (testnet only):  .env.local  ->  NEAR_ACCOUNT_ID=yourname.testnet
//   key from NEAR_PRIVATE_KEY=ed25519:...  or from near-cli-rs legacy keychain
//   ~/.near-credentials/testnet/<account>.json
// Receipts are written with add_message to a public, verified testnet guestbook contract
// (NEAR_RECEIPT_CONTRACT, default guestbook.near-examples.testnet) until our own NEP-245 contract ships.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, actions, nearToYocto, teraToGas, type KeyPairString } from "near-api-js";

interface RelayConfig {
  accountId: string;
  key: KeyPairString | null;
  keySource: string;
  contractId: string;
  rpcUrl: string;
}

const KIND = /^[a-z0-9-]{3,32}$/;
const MIN_INTERVAL_MS = 3000;

function readConfig(env: Record<string, string>): RelayConfig {
  const accountId = (env.NEAR_ACCOUNT_ID ?? "").trim();
  let key = (env.NEAR_PRIVATE_KEY ?? "").trim() as KeyPairString;
  let keySource = key ? "NEAR_PRIVATE_KEY" : "none";
  if (!key && accountId) {
    const file = path.join(os.homedir(), ".near-credentials", "testnet", `${accountId}.json`);
    try {
      const cred = JSON.parse(fs.readFileSync(file, "utf8")) as { private_key?: string };
      if (cred.private_key) {
        key = cred.private_key as KeyPairString;
        keySource = "~/.near-credentials/testnet";
      }
    } catch {
      /* no legacy keychain file */
    }
  }
  return {
    accountId,
    key: key || null,
    keySource,
    contractId: (env.NEAR_RECEIPT_CONTRACT ?? "guestbook.near-examples.testnet").trim(),
    rpcUrl: (env.NEAR_RPC_URL ?? "https://rpc.testnet.near.org").trim(),
  };
}

const configured = (c: RelayConfig): boolean => Boolean(c.accountId.endsWith(".testnet") && c.key && c.contractId.endsWith(".testnet"));

function send(res: ServerResponse, code: number, body: unknown): void {
  res.statusCode = code;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c: Buffer) => {
      raw += c.toString();
      if (raw.length > 4096) reject(new Error("body too large"));
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(raw || "{}"));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

export function nearRelay(env: Record<string, string>): Plugin {
  const cfg = readConfig(env);
  let account: Account | null = null;
  let last = 0;
  const getAccount = (): Account => {
    if (!account) {
      const provider = new JsonRpcProvider({ url: cfg.rpcUrl });
      account = new Account(cfg.accountId, provider, new KeyPairSigner(KeyPair.fromString(cfg.key!)));
    }
    return account;
  };

  return {
    name: "near-world-relay",
    configureServer(server) {
      server.middlewares.use("/api/near/status", (_req, res) => {
        send(res, 200, {
          configured: configured(cfg),
          network: "testnet",
          accountId: cfg.accountId || null,
          contractId: cfg.contractId,
          keySource: cfg.keySource,
        });
      });
      server.middlewares.use("/api/near/receipt", async (req, res) => {
        if (req.method !== "POST") return send(res, 405, { status: "error", message: "POST only" });
        if (!configured(cfg)) {
          return send(res, 503, { status: "unconfigured", message: "No NEAR testnet account configured (see README: NEAR setup)." });
        }
        const now = Date.now();
        if (now - last < MIN_INTERVAL_MS) return send(res, 429, { status: "error", message: "Too many receipts, slow down." });
        try {
          const body = (await readBody(req)) as { kind?: unknown; summary?: unknown };
          const kind = typeof body.kind === "string" ? body.kind : "";
          const summary = typeof body.summary === "string" ? body.summary.replace(/[^\x20-\x7E]/g, "").slice(0, 140) : "";
          if (!KIND.test(kind) || summary.length < 3) return send(res, 400, { status: "error", message: "Invalid receipt." });
          last = now;
          const text = `NEARWorld|${kind}|${summary}`;
          const outcome = await getAccount().signAndSendTransaction({
            receiverId: cfg.contractId,
            actions: [actions.functionCall("add_message", { text }, teraToGas("30"), nearToYocto("0"))],
          });
          const o = outcome as unknown as { transaction?: { hash?: string }; transaction_outcome?: { id?: string } };
          const txHash = o.transaction?.hash ?? o.transaction_outcome?.id ?? null;
          send(res, 200, { status: "onchain", txHash, accountId: cfg.accountId, contractId: cfg.contractId, text });
        } catch (e) {
          const message = e instanceof Error ? e.message.split("\n")[0].slice(0, 200) : "Unknown error";
          send(res, 502, { status: "failed", message });
        }
      });
    },
  };
}
