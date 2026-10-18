# WORKLOG — jcode launcher (`bili jcode`)

## Date
2026-09-13

## What was done (this commit)
- src/launcher.ts: LAUNCH_CLIENTS += "jcode"; BaseClientName += "jcode";
  buildJcodeEnv (exported); runLaunch jcode branch; launcherInjectMcp
  skips jcode; discoverRoutes jcode branch; import/re-export of
  JCODE_DEFAULT_MODEL_HOSTS.
- src/client-config.ts: JCODE_DEFAULT_MODEL_HOSTS = ["api.z.ai"];
  ModelWindowScope += "jcode".
- src/cli.ts: help usage row, launcher list, mechanism para, example.
- tests/launcher.test.ts: isLaunchClient jcode case; buildJcodeEnv case
  (HTTPS_PROXY/SSL_CERT_FILE/BILLION_CONTEXT_PROXY/NO_PROXY loopback,
  baseEnv preserved); discoverRoutes jcode allowlist case.

## Verification
`node --import tsx --test tests/launcher.test.ts`: 155 tests, 154 pass.
The single failure ("runLaunch trae: cert-MITM envs...") reproduces on the
clean tree with ambient NODE_EXTRA_CA_CERTS set (test asserts the variable
is absent from the env while the ambient environment leaks it in); it is
pre-existing and unrelated to this series.

## Ceiling notes / deferred
- No jcode config reader: discoverRoutes for jcode whitelists only
  JCODE_DEFAULT_MODEL_HOSTS. jcode config is TOML (~/.jcode/config.toml);
  adding a TOML reader would enable per-provider host discovery the way
  trae reads JSON. Until then, extra MITM domains ride ambient
  BILI_MITM_DOMAINS. Loopback legs stay direct via the built-in NO_PROXY.
- No collectModelWindows branch for jcode (convention: unhandled scopes
  collect nothing).
