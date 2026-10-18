// zcode native MCP entry (#1145): spawned per-session by ZCode (mcp.servers.
// bili). Bootstraps a bili proxy, routes the provider store through it,
// verifies the ACP tool manifest BEFORE stamping the plugin-mode header
// (round 1 rides wire mode), then serves the ACP tools over stdio with a
// watchdog that respawns the proxy or reverts routing on its death. #1623:
// every tick also repairs a shared-store pointer left dead by ANY instance
// (last-writer-wins means our own death can strand it too), and exiting this
// process hands OUR pointer off instead of leaving a dead port behind. Logs
// go through the shared bili.log tee because zcode does not capture this
// child's stderr.

import { runMcpStdio } from "../mcp.js";
import { fetchManifest } from "../agent/shared.js";
import { readProxyInstanceFile } from "../instance.js";
import { nativeProxyScriptPath } from "../agent/native-bootstrap.js";
import { resolveZcodeNativePort } from "../config.js";
import { closeLogger, configureLogger, log as teeLog } from "../logger.js";
import { defaultLogFile } from "../paths.js";
import { LAUNCHER_DEFAULT_HOST, ensureProxyRunning } from "../launcher.js";
import type { ZcodeRoutePolicy } from "./json-edit.js";
import {
    activateZcodePluginMode,
    bootstrapZcodeNative,
    handoffZcodeRoutingOnExit,
    probeProxyHealth,
    repairSharedStoreDrift,
    routeZcodeConfig,
    unrouteZcode,
    zcodePolicyFromEnv,
} from "./native.js";

const WATCHDOG_INTERVAL_MS = 30000;
const WATCHDOG_FAILURE_LIMIT = 3;
const HANDOFF_TIMEOUT_MS = 5000;

function startWatchdog(
    state: { origin: string; policy: ZcodeRoutePolicy },
    attached: boolean,
    log: (msg: string) => void,
): void {
    let failures = 0;
    let busy = false;
    const timer = setInterval(() => {
        if (busy) return;
        busy = true;
        void watchdogTick().catch((err) => log(`watchdog error: ${err instanceof Error ? err.message : String(err)}`))
            .finally(() => { busy = false; });

        async function watchdogTick(): Promise<void> {
            if (await probeProxyHealth(state.origin)) {
                failures = 0;
            } else {
                failures += 1;
                if (failures >= WATCHDOG_FAILURE_LIMIT) {
                    if (attached) {
                        log(`attached proxy ${state.origin} unhealthy — waiting for it to recover`);
                    } else {
                        // #1660: same zone semantics as
                        // zcode/native.ts defaultEnsureProxy — explicit
                        // BILI_ZCODE_PORT is strict; otherwise port 0 lets the
                        // launcher resolve the zone preference AND settle the
                        // actually-bound port sticky (#1660).
                        const explicit = resolveZcodeNativePort();
                        const handle = await ensureProxyRunning(
                            { host: LAUNCHER_DEFAULT_HOST, port: explicit ?? 0, passthrough: false, debug: false, strictPort: explicit !== undefined, lane: "zcode" },
                            { scriptPath: nativeProxyScriptPath() },
                        );
                        if (handle.origin !== state.origin) {
                            process.env.BILI_MCP_PROXY = handle.origin;
                            const routed = await routeZcodeConfig({ origin: handle.origin, log, policy: state.policy });
                            if (!routed) throw new Error("proxy respawned but the zcode config rewrite failed");
                            await activateZcodePluginMode(routed, { log });
                            state.origin = handle.origin;
                            log(`proxy respawned at ${handle.origin} — config re-routed`);
                        }
                    }
                    failures = 0;
                }
            }
            await repairSharedStoreDrift({ selfOrigin: state.origin, log });
        }
    }, WATCHDOG_INTERVAL_MS);
    timer.unref?.();
}

function installExitHandoff(state: { origin: string }, log: (msg: string) => void): void {
    let started = false;
    const handoff = (exitCode: number | undefined) => {
        if (started) return;
        started = true;
        const timeout = new Promise<void>((resolve) => setTimeout(resolve, HANDOFF_TIMEOUT_MS).unref?.());
        void Promise.race([
            handoffZcodeRoutingOnExit({ ownOrigin: state.origin, log }).catch((err) => {
                log(`exit handoff failed: ${err instanceof Error ? err.message : String(err)}`);
            }),
            timeout,
        ]).then(() => { if (exitCode !== undefined) process.exit(exitCode); });
    };
    process.once("SIGTERM", () => handoff(143));
    process.once("SIGINT", () => handoff(130));
    process.once("beforeExit", () => handoff(undefined));
}

