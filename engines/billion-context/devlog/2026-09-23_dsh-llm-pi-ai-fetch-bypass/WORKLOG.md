# WORKLOG — dsh profile-install zero-traffic sessions: loud one-shot detection + gate-refusal instrumentation (#1158)

## Date
2026-09-23 (three commits on this branch)

## What was done

### Commit 1 — loud, actionable no-model-request 404
- src/plugin.ts: `handlePluginTool` distinguishes the two `!session` failures
  more precisely on the never-registered (`!entry`) branch — a tool call proves
  the model already answered, so ZERO model requests for that conversation id
  means its traffic never reached the proxy at all. First hit per conversation
  logs a one-shot actionable warn (`[plugin] NO MODEL REQUESTS seen for
  conversation …`); the 404 error body gains the same guidance while keeping
  the exact substrings `src/mcp.ts` (ORPHAN_ADOPT) and
  `src/agent/opencode-v2.ts` match on. One-shot state lives in a bounded module
  Set (cap 4096, coarse clear) reset by `_resetPluginStateForTest`. The
  entry-exists branch keeps its legacy per-call warn and wording byte-for-byte.
- tests/issue1158-no-model-request-warning.test.ts: regression suite — consumer
  substrings preserved, guidance present, warn exactly once per conversation,
  second conversation gets its own, reset re-arms, entry-exists branch
  unchanged.
- README.md / README.zh-CN.md: dsh section gains the #1158 entry.

### Commit 2 — root-cause retraction + takeover-gate refusal instrumentation
The owner's review (thread comment 2026-09-23) REJECTED the "SDK-injected
private fetch bypass" root cause with unpacked evidence across ALL published
versions: dsh-llm-pi-ai never sets a `fetch` key in streamSimple options;
pi-ai forwards `options?.fetch` (= undefined) into the OpenAI SDK, whose
`this.fetch = options.fetch ?? Shims.getDefaultFetch()` resolves globalThis at
client construction — i.e. the patched fetch; and dsh's main chat loop is
statically wrapped in `withInitiator` with zero `withoutInitiator` in llm
packages. The issue's :573-579 citation proved the channel EXISTS, not that
it is populated. Consequences, all applied here:
- plugin.ts warn/error wording made HYPOTHESIS-NEUTRAL: candidates listed
  (transport-level fetch shape / host-side attribution gap leaving traffic
  unclaimed by the takeover gate / stale id after host resume); the "known
  case: dsh llm-pi-ai" assertion removed from code, docs, and tests. The
  diagnostic itself stands regardless of which cause turns out true — it fires
  for ANY cause producing tool-calls-without-model-requests.
- src/agent/dsh-native.ts: `takeoverGate` now logs each DISTINCT endpoint it
  refuses ONCE PER PROCESS via console.error (host stdout/stderr, not
  bili.log): refused origin+pathname (query stripped — keys can ride there) +
  attribution state at refusal time (no initiator vs initiator-without-session
  id). This makes the owner's local repro one-pass diagnosable: a refused line
  with "no active initiator attribution" during an attributed chat turn pins
  the runtime-attribution hypothesis; absence of any refusal line while traffic
  still bypasses pins the transport-fetch-shape hypothesis. Legitimate agentless
  lanes (dsh's intentional `withoutInitiator` background drivers, third-party
  in-process callers) add at most one flat line per endpoint — the #1117
  silence rationale (no per-request noise) is preserved. Boolean gate contract
  unchanged; other consumers unaffected.
- tests/dsh-native.test.ts: new test — refusal logged once per endpoint, query
  string neither spawns a line nor leaks into it, distinct endpoints get their
  own lines, attributed traffic claims silently.
- README zh/en entry reworded to "reported, under investigation" with the two
  detection signals and the launcher workaround (robust under BOTH hypotheses:
  settings-overlay `/bili/` URLs reach the proxy directly, needing neither the
  fetch patch nor the gate).

