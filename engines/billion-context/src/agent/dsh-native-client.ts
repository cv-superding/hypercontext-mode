// #1590: browser half of the dsh dual-face plugin (dsh.client). The tsup
// build wraps this CJS body in window.__ModuleLoader__.load({id, factory}) —
// two load-bearing invariants invisible from this file alone: the id MUST
// equal the loader entry name the scanner keys its graph row by ("loaded
// without registering" otherwise), and the factory's `require` resolves only
// through dsh's module system, so react is the sole permitted external.
// Origin discovery has two paths (#1809): the host half (dsh-native.ts)
// injects globalThis.__BILI__ = {origin} into the web index at render time —
// a boot-time snapshot that a page loaded before spawn-mode bootstrap (or a
// desktop boot payload, captured once per app launch) never carries — and it
// serves the live origin at GET /bili/origin on the dsh webserver. The
// snapshot is only a FIRST-PAINT HINT (#2288): attach-mode presets publish
// the env origin at startup while the host re-binds it at runtime (dead-attach
// fallback spawn, routed-origin convergence), so freezing on whatever the page
// captured left the button pointing at a dead URL for the whole session. This
// section therefore keeps polling the live route for the whole mount (fast
// until the first resolution, slow after) and the entry follows wherever the
// proxy actually listens — no reload or app restart. Neither source known ⇒
// degrade to a hint instead of a dead link. #2321: once bound, the panel
// embeds the REAL web UI — a native tab bar (overview/sessions/config/logs)
// driving one iframe at origin/__bili/ with ?embed=1 plus a hash route; tab
// switches move only the fragment, so the frame navigates same-document
// (hashchange) without a full reload — and since its src tracks the polled
// origin, a mid-session re-bind moves the frame in place too. The
// open-in-browser button survives as the escape hatch; #2448: the host panel
// is a NARROW column, so the backup button keeps the origin in a tooltip
// instead of the label (a URL + nowrap squeezed the hint row into a sliver)
// and the frame height follows the host viewport. lang mirrors the host
// locale: bind() resolves against the live dsh locale, and comparing the
// resolved nav label with the registered zh value is the only locale signal
// the client contract exposes. #2559: theme follows the HOST page too —
// an app-level dsh dark setting is invisible to the framed document's
// prefers-color-scheme, so we sample the actual on-screen ground of this page
// (same-origin) and pin the face via &theme=light|dark; first paint reads it
// synchronously, later probe ticks pick up mid-session toggles. The same panel is mounted at two slots (#2125): settings.section
// (always present — the launcher posture has no bundle page) and
// plugins.bundle.config (keyed by package name; the plugin detail page renders
// it only when this package is installed as a profile bundle and draws the
// title itself, so that registration drops the h3).

import { createElement, useEffect, useState } from "react";

type Dict = Record<string, string>;

type SlotOptions =
    | { name: string; id: string; order: number; label: () => string; locale: string }
    | { name: string; key: string; locale: string };

type ClientContext = {
    effect: (fn: () => void | (() => void), label?: string) => void;
    locale: {
        register: (ns: string, dict: { zh: Dict; en: Dict }) => void;
        bind: (ns: string) => (key: string) => string;
    };
    slots: {
        inject: (slot: string, provide: () => void) => void;
        register: (options: SlotOptions, component: (props: Record<string, unknown>) => unknown) => unknown;
    };
};

export const inject = ["slots", "locale"];

const NS = "bili";

