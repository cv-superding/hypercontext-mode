/**
 * error-classifier — PRD-context-as-a-service §5 ABI parity
 *
 * Pure classifiers that derive per-event metadata from PostToolUse hook
 * stdin, mirroring the seed shape produced by context-mode-platform's
 * `seed.ts` so the bridge can ship full seed-shape parity.
 *
 * The dashboard reads three derived columns that are populated by the
 * platform seeder but, per the OSS handoff (ANOMALY #3), are NEVER READ
 * by the engine when ingesting live events:
 *
 *   • error_category   — one of 10 fixed buckets
 *   • error_tool       — tool name that produced the error
 *   • command_type     — git / test / build / lint / install / format / run / other
 *   • command_tool     — first token of the command (npm, git, pytest, …)
 *   • duration_bucket  — fast / medium / slow / timeout
 *
 * We populate them anyway, with sane defaults derived from message text
 * and tool name, so the dashboard renders symmetrically with seed.
 *
 * Hard constraints:
 *   1. Pure functions — no I/O, no globals, no module state.
 *   2. `error_category` MUST match seed's `pickErrorClassification`
 *      output exactly. The literal union below is the ABI.
 *   3. No external dependencies; TypeScript stdlib only.
 *   4. Robust to null / undefined / empty / malformed input.
 */

// ── Type ABI ────────────────────────────────────────────────────────────
// These literal unions MUST match the values produced by seed.ts. Any
// drift here breaks dashboard column parity. See seed.ts §297-307.

export type ErrorCategory =
  | "file_not_found"
  | "command_not_found"
  | "edit_match_failed"
  | "test_failed"
  | "syntax_error"
  | "runtime_error"
  | "permission_denied"
  | "git_conflict"
  | "timeout"
  | "unknown";

export type CommandType =
  | "test"
  | "build"
  | "lint"
  | "git"
  | "install"
  | "format"
  | "run"
  | "other";

export type DurationBucket = "fast" | "medium" | "slow" | "timeout";

export interface ErrorClassification {
  error_category: ErrorCategory;
  error_tool: string;
}

export interface CommandClassification {
  command_type: CommandType;
  command_tool: string;
}

// ── Internal helpers ────────────────────────────────────────────────────

/**
 * Normalise message for case-insensitive substring matching. Coerces
 * non-string input (null, undefined, numbers from errno objects) to
 * empty string so downstream `.includes()` is always safe.
 */
function normalise(s: unknown): string {
  if (typeof s !== "string") return "";
  return s.toLowerCase();
}

/**
 * Best-effort `error_tool` derivation. Prefers the PostToolUse-supplied
 * `toolName`; falls back to scanning the message for a canonical tool
 * name (Read/Edit/Write/Bash/Grep/Glob) so isolated error strings still
 * resolve to a useful value rather than the literal "unknown".
 */
function deriveErrorTool(toolName: unknown, message: string): string {
  if (typeof toolName === "string" && toolName.trim().length > 0) {
    return toolName.trim();
  }
  // Canonical Claude Code tool names that may appear in error strings.
  const known = ["Edit", "Read", "Write", "Bash", "Grep", "Glob", "MultiEdit"];
  for (const t of known) {
    if (message.toLowerCase().includes(t.toLowerCase())) return t;
  }
  return "unknown";
}

// ── Error classifier ────────────────────────────────────────────────────

/**
 * Classify an error message + tool name into one of seed's 10 categories.
 *
 * Patterns (ordered most-specific → least-specific so the first match
 * wins). Rationale for each pattern is inline.
 *
 *  • file_not_found   — Node's ENOENT, Python's FileNotFoundError, and
 *                       Claude's "Cannot find module" all signal a
 *                       missing file/path.
 *  • command_not_found — POSIX shells emit "command not found" (exit 127)
 *                       and "bash: <bin>: not found"; npx prints similar.
 *  • edit_match_failed — Claude's Edit tool prints "old_string not found"
 *                       or "matches multiple locations" when the patch
 *                       context is stale.
 *  • test_failed      — vitest/jest/pytest format `FAIL ` prefix; npm
 *                       prints "Test failed".
 *  • syntax_error     — SyntaxError (JS/TS), tsc TS-codes, or Python's
 *                       SyntaxError header.
 *  • runtime_error    — TypeError/ReferenceError/RangeError (uncaught).
 *  • permission_denied — EACCES / "permission denied" from fs or sudo.
 *  • git_conflict     — git's "CONFLICT" header on rebase/merge, plus
 *                       "Merge conflict in".
 *  • timeout          — explicit "timeout"/"timed out"/"ETIMEDOUT".
 *  • unknown          — fallthrough; never throws.
 */
