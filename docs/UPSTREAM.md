# Upstream tracking

Both engines are vendored as plain source trees under `engines/`. The original
clones are kept in `_upstream/` (gitignored, not part of the project) for
reference and diffing.

| Engine | Upstream | Vendored commit |
|---|---|---|
| context-mode | https://github.com/mksglu/context-mode | `dad48de75686389612bba9ef842e459ee38134cd` |
| billion-context | https://github.com/ranxianglei/billion-context | `1f0397b0a9aed62cbaa192c7af47515e55f827b9` |

## Patch inventory

Keep this list in sync with the actual diff. Every patch must stay small and
reversible so upstream changes can be merged with a three-way diff.

### context-mode

1. `hooks/core/routing.mjs`
   - Adds `HYPERCONTEXT_ROUTING_MODE` (`strict` | `balanced` | `advisory`).
   - `strict`: upstream behavior.
   - `balanced`: WebFetch is allowed (its output is already model-processed),
     curl/wget and inline HTTP still route into the sandbox, build tools still
     route into the sandbox.
   - `advisory`: no deny/modify; only one-shot guidance.
2. `hooks/sessionstart.mjs`
   - Adds `HYPERCONTEXT_MEMORY_INJECTION=minimal`. Resume/compact injection is
     reduced to a pointer plus event counts; full snapshots remain searchable
     through `ctx_search`. Prevents memory re-injection from invalidating the
     compression proxy's prompt-cache prefix.
3. `src/server.ts`
   - Adds `CONTEXT_MODE_DISABLE_UPDATE_CHECK=1` to skip the hourly npm version
     check.

### billion-context

1. `src/hypercontext-bridge.ts` (new)
   - Reads context-mode content DBs with `node:sqlite` and returns a compact
     sandbox-index section for `search_context`.
   - Gated by `HYPERCONTEXT=1`; every error degrades to an empty string.
2. `src/decompress-shared.ts`
   - Imports the bridge and appends its output to `search_context` results.
   - `foreignSessionId` searches do not append sandbox hits.
   - Without `HYPERCONTEXT=1` the output is byte-identical to upstream.

Behavior (no source patch):

- `ACP_AUTO_UPDATE=0`
- `BILI_ADVISORY_CHECK=0`
- `BILI_RELEASE_NOTES_CHECK=0`
- `BILI_CONFIG_FILE` and `BILI_SESSIONS_DIR` under
  `~/.hypercontext/data/compression/`
- `XDG_*` roots under `~/.hypercontext` (CA, state, cache)

## Sync procedure

1. Fetch upstream into `_upstream/<engine>`.
2. Inspect `git log <vendored-commit>..origin/<branch>`.
3. Copy changed files into `engines/<engine>` (do not copy `.git`).
4. Re-apply the patches above by diffing against the pristine copy:
   `diff -ru _upstream/context-mode engines/context-mode`.
5. Rebuild both engines and run `npm test` plus the integration smoke test.
6. Update the commit table and `NOTICE.md`.
