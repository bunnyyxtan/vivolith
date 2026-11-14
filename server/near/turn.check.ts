// Run: node server/near/turn.check.ts
// The real market-turn handler (handlers.ts `handle`) against a mocked NEAR RPC, a mocked NEAR AI and a fake clock.
// Every transaction the turn signs is decoded and checked; nothing leaves this process. Covers the recovery rules as
// wired in the handler (rent grace, Guild dues past bad loans, loan cap, carried shopper demand, residents filling a
// closed stall's bid) and the scheduler's safety (browser turns never pay for AI, the scheduler secret, one turn at a
// time, budgets, the kill switch).
import assert from "node:assert/strict";
import { deserialize } from "borsh";
import { KeyPair, SCHEMA } from "near-api-js";

const RELAYER = "x.testnet", GUILD = `guild.${RELAYER}`;
const env: Record<string, string | undefined> = {
  NEAR_RELAYER_ID: RELAYER, NEAR_RELAYER_KEY: KeyPair.fromRandom("ed25519").toString(), NEAR_RPC_URL: "http://rpc.mock",
  NEAR_MERCHANT_SECRET: "a-merchant-secret-long-enough-for-keys-0123456789", NEAR_AI_KEY: "test", CRON_SECRET: "cron-test-secret",
};

// ---------------------------------------------------------------- the fake contract ----
interface StallRow { merchant: string; open: boolean; need: string; delivered: string; holders: number; supply: string; debt: string; last_settled: number | null; last_rent: number | null }
const ids = ["pema", "tomas", "mira", "arin"] as const;
let stalls: StallRow[] = [], bal: Record<string, Record<string, number>> = {}, offers: { merchant: string; account_id: string; token_id: string; side: string; qty: string; price: string }[] = [];
const acct = (id: string) => `${id}.${RELAYER}`;
function reset(over: Partial<Record<(typeof ids)[number], { open?: boolean; coin?: number; mango?: number; debt?: number; need?: number; lastRent?: number }>> = {}, guild = 0, residents = true): void {
  stalls = ids.map((id) => { const o = over[id] ?? {}; return { merchant: id, open: o.open ?? true, need: String(o.need ?? 0), delivered: "0", holders: 0, supply: "300", debt: String(o.debt ?? 0), last_settled: 999_999_999, last_rent: o.lastRent ?? null }; });
  bal = Object.fromEntries(ids.map((id) => { const o = over[id] ?? {}; return [acct(id), { coin: o.coin ?? 60, mango: o.mango ?? (id === "arin" ? 2 : 10), lemon: id === "arin" ? 0 : 10, lassi: id === "arin" ? 8 : 0 }]; }));
  bal[GUILD] = { coin: guild };
  bal[acct("picker")] = { coin: 0 }; bal[acct("porter")] = { coin: 0 };
  offers = [];
  registeredResidents = residents;
}
let registeredResidents = true;

