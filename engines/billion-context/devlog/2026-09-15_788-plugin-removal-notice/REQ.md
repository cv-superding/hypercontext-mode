# REQ — plugin install/remove: report dropped entries; neutral `/acp` no-proxy warning

## Date

2026-09-15

## Background

Issue #788 (source: analysis of billion-context-pi#445, where a real pi user
who followed the documented `pi install npm:billion-context-pi` path started
seeing the thin-plugin warning and believed pi needed `bili` running). Two
defects in this package:

1. **Silent entry removal.** `piInstall()` (src/plugin-install.ts) filters
   every `packages` entry matching `isPiEntry()` out of
   `~/.pi/agent/settings.json` before appending the bili root — and
   `isPiEntry()` deliberately matches `npm:billion-context-pi` /
   `node_modules/billion-context-pi` paths. The command output only reported
   the addition; nothing was printed about what was removed. A user who ran
   `pi install npm:billion-context-pi` then `bili plugin install pi` lost the
   in-process plugin silently: plain `pi` launches had no context compression
   at all, contradicting the README "Which do I need?" tables that recommend
   billion-context-pi as the pi path.
2. **Proxy-assuming `/acp` warning.** src/agent/pi.ts registers `/acp`
   unconditionally; when no proxy baseURL is detected it notified
   `bili: no proxy detected (run via \`bili <client>\` or set a /bili/
   baseURL)`. For users who never intend proxy mode the actionable exit is
   removing the plugin, not launching through bili — the message steered them
   into a different usage mode of the same product family.

The removal itself is intentional design (exactly one bili plugin must stay
live after install, or both would double-register the ACP tools); the defect
is that it happened without any notice.

## Requirements

1. `bili plugin install pi` names every entry it drops in its output
   (e.g. `pi: replaced existing entries: npm:billion-context-pi`).
2. `bili plugin remove pi` names the entry it drops in its output.
3. The `/acp` no-proxy warning is neutral: it offers BOTH exits — launch via
   `bili <client>` for proxy mode, or remove the plugin if the user uses
   billion-context-pi / doesn't want a proxy. Agent-aware wording (the
   remove hint mentions `billion-context-pi` only for pi).
4. Existing behavior unchanged otherwise: same entries removed, same backup
   file, same idempotency (`already installed`), `not installed` when absent.

## Solution

- src/plugin-install.ts: `piInstall()` collects the filtered entries and
  appends a `replaced existing entries:` line to its return value;
  `piRemove()` returns a `removed entries:` line (and keeps the early `not
  installed` path when nothing matched).
- src/agent/pi.ts: the `/acp` handler builds the warning from the factory's
  `agent` name plus a per-agent remove hint.
- tests/plugin-agent.test.ts: roundtrip + legacy-replacement fixtures assert
  the new lines (and their absence on fresh installs); the `/acp` test asserts
  the dual-exit wording; new omp variant asserts agent-awareness and that the
  billion-context-pi hint is pi-only.
