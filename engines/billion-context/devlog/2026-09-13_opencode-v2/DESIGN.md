# DESIGN — OpenCode 2.0 launcher mode

## Module shape: dual-shape default export

`src/agent/opencode.ts` keeps the existing V1 `server()` function and adds a
V2 `setup(ctx)`. The default export becomes:

```
{ id: "billion-context-opencode", setup, server }
```

Hosts ≥ 1.18.29 accept an object that is both a V1 plugin (`server`) and a
V2 plugin definition (`id` + `setup`); older hosts ignore the extra keys. One
artifact serves both generations — no separate package or entry point.

## Why static tool registration

`ctx.tool.transform(editor => editor.add(...))` must be synchronous, cheap,
and replayable; the probed 2.0 runtime has no `ctx.tool.reload()`, so tools
cannot be registered lazily after an async manifest fetch. Instead the tool
list is built at module load from the **same bundled schemas** the proxy
serves in its OpenAI manifest (`ACP_TOOLS_OPENAI` + `ABSORB_TOOL_OPENAI` from
`src/compress-tool.ts`). Parity between host-registered tools and wire-injected
tools cannot drift because both sides are the same const.

## Interception point: `http.request`, not `model.request`

Probed against the real 2.0 pre-release binary: `session.hook("model.request")`
registers successfully but never fires. `session.hook("http.request")` fires
per outgoing provider request with `e = { sessionID, agent, model, request }`
where `request` is a standard fetch `Request`; mutating `request.headers`
reaches the wire (probe-verified). The hook therefore:

1. kill-switch check (`BILLION_CONTEXT_PLUGIN === "0"`);
2. lazy proxy-base detection from `request.url` (`proxyBaseFromUrl`) falling
   back to `BILLION_CONTEXT_PROXY`;
3. refreshes the context-window map (60s throttle) from
   `ctx.catalog.model.list()`;
4. stamps `x-bili-plugin: opencode`, `x-bili-plugin-conversation: <sessionID>`,
   and — when known — `x-bili-plugin-context-window`.

Lazy detection means the same artifact works for launcher mode (baseURL
already `/bili/-wrapped`) and any manual pure-proxy setup without env vars.

## Tool execution path

Native tool `execute(input)` → `forwardTool(proxyBase, sessionID, name, args)`
→ `POST /__bili/plugin/tool` on the proxy. The proxy executes via the kernel
and returns the result text; the agent returns `{ content }`. Because the
header marks the session plugin-mode, the proxy suppresses wire-level ACP tool
injection for these sessions (existing behavior, no change) — the model sees
exactly one copy of each tool, the native one. The kill switch
(`BILLION_CONTEXT_PLUGIN=0`) gates `execute` too, alongside header stamping
and compaction reporting — fully inert, matching `detectProxyBase` semantics.

## Native compaction boundary

`ctx.event.subscribe({ signal })` async iterator; on
`session.compaction.ended` the plugin POSTs the conversation id to
`/__bili/plugin/compact` so the proxy archives its blocks at the boundary
(#421 path). Errors are swallowed — a missed report degrades to the existing
orphan-GC behavior, never breaks the host session. Cleanup aborts the signal
and disposes every registration.

## Launcher change

`prepareOpencodeHttpRewrite` merges `compaction.auto: false` into the temp
config (preserving any user-set sibling keys). Verified tolerant on V1 1.14.46
(unknown top-level key ignored), so no version detection is needed.

## Addendum 2026-09-14 — API-surface drift (PR #754 review)

External report (@jensenojs, #754 thread, with repro script `v2probe.sh`): on
**2.0.1 stable** all four "runtime facts" above from the next-17444
pre-release invert or shift — `model.request` fires; `ctx.tool = {reload,
transform, hook}`; `ctx.command = {list, transform, reload}`; and `context`
mutation reaches the wire. Provenance of that binary is not on any public
channel checked (npm `opencode-ai` has no 2.x versions under any package name;
GitHub releases ≤ v1.18.30) — exact re-probe pending an artifact identifier.

Independent probes during review (local LLM upstream, hermetic HOME):

| build | plugin entry | ctx.session | ctx.tool | hooks fired | bili outcome |
|---|---|---|---|---|---|
| next-17444 pre-release (author) | setup() | yes | no reload | http.request only | plugin mode (author's Live ②) |
| npm dev 2026-09-13 (`0.0.0-dev-202609132139`) | V1 server() only | n/a | n/a | n/a | proxy-mode fallback (zero `[plugin]`, one `[acp-loop]`) |
| npm dev 2026-09-14 (`0.0.0-dev-202609140717`) | setup() | **absent** (ctx = options,agent,aisdk,catalog,command,integration,plugin,reference,skill) | absent | none (cannot register) | proxy-mode fallback (same log signature) |

Consequences applied:

1. README + this file now state the facts as version-specific observations,
   not general V2 behavior.
2. The thin-shell rationale was re-based: single compression authority +
   kernel-version-drift elimination, NOT "plugins cannot mutate context"
   (that capability varies by build).
3. No code change required — every registration already uses optional
   chaining (inert-safe); new test pins `setup({})` resolving cleanly. The
   graceful-degradation path (no seam → transparent proxy mode) is now
   empirically verified on two adjacent builds.
4. `/acp` conclusion survives: no observed 2.x build exposes an add-command
   entry point (both list/get/update/remove and list/transform/reload shapes
   lack one).

## Addendum 2 (2026-09-14, later) — @opencode/cli 2.0.x stable verification + launcher fix

Provenance resolved: the 2.x line publishes on npm as `@opencode/cli`
(bins `opencode`/`opencode2`; platform packages like
`@opencode/cli-linux-x64`). `opencode-ai` / `opencode` / `@opencode-ai/cli`
are the 1.x line. Verified live on 2.0.1 and 2.0.3 in the same hermetic
setup.

| build | plugin entry | ctx.session | ctx.tool | hooks fired | bili outcome |
|---|---|---|---|---|---|
| @opencode/cli 2.0.1 | setup() | yes (hook/create/get/…) | {reload,transform,hook} | model.request + http.request | seam probe green |
| @opencode/cli 2.0.3 | setup() | yes | {reload,transform,hook} | model.request + http.request | **true plugin mode end-to-end** (`[plugin] tool acp_status executed via plugin`, zero `[acp-loop]`) |

Command-fact correction (supersedes Addendum item 4): on 2.0.x stable
`ctx.command.transform(editor => editor.add(definition))` WORKS — the
editor's only key is `add`; added commands appear in the slash menu and are
invocable in the TUI by accepting the completion (Tab + Enter); `opencode
run` mode dispatches NO slash commands at all (they pass through to the
model). The bundled plugin still registers no commands — `acp_status`
remains the in-host equivalent.

Launcher bug found + fixed (this addendum): OC 2.0.x rejects FILE paths in
the config `plugin` array (WARN "configured plugin path must be a directory";
a directory entry's `index.js` is the entrypoint), so `bili opencode` was
silently degrading every 2.x launch to proxy mode. Fix: `opencodeMajorVersion`
(`--version` probe, cached per path, failure defaults to 1) gates a new
`pluginDirMode` on `prepareOpencodeHttpRewrite`, which injects a temp wrapper
dir whose `index.js` re-exports `dist/agent/opencode.js`. Verified end-to-end
through the real launcher on 2.0.3 (captured temp config shows the directory
entry; log shows true plugin mode as above).
