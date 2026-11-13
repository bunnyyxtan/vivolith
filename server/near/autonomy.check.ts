// Run: node server/near/autonomy.check.ts   (Node 24+ strips the types natively)
// Phase 2 checks: economic memory, operating controls, replay/budget, decision evidence, signature verification,
// grounded conversation and the autonomy pass. No network, no model call, no credits, no chain.
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { initialEconomy } from "../../src/economy/state.ts";
import { RESIDENTS } from "../../src/economy/residents.ts";
import { STRATEGY, agentConfig, bandFor, decideBid, decideResident, decisionFor, decisionKey, questionsFor, stateFor, verifyStored, type BookOffer, type Decision, type DecisionStore, type FetchLike } from "./agent.ts";
import { MAX_DAYS, RECEIPT_WINDOW, memoryFacts, memoryForModel, memoryKey, readMemory, updateRows, type ChainReceipt, type MemoryRow, type Snapshot } from "./memory.ts";
import { KILL_KEY, agentsHalted, budgetKey, fromScheduler, opsConfig, spend } from "./ops.ts";
import { attestedSigners, ed25519Ok, evidenceOf, expectedText, verifyDecision, type Evidence } from "./verify.ts";
import { answer, clean, decisionFacts, factsFor, grounded, playerFacts, residentFacts, scriptFor, sentencesOf } from "./talk.ts";
import { recordMemories, verifyPass } from "./autonomy.ts";

function memStore(): DecisionStore & { down: boolean; data: Map<string, string>; sets: number } {
  const data = new Map<string, string>();
  const s = {
    down: false, data, sets: 0,
    get: async (k: string) => { if (s.down) throw new Error("down"); return data.get(k) ?? null; },
    setNx: async (k: string, v: string) => { if (s.down) throw new Error("down"); if (data.has(k)) return false; data.set(k, v); return true; },
    set: async (k: string, v: string) => { if (s.down) throw new Error("down"); s.sets++; data.set(k, v); },
    del: async (k: string) => { if (s.down) throw new Error("down"); data.delete(k); },
    incr: async (k: string) => { if (s.down) throw new Error("down"); const n = Number(data.get(k) ?? 0) + 1; data.set(k, String(n)); return n; },
  };
  return s;
}
const sha = (s: string): string => createHash("sha256").update(s).digest("hex");
const snap = (day: number, block: number, coin: number, mango: number, open = true): Snapshot => ({ day, block, coin, goods: { mango, lemon: 0, lassi: 0 }, open });
const rc = (kind: string, qty: number, price: number, counterparty: string, block_height: number): ChainReceipt => ({ kind, token_id: "mango", qty: String(qty), price: String(price), counterparty, block_height });
const PLAYER = "g0123456789abcdef.bunnyy-nearworld.testnet";

// ---------------------------------------------------------------- memory ----
{
  // a day opens, a second turn the same day changes nothing, the next day closes it from chain facts only
  let rows = updateRows([], snap(100, 1000, 30, 4), [], null);
  assert.equal(rows.length, 1); assert.equal(rows[0].outcome, null);
  const again = updateRows(rows, snap(100, 1040, 99, 9), [], null);
  assert.deepEqual(again, rows, "the day's opening snapshot never moves and no row is added");
  const dec = { action: "raise", source: "ai" as const, price: 6, basePrice: 5, txHash: "tx1", verification: "pending" };
  rows = updateRows(rows, snap(100, 1050, 31, 4), [], dec);
  assert.equal(rows.length, 1); assert.deepEqual(rows[0].decision, dec, "a later turn may attach the decision");
  const receipts = [
    rc("bought", 3, 6, "picker.bunnyy-nearworld.testnet", 1010),
    rc("sold", 2, 7, PLAYER, 1100),
    rc("bought", 9, 9, "tomas.bunnyy-nearworld.testnet", 999), // before the day: ignored
    rc("sold", 9, 9, PLAYER, 1200), // after the day closed: ignored
    rc("guild loan", 5, 5, "guild.bunnyy-nearworld.testnet", 1050), // not a trade
  ];
  rows = updateRows(rows, snap(101, 1150, 27, 5), receipts, null);
  const o = rows[0].outcome!;
  assert.equal(o.coinChange, -3); assert.equal(o.goodsChange.mango, 1); assert.equal(o.openAtEnd, true);
  assert.deepEqual(o.bought, { count: 1, qty: 3, coins: 18 }); assert.deepEqual(o.sold, { count: 1, qty: 2, coins: 14 });
  assert.equal(o.withPlayers!.count, 1, "trades with players are recognised by the game's account pattern");
  assert.equal(rows.length, 2); assert.equal(rows[1].outcome, null);

  // the contract keeps 20 receipts: a full window starting inside the day means "unknown", never a made-up zero
  const full = Array.from({ length: RECEIPT_WINDOW }, (_, k) => rc("sold", 1, 5, PLAYER, 2001 + k));
  const unknown = updateRows([{ day: 200, start: snap(200, 2000, 10, 1), decision: null, outcome: null }], snap(201, 3000, 15, 0), full, null);
  assert.equal(unknown[0].outcome!.sold, null); assert.equal(unknown[0].outcome!.coinChange, 5, "balances still give the change");

  // bounded: never more than MAX_DAYS rows, and a row from the future (clock skew) is dropped
  let many: MemoryRow[] = [];
  for (let d = 0; d < MAX_DAYS + 5; d++) many = updateRows(many, snap(500 + d, 10 * d, d, d), [], null);
  assert.equal(many.length, MAX_DAYS); assert.equal(many[0].day, 505);
  assert.ok(updateRows(many, snap(510, 1e6, 0, 0), [], null).every((r) => r.day <= 510));

  // stored values are validated on read: corrupt or forged rows never reach a prompt
  const store = memStore();
  await store.set(memoryKey("pema"), JSON.stringify([rows[0], { day: 3, start: { day: 4 } }, "x", { ...rows[1], start: { ...rows[1].start, coin: "lots" } }]), 60);
  assert.equal((await readMemory(store, "pema")).length, 1);
  await store.set(memoryKey("pema"), "not json", 60);
  assert.deepEqual(await readMemory(store, "pema"), []);

  // what the model and the merchant see: closed days only, relative wording (no raw day numbers in speech)
  const forModel = memoryForModel(rows, "mango");
  assert.equal(forModel.length, 1); assert.equal(forModel[0].till_change_coins, -3); assert.equal(forModel[0].units_bought, 3);
  const said = memoryFacts(rows, "mango");
  assert.equal(said.length, 1); assert.match(said[0], /^On the last market day you raised your price from 5 to 6 coins on your own judgement/);
  assert.ok(!said[0].includes("100"), "no market-day serial numbers in dialogue facts");
}

