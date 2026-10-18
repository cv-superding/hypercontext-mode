# NOTICE

HyperContext Mode is a combined work built from two upstream projects. The
upstream sources are vendored under `engines/` and modified for integration.

## Upstream projects

### context-mode

- Repository: https://github.com/mksglu/context-mode
- Author: Mert Koseoğlu
- Vendored commit: `dad48de75686389612bba9ef842e459ee38134cd`
- Vendored path: `engines/context-mode/`
- License: Elastic License 2.0 (ELv2). See
  `LICENSES/Elastic-2.0-context-mode.txt` and
  `engines/context-mode/LICENSE`.
- Scope: sandboxed tool execution, FTS5 knowledge base, session memory,
  platform hooks and MCP tool surface.

### billion-context

- Repository: https://github.com/ranxianglei/billion-context
- Author: ranxianglei
- Vendored commit: `1f0397b0a9aed62cbaa192c7af47515e55f827b9`
- Vendored path: `engines/billion-context/`
- License: MIT, plus the upstream "Attribution on Product Surfaces"
  additional term. See `LICENSES/MIT-billion-context.txt` and
  `engines/billion-context/LICENSE`.
- Scope: model API proxy, incremental hierarchical compression
  (`kernel/` / acp-kernel), launchers, native plugins and storage.

## Combined-work licensing

The combined repository is distributed under the union of the upstream terms:

- Code derived from `context-mode` remains subject to ELv2. In particular, it
  may not be offered to third parties as a hosted or managed service providing
  a substantial set of its features, and its copyright/license notices must be
  retained.
- Code derived from `billion-context` remains subject to MIT and its additional
  attribution term. The MIT notice must be retained.
- New code in `packages/` is provided under the same terms as the component it
  integrates with. No attempt is made to relicense upstream code.

Because ELv2 applies to a substantial part of this repository, the combined
work as a whole is **not** MIT-licensed. It is intended for local and internal
use. Publishing a hosted service or an npm package requires a separate license
review.

## Modifications in this repository

The engines are kept intact except for small, documented integration patches:

- `engines/context-mode/hooks/core/routing.mjs`: adds a routing-mode switch so
  WebFetch / curl / inline HTTP interception can be `strict`, `balanced`, or
  `advisory` instead of always hard-blocking.
- `engines/context-mode/hooks/sessionstart.mjs`: adds a minimal memory
  injection mode so resumed context does not invalidate the compression
  proxy's prefix cache.
- `engines/context-mode/src/server.ts`: allows disabling the hourly npm
  version check.
- `engines/billion-context/src/hypercontext-bridge.ts` (new) and
  `src/decompress-shared.ts` (one import + output append): when
  `HYPERCONTEXT=1`, proxy-side `search_context` also queries context-mode's
  sandbox FTS5 index. Without that env var the output is byte-identical to
  upstream, so upstream tests and behavior are unchanged.
- Auto-update, advisory checks and release-note checks are disabled through
  billion-context's supported environment and config surfaces (no source
  patch needed).

See `docs/UPSTREAM.md` for the sync procedure and patch inventory.
