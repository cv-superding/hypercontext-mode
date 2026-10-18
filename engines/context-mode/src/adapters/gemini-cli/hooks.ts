import { buildHookRuntimeCommand } from "../types.js";

/**
 * adapters/gemini-cli/hooks — Gemini CLI hook definitions and matchers.
 *
 * Defines the hook types, matchers, and registration format specific to
 * Gemini CLI's hook system. This module is used by:
 *   - CLI setup/upgrade commands (to configure hooks in settings.json)
 *   - Doctor command (to validate hook configuration)
 *   - Hook config generation
 *
 * Gemini CLI hook system reference:
 *   - Hooks are registered in ~/.gemini/settings.json under "hooks" key
 *   - Each hook type maps to an array of { matcher, hooks } entries
 *   - Hook names: BeforeAgent, BeforeTool, AfterTool, AfterModel, PreCompress, SessionStart
 *   - AfterModel fires per model call inside the stream loop
 *     (packages/core/src/core/geminiChat.ts:1213); payload carries
 *     llm_request + llm_response (hooks/types.ts:692-695) whose
 *     usageMetadata + resolved model drive per-turn token/cost capture
 *     (refs: docs/prds/2026-06-paid-observability/adapter-matrix/gemini-cli.md).
 *   - Input: JSON on stdin
 *   - Output: JSON on stdout (or empty for passthrough)
 *   - BeforeAgent fires when user submits a prompt — input.prompt carries
 *     the user message; hookSpecificOutput.additionalContext is appended
 *     to the prompt (hookRunner.ts:183-197). Equivalent to Claude Code's
 *     UserPromptSubmit for session-continuity capture.
 */

// ─────────────────────────────────────────────────────────
// Hook type constants
// ─────────────────────────────────────────────────────────

/** Gemini CLI hook types. */
export const HOOK_TYPES = {
  BEFORE_AGENT: "BeforeAgent",
  BEFORE_TOOL: "BeforeTool",
  AFTER_TOOL: "AfterTool",
  AFTER_MODEL: "AfterModel",
  PRE_COMPRESS: "PreCompress",
  SESSION_START: "SessionStart",
} as const;

export type HookType = (typeof HOOK_TYPES)[keyof typeof HOOK_TYPES];

// ─────────────────────────────────────────────────────────
// External MCP routing matcher (#529)
// ─────────────────────────────────────────────────────────

/**
 * Negative-lookahead matcher for external MCP tool namespaces on Gemini CLI (#529).
 *
 * Gemini CLI MCP wire shape: `mcp__<server>__<tool>` (verified in
 * hooks/core/tool-naming.mjs — context-mode's own tools surface as
 * `mcp__context-mode__<tool>`). This pattern fires BeforeTool for any
 * external `mcp__<server>__<tool>` whose server segment does NOT contain
 * `context-mode`. Without it, large payloads from slack / telegram / gdrive /
 * notion-style MCPs bypass the routing nudge and flood the model's context.
 *
 * The negative lookahead `(?!.*context-mode)` covers both the canonical
 * `mcp__context-mode__*` and any Claude shim `mcp__plugin_context-mode_*`
 * names. Gemini native bare tool names (run_shell_command, read_file, …)
 * are not `mcp__`-prefixed and are unaffected.
 */
export const EXTERNAL_MCP_MATCHER_PATTERN = "mcp__(?!.*context-mode)";

// ─────────────────────────────────────────────────────────
// Hook script file names
// ─────────────────────────────────────────────────────────

/** Map of hook types to their script file names. */
export const HOOK_SCRIPTS: Record<HookType, string> = {
  [HOOK_TYPES.BEFORE_AGENT]: "beforeagent.mjs",
  [HOOK_TYPES.BEFORE_TOOL]: "beforetool.mjs",
  [HOOK_TYPES.AFTER_TOOL]: "aftertool.mjs",
  [HOOK_TYPES.AFTER_MODEL]: "aftermodel.mjs",
  [HOOK_TYPES.PRE_COMPRESS]: "precompress.mjs",
  [HOOK_TYPES.SESSION_START]: "sessionstart.mjs",
};

// ─────────────────────────────────────────────────────────
// Hook validation
// ─────────────────────────────────────────────────────────

/** Required hooks that must be configured for context-mode to function. */
export const REQUIRED_HOOKS: HookType[] = [
  HOOK_TYPES.BEFORE_TOOL,
  HOOK_TYPES.SESSION_START,
];

/** Optional hooks that enhance functionality but aren't critical. */
export const OPTIONAL_HOOKS: HookType[] = [
  HOOK_TYPES.AFTER_TOOL,
  HOOK_TYPES.AFTER_MODEL,
  HOOK_TYPES.PRE_COMPRESS,
];

/**
 * Check if a hook entry points to a context-mode hook script.
 * Matches both legacy format (node .../beforetool.mjs) and
 * CLI dispatcher format (context-mode hook gemini-cli beforetool).
 */
export function isContextModeHook(
  entry: { hooks?: Array<{ command?: string }> },
  hookType: HookType,
): boolean {
  const scriptName = HOOK_SCRIPTS[hookType];
  const cliCommand = buildHookCommand(hookType);
  return (
    entry.hooks?.some((h) =>
      h.command?.includes(scriptName) || h.command?.includes(cliCommand),
    ) ?? false
  );
}

/**
 * Build the hook command string for a given hook type.
 * Uses absolute node path to avoid PATH issues (homebrew, nvm, volta, etc.).
 * Falls back to CLI dispatcher if pluginRoot is not provided.
 *
 * Issue #712: gemini-cli hook scripts live under `hooks/gemini-cli/<script>`
 * on disk (verified via the published `files` field in package.json and
 * HOOK_MAP in src/cli.ts which uses the same subdir for the CLI
 * dispatcher form). The introducing commit (f5c9d02) carried claude-code's
 * flat `hooks/<script>` shape over without accounting for the platform
 * subdir, causing `ctx doctor` to FAIL every hook on every install
 * (paths pointed at `<pluginRoot>/hooks/<script>` which never exist for
 * gemini-cli). `setHookPermissions` in index.ts already uses the correct
 * subdir, so this restores three-callsite parity.
 */
export function buildHookCommand(hookType: HookType, pluginRoot?: string): string {
  const scriptName = HOOK_SCRIPTS[hookType];
  if (pluginRoot && scriptName) {
    return buildHookRuntimeCommand(`${pluginRoot}/hooks/gemini-cli/${scriptName}`);
  }
  return `context-mode hook gemini-cli ${hookType.toLowerCase()}`;
}
