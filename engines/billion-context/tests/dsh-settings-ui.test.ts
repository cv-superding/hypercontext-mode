import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import vm from "node:vm";
import { apply, _resetRegisterForTest } from "../src/agent/dsh-native.ts";
import { rmrf } from "./tmp-rm.ts";

// The node:test runner sets NODE_TEST_CONTEXT itself (see tests/e2e/README.md);
// set it defensively so a direct single-file run also stands down the spawn
// bootstrap and the global fetch intercept.
process.env.NODE_TEST_CONTEXT = process.env.NODE_TEST_CONTEXT ?? "1";

async function withEnv<T>(env: Record<string, string | undefined>, fn: () => Promise<T> | T): Promise<T> {
    const prev: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(env)) {
        prev[key] = process.env[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    try {
        return await fn();
    } finally {
        for (const [key, value] of Object.entries(prev)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
}

function startManifestProxy(): Promise<{ origin: string; close: () => void }> {
    const server = http.createServer((req, res) => {
        if ((req.url ?? "").startsWith("/__bili/plugin/manifest")) {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ version: "0.1.166", tools: { anthropic: [] } }));
            return;
        }
        res.writeHead(404);
        res.end("{}");
    });
    return new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => {
            const port = (server.address() as { port: number }).port;
            resolve({ origin: `http://127.0.0.1:${port}`, close: () => server.close() });
        });
    });
}

// #3373: hermetic config isolation — the relay gate reads the real config
// file unless pointed elsewhere; a machine with security.adminRelay on must
// not flip these tests.
function emptyConfigFile(home: string): string {
    const file = path.join(home, "bili-config.json");
    fs.writeFileSync(file, "{}");
    return file;
}

type InjectRow = { kind: string; name?: string; value?: unknown };
type InjectListener = (table: InjectRow[]) => void;

function uiCtx(listeners: InjectListener[]) {
    return {
        tools: { register: (_t: unknown) => {} },
        commands: { register: (_c: unknown) => {} },
        agents: { currentInitiator: () => ({ session: { id: "s-1590" } }) },
        inject: (_deps: readonly string[], _cb: (sub: unknown) => void) => {},
        on: (event: string, listener: InjectListener) => {
            if (event === "webserver/index-inject") listeners.push(listener);
        },
    };
}

test("#1590: webserver/index-inject publishes __BILI__ while an origin is known (attach mode)", async () => {
    const proxy = await startManifestProxy();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-ui-"));
    try {
        await withEnv({ DSH_HOME: home, BILLION_CONTEXT_PROXY: proxy.origin, BILI_CONFIG_FILE: emptyConfigFile(home) }, async () => {
            _resetRegisterForTest(proxy.origin);
            const listeners: InjectListener[] = [];
            apply(uiCtx(listeners) as Parameters<typeof apply>[0]);
            // attach mode binds register.base synchronously before the async
            // liveness probe, so a startup-time collection already sees it.
            assert.equal(listeners.length, 1);
            const table: InjectRow[] = [];
            listeners[0](table);
            assert.deepEqual(table, [{ kind: "global", name: "__BILI__", value: { origin: proxy.origin } }]);
        });
    } finally {
        proxy.close();
        rmrf(home);
    }
});

test("#1590: index-inject stays silent when no origin is known yet (spawn mode)", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-ui-"));
    try {
        await withEnv({ DSH_HOME: home, BILLION_CONTEXT_PROXY: undefined, BILI_CONFIG_FILE: emptyConfigFile(home) }, async () => {
            _resetRegisterForTest(undefined);
            const listeners: InjectListener[] = [];
            apply(uiCtx(listeners) as Parameters<typeof apply>[0]);
            assert.equal(listeners.length, 1);
            const table: InjectRow[] = [];
            listeners[0](table);
            assert.deepEqual(table, []);
        });
    } finally {
        rmrf(home);
    }
});

type RouteRow = { kind: string; path: string; handler: (req: unknown, res: FakeRes) => void | Promise<void> };

class FakeRes {
    status?: number;
    headers?: Record<string, string>;
    body = "";
    writeHead(status: number, headers?: Record<string, string>): void {
        this.status = status;
        this.headers = headers;
    }
    end(body?: string): void {
        this.body = body ?? "";
    }
}

function routeCtx(routes: RouteRow[], listeners: InjectListener[]) {
    return {
        tools: { register: (_t: unknown) => {} },
        commands: { register: (_c: unknown) => {} },
        agents: { currentInitiator: () => ({ session: { id: "s-1809" } }) },
        inject: (_deps: readonly string[], cb: (sub: unknown) => void) => {
            cb({ webServer: { register: (r: RouteRow) => routes.push(r) } });
        },
        on: (event: string, listener: InjectListener) => {
            if (event === "webserver/index-inject") listeners.push(listener);
        },
    };
}

test("#1809: live /bili/origin route reflects the bound origin", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-ui-"));
    try {
        await withEnv({ DSH_HOME: home, BILLION_CONTEXT_PROXY: undefined, BILI_CONFIG_FILE: emptyConfigFile(home) }, async () => {
            _resetRegisterForTest("http://127.0.0.1:8787");
            const routes: RouteRow[] = [];
            apply(routeCtx(routes, []) as Parameters<typeof apply>[0]);
            // #3373: the panel now registers two routes — the origin probe and
            // the /__bili admin relay (fail-closed while the gate is off).
            assert.equal(routes.length, 2);
            const originRoute = routes.find((r) => r.path === "/bili/origin")!;
            const relayRoute = routes.find((r) => r.path === "/__bili")!;
            assert.equal(originRoute.kind, "exact");
            assert.equal(relayRoute.kind, "prefix");
            const res = new FakeRes();
            await originRoute.handler({}, res);
            assert.equal(res.status, 200);
            assert.equal(res.headers?.["content-type"], "application/json");
            assert.deepEqual(JSON.parse(res.body), { origin: "http://127.0.0.1:8787" });
        });
    } finally {
        rmrf(home);
    }
});

test("#1809: /bili/origin answers null before binding", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-ui-"));
    try {
        await withEnv({ DSH_HOME: home, BILLION_CONTEXT_PROXY: undefined, BILI_CONFIG_FILE: emptyConfigFile(home) }, async () => {
            _resetRegisterForTest(undefined);
            const routes: RouteRow[] = [];
            apply(routeCtx(routes, []) as Parameters<typeof apply>[0]);
            assert.equal(routes.length, 2);
            const originRoute = routes.find((r) => r.path === "/bili/origin")!;
            const res = new FakeRes();
            await originRoute.handler({}, res);
            assert.deepEqual(JSON.parse(res.body), { origin: null });
        });
    } finally {
        rmrf(home);
    }
});

