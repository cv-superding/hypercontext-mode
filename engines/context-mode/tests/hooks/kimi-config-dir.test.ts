import "../setup-home";
/**
 * Verifies the Kimi adapter honours `KIMI_CODE_HOME` for resolving its
 * data root, matching upstream's documented behaviour.
 *
 * Evidence:
 *   refs/platforms/kimi-code/docs/en/configuration/env-vars.md:9-21
 *     "`KIMI_CODE_HOME` overrides Kimi Code CLI's data root directory,
 *      defaulting to `~/.kimi-code`."
 *   refs/platforms/kimi-code/plugins/official/kimi-datasource/bin/
 *     kimi-datasource.mjs:207-210
 *     MoonshotAI's first-party plugin reads `process.env.KIMI_CODE_HOME`.
 *
 * Without this wiring, a user who relocates `$KIMI_CODE_HOME` ends up with
 * Kimi's own state at the override path but context-mode's session DB
 * stranded at `~/.kimi-code/context-mode/sessions/` — split-brain.
 */

import { describe, it, expect, afterEach } from "vitest";
import { join } from "node:path";
import { homedir } from "node:os";

describe("Kimi adapter — KIMI_CODE_HOME env var", () => {
  let savedHome: string | undefined;

  afterEach(() => {
    if (savedHome === undefined) delete process.env.KIMI_CODE_HOME;
    else process.env.KIMI_CODE_HOME = savedHome;
    savedHome = undefined;
  });

  it("KIMI_OPTS declares KIMI_CODE_HOME as its configDirEnv", async () => {
    // Static contract — the helper's options object MUST name the env var
    // so resolveConfigDir() picks it up.
    const helpers = await import("../../hooks/session-helpers.mjs");
    expect(helpers.KIMI_OPTS.configDirEnv).toBe("KIMI_CODE_HOME");
    expect(helpers.KIMI_OPTS.configDir).toBe(".kimi-code");
  });

  it("resolveConfigDir(KIMI_OPTS) returns the KIMI_CODE_HOME override when set", async () => {
    const helpers = await import("../../hooks/session-helpers.mjs");
    savedHome = process.env.KIMI_CODE_HOME;
    const custom = join(homedir(), "custom-kimi-home");
    process.env.KIMI_CODE_HOME = custom;

    expect(helpers.resolveConfigDir(helpers.KIMI_OPTS)).toBe(custom);
  });

  it("resolveConfigDir(KIMI_OPTS) falls back to ~/.kimi-code when env unset", async () => {
    const helpers = await import("../../hooks/session-helpers.mjs");
    savedHome = process.env.KIMI_CODE_HOME;
    delete process.env.KIMI_CODE_HOME;

    expect(helpers.resolveConfigDir(helpers.KIMI_OPTS))
      .toBe(join(homedir(), ".kimi-code"));
  });

  it("resolveConfigDir(KIMI_OPTS) expands a leading ~ in KIMI_CODE_HOME", async () => {
    const helpers = await import("../../hooks/session-helpers.mjs");
    savedHome = process.env.KIMI_CODE_HOME;
    process.env.KIMI_CODE_HOME = "~/relocated-kimi";

    expect(helpers.resolveConfigDir(helpers.KIMI_OPTS))
      .toBe(join(homedir(), "relocated-kimi"));
  });
});
