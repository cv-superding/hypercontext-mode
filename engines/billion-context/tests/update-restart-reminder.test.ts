import { test } from "node:test";
import assert from "node:assert/strict";
import { _resetStaleWarnForTest, reportNotNewer, staleInstallStatus } from "../src/update.ts";

function captureLog(): { log: (level: string, msg: string) => void; entries: Array<{ level: string; msg: string }> } {
    const entries: Array<{ level: string; msg: string }> = [];
    return { entries, log: (level, msg) => entries.push({ level, msg }) };
}

test("staleInstallStatus: disk newer than running process → restart (#327 scenario)", () => {
    assert.equal(staleInstallStatus("0.1.62", "0.1.55"), "restart");
});

test("staleInstallStatus: disk == running → current", () => {
    assert.equal(staleInstallStatus("0.1.62", "0.1.62"), "current");
});

test("staleInstallStatus: disk older than running (manual downgrade) → current", () => {
    assert.equal(staleInstallStatus("0.1.55", "0.1.62"), "current");
});

test("staleInstallStatus: no install dir found → current", () => {
    assert.equal(staleInstallStatus(undefined, "0.1.62"), "current");
});

test("staleInstallStatus: numeric (not lexicographic) compare across digit widths", () => {
    assert.equal(staleInstallStatus("0.1.10", "0.1.9"), "restart");
    assert.equal(staleInstallStatus("0.1.9", "0.1.10"), "current");
});

test("reportNotNewer: restart reminder warns ONCE per version pair, then stays quiet (#806)", () => {
    _resetStaleWarnForTest();
    const { log, entries } = captureLog();
    assert.equal(reportNotNewer("0.1.112", "latest", "0.1.114", "0.1.112", log), true);
    assert.equal(reportNotNewer("0.1.112", "latest", "0.1.114", "0.1.112", log), true);
    assert.equal(reportNotNewer("0.1.112", "latest", "0.1.114", "0.1.112", log), true);
    assert.equal(entries.length, 1, "the reminder must not re-log on every 180s check");
    assert.equal(entries[0].level, "warn");
    assert.match(entries[0].msg, /running v0\.1\.112 but v0\.1\.114 is installed — restart bili to activate/);
    _resetStaleWarnForTest();
});

test("reportNotNewer: a changed version pair re-warns without needing a reset (#806)", () => {
    _resetStaleWarnForTest();
    const { log, entries } = captureLog();
    reportNotNewer("0.1.112", "latest", "0.1.114", "0.1.112", log);
    reportNotNewer("0.1.112", "latest", "0.1.115", "0.1.112", log);
    const warns = entries.filter((e) => e.level === "warn");
    assert.equal(warns.length, 2, "a new on-disk version is a new fact worth one more warning");
    assert.match(warns[1].msg, /v0\.1\.115 is installed/);
    _resetStaleWarnForTest();
});

test("reportNotNewer: up-to-date (non-stale) logs info and clears the dedupe key (#806)", () => {
    _resetStaleWarnForTest();
    const { log, entries } = captureLog();
    reportNotNewer("0.1.114", "latest", undefined, "0.1.114", log);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].level, "info");
    assert.match(entries[0].msg, /up to date/);
    reportNotNewer("0.1.112", "latest", "0.1.114", "0.1.112", log);
    assert.equal(entries[entries.length - 1].level, "warn", "after an info line the next stale pair warns again");
    _resetStaleWarnForTest();
});

test("reportNotNewer: a newer latest available → false so the caller proceeds to install", () => {
    const { log, entries } = captureLog();
    assert.equal(reportNotNewer("0.2.0", "latest", "0.1.114", "0.1.112", log), false);
    assert.equal(entries.length, 0, "nothing is logged when an update is about to be installed");
    _resetStaleWarnForTest();
});