/** Candidate proxies an idle/degraded entry may still serve through
 *  (#1892): explicit pin, then the instance file the launcher keeps fresh,
 *  then the default port. First candidate that answers the health probe
 *  wins. */
async function discoverHealthyProxyOrigin(log: (msg: string) => void): Promise<string | undefined> {
    const candidates: string[] = [];
    const pinned = process.env.BILI_MCP_PROXY?.trim();
    if (pinned) candidates.push(pinned);
    try {
        const rec = readProxyInstanceFile();
        if (rec && /^https?:\/\/\S+$/.test(rec.origin) && !candidates.includes(rec.origin)) candidates.push(rec.origin);
    } catch {
        /* unreadable instance file — fall through */
    }
    candidates.push(process.env.BILI_MCP_DEFAULT_ORIGIN?.trim() || "http://127.0.0.1:8787");
    for (const origin of candidates) {
        try {
            if (await probeProxyHealth(origin)) return origin;
        } catch {
            /* probe failures just move to the next candidate */
        }
    }
    log(`no healthy bili proxy found (tried ${candidates.join(", ")})`);
    return undefined;
}

/** Serve the MCP endpoint without native routing (#1892): a cert-MITM box
 *  usually has a live proxy — serve the real ACP tools through it (whatever
 *  traffic that proxy already intercepts); otherwise stay an idle MCP server
 *  with an empty tool list. Either way the handshake completes instead of
 *  the child dying before initialize ("Connection closed"). */
async function serveDegraded(reason: string, log: (msg: string) => void): Promise<void> {
    const origin = await discoverHealthyProxyOrigin(log);
    if (origin) {
        process.env.BILI_MCP_PROXY = origin;
        try {
            const tools = await fetchManifest(origin, "anthropic");
            if (tools.length > 0) {
                log(`degraded: serving the ACP tools via the existing proxy at ${origin} — native routing is inactive, compression rides whatever traffic that proxy already intercepts (cert-MITM)`);
                runMcpStdio();
                return;
            }
        } catch {
            log(`degraded: proxy at ${origin} answered but served no ACP manifest`);
        }
    }
    log(`degraded: serving an idle MCP endpoint (${reason})`);
    await closeLogger();
    runMcpStdio({ degraded: reason });
}

export async function main(): Promise<void> {
    if (process.env.NODE_TEST_CONTEXT !== undefined) return;
    configureLogger(defaultLogFile());
    const log = (msg: string) => teeLog("info", `[bili-zcode] ${msg}`);
    let bootstrap;
    try {
        bootstrap = await bootstrapZcodeNative({ log });
    } catch (err) {
        log(`bootstrap failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!bootstrap) {
        // bootstrap threw (attach target died mid-boot, spawn failure…):
        // diagnostics are already logged. Serve idle — a plugin child that
        // dies pre-handshake is the louder failure (#1892).
        await serveDegraded("bootstrap failed (see the bili log)", log);
        return;
    }
    if (bootstrap.mode === "off") {
        unrouteZcode({ log });
        await serveDegraded("native routing is off (BILI_ZCODE_ROUTE=none or a kill-switch)", log);
        return;
    }
    if (bootstrap.mode === "degraded") {
        await serveDegraded(`native routing found nothing to wrap (${bootstrap.reason}) — see the bili log for next steps`, log);
        return;
    }
    const applied = bootstrap.routed;
    if (!applied) {
        await serveDegraded("the provider store changed under us — nothing was wrapped (see the bili log)", log);
        return;
    }
    process.env.BILI_MCP_PROXY = applied.origin;
    try {
        const tools = await fetchManifest(applied.origin, "anthropic");
        if (tools.length === 0) throw new Error("manifest returned no tools");
    } catch (err) {
        log(`ACP manifest unavailable — leaving plugin mode off: ${err instanceof Error ? err.message : String(err)}`);
        unrouteZcode({ log });
        await serveDegraded("the ACP manifest was unavailable — routing was reverted (see the bili log)", log);
        return;
    }
    await activateZcodePluginMode(applied, { log });
    // #1622: the watchdog respawn path must re-route with the SAME policy
    // (BILI_ZCODE_ROUTE / providers direct) — not the hardcoded default.
    const state = { origin: applied.origin, policy: zcodePolicyFromEnv(process.env) };
    startWatchdog(state, bootstrap.attached, log);
    installExitHandoff(state, log);
    runMcpStdio();
}

if (process.argv[1] && /(?:^|[\\/])mcp-entry\.(?:ts|js)$/.test(process.argv[1])) {
    main().catch(async (err) => {
        process.stderr.write(`[bili-zcode] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
        await closeLogger();
        process.exit(1);
    });
}
