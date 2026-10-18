import assert from "node:assert/strict";
import { homedir } from "node:os";
import path from "node:path";
import test from "node:test";

import { dumpsDir, stateDir } from "../src/paths.ts";

// #864: dump location must be XDG-based (stateDir) on every platform — never a
// raw $HOME string (undefined on Windows) and never /tmp. ACP_DUMP_DIR stays
// the highest-priority override (tests/reasoning-echo-400, tests/error-dump).

interface Env {
    dumpDir: string | undefined;
    xdgStateHome: string | undefined;
}

function saveEnv(): Env {
    return { dumpDir: process.env.ACP_DUMP_DIR, xdgStateHome: process.env.XDG_STATE_HOME };
}

function restoreEnv(prev: Env): void {
    if (prev.dumpDir === undefined) delete process.env.ACP_DUMP_DIR;
    else process.env.ACP_DUMP_DIR = prev.dumpDir;
    if (prev.xdgStateHome === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = prev.xdgStateHome;
}

test("dumpsDir: ACP_DUMP_DIR override wins over everything", () => {
    const prev = saveEnv();
    try {
        process.env.ACP_DUMP_DIR = "/custom/dumps";
        process.env.XDG_STATE_HOME = "/custom/state";
        assert.equal(dumpsDir(), "/custom/dumps");
    } finally {
        restoreEnv(prev);
    }
});

test("dumpsDir: respects XDG_STATE_HOME", () => {
    const prev = saveEnv();
    try {
        delete process.env.ACP_DUMP_DIR;
        process.env.XDG_STATE_HOME = "/custom/state";
        // mirrors stateDir()'s path.resolve of the env override; a bare path.join disagrees on win32 (drive-relative fixture)
        assert.equal(dumpsDir(), path.join(path.resolve("/custom/state"), "billion-context", "dumps"));
        assert.equal(dumpsDir(), path.join(stateDir(), "dumps"), "co-located with bili.log state dir");
    } finally {
        restoreEnv(prev);
    }
});

test("dumpsDir: default is under ~/.local/state/billion-context/dumps (no raw $HOME, no /tmp)", () => {
    const prev = saveEnv();
    try {
        delete process.env.ACP_DUMP_DIR;
        delete process.env.XDG_STATE_HOME;
        assert.equal(dumpsDir(), path.join(homedir(), ".local", "state", "billion-context", "dumps"));
        assert.ok(!dumpsDir().startsWith("/tmp"), "must not fall back to /tmp");
    } finally {
        restoreEnv(prev);
    }
});
