// #2186: esbuild alias target for the single runtime host import inside the
// inlined billion-context-pi-subagents bundle. The package's config-dir
// module namespace-imports @earendil-works/pi-coding-agent only to read
// CONFIG_DIR_NAME and falls back to ".pi" when the export is absent — the
// documented degradation for hosts that alias the pi package to their own
// build. Leaving the import resolvable would force a runtime dependency on
// the full pi agent; aliasing it to this empty module keeps dist/agent/pi.js
// dependency-free, preserving bili's zero-runtime-dependency contract.
export {};
