# REQ — jcode launcher (`bili jcode`)

## Date
2026-09-13

## Background
jcode (https://github.com/1jehuang/jcode) is a Rust terminal coding-agent
harness now in daily use in this environment with two model legs: a hosted
`zai` leg (api.z.ai, GLM) and a local unsloth loopback. Hosted legs should
ride the bili cert-MITM proxy like every other launched client; the loopback
leg must stay direct. jcode keeps its own MCP config and does not read a
JSON/TOML client config the launcher could rewrite, so the trae-style
"env-only MITM" pattern is the right fit.

## Requirements
1. `bili jcode [--] [args]` launches jcode through the proxy with
   HTTPS_PROXY + SSL_CERT_FILE (combined CA) set, exactly like the codex and
   trae paths, plus NO_PROXY covering loopback so local model servers bypass.
2. Default MITM domain allowlist for the jcode leg covers api.z.ai without
   user config; compression for other hosts stays opt-in via ambient
   BILI_MITM_DOMAINS (no TOML config reader yet — see WORKLOG ceiling note).
3. MCP injection is skipped for jcode (it manages its own ~/.jcode/mcp.json).
4. Existing clients' behavior unchanged.

## Solution
Same shape as the trae path:
- `LAUNCH_CLIENTS`/`BaseClientName` gain `jcode`; `launcherInjectMcp`
  false-lists it.
- `buildJcodeEnv()` mirrors `buildTraeEnv()` and adds
  `NO_PROXY=no_proxy=localhost,127.0.0.1,::1`.
- `runLaunch` jcode branch wires `origin` + `resolveCombinedCaPath` +
  `stripInheritedProxy`.
- `discoverRoutes` whitelists `JCODE_DEFAULT_MODEL_HOSTS = ["api.z.ai"]`
  (new export in `src/client-config.ts`; host:port reduced to host, lowercased).
- `ModelWindowScope` union gains `jcode` (no collector branch, matching
  hermes/dsh/qoder/trae convention: unhandled scopes collect nothing).
- cli.ts help gains the jcode row, list mention, mechanism note, and example.

Tests: `tests/launcher.test.ts` — isLaunchClient(jcode) true;
buildJcodeEnv env assertions incl. NO_PROXY loopback + baseEnv preservation;
discoverRoutes jcode allowlist assertion.