export function classifyError(
  message: unknown,
  toolName: unknown
): ErrorClassification {
  const msg = normalise(message);
  const tool = typeof toolName === "string" ? toolName : "";
  const error_tool = deriveErrorTool(toolName, typeof message === "string" ? message : "");

  // Empty / malformed input → unknown bucket but still return a valid tool.
  if (msg.length === 0) {
    return { error_category: "unknown", error_tool };
  }

  // ── file_not_found ────────────────────────────────────────────────
  // Node's ENOENT carries "no such file or directory"; Claude's Read
  // tool surfaces the raw errno line. "cannot find module" is the
  // require-resolution variant.
  if (
    msg.includes("enoent") ||
    msg.includes("no such file") ||
    msg.includes("cannot find module") ||
    msg.includes("filenotfounderror")
  ) {
    return { error_category: "file_not_found", error_tool };
  }

  // ── command_not_found ────────────────────────────────────────────
  // POSIX shells: "<shell>: <bin>: command not found" → exit 127.
  // Some hooks surface the bare exit code without the message.
  if (
    msg.includes("command not found") ||
    msg.includes(": not found") ||
    /\bexit(?:\s+code)?\s*[:=]?\s*127\b/.test(msg)
  ) {
    return { error_category: "command_not_found", error_tool };
  }

  // ── edit_match_failed ────────────────────────────────────────────
  // Claude Code's Edit tool prints these exact phrases when the
  // `old_string` parameter no longer matches the file contents.
  // Gate on the Edit tool to avoid false positives when a Bash script
  // happens to contain the literal text "old_string".
  if (
    (tool === "Edit" || tool === "MultiEdit") &&
    (msg.includes("old_string") ||
      msg.includes("could not find string") ||
      msg.includes("string to replace not found") ||
      msg.includes("matches multiple"))
  ) {
    return { error_category: "edit_match_failed", error_tool };
  }
  // Edit-style failure can also leak without tool name — match the
  // distinctive Claude phrasing alone.
  if (msg.includes("old_string not found") || msg.includes("string to replace not found")) {
    return { error_category: "edit_match_failed", error_tool };
  }

  // ── git_conflict ─────────────────────────────────────────────────
  // Check BEFORE test_failed because "CONFLICT" can co-occur with the
  // word "fail" in some merge outputs.
  if (
    msg.includes("conflict") &&
    (msg.includes("merge") || msg.includes("rebase") || msg.includes("git"))
  ) {
    return { error_category: "git_conflict", error_tool };
  }
  if (msg.startsWith("conflict") || msg.includes("merge conflict")) {
    return { error_category: "git_conflict", error_tool };
  }

  // ── timeout ──────────────────────────────────────────────────────
  // Check BEFORE test_failed; "test timed out" should bucket as timeout.
  if (
    msg.includes("etimedout") ||
    msg.includes("timed out") ||
    msg.includes("timeout") ||
    msg.includes("deadline exceeded")
  ) {
    return { error_category: "timeout", error_tool };
  }

  // ── permission_denied ────────────────────────────────────────────
  if (
    msg.includes("eacces") ||
    msg.includes("permission denied") ||
    msg.includes("operation not permitted") ||
    msg.includes("eperm")
  ) {
    return { error_category: "permission_denied", error_tool };
  }

  // ── syntax_error ─────────────────────────────────────────────────
  // tsc errors look like "error TS2322"; JS SyntaxError header is exact.
  if (
    msg.includes("syntaxerror") ||
    /\berror\s+ts\d{3,5}\b/.test(msg) ||
    msg.includes("unexpected token") ||
    msg.includes("unexpected end of") ||
    msg.includes("parse error")
  ) {
    return { error_category: "syntax_error", error_tool };
  }

  // ── test_failed ──────────────────────────────────────────────────
  // vitest/jest print `FAIL `; npm test prints "Test failed".
  // pytest prints "FAILED" capital. Bias to Bash tool but accept
  // unscoped messages because hooks sometimes drop tool name.
  if (
    msg.includes("test failed") ||
    msg.includes("tests failed") ||
    /\bfail(?:ed)?\b.*\btest\b/.test(msg) ||
    /\b\d+\s+tests?\s+failed\b/.test(msg) ||
    msg.includes("assertion") ||
    /^fail\s/.test(msg) ||
    /\nfail\s/.test(msg)
  ) {
    return { error_category: "test_failed", error_tool };
  }

  // ── runtime_error ────────────────────────────────────────────────
  // Catch-all for uncaught JS exceptions and the common Python ones.
  // Placed near the end so more specific buckets (syntax_error) win
  // when both could match.
  if (
    msg.includes("typeerror") ||
    msg.includes("referenceerror") ||
    msg.includes("rangeerror") ||
    msg.includes("uncaught exception") ||
    msg.includes("traceback (most recent call last)") ||
    msg.includes("nullpointerexception")
  ) {
    return { error_category: "runtime_error", error_tool };
  }

  // Fallthrough — categorisation is best-effort; the dashboard renders
  // "unknown" as a neutral bucket rather than dropping the event.
  return { error_category: "unknown", error_tool };
}

// ── Command classifier ──────────────────────────────────────────────────

/**
 * Tokenise a shell command, stripping leading env-var prefixes
 * (`FOO=bar npm run build`) and `sudo`/`time` wrappers so the first
 * meaningful token is returned.
 */
