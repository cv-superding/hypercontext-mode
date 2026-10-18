/**
 * Issue #710 — /ctx-upgrade Layer 1: rewrites stale shell-snapshot PATH
 * entries to the freshly-installed version.
 *
 * This is the upgrade-time arm of the fix. We don't run the full
 * `upgrade()` flow here (network + npm + plugin install) — we exercise
 * the same `rewriteShellSnapshots` helper cli.ts calls during the
 * finalize block, with the same fixture shapes we expect to encounter
 * in `~/.claude/shell-snapshots/`.
 */
import { describe, test, expect, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rewriteShellSnapshots } from "../../hooks/cache-heal-utils.mjs";

const cleanups: string[] = [];

afterEach(() => {
  while (cleanups.length) {
    const d = cleanups.pop();
    if (d) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  }
});

function makeTmp(prefix = "ctx-upgrade-snap-"): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(d);
  return d;
}

describe("ctx-upgrade Layer 1 — shell-snapshot heal", () => {
  test("real-world Mert fixture: 1.0.146 → 1.0.151 bump survives mid-session", () => {
    // This is shape #710 reported verbatim — pre-upgrade snapshot
    // pinned at 1.0.146 with sibling plugins around it.
    const root = makeTmp();
    const snapshotsDir = join(root, "shell-snapshots");
    mkdirSync(snapshotsDir, { recursive: true });
    const file = join(snapshotsDir, "snapshot-zsh-1779542730786-4e0jjg.sh");
    const before =
      `export PATH='/Users/mksglu/.claude-worktree/shims:/opt/homebrew/bin:` +
      `/Users/mksglu/.claude/plugins/cache/pm-skills/pm-toolkit/1.0.1/bin:` +
      `/Users/mksglu/.claude/plugins/cache/context-mode/context-mode/1.0.146/bin:` +
      `/Users/mksglu/.claude/plugins/cache/claude-adhd/claude-adhd/1.0.0/bin'\n`;
    writeFileSync(file, before, "utf-8");

    const result = rewriteShellSnapshots({
      snapshotsDir,
      currentVersion: "1.0.151",
    });

    expect(result.rewritten).toEqual([file]);
    const after = readFileSync(file, "utf-8");
    expect(after).toContain(
      "/cache/context-mode/context-mode/1.0.151/bin",
    );
    // Sibling plugins frozen at their own versions — must not move.
    expect(after).toContain("/cache/pm-skills/pm-toolkit/1.0.1/bin");
    expect(after).toContain("/cache/claude-adhd/claude-adhd/1.0.0/bin");
    expect(after).not.toContain("context-mode/context-mode/1.0.146");
  });

  test("multiple sessions on disk — every stale snapshot is healed", () => {
    // Mert's bug report listed several snapshots from prior sessions,
    // each pinned at the cache version active when that session
    // started. After /ctx-upgrade, every one of them must converge to
    // the current version.
    const root = makeTmp();
    const snapshotsDir = join(root, "shell-snapshots");
    mkdirSync(snapshotsDir, { recursive: true });
    const stalePins = ["1.0.111", "1.0.122", "1.0.140", "1.0.146"];
    for (const [i, v] of stalePins.entries()) {
      writeFileSync(
        join(snapshotsDir, `snapshot-zsh-${i}.sh`),
        `export PATH='/x:/Users/x/.claude/plugins/cache/context-mode/context-mode/${v}/bin'\n`,
        "utf-8",
      );
    }

    const result = rewriteShellSnapshots({
      snapshotsDir,
      currentVersion: "1.0.151",
    });

    expect(result.rewritten.length).toBe(stalePins.length);
    for (let i = 0; i < stalePins.length; i++) {
      const content = readFileSync(
        join(snapshotsDir, `snapshot-zsh-${i}.sh`),
        "utf-8",
      );
      expect(content).toContain("context-mode/context-mode/1.0.151/bin");
      expect(content).not.toContain(`context-mode/context-mode/${stalePins[i]}`);
    }
  });

  test("idempotent — running upgrade twice with the same currentVersion no-ops the second time", () => {
    const root = makeTmp();
    const snapshotsDir = join(root, "shell-snapshots");
    mkdirSync(snapshotsDir, { recursive: true });
    const file = join(snapshotsDir, "snapshot-zsh-idem.sh");
    writeFileSync(
      file,
      `export PATH='/Users/x/.claude/plugins/cache/context-mode/context-mode/1.0.146/bin'\n`,
      "utf-8",
    );

    const r1 = rewriteShellSnapshots({
      snapshotsDir,
      currentVersion: "1.0.151",
    });
    expect(r1.rewritten).toEqual([file]);

    const r2 = rewriteShellSnapshots({
      snapshotsDir,
      currentVersion: "1.0.151",
    });
    expect(r2.rewritten).toEqual([]);
  });
});
