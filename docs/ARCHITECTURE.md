# Architecture

## Goals

1. Keep every strength of both upstreams: sandboxed tool output, persistent
   memory, hook routing, API proxying, reversible hierarchical compression.
2. Remove the failure modes that appear when both run together: double
   compaction, duplicated tool surfaces, split storage/search/status, competing
   installers and update channels.
3. Degrade independently. A broken sandbox child must not take down the MCP
   endpoint; a missing proxy must not break memory search.

## Components

```
packages/core      config, paths, client matrix, policy, SQLite readers,
                   federated search and stats
packages/runtime   daemon supervisor, unified MCP multiplexer, client setup,
                   doctor, formatters, process helpers
packages/cli       hctx command surface
engines/           vendored upstream sources (context-mode, billion-context)
```

The control plane is plain ESM TypeScript executed through Node's type
stripping. The engines keep their own build chains and dependencies; the
control plane never imports engine internals except for the documented adapter
seam used by hook installation.

## Three layers

### 1. Sandbox layer (context-mode)

- `ctx_execute`, `ctx_execute_file`, `ctx_batch_execute`, `ctx_index`,
  `ctx_search`, `ctx_fetch_and_index` plus five meta tools.
- Hooks intercept floody tool calls and keep raw output in the sandbox.
- SQLite stores:
  - content DB per project: `sources`, FTS5 `chunks`, `chunks_trigram`
  - session DB per project/worktree: `session_events`, `session_meta`,
    `session_resume`, `tool_calls`
- The engine's storage root is forced to
  `~/.hypercontext/data/context-mode` through `CONTEXT_MODE_DIR`.

### 2. Compression layer (billion-context)

- HTTP proxy between the client and the model provider.
- Owns conversation-level compression: `compress`, `decompress`,
  `search_context`, `acp_status` are injected into the wire.
- Storage:
  - session JSON envelopes (legacy)
  - `<sessions>/index.db` (SQLite): `sessions`, `messages`, `content` (CAS),
    `blocks`, `refs`, `checkpoints`, `conversations`, `session_ext`,
    `kv_store`
- Forced into `~/.hypercontext/data/compression`; XDG roots keep CA/state/cache
  under the same home.

### 3. Control plane (new)

- One config, one data root, one CLI, one MCP endpoint.
- `federatedSearch` opens both stores read-only and merges hits with layer
  labels; no engine process is required to search.
- `hc_status` / `hctx status` aggregate both layers and the proxy health.
- `compression.mode=autofold` delegates summarization to a separately configured
  model and turns off the proxy's prompt/tool injection, so compression does not
  depend on the main model calling `compress` and short sessions do not pay the
  fixed injection cost.
- `compression.coldStartTokens` (default `32_000`) is a **cold-start gate**: the
  compression prompt, tool, nudge and absorb/rules surfaces stay off until the
  raw request crosses the threshold, and the session latches open afterwards so
  a native compaction cannot make the surfaces disappear mid-session. The
  control plane passes it to the engine as the managed env var
  `ACP_INJECT_AFTER_TOKENS`; the engine parses it in `src/config.ts` and gates
  all four wires in `src/server/inject-gate.ts`. No engine config file field is
  added and the kernel is untouched.
- `profile` (`lean` / `balanced` / `maximum`) is an explicit preset applied by
  `hctx profile`; loading a config never rewrites fields silently. It selects
  which layers run, the memory injection mode and the MCP facade size.
- `mcp.toolset` (`auto` / `full` / `lean`) selects the MCP facade; an explicit
  value always wins, `auto` means full only for the `maximum` profile.
- `pricing.*` converts the measured token meter into money; without rates the
  meter reports tokens only.
- `doctor` validates engines, storage readability, update channels and policy
  conflicts.
- `setup` writes per-client artifacts; host config is only modified when the
  user passes `--apply` / `--hooks` / `--plugin`.

### Net meter

The dashboard numbers of the compression layer (`grossSaved`, `netSaved`) do not
include the cost the proxy itself adds, so the control plane computes a net
figure from measured counters:

```
net        = gross saved − re-pay − summary output − summary input − injected overhead
break-even = ceil(overhead ÷ (gross saved ÷ post-fold requests))
```