test("#1809: route registration rides the injected context's effect lifecycle", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-ui-"));
    try {
        await withEnv({ DSH_HOME: home, BILLION_CONTEXT_PROXY: undefined, BILI_CONFIG_FILE: emptyConfigFile(home) }, async () => {
            _resetRegisterForTest("http://127.0.0.1:8787");
            const routes: RouteRow[] = [];
            let disposed = 0;
            const effects: Array<{ fn: () => void | (() => void); label?: string }> = [];
            const ctx = {
                tools: { register: (_t: unknown) => {} },
                commands: { register: (_c: unknown) => {} },
                agents: { currentInitiator: () => ({ session: { id: "s-1809" } }) },
                inject: (_deps: readonly string[], cb: (sub: unknown) => void) => {
                    cb({
                        webServer: {
                            register: (r: RouteRow) => {
                                routes.push(r);
                                return (): void => { disposed += 1; };
                            },
                        },
                        effect: (fn: () => void | (() => void), label?: string) => {
                            effects.push({ fn, label });
                        },
                    });
                },
                on: (_event: string, _listener: InjectListener) => {},
            };
            apply(ctx as Parameters<typeof apply>[0]);
            assert.equal(effects.length, 1, "registration must be wrapped in the context effect");
            assert.equal(effects[0].label, "bili: panel routes (origin + admin relay)");
            const cleanup = effects[0].fn();
            assert.equal(routes.length, 2);
            // #3373 review: the effect fn must hand back a combined disposer —
            // dsh calls it on re-run to un-register BOTH routes; returning
            // undefined lets stale duplicates accumulate in the router table.
            assert.equal(typeof cleanup, "function", "the combined disposer doubles as the effect cleanup");
            (cleanup as () => void)();
            assert.equal(disposed, 2);
        });
    } finally {
        rmrf(home);
    }
});

type ElementNode = { type: string; props: Record<string, unknown> | null; children: unknown[] };

function collectText(node: unknown, out: string[]): void {
    if (typeof node === "string") {
        out.push(node);
        return;
    }
    if (Array.isArray(node)) {
        for (const child of node) collectText(child, out);
        return;
    }
    if (node !== null && typeof node === "object") {
        for (const child of (node as ElementNode).children ?? []) collectText(child, out);
    }
}

// The #2321 tab bar passes an ARRAY of buttons as one child, so every walker
// must descend into array children like collectText already does.
function findButton(node: unknown): ElementNode | undefined {
    if (Array.isArray(node)) {
        for (const child of node) {
            const hit = findButton(child);
            if (hit !== undefined) return hit;
        }
        return undefined;
    }
    if (node !== null && typeof node === "object") {
        const el = node as ElementNode;
        if (el.type === "button") return el;
        for (const child of el.children ?? []) {
            const hit = findButton(child);
            if (hit !== undefined) return hit;
        }
    }
    return undefined;
}

function findTag(node: unknown, type: string): ElementNode | undefined {
    if (Array.isArray(node)) {
        for (const child of node) {
            const hit = findTag(child, type);
            if (hit !== undefined) return hit;
        }
        return undefined;
    }
    if (node !== null && typeof node === "object") {
        const el = node as ElementNode;
        if (el.type === type) return el;
        for (const child of el.children ?? []) {
            const hit = findTag(child, type);
            if (hit !== undefined) return hit;
        }
    }
    return undefined;
}

function collectButtons(node: unknown, out: ElementNode[] = []): ElementNode[] {
    if (Array.isArray(node)) {
        for (const child of node) collectButtons(child, out);
        return out;
    }
    if (node !== null && typeof node === "object") {
        const el = node as ElementNode;
        if (el.type === "button") out.push(el);
        for (const child of el.children ?? []) collectButtons(child, out);
    }
    return out;
}

// The element whose DIRECT children (including array children) contain an
// element matching pred — used to pin which row parents a given tab.
function findDivParenting(node: unknown, pred: (el: ElementNode) => boolean): ElementNode | undefined {
    if (Array.isArray(node)) {
        for (const child of node) {
            const hit = findDivParenting(child, pred);
            if (hit !== undefined) return hit;
        }
        return undefined;
    }
    if (node !== null && typeof node === "object") {
        const el = node as ElementNode;
        for (const child of el.children ?? []) {
            if (Array.isArray(child)) {
                for (const c of child) {
                    if (c !== null && typeof c === "object" && pred(c as ElementNode)) return el;
                }
            } else if (child !== null && typeof child === "object" && pred(child as ElementNode)) {
                return el;
            }
        }
        for (const child of el.children ?? []) {
            const hit = findDivParenting(child, pred);
            if (hit !== undefined) return hit;
        }
    }
    return undefined;
}

// One esbuild pass per test file — every scenario below runs the SAME shipped
// wrapper shape (banner/footer/externals sourced from tsup.config.ts).
let clientCodePromise: Promise<string> | undefined;
async function clientCode(): Promise<string> {
    clientCodePromise ??= (async () => {
        const { build } = await import("esbuild");
        const configs = ((await import("../tsup.config.ts")).default) as unknown as Array<{
            entry: Record<string, string>;
            platform: string;
            target: string;
            external?: string[];
            banner?: { js?: string };
            footer?: { js?: string };
        }>;
        const cfg = configs.find((c) => c.entry["agent/dsh-native-client"] !== undefined);
        assert.ok(cfg !== undefined, "tsup config must keep the dsh client entry");
        const result = await build({
            entryPoints: [cfg.entry["agent/dsh-native-client"]],
            bundle: true,
            format: "cjs",
            platform: cfg.platform as Parameters<typeof build>[0]["platform"],
            target: cfg.target,
            external: cfg.external,
            banner: cfg.banner,
            footer: cfg.footer,
            write: false,
        });
        assert.equal(result.outputFiles!.length, 1);
        return result.outputFiles![0].text;
    })();
    return clientCodePromise;
}

const tick = (): Promise<void> => new Promise<void>((r) => setTimeout(r, 0));

// #3100: what a CURRENT server answers for the exact framed URL — a 200 with
// an HTML content type (older builds answer the query form with a JSON 404).
const htmlOk = () => ({ ok: true, headers: { get: (_k: string) => "text/html; charset=utf-8" } });

type Face = { inject: string[]; apply: (ctx: unknown) => void };

type Mounted = {
    component: () => unknown;
    resetHooks: () => void;
    runCleanups: () => void;
    inject: string[];
    slotsOrder: string[];
    optionsBySlot: Map<string, Record<string, unknown>>;
    dicts: Record<string, { zh: Record<string, string>; en: Record<string, string> }>;
};

