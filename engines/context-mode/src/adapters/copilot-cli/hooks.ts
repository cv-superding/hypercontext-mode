/**
 * adapters/copilot-cli/hooks — GitHub Copilot CLI hook definitions.
 *
 * GitHub Copilot CLI's native hook events are the camelCase names
 * preToolUse / postToolUse / sessionStart / userPromptSubmitted / agentStop /
 * preCompact. Per the copilot-cli changelog, PascalCase event names are ALSO
 * accepted and fire — the CLI loads hook configs across VS Code, Claude Code,
 * and the CLI by accepting PascalCase event names alongside camelCase
 * (copilot-cli changelog.md:1065; see also :811 and :1081). We register the
 * camelCase KEYS below because they are the CLI's native names, not because
 * PascalCase would fail. The CLI dispatch token (the `.mjs` script base, e.g.
 * `pretooluse`) is independent and stays lowercase via buildHookCommand, so
 * changing the event casing does not change the dispatcher.
 */

export const HOOK_TYPES = {
  PRE_TOOL_USE: "preToolUse",
  POST_TOOL_USE: "postToolUse",
  PRE_COMPACT: "preCompact",
  SESSION_START: "sessionStart",
  // Copilot CLI 1.0.60 fires userPromptSubmitted + agentStop (verified against
  // the @github/copilot binary). Used for user-prompt + session-end capture,
  // same as the codex/kimi adapters.
  USER_PROMPT_SUBMIT: "userPromptSubmitted",
  STOP: "agentStop",
} as const;

export type HookType = (typeof HOOK_TYPES)[keyof typeof HOOK_TYPES];

export const HOOK_SCRIPTS: Record<string, string> = {
  [HOOK_TYPES.PRE_TOOL_USE]: "pretooluse.mjs",
  [HOOK_TYPES.POST_TOOL_USE]: "posttooluse.mjs",
  [HOOK_TYPES.PRE_COMPACT]: "precompact.mjs",
  [HOOK_TYPES.SESSION_START]: "sessionstart.mjs",
  [HOOK_TYPES.USER_PROMPT_SUBMIT]: "userpromptsubmit.mjs",
  [HOOK_TYPES.STOP]: "stop.mjs",
};

export const REQUIRED_HOOKS: HookType[] = [
  HOOK_TYPES.PRE_TOOL_USE,
  HOOK_TYPES.SESSION_START,
];

export const OPTIONAL_HOOKS: HookType[] = [
  HOOK_TYPES.POST_TOOL_USE,
  HOOK_TYPES.PRE_COMPACT,
  HOOK_TYPES.USER_PROMPT_SUBMIT,
  HOOK_TYPES.STOP,
];

export function isContextModeHook(
  entry: { command?: string; hooks?: Array<{ command?: string }> },
  hookType: HookType,
): boolean {
  const scriptName = HOOK_SCRIPTS[hookType];
  if (!scriptName) return false;
  const cliCommand = buildHookCommand(hookType);
  if (entry.command?.includes(cliCommand) || entry.command?.includes(scriptName)) {
    return true;
  }
  return (
    entry.hooks?.some((h) =>
      h.command?.includes(scriptName) || h.command?.includes(cliCommand),
    ) ?? false
  );
}

export function buildHookCommand(hookType: HookType, _pluginRoot?: string): string {
  const scriptName = HOOK_SCRIPTS[hookType];
  if (!scriptName) {
    throw new Error(`No script defined for hook type: ${hookType}`);
  }
  // The CLI dispatch token is the script base (pretooluse, posttooluse, …), NOT
  // the camelCase host event name — keep them decoupled so the event KEY stays
  // Copilot's camelCase while the dispatcher token (and the cli.ts hook handler)
  // remain stable regardless of how the host names its events.
  return `context-mode hook copilot-cli ${scriptName.replace(/\.mjs$/, "")}`;
}