- `injectedOverheadTokens` — per request: outbound system+tools minus the
  client's inbound system+tools (engine side, `session.stats`).
- `summaryInput/Output/Calls/Latency` — measured around the external summary
  HTTP call: token counts are the engine tokenizer's estimate, latency is real
  wall clock.
- `postFoldRequests` — requests that arrived while a fold was already in
  place. Counted per request, so it works on paths where the cache ledger has
  no usage-grade samples.
- `pricing.*` only changes the currency line. No provider bill was ever
  measured; the meter reports tokens unless the user configures rates.

## Unified MCP

`hctx mcp` is a multiplexer:

```
client ⇄ unified MCP (stdio)
            ├── hc_search / hc_status / hc_doctor   (in-process)
            └── ctx_* tools                         (forwarded)
                   ⇄ context-mode MCP child (stdio)
```

- Tool names are disjoint: compression tools are injected by the proxy, sandbox
  tools by context-mode, control tools by the multiplexer. No name collides.
- The child is started lazily. If it fails, `hc_*` still works and `ctx_*`
  returns an actionable error.
- The child receives the unified environment plus `CONTEXT_MODE_PLATFORM` when
  `--client <id>` is supplied, so platform-aware behavior still works without a
  native plugin host.
- MCP stdout is strictly protocol; diagnostics go to stderr and
  `~/.hypercontext/state/logs/mcp-child.log`.

### Facade size (`full` vs `lean`)

The child ships 14 tools; their schemas and descriptions are a fixed cost in
every new window (28,502 B measured). The lean facade keeps `hc_search`,
`hc_status`, `hc_doctor`, `ctx_execute`, `ctx_search` and adds one dispatcher:

```
ctx_more { tool: "ctx_index" | "ctx_fetch_and_index" | ..., arguments: { … } }
```

`ctx_more` forwards to the child verbatim, so the hidden tools stay reachable;
the facade is 11,330 B (−17,172 B, −60.2 %). `hctx mcp --toolset full|lean`
overrides the configured value for one run.

## Storage federation

`federatedSearch` scans files rather than requiring a live engine:

1. Content DBs: FTS5 match, trigram fallback, then `LIKE` fallback. This keeps
   Chinese and partial-token queries useful.
2. Session DBs: `session_events` `LIKE` over `data` and `type`.
3. Compression `index.db`: active blocks joined to the content CAS, plus
   original messages. Block hits carry `ref` (`start-end`) for `decompress`.
4. Results are deduplicated and interleaved by layer so one layer cannot
   starve the other.
5. When `projectDir` is supplied, sandbox DB filenames are filtered by the
   canonical project hash (content DBs are `<hash>.db`, session DBs are
   `<hash><worktreeSuffix>.db`). CLI/MCP search default to the current
   project; `--all-projects` / `all_projects` widens it.
6. Cross-DB copies are deduplicated by layer, kind, source, session/ref and
   snippet, so indexing the same content under two project hashes does not
   double-report.

### One session id for both layers

`resolveSessionIdentity()` joins the host's own session id across the two
layers: the newest `session_meta` row of the current project (sandbox) and the
compression index's `sessions.session_id` table. When the same id exists in
both, the federated search is scoped to that conversation — no second id has to
be passed around. `--all-sessions` / `all_sessions` (and `--all-projects`, which
implies it) opts out; an explicit `--session <id>` overrides the inference.

The proxy side has a parallel bridge (`engines/billion-context/src/
hypercontext-bridge.ts`): `search_context` appends up to four sandbox hits
when `HYPERCONTEXT=1`. It scans content DBs directly, deduplicates, and
degrades to an empty string on any error. Without the env var the proxy output
is byte-identical to upstream.

All readers use `node:sqlite` read-only connections and tolerate missing,
locked, old or malformed databases. Errors are surfaced as diagnostics, not
crashes.

## Conflict resolution