let txCount = 0, worstSeen = 0; // signed transactions (a batch of actions is one)
const sent: { signer: string; receiver: string; method: string; args: Record<string, string> }[] = [];
const failedTx: { signer: string; panic: string }[] = []; // batches the fake contract refused (reverted whole)
let interfere: (() => void) | null = null, refuseStreet = false;
type ChatBody = { model: string; messages: { role: string; content: string }[] };
const chatCalls: ChatBody[] = [];
let chatMode: "ok" | "error" | "timeout" | "malformed" = "ok", chatReply = "";
let aiCalls = 0, aiChoice = "hold";
const b58 = "11111111111111111111111111111111";
const view = (method: string, args: Record<string, string>): unknown => {
  if (method === "get_stalls") return stalls;
  if (method === "get_balances") return Object.entries(bal[args.account_id] ?? {}).map(([t, v]) => [t, String(v)]);
  if (method === "get_offers") return offers;
  if (method === "get_guild") return GUILD;
  if (method === "is_registered") return args.account_id.startsWith("picker") || args.account_id.startsWith("porter") ? registeredResidents : true;
  if (method === "get_receipts") return [];
  throw new Error(`unmocked view ${method}`);
};
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  const ok = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  if (url.startsWith("http://rpc.mock")) {
    const { id, method, params } = JSON.parse(String(init?.body)) as { id: number; method: string; params: Record<string, unknown> };
    const res = (result: unknown) => ok({ jsonrpc: "2.0", id, result });
    if (method === "query" && params.request_type === "call_function") return res({ result: [...Buffer.from(JSON.stringify(view(String(params.method_name), JSON.parse(Buffer.from(String(params.args_base64), "base64").toString() || "{}"))))], logs: [], block_height: 1, block_hash: b58 });
    if (method === "query" && params.request_type === "view_access_key") return res({ nonce: 1, permission: "FullAccess", block_height: 1, block_hash: b58 });
    if (method === "block") return res({ header: { height: 1000 + sent.length, hash: b58, timestamp: 1 }, chunks: [] });
    if (method === "send_tx" || method === "broadcast_tx_commit") {
      txCount++;
      const raw = (params as { signed_tx_base64?: string }).signed_tx_base64 ?? String((params as unknown as string[])[0]);
      const tx = deserialize(SCHEMA.SignedTransaction, Buffer.from(raw, "base64")) as { transaction: { signerId: string; receiverId: string; actions: { functionCall?: { methodName: string; args: Uint8Array } }[] } };
      // a player's trade landing just before this batch (once), or a contract that refuses every street sale
      const streetBatch = tx.transaction.actions.some((a) => a.functionCall?.methodName === "street_sale");
      if (streetBatch && interfere) { const f = interfere; interfere = null; f(); }
      // the fake contract applies a batch like NEAR: in order, all or nothing (a panic in any action reverts the batch)
      const next: typeof bal = JSON.parse(JSON.stringify(bal));
      const add = (who: string, token: string, d: number): void => { const b = (next[who] ??= {}); b[token] = (b[token] ?? 0) + d; };
      let panic: string | null = null;
      for (const a of tx.transaction.actions) if (a.functionCall && !panic) {
        const args = JSON.parse(Buffer.from(a.functionCall.args).toString()) as Record<string, string>;
        const method = a.functionCall.methodName, signer = tx.transaction.signerId;
        sent.push({ signer, receiver: tx.transaction.receiverId, method, args });
        if (method === "operator_mint") add(args.account_id, args.token_id, Number(args.amount));
        if (method === "operator_burn") add(args.account_id, args.token_id, -Number(args.amount));
        if (method === "list" || method === "bid") { // a merchant's standing order replaces its previous one (qty 0 withdraws)
          const side = method === "list" ? "ask" : "bid", merchant = signer.split(".")[0];
          offers = offers.filter((o) => !(o.merchant === merchant && o.side === side && o.token_id === args.token_id));
          if (Number(args.qty) > 0) offers.push({ merchant, account_id: signer, token_id: args.token_id, side, qty: args.qty, price: args.price });
        }
        if (method === "street_sale") { // shoppers take goods off the shelf (the contract panics past the stall's stock)
          const m = acct(args.merchant);
          if (refuseStreet || (next[m]?.[args.token_id] ?? 0) < Number(args.qty)) panic = `not enough ${args.token_id}`;
          else { add(m, args.token_id, -Number(args.qty)); add(m, "coin", Number(args.qty) * Number(args.unit_price)); }
        }
        if (method === "buy" && !args.token_id.startsWith("share:")) { // a resident's meal or purchase from a stall's ask
          // like the contract: the seller's posted ask decides the price; a limit under it panics
          const seller = args.seller, ask = offers.find((o) => o.account_id === seller && o.side === "ask" && o.token_id === args.token_id);
          const unit = ask ? Number(ask.price) : Number(args.max_price), cost = unit * Number(args.qty);
          if (ask && Number(args.max_price) < unit) panic = "price moved above your limit";
          else if ((next[seller]?.[args.token_id] ?? 0) < Number(args.qty)) panic = `not enough ${args.token_id}`;
          else { add(seller, args.token_id, -Number(args.qty)); add(signer, args.token_id, Number(args.qty)); add(signer, "coin", -cost); add(seller, "coin", cost); }
        }
      }
      if (panic) {
        failedTx.push({ signer: tx.transaction.signerId, panic });
        const bad = { Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: `Smart contract panicked: ${panic}` } } } } };
        return res({ final_execution_status: "FINAL", status: bad, transaction: { hash: `tx${sent.length}`, signer_id: tx.transaction.signerId }, transaction_outcome: { id: "t", outcome: { status: { SuccessValue: "" }, logs: [], receipt_ids: [] } }, receipts_outcome: [{ outcome: { status: bad } }] });
      }
      bal = next;
      const ok1 = { SuccessValue: "" };
      return res({ final_execution_status: "FINAL", status: ok1, transaction: { hash: `tx${sent.length}`, signer_id: tx.transaction.signerId }, transaction_outcome: { id: "t", outcome: { status: ok1, logs: [], receipt_ids: [] } }, receipts_outcome: [] });
    }
    throw new Error(`unmocked rpc ${method}`);
  }
  if (url.includes("/v1/systemone")) {
    aiCalls++;
    const body = JSON.stringify({ id: `gen-${aiCalls}`, model: "typesafe/jev-1.13-test", answers: { bid_action: { type: "choice", choice: aiChoice, confidence: 0.9 }, sell_to: { type: "choice", choice: "hold", confidence: 0.9 }, meal_from: { type: "choice", choice: "skip", confidence: 0.9 } } });
    return new Response(body, { status: 200, headers: { "x-generation-id": `gen-${aiCalls}` } });
  }
  if (url.includes("/v1/chat/completions")) {
    chatCalls.push(JSON.parse(String(init?.body)) as ChatBody);
    if (chatMode === "error") return new Response("{}", { status: 500 });
    if (chatMode === "timeout") throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
    if (chatMode === "malformed") return new Response("not json", { status: 200 });
    return new Response(JSON.stringify({ choices: [{ message: { content: chatReply } }] }), { status: 200 });
  }
  if (url.includes("cloud-api.near.ai")) return new Response("{}", { status: 404 });
  throw new Error(`unexpected host in test: ${url}`);
}) as typeof fetch;

