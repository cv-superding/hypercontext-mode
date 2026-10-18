# REQ — OpenCode 2.0 support (pure-proxy verification + V2 launcher mode)

Source: issue #735 (transferred from ranxianglei/opencode-acp#395).

## Problem

OpenCode 2.0 ships a new plugin API (`@opencode/plugin`, `Plugin.define({ id,
setup })`). The official migration guide states V1 plugins do not run under V2,
so `opencode-acp` (V1, npm latest 1.18.0) is unusable on OpenCode 2.0. Per the
decision in opencode-acp#395, V2 support lands in billion-context instead of
porting the standalone V1 implementation (which would perpetuate a second fork
of the kernel logic):

1. **Pure proxy mode** — provider baseURL pointed at `/bili/`. Wire-level,
   independent of the host plugin API version; needs live verification on 2.0.
2. **New OpenCode V2 launcher mode** — counterpart of `bili pi` / `bili
   codex`: acp-kernel + thin host glue providing in-host native tools.

## Scope

- ① Verify the full pure-proxy chain on OpenCode 2.0: auth, request parsing,
  SSE rewriting, ACP tool injection & execution. Record and fix any 2.0
  baseURL/auth differences.
- ② Add the V2 launcher path in `src/agent/opencode.ts`:
  - tools compress / decompress / search_context / acp_status (+ absorb) with
    JSON-Schema inputs and structured results;
  - header stamping so the proxy binds sessions into plugin mode;
  - context-window identification from the host catalog domain;
  - native-compaction boundary reporting to the proxy archive (#421 path);
  - launcher auto-disables native compaction (`compaction.auto: false`).
- Docs: OpenCode 2.0 install/configuration (pure-proxy config shape, launcher
  behavior, known limitations).

## Acceptance criteria (adapted from opencode-acp#395 item 9)

- Plugin loads on a real OpenCode 2.0 binary (tools visible in-host);
- Tools register with JSON Schema inputs and execute against the proxy;
- System/message context handling verified (mutability probed live);
- Session restore/fork not regressed (plugin state is per-setup, re-created);
- Model switching + context window identification (catalog domain);
- Permission handling: tools registered with `permission: "allow"`;
- Plugin unload/reload cleans up subscriptions (no leaks);
- Full run with built-in auto-compaction disabled (`compaction.auto: false`).

## Constraints

- No new runtime dependencies (agent bundles stay self-contained via tsup);
- No `as any` / `@ts-ignore`; no comments unless load-bearing;
- Both compression modes must keep working (proxy-mode clients unchanged);
- The same agent artifact must still serve OpenCode 1.x hosts (dual-shape
  export, supported since host ≥ 1.18.29);
- Version field untouched (feature branch).