// Mounts the client bundle in a fresh vm realm (one page load) with the given
// globals. React hooks are emulated with per-mount state: useState persists
// across renders, useEffect follows React semantics (#2288) — run on mount,
// re-run only when their deps change (prior cleanup first).
async function mountClient(extra: Record<string, unknown>, slotName = "settings.section"): Promise<Mounted> {
    const code = await clientCode();
    const registrations: Array<{ id: string; factory: (require: (spec: string) => unknown) => unknown }> = [];
    const sandbox: Record<string, unknown> = {};
    sandbox.window = { __ModuleLoader__: { load: (reg: (typeof registrations)[number]) => registrations.push(reg) } };
    Object.assign(sandbox, extra);
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox, { filename: "dsh-native-client.bundle.js" });
    assert.equal(registrations.length, 1);
    // Must equal the loader entry name the scanner keys its graph row by.
    assert.equal(registrations[0].id, "billion-context");
    type EffectSlot = { deps: readonly unknown[] | undefined; cleanup: (() => void) | undefined };
    let hookStates: unknown[] = [];
    let hookIndex = 0;
    let effectSlots: EffectSlot[] = [];
    const reactStub = {
        createElement: (type: string, props: Record<string, unknown> | null, ...children: unknown[]): ElementNode => ({ type, props, children }),
        useState: (init: unknown): [unknown, (v: unknown) => void] => {
            const i = hookIndex++;
            if (!(i in hookStates)) hookStates[i] = typeof init === "function" ? (init as () => unknown)() : init;
            return [hookStates[i], (v: unknown) => { hookStates[i] = v; }];
        },
        useEffect: (fn: () => unknown | (() => void), deps?: readonly unknown[]): void => {
            const i = hookIndex++;
            const prev = effectSlots[i];
            const prevDeps = prev?.deps;
            const unchanged = prevDeps !== undefined && deps !== undefined &&
                deps.length === prevDeps.length && deps.every((d, j) => Object.is(d, prevDeps[j]));
            if (unchanged) return;
            prev?.cleanup?.();
            const r = fn();
            effectSlots[i] = { deps, cleanup: typeof r === "function" ? (r as () => void) : undefined };
        },
    };
    const requireStub = (spec: string): unknown => {
        if (spec === "react") return reactStub;
        throw new Error(`unexpected external require: ${spec}`);
    };
    const face = registrations[0].factory(requireStub) as Face;
    // Re-materialize in the host realm: vm-context arrays carry the sandbox's
    // Array.prototype, which deepStrictEqual rejects.
    const inject = Array.from(face.inject);
    assert.equal(typeof face.apply, "function");
    const dicts: Record<string, { zh: Record<string, string>; en: Record<string, string> }> = {};
    const slotsOrder: string[] = [];
    const optionsBySlot = new Map<string, Record<string, unknown>>();
    const components = new Map<string, () => unknown>();
    let current: string | undefined;
    face.apply({
        effect: (fn: () => void) => fn(),
        locale: {
            register: (ns: string, dict: { zh: Record<string, string>; en: Record<string, string> }) => {
                dicts[ns] = dict;
            },
            bind: (ns: string) => (key: string) => dicts[ns]?.zh?.[key] ?? key,
        },
        slots: {
            inject: (name: string, p: () => void) => {
                slotsOrder.push(name);
                current = name;
                p();
            },
            register: (opts: Record<string, unknown>, comp: () => unknown) => {
                optionsBySlot.set(current!, opts);
                components.set(current!, comp);
            },
        },
    });
    assert.ok(components.has(slotName), `slot ${slotName} must be registered`);
    const bound = components.get(slotName)!;
    return {
        // Hook indices restart on every render (React matches hooks by
        // position within a single render).
        component: (): unknown => { hookIndex = 0; return bound(); },
        resetHooks: () => {
            hookStates = [];
            hookIndex = 0;
            effectSlots = [];
        },
        runCleanups: () => {
            // Positions held by non-effect hooks (useState) stay as holes.
            for (const slot of effectSlots.splice(0)) slot?.cleanup?.();
        },
        inject,
        slotsOrder,
        optionsBySlot,
        dicts,
    };
}

