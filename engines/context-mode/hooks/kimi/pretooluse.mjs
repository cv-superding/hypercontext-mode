#!/usr/bin/env node
import "./platform.mjs";
import "../suppress-stderr.mjs";
/**
 * Kimi Code CLI preToolUse hook for context-mode.
 *
 * Kimi Code PreToolUse supports:
 *   - Exit code 0 with JSON:
 *     { hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "..." } }
 *     → block the tool call
 *   - Exit code 2 → block (stderr used as reason)
 *
 * Like Codex, Kimi Code only acts on `permissionDecision === "deny"` —
 * `ask` / `allow + updatedInput` / `additionalContext` are explicitly stripped
 * by the host's runner (refs/platforms/kimi-code/.../session/hooks/runner.ts:
 * 36-39,162-178) and its HookResult type has no additionalContext field
 * (types.ts:28-37). The central formatter at hooks/core/formatters.mjs
 * therefore returns null for those branches; see the codex precedent at #225
 * (commit 607dc70).
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readStdin, parseStdin, getInputProjectDir, getSessionId, KIMI_OPTS } from "../session-helpers.mjs";
import { routePreToolUse, initSecurity } from "../core/routing.mjs";
import { formatDecision } from "../core/formatters.mjs";

const __hookDir = dirname(fileURLToPath(import.meta.url));
await initSecurity(resolve(__hookDir, "..", "..", "build"));

const raw = await readStdin();
const input = parseStdin(raw);
const tool = input.tool_name ?? "";
const toolInput = input.tool_input ?? {};
const projectDir = getInputProjectDir(input, KIMI_OPTS);

const decision = routePreToolUse(tool, toolInput, projectDir, "kimi", getSessionId(input, KIMI_OPTS));
const response = formatDecision("kimi", decision);
const output = response ?? {
  hookSpecificOutput: { hookEventName: "PreToolUse" },
};
process.stdout.write(JSON.stringify(output) + "\n");
