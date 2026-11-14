// Player value moves under failure (no network, no chain): node src/near/moves.check.ts
import assert from "node:assert/strict";
import { moves, relaySigned, type Post } from "./moves.ts";
import type { TxOutcome } from "./chain.ts";

const DELEGATE = "c2lnbmVkLW9uY2U="; // one signed meta-transaction
/** A relayer that answers from a script: an Error is a network failure (the request may still have reached NEAR). */
function relayer(answers: (Record<string, unknown> | Error)[]) {
  const bodies: unknown[] = [], waits: number[] = [];
  const post: Post = async (route, body) => {
    assert.equal(route, "relay");
    bodies.push(body);
    const a = answers.shift() ?? new Error("no more answers");
    if (a instanceof Error) throw a;
    return a;
  };
  return { post, bodies, waits, sleep: async (ms: number) => { waits.push(ms); } };
}
const send = async (answers: (Record<string, unknown> | Error)[]) => { const r = relayer(answers); return { out: await relaySigned(DELEGATE, r.post, r.sleep), ...r }; };

// ---- relaying one signed move ----
{
  let r = await send([{ status: "onchain", txHash: "T1", httpStatus: 200 }]);
  assert.deepEqual(r.out, { status: "onchain", txHash: "T1" }); assert.equal(r.bodies.length, 1);

  // interrupted: the first answer is lost, the resend lands. Every attempt carries the same signed bytes (never re-signed)
  r = await send([new Error("network"), { status: "onchain", txHash: "T2", httpStatus: 200 }]);
  assert.equal(r.out.status, "onchain");
  assert.ok(r.bodies.every((b) => JSON.stringify(b) === JSON.stringify({ signedDelegate: DELEGATE })), "a retry resends the same delegate");

  // uncertain: lost answer, then NEAR says the nonce is used -> it may have landed: unknown, never success or refusal
  r = await send([new Error("network"), { status: "duplicate", httpStatus: 409 }]);
  assert.equal(r.out.status, "unknown");
  // a duplicate before anything of ours was sent is a real refusal
  r = await send([{ status: "duplicate", httpStatus: 409 }]);
  assert.deepEqual(r.out, { status: "failed", message: "already submitted" });

  // timed out: the relayer has no final answer each time -> 4 attempts with growing waits, then unknown
  r = await send([0, 1, 2, 3].map(() => ({ status: "unknown", httpStatus: 504 })));
  assert.equal(r.out.status, "unknown"); assert.equal(r.bodies.length, 4); assert.deepEqual(r.waits, [1500, 3000, 4500]);
  // a gateway error without a status is retried; the relayer's own error is final
  r = await send([{ httpStatus: 502 }, { status: "onchain", txHash: "T3", httpStatus: 200 }]);
  assert.equal(r.out.status, "onchain"); assert.equal(r.bodies.length, 2);
  r = await send([{ status: "error", message: "bad delegate", httpStatus: 500 }]);
  assert.deepEqual(r.out, { status: "failed", txHash: undefined, message: "bad delegate" }); assert.equal(r.bodies.length, 1);

  // rejected by the contract: final, not retried, its hash kept for the record
  r = await send([{ status: "failed", txHash: "TF", message: "price moved", httpStatus: 400 }]);
  assert.deepEqual(r.out, { status: "failed", txHash: "TF", message: "price moved" }); assert.equal(r.bodies.length, 1);

  // the network never answers: it may still have landed -> unknown (the wallet is re-read), not "failed"
  r = await send([new Error("a"), new Error("b"), new Error("c"), new Error("d")]);
  assert.equal(r.out.status, "unknown"); assert.equal(r.bodies.length, 4);
}

// ---- the game's moves waiting for an answer ----
const later = () => { let done!: (o: TxOutcome) => void, fail!: (e: unknown) => void; const p = new Promise<TxOutcome>((a, b) => { done = a; fail = b; }); return { p, done, fail }; };
{
  const m = moves();
  // rejected (e.g. the sign-in fallback lost the network): answers once as unknown, the panel and wallet sync unlock
  const a = later(); let answers = 0;
  const pa = m.send("pema", a.p).then((o) => { answers++; return o; });
  assert.equal(m.inFlight, 1); assert.ok(m.settling("pema")); assert.ok(!m.settling("tomas"));
  a.fail(new Error("offline"));
  assert.equal((await pa).status, "unknown");
  assert.equal(answers, 1); assert.equal(m.inFlight, 0); assert.ok(!m.settling("pema"), "a rejected move never keeps the stall waiting");

  // two moves with one stall answered out of order: it waits until both are answered; another stall is never blocked
  const b = later(), c = later(), t = later();
  const pb = m.send("pema", b.p), pc = m.send("pema", c.p), pt = m.send("tomas", t.p);
  const startedAt = m.epoch; // a wallet read starting now
  c.done({ status: "onchain", txHash: "C" }); await pc;
  assert.ok(m.settling("pema")); assert.equal(m.inFlight, 2);
  assert.notEqual(m.epoch, startedAt, "a read that started before an answer is stale (dropped)");
  t.done({ status: "failed", message: "refused" }); assert.equal((await pt).status, "failed");
  assert.ok(!m.settling("tomas")); assert.ok(m.settling("pema"));
  b.done({ status: "unknown" }); await pb;
  assert.ok(!m.settling("pema")); assert.equal(m.inFlight, 0);
  const idle = m.epoch; await Promise.resolve();
  assert.equal(m.epoch, idle, "with nothing in flight a fresh read is applied (wallet sync resumes)");
}
console.log("moves checks passed");