// #1809/#2187/#2288: live-origin probe cadence — first attempt immediate,
// then a retry every POLL_INTERVAL_MS for POLL_MAX_ATTEMPTS total (~30s),
// after which probing CONTINUES at SLOW_POLL_INTERVAL_MS until the page
// unmounts. #2187: the server side now heals a failed spawn-mode bootstrap
// in the background and a slow Windows boot can take minutes, so stopping at
// ~30s stranded the entry on "not bound" for the whole session. #2288: the
// slow phase also runs AFTER the first resolution — the host re-binds the
// origin mid-session (runtime re-spawn, routed-origin convergence), so the
// entry keeps following the live route instead of freezing on the first value.
const ORIGIN_PATH = "/bili/origin";
const POLL_INTERVAL_MS = 3000;
const POLL_MAX_ATTEMPTS = 10;
const SLOW_POLL_INTERVAL_MS = 10000;

// #2321: pages offered by the embedded face, in tab-bar order. Labels mirror
// the web UI's own nav terminology (src/web/i18n.ts) so each tab reads like
// the title of the page inside the frame. "connect" stays out: it documents
// how OTHER clients reach this proxy, which makes no sense from inside dsh.
const PAGE_IDS = ["overview", "sessions", "config", "logs"] as const;
type PageId = (typeof PAGE_IDS)[number];
const PAGE_KEYS: Record<PageId, string> = {
    overview: "tab_overview",
    sessions: "tab_sessions",
    config: "tab_config",
    logs: "tab_logs",
};
const EMBED_HEIGHT = "min(640px, 78vh)";

// #3100: pre-flight for the framed face. Auto-update refreshes the profile
// bundle on DISK while the long-running proxy child keeps serving the code it
// booted with — and this browser half always runs the freshest disk code — so
// right after an update it frames a route the frozen server may not have yet
// (the query form landed in v0.1.189; older builds answer it with a raw JSON
// 404 inside the frame). Probe the exact embed URL once per origin BEFORE
// mounting: HTML ⇒ mount the frame; any other answer ⇒ the running build
// predates the route ⇒ show the restart notice instead (the backup button
// targets the bare /__bili/ form every build serves). A network error yields
// no verdict — the origin poll re-probes on its regular ticks. Verdicts are
// cached per origin for the page lifetime: a frozen process cannot gain
// routes mid-session.
const EMBED_PROBE_PATH = "/__bili/?embed=1";
type EmbedVerdict = "ok" | "stale";
type EmbedState = { origin: string; verdict: EmbedVerdict };
const embedVerdicts = new Map<string, EmbedVerdict>();
const embedProbesInFlight = new Set<string>();

function probeEmbedRoute(origin: string, onVerdict: (state: EmbedState) => void): void {
    if (typeof fetch !== "function") return;
    const cached = embedVerdicts.get(origin);
    if (cached !== undefined) {
        onVerdict({ origin, verdict: cached });
        return;
    }
    if (embedProbesInFlight.has(origin)) return;
    embedProbesInFlight.add(origin);
    void fetch(`${origin}${EMBED_PROBE_PATH}`)
        .then((res) => {
            let html = false;
            try {
                const ct = typeof res.headers.get === "function" ? res.headers.get("content-type") : "";
                html = res.ok && String(ct ?? "").includes("text/html");
            } catch {
                html = false;
            }
            const verdict: EmbedVerdict = html ? "ok" : "stale";
            embedVerdicts.set(origin, verdict);
            try {
                void res.body?.cancel?.().catch(() => {});
            } catch {
                // non-stream body (harness): nothing to release
            }
            onVerdict({ origin, verdict });
        })
        .catch(() => {
            // unreachable right now: no verdict, the next poll tick retries
        })
        .finally(() => {
            embedProbesInFlight.delete(origin);
        });
}

/** #2559: classify the host page's actual ground as light/dark. The framed
 *  bili face is a separate document — it only sees the browser/OS
 *  color-scheme, while dsh's dark theme is app-level. Same origin lets us
 *  sample what the user actually sees: walk the usual ground candidates,
 *  read each opaque background-color, vote by simple weighted luminance
 *  (near-black app grounds < 0.4, near-white > 0.4). No readable signal at
 *  all ⇒ fall back to the OS signal; nothing even for that ⇒ undefined and
 *  the frame stays OS-driven. Every read is guard-wrapped: older hosts or
 *  minimal DOMs must degrade to "no pin", never crash the panel. */