// ---------------------------------------------------------------- operating controls ----
{
  const def = opsConfig({});
  assert.equal(def.driver, "players"); assert.equal(def.agentsOff, false); assert.equal(def.schedulerSecret, null);
  assert.deepEqual([def.dailyDecisions, def.dailyChats, def.dailyVerifies], [200, 300, 200], "unset limits use the defaults, not 0");
  assert.equal(opsConfig({ NEAR_AI_DAILY_DECISIONS: "  " }).dailyDecisions, 200);
  assert.equal(opsConfig({ NEAR_AI_DAILY_DECISIONS: "0" }).dailyDecisions, 0, "an explicit 0 turns paid decisions off");
  assert.equal(opsConfig({ NEAR_MARKET_DRIVER: "scheduler" }).driver, "scheduler");
  assert.equal(opsConfig({ NEAR_MARKET_DRIVER: "anything" }).driver, "players", "unknown driver = today's behaviour");
  assert.equal(opsConfig({ NEAR_AI_DAILY_DECISIONS: "-4" }).dailyDecisions, 200, "invalid limits use the default");

  const store = memStore(), ops = opsConfig({ NEAR_AI_DAILY_DECISIONS: "2", NEAR_AI_DAILY_CHATS: "0" });
  const now = Date.UTC(2026, 10, 13, 12);
  assert.equal(await spend(ops, store, "decision", now), true);
  assert.equal(await spend(ops, store, "decision", now), true);
  assert.equal(await spend(ops, store, "decision", now), false, "third decision over a limit of 2");
  assert.equal(await spend(ops, store, "decision", now + 24 * 3600 * 1000), true, "a new UTC day has a new budget");
  assert.equal(budgetKey("decision", now), "vivolith:ai:decision:2026-11-13");
  assert.equal(await spend(ops, store, "chat", now), false, "a limit of 0 means none");
  store.down = true;
  assert.equal(await spend(opsConfig({}), store, "decision", now), false, "an unreachable counter makes no paid call");
  assert.equal(await agentsHalted(opsConfig({}), store), true, "an unreachable store halts agents");
  store.down = false;
  assert.equal(await agentsHalted(opsConfig({}), store), false);
  assert.equal(await agentsHalted(opsConfig({ NEAR_AGENTS_OFF: "1" }), store), true);
  await store.set(KILL_KEY, "operator", 60);
  assert.equal(await agentsHalted(opsConfig({}), store), true, "the runtime kill switch stops agents without a redeploy");

  const sec = opsConfig({ CRON_SECRET: "s3cret-value" });
  assert.equal(fromScheduler(sec, "Bearer s3cret-value"), true);
  assert.equal(fromScheduler(sec, "Bearer s3cret-valuX"), false);
  assert.equal(fromScheduler(sec, null), false);
  assert.equal(fromScheduler(opsConfig({}), "Bearer "), false, "no secret configured: nobody is the scheduler");
}