### Commit 3 — persist bootstrap failures to bili.log (GUI stderr is invisible)
Owner's Linux repro (dsh 0.1.7-alpha.2 + bili native plugin + llm-pi-ai custom
provider, mock upstream; BOTH `dsh headless` and real chromium-driven `dsh web`)
could NOT reproduce the symptom — all llm-pi-ai traffic (incl. side requests)
routed through the proxy with `x-bili-hop`/`x-bili-tunnel` stamps. Combined
with their source review (pi-ai constructs `new OpenAI({fetch: undefined})` per
request in 0.82.1 AND 0.87.1; openai SDK 6.26.0/6.40.0 both resolve globalThis
fetch at call time), the transport-shape hypothesis is dead on Linux; residual
top suspect = Windows-specific spawn/attach bootstrap failure degrading
silently: the only output is a one-shot console.error, invisible in GUI process
stderr — matching "zero interception, zero logs" exactly. Consequence (owner's
ask): bootstrap failures must also land in the shared bili.log file.
- src/agent/dsh-native.ts: new `persistClientEvent(msg)` — best-effort
  appendFileSync of `<ISO ts> [warn] [dsh-client] <msg>` into `defaultLogFile()`
  (paths.ts, XDG-overridable, same file+shape as the proxy's tee logger;
  origin-marked `[dsh-client]` so client lines are greppable apart from proxy
  lines; appendFileSync reopens by path per call so the proxy's 10MB rotation
  can't strand writes; all errors swallowed — logging never breaks the host).
  Call sites: bootstrap() catch (spawn failed → direct send),
  verifyAttachAndRecover unhealthy attach target (fallback chain start), and
  all three onGiveUp closures (respawn gave up → direct send). Existing
  console.error lines unchanged (dual channel: durable file + stderr when
  visible).
- tests/dsh-native.test.ts: integration test (dead preset + failing fallback
  spawn under XDG_STATE_HOME → bili.log contains the standard-shaped
  [dsh-client] line) + unit test (line shape regex; broken fs target swallows
  without throwing or partial dir trees).
- Scope note: the generic native-intercept "proxy not ready" stderr line was
  left alone — it is shared across agent lanes and its dsh-side fact is now
  durably recorded by the client-side call sites above at the moment of
  failure.

## Behavior / compatibility changes (disclosure)
- NEW durable log (shared bili.log file): up to one
  `<ISO ts> [warn] [dsh-client] …` line per degradation event (bootstrap
  failure, unhealthy attach target, respawn give-up) where previously the only
  trace was a one-shot console.error invisible to GUI hosts. Old → new:
  stderr-only, possibly invisible → file + stderr. File shape identical to the
  proxy's own tee lines (`src/logger.ts`), origin-marked for grep.
- Log volume, never-registered conversation id: every rejected tool call →
  once per conversation (old text `id never registered (stale shim session id
  after host resume?)` replaced by the richer NO MODEL REQUESTS line). Reason:
  the old line repeated on every tool call while pointing at only one of
  several hypotheses.
- Wire: the `/__bili/plugin/tool` 404 `error` string for unknown conversations
  grows a guidance suffix; status code, JSON shape, and both matched substrings
  are unchanged.
- NEW client-side log (dsh process): up to one `bili-native-dsh: model request
  sent DIRECT (uncompressed) — takeover gate refused <origin+path>: …` line per
  distinct endpoint per process lifetime where previously there was none.
  Deliberate deviation from #1117's silent refusals, scoped by the per-endpoint
  dedupe so legitimate agentless traffic stays constant-noise.
- No change to model-request handling, compression, config schema, wire shapes,
  or persistence format.

## Verification
- `npm run typecheck`: clean.
- `npm test`: 2255 total, 2253 pass, 0 fail, 2 skipped (pre-existing gated
   skips); touched suites (issue1158 + dsh-native) all green, dsh-native 28/28.
- `npm run build`: success.
- Full E2E not run: no commit touches the request pipeline (server.ts /
  src/loop/* / adapters / preflight) or any wire shape — diagnostics only on
  already-failing paths. Local repro of the original symptom is impossible here
  (needs Windows + dsh web GUI); the owner is building a real dsh + bili + mock
  upstream harness and will post runtime results, which the new gate-refusal
  log is designed to make conclusive in one pass.

## Ceiling notes / deferred
- Generic interception of an arbitrary SDK-injected fetch is infeasible from
  bili's side (the function reference is private to the host module graph; pnpm
  isolation defeats cross-module patching; undici-internals patching too
  invasive). IF the transport-fetch-shape hypothesis survives the runtime
  evidence, the real fix belongs in dsh (lazy globalThis fetch resolution or a
  middleware seam) — cross-repo, stays manual.
- The reported agentless background lanes (dsh goal-round-driver / schedule,
  explicit `withoutInitiator()`) go direct BY DESIGN (owner's finding): their
  traffic now surfaces as one flat gate-refused line per endpoint instead of
  vanishing silently — visible, but intended uncompressed.
- `handlePluginCompact`'s analogous 404 wording left untouched (not part of
  the symptom; dsh-native has no compaction hook calling it).

## Follow-up: L2 gate three-state (branch 2026-09-23_dsh-gate-three-state-log)

Root cause was pinned by the reporter's runtime evidence (dsh-http-proxy
settings-refresh re-arm overwrites `globalThis.fetch` with its frozen
pre-bili capture, evicting bili from the chain); the owner shipped the L1
self-heal separately (#1187, guarded accessor + `BILI_RECLAIM_FETCH_PATCH`).
This follow-up delivers the agreed L2 instrument in `src/agent/dsh-native.ts`:

- `attributionOf(ctx)`: three states — `ok` (usable session id), `none`
  (initiator present-or-absent, no id), `threw` (+ exception message). The old
  bare catch folded `threw` into `none`. `sessionIdOf` is now a thin wrapper;
  statusOutcome/headersFor behavior is byte-identical.
- Gate refusal log: first refusal per endpoint prints exactly as before plus
  `— refusals so far: N`; same-state refusals accumulate silently; a state
  transition (none↔threw) re-prints with `(state none→threw)`. Bounded noise
  — #1117's per-request silence preserved; the 256-endpoint cap now clears
  only when a NEW endpoint would overflow (existing counts survive).
- Every printed line is additionally appended to bili.log via
  `persistClientEvent` (`[warn] [dsh-client] …`) so GUI hosts that swallow
  stderr leave a durable trace.

Behavior change disclosure (old → new):
- A gate refusal on a previously-unseen endpoint now ends with
  `— refusals so far: 1` (previously no count suffix).
- NEW log lines appear on attribution-state transitions
  (`(state none→threw)` / `(state threw→none)`) carrying the accumulated
  count — previously only one flat line per endpoint ever existed.
- NEW durable lines in `~/.local/state/billion-context/bili.log`
  (`[dsh-client]`-marked) mirroring every printed refusal line — previously
  refusals were stderr-only and invisible in GUI hosts.
- No change to gate decision logic, wire shapes, config schema, or persistence
  format.

Verification (head 2a6778df, based on master incl. merged #1187):
- `npm run typecheck`: clean (after `npm ci` — a stale local acp-kernel 0.0.82
  vs pinned 0.0.84 had produced spurious src/store.ts errors on the old tree).
- `npm test`: 2359 total, 2357 pass, 0 fail, 2 skipped (gated E2E);
  dsh-native 31/31 (+1 new three-state test covering silent counting,
  both transition directions, attributed-silent claim, and the durable
  bili.log copy).
- `npm run build`: success.
