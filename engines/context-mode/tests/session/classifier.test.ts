/**
 * classifier.test — PRD-context-as-a-service §5 ABI parity
 *
 * TDD coverage for src/session/error-classifier.ts.
 *
 * The matrix below pins every literal bucket value to a representative
 * real-world input so that any future refactor of the regex pipeline
 * cannot silently drift away from seed.ts's pickErrorClassification
 * output names.
 */

import { describe, expect, test } from "vitest";
import {
  classifyError,
  classifyCommand,
  bucketizeDuration,
} from "../../src/session/error-classifier.js";

// ── Error classifier ────────────────────────────────────────────────────

describe("classifyError — one case per seed category", () => {
  test("file_not_found: Node ENOENT from Read", () => {
    const { error_category, error_tool } = classifyError(
      "ENOENT: no such file or directory, open 'src/config.ts'",
      "Read"
    );
    expect(error_category).toBe("file_not_found");
    expect(error_tool).toBe("Read");
  });

  test("command_not_found: POSIX shell 127", () => {
    const { error_category } = classifyError(
      "bash: tsc: command not found",
      "Bash"
    );
    expect(error_category).toBe("command_not_found");
  });

  test("edit_match_failed: Edit tool old_string miss", () => {
    const { error_category, error_tool } = classifyError(
      "old_string not found in file",
      "Edit"
    );
    expect(error_category).toBe("edit_match_failed");
    expect(error_tool).toBe("Edit");
  });

  test("test_failed: vitest FAIL prefix", () => {
    const { error_category } = classifyError(
      "FAIL tests/auth.test.ts: expected 200 but received 401",
      "Bash"
    );
    expect(error_category).toBe("test_failed");
  });

  test("syntax_error: tsc TS2322", () => {
    const { error_category } = classifyError(
      "tsc: error TS2322: Type 'string' is not assignable to type 'number'",
      "Bash"
    );
    expect(error_category).toBe("syntax_error");
  });

  test("runtime_error: uncaught TypeError", () => {
    const { error_category } = classifyError(
      "TypeError: Cannot read properties of undefined (reading 'map')",
      "Bash"
    );
    expect(error_category).toBe("runtime_error");
  });

  test("permission_denied: EACCES from Write", () => {
    const { error_category, error_tool } = classifyError(
      "EACCES: permission denied, open '/etc/hosts'",
      "Write"
    );
    expect(error_category).toBe("permission_denied");
    expect(error_tool).toBe("Write");
  });

  test("git_conflict: merge conflict header", () => {
    const { error_category } = classifyError(
      "CONFLICT (content): Merge conflict in src/index.ts",
      "Bash"
    );
    expect(error_category).toBe("git_conflict");
  });

  test("timeout: Query timeout after Nms", () => {
    const { error_category } = classifyError(
      "Error: Query timeout after 30000ms",
      "Bash"
    );
    expect(error_category).toBe("timeout");
  });

  test("unknown: unrecognised message", () => {
    const { error_category } = classifyError(
      "the gremlins ate the response",
      "Bash"
    );
    expect(error_category).toBe("unknown");
  });
});

describe("classifyError — error_tool derivation", () => {
  test("uses toolName when provided", () => {
    expect(classifyError("any error", "MultiEdit").error_tool).toBe("MultiEdit");
  });

  test("extracts canonical tool from message when toolName missing", () => {
    const { error_tool } = classifyError(
      "Edit failed: file has been modified externally",
      ""
    );
    expect(error_tool).toBe("Edit");
  });

  test("falls back to 'unknown' when neither tool source is informative", () => {
    expect(classifyError("totally opaque", "").error_tool).toBe("unknown");
  });
});