// ---------------------------------------------------------------- strategies, budget, replay, evidence ----
const cfg = agentConfig({ NEAR_AGENT_MERCHANTS: "pema,tomas,mira,arin,picker,porter", NEAR_AI_KEY: "test-key-not-real" });
const offers: BookOffer[] = [{ merchant: "tomas", token_id: "mango", side: "ask", qty: "20", price: "6" }];
const DAY = 7;
const econ = () => {
  const st = initialEconomy();
  for (const id of ["pema", "tomas", "mira", "arin"] as const) Object.assign(st.merchants[id], { status: "open" });
  Object.assign(st.merchants.pema, { cash: 30, stock: { mango: 4, lemon: 0, lassi: 0 } });
  return st;
};
let calls = 0;
const RESPONSE = JSON.stringify({ id: "resp-1", model: "typesafe/jev-1.13-20260917", answers: { bid_action: { type: "choice", choice: "raise", confidence: 0.9 } } });
const lastSent: { body: string } = { body: "" };
const withBytes: FetchLike = async (_url, init) => { calls++; lastSent.body = init.body; return { ok: true, status: 200, headers: { get: (k: string) => (k === "x-generation-id" ? "gen-dec-1" : null) }, json: async () => JSON.parse(RESPONSE), text: async () => RESPONSE }; };
const noBytes: FetchLike = async () => { calls++; return { ok: true, status: 200, headers: { get: () => "gen-dec-2" }, json: async () => JSON.parse(RESPONSE) }; };
{
  // each merchant reads the same chain through its own strategy
  const st = econ();
  const seen: Record<string, Record<string, unknown>> = {};
  for (const id of ["pema", "tomas", "mira", "arin"] as const) {
    const band = bandFor(st, id, offers);
    if (!band) continue;
    seen[id] = stateFor(st, id, offers, band, DAY, []);
    const q = questionsFor(id, band) as { bid_action: { criteria: Record<string, string> } };
    assert.ok(q.bid_action.criteria.raise.includes(STRATEGY[id].raise), `${id} weighs its own raise rule`);
  }
  assert.ok("coins_short_of_rent" in seen.pema && "rent_due_in_market_days" in seen.pema, "Pema watches the rent");
  if (seen.tomas) assert.ok("margin_per_mango_at_current_price_coins" in seen.tomas, "Tomas watches his margin");
  if (seen.mira) assert.ok("resale_spread_at_current_bid_coins" in seen.mira, "Mira watches the spread");
  if (seen.arin) assert.ok("mangoes_needed_for_kitchen" in seen.arin, "Arin watches the kitchen");
  const mem = updateRows(updateRows([], snap(DAY - 1, 1, 40, 2), [], { action: "raise", source: "ai", price: 6, basePrice: 5, txHash: "t", verification: "signed" }), snap(DAY, 9, 30, 4), [], null);
  const band = bandFor(st, "pema", offers)!;
  const withMem = stateFor(st, "pema", offers, band, DAY, mem);
  assert.equal((withMem.your_recent_days as unknown[]).length, 1, "the model sees what happened after its last choice");
  assert.ok(!JSON.stringify(withMem).includes("test-key"));

  // over budget: no model call, the rule decides, the reason is recorded
  const store = memStore(); calls = 0;
  const over = await decideBid({ store, cfg, st, id: "pema", offers, day: DAY, fetchImpl: withBytes, budget: async () => false, now: () => 1 });
  assert.equal(calls, 0); assert.equal(over.decision!.source, "fallback"); assert.match(over.decision!.fallbackReason!, /budget/);
  assert.equal(over.price, band.base);

  // replay (browser-driven turn): never asks the model; uses a scheduler's stored decision while it is inside today's band
  const s2 = memStore(); calls = 0;
  const none = await decideBid({ store: s2, cfg, st, id: "pema", offers, day: DAY, fetchImpl: withBytes, replayOnly: true });
  assert.equal(calls, 0); assert.equal(none.decision, null); assert.equal(none.price, band.base, "nothing stored: the rule price");
  const made = await decideBid({ store: s2, cfg, st, id: "pema", offers, day: DAY, fetchImpl: withBytes, now: () => 5 });
  assert.equal(calls, 1);
  const replay = await decideBid({ store: s2, cfg, st, id: "pema", offers, day: DAY, fetchImpl: withBytes, replayOnly: true });
  assert.equal(calls, 1, "replay made no second call"); assert.equal(replay.price, made.price); assert.equal(replay.decision!.at, 5);
  await s2.set(decisionKey("pema", DAY), JSON.stringify({ ...made.decision!, price: 999 }), 60);
  const stale = await decideBid({ store: s2, cfg, st, id: "pema", offers, day: DAY, fetchImpl: withBytes, replayOnly: true });
  assert.equal(stale.price, band.base, "a stored price outside today's band is not replayed");

  // evidence: the exact bytes sent and received are hashed for the signature check
  const ev = made.decision!.receipt;
  assert.equal(ev.status, "pending"); assert.equal(ev.id, "gen-dec-1");
  assert.equal(ev.evidence!.requestHash, sha(lastSent.body)); assert.equal(ev.evidence!.responseHash, sha(RESPONSE));
  assert.equal(ev.evidence!.model, "typesafe/jev-1.13-20260917", "the model the gateway reported, not the one requested");
  const s3 = memStore();
  const nob = await decideBid({ store: s3, cfg, st, id: "pema", offers, day: DAY, fetchImpl: noBytes });
  assert.equal(nob.decision!.receipt.status, "unverified", "no raw bytes: honestly unverifiable");

  // residents: budget and replay apply the same way
  const lin = RESIDENTS.find((r) => r.id === "picker")!;
  const resOffers = [{ merchant: "pema", account_id: "pema.x", token_id: "mango", side: "bid", qty: "10", price: "4" }, { merchant: "arin", account_id: "arin.x", token_id: "lassi", side: "ask", qty: "5", price: "3" }];
  calls = 0;
  const rb = await decideResident({ store: memStore(), cfg, res: lin, offers: resOffers, coin: 0, holding: 6, day: DAY, fetchImpl: withBytes, budget: async () => false });
  assert.equal(calls, 0); assert.equal(rb.decision!.source, "fallback"); assert.equal(rb.plan.sell!.merchant, "pema", "the rule plan still runs");
  const rr = await decideResident({ store: memStore(), cfg, res: lin, offers: resOffers, coin: 0, holding: 6, day: DAY, fetchImpl: withBytes, replayOnly: true });
  assert.equal(calls, 0); assert.equal(rr.decision, null); assert.equal(rr.plan.sell!.merchant, "pema");
}

