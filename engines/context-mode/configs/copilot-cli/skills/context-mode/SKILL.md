---
name: context-mode
description: MANDATORY routing rules for context-mode. Invoke whenever you analyze, count, filter, compare, search, parse, or transform data; fetch a URL; or run a data-heavy command — so raw bytes stay out of the context window.
---

# context-mode — MANDATORY routing rules

context-mode MCP tools are available in GitHub Copilot CLI. These rules protect
the context window from flooding — one unrouted command can dump tens of KB into
the conversation. Follow them strictly.

## Think in Code — MANDATORY

Analyze / count / filter / compare / search / parse / transform data: **write
code** via `ctx_execute(language, code)` and `console.log()` only the answer. Do
NOT read raw data into context. PROGRAM the analysis, do not COMPUTE it by
reading. One script replaces ten tool calls.

## BLOCKED — do NOT use

- **curl / wget** — dumps raw HTTP into context. Use
  `ctx_fetch_and_index(url, source)` then `ctx_search(queries)`.
- **Inline HTTP** (`node -e "fetch(...)"`, `python -c "requests.get(...)"`) — use
  `ctx_execute(language, code)`; only stdout enters context.
- **Reading large files to analyze** — use
  `ctx_execute_file(path, language, code)`.

## Tool selection

1. **GATHER**: `ctx_batch_execute(commands, queries)` — runs all commands,
   auto-indexes, returns search. One call replaces dozens.
2. **PROCESS**: `ctx_execute` / `ctx_execute_file` — sandbox; only stdout enters
   context.
3. **WEB**: `ctx_fetch_and_index(url, source)` then `ctx_search(queries)` — raw
   HTML never enters context.
4. **SEARCH**: `ctx_search(queries: [...])` — all questions in one call.

Write artifacts to FILES; return a path + one-line description, not inline dumps.
