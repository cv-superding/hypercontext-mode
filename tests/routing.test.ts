import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { REPO_ROOT } from "@hypercontext/core";

type Decision = {
  action?: string;
  reason?: string;
  additionalContext?: string;
  updatedInput?: unknown;
} | null;

const routing = (await import(
  pathToFileURL(join(REPO_ROOT, "engines", "context-mode", "hooks", "core", "routing.mjs")).href
)) as {
  routePreToolUse: (
    toolName: string,
    toolInput: Record<string, unknown>,
    projectDir: string,
    platform: string,
    sessionId: string,
    options?: Record<string, unknown>,
  ) => Decision;
  resetGuidanceThrottle: (sessionId?: string) => void;
};

function routeUnderMode(mode: string, sessionId: string): Decision {
  const previous = process.env.HYPERCONTEXT_ROUTING_MODE;
  process.env.HYPERCONTEXT_ROUTING_MODE = mode;
  try {
    routing.resetGuidanceThrottle(sessionId);
    return routing.routePreToolUse(
      "WebFetch",
      { url: "https://example.com/page" },
      process.cwd(),
      "claude-code",
      sessionId,
      {},
    );
  } finally {
    if (previous === undefined) delete process.env.HYPERCONTEXT_ROUTING_MODE;
    else process.env.HYPERCONTEXT_ROUTING_MODE = previous;
  }
}

test("balanced routing allows WebFetch with one-time guidance", () => {
  const decision = routeUnderMode("balanced", "hctx-test-balanced");
  assert.ok(decision);
  assert.equal(decision?.action, "context");
  assert.match(decision?.additionalContext ?? "", /WebFetch is allowed/);
});

test("advisory routing lets WebFetch pass through untouched", () => {
  const decision = routeUnderMode("advisory", "hctx-test-advisory");
  assert.equal(decision, null);
});
