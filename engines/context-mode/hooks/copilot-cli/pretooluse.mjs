#!/usr/bin/env node
import "../suppress-stderr.mjs";

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readStdin } from "../core/stdin.mjs";
import { routePreToolUse, initSecurity } from "../core/routing.mjs";
import { formatDecision } from "../core/formatters.mjs";
import { parseStdin, getSessionId, getInputProjectDir, COPILOT_OPTS } from "../session-helpers.mjs";

const __hookDir = dirname(fileURLToPath(import.meta.url));

try {
  await initSecurity(resolve(__hookDir, "..", "..", "build"));

  const raw = await readStdin();
  const input = parseStdin(raw);
  const tool = input.tool_name ?? input.toolName ?? "";
  const toolInput = input.tool_input ?? input.toolArgs ?? {};
  const projectDir = getInputProjectDir(input, COPILOT_OPTS);

  const decision = routePreToolUse(
    tool,
    toolInput,
    projectDir,
    "copilot-cli",
    getSessionId(input, COPILOT_OPTS),
  );
  const response = formatDecision("copilot-cli", decision);
  if (response !== null) {
    process.stdout.write(JSON.stringify(response) + "\n");
  }
} catch {
  // Fail OPEN. A throw here (better-sqlite3 ABI skew, a routing exception, a
  // malformed-stdin parse error) must NOT exit non-zero with empty stdout:
  // GitHub Copilot CLI 1.0.59 treats a failed PreToolUse hook as "Denied by
  // preToolUse hook (hook errored)" and blocks EVERY tool, bricking the agent.
  // A legitimate veto is a normal stdout write + normal return (never a throw),
  // so it is unaffected by this catch. Empty stdout + exit 0 => host ALLOWS the
  // tool; context-mode routing is skipped for this one call, agent keeps working.
}
