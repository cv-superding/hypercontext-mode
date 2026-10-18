import fs from "node:fs";
import path from "node:path";
import { dumpsDir } from "./paths.js";
import { log as loggerLog } from "./logger.js";
import { dump4xxEnabled as knobDump4xxEnabled, dump4xxMaxBytes as knobDump4xxMaxBytes } from "./knobs.js";
import { gcDumpDirIfConfigured } from "./state-gc.js";

// #762: when the upstream rejects the forwarded body (4xx), persist the exact
// bytes that were sent so the rejection can be explained byte-for-byte. The
// standing body dump (ACP_DUMP_BODY=1) must be armed BEFORE the incident; this
// one fires on the failure itself. Still off by default — conversation bodies
// leak to disk (#276) — enable with BILI_DUMP_4XX=1 or diagnostics.dump4xx.

let failCount = 0;
let lastFailLog = 0;

function warnDumpFailure(err: unknown): void {
    failCount++;
    const now = Date.now();
    if (failCount === 1 || now - lastFailLog >= 60_000) {
        lastFailLog = now;
        const msg = err instanceof Error ? err.message : String(err);
        loggerLog("warn", `[dump] rejected-body dump failed (total ${failCount}x): ${msg}`);
    }
}

/** Write the rejected forwarded body to `<dumpDir>/err-<ts>-<sid>-<status>.json`
 *  when BILI_DUMP_4XX=1. Returns the file path, or null when disabled/skipped/failed. */
export function dumpRejectedBody(status: number, sessionId: string, body: string | Buffer): string | null {
    if (!knobDump4xxEnabled()) return null;
    const raw = typeof body === "string" ? body : body.toString("utf8");
    if (!raw) return null;
    try {
        const cap = knobDump4xxMaxBytes();
        let text: string;
        let marker = "";
        if (raw.length > cap) {
            text = raw.slice(0, cap);
            marker = `\n[truncated: ${raw.length - cap} more character(s)]\n`;
        } else {
            try {
                text = JSON.stringify(JSON.parse(raw), null, 2);
            } catch {
                text = raw;
            }
        }
        const dir = dumpsDir();
        fs.mkdirSync(dir, { recursive: true });
        const sid = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
        const out = path.join(dir, `err-${Date.now()}-${sid}-${status}.json`);
        fs.writeFileSync(out, `${text}${marker}`);
        loggerLog("info", `[dump] upstream ${status} rejected body written to ${out}`);
        gcDumpDirIfConfigured(dir);
        return out;
    } catch (err) {
        warnDumpFailure(err);
        return null;
    }
}

// #1993: persist a rejected PREFLIGHT SUMMARY exchange — both sides of it, the
// request bytes bili sent and the response bytes the upstream answered — when
// BILI_DUMP_4XX=1. The summary call is built independently of the forwarded
// wire body, so dumpRejectedBody's two main-path call sites never see it;
// without this, "summarization failed: HTTP 400" could not be explained
// byte-for-byte after the fact. Separate `summary-err-` prefix so a main-path
// and a summary dump landing in the same millisecond cannot clobber each
// other. Sides are embedded as strings so the envelope stays valid JSON even
// when a side is not itself JSON.
export function dumpSummaryRejection(status: number, sessionId: string, request: string, response: string): string | null {
    if (!knobDump4xxEnabled()) return null;
    if (!request && !response) return null;
    try {
        const cap = knobDump4xxMaxBytes();
        const side = (raw: string): string => {
            const bounded = raw.length > cap ? `${raw.slice(0, cap)}\n[truncated: ${raw.length - cap} more character(s)]` : raw;
            try { return JSON.stringify(JSON.parse(bounded)); } catch { return bounded; }
        };
        const dir = dumpsDir();
        fs.mkdirSync(dir, { recursive: true });
        const sid = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
        const out = path.join(dir, `summary-err-${Date.now()}-${sid}-${status}.json`);
        fs.writeFileSync(out, JSON.stringify({ status, request: side(request), response: side(response) }, null, 2));
        loggerLog("info", `[dump] upstream ${status} rejected summary exchange written to ${out}`);
        gcDumpDirIfConfigured(dir);
        return out;
    } catch (err) {
        warnDumpFailure(err);
        return null;
    }
}
