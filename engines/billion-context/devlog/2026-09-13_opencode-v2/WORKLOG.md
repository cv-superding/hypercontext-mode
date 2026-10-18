# WORKLOG — OpenCode 2.0 support

Branch: `2026-09-13_opencode-v2` · Issue: #735 (from opencode-acp#395)

## Changes

| File | Change |
|------|--------|
| `src/agent/opencode.ts` | V2 branch appended: `setup(ctx)` per the probed 2.0 runtime API; default export becomes the dual-shape object `{ id, setup, server }` (V1 `server()` untouched) |
| `src/agent/shared.ts` | `fetchManifest` gains an optional `"openai"` format (maps `tools.openai[] {name, description, parameters}` → `{name, description, inputSchema}`); new `reportCompactionBoundary` POST helper (`/__bili/plugin/compact`) |
| `src/launcher.ts` | `prepareOpencodeHttpRewrite` merges `compaction: { ...existing, auto: false }` into the generated temp config (safe on both generations — V1 tolerates the unknown key) |
| `tests/opencode-v2.test.ts` | New: 9 tests — dual export shape, static tool parity vs bundled schemas, inert-without-proxy, kill switch, `/bili/`-URL activation + header timing + tool forwarding, env-based activation, compaction-boundary reporting, cleanup dispose, manifest openai mapping |
| `tests/launcher.test.ts` | +2 assertions: temp opencode config carries `compaction.auto === false` |
| `README.md` | "Which do I need?" table split by generation; launcher line; new "OpenCode 2.0" section (pure-proxy config incl. apiKey requirement, launcher behavior, `/acp` limitation) |

## Verification

- `npm run typecheck` — clean; `npm run build` — clean; `npm test` — 1243/1244
  (sole failure: pre-existing sandbox env issue in `resolveClientCommand`
  codex test, fails identically on unmodified master).
- Live ①: real OpenCode 2.0 pre-release binary against a local sglang upstream
  through the proxy — pure-proxy round-trip OK with the documented config
  shape; provider requires a non-empty `apiKey` even for local endpoints.
- Live ②: real OC2 binary + built `dist/agent/opencode.js` plugin:
  - model called the **native** `acp_status` tool; bili log shows
    `[plugin] tool acp_status executed via plugin` and zero `[acp-loop]`
    lines → true plugin mode, no wire-level tool injection;
  - probe harness confirmed header mutations on `e.request.headers` reach the
    wire (probe header recorded by an echo server on every request).

## Lessons learned (probed against the real 2.0 pre-release binary)

1. **`session.hook("model.request")` registers but never fires.** The working
   interception point is `session.hook("http.request")` — fires per outgoing
   provider request with a standard fetch `Request` at `e.request`; mutating
   `e.request.headers` reaches the wire. The published `@opencode/plugin@2.0.2`
   typings advertise `model.request`; trust runtime probes over typings here.
2. **No `ctx.tool.reload()`.** The host replays transforms on its own reload
   events; tools must be registered synchronously from bundled schemas (this
   file and the proxy's OpenAI tool list are built from the same source,
   `src/compress-tool.ts`, so parity cannot drift).
3. **Command editor is read/update-only** (`list/get/update/remove`) — plugins
   cannot add commands, hence no `/acp` under 2.0; the `acp_status` native
   tool is the equivalent.
4. OC2 swallows plugin `console.error` output in `run` mode — probes must log
   to a file.
5. Stale OC2 persistent service (`serve --service`) makes new runs die with
   "Error: Transport" before any request — kill it first when debugging.