test("#1590/#2125: client bundle registers the settings.section entry bili AND the plugins.bundle.config panel (wrapper id, require purity, both render branches)", async () => {
    const opened: string[] = [];
    const extra: Record<string, unknown> = {
        __BILI__: { origin: "http://127.0.0.1:8787" },
        open: (url: string) => opened.push(url),
        // #3100: the embed pre-flight answers HTML here — every build since
        // v0.1.189 serves the query-form UI route.
        fetch: async (url: string) => {
            if (String(url).endsWith("/__bili/?embed=1")) return { ok: true, headers: { get: (_k: string) => "text/html; charset=utf-8" } };
            return { ok: true, json: async () => ({ origin: "http://127.0.0.1:8787" }) };
        },
        // The poll loop schedules its retry through the injected clock — the
        // vm realm has no host globals of its own.
        setTimeout,
        clearTimeout,
    };

    const m = await mountClient(extra);
    assert.deepEqual(Array.from(m.inject), ["slots", "locale"]);
    assert.deepEqual(m.slotsOrder, ["settings.section", "plugins.bundle.config"]);
    assert.equal(m.optionsBySlot.size, 2);
    assert.ok(m.dicts["bili"] !== undefined);
    const settings = m.optionsBySlot.get("settings.section")!;
    assert.equal(settings.name, "settings.section");
    assert.equal(settings.id, "bili");
    assert.equal(settings.order, 100);
    assert.equal(settings.locale, "bili");
    assert.equal(typeof settings.label, "function");
    assert.equal((settings.label as () => string)(), "bili设置");
    const bundle = m.optionsBySlot.get("plugins.bundle.config")!;
    assert.equal(bundle.name, "plugins.bundle.config");
    assert.equal(bundle.key, "billion-context");
    assert.equal(bundle.locale, "bili");
    // Keyed slot: the host matches the key against its own package name — no
    // list-slot fields may ride along.
    assert.deepEqual(Object.keys(bundle).sort(), ["key", "locale", "name"]);
    assert.deepEqual(Object.keys(m.dicts["bili"].zh).sort(), Object.keys(m.dicts["bili"].en).sort());

    m.resetHooks();
    const pendingTree = m.component() as ElementNode;
    assert.equal(findTag(pendingTree, "iframe"), undefined, "#3100: the frame waits for the embed pre-flight verdict");
    await tick();
    const tree = m.component() as ElementNode;
    assert.equal(tree.type, "div");
    assert.notEqual(findTag(tree, "h3"), undefined, "the settings section keeps its own title");
    // #2321: bound state embeds the real web UI — tab bar plus one iframe at
    // the embeddable face, defaulting to the overview page. The stub's locale
    // bind resolves zh, so lang=zh.
    const frame = findTag(tree, "iframe");
    assert.ok(frame !== undefined, "origin present renders the embedded iframe");
    assert.equal(frame.props?.src, "http://127.0.0.1:8787/__bili/?embed=1&lang=zh#/overview");
    assert.equal(
        ((frame.props?.style) as Record<string, unknown> | undefined)?.height,
        "min(640px, 78vh)",
        "#2448: frame height follows the host viewport instead of a flat 640px",
    );
    const buttons = collectButtons(tree);
    assert.equal(buttons.length, 5, "four tabs plus the backup open-in-browser button");
    // #2448: the backup button drops the origin URL from the label (a narrow
    // host panel squeezed the hint row into a sliver) and keeps it in the
    // tooltip instead.
    const openLabel: string[] = [];
    collectText(buttons[4], openLabel);
    assert.deepEqual(openLabel, ["打开 Web UI"], "#2448: backup button label carries no origin URL");
    assert.equal(buttons[4].props?.title, "http://127.0.0.1:8787", "#2448: the origin moves to the tooltip");
    const tabLabels: string[] = [];
    for (const b of buttons.slice(0, 4)) {
        const bt: string[] = [];
        collectText(b, bt);
        tabLabels.push(bt.join(""));
    }
    assert.deepEqual(tabLabels, ["总览", "会话", "配置", "日志"], "tabs mirror the web UI nav terminology");
    // The open-in-browser action rides the TAB row (right after the logs
    // tab), not the footer below the iframe: the row div that parents the
    // logs tab also parents the action button, and the root's footer row
    // carries no button at all in the embedded state.
    const tabRow = findDivParenting(tree, (el) => {
        const bt: string[] = [];
        collectText(el, bt);
        return bt.join("") === "日志";
    });
    assert.ok(tabRow !== undefined, "logs tab has a parent row");
    const rowButtons = collectButtons(tabRow);
    assert.equal(rowButtons.length, 5, "tab row = four tabs + the open-WebUI action");
    assert.equal(rowButtons[4], buttons[4], "the action is the row's last child, right after the logs tab");
    const footerRow = (tree.children ?? []).filter((c) => c !== null && typeof c === "object").at(-1) as ElementNode;
    assert.equal(collectButtons(footerRow).length, 0, "embedded footer carries no button — the action moved up");
    // Tab click moves only the hash — the frame navigates same-document.
    (buttons[1].props!.onClick as () => void)();
    const treeAfterTab = m.component() as ElementNode;
    const frameAfterTab = findTag(treeAfterTab, "iframe");
    assert.ok(frameAfterTab !== undefined);
    assert.equal(frameAfterTab.props?.src, "http://127.0.0.1:8787/__bili/?embed=1&lang=zh#/sessions");
    // The backup button keeps the original jump target.
    (buttons[4].props!.onClick as () => void)();
    assert.deepEqual(opened, ["http://127.0.0.1:8787/__bili/"]);
    m.runCleanups();

    // #2125: the bundle panel reuses the probe/frame/hint but drops the title
    // — the plugin detail page draws it. A fresh mount is a fresh page load:
    // pending first paint again, verdict cache empty again.
    const bm = await mountClient(extra, "plugins.bundle.config");
    bm.resetHooks();
    bm.component();
    await tick();
    const btree = bm.component() as ElementNode;
    assert.equal(btree.type, "div");
    assert.equal(findTag(btree, "h3"), undefined, "the bundle panel does not repeat the page title");
    const bframe = findTag(btree, "iframe");
    assert.ok(bframe !== undefined, "origin present renders the embedded iframe in the bundle panel");
    assert.equal(bframe.props?.src, "http://127.0.0.1:8787/__bili/?embed=1&lang=zh#/overview");
    const bButtons = collectButtons(btree);
    assert.equal(bButtons.length, 5, "the bundle panel offers the same tabs plus backup button");
    assert.equal(
        bButtons[bButtons.length - 1].props?.title,
        "http://127.0.0.1:8787",
        "bundle backup button tooltip carries the origin",
    );
    opened.length = 0;
    (bButtons[bButtons.length - 1].props!.onClick as () => void)();
    assert.deepEqual(opened, ["http://127.0.0.1:8787/__bili/"]);
    bm.runCleanups();

    // Degraded: no snapshot AND a host without the live route (fetch rejects)
    // — the entry stays degraded in BOTH slots.
    for (const slot of ["settings.section", "plugins.bundle.config"]) {
        const dm = await mountClient({ open: (_url: string) => {}, fetch: async () => { throw new Error("no route"); }, setTimeout, clearTimeout }, slot);
        dm.resetHooks();
        const dtree = dm.component() as ElementNode;
        assert.equal(findButton(dtree), undefined, `${slot}: no buttons while degraded`);
        assert.equal(findTag(dtree, "iframe"), undefined, `${slot}: no frame before the origin resolves`);
        const dt: string[] = [];
        collectText(dtree, dt);
        assert.ok(dt.some((x) => x.includes("/acp")), `${slot}: degraded hint points at /acp: ${JSON.stringify(dt)}`);
        dm.runCleanups();
    }
});

test("#3373: relay mode — probe {origin:null,relay:true} binds same-origin; prefix gateways resolve through the base-relative fallback form", async () => {
    {
        // Root relay deployment: no response URL ⇒ base "" (same-origin paths).
        const opened: string[] = [];
        const m = await mountClient({
            open: (url: string) => opened.push(url),
            fetch: async (url: string) => {
                if (String(url).endsWith("/__bili/?embed=1")) return htmlOk();
                return { ok: true, json: async () => ({ origin: null, relay: true }) };
            },
            setTimeout,
            clearTimeout,
        });
        m.resetHooks();
        const first = m.component() as ElementNode;
        // No snapshot here — first paint is the degraded hint until the first
        // poll resolves (the snapshot path is covered below).
        assert.equal(findTag(first, "iframe"), undefined, "#3100: the frame still waits for the pre-flight verdict");
        await tick();
        m.component();
        await tick();
        const second = m.component() as ElementNode;
        const ft: string[] = [];
        collectText(second, ft);
        assert.ok(!ft.some((x) => x.includes("/acp")), "relay mode is bound, not degraded");
        const frame = findTag(second, "iframe");
        assert.ok(frame !== undefined, "relay mode renders the frame");
        assert.equal(frame.props?.src, "/__bili/?embed=1&lang=zh#/overview", "same-origin frame under the entry relay");
        const buttons = collectButtons(second);
        (buttons[buttons.length - 1].props!.onClick as () => void)();
        assert.deepEqual(opened, ["/__bili/"]);
        m.runCleanups();
    }
    {
        // Prefix gateway (fnOS-style /app/dsh/): the absolute probe path misses;
        // the base-relative fallback form carries the prefix and its response
        // URL becomes the absolute UI base.
        const m = await mountClient({
            document: { baseURI: "https://dsh.example/app/dsh/" },
            URL,
            open: (_url: string) => {},
            fetch: async (url: string) => {
                const u = String(url);
                if (u === "/bili/origin") return { ok: false };
                if (u.endsWith("/bili/origin")) return { ok: true, url: u, json: async () => ({ origin: null, relay: true }) };
                if (u.endsWith("/__bili/?embed=1")) return htmlOk();
                throw new Error(`unexpected fetch: ${u}`);
            },
            setTimeout,
            clearTimeout,
        });
        m.resetHooks();
        m.component();
        await tick();
        m.component();
        await tick();
        const tree = m.component() as ElementNode;
        const frame = findTag(tree, "iframe");
        assert.ok(frame !== undefined, "prefix gateway resolves through the fallback probe form");
        assert.equal(frame.props?.src, "https://dsh.example/app/dsh/__bili/?embed=1&lang=zh#/overview");
        m.runCleanups();
    }
    {
        // Relay snapshot (__BILI__ carries relay:true): first paint is bound.
        const m = await mountClient({
            __BILI__: { origin: null, relay: true },
            open: (_url: string) => {},
            fetch: async (url: string) => {
                if (String(url).endsWith("/__bili/?embed=1")) return htmlOk();
                return { ok: true, json: async () => ({ origin: null, relay: true }) };
            },
            setTimeout,
            clearTimeout,
        });
        m.resetHooks();
        const first = m.component() as ElementNode;
        const ft: string[] = [];
        collectText(first, ft);
        assert.ok(!ft.some((x) => x.includes("/acp")), "relay snapshot is bound from first paint");
        await tick();
        m.component();
        await tick();
        const second = m.component() as ElementNode;
        assert.ok(findTag(second, "iframe") !== undefined, "relay snapshot + live route renders the frame");
        m.runCleanups();
    }
});

