// Operating controls for the autonomous market: who may run a market turn, whether agents may use NEAR AI at all,
// and how many paid calls a UTC day may make. Every control fails closed: a down store, a missing secret or an unknown
// setting means no paid call, never an unlimited one.
import { timingSafeEqual } from "node:crypto";
import type { DecisionStore } from "./agent.ts";

/** players: browsers' 60 s requests drive market turns (today's production behaviour); paid AI calls never happen on
 *  them. scheduler: only the authenticated scheduler route runs turns; browser requests change nothing. */
export type Driver = "players" | "scheduler";

export interface OpsConfig {
  readonly driver: Driver;
  /** Deploy-time kill switch (NEAR_AGENTS_OFF=1): no agent decides, every price is the rule price. */
  readonly agentsOff: boolean;
  /** Shared secret a scheduler sends as `Authorization: Bearer <secret>` (Vercel Cron's convention). */
  readonly schedulerSecret: string | null;
  /** Paid calls per UTC day, all agents together: decisions (Jev), conversations (chat model), signature checks. */
  readonly dailyDecisions: number;
  readonly dailyChats: number;
  readonly dailyVerifies: number;
  /** Test-operation guard for a bounded connected playthrough (NEAR_TEST_TURNS): at most this many market turns, from
   *  any driver, for the run NEAR_TEST_RUN. null = no cap (production's normal behaviour). An unparseable value is 0:
   *  a cap that was meant to be set never turns into "unlimited". */
  readonly testTurns: number | null;
  readonly testRun: string;
}

const int = (v: string | undefined, d: number): number => {
  const s = (v ?? "").trim();
  if (!s) return d; // unset: the default (Number("") would be 0)
  const n = Number(s);
  return Number.isInteger(n) && n >= 0 ? n : d;
};

export function opsConfig(env: Record<string, string | undefined>): OpsConfig {
  return {
    driver: (env.NEAR_MARKET_DRIVER ?? "").trim() === "scheduler" ? "scheduler" : "players",
    agentsOff: ["1", "true", "on", "yes"].includes((env.NEAR_AGENTS_OFF ?? "").trim().toLowerCase()),
    schedulerSecret: (env.NEAR_SCHEDULER_SECRET ?? env.CRON_SECRET ?? "").trim() || null,
    dailyDecisions: int(env.NEAR_AI_DAILY_DECISIONS, 200),
    dailyChats: int(env.NEAR_AI_DAILY_CHATS, 300),
    dailyVerifies: int(env.NEAR_AI_DAILY_VERIFIES, 200),
    testTurns: (env.NEAR_TEST_TURNS ?? "").trim() ? int(env.NEAR_TEST_TURNS, 0) : null,
    testRun: ((env.NEAR_TEST_RUN ?? "").trim().replace(/[^a-z0-9-]/gi, "").slice(0, 40)) || "playtest",
  };
}

export const testTurnKey = (run: string): string => `vivolith:test:turns:${run}`;

/** Takes one market turn from the playtest cap. Called after the turn lock is held and before anything is read or
 *  signed. Counted in the shared store (atomic INCR, kept 7 days), so every instance and every browser share one cap;
 *  a store that cannot count refuses the turn. No cap configured: always allowed. */
export async function takeTestTurn(ops: OpsConfig, store: DecisionStore): Promise<{ readonly ok: boolean; readonly used: number | null }> {
  if (ops.testTurns === null) return { ok: true, used: null };
  if (ops.testTurns <= 0) return { ok: false, used: null };
  try {
    const used = await store.incr(testTurnKey(ops.testRun), 7 * 24 * 3600);
    return { ok: used <= ops.testTurns, used };
  } catch { return { ok: false, used: null }; }
}

/** Runtime kill switch in the shared store (set by scripts/near/agents.ts): stops every agent without a redeploy. */
export const KILL_KEY = "vivolith:agents:off";

/** True when agents must not use NEAR AI right now. A store that cannot answer counts as off. */
export async function agentsHalted(ops: OpsConfig, store: DecisionStore): Promise<boolean> {
  if (ops.agentsOff) return true;
  try { return (await store.get(KILL_KEY)) !== null; } catch { return true; }
}

/** True only for a request carrying the scheduler secret (constant-time compare; no secret configured = never). */
export function fromScheduler(ops: OpsConfig, authorization: string | null): boolean {
  if (!ops.schedulerSecret || !authorization) return false;
  const a = Buffer.from(authorization.trim()), b = Buffer.from(`Bearer ${ops.schedulerSecret}`);
  return a.length === b.length && timingSafeEqual(a, b);
}

export type Spend = "decision" | "chat" | "verify";
const limitOf = (ops: OpsConfig, kind: Spend): number => kind === "decision" ? ops.dailyDecisions : kind === "chat" ? ops.dailyChats : ops.dailyVerifies;
export const budgetKey = (kind: Spend, now: number): string => `vivolith:ai:${kind}:${new Date(now).toISOString().slice(0, 10)}`;

/** Takes one paid call from today's budget. false = over budget or the counter is unreachable (no call is made). */
export async function spend(ops: OpsConfig, store: DecisionStore, kind: Spend, now = Date.now()): Promise<boolean> {
  const limit = limitOf(ops, kind);
  if (limit <= 0) return false;
  try { return (await store.incr(budgetKey(kind, now), 2 * 24 * 3600)) <= limit; } catch { return false; }
}

/** Today's use, for the status route and the operator script (null when the store cannot answer). */
export async function usage(store: DecisionStore, now = Date.now()): Promise<Record<Spend, number> | null> {
  try {
    const read = async (k: Spend): Promise<number> => Number((await store.get(budgetKey(k, now))) ?? 0);
    return { decision: await read("decision"), chat: await read("chat"), verify: await read("verify") };
  } catch { return null; }
}
