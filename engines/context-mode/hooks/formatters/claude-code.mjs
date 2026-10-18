/**
 * Claude Code formatter — converts routing decisions into Claude Code hook output format.
 *
 * Claude Code expects:
 *   { hookSpecificOutput: { hookEventName, permissionDecision?, reason?, updatedInput?, additionalContext? } }
 *
 * Decision shape from routing.mjs:
 *   - { action: "deny", reason: string }
 *   - { action: "ask" }
 *   - { action: "modify", updatedInput: object }
 *   - { action: "context", additionalContext: string }
 *   - null (passthrough)
 *
 * @param {object | null} decision - Normalized decision from routePreToolUse
 * @returns {object | null} Claude Code hook response, or null for passthrough
 */

// In `claude --print` (headless) the CLI has no TTY to surface an "ask" prompt,
// so the agent stalls forever. Launchers running headless set CLAUDE_CODE_HEADLESS=1;
// when set, we mirror gemini-cli.mjs and passthrough on ask instead of blocking.
//
// We also passthrough on `deny` and `modify` in headless mode — context-mode's
// purpose is to nudge the agent toward `ctx_*` tools to save context. In a TTY
// session that nudge is useful: the agent reconsiders or asks the user. In
// headless `--print` mode the agent has no UI to reconsider; a `deny` aborts
// the run with no path forward, and `modify` silently swaps a curl for an
// `echo "use ctx_execute"` line that produces zero stdout — which is exactly
// what blocked the homelab daily explorer agent (Loki/Prom curl turned into
// empty echoes, all data-fetch steps reported BLOCKED). In headless launchers,
// the operator has already accepted the context-budget tradeoff by running
// raw tools; let those tools through.
const isHeadless = () => process.env.CLAUDE_CODE_HEADLESS === "1";

export function formatDecision(decision) {
  if (!decision) return null;

  switch (decision.action) {
    case "deny":
      if (isHeadless()) return null;
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          reason: decision.reason ?? "Blocked by context-mode",
        },
      };

    case "ask":
      if (isHeadless()) return null;
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "ask",
        },
      };

    case "modify": {
      if (isHeadless()) return null;

      // Tool-aware modify handling:
      //
      // - Bash redirect (updatedInput.command): CC v2.1.x ignores
      //   `updatedInput.command` substitution under `permissionDecision: "allow"`
      //   — original command runs unchanged. Verified via /diagnose Phase 4
      //   forced-deny probe: only `permissionDecision: "deny"` is honored for
      //   Bash blocking. Emit deny + extract echo payload into
      //   `permissionDecisionReason`.
      //
      // - Agent prompt injection (updatedInput.prompt): CC honors allow+updatedInput
      //   for the Agent tool — the modified prompt actually reaches the subagent.
      //   Keep the original modify shape so subagent routing-block injection works.
      //
      // - Any other shape: pass through as modify (no command, no prompt — let
      //   CC decide if the field is honored).
      const ui = decision.updatedInput ?? {};
      const isBashCommandRedirect = "command" in ui;
      if (!isBashCommandRedirect) {
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            updatedInput: ui,
          },
        };
      }
      // routing.mjs wraps the redirect guidance in `echo "..."` form.
      // Extract the quoted payload as the deny reason. Fall back to a generic
      // ADR-0003 CASE A message if the shape doesn't match.
      const cmd = ui.command ?? "";
      const m = cmd.match(/^echo\s+"(.+)"$/s);
      const reason = m
        ? m[1]
        : "Redirected to ctx_execute / ctx_fetch_and_index. Call ctx_execute(language, code) to fetch and derive your answer in one round trip, or call ctx_fetch_and_index(url, source) when you want to query the response later via ctx_search. Both have full network access. Retry the same call on a transient DNS error (EAI_AGAIN, ETIMEDOUT, ENETUNREACH).";
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: reason,
        },
      };
    }

    case "context":
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          additionalContext: decision.additionalContext ?? "",
        },
      };

    default:
      return null;
  }
}