test("#1809/#2125/#2187: client polls /bili/origin while unresolved — upgrades on success, stays degraded and cancels when absent (both slots); slow phase continues past the fast attempts; #2288 corrects a stale boot snapshot and follows mid-session re-binds", async () => {
    // #3100: every fetch stub below dispatches on URL — the host origin route
    // answers JSON, the proxy embed pre-flight answers HTML (htmlOk above).
    {
        const opened: string[] = [];
        const fetched: string[] = [];
        const m = await mountClient({
            open: (url: string) => opened.push(url),
            fetch: async (url: string) => {
                fetched.push(url);
                if (String(url).endsWith("/__bili/?embed=1")) return htmlOk();
                return { ok: true, json: async () => ({ origin: "http://127.0.0.1:9999" }) };
            },
            setTimeout,
            clearTimeout,
        });
        m.resetHooks();
        const first = m.component() as ElementNode;
        assert.equal(findTag(first, "iframe"), undefined, "#3100: first paint before the pre-flight resolves shows no frame");
        await tick();
        m.component();
        await tick();
        const second = m.component() as ElementNode;
        const frame = findTag(second, "iframe");
        assert.ok(frame !== undefined, "resolved origin upgrades the entry without a reload");
        assert.equal(frame.props?.src, "http://127.0.0.1:9999/__bili/?embed=1&lang=zh#/overview");
        const upButtons = collectButtons(second);
        assert.equal(upButtons.length, 5, "the upgraded entry shows tabs plus the backup button");
        (upButtons[upButtons.length - 1].props!.onClick as () => void)();
        assert.deepEqual(opened, ["http://127.0.0.1:9999/__bili/"]);
        // #2288: resolution no longer STOPs the probe — exactly one fast probe
        // ran so far; the slow follow-up is still pending and gets cancelled
        // by runCleanups below. #3100: the embed pre-flight fired exactly once
        // per distinct origin (in-flight guard dedupes the same-tick re-drives).
        assert.equal(fetched.filter((u) => u === "/bili/origin").length, 1, "resolution took exactly the initial fast probe (slow follow-up still pending)");
        assert.equal(fetched.filter((u) => u.endsWith("/__bili/?embed=1")).length, 1, "#3100: one embed pre-flight per distinct origin");
        m.runCleanups();
    }

    {
        // #2288 regression core: a stale boot snapshot (the attach-mode env
        // origin published at page render, before the host re-bound the proxy)
        // must be corrected in place by the live route — the old guard froze
        // it for the whole session.
        const opened: string[] = [];
        const m = await mountClient({
            __BILI__: { origin: "http://127.0.0.1:8787" },
            open: (url: string) => opened.push(url),
            fetch: async (url: string) => {
                if (String(url).endsWith("/__bili/?embed=1")) return htmlOk();
                return { ok: true, json: async () => ({ origin: "http://127.0.0.1:18798" }) };
            },
            setTimeout,
            clearTimeout,
        });
        m.resetHooks();
        const first = m.component() as ElementNode;
        assert.equal(findTag(first, "iframe"), undefined, "#3100: even a snapshot origin waits for its pre-flight verdict");
        await tick();
        m.component();
        await tick();
        const second = m.component() as ElementNode;
        const secondButtons = collectButtons(second);
        assert.equal(
            secondButtons[secondButtons.length - 1].props?.title,
            "http://127.0.0.1:18798",
            "stale snapshot upgraded to the live origin (backup button tooltip)",
        );
        const sframe = findTag(second, "iframe");
        assert.ok(sframe !== undefined, "the upgraded entry keeps its frame");
        assert.equal(sframe.props?.src, "http://127.0.0.1:18798/__bili/?embed=1&lang=zh#/overview", "the embedded frame follows the corrected live origin");
        const sButtons = collectButtons(second);
        assert.equal(sButtons.length, 5, "the upgraded entry shows tabs plus the backup button");
        (sButtons[sButtons.length - 1].props!.onClick as () => void)();
        assert.deepEqual(opened, ["http://127.0.0.1:18798/__bili/"]);
        m.runCleanups();
    }

    {
        // #2288/#2321: after the first resolution the slow phase KEEPS following
        // the live route — a mid-session re-bind (runtime re-spawn, routed-origin
        // convergence) moves the frame and the backup button without a reload.
        // Manual clock as in the #2187 blocks below.
        const pending: Array<{ id: number; delay: number; fn: () => void }> = [];
        let nextId = 1;
        let polls = 0;
        const fakeSetTimeout = ((fn: () => void, delay?: number): unknown => {
            const id = nextId++;
            pending.push({ id, delay: delay ?? 0, fn });
            return id;
        }) as unknown as typeof setTimeout;
        const fakeClearTimeout = ((id: unknown): void => {
            const i = pending.findIndex((p) => p.id === id);
            if (i >= 0) pending.splice(i, 1);
        }) as unknown as typeof clearTimeout;
        const m = await mountClient({
            fetch: async (url: string) => {
                if (String(url).endsWith("/__bili/?embed=1")) return htmlOk();
                polls += 1;
                return { ok: true, json: async () => ({ origin: polls < 4 ? "http://127.0.0.1:18798" : "http://127.0.0.1:18800" }) };
            },
            setTimeout: fakeSetTimeout,
            clearTimeout: fakeClearTimeout,
        });
        m.resetHooks();
        m.component();
        await tick();
        for (let i = 0; i < 3; i++) {
            await tick();
            if (pending.length === 0) throw new Error("polling stopped after resolution — the entry would freeze on a stale origin");
            const t = pending.shift()!;
            assert.equal(t.delay, 10000, "post-resolution follow-ups use the slow cadence");
            t.fn();
        }
        await tick();
        m.component();
        await tick();
        const tree = m.component() as ElementNode;
        const treeButtons = collectButtons(tree);
        assert.equal(
            treeButtons[treeButtons.length - 1].props?.title,
            "http://127.0.0.1:18800",
            "mid-session re-bind follows the live origin (backup button tooltip)",
        );
        const rframe = findTag(tree, "iframe");
        assert.ok(rframe !== undefined, "the re-bound entry keeps its frame");
        assert.equal(rframe.props?.src, "http://127.0.0.1:18800/__bili/?embed=1&lang=zh#/overview", "the embedded frame follows the mid-session re-bind");
        m.runCleanups();
    }

    {
        let cleared = 0;
        const m = await mountClient({
            fetch: async () => ({ ok: false, json: async () => ({}) }),
            setTimeout,
            clearTimeout: (t: unknown) => {
                cleared += 1;
                clearTimeout(t as ReturnType<typeof setTimeout>);
            },
        });
        m.resetHooks();
        const first = m.component() as ElementNode;
        assert.equal(findTag(first, "iframe"), undefined);
        await tick();
        const second = m.component() as ElementNode;
        assert.equal(findTag(second, "iframe"), undefined, "a host without the route keeps the entry degraded");
        m.runCleanups();
        assert.ok(cleared >= 1, "pending retry timers are cancelled on unmount");
    }

    {
        // #2125: the bundle panel runs the same probe wiring through its own
        // registration.
        const opened: string[] = [];
        const m = await mountClient(
            {
                open: (url: string) => opened.push(url),
                fetch: async (url: string) => {
                    if (String(url).endsWith("/__bili/?embed=1")) return htmlOk();
                    return { ok: true, json: async () => ({ origin: "http://127.0.0.1:9999" }) };
                },
                setTimeout,
                clearTimeout,
            },
            "plugins.bundle.config",
        );
        m.resetHooks();
        const first = m.component() as ElementNode;
        assert.equal(findTag(first, "iframe"), undefined, "#3100: the bundle panel also waits for the pre-flight");
        await tick();
        m.component();
        await tick();
        const second = m.component() as ElementNode;
        const bframe = findTag(second, "iframe");
        assert.ok(bframe !== undefined, "the bundle panel upgrades on a resolved origin");
        assert.equal(bframe.props?.src, "http://127.0.0.1:9999/__bili/?embed=1&lang=zh#/overview");
        const bUpButtons = collectButtons(second);
        assert.equal(bUpButtons.length, 5, "the bundle panel offers tabs plus the backup button");
        (bUpButtons[bUpButtons.length - 1].props!.onClick as () => void)();
        assert.deepEqual(opened, ["http://127.0.0.1:9999/__bili/"]);
        m.runCleanups();
    }

    {
        // #2187: past the fast phase, probing CONTINUES at the slow cadence
        // instead of stopping — a late-arriving origin (background heal) must
        // still upgrade the entry. Manual clock: capture each scheduled retry
        // and fire it by hand so the test never waits in wall time.
        const pending: Array<{ id: number; delay: number; fn: () => void }> = [];
        let nextId = 1;
        let polls = 0;
        let landed = false;
        const fakeSetTimeout = ((fn: () => void, delay?: number): unknown => {
            const id = nextId++;
            pending.push({ id, delay: delay ?? 0, fn });
            return id;
        }) as unknown as typeof setTimeout;
        const fakeClearTimeout = ((id: unknown): void => {
            const i = pending.findIndex((p) => p.id === id);
            if (i >= 0) pending.splice(i, 1);
        }) as unknown as typeof clearTimeout;
        const m = await mountClient({
            fetch: async (url: string) => {
                if (String(url).endsWith("/__bili/?embed=1")) return htmlOk();
                polls += 1;
                if (polls >= 13) landed = true;
                return { ok: true, json: async () => ({ origin: polls >= 13 ? "http://127.0.0.1:9997" : null }) };
            },
            setTimeout: fakeSetTimeout,
            clearTimeout: fakeClearTimeout,
        });
        m.resetHooks();
        const first = m.component() as ElementNode;
        assert.equal(findTag(first, "iframe"), undefined, "#3100: first paint before the pre-flight resolves shows no frame");
        const delays: number[] = [];
        for (;;) {
            await tick();
            if (landed) break;
            if (pending.length === 0) throw new Error("polling stopped before the origin arrived");
            const t = pending.shift()!;
            delays.push(t.delay);
            t.fn();
        }
        await tick();
        m.component();
        await tick();
        const second = m.component() as ElementNode;
        const sframe = findTag(second, "iframe");
        assert.ok(sframe !== undefined, "a late-arriving origin upgrades the entry without a reload");
        assert.equal(sframe.props?.src, "http://127.0.0.1:9997/__bili/?embed=1&lang=zh#/overview");
        assert.deepEqual(delays.slice(0, 9), Array(9).fill(3000), "fast phase keeps the original cadence");
        assert.ok(delays.length > 9, `probing must continue past the fast phase, got ${delays.length} retries`);
        assert.deepEqual(delays.slice(9), Array(delays.length - 9).fill(10000), "slow phase uses the reduced cadence");
        m.runCleanups();
    }

    {
        // #2187: unmount still cancels the pending retry even in the slow phase
        const pending: Array<{ id: number; delay: number; fn: () => void }> = [];
        let nextId = 1;
        let cleared = 0;
        const fakeSetTimeout = ((fn: () => void, delay?: number): unknown => {
            const id = nextId++;
            pending.push({ id, delay: delay ?? 0, fn });
            return id;
        }) as unknown as typeof setTimeout;
        const fakeClearTimeout = ((id: unknown): void => {
            cleared += 1;
            const i = pending.findIndex((p) => p.id === id);
            if (i >= 0) pending.splice(i, 1);
        }) as unknown as typeof clearTimeout;
        const m = await mountClient({
            fetch: async () => ({ ok: true, json: async () => ({ origin: null }) }),
            setTimeout: fakeSetTimeout,
            clearTimeout: fakeClearTimeout,
        });
        m.resetHooks();
        m.component();
        const delays: number[] = [];
        for (let i = 0; i < 12; i++) {
            await tick();
            if (pending.length === 0) break;
            const t = pending.shift()!;
            delays.push(t.delay);
            t.fn();
        }
        assert.ok(delays.includes(10000), `reached the slow phase, got delays ${JSON.stringify(delays)}`);
        m.runCleanups();
        assert.ok(cleared >= 1, "the pending retry is cancelled on unmount");
        assert.equal(pending.length, 0, "no timers survive unmount");
    }

    {
        // #2559: the host page's actual ground drives the face's palette.
        // The synchronous sample still classifies on FIRST RENDER (fed here
        // through the __BILI__ origin snapshot), so the very first frame that
        // appears already carries &theme=<pin> — #3100 delays that appearance
        // by at most one loopback pre-flight round-trip, never by a re-sample.
        // A light ground pins &theme=light; unpinned sandboxes (all earlier
        // scenarios) keep the old exact srcs above, proving a DOM-less host
        // stays OS-driven.
        const mkDom = (bg: string): Record<string, unknown> => ({
            __BILI__: { origin: "http://127.0.0.1:9998" },
            document: {
                documentElement: {},
                body: { querySelector: (_sel: string): unknown => undefined },
            },
            getComputedStyle: (_el: unknown): unknown => ({ backgroundColor: bg }),
        });
        for (const [bg, theme] of [
            ["rgb(13,17,23)", "dark"],
            ["rgba(22,27,34,0.98)", "dark"],
            ["rgb(247,248,250)", "light"],
        ] as Array<[string, string]>) {
            const m = await mountClient({
                fetch: async (url: string) => {
                    if (String(url).endsWith("/__bili/?embed=1")) return htmlOk();
                    return { ok: true, json: async () => ({ origin: "http://127.0.0.1:9998" }) };
                },
                setTimeout,
                clearTimeout,
                ...mkDom(bg),
            });
            m.resetHooks();
            const painted = m.component() as ElementNode;
            assert.equal(findTag(painted, "iframe"), undefined, `ground ${bg}: the frame waits for the pre-flight verdict`);
            await tick();
            m.component();
            await tick();
            const settled = m.component() as ElementNode;
            const frame = findTag(settled, "iframe");
            assert.ok(frame !== undefined, `ground ${bg} upgrades once the pre-flight lands`);
            assert.equal(
                frame.props?.src,
                `http://127.0.0.1:9998/__bili/?embed=1&lang=zh&theme=${theme}#/overview`,
                `ground ${bg} classifies ${theme} on first render and carries the pin into the first frame`,
            );
            m.runCleanups();
        }
    }
});