| Conflict | Resolution |
|---|---|
| Host compaction vs. proxy compression | The proxy is the conversation owner. context-mode still records events but injects only a memory pointer (`HYPERCONTEXT_MEMORY_INJECTION=minimal`) when compression is on. |
| Full resume snapshot vs. prefix cache | Minimal injection prevents large snapshot re-insertion. The snapshot remains in SQLite and is searchable. |
| WebFetch hard deny | `routing=balanced` allows WebFetch with one guidance message; `strict` restores upstream; `advisory` disables rewrites/denials. |
| curl/wget/inline HTTP/build logs | Still redirected to the sandbox in `balanced` (deterministic floods); disabled in `advisory`. |
| Duplicate tool surfaces | Compression tools remain proxy-owned; sandbox tools remain MCP-owned; control tools are `hc_*`. |
| Two installers writing host config | One capability matrix decides plugin vs. launcher vs. proxy. `hctx setup` is the only entry point and backs up settings before hook writes. |
| Two update channels | `ACP_AUTO_UPDATE=0`, advisory/release-note checks off, and the context-mode npm version check disabled. Updates are explicit. |
| Two storage roots | `CONTEXT_MODE_DIR`, `BILI_CONFIG_FILE`, `BILI_SESSIONS_DIR` and `XDG_*` all point under `~/.hypercontext`. |
| Port conflict | Startup probes `/__bili/health`; an existing healthy proxy is adopted as `external` and never killed by `hctx stop`. |
| Model-dependent compression | Default `cooperative` mode waits for the model to call `compress`. Opt-in `autofold` mode lets the proxy select ranges and call an independent summary model, with `injectTool`/`injectNudge` off. |
| Corrupt bili config | Startup and doctor fail loudly; only the managed update flags plus the opt-in `hctx-summary` provider and auto-fold `compress` keys are ever merged. |

## Hook installation

Hooks are installed through the engine's own adapters, but not through their
default standalone installers: those register subsets (Claude 2 events, Gemini
3) and, for Gemini, bypass the wrapper. Instead the control plane merges the
adapter's full generated registration into the host's `hooks` map.

Verified platforms in v0.1: Claude Code, Gemini CLI, Qwen Code. They share a
simple `settings.hooks` shape and on-disk hook scripts. Other clients keep the
unified MCP endpoint and the compression proxy; their hook installers are
roadmap items, not shipped silently.

Two integration details make the verified installers safe:

1. Every hook command is rewritten to a dependency-free wrapper
   (`packages/runtime/src/hook-wrapper.ts`). The wrapper sets the unified
   storage/policy environment without loading zod or SQLite, then imports the
   original hook script. The unified home is embedded in the command, so host
   processes do not need `HYPERCONTEXT_HOME` in their environment.
2. The host settings file is backed up by the adapter before any write. The
   user must opt in with `--apply` / `--hooks`. Re-running replaces our own
   entries instead of duplicating them.

The wrapper always fails open: a broken config or missing script exits 0 rather
than blocking the host's tool call.

## Security model

- Proxy binds `127.0.0.1` by default and has no authentication. Non-loopback
  binds are reported as warnings by `status` and `doctor`.
- Management endpoints are loopback-gated upstream.
- Managed config files are written with mode `0600` where the platform honors
  it; malformed JSON is never silently replaced.
- CA material is generated lazily by the upstream launcher when a client needs
  certificate MITM, and lives under `~/.hypercontext/data/xdg`.
- Host settings are modified only on explicit apply and only after a backup.
- No telemetry is enabled by the control plane; upstream event forwarding is
  not configured.

## Failure modes

| Failure | Behavior |
|---|---|
| context-mode MCP child crashes | unified MCP stays up; `ctx_*` returns a fix hint; `hc_*` works |
| proxy dies | daemon status reports unhealthy; sandbox layer unaffected |
| SQLite DB locked/corrupt | federation records a diagnostic and skips it |
| Sandbox bridge on proxy fails | `search_context` returns its normal compression results only |
| engine build missing | commands fail with the exact build command |
| stale daemon state | status flags it; start/stop verify health PID before acting |
| host hook misconfigured | wrapper exits 0 (fail open) |

## Extension points

- `packages/core/src/clients.ts`: add a client with capabilities; no installer
  code changes needed for artifacts.
- `packages/runtime/src/setup.ts`: add a platform to the hook installer set
  after validating its adapter.
- `federatedSearch`: add a new store by returning `SearchHit[]` and merging.
- `hc_*` tools: add control-plane capabilities without touching engine tools.
- `hypercontext-bridge.ts`: extend the proxy-side sandbox search with project
  scoping or additional stores.
- Unified session identity is the next planned integration point; see the
  roadmap in the README.