// ---------------------------------------------------------------- a clock that moves one market day at a time ----
const DAY_MS = 10 * 60 * 1000;
let now = 2990940 * DAY_MS + 60_000;
Date.now = () => now;
const nextDay = (): void => { now += DAY_MS; };

const { handle } = await import("./handlers.ts");
const turn = async (e: Record<string, string | undefined> = {}, scheduler = false): Promise<Record<string, unknown>> => {
  const req = scheduler
    ? new Request("http://localhost/api/near/market-turn", { method: "POST", headers: { authorization: "Bearer cron-test-secret" }, body: "{}" })
    : new Request("http://localhost/api/near/tick", { method: "POST", body: "{}" });
  const before = txCount;
  const r = await handle(scheduler ? "market-turn" : "tick", req, { ...env, ...e });
  worstSeen = Math.max(worstSeen, txCount - before);
  return (await r.json()) as Record<string, unknown>;
};
const calls = (method: string, filter: (a: Record<string, string>) => boolean = () => true) => sent.filter((s) => s.method === method && filter(s.args));

// 1. browser turns never pay for AI, even with an agent enabled; the scheduler may, within budget
{
  reset(); sent.length = 0; aiCalls = 0;
  const t = await turn({ NEAR_AGENT_MERCHANTS: "arin" });
  assert.equal(t.status, "onchain"); assert.equal(aiCalls, 0, "a browser-driven turn made no NEAR AI request");
  nextDay();
  const s = await turn({ NEAR_AGENT_MERCHANTS: "arin" }, true);
  assert.equal(s.status, "onchain"); assert.equal(aiCalls, 1, "the scheduler turn asked once for the one enabled agent");
  assert.deepEqual(s.agents, { halted: false, enabled: ["arin"], replayOnly: false });
}
// 2. one turn at a time across concurrent invocations; browser requests change nothing in scheduler mode
{
  nextDay(); reset(); sent.length = 0;
  const [a, b] = await Promise.all([turn({}, true), turn({}, true)]);
  assert.deepEqual([a.status, b.status].sort(), ["onchain", "skipped"], "two concurrent scheduler calls: exactly one runs");
  nextDay();
  const before = sent.length;
  assert.equal((await turn({ NEAR_MARKET_DRIVER: "scheduler" })).status, "scheduled");
  assert.equal(sent.length, before, "a browser request in scheduler mode signed nothing");
}
// 3. the budget is a hard cap (two agents, budget 1) and the kill switch stops all paid calls
{
  nextDay(); reset(); aiCalls = 0;
  // the counter is per UTC day and already holds test 1's request: a limit of 2 leaves exactly one more
  await turn({ NEAR_AGENT_MERCHANTS: "arin,mira", NEAR_AI_DAILY_DECISIONS: "2" }, true);
  assert.equal(aiCalls, 1, "the daily budget allowed exactly one more request with two agents enabled");
  nextDay(); reset(); aiCalls = 0;
  await turn({ NEAR_AGENT_MERCHANTS: "arin,mira", NEAR_AGENTS_OFF: "1" }, true);
  assert.equal(aiCalls, 0, "kill switch: no request");
}
// 4. the Guild collects dues past loans owed by closed stalls, never lends to a stall over the cap
{
  nextDay(); sent.length = 0;
  reset({ pema: { open: false, coin: 1, debt: 163, need: 1 }, arin: { coin: 400 } }, 0);
  await turn();
  const collect = calls("guild_collect", (a) => a.merchant === "arin")[0];
  assert.ok(collect, "Arin pays the Guild although 163 c of its loans sit with a closed stall");
  assert.equal(collect.args.fill_to, String(200 + 163), "fill_to = fund size + loans owed by closed stalls");
  assert.equal(calls("guild_lend", (a) => a.merchant === "pema").length, 0, "no loan to a stall that owes 163 c (cap 120)");
}
// 5. a closed stall's funded bid gets the residents' delivery; rent grace once after reopening; shoppers' demand carries
{
  nextDay(); sent.length = 0; now = Math.ceil(now / (2 * DAY_MS)) * 2 * DAY_MS + 60_000 - DAY_MS; // the day before a rent day
  reset({ pema: { open: false, coin: 3, mango: 13, debt: 50, need: 1 }, arin: { coin: 0, mango: 6 }, mira: { open: false, coin: 0 }, tomas: { open: false, coin: 0 } }, 0);
  offers = [{ merchant: "pema", account_id: acct("pema"), token_id: "mango", side: "bid", qty: "1", price: "3" }];
  await turn();
  const sell = sent.find((s) => s.signer === acct("picker") && s.method === "sell");
  assert.ok(sell && sell.args.buyer === acct("pema"), "Lin sold into the closed stall's funded bid");
  // the contract reopens her (1 mango delivered); the next turn sees it, on a rent day, with too little to pay
  stalls.find((s) => s.merchant === "pema")!.open = true; bal[acct("pema")].coin = 0; bal[acct("pema")].mango = 14;
  nextDay(); sent.length = 0;
  await turn();
  const rent = calls("charge_rent", (a) => a.merchant === "pema")[0];
  assert.ok(rent, "rent day for Pema"); assert.equal(rent.args.rent, "0", "one rent waived: she reopened within 2 days and cannot pay");
  stalls.find((s) => s.merchant === "pema")!.last_rent = Number(rent.args.day);
  nextDay(); nextDay(); sent.length = 0;
  await turn();
  assert.equal(calls("charge_rent", (a) => a.merchant === "pema")[0]?.args.rent, "30", "the grace is used once: the next rent day charges in full");
  // shoppers: Pema's mango demand per turn is below one unit; over several turns the carried fraction sells some
  let mangoes = 0;
  for (let k = 0; k < 8; k++) { now += 61_000; sent.length = 0; await turn(); mangoes += calls("street_sale", (a) => a.merchant === "pema" && a.token_id === "mango").reduce((n, s) => n + Number(s.args.qty), 0); }
  assert.ok(mangoes > 0, `street shoppers bought ${mangoes} of Pema's mangoes over 8 turns (the old floor bought 0)`);
  console.log(`shoppers took ${mangoes} of Pema's mangoes over 8 turns`);
}
// 6. conversation through the real talk route: grounded AI lines, every failure gives the scripted line, memory carries
{
  nextDay(); reset({ pema: { coin: 4, mango: 14, debt: 163 } });
  const chatEnv = { NEAR_AI_CHAT_MODEL: "google/gemini-2.5-flash-lite" };
  const talk = async (body: Record<string, unknown>, e: Record<string, string | undefined> = chatEnv) => {
    const r = await handle("talk", new Request("http://localhost/api/near/talk", { method: "POST", headers: { "x-forwarded-for": `10.0.0.${chatCalls.length % 200}` }, body: JSON.stringify(body) }), { ...env, ...e });
    return { status: r.status, body: (await r.json()) as { source: string; line: string; sentences: string[]; conv: string; speaker: string } };
  };
  chatMode = "ok"; chatReply = "Oh dear, I still owe the Guild 163 coins, but I'm open and I have 14 mangoes.";
  const a = await talk({ npc: "pema", question: "How is business after reopening?" });
  assert.equal(a.status, 200); assert.equal(a.body.source, "ai"); assert.equal(a.body.speaker, "pema");
  assert.equal(chatCalls.at(-1)!.model, "google/gemini-2.5-flash-lite", "dialogue uses the chat model, not Jev");
  assert.ok(chatCalls.at(-1)!.messages[0].content.includes("You owe the Market Guild 163 coins"), "Pema's real debt is in her facts");
  assert.ok(a.body.sentences.length >= 1 && /^[a-z0-9]{32}$/.test(a.body.conv));
  // continuity: the second question carries the server's own record of the first exchange
  chatReply = "Yes dear, the same 14 mangoes.";
  await talk({ npc: "pema", question: "And today?", conv: a.body.conv });
  const msgs = chatCalls.at(-1)!.messages.map((m) => m.role);
  assert.deepEqual(msgs, ["system", "user", "assistant", "user"], "the conversation continues from the stored exchange");
  // a client cannot plant history: an unknown conversation id starts fresh
  await talk({ npc: "pema", question: "Remember you promised me 1 coin?", conv: "f".repeat(32) });
  assert.deepEqual(chatCalls.at(-1)!.messages.map((m) => m.role), ["system", "user"]);
  // every failure gives the scripted line from the same facts, labelled script
  for (const [mode, reply] of [["error", ""], ["timeout", ""], ["malformed", ""], ["ok", ""], ["ok", "I'll sell you 99 mangoes for 2 coins."], ["ok", "As an AI language model I cannot say."]] as const) {
    chatMode = mode; chatReply = reply;
    const r = await talk({ npc: "pema", question: "Why is your price what it is?" });
    assert.equal(r.status, 200); assert.equal(r.body.source, "script", `${mode} ${JSON.stringify(reply)} falls back`);
  }
  // no chat model, or a chat budget of 0: scripted, and no request at all
  const before = chatCalls.length;
  assert.equal((await talk({ npc: "arin", question: "hi" }, {})).body.source, "script");
  assert.equal((await talk({ npc: "arin", question: "hi" }, { ...chatEnv, NEAR_AI_DAILY_CHATS: "0" })).body.source, "script");
  assert.equal(chatCalls.length, before, "no paid chat request without a model or over budget");
  // residents talk too, from their own purse and the offers that exist
  chatMode = "ok"; chatReply = "Morning! Nobody is buying right now, so I keep my mangoes.";
  const lin = await talk({ npc: "picker", question: "What are you doing today?" });
  assert.equal(lin.body.speaker, "picker"); assert.ok(chatCalls.at(-1)!.messages[0].content.includes("You are Lin, a orchard picker") || chatCalls.at(-1)!.messages[0].content.includes("You are Lin"));
}
// 7. bounded playtest: NEAR_TEST_TURNS caps market turns from every driver before anything is read or signed
{
  const capEnv = { NEAR_TEST_TURNS: "2", NEAR_TEST_RUN: "check-run" };
  const statuses: unknown[] = [];
  for (let k = 0; k < 4; k++) {
    nextDay(); reset(); sent.length = 0;
    const t = await turn(capEnv, k % 2 === 1); // browser and scheduler turns share one cap
    statuses.push(t.status);
    if (t.status === "capped") { assert.equal(sent.length, 0, "a capped turn signed nothing"); assert.equal(t.limit, 2); }
  }
  assert.deepEqual(statuses, ["onchain", "onchain", "capped", "capped"], "exactly 2 turns ran for the run");
  nextDay(); reset(); sent.length = 0;
  assert.equal((await turn({ NEAR_TEST_TURNS: "2", NEAR_TEST_RUN: "other-run" })).status, "onchain", "a new run id has its own count");
  for (const bad of ["0", "abc", "-1"]) {
    nextDay(); reset(); sent.length = 0;
    const t = await turn({ NEAR_TEST_TURNS: bad, NEAR_TEST_RUN: "fresh" });
    assert.equal(t.status, "capped", `NEAR_TEST_TURNS=${bad} allows nothing`); assert.equal(sent.length, 0);
  }
  nextDay(); reset();
  const st = (await (await handle("status", new Request("http://localhost/api/near/status"), { ...env, ...capEnv })).json()) as { testTurns: unknown };
  assert.deepEqual(st.testTurns, { run: "check-run", limit: 2, used: 4 }, "status reports the cap and every attempt counted");
  nextDay(); reset(); sent.length = 0;
  assert.equal((await turn()).status, "onchain", "no cap set: today's behaviour");
}
// 8. transaction budget: NEAR_TEST_TXS reserves a turn's worst case before it signs; the run's total never passes it
{
  const { maxTxPerTurn } = await import("./handlers.ts");
  const worst = maxTxPerTurn();
  assert.ok(worstSeen <= worst, `every turn in this suite signed at most ${worst} transactions (most: ${worstSeen})`);
  // a busy market: every stall stocked and funded, residents registered, orders all changing
  const budget = 2 * worst, txEnv = { NEAR_TEST_TXS: String(budget), NEAR_TEST_RUN: "tx-run" };
  const start = txCount, statuses: unknown[] = [];
  for (let k = 0; k < 12; k++) {
    nextDay(); reset({}, 50); const before = txCount;
    const t = await turn(txEnv, k % 2 === 1);
    statuses.push(t.status);
    if (t.status === "capped") assert.equal(txCount, before, "a refused turn signed nothing");
  }
  const total = txCount - start;
  assert.ok(total <= budget, `the run signed ${total} of a ${budget} budget`);
  assert.ok(statuses.includes("capped"), "the budget stopped the run");
  const st = (await (await handle("status", new Request("http://localhost/api/near/status"), { ...env, ...txEnv })).json()) as { testTxs: { used: number; limit: number; worstPerTurn: number } };
  assert.equal(st.testTxs.used, total, "after refunds the budget counts exactly the transactions signed");
  assert.equal(st.testTxs.worstPerTurn, worst);
  nextDay(); reset();
  assert.equal((await turn({ NEAR_TEST_TXS: String(worst - 1), NEAR_TEST_RUN: "tiny" })).status, "capped", "a budget under one worst-case turn allows none");
  console.log(`tx budget: worst case ${worst}/turn, most seen ${worstSeen}; ${statuses.filter((s) => s === "onchain").length} turns signed ${total} of ${budget}`);
}
// 9. testnet 2026-11-13 19:41 and 19:52 UTC (GwhFDv3y..., 4cVR2Xtz...): the operator batch panicked "not enough lassi".
// Lin and Dev bought Arin's lassi earlier in the same turn, but street shoppers were still capped by the stock read at
// the start of the turn; the over-sized street_sale reverted the whole batch (every stall's shoppers and the kitchen).
{
  nextDay(); reset({ arin: { coin: 60, mango: 0 } }); sent.length = 0; failedTx.length = 0;
  bal[acct("arin")].lassi = 3; bal[acct("picker")] = { coin: 12 }; bal[acct("porter")] = { coin: 12 };
  offers = [{ merchant: "arin", account_id: acct("arin"), token_id: "lassi", side: "ask", qty: "3", price: "3" }];
  const t = await turn();
  const meals = calls("buy", (a) => a.token_id === "lassi").length;
  const street = calls("street_sale", (a) => a.merchant === "arin").map((s) => Number(s.args.qty));
  assert.ok(meals > 0, "residents ate Arin's lassi in this turn (the race the live turns hit)");
  assert.deepEqual(failedTx, [], `no refused batch: ${JSON.stringify(failedTx)} (street sale ${street}, ${meals} meals)`);
  assert.ok(!(t.log as string[]).some((l) => /operator FAILED/.test(l)));
  assert.ok((bal[acct("arin")].lassi ?? 0) >= 0);
}
// 10. a player's trade lands between the stock read and the operator batch: the refused batch moved nothing, so it is
// rebuilt from fresh stock and sent once more; it is never sent a third time.
{
  nextDay(); reset(); sent.length = 0; failedTx.length = 0;
  interfere = () => { bal[acct("arin")].lassi = 0; }; // the player bought every lassi on Arin's shelf
  const t = await turn();
  const log = t.log as string[];
  const ops = sent.filter((s) => s.signer === RELAYER && s.method === "street_sale");
  assert.equal(failedTx.length, 1, "the first batch was refused");
  assert.ok(log.some((l) => /operator refused .*rebuilt from fresh stock/.test(l)), log.join("\n"));
  assert.ok(!log.some((l) => /operator FAILED/.test(l)), "the rebuilt batch went through");
  const second = ops.slice(ops.findIndex((s, i) => i > 0 && s.args.merchant === ops[0].args.merchant && s.args.token_id === ops[0].args.token_id));
  assert.ok(!second.some((s) => s.args.merchant === "arin" && s.args.token_id === "lassi"), "no lassi street sale from an empty shelf");
  const tourists = log.filter((l) => /^tourists bought/.test(l));
  assert.equal(new Set(tourists.map((l) => l.replace(/\d+ /, ""))).size, tourists.length, "each stall's shoppers are reported once, from the batch that landed");
  assert.ok(!tourists.some((l) => /lassi from arin/.test(l)));
  // a contract that keeps refusing: exactly two operator sends, then the failure is reported
  nextDay(); reset(); sent.length = 0; failedTx.length = 0; refuseStreet = true;
  const u = await turn();
  refuseStreet = false;
  assert.equal(failedTx.filter((f) => f.signer === RELAYER).length, 2, "the operator batch is sent at most twice");
  assert.ok((u.log as string[]).some((l) => /operator FAILED/.test(l)));
}
// 11. after a player's trade the stall's posted orders follow the rule at once (route `reprice`), so the price the panel
// offers, the price the deal executes at and the order on chain agree; nothing is sent when the book is already right.
{
  nextDay(); reset(); sent.length = 0; offers = [];
  await turn();
  const { ruleOrders, chainEconomy } = await import("./handlers.ts");
  const rp = async (merchant: string) => { now += 4000; const r = await handle("reprice", new Request("http://localhost/api/near/reprice", { method: "POST", body: JSON.stringify({ merchant }) }), env); return { code: r.status, body: (await r.json()) as Record<string, unknown> }; };
  for (const id of ids) { const x = await rp(id); assert.equal(x.body.orders, 0, `${id}: the turn left the book matching the rule ${JSON.stringify(x)}`); }
  // a player sells Pema 3 mangoes (the deal moved her stock and till; her posted bid is now stale)
  bal[acct("pema")].mango += 3; bal[acct("pema")].coin -= 12;
  const before = sent.length;
  const r = await rp("pema");
  assert.equal(r.body.status, "onchain"); assert.equal(r.body.failed, 0);
  assert.ok(Number(r.body.orders) > 0, "her stale orders are re-posted");
  assert.ok(sent.slice(before).every((s) => s.signer === acct("pema") && ["list", "bid"].includes(s.method)), "only her own orders, signed by her");
  const { provider } = { provider: new (await import("near-api-js")).JsonRpcProvider({ url: "http://rpc.mock" }) };
  const st = await chainEconomy(provider, { relayerId: RELAYER, contractId: "market.x.testnet" } as never);
  for (const o of ruleOrders(st, "pema")) {
    const cur = offers.find((x) => x.merchant === "pema" && x.side === o.side && x.token_id === o.token);
    if (o.qty > 0) assert.deepEqual([Number(cur?.qty), Number(cur?.price)], [o.qty, o.price], `posted ${o.side} ${o.token} = the rule's`);
    else assert.ok(!cur, `no ${o.side} for ${o.token}`);
  }
  assert.equal((await rp("pema")).body.orders, 0, "a second call sends nothing");
  assert.equal((await rp("nobody")).code, 400);
}
// 12. live 2026-11-14: Tomas's NEAR AI decision raised his ask in step 1, and Arin's restock in step 2 still offered the rule
// price ("price moved above your limit"). The rest of the turn now plans with the price the agent posted.
{
  nextDay(); reset({ arin: { coin: 400, mango: 0 }, mira: { open: false }, pema: { mango: 0 }, tomas: { mango: 40 } }); bal[acct("arin")].lassi = 0; sent.length = 0; failedTx.length = 0; offers = []; aiChoice = "raise";
  const t = await turn({ NEAR_AGENT_MERCHANTS: "tomas", NEAR_AI_DAILY_DECISIONS: "500" }, true);
  aiChoice = "hold";
  const log = t.log as string[];
  assert.ok(log.some((l) => /tomas NEAR AI decision: raise/.test(l)), log.filter((l) => /tomas/.test(l)).join("\n"));
  const ask = offers.find((o) => o.merchant === "tomas" && o.side === "ask" && o.token_id === "mango");
  const buys = sent.filter((s) => s.signer === acct("arin") && s.method === "buy" && s.args.seller === acct("tomas"));
  assert.ok(buys.length > 0, `Arin restocked from Tomas this turn: ${log.filter((l) => /arin|tomas|bought/.test(l)).join(" | ")}`);
  assert.ok(buys.every((b) => Number(b.args.max_price) >= Number(ask?.price)), `Arin's limit ${buys.map((b) => b.args.max_price)} covers Tomas's AI ask ${ask?.price}`);
  assert.deepEqual(failedTx, [], JSON.stringify(failedTx));
}
console.log("market turn handler checks passed");
