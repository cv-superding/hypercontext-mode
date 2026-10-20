import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { REPO_ROOT, loadConfig, saveConfig } from "@hypercontext/core";

const execFileAsync = promisify(execFile);
const HCTX = join(REPO_ROOT, "bin", "hctx.mjs");

async function runHctx(args: string[], env: NodeJS.ProcessEnv = {}): Promise<string> {
  const result = await execFileAsync(process.execPath, [HCTX, ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return result.stdout;
}

test("hctx version reports both engine versions", async () => {
  const output = await runHctx(["version"]);
  const version = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")).version as string;
  assert.match(output, new RegExp(`hctx ${version.replace(/\./g, "\\.")}`));
  assert.match(output, /context-mode 1\.0\.169/);
  assert.match(output, /billion-context 0\.1\.199/);
});

test("hctx clients includes Qoder and native lanes", async () => {
  const output = await runHctx(["clients", "--json"]);
  const clients = JSON.parse(output) as Array<{ id: string; launcher: string | null; plugin: string | null }>;
  const qoderIntl = clients.find((client) => client.id === "qoder-intl");
  const qoderCn = clients.find((client) => client.id === "qoder-cn");
  assert.ok(qoderIntl);
  assert.ok(qoderCn);
  assert.equal(qoderIntl?.launcher, "qoder");
  assert.equal(qoderCn?.launcher, "qoder");
  assert.ok(clients.some((client) => client.id === "workbuddy-intl"));
  assert.ok(clients.some((client) => client.id === "workbuddy-cn"));
  assert.ok(clients.some((client) => client.id === "claude-code" && client.plugin === "claude"));
  assert.ok(clients.length >= 33);
});

test("hctx status works with an isolated home and reports the policy", async () => {
  const home = mkdtempSync(join(tmpdir(), "hctx-cli-"));
  const previous = process.env.HYPERCONTEXT_HOME;
  process.env.HYPERCONTEXT_HOME = home;
  try {
    const config = loadConfig();
    config.compression.port = 38999;
    saveConfig(config);
    const output = await runHctx(["status", "--json"], { HYPERCONTEXT_HOME: home });
    const report = JSON.parse(output) as {
      policy: { mode: string; compressionMode: string; routing: string; memoryInjection: string };
      stats: { sandbox: { events: number }; compression: { indexPresent: boolean } };
      engines: { contextMode: { version?: string } };
    };
    assert.equal(report.policy.mode, "full");
    assert.equal(report.policy.compressionMode, "cooperative");
    assert.equal(report.policy.routing, "balanced");
    assert.equal(report.policy.memoryInjection, "minimal");
    assert.equal(report.stats.compression.indexPresent, false);
    assert.equal(report.engines.contextMode.version, "1.0.169");
  } finally {
    if (previous === undefined) delete process.env.HYPERCONTEXT_HOME;
    else process.env.HYPERCONTEXT_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});
