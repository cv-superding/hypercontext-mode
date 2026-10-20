import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  HypercontextConfigSchema,
  buildPolicy,
  defaultConfig,
  ensureBillionConfig,
  getHypercontextPaths,
} from "@hypercontext/core";

test("policy defaults to full mode, balanced routing and minimal memory", () => {
  const home = mkdtempSync(join(tmpdir(), "hctx-policy-"));
  const previous = process.env.HYPERCONTEXT_HOME;
  process.env.HYPERCONTEXT_HOME = home;
  try {
    const policy = buildPolicy({ config: defaultConfig() });
    assert.equal(policy.mode, "full");
    assert.equal(policy.compressionMode, "cooperative");
    assert.equal(policy.routingMode, "balanced");
    assert.equal(policy.memoryInjection, "minimal");
    assert.equal(policy.env.CONTEXT_MODE_DIR, getHypercontextPaths().contextDataDir);
    assert.equal(policy.env.HYPERCONTEXT_MEMORY_INJECTION, "minimal");
    assert.equal(policy.env.HYPERCONTEXT_COMPRESSION_MODE, "cooperative");
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

test("autofold mode requires a summary provider", () => {
  assert.throws(
    () => HypercontextConfigSchema.parse({ compression: { mode: "autofold" } }),
    /compression\.summary is required/,
  );
});

test("autofold mode writes a managed summary chain and disables prompt injection", () => {
  const home = mkdtempSync(join(tmpdir(), "hctx-autofold-"));
  const previous = process.env.HYPERCONTEXT_HOME;
  process.env.HYPERCONTEXT_HOME = home;
  try {
    ensureBillionConfig();
    const paths = getHypercontextPaths();
    writeFileSync(
      paths.compressionConfigFile,
      JSON.stringify({ custom: true, compress: { maxContextLimit: "70%" } }),
    );

    const config = defaultConfig();
    config.compression.mode = "autofold";
    config.compression.summary = {
      baseUrl: "https://summary.example/v1/",
      api: "openai",
      apiKeyEnv: "SUMMARY_API_KEY",
      model: "cheap-summary",
      autoFoldTargetTokens: 40000,
      concurrency: 8,
    };

    const first = ensureBillionConfig(config);
    assert.equal(first.changed, true);
    const saved = JSON.parse(readFileSync(first.file, "utf8")) as {
      custom: boolean;
      providers: Record<string, { baseUrl: string; api: string; apiKeyEnv: string; models: Record<string, unknown> }>;
      compress: {
        maxContextLimit: string;
        injectTool: boolean;
        injectNudge: boolean;
        externalSummary: { enabled: boolean; targets: string[]; autoFold: boolean; autoFoldTargetTokens: number; concurrency: number };
      };
    };
    assert.equal(saved.custom, true);
    assert.equal(saved.compress.maxContextLimit, "70%");
    assert.equal(saved.providers["hctx-summary"].baseUrl, "https://summary.example/v1");
    assert.equal(saved.providers["hctx-summary"].api, "openai");
    assert.equal(saved.providers["hctx-summary"].apiKeyEnv, "SUMMARY_API_KEY");
    assert.ok("cheap-summary" in saved.providers["hctx-summary"].models);
    assert.equal(saved.compress.injectTool, false);
    assert.equal(saved.compress.injectNudge, false);
    assert.deepEqual(saved.compress.externalSummary.targets, ["hctx-summary/cheap-summary"]);
    assert.equal(saved.compress.externalSummary.autoFold, true);
    assert.equal(saved.compress.externalSummary.autoFoldTargetTokens, 40000);
    assert.equal(saved.compress.externalSummary.concurrency, 8);

    const second = ensureBillionConfig(config);
    assert.equal(second.changed, false);

    config.compression.mode = "cooperative";
    const restored = ensureBillionConfig(config);
    assert.equal(restored.changed, true);
    const after = JSON.parse(readFileSync(restored.file, "utf8")) as {
      providers: Record<string, unknown>;
      compress: { maxContextLimit: string; injectTool: boolean; injectNudge: boolean; externalSummary: { enabled: boolean; autoFold: boolean } };
    };
    assert.equal(after.providers["hctx-summary"], undefined);
    assert.equal(after.compress.maxContextLimit, "70%");
    assert.equal(after.compress.injectTool, true);
    assert.equal(after.compress.injectNudge, true);
    assert.equal(after.compress.externalSummary.enabled, false);
    assert.equal(after.compress.externalSummary.autoFold, false);

    const stable = ensureBillionConfig(config);
    assert.equal(stable.changed, false);
  } finally {
    if (previous === undefined) delete process.env.HYPERCONTEXT_HOME;
    else process.env.HYPERCONTEXT_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});