type ThemeDom = {
    document?: { documentElement?: unknown; body?: { querySelector?: (sel: string) => unknown } & Record<string, unknown> };
    getComputedStyle?: (el: unknown) => { backgroundColor?: unknown };
    matchMedia?: (q: string) => { matches: boolean };
};
function detectHostTheme(): "light" | "dark" | undefined {
    const g = globalThis as ThemeDom;
    try {
        const doc = g.document;
        if (!doc || typeof g.getComputedStyle !== "function") return undefined;
        const candidates: unknown[] = [];
        if (doc.documentElement) candidates.push(doc.documentElement);
        if (doc.body) candidates.push(doc.body);
        try {
            for (const sel of ["main", "[role=main]", "#root", "#app"]) {
                const el = doc.body?.querySelector?.(sel);
                if (typeof el === "object" && el !== null) candidates.push(el);
            }
        } catch {
            // non-DOM harness: ground sampling below just yields no votes
        }
        let lightVotes = 0;
        let darkVotes = 0;
        for (const c of candidates) {
            let bg: string;
            try {
                const v = g.getComputedStyle!(c).backgroundColor;
                if (typeof v !== "string") continue;
                bg = v;
            } catch {
                continue;
            }
            const m = /rgba?\(([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\/\s]+([\d.]+))?\)/.exec(bg);
            if (!m) continue; // transparent / named / unparsable → no vote
            const alpha = m[4] !== undefined ? Number(m[4]) : 1;
            if (alpha <= 0.5) continue;
            const luma = (0.2126 * Number(m[1]) + 0.7152 * Number(m[2]) + 0.0722 * Number(m[3])) / 255;
            if (luma <= 0.4) darkVotes += 1;
            else lightVotes += 1;
        }
        if (darkVotes !== lightVotes && (darkVotes > 0 || lightVotes > 0)) return darkVotes > lightVotes ? "dark" : "light";
    } catch {
        return undefined;
    }
    try {
        const mq = g.matchMedia?.("(prefers-color-scheme: dark)");
        if (mq) return mq.matches ? "dark" : "light";
    } catch {
        // no media support either — leave the face OS-driven
    }
    return undefined;
}

const zh: Dict = {
    "nav": "bili设置",
    "title": "billion-context 压缩代理",
    "open": "打开 Web UI",
    "hint": "查看压缩状态、会话与上下文窗口。",
    "degraded": "当前 dsh 进程未绑定 bili 代理（未经 bili dsh 启动，或代理尚未就绪）——先运行 /acp，或改用 bili dsh 启动。",
    "connecting": "正在连接 bili 代理…",
    "stale": "运行中的 bili 代理比已安装的配置文件旧：本页面已加载新版界面，但代理进程仍在提供旧版服务，暂时无法打开内嵌页面。若本应用已运行新版本，启动一个新会话即会自动换上新代理（也可手动结束旧代理进程立即生效）；若应用本身还是旧版本，请完全退出并重新启动 dsh。恢复前可点下方按钮直接打开 Web UI。",
    "tab_overview": "总览",
    "tab_sessions": "会话",
    "tab_config": "配置",
    "tab_logs": "日志",
};

const en: Dict = {
    "nav": "bili",
    "title": "billion-context compression proxy",
    "open": "Open Web UI",
    "hint": "Inspect compression status, sessions and context windows.",
    "degraded": "This dsh process is not bound to a bili proxy (not launched via bili dsh, or the proxy is not up yet) — run /acp first, or launch through bili dsh.",
    "connecting": "Connecting to the bili proxy…",
    "stale": "The running bili proxy is older than the installed profile: this page already runs the new face, but the proxy process still serves the old build, so the embedded page cannot be opened yet. If this app itself runs the new version, starting a new session swaps in the new proxy automatically (or kill the old proxy process manually for an immediate switch); if the app itself is still on the old version, fully quit and relaunch dsh. Until then, use the button below to open the Web UI directly.",
    "tab_overview": "Overview",
    "tab_sessions": "Sessions",
    "tab_config": "Config",
    "tab_logs": "Logs",
};

