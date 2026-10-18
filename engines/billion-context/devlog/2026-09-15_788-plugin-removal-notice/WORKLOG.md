# WORKLOG — plugin install/remove notice + neutral `/acp` warning

## Date
2026-09-15

## What was done (this commit)
- src/plugin-install.ts: `piInstall()` now collects the entries it filtered
  out and appends a `pi: replaced existing entries: <list>` line to its
  return value; `piRemove()` returns `pi: removed from <file>` plus
  `pi: removed entries: <list>` (early `not installed` path unchanged when
  nothing matched). The removal set itself is untouched — only the silence
  was fixed.
- src/agent/pi.ts: the unconditional `/acp` no-proxy warning is now neutral
  and agent-aware — `run via \`bili <agent>\` (or set a /bili/ baseURL) to
  use proxy mode` plus a remove hint (`bili plugin remove <agent>`); the
  hint mentions `billion-context-pi` for pi only. dsh-acp.ts keeps its own
  separate message.
- tests/plugin-agent.test.ts: fresh-install output asserts NO replaced line;
  first-remove asserts it names the dropped root; legacy-replacement fixture
  asserts all five dropped entries are named (and unrelated entries are not);
  `/acp` test asserts the dual-exit wording; new omp variant test asserts
  agent-awareness and that the billion-context-pi hint is pi-only.
- devlog entry (this folder).

## Verification
- `npm run typecheck`: clean.
- `npm test`: 1512 pass, 0 fail, 2 skipped (skips are the pre-existing gated
  ones).
- `npm run build`: success.
- E2E suite not run: the change touches neither the server request pipeline
  (server.ts / src/loop/* / adapters / preflight) nor compression behavior —
  only CLI output strings and a client-side `ui.notify` message.

## Ceiling notes / deferred
- The `isPiEntry()` match set (npm spec, node_modules paths, dev-checkout
  dir names) is unchanged by design: replacing every match is what keeps
  exactly one bili plugin live. Only the reporting changed.
- Launcher-side detection (`isBiliPiEntry`, launcher.ts) still excludes
  billion-context-pi on purpose; #788 does not ask to change that.
