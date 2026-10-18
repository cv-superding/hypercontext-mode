import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildPolicy, defaultConfig, getHypercontextPaths } from "@hypercontext/core";

test("policy defaults to full mode, balanced routing and minimal memory", () => {
  const home = mkdtempSync(join(tmpdir(), "hctx-policy-"));
  const previous = process.env.HYPERCONTEXT_HOME;
  process.env.HYPERCONTEXT_HOME = home;
  try {
    const policy = buildPolicy({ config: defaultConfig() });
    assert.equal(policy.mode, "full");
    assert.equal(policy.routingMode, "balanced");
    assert.equal(policy.memoryInjection, "minimal");
    assert.equal(policy.env.CONTEXT_MODE_DIR, getHypercontextPaths().contextDataDir);
    assert.equal(policy.env.HYPERCONTEXT_MEMORY_INJECTION, "minimal");
    assert.equal(policy.env.ACP_AUTO_UPDATE, "0");
    assert.equal(policy.env.BILI_ADVISORY_CHECK, "0");
    assert.equal(policy.env.BILI_RELEASE_NOTES_CHECK, "0");
    assert.equal(policy.env.CONTEXT_MODE_DISABLE_UPDATE_CHECK, "1");
    assert.ok(policy.env.XDG_DATA_HOME?.endsWith(join("data", "xdg")));
  } finally {
    if (previous === undefined) delete process.env.HYPERCONTEXT_HOME;
    else process.env.HYPERCONTEXT_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});

test("policy honors layer overrides and warns about unsafe settings", () => {
  const home = mkdtempSync(join(tmpdir(), "hctx-policy2-"));
  const previous = process.env.HYPERCONTEXT_HOME;
  process.env.HYPERCONTEXT_HOME = home;
  try {
    const config = defaultConfig();
    config.compression.enabled = false;
    const sandboxOnly = buildPolicy({ config });
    assert.equal(sandboxOnly.mode, "sandbox-only");
    assert.equal(sandboxOnly.memoryInjection, "full");

    config.compression.enabled = true;
    config.sandbox.enabled = false;
    const compressionOnly = buildPolicy({ config });
    assert.equal(compressionOnly.mode, "compression-only");

    config.sandbox.enabled = true;
    config.compression.host = "0.0.0.0";
    config.sandbox.routing = "strict";
    config.sandbox.memoryInjection = "full";
    config.update.auto = true;
    const risky = buildPolicy({ config });
    assert.equal(risky.warnings.length >= 3, true);
    assert.ok(risky.warnings.some((warning) => warning.includes("no authentication")));
    assert.ok(risky.warnings.some((warning) => warning.includes("Strict routing")));
    assert.ok(risky.warnings.some((warning) => warning.includes("prefix cache")));
    assert.ok(risky.warnings.some((warning) => warning.includes("Automatic updates")));
  } finally {
    if (previous === undefined) delete process.env.HYPERCONTEXT_HOME;
    else process.env.HYPERCONTEXT_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});