function firstToken(command: string): string {
  const parts = command.trim().split(/\s+/);
  let i = 0;
  // Skip env-var assignments: KEY=value
  while (i < parts.length && /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(parts[i])) i++;
  // Skip common wrappers that aren't the "real" tool.
  while (i < parts.length && (parts[i] === "sudo" || parts[i] === "time" || parts[i] === "nice")) i++;
  return parts[i] ?? "";
}

/**
 * Classify a Bash command into a workflow bucket. The bucket is derived
 * from the (tool, sub-verb) pair: `npm test` → test, `npm run build` →
 * build, `git commit` → git, `pip install` → install, etc.
 *
 * Heuristic ordering — most-specific verb checks first; falls through to
 * `run` for generic execution and `other` for anything we can't classify.
 */
export function classifyCommand(command: unknown): CommandClassification {
  if (typeof command !== "string" || command.trim().length === 0) {
    return { command_type: "other", command_tool: "" };
  }
  const raw = command.trim();
  const tool = firstToken(raw).toLowerCase();
  const lower = raw.toLowerCase();

  // ── git ──────────────────────────────────────────────────────────
  if (tool === "git") {
    return { command_type: "git", command_tool: "git" };
  }

  // ── install ──────────────────────────────────────────────────────
  // npm/pnpm/yarn/pip install variants come before generic test/build
  // because `npm install --save-dev jest` would otherwise match test.
  if (
    /\b(install|add|ci)\b/.test(lower) &&
    (tool === "npm" || tool === "pnpm" || tool === "yarn" || tool === "bun" || tool === "pip" || tool === "pip3")
  ) {
    return { command_type: "install", command_tool: tool };
  }
  if (tool === "brew" && /\binstall\b/.test(lower)) {
    return { command_type: "install", command_tool: "brew" };
  }

  // ── test ─────────────────────────────────────────────────────────
  // Direct test runners, plus `npm test` / `pnpm test` / `yarn test`.
  if (
    tool === "vitest" || tool === "jest" || tool === "pytest" ||
    tool === "mocha" || tool === "playwright" || tool === "cypress"
  ) {
    return { command_type: "test", command_tool: tool };
  }
  if (
    (tool === "npm" || tool === "pnpm" || tool === "yarn" || tool === "bun") &&
    /\btest\b/.test(lower)
  ) {
    return { command_type: "test", command_tool: tool };
  }

  // ── lint ─────────────────────────────────────────────────────────
  if (tool === "eslint" || tool === "tslint" || tool === "ruff" || tool === "flake8" || tool === "pylint") {
    return { command_type: "lint", command_tool: tool };
  }
  if (/\blint\b/.test(lower) && (tool === "npm" || tool === "pnpm" || tool === "yarn" || tool === "bun")) {
    return { command_type: "lint", command_tool: tool };
  }

  // ── format ───────────────────────────────────────────────────────
  if (tool === "prettier" || tool === "black" || tool === "gofmt" || tool === "rustfmt") {
    return { command_type: "format", command_tool: tool };
  }
  if (/\b(format|fmt)\b/.test(lower) && (tool === "npm" || tool === "pnpm" || tool === "yarn" || tool === "bun")) {
    return { command_type: "format", command_tool: tool };
  }

  // ── build ────────────────────────────────────────────────────────
  if (tool === "tsc" || tool === "webpack" || tool === "rollup" || tool === "vite" || tool === "esbuild" || tool === "make") {
    return { command_type: "build", command_tool: tool };
  }
  if (/\bbuild\b/.test(lower) && (tool === "npm" || tool === "pnpm" || tool === "yarn" || tool === "bun" || tool === "cargo" || tool === "go")) {
    return { command_type: "build", command_tool: tool };
  }

  // ── run ──────────────────────────────────────────────────────────
  // Generic execution — `npm run …` (with no recognised sub-verb),
  // `node script.js`, `python -m foo`, etc.
  if (
    (tool === "npm" || tool === "pnpm" || tool === "yarn" || tool === "bun") &&
    /\brun\b/.test(lower)
  ) {
    return { command_type: "run", command_tool: tool };
  }
  if (tool === "node" || tool === "python" || tool === "python3" || tool === "deno" || tool === "bun") {
    return { command_type: "run", command_tool: tool };
  }

  // Fallthrough — preserves the tool name so the dashboard can still
  // chart "other" commands by their underlying binary.
  return { command_type: "other", command_tool: tool || "" };
}

// ── Duration bucketiser ────────────────────────────────────────────────

/**
 * Bucketise a latency_ms reading into the four fixed buckets the
 * dashboard renders. Bucket edges (in ms):
 *
 *    fast    : [0,     1_000)
 *    medium  : [1_000, 10_000)
 *    slow    : [10_000, 60_000)
 *    timeout : [60_000, ∞)
 *
 * Defensive: negative and non-numeric inputs collapse to `fast` (the
 * neutral bucket) rather than throwing, because hooks have been seen
 * to emit `null` for very short calls.
 */
export function bucketizeDuration(latencyMs: unknown): DurationBucket {
  const n = typeof latencyMs === "number" && Number.isFinite(latencyMs) ? latencyMs : 0;
  if (n < 1_000) return "fast";
  if (n < 10_000) return "medium";
  if (n < 60_000) return "slow";
  return "timeout";
}
