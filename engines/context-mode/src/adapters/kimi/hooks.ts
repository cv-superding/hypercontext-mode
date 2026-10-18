/**
 * adapters/kimi/hooks — Kimi Code CLI hook definitions.
 *
 * Kimi Code CLI hooks run behind the `[[hooks]]` array-table surface in
 * `~/.kimi-code/config.toml`. 7 hook events: PreToolUse, PostToolUse,
 * PreCompact, SessionStart, SessionEnd, UserPromptSubmit, Stop.
 * Same JSON stdin/stdout wire protocol as Codex CLI.
 *
 * Known limitations (verified against upstream source):
 *   - PreToolUse: deny works; updatedInput / additionalContext / ask are
 *     silently stripped by the host runner (refs/platforms/kimi-code/...
 *     /session/hooks/runner.ts:36-39,162-178 and types.ts:28-37).
 *   - PostToolUse: updatedMCPToolOutput is parsed but not acted upon.
 */

// ─────────────────────────────────────────────────────────
// Hook type constants
// ─────────────────────────────────────────────────────────

/** Kimi Code CLI hook types — mirrors Codex CLI's events + SessionEnd. */
export const HOOK_TYPES = {
  PRE_TOOL_USE: "PreToolUse",
  POST_TOOL_USE: "PostToolUse",
  PRE_COMPACT: "PreCompact",
  SESSION_START: "SessionStart",
  SESSION_END: "SessionEnd",
  USER_PROMPT_SUBMIT: "UserPromptSubmit",
  STOP: "Stop",
} as const;

// ─────────────────────────────────────────────────────────
// Routing instructions
// ─────────────────────────────────────────────────────────

/**
 * Path to the routing instructions file for Kimi Code CLI.
 */
export const ROUTING_INSTRUCTIONS_PATH = "configs/kimi/AGENTS.md";