test("#2559: explicit host theme pin overrides the OS palette; #2560 embed frame padding", () => {
    // A framed document only sees the browser/OS color-scheme, while dsh's
    // dark theme is app-level — the host client samples its real ground and
    // pins the face via ?theme= (renderPage → <html data-theme=…>). An
    // explicit pin must OUTRANK the media query, so the OS-driven block
    // narrows to :not([data-theme]) while the pinned palette repeats it.
    // Normalize CRLF first: Git-for-Windows checks .ts out with \r\n (autocrlf
    // default; .gitattributes pins only tests/golden/** to LF), which breaks
    // every mid-string "\n" literal below on Windows CI runs.
    const styles = fs.readFileSync(new URL("../src/web/styles.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
    assert.ok(
        styles.includes("@media (prefers-color-scheme: dark) {\n    :root:not([data-theme]) {"),
        "the OS-driven dark palette stays out of explicitly pinned documents",
    );
    assert.ok(styles.includes(':root[data-theme="dark"] {'), "an explicit dark pin carries the full dark palette");
    {
        // Review finding on #2564: the pinned list had drifted from the
        // OS-driven one (--red-soft green channel 73→46) — CSS cannot share
        // declarations across the media boundary, so drift stays silent.
        // Pin SET-EQUALITY (color-scheme aside): both lists must carry the
        // same declarations verbatim.
        const grab = (open: string): string => {
            const i = styles.indexOf(open);
            assert.ok(i >= 0, `${open} present`);
            return styles.slice(i + open.length, styles.indexOf("}", i));
        };
        const decls = (block: string): string[] =>
            block.split("\n")
                .map((l) => l.trim().replace(/;\s*$/, ""))
                .filter((l) => l !== "" && !l.startsWith("*"));
        const pinned = decls(grab(':root[data-theme="dark"] {'));
        const osDriven = decls(grab(":root:not([data-theme]) {"));
        for (const d of pinned) {
            if (d.startsWith("color-scheme")) continue;
            assert.ok(osDriven.includes(d), `pinned dark declaration missing from the OS-driven list: ${d}`);
        }
        for (const d of osDriven) {
            assert.ok(pinned.includes(d), `OS-driven dark declaration missing from the pin: ${d}`);
        }
    }
    assert.ok(
        styles.includes(':root[data-theme="light"] {\n    color-scheme: light;\n}'),
        "an explicit light pin rebinds the canvas over a dark OS",
    );
    assert.ok(
        styles.includes(".embed main { max-width: none; padding: 8px 10px 16px; }"),
        "the embed face keeps a breathing gutter around the frame edge",
    );
});

test("#2125: the manifest declares no dsh.client.inject (pre-0.2 dsh compat)", () => {
    // dsh < 0.2.x cannot resolve "@deepseek-ai/dsh-client-ui-plugin-manager" and its
    // client-module scanner stalls the whole web UI on an unknown inject target.
    // dsh >= 0.2.0-rc.x ships the slot host inside dsh-web-app, so no injection is
    // required — re-adding it would freeze older clients into an endless spinner.
    const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
        dsh?: { client?: { inject?: unknown } };
    };
    assert.equal(pkg.dsh?.client?.inject ?? null, null, "dsh.client.inject would break pre-0.2 dsh clients");
});

test("#3043: the published manifest exposes ./package.json so dsh's client scanner can locate the package root", () => {
    const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
        exports?: Record<string, unknown>;
    };
    // Node's `exports` map is closed once declared — an unlisted subpath throws
    // ERR_PACKAGE_PATH_NOT_EXPORTED. dsh's client scanner resolves
    // "<pkg>/package.json" to find the package root before reading dsh.client;
    // the self-mapping below looks redundant but is load-bearing: drop it and
    // the scanner swallows the throw, so the browser half never registers.
    assert.equal(pkg.exports?.["./package.json"], "./package.json");
});

