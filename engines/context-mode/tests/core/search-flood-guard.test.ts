/**
 * Issue #769: ctx_search flood-guard counter is shared across concurrent
 * subagents.
 *
 * The progressive throttle (introduced in 103b41dd, hardened in #697/#698)
 * keeps a single module-global counter on the per-session MCP server
 * process. In a parallel multi-agent fan-out (Claude Code Task/Workflow),
 * N subagents share that ONE process, so their independent search calls are
 * summed into a single budget. The guard — designed to stop ONE actor
 * spamming individual searches (#79/#155) — then misclassifies legitimate
 * parallel fan-out as flooding and hard-blocks subagents collectively.
 *
 * Fix: bucket the counter per agent-context key (the per-call session/agent
 * id) so each actor gets its own rolling window, WITHOUT removing the
 * single-actor flood protection.
 *
 * These tests pin the extracted pure flood-guard (src/search/flood-guard.ts)
 * so the policy is testable without spinning up the MCP transport.
 */

import { describe, test, expect } from "vitest";
import { FloodGuard } from "../../src/search/flood-guard.js";

const CFG = { windowMs: 60_000, softCapAfter: 3, blockAfter: 8 };

describe("Issue #769: flood-guard is per-agent-context, not machine-global", () => {
  test("single actor: blocks after blockAfter calls in the window (protection preserved)", () => {
    const guard = new FloodGuard(CFG);
    const now = 1_000;
    const agent = "agent-solo";

    // 8 calls allowed (count 1..8 <= blockAfter), 9th blocked.
    for (let i = 1; i <= CFG.blockAfter; i++) {
      const d = guard.record(agent, now + i);
      expect(d.blocked).toBe(false);
      expect(d.count).toBe(i);
    }
    const ninth = guard.record(agent, now + 9);
    expect(ninth.blocked).toBe(true);
    expect(ninth.count).toBe(CFG.blockAfter + 1);
  });

  test("RED→GREEN: concurrent subagents each get their OWN budget — fan-out is not collectively starved", () => {
    const guard = new FloodGuard(CFG);
    const now = 1_000;

    // 10 distinct subagents, each makes 2 search calls inside the SAME 16s
    // window (the issue's exact "10 agents x 2 calls" scenario). Aggregate
    // is 20 calls — well over the global budget of 8 — but NO agent should
    // be blocked, because each has its own rolling counter.
    let anyBlocked = false;
    for (let call = 1; call <= 2; call++) {
      for (let a = 0; a < 10; a++) {
        const d = guard.record(`subagent-${a}`, now + call * 1000);
        if (d.blocked) anyBlocked = true;
        // Per-agent count must reflect only that agent's own calls.
        expect(d.count).toBe(call);
      }
    }
    expect(anyBlocked).toBe(false);
  });

  test("one greedy actor does not consume another actor's budget", () => {
    const guard = new FloodGuard(CFG);
    const now = 1_000;

    // Greedy agent floods to its hard block.
    for (let i = 1; i <= CFG.blockAfter + 1; i++) {
      guard.record("greedy", now + i);
    }
    const greedy = guard.record("greedy", now + CFG.blockAfter + 2);
    expect(greedy.blocked).toBe(true);

    // A different agent, first call, must be untouched and unblocked.
    const fresh = guard.record("innocent", now + CFG.blockAfter + 3);
    expect(fresh.blocked).toBe(false);
    expect(fresh.count).toBe(1);
  });

  test("rolling window resets per agent after windowMs elapses", () => {
    const guard = new FloodGuard(CFG);
    const agent = "agent-x";

    guard.record(agent, 1_000);
    guard.record(agent, 2_000);
    // Jump beyond the window — counter resets for this agent.
    const afterReset = guard.record(agent, 1_000 + CFG.windowMs + 1);
    expect(afterReset.count).toBe(1);
    expect(afterReset.blocked).toBe(false);
  });

  test("soft cap: effective per-query limit tapers after softCapAfter calls (1 actor)", () => {
    const guard = new FloodGuard(CFG);
    const agent = "agent-y";
    const now = 1_000;

    // calls 1..3 are at/under soft cap → not soft-capped
    for (let i = 1; i <= CFG.softCapAfter; i++) {
      const d = guard.record(agent, now + i);
      expect(d.softCapped).toBe(false);
    }
    // call 4 exceeds soft cap → soft-capped (server trims to 1 result/query)
    const fourth = guard.record(agent, now + CFG.softCapAfter + 1);
    expect(fourth.softCapped).toBe(true);
  });
});