function readOrigin(): string | undefined {
    const g = globalThis as { __BILI__?: { origin?: unknown; relay?: unknown } };
    const snap = g.__BILI__;
    // #3373: relay snapshot — the entry serves the admin surface itself, so
    // the base is same-origin ("" = entry-relative paths). Prefix gateways
    // correct this to an absolute base on the first live probe.
    if (snap !== undefined && snap.relay === true) return "";
    const origin = snap?.origin;
    return typeof origin === "string" && origin.length > 0 ? origin : undefined;
}

function openExternal(url: string): void {
    const w = globalThis as { open?: (url: string, target?: string, features?: string) => unknown };
    if (typeof w.open === "function") w.open(url, "_blank", "noopener,noreferrer");
}

/** #3373: relay mode — the probe response carries `relay: true` instead of
 *  a loopback origin. Derive the UI base from the probe's own response URL:
 *  whatever origin+prefix carried the probe also serves /__bili/. An empty
 *  base means same-origin paths (root deployments, test harnesses). */
function relayBaseOf(res: { url?: unknown }): string {
    const url = typeof res.url === "string" ? res.url : "";
    if (url.endsWith(ORIGIN_PATH)) {
        const base = url.slice(0, -ORIGIN_PATH.length).replace(/\/+$/, "");
        return base.length > 0 ? base : "";
    }
    return "";
}

// #3373: gateways that mount dsh web under a path prefix re-map every URL
// the index references, so the absolute probe path misses. Probe relative to
// the page's own base as a second form; the last form that answered wins the
// next tick (direct hosts never leave the primary form).
let winningProbeForm: string | undefined;

function probeForms(): string[] {
    if (winningProbeForm !== undefined) return [winningProbeForm];
    const doc = (globalThis as { document?: { baseURI?: unknown } }).document;
    const baseURI = typeof doc?.baseURI === "string" && doc.baseURI.length > 0 ? doc.baseURI : undefined;
    if (baseURI === undefined) return [ORIGIN_PATH];
    try {
        const fallback = new URL("bili/origin", baseURI).toString();
        return fallback === ORIGIN_PATH ? [ORIGIN_PATH] : [ORIGIN_PATH, fallback];
    } catch {
        return [ORIGIN_PATH];
    }
}

/** #1809/#2187/#2288: follow the host's live origin route for the lifetime
 *  of the mount; returns the cancel used as the effect cleanup (no fetch ⇒
 *  no-op, older hosts without the route simply stay on the snapshot or
 *  degrade). The snapshot is only a first-paint hint — the host re-binds the
 *  origin at runtime, so polling never stops after a resolution.
 *  #2559: every successful tick also re-classifies the host ground and pushes
 *  a fresh theme pin — mid-session theme toggles land within one slow phase.
 *  No extra timers are scheduled here (the test pins in tests/dsh-settings-ui
 *  count every delay on this queue). */