test("#2448: embed face adapts the data tables to a narrow host panel (CSS pins)", () => {
    // The embed iframe lives inside a dsh settings column (400-760px), not a
    // browser tab — the standalone-page table floors (940px/520px + fixed
    // colgroup) crushed the sessions table there (#2448).
    const styles = fs.readFileSync(new URL("../src/web/styles.ts", import.meta.url), "utf8");
    assert.ok(
        styles.includes(".embed .twide table.data { min-width: 0; }"),
        "embed drops the standalone-page 940px floor",
    );
    assert.ok(
        styles.includes(".embed .tproc table.data { min-width: 0; }"),
        "embed drops the protocol-table 520px floor",
    );
    assert.ok(
        styles.includes(".embed table.data th:nth-child(n + 6), .embed table.data td:nth-child(n + 6) { display: none; }"),
        "embed reuses the phone-compact column set at any panel width",
    );
    // The hidden TDs' <col> tracks still claim their px under table-layout:
    // fixed unless zeroed — otherwise the SESSION column collapses to 0 and
    // rows render double-exposed (title overflowing onto adjacent cells).
    assert.ok(
        styles.includes("\n    table.data colgroup col:nth-child(n + 6) { width: 0 !important; }"),
        "phone-compact releases the hidden <col> tracks",
    );
    assert.ok(
        styles.includes(".embed table.data colgroup col:nth-child(n + 6) { width: 0 !important; }"),
        "embed releases the hidden <col> tracks",
    );
});

