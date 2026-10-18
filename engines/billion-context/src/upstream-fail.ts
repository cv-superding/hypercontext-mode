/** Upstream transport failure taxonomy (#1263).
 *
 *  Field diagnosis of long-session failures (omp → bili → external proxy →
 *  upstream) was blind because every network error surfaced as a flattened
 *  `code=/message=` blob: a proxy that recycles the socket mid-CONNECT, an
 *  upstream that goes silent past the idle budget, and a client disconnect
 *  are three different remedies, but were indistinguishable in the log. This
 *  module owns the ONE classification used everywhere (fetchWithRetry's
 *  replay decision, formatUpstreamError's log prefix, the status snapshot).
 *
 *  Kept dependency-free and below both fetch-util and upstream-proxy so
 *  neither imports the other just for this (they already form an import
 *  edge upstream-proxy → fetch-util; adding the reverse would be a cycle). */

export type UpstreamFailureKind =
    /** Downstream client disconnected (external abort fired). Nothing bili
     *  did or can retry — the request is dead by definition. */
    | "client-abort"
    /** Idle-budget / read-phase timeout expiry: our own watchdog aborted, or
     *  OS/undici reported a headers/body timeout. NOT retried — the budget
     *  already waited and the request may have reached the upstream. */
    | "upstream-timeout"
    /** Connect-phase timeout (undici UND_ERR_CONNECT_TIMEOUT): the TCP
     *  handshake never completed, so nothing reached the upstream and each
     *  attempt costs at most one connect timeout — replayed within the retry
     *  budget (#1453). */
    | "connect-timeout"
    /** Connect-phase reset THROUGH a proxy: socket died before the response
     *  started, and a proxy sits in the path — prime suspect is the proxy
     *  recycling the tunnel (idle recycle, payload cap, node churn). */
    | "proxy-reset"
    /** Same fail-fast reset, direct connection (no proxy): suspect the
     *  upstream or the local network, not a proxy. */
    | "upstream-reset"
    /** TCP refused — the proxy when one is configured, else the upstream. */
    | "connect-refused"
    /** Name resolution failed (ENOTFOUND / EAI_AGAIN). */
    | "dns"
    /** TLS/certificate failure at the proxy CONNECT or upstream handshake. */
    | "tls"
    | "unknown";

interface UpstreamFailCtx {
    /** A proxy dispatcher is in the path — changes reset/refused attribution. */
    viaProxy?: boolean;
    /** True when the caller's EXTERNAL abort signal (client disconnect) has
     *  fired. Without it, an AbortError is attributed to bili's own idle
     *  watchdog (upstream-timeout) — the common internal-abort shape. */
    externalAborted?: boolean;
}

function chainOf(error: unknown): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = [];
    let cur: unknown = error;
    for (let depth = 0; cur instanceof Error && depth < 8; depth++) {
        out.push(cur as unknown as Record<string, unknown>);
        cur = (cur as Error & { cause?: unknown }).cause;
    }
    return out;
}

/** Classify a transport-level failure into the diagnostic taxonomy. Pure:
 *  no IO, no clock — safe to call from anywhere, including tests. */