// ---------------------------------------------------------------- signature verification ----
{
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pubHex = Buffer.from(publicKey.export({ format: "jwk" }).x!, "base64url").toString("hex");
  const ev: Evidence = evidenceOf('{"q":1}', '{"a":2}', "typesafe/jev-1.13-20260917");
  const signed = (text: string): string => sign(null, Buffer.from(text), privateKey).toString("hex");
  assert.equal(expectedText("gateway", ev), `${ev.requestHash}:${ev.responseHash}`);
  assert.equal(expectedText("provider_tee", ev), `typesafe/jev-1.13-20260917:${ev.requestHash}:${ev.responseHash}`);
  assert.equal(expectedText("mystery", ev), null);
  assert.equal(ed25519Ok("hi", signed("hi"), pubHex), true); assert.equal(ed25519Ok("ho", signed("hi"), pubHex), false);
  assert.deepEqual(attestedSigners({ gateway_attestation: { signing_address: `0x${pubHex.toUpperCase()}` }, model_attestations: [{ signing_address: "ab" }] }), [pubHex]);

  const server = (sig: unknown, report: unknown, sigStatus = 200) => async (url: string) => ({
    ok: (url.includes("/v1/signature/") ? sigStatus : 200) < 400, status: url.includes("/v1/signature/") ? sigStatus : 200,
    json: async () => (url.includes("/v1/signature/") ? sig : report),
  });
  const good = { text: expectedText("gateway", ev), signature: signed(expectedText("gateway", ev)!), signing_address: pubHex, signing_algo: "ed25519", signature_kind: "gateway" };
  const report = { gateway_attestation: { signing_address: pubHex } };
  const base = "https://cloud-api.near.ai/v1/systemone";
  assert.equal((await verifyDecision(base, "k", "gen-1", ev, server(good, report))).status, "signed");
  const other = evidenceOf('{"q":1}', '{"a":3}', ev.model); // the response we kept differs from what was signed
  assert.equal((await verifyDecision(base, "k", "gen-1", other, server(good, report))).status, "failed");
  assert.equal((await verifyDecision(base, "k", "gen-1", ev, server(good, { gateway_attestation: { signing_address: "00".repeat(32) } }))).status, "failed", "signer must be the attested key");
  assert.equal((await verifyDecision(base, "k", "gen-1", ev, server({ ...good, signature: signed("other") }, report))).status, "failed");
  assert.equal((await verifyDecision(base, "k", "gen-1", ev, server(null, report, 404))).status, "pending", "a missing signature is not a failure yet");
  const tee = { ...good, text: expectedText("provider_tee", ev), signature: signed(expectedText("provider_tee", ev)!), signature_kind: "provider_tee" };
  assert.equal((await verifyDecision(base, "k", "gen-1", ev, server(tee, { model_attestations: [{ signing_address: pubHex }] }))).status, "signed");
  assert.equal((await verifyDecision(base, "k", "gen-1", ev, server(tee, { model_attestations: [{ signing_address: "11".repeat(32) }] }))).status, "failed", "a model signature needs the model's attested key");

  // stored decisions: pending -> signed, or after MAX_ATTEMPTS without a signature -> unverified
  const store = memStore();
  const d = { merchant: "pema", lever: "bid:mango", kind: "price", day: DAY, source: "ai", model: ev.model, action: "raise", basePrice: 5, price: 6, confidence: 0.9, probabilities: null, choices: null, receipt: { id: "gen-1", status: "pending", note: "", evidence: ev, attempts: 0, signer: null }, justification: [], line: "", fallbackReason: null, txHash: "tx", at: 1 } as Decision;
  await store.set(decisionKey("pema", DAY), JSON.stringify(d), 60);
  const ok = await verifyStored(store, "pema", DAY, (id, e) => verifyDecision(base, "k", id, e, server(good, report)));
  assert.equal(ok!.receipt.status, "signed"); assert.equal(ok!.receipt.signer, pubHex);
  assert.equal(await verifyStored(store, "pema", DAY, async () => { throw new Error("must not be called"); }), null, "a settled decision is not checked again");
  await store.set(decisionKey("pema", DAY), JSON.stringify(d), 60);
  const missing = (id: string, e: Evidence) => verifyDecision(base, "k", id, e, server(null, report, 404));
  for (let k = 0; k < 2; k++) assert.equal((await verifyStored(store, "pema", DAY, missing))!.receipt.status, "pending");
  assert.equal((await verifyStored(store, "pema", DAY, missing))!.receipt.status, "unverified");

  // the autonomy pass spends one verification call per pending decision and stops at the budget
  await store.set(decisionKey("tomas", DAY), JSON.stringify({ ...d, merchant: "tomas", lever: "ask:mango" }), 60);
  await store.set(decisionKey("mira", DAY), JSON.stringify({ ...d, merchant: "mira" }), 60);
  let spent = 0; const log: string[] = [];
  await verifyPass(store, DAY, (id, e) => verifyDecision(base, "k", id, e, server(good, report)), async () => ++spent <= 1, log);
  assert.equal((await decisionFor(store, "tomas", DAY))!.receipt.status, "signed");
  assert.equal((await decisionFor(store, "mira", DAY))!.receipt.status, "pending", "over budget: left for a later turn");
  assert.ok(log.some((l) => /limit/.test(l)));
}