test("#2473: the web face keeps its canvas coupled to the color scheme", () => {
    // The ?embed=1 face drops its opaque ground (--bg: transparent) to blend
    // into the host panel. If the document never declares color-scheme, its
    // default canvas stays WHITE regardless of scheme — so under DSH's dark
    // theme (prefers-color-scheme: dark) the light-scheme text (#e6edf3)
    // landed on a white ground and the overview stats went unreadable (#2473).
    // `color-scheme: light dark` on the BASE :root makes the canvas follow the
    // SAME prefers-color-scheme signal that drives the palette, so ground and
    // text stay consistent in BOTH schemes. Pin it in the base block (before
    // the dark @media), not buried inside one scheme's override — that is the
    // exact placement that keeps the coupling symmetric.
    const styles = fs.readFileSync(new URL("../src/web/styles.ts", import.meta.url), "utf8");
    const declIdx = styles.search(/color-scheme:\s*light\s+dark/);
    const mediaIdx = styles.indexOf("@media (prefers-color-scheme: dark)");
    assert.notEqual(declIdx, -1, "declares color-scheme: light dark on :root");
    assert.ok(
        mediaIdx !== -1 && declIdx < mediaIdx,
        "color-scheme sits in the base :root (before the dark @media) so both schemes inherit it",
    );
});

test("#3100: embed pre-flight — a stale proxy build gets the restart notice instead of a 404 frame; transient failures stay pending; verdicts cache per origin", async () => {
    // The auto-update window: the profile bundle on disk is NEW (this browser
    // half always runs it) while the long-running proxy child still SERVES the
    // old build in memory — its /__bili/ route table predates the query form
    // that landed in v0.1.189 (#2321), so the exact framed URL gets a raw JSON
    // 404 that used to render inside the iframe.
    {
        const opened: string[] = [];
        const m = await mountClient({
            open: (url: string) => opened.push(url),
            fetch: async (url: string) => {
                if (String(url).endsWith("/__bili/?embed=1")) {
                    return {
                        ok: false,
                        status: 404,
                        headers: { get: (_k: string) => "application/json; charset=utf-8" },
                        json: async () => ({ error: { type: "not_found", message: "no such management endpoint" } }),
                    };
                }
                return { ok: true, json: async () => ({ origin: "http://127.0.0.1:18796" }) };
            },
            setTimeout,
            clearTimeout,
        });
        m.resetHooks();
        m.component();
        await tick();
        m.component();
        await tick();
        const tree = m.component() as ElementNode;
        assert.equal(findTag(tree, "iframe"), undefined, "#3100: a non-HTML answer must never be framed");
        const staleText: string[] = [];
        collectText(tree, staleText);
        assert.ok(staleText.join(" ").includes("重新启动 dsh"), "the stale notice points at restarting dsh");
        const btns = collectButtons(tree);
        assert.equal(btns.length, 1, "the stale face keeps only the backup button");
        assert.equal(btns[0].props?.title, "http://127.0.0.1:18796", "the backup button still names the live origin");
        (btns[0].props!.onClick as () => void)();
        assert.deepEqual(opened, ["http://127.0.0.1:18796/__bili/"], "the backup button targets the bare form every build serves");
        m.runCleanups();
    }

    // Transient network errors yield NO verdict: the face stays on the
    // connecting placeholder (never the restart notice) and each origin-poll
    // slot re-drives the probe until one lands; the verdict then caches for
    // the page lifetime (a frozen process cannot gain routes mid-session).
    {
        const pending: Array<{ id: number; delay: number; fn: () => void }> = [];
        let nextId = 1;
        let embedCalls = 0;
        const fakeSetTimeout = ((fn: () => void, delay?: number): unknown => {
            const id = nextId++;
            pending.push({ id, delay: delay ?? 0, fn });
            return id;
        }) as unknown as typeof setTimeout;
        const fakeClearTimeout = ((id: unknown): void => {
            const i = pending.findIndex((p) => p.id === id);
            if (i >= 0) pending.splice(i, 1);
        }) as unknown as typeof clearTimeout;
        const m = await mountClient({
            fetch: async (url: string) => {
                if (String(url).endsWith("/__bili/?embed=1")) {
                    embedCalls += 1;
                    if (embedCalls < 3) throw new Error("network down");
                    return htmlOk();
                }
                return { ok: true, json: async () => ({ origin: "http://127.0.0.1:9999" }) };
            },
            setTimeout: fakeSetTimeout,
            clearTimeout: fakeClearTimeout,
        });
        m.resetHooks();
        const first = m.component() as ElementNode;
        const preText: string[] = [];
        collectText(first, preText);
        assert.ok(preText.join(" ").includes("未绑定 bili 代理"), "before any resolution the entry is still degraded");
        await tick();
        const second = m.component() as ElementNode;
        assert.equal(findTag(second, "iframe"), undefined);
        const pendText: string[] = [];
        collectText(second, pendText);
        assert.ok(pendText.join(" ").includes("正在连接 bili 代理"), "#3100: a failed probe reads as connecting, not as stale");
        assert.equal(embedCalls, 2, "the resolution and the origin-change effect each probed once; both failed");
        let upgraded = false;
        for (let i = 0; i < 5 && !upgraded; i++) {
            const mid = m.component() as ElementNode;
            upgraded = findTag(mid, "iframe") !== undefined;
            if (!upgraded) {
                const midText: string[] = [];
                collectText(mid, midText);
                assert.ok(midText.join(" ").includes("正在连接 bili 代理"), `probe slot ${i + 1}: still down reads as connecting, never stale`);
                if (pending.length === 0) throw new Error("the origin poll stopped before the probe could retry");
                const t = pending.shift()!;
                assert.equal(t.delay, 10000, "post-resolution follow-ups use the slow cadence");
                t.fn();
                await tick();
            }
        }
        assert.ok(upgraded, "a recovered probe upgrades the entry without a reload");
        const settled = m.component() as ElementNode;
        const frame = findTag(settled, "iframe");
        assert.ok(frame !== undefined, "the recovered verdict mounts the frame");
        assert.equal(frame.props?.src, "http://127.0.0.1:9999/__bili/?embed=1&lang=zh#/overview");
        assert.equal(embedCalls, 3, "probing stops once a verdict lands (slots 1-2 were the failed attempts)");
        if (pending.length === 0) throw new Error("polling stopped after the verdict");
        pending.shift()!.fn();
        await tick();
        const cached = m.component() as ElementNode;
        assert.ok(findTag(cached, "iframe") !== undefined, "the frame survives the follow-up tick");
        assert.equal(embedCalls, 3, "#3100: a cached verdict is never re-fetched");
        m.runCleanups();
    }
});