export function classifyUpstreamFailure(error: unknown, ctx: UpstreamFailCtx = {}): UpstreamFailureKind {
    if (ctx.externalAborted === true) return "client-abort";
    const chain = chainOf(error);
    if (chain.length === 0) return "unknown";
    for (const entry of chain) {
        const code = typeof entry.code === "string" ? entry.code : undefined;
        const name = typeof entry.name === "string" ? entry.name : undefined;
        if (code === undefined) {
            if (name === "AbortError") return "upstream-timeout";
            continue;
        }
        if (code === "UND_ERR_CONNECT_TIMEOUT") return "connect-timeout";
        if (code === "ETIMEDOUT" || code === "UND_ERR_HEADERS_TIMEOUT" || code === "UND_ERR_BODY_TIMEOUT") return "upstream-timeout";
        if (code === "ECONNRESET" || code === "EPIPE" || code === "ECONNABORTED" || code === "UND_ERR_SOCKET") return ctx.viaProxy ? "proxy-reset" : "upstream-reset";
        if (code === "ECONNREFUSED") return "connect-refused";
        if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "dns";
        // #1987: OpenSSL/undici certificate-TRUST codes (corporate interception /
        // MITM) are TLS failures too — before this they classified as "unknown",
        // losing the CA-remediation hint in logs and status output.
        if (code === "EPROTO" || code.startsWith("ERR_TLS") || code.startsWith("ERR_SSL") || code.startsWith("CERT_")
            || code.startsWith("DEPTH_ZERO_") || code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" || code === "SELF_SIGNED_CERT_IN_CHAIN" || code === "UNABLE_TO_GET_ISSUER_CERT_LOCALLY") return "tls";
    }
    return "unknown";
}

/** Fail-fast kinds: the attempt died BEFORE any response byte existed, so a
 *  replay cannot double-deliver anything. Per-attempt cost stays bounded —
 *  milliseconds for resets/refusals/DNS, at most one connect timeout for
 *  connect-timeout — so retrying never stacks the 12-min idle budget across
 *  attempts the way a headers/body timeout would (#1263, #1453). */
export function isFailFastUpstreamKind(kind: UpstreamFailureKind): boolean {
    return kind === "proxy-reset" || kind === "upstream-reset" || kind === "connect-refused" || kind === "connect-timeout" || kind === "dns";
}

/** One-line remediation hint per kind — used by logs and the docs so the
 *  taxonomy and the checklist never drift apart. */
export const UPSTREAM_FAIL_HINTS: Record<UpstreamFailureKind, string> = {
    "client-abort": "downstream client disconnected — no bili-side action",
    "upstream-timeout": "idle budget expired (headers/body) — check upstream health; not retried by design",
    "connect-timeout": "TCP handshake never completed — upstream/proxy unreachable or blackholed; a bounded transparent replay may be attempted (BILI_REPLAY_RETRY_MAX)",
    "proxy-reset": "proxy dropped the connection before the response — check proxy idle-recycle/payload limits (BILI_PROXY_KEEPALIVE_MAX_MS can shorten our reuse window); a bounded transparent replay may be attempted (BILI_REPLAY_RETRY_MAX)",
    "upstream-reset": "upstream/network reset before the response — check upstream and local network; a bounded transparent replay may be attempted (BILI_REPLAY_RETRY_MAX)",
    "connect-refused": "TCP refused (proxy when configured, else upstream) — endpoint down or wrong port",
    dns: "name resolution failed — DNS server or hostname typo; a bounded transparent replay may be attempted (BILI_REPLAY_RETRY_MAX)",
    tls: "TLS/certificate failure at CONNECT or upstream handshake — CA/proxy MITM config",
    unknown: "unclassified transport failure — report with full error chain",
};

/** Mask proxy credentials for display surfaces (log lines, 502 detail, the
 *  #2809 skipped-proxy note, alert payloads). Lives HERE instead of
 *  upstream-proxy so every renderer below that layer can share one
 *  implementation without a new import edge. */
export function redactProxyUrl(value: string | undefined): string | undefined {
    if (!value) return undefined;
    try {
        const url = new URL(value);
        if (url.username || url.password) {
            url.username = "***";
            url.password = "***";
        }
        return url.href;
    } catch {
        return "(invalid proxy URL)";
    }
}

/** #2809: an AVAILABLE proxy that default-direct mode skipped for this host —
 *  the value the auto-detect chain would have resolved. Raw on purpose: each
 *  display channel redacts per its own needs (see redactedSkippedProxy). */
export type SkippedProxyInfo = {
    proxy: string;
    /** Tier that offered it: an env var name ("HTTPS_PROXY") or "windows-system". */
    source: string;
};

/** Display form of a skipped proxy: credentials masked, the normalization
 *  trailing slash stripped so the note reads like a human wrote it. */
export function redactedSkippedProxy(skipped: SkippedProxyInfo): string {
    return (redactProxyUrl(skipped.proxy) ?? "").replace(/\/$/, "");
}

/** #2809 dead-end: a fail-fast failure under UNSET proxy mode reads
 *  "unreachable/blackholed" while the machine's own env/system proxy could
 *  reach the host fine — and no channel ever named that proxy. This appends
 *  the conditional suffix naming it plus the opt-in paths. Only fail-fast
 *  kinds qualify: a post-connect failure may have run on a working path,
 *  where "skipped proxy" would mislead. Diagnostic text only — egress
 *  decisions never read it. */
export function hintWithSkippedProxy(kind: UpstreamFailureKind, skipped: SkippedProxyInfo | undefined): string {
    const base = UPSTREAM_FAIL_HINTS[kind];
    if (!skipped || !isFailFastUpstreamKind(kind)) return base;
    return `${base}; available proxy ${redactedSkippedProxy(skipped)} (${skipped.source}) was skipped because upstreamProxyMode is unset (direct is the default by design, #346/#357) — follow it with "upstreamProxyMode": "auto" or BILI_UPSTREAM_PROXY_MODE=auto, or give this provider a "proxy" lane`;
}