// ---------------------------------------------------------------- conversation ----
{
  const st = econ();
  const dAi = { merchant: "pema", lever: "bid:mango", kind: "price", day: DAY, source: "ai", model: "m", action: "raise", basePrice: 5, price: 6, confidence: 0.9, probabilities: null, choices: null, receipt: { id: null, status: "none", note: "" }, justification: ["4 of 12 mangoes on the shelf", "30 c in the till", "so a slightly higher price suits today"], line: "", fallbackReason: null, txHash: "tx", at: 1 } as Decision;
  assert.match(decisionFacts(dAi)[0], /raised your mango buying price from 5 to 6 coins on your own judgement, and the new order is posted/);
  assert.match(decisionFacts({ ...dAi, source: "fallback", txHash: null })[0], /by the usual rule\.$/);
  assert.ok(!decisionFacts(dAi).join(" ").includes("slightly"), "the trailing 'so ...' line is not stated as a fact");
  const mem = updateRows(updateRows([], snap(DAY - 1, 1, 40, 2), [], { action: "raise", source: "ai", price: 6, basePrice: 5, txHash: "t", verification: "signed" }), snap(DAY, 9, 30, 4), [], null);
  const player = playerFacts([{ kind: "bought", token_id: "mango", qty: "3", price: "6", counterparty: "pema.bunnyy-nearworld.testnet" }], "pema.bunnyy-nearworld.testnet");
  const f = factsFor(st, "pema", [], [], { decision: dAi, memory: mem, player });
  assert.ok(f.facts.some((x) => x.startsWith("This customer bought 3 mango from you at 6 coins")));
  assert.match(scriptFor("Will you make rent?", f.script, f.topics), /^Rent is \d+ coins/);
  assert.match(scriptFor("What happened yesterday?", f.script, f.topics), /^On the last market day I raised my price/);
  assert.match(scriptFor("Did I buy from you before?", f.script, f.topics), /^You bought 3 mango from me at 6 coins/);
  assert.match(scriptFor("Why did you change your bid today?", f.script, f.topics), /^Today I raised my mango buying price/);
  assert.equal(scriptFor("Do you like the weather?", f.script, f.topics), f.script, "anything else: the price line");
  for (const line of Object.values(f.topics)) assert.ok(grounded(line, f.facts), `scripted topic lines are grounded: ${line}`);

  const lin = RESIDENTS.find((r) => r.id === "picker")!;
  const rf = residentFacts(lin, { coin: 7, mango: 6 }, [{ merchant: "pema", token_id: "mango", side: "bid", qty: "10", price: "4" }, { merchant: "mira", token_id: "mango", side: "bid", qty: "5", price: "5" }, { merchant: "arin", token_id: "lassi", side: "ask", qty: "5", price: "3" }], { pema: "Auntie Pema", mira: "Mira Sol", arin: "Arin Okoye" });
  assert.match(rf.script, /^Mira Sol pays best today, 5 coins a mango\. Lunch is a lassi at 3\./);
  assert.ok(rf.facts[0].startsWith("You are Lin, a orchard picker") || rf.facts[0].startsWith("You are Lin"));

  // Live failure 2026-11-13: Lin held 65 mangoes, picks 6 a day, and each of three stalls bid for 1. The model said
  // "I've got six lovely mangos" and "Arin will buy them": true numbers on the wrong things. Facts now label each role
  // and the ledger check catches a count on the wrong role.
  const live = [
    { merchant: "arin", token_id: "mango", side: "bid", qty: "1", price: "6" }, { merchant: "tomas", token_id: "mango", side: "bid", qty: "1", price: "5" },
    { merchant: "mira", token_id: "mango", side: "bid", qty: "1", price: "5" }, { merchant: "arin", token_id: "lassi", side: "ask", qty: "3", price: "4" },
  ];
  const names = { arin: "Arin Okoye", tomas: "Tomas Vell", mira: "Mira Sol" };
  const lf = residentFacts(lin, { coin: 181, mango: 65 }, live, names);
  assert.ok(lf.facts.includes("What you hold right now, in total: 65 mangoes, 181 coins and 0 lassi."), "holdings labelled, from the balances given");
  assert.ok(lf.facts.some((x) => x.startsWith("Your daily work: each market day you gather 6 mangoes") && x.includes("not what you have")), "daily amount labelled apart from holdings");
  assert.ok(lf.facts.includes("Arin Okoye has an order to buy at most 1 mango from you, at 6 coins each."), "bid price and order quantity both explicit");
  assert.ok(lf.facts.includes("Together these orders take at most 3 mangoes of your 65 mangoes; nobody buys your whole stock today."));
  assert.deepEqual(lf.ledger, { held: { mango: 65, lassi: 0 }, perDay: { mango: 6 }, takes: { mango: 3 }, each: { mango: 1 } });
  const liveLine = "The morning pick was good, I've got six lovely mangos right here! Arin Okoye will buy them for six coins each, or Tomas Vell and Mira Sol will pay five.";
  assert.ok(grounded(liveLine, lf.facts), "the old check (numbers only) let the live line through");
  assert.ok(!grounded(liveLine, lf.facts, lf.ledger), "the role check rejects it");
  assert.ok(!grounded("I've got 6 mangoes.", lf.facts, lf.ledger), "daily amount said as holdings");
  assert.ok(!grounded("Arin Okoye will buy them all at 6 coins.", lf.facts, lf.ledger), "a buyer taking the whole stock");
  assert.ok(!grounded("Arin Okoye wants 3 mangoes at 6 coins each.", lf.facts, lf.ledger), "one order takes 1, not 3");
  assert.ok(!grounded("I pick 65 mangoes a day.", lf.facts, lf.ledger), "holdings said as the daily amount");
  for (const ok of [
    "I picked six mangoes this morning, and I'm carrying 65 mangoes in total.",
    "Arin Okoye pays 6 coins for 1 mango, Tomas Vell and Mira Sol pay 5.",
    "I have 65 mangoes, but each stall only takes 1 mango today.",
    "Arin Okoye pays best, 6 coins a mango.",
  ]) assert.ok(grounded(ok, lf.facts, lf.ledger), `correct roles pass: ${ok}`);
  for (const line of [lf.script, ...Object.values(lf.topics)]) assert.ok(grounded(line, lf.facts, lf.ledger), `Lin's scripted lines pass the role check: ${line}`);
  const say = (content: string): typeof fetch => (async () => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 })) as typeof fetch;
  const linBase = { ai: { key: "k", model: "fast-chat" }, id: "picker", facts: lf.facts, script: lf.script, topics: lf.topics, ledger: lf.ledger, question: "What are you carrying, and who could you sell it to?" };
  assert.equal((await answer({ ...linBase, fetchImpl: say(liveLine) })).source, "script", "the live line now falls back");
  assert.equal((await answer({ ...linBase, fetchImpl: say("I'm carrying 65 mangoes. Arin Okoye pays 6 coins for 1 mango.") })).source, "ai");
  // inventory changes: the facts and the check follow the balances, nothing is fixed at 65
  const later = residentFacts(lin, { coin: 187, mango: 70 }, live, names);
  assert.ok(later.facts.includes("What you hold right now, in total: 70 mangoes, 187 coins and 0 lassi."));
  assert.ok(!grounded("I've got 65 mangoes.", later.facts, later.ledger) && grounded("I've got 70 mangoes.", later.facts, later.ledger));
  const sold = residentFacts(lin, { coin: 197, mango: 2 }, live, names);
  assert.ok(!sold.facts.some((x) => x.startsWith("Together these orders")), "no whole-stock warning when the orders can take it all");
  assert.ok(grounded("Arin Okoye will buy them at 6 coins.", sold.facts, sold.ledger), "with 2 left and 3 wanted, 'buy them' is true");
  // Dev: lemons, the same roles
  const dev = RESIDENTS.find((r) => r.id === "porter")!;
  const df = residentFacts(dev, { coin: 12, lemon: 9 }, [{ merchant: "tomas", token_id: "lemon", side: "bid", qty: "2", price: "3" }], names);
  assert.ok(grounded("I'm carrying 9 lemons.", df.facts, df.ledger), "Dev's holdings");
  assert.ok(grounded(`I gather ${dev.perDay} lemons a day.`, df.facts, df.ledger) && !grounded(`I gather 9 lemons a day.`, [...df.facts], df.ledger), "Dev's daily amount");
  assert.ok(!grounded("Tomas Vell will take them all.", df.facts, df.ledger), "one order of 2 cannot take 9");
  // merchants: a count of goods said as held must be the shelf; Pema's and Arin's live lines still pass
  assert.deepEqual(f.ledger.held, { mango: st.merchants.pema.stock.mango, lemon: st.merchants.pema.stock.lemon, lassi: st.merchants.pema.stock.lassi });
  assert.ok(grounded(`I have ${st.merchants.pema.stock.mango} mangoes.`, f.facts, f.ledger));
  assert.ok(!grounded(`I have ${st.merchants.pema.stock.mango + 1} mangoes.`, [...f.facts, String(st.merchants.pema.stock.mango + 1)], f.ledger), "a wrong shelf count fails even when the number exists elsewhere");
  const pemaLive = "Oh, hello dear! Yes, the stall is open again. We just needed to get some fresh fruit in. As for the Guild, I still owe them 163 coins, but we'll chip away at it, don't you worry.";
  assert.ok(grounded(pemaLive, [...f.facts, "You owe the Market Guild 163 coins."], f.ledger), "Pema's live line still passes");
  const arinLive = "The market is always a bit of a dance, isn't it? I'm focusing on selling the lassi we have left, as there are only five available.";
  assert.ok(grounded(arinLive, ["On your shelves: 5 mangoes, 0 lemons, 5 lassi."], { held: { mango: 5, lemon: 0, lassi: 5 } }), "Arin's live line still passes");

  // the model only phrases: invented numbers, off-world words or a refused budget give the scripted line
  const chat = (content: string): typeof fetch => (async () => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 })) as typeof fetch;
  const base = { ai: { key: "k", model: "fast-chat" }, id: "pema", facts: f.facts, script: f.script, topics: f.topics, question: "Why so pricey?" };
  const ok = await answer({ ...base, fetchImpl: chat("**Oh dear,** my till holds 30 coins and rent worries me. 🙂") });
  assert.equal(ok.source, "ai"); assert.equal(ok.line, "Oh dear, my till holds 30 coins and rent worries me."); assert.equal(ok.sentences.length, 1);
  assert.ok(!grounded("seventeen", f.facts) && !grounded("17", f.facts), "17 is not a fact here");
  assert.equal((await answer({ ...base, fetchImpl: chat("I'll sell you 17 for a song.") })).source, "script", "a number not in the facts");
  assert.equal((await answer({ ...base, fetchImpl: chat("I'll sell you seventeen, just for you.") })).source, "script", "spelled-out numbers are numbers too");
  assert.equal((await answer({ ...base, fetchImpl: chat("My wallet on the blockchain says so.") })).source, "script", "no off-world talk");
  let hit = 0;
  const counted = (async () => { hit++; return new Response("{}"); }) as typeof fetch;
  assert.equal((await answer({ ...base, fetchImpl: counted, allowed: async () => false })).source, "script"); assert.equal(hit, 0, "no paid call over budget or when halted");
  assert.equal((await answer({ ...base, ai: { key: null, model: null }, fetchImpl: counted })).source, "script"); assert.equal(hit, 0);
  let sent: { messages: { role: string; content: string }[] } | null = null;
  const capture = (async (_u: string, init: { body: string }) => { sent = JSON.parse(init.body); return new Response(JSON.stringify({ choices: [{ message: { content: "Yes dear." } }] })); }) as unknown as typeof fetch;
  await answer({ ...base, history: [{ q: "Hello", a: "Hello dear." }], fetchImpl: capture });
  assert.deepEqual(sent!.messages.slice(1).map((m) => m.role), ["user", "assistant", "user"], "the conversation continues from the server's own history");
  assert.equal(clean('"Fine." (smiles) [laughs]'), "Fine.");
  assert.deepEqual(sentencesOf("One. Two! Three"), ["One.", "Two!", "Three"]);
}

