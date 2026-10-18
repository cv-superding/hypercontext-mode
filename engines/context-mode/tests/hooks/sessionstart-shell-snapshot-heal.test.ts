/**
 * Issue #710 — Layer 2: SessionStart hook re-heals stale shell snapshots.
 *
 * The SessionStart hook fires on every Claude Code session boot, so even
 * a session that started before /ctx-upgrade ran (and thus missed Layer
 * 1's in-process rewrite) will self-heal on its first SessionStart.
 *
 * This test exercises the `selfHealShellSnapshots` entry point from
 * `cache-heal-utils.mjs` — the inline call site in `sessionstart.mjs`
 * just delegates to it.
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
import { selfHealShellSnapshots } from "../../hooks/cache-heal-utils.mjs";

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

function makeTmp(prefix = "ctx-sshell-"): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(d);
  return d;
}

describe("selfHealShellSnapshots — SessionStart entry point", () => {
  test("heals a stale snapshot left behind by a previous /ctx-upgrade", () => {
    const root = makeTmp();
    const snapshotsDir = join(root, "shell-snapshots");
    mkdirSync(snapshotsDir, { recursive: true });
    const file = join(snapshotsDir, "snapshot-zsh-stale.sh");
    writeFileSync(
      file,
      `export PATH='/Users/x/.claude/plugins/cache/context-mode/context-mode/1.0.146/bin:/usr/bin'\n`,
      "utf-8",
    );

    const result = selfHealShellSnapshots({
      snapshotsDir,
      pluginCacheRoot: join(root, "cache"),
      currentVersion: "1.0.151",
    });

    expect(result.rewritten).toEqual([file]);
    const after = readFileSync(file, "utf-8");
    expect(after).toContain("context-mode/context-mode/1.0.151/bin");
  });

  test("no-op when no snapshots reference context-mode", () => {
    const root = makeTmp();
    const snapshotsDir = join(root, "shell-snapshots");
    mkdirSync(snapshotsDir, { recursive: true });
    writeFileSync(
      join(snapshotsDir, "snapshot-zsh-clean.sh"),
      `export PATH='/usr/bin:/bin'\n`,
      "utf-8",
    );

    const result = selfHealShellSnapshots({
      snapshotsDir,
      pluginCacheRoot: join(root, "cache"),
      currentVersion: "1.0.151",
    });

    expect(result.rewritten).toEqual([]);
  });

  test("never throws on missing snapshotsDir", () => {
    let result: { rewritten: string[] } | undefined;
    expect(() => {
      result = selfHealShellSnapshots({
        snapshotsDir: "/path/does/not/exist/xyz",
        pluginCacheRoot: "/whatever",
        currentVersion: "1.0.151",
      });
    }).not.toThrow();
    expect(result?.rewritten).toEqual([]);
  });

  test("never throws on malformed inputs", () => {
    expect(() =>
      selfHealShellSnapshots({
        // @ts-expect-error — exercise runtime guard
        snapshotsDir: undefined,
        // @ts-expect-error
        pluginCacheRoot: undefined,
        // @ts-expect-error
        currentVersion: undefined,
      }),
    ).not.toThrow();
  });
});