function probeOrigin(onOrigin: (origin: string) => void, onTheme?: (theme: "light" | "dark") => void, onTick?: (origin: string) => void): () => void {
    if (typeof fetch !== "function") return () => {};
    let cancelled = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    const poll = async (): Promise<void> => {
        // #3373: try the known-good form first — under a path-prefix gateway
        // that becomes the relative form after its first hit.
        let sawOk = false;
        for (const form of probeForms()) {
            try {
                const res = await fetch(form);
                if (!res.ok) continue;
                sawOk = true;
                const data = (await res.json()) as { origin?: unknown; relay?: unknown };
                let bind: string | undefined;
                if (data.relay === true) bind = relayBaseOf(res);
                else if (typeof data.origin === "string" && data.origin.length > 0) bind = data.origin;
                if (bind !== undefined && !cancelled) {
                    winningProbeForm = form;
                    onOrigin(bind);
                    settled = true;
                    // #3100: every resolution is also an embed-probe retry slot —
                    // a snapshot-only origin (older hosts without the route)
                    // never flows through onOrigin again after mount.
                    if (onTick !== undefined) onTick(bind);
                    break;
                }
            } catch {
                // host without the route (older builds) or transient error: try the next form
            }
        }
        if (sawOk && onTheme && !cancelled) {
            const theme = detectHostTheme();
            if (theme !== undefined) onTheme(theme);
        }
        if (cancelled) return;
        attempts += 1;
        // #2187/#2288: fast phase until the first resolution, then an endless
        // slow phase — the origin can land (background heal) or move
        // (runtime re-bind) at any time.
        const delay = !settled && attempts < POLL_MAX_ATTEMPTS ? POLL_INTERVAL_MS : SLOW_POLL_INTERVAL_MS;
        if (!cancelled) timer = setTimeout(() => void poll(), delay);
    };
    void poll();
    return () => {
        cancelled = true;
        if (timer !== undefined) clearTimeout(timer);
    };
}