// ---------------------------------------------------------------- the autonomy pass: memory over several turns ----
{
  const store = memStore(), log: string[] = [];
  const snaps = (day: number, block: number, coin: number) => new Map([["pema", snap(day, block, coin, 3)], ["picker", snap(day, block, 2, 6)]]);
  let reads = 0;
  const receipts = async (id: string): Promise<ChainReceipt[]> => { reads++; return id === "pema" ? [rc("bought", 6, 4, "picker.x", block1 + 1)] : [rc("sold", 6, 4, "pema.x", block1 + 1)]; };
  const block1 = 1000;
  await recordMemories(store, 50, snaps(50, block1, 20), receipts, log);
  assert.equal(reads, 0, "no receipts are read while no day needs closing");
  const writes = store.sets;
  await recordMemories(store, 50, snaps(50, block1 + 5, 99), receipts, log);
  assert.equal(store.sets, writes, "an unchanged memory is not rewritten every turn");
  await recordMemories(store, 51, snaps(51, block1 + 60, 2), receipts, log);
  const pema = await readMemory(store, "pema"), lin = await readMemory(store, "picker");
  assert.equal(pema[0].outcome!.coinChange, -18); assert.equal(pema[0].outcome!.bought!.qty, 6);
  assert.equal(lin[0].outcome!.sold!.coins, 24, "Lin's sale to Pema is the same trade seen from her side");
  store.down = true;
  await recordMemories(store, 52, snaps(52, block1 + 90, 2), receipts, log);
  assert.ok(log.some((l) => /memory not updated/.test(l)), "a down store is logged; the market turn carries on");
}