describe("classifyError — edge cases", () => {
  test("empty string → unknown / unknown", () => {
    const { error_category, error_tool } = classifyError("", "");
    expect(error_category).toBe("unknown");
    expect(error_tool).toBe("unknown");
  });

  test("null message → unknown (does not throw)", () => {
    expect(() => classifyError(null, "Bash")).not.toThrow();
    expect(classifyError(null, "Bash").error_category).toBe("unknown");
  });

  test("undefined message + undefined tool", () => {
    expect(classifyError(undefined, undefined).error_category).toBe("unknown");
    expect(classifyError(undefined, undefined).error_tool).toBe("unknown");
  });

  test("numeric/garbage message coerces safely", () => {
    // @ts-expect-error — exercising defensive coercion of non-string input.
    const r = classifyError(42, "Bash");
    expect(r.error_category).toBe("unknown");
    expect(r.error_tool).toBe("Bash");
  });

  test("timeout pattern wins over generic test wording", () => {
    expect(
      classifyError("Test timed out after 5000ms", "Bash").error_category
    ).toBe("timeout");
  });
});

// ── Command classifier ─────────────────────────────────────────────────

describe("classifyCommand — command_type buckets", () => {
  test("test: npm test", () => {
    expect(classifyCommand("npm test").command_type).toBe("test");
  });

  test("build: npm run build", () => {
    expect(classifyCommand("npm run build").command_type).toBe("build");
  });

  test("lint: eslint .", () => {
    const r = classifyCommand("eslint .");
    expect(r.command_type).toBe("lint");
    expect(r.command_tool).toBe("eslint");
  });

  test("git: git commit", () => {
    const r = classifyCommand("git commit -m 'wip'");
    expect(r.command_type).toBe("git");
    expect(r.command_tool).toBe("git");
  });

  test("install: pnpm install", () => {
    const r = classifyCommand("pnpm install");
    expect(r.command_type).toBe("install");
    expect(r.command_tool).toBe("pnpm");
  });

  test("format: prettier --write .", () => {
    expect(classifyCommand("prettier --write .").command_type).toBe("format");
  });

  test("run: node script.js", () => {
    const r = classifyCommand("node script.js");
    expect(r.command_type).toBe("run");
    expect(r.command_tool).toBe("node");
  });

  test("other: unknown binary", () => {
    const r = classifyCommand("doctl compute droplet list");
    expect(r.command_type).toBe("other");
    expect(r.command_tool).toBe("doctl");
  });
});

describe("classifyCommand — tokeniser edge cases", () => {
  test("strips leading env-var prefix", () => {
    const r = classifyCommand("FOO=bar npm test");
    expect(r.command_type).toBe("test");
    expect(r.command_tool).toBe("npm");
  });

  test("strips sudo wrapper", () => {
    const r = classifyCommand("sudo npm install");
    expect(r.command_type).toBe("install");
    expect(r.command_tool).toBe("npm");
  });

  test("empty / non-string input → other", () => {
    expect(classifyCommand("").command_type).toBe("other");
    expect(classifyCommand(null).command_type).toBe("other");
    expect(classifyCommand(undefined).command_type).toBe("other");
  });
});

// ── Duration bucketiser ────────────────────────────────────────────────

describe("bucketizeDuration", () => {
  test("fast: <1s", () => {
    expect(bucketizeDuration(250)).toBe("fast");
    expect(bucketizeDuration(0)).toBe("fast");
  });

  test("medium: 1–10s", () => {
    expect(bucketizeDuration(1_500)).toBe("medium");
    expect(bucketizeDuration(9_999)).toBe("medium");
  });

  test("slow: 10–60s", () => {
    expect(bucketizeDuration(15_000)).toBe("slow");
  });

  test("timeout: ≥60s", () => {
    expect(bucketizeDuration(60_000)).toBe("timeout");
    expect(bucketizeDuration(120_000)).toBe("timeout");
  });

  test("defensive: null/NaN/negative → fast", () => {
    expect(bucketizeDuration(null)).toBe("fast");
    expect(bucketizeDuration(undefined)).toBe("fast");
    expect(bucketizeDuration(Number.NaN)).toBe("fast");
    expect(bucketizeDuration(-1)).toBe("fast");
  });
});
