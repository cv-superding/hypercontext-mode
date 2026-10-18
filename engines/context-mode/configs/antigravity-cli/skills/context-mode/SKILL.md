---
name: context-mode
description: Mandatory routing rules for Antigravity CLI. Invoke when exploring a codebase, reading files for analysis, listing context-mode tools, searching, parsing, counting, comparing, summarizing, fetching web content, or running data-heavy commands.
---

# context-mode for Antigravity CLI

context-mode MCP tools are available in agy as `context-mode/<tool>`.
Use these tools directly. Do not inspect cached schema files under
`~/.gemini/antigravity-cli/mcp/context-mode/*.json`, and do not run
`ctx_execute` just to discover tool names or schemas.

If agy uses the generic MCP wrapper, call `call_mcp_tool` with:

- `ServerName`: `"context-mode"`
- `ToolName`: one of the tool names below
- `Arguments`: the JSON arguments for that tool

## Tool List

- `context-mode/ctx_execute`: run JavaScript, TypeScript, Python, shell, or
  other code in a sandbox. Print only the final answer.
- `context-mode/ctx_execute_file`: read one file into `FILE_CONTENT` inside the
  sandbox and run code over it. This is the context-mode file-read surface.
- `context-mode/ctx_batch_execute`: run multiple repository commands in one
  batch, index large output, and answer follow-up queries.
- `context-mode/ctx_index`: store a file, directory, or content in the local
  FTS5 knowledge base for later search.
- `context-mode/ctx_search`: search indexed content and captured session
  memory. Batch related questions in `queries`.
- `context-mode/ctx_fetch_and_index`: fetch web content, store it, then query
  with `ctx_search`.
- `context-mode/ctx_stats`: show context savings and current-session stats.
- `context-mode/ctx_doctor`: diagnose context-mode runtime and hook health.
- `context-mode/ctx_upgrade`: provide upgrade or repair guidance.
- `context-mode/ctx_purge`: purge stored context-mode knowledge after
  confirmation.
- `context-mode/ctx_insight`: launch or report the Insight analytics app.

When the user asks "what context-mode tools are available", answer from this
list. Do not list `~/.gemini/antigravity-cli/mcp/context-mode` and do not read
the JSON schema files.

## File Reading

There is no separate `ctx_read` tool. Use `context-mode/ctx_execute_file` for
file reads that analyze, summarize, extract, count, filter, or compare.

Native `Read` / `view_file` is only right when editing needs exact bytes in the
conversation, or when the user explicitly asks to view a small known range.

Use JavaScript by default for lightweight file analysis:

```json
{
  "path": "README.md",
  "language": "javascript",
  "code": "const lines = FILE_CONTENT.split(/\\r?\\n/); console.log(lines.slice(0, 20).join('\\n'));"
}
```

Never print `FILE_CONTENT` wholesale unless the user explicitly asks for a full
file dump. Print selected lines, counts, matches, summaries, or structured
results.

## Codebase Exploration

For repository exploration, prefer one `context-mode/ctx_batch_execute` call
instead of many native `ListDir`, `Read`, `Grep`, or shell calls.

For one-off computed answers, use `context-mode/ctx_execute`.
For one-file analysis, use `context-mode/ctx_execute_file`.
For durable recall across follow-up questions, use `context-mode/ctx_index`
with a descriptive `source`, then `context-mode/ctx_search`.

Return concise derived answers. Do not paste raw command dumps, full files,
large search results, cached schemas, or raw HTML into the conversation.
