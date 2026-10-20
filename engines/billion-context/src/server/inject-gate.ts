import type { ProxyOptions } from "../config.js";
import type { Session } from "../session.js";
import { estimateRawBodyTokens } from "../preflight.js";

type Log = (level: string, msg: string) => void;

export function injectionGateOpen(
    opts: ProxyOptions,
    parsed: unknown,
    session: Session,
    log?: Log,
): boolean {
    const threshold = opts.compress.injectAfterTokens ?? 0;
    if (threshold <= 0) return true;
    if (session.metadata.injectionGateOpen === true) return true;

    const tokens = estimateRawBodyTokens(parsed);
    session.metadata.injectionGateTokens = tokens;
    session.metadata.injectionGateThreshold = threshold;
    if (tokens < threshold) {
        session.metadata.injectionGateOpen = false;
        return false;
    }
    session.metadata.injectionGateOpen = true;
    session.metadata.injectionGateOpenedAt = Date.now();
    log?.("info", `[cold-start] compression injection enabled at ${tokens} >= ${threshold} tokens`);
    return true;
}

export function injectionEnabled(opts: ProxyOptions, parsed: unknown, session: Session, log?: Log): boolean {
    return opts.compress.injectTool && injectionGateOpen(opts, parsed, session, log);
}

export function nudgeEnabled(opts: ProxyOptions, parsed: unknown, session: Session, log?: Log): boolean {
    return opts.compress.injectNudge && injectionGateOpen(opts, parsed, session, log);
}