// ---------------------------------------------------------------- routes (real handlers, unreachable RPC, no keys) ----
{
  const { handle } = await import("./handlers.ts");
  const env = { NEAR_RELAYER_ID: "x.testnet", NEAR_RELAYER_KEY: "ed25519:not-a-real-key", NEAR_RPC_URL: "http://127.0.0.1:9", CRON_SECRET: "cron-secret-for-test" };
  const req = (route: string, method = "POST", headers: Record<string, string> = {}): Request => new Request(`http://localhost/api/near/${route}`, { method, headers, body: method === "POST" ? "{}" : undefined });
  const body = async (r: Response): Promise<Record<string, unknown>> => (await r.json()) as Record<string, unknown>;

  // browsers cannot move a scheduler-driven market (answered before any lock, chain read or key use)
  const sched = await handle("tick", req("tick"), { ...env, NEAR_MARKET_DRIVER: "scheduler" });
  assert.equal((await body(sched)).status, "scheduled");
  // the scheduler route needs the secret
  assert.equal((await handle("market-turn", req("market-turn", "GET"), env)).status, 401);
  assert.equal((await handle("market-turn", req("market-turn", "GET", { authorization: "Bearer wrong" }), env)).status, 401);
  assert.equal((await handle("market-turn", req("market-turn", "GET", { authorization: "Bearer cron-secret-for-test" }), { NEAR_RPC_URL: "http://127.0.0.1:9", CRON_SECRET: "cron-secret-for-test" })).status, 503, "authorised but unconfigured: nothing runs");
  // the decision board is a GET (it was unreachable behind the POST-only check before Phase 2)
  const dec = await handle("decisions", new Request("http://localhost/api/near/decisions?merchant=picker"), env);
  assert.equal(dec.status, 200); assert.deepEqual((await body(dec)).decisions, []);
  // status says who drives the market and whether agents are halted, without secrets
  const st = await body(await handle("status", new Request("http://localhost/api/near/status"), { ...env, NEAR_AGENT_MERCHANTS: "pema,ghost", NEAR_AGENTS_OFF: "1" }));
  assert.equal(st.driver, "players"); assert.deepEqual((st.agents as { enabled: string[] }).enabled, ["pema"]); assert.equal((st.agents as { halted: boolean }).halted, true);
  assert.ok(!JSON.stringify(st).includes("cron-secret") && !JSON.stringify(st).includes("not-a-real-key"));
  // talk refuses unknown speakers before any chain read
  assert.equal((await handle("talk", new Request("http://localhost/api/near/talk", { method: "POST", body: JSON.stringify({ npc: "ghost" }) }), env)).status, 400);
}

console.log("phase 2 autonomy checks passed");
