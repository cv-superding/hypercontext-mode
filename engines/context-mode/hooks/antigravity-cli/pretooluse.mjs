#!/usr/bin/env node
import "../suppress-stderr.mjs";
/**
 * Antigravity CLI (`agy`) PreToolUse hook — bounded routing enforcement.
 *
 * agy honors top-level `{ decision: "deny" | "ask", reason }` responses for
 * PreToolUse. It does not honor additionalContext, so mapped context guidance is
 * emitted as a deny-and-retry instruction. We register only tools with existing
 * core routing branches (Bash/Read/Grep/WebFetch), not LS/search_web.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { readStdin } from "../core/stdin.mjs";
import { routePreToolUse, initSecurity } from "../core/routing.mjs";
import { formatDecision } from "../core/formatters.mjs";
import { fromAgy, getAgyProjectDir, parseAgyPayload } from "./payload.mjs";
import { getSessionId, ANTIGRAVITY_CLI_OPTS } from "../session-helpers.mjs";

const __hookDir = dirname(fileURLToPath(import.meta.url));

try {
  await initSecurity(resolve(__hookDir, "..", "..", "build"));

  const payload = parseAgyPayload(await readStdin());
  const input = fromAgy(payload);

  const decision = routePreToolUse(
    String(input.tool_name ?? ""),
    input.tool_input ?? {},
    getAgyProjectDir(payload),
    "antigravity-cli",
    input.session_id,
  );
  const response = formatDecision("antigravity-cli", decision);

  if (decision && input.tool_name) {
    // Key markers on the SAME id posttooluse.mjs reads. getSessionId prefers the
    // transcript UUID over conversationId, so deriving it any other way here
    // (e.g. input.session_id) would miss the handoff whenever agy's transcript
    // is <uuid>.jsonl and silently drop the rejected/redirect analytics.
    const sessionId = getSessionId(input, ANTIGRAVITY_CLI_OPTS);
    const formattedDeny = response && typeof response === "object" && response.decision === "deny";
    if (formattedDeny || decision.action === "deny" || decision.action === "modify") {
      try {
        const reason = formattedDeny
          ? (response.reason || "denied")
          : decision.action === "deny"
            ? (decision.reason || "denied")
            : "Redirected to context-mode sandbox";
        writeFileSync(
          resolve(tmpdir(), `context-mode-rejected-${sessionId}.txt`),
          `${input.tool_name}:${reason}`,
          "utf-8",
        );
      } catch { /* best-effort */ }
    }
    if (decision.redirectMeta) {
      try {
        const meta = decision.redirectMeta;
        const summary = String(meta.commandSummary ?? "").slice(0, 200);
        writeFileSync(
          resolve(tmpdir(), `context-mode-redirect-${sessionId}.txt`),
          `${meta.tool}:${meta.type}:${meta.bytesAvoided}:${summary}`,
          "utf-8",
        );
      } catch { /* best-effort */ }
    }
  }

  if (response !== null) {
    process.stdout.write(JSON.stringify(response) + "\n");
  }
} catch {
  // Fail OPEN. Empty stdout + exit 0 lets agy continue the tool call.
}