export function apply(ctx: ClientContext): void {
    const zhDict = zh;
    const enDict = en;
    ctx.effect(
        () => ctx.locale.register(NS, { zh: zhDict, en: enDict }),
        "bili: dictionaries",
    );
    const t = ctx.locale.bind(NS);
    const panel = (titled: boolean): ((props: Record<string, unknown>) => unknown) => () => {
        const [origin, setOrigin] = useState<string | undefined>(readOrigin());
        const [page, setPage] = useState<PageId>("overview");
        // #2559: synchronous first paint — the very first render already pins
        // the palette to the host's current ground (no wrong-scheme flash).
        const [theme, setTheme] = useState<("light" | "dark") | undefined>(detectHostTheme);
        // #3100: embed pre-flight verdict for the CURRENT origin — a verdict
        // recorded for a previous origin (mid-session re-bind) is stale by
        // definition and reads as "pending" until its own probe lands.
        const [embed, setEmbed] = useState<EmbedState | undefined>(() => {
            const o = readOrigin();
            const v = o !== undefined ? embedVerdicts.get(o) : undefined;
            return o !== undefined && v !== undefined ? { origin: o, verdict: v } : undefined;
        });
        // #2288: no guard on the snapshot — the live route is authoritative
        // for the whole mount, so a stale boot value is corrected in place.
        // #3100: each resolution also probes the new origin's embed route in
        // flight, and every tick re-drives pending origins (snapshot-only
        // hosts never resolve through this path again after mount).
        useEffect(
            () =>
                probeOrigin(
                    (o) => {
                        setOrigin(o);
                        probeEmbedRoute(o, setEmbed);
                    },
                    setTheme,
                    (o) => probeEmbedRoute(o, setEmbed),
                ),
            [],
        );
        // #3100: mount-time probe for a snapshot origin and re-probe on any
        // origin change (covers hosts whose live route never answers).
        useEffect(() => {
            if (origin !== undefined) probeEmbedRoute(origin, setEmbed);
        }, [origin]);
        const liveEmbed: EmbedVerdict | undefined = embed !== undefined && embed.origin === origin ? embed.verdict : undefined;
        const lang = t("nav") === zhDict.nav ? "zh" : "en";
        // The open-in-browser action button. One shared builder so the two
        // placements (embedded-tab row, degraded/stale footer) cannot drift:
        // same label, same tooltip, same jump target. Returns null while the
        // origin is unknown — there is nothing to open yet.
        const openWebButton = (style?: Record<string, string>): ReturnType<typeof createElement> =>
            origin === undefined
                ? null
                : createElement(
                    "button",
                    {
                        type: "button",
                        title: origin,
                        onClick: () => openExternal(`${origin}/__bili/`),
                        style: {
                            cursor: "pointer",
                            borderRadius: 8,
                            border: "1px solid rgba(127,127,127,0.4)",
                            background: "transparent",
                            color: "inherit",
                            fontFamily: "inherit",
                            fontSize: 14,
                            lineHeight: "22px",
                            padding: "7px 16px",
                            whiteSpace: "nowrap",
                            ...style,
                        },
                    },
                    t("open"),
                );
        let middle: unknown;
        if (origin === undefined) {
            middle = createElement("p", { style: { margin: 0, opacity: 0.7, lineHeight: 1.6 } }, t("degraded"));
        } else if (liveEmbed === "stale") {
            middle = createElement("p", { style: { margin: 0, opacity: 0.7, lineHeight: 1.6 } }, t("stale"));
        } else if (liveEmbed === "ok") {
            middle = createElement(
                "div",
                { style: { display: "flex", flexDirection: "column", gap: 10 } },
                createElement(
                    "div",
                    { style: { display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" } },
                    PAGE_IDS.map((id) =>
                        createElement(
                            "button",
                            {
                                key: id,
                                type: "button",
                                onClick: () => setPage(id),
                                style: {
                                    cursor: "pointer",
                                    borderRadius: 8,
                                    border: id === page ? "1px solid rgba(127,127,127,0.7)" : "1px solid rgba(127,127,127,0.4)",
                                    background: id === page ? "rgba(127,127,127,0.12)" : "transparent",
                                    color: "inherit",
                                    fontFamily: "inherit",
                                    fontSize: 13,
                                    fontWeight: id === page ? 600 : 400,
                                    lineHeight: "20px",
                                    padding: "4px 14px",
                                },
                            },
                            t(PAGE_KEYS[id]),
                        ),
                    ),
                    // The open-in-browser action rides the TAB row — right
                    // after the logs tab, pushed to the row's far end —
                    // instead of sitting in the footer below the iframe.
                    openWebButton({ marginLeft: "auto", fontSize: "13", lineHeight: "20px", padding: "4px 14px" }),
                ),
                createElement("iframe", {
                    src: `${origin}/__bili/?embed=1&lang=${lang}${theme ? `&theme=${theme}` : ""}#/${page}`,
                    title: t("title"),
                    style: {
                        display: "block",
                        width: "100%",
                        height: EMBED_HEIGHT,
                        border: "1px solid rgba(127,127,127,0.4)",
                        borderRadius: 8,
                        background: "transparent",
                    },
                }),
            );
        } else {
            middle = createElement("p", { style: { margin: 0, opacity: 0.7, lineHeight: 1.6 } }, t("connecting"));
        }
        return createElement(
            "div",
            { style: { display: "flex", flexDirection: "column", gap: 12, padding: "20px 8px" } },
            titled ? createElement("h3", { style: { margin: 0, fontSize: 16, fontWeight: 600 } }, t("title")) : null,
            middle,
            createElement(
                "div",
                { style: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" } },
                createElement("p", { style: { margin: 0, opacity: 0.7, fontSize: 13, lineHeight: 1.6, flex: 1, minWidth: 200 } }, t("hint")),
                // ok 状态:按钮在上方页签行(日志页签后面);degraded/stale
                // 仍留在页脚作后备入口(#2448 同一按钮)。
                liveEmbed === "ok" ? null : openWebButton(),
            ),
        );
    };
    ctx.slots.inject(
        "settings.section",
        () => ctx.slots.register({ name: "settings.section", id: "bili", order: 100, label: () => t("nav"), locale: NS }, panel(true)),
    );
    ctx.slots.inject(
        "plugins.bundle.config",
        () => ctx.slots.register({ name: "plugins.bundle.config", key: "billion-context", locale: NS }, panel(false)),
    );
}
