/**
 * Hook entry point used by every installed client hook.
 *
 * Hosts launch hooks from arbitrary working directories and with their own
 * environment. This wrapper is deliberately dependency-free (no zod, no
 * SQLite) so hook latency stays low, then sets the unified storage and policy
 * environment before importing the context-mode hook script.
 *
 * Usage: node hook-wrapper.ts <platform> <script-name>
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");
const ENGINE_HOOKS = join(REPO_ROOT, "engines", "context-mode", "hooks");

interface MinimalConfig {
  sandbox?: { routing?: string; memoryInjection?: string; enabled?: boolean };
  compression?: { enabled?: boolean; host?: string; port?: number };
}

function resolveHome(argv: string[]): string {
  const index = argv.indexOf("--home");
  if (index >= 0 && argv[index + 1]) return resolve(argv[index + 1]!);
  return process.env.HYPERCONTEXT_HOME?.trim()
    ? resolve(process.env.HYPERCONTEXT_HOME.trim())
    : join(homedir(), ".hypercontext");
}

function readConfig(home: string): MinimalConfig {
  const file = join(home, "config.json");
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8")) as MinimalConfig;
  } catch {
    return {};
  }
}

function main(): void {
  const home = resolveHome(process.argv);
  const offset = process.argv.includes("--home") ? 2 : 0;
  const platform = process.argv[2 + offset] ?? "";
  const script = (process.argv[3 + offset] ?? "").replace(/\\/g, "/");
  if (!platform || !script || !/^(?:[a-z0-9-]+\/)?[a-z-]+\.mjs$/.test(script)) {
    process.exit(0);
  }

  const config = readConfig(home);
  const compressionEnabled = config.compression?.enabled !== false;
  const routing = config.sandbox?.routing ?? "balanced";
  const memoryInjection =
    config.sandbox?.memoryInjection && config.sandbox.memoryInjection !== "auto"
      ? config.sandbox.memoryInjection
      : compressionEnabled
        ? "minimal"
        : "full";
  const contextDir = join(home, "data", "context-mode");

  process.env.HYPERCONTEXT = "1";
  process.env.HYPERCONTEXT_HOME = home;
  process.env.CONTEXT_MODE_DIR = contextDir;
  process.env.CONTEXT_MODE_DATA_DIR = contextDir;
  process.env.CONTEXT_MODE_DISABLE_UPDATE_CHECK = "1";
  process.env.CONTEXT_MODE_PLATFORM = platform;
  process.env.HYPERCONTEXT_ROUTING_MODE = routing;
  process.env.HYPERCONTEXT_MEMORY_INJECTION = memoryInjection;
  process.env.HYPERCONTEXT_COMPRESSION = compressionEnabled ? "1" : "0";

  const scriptPath = resolve(ENGINE_HOOKS, script);
  if (!scriptPath.startsWith(ENGINE_HOOKS) || !existsSync(scriptPath)) {
    process.exit(0);
  }

  import(pathToFileURL(scriptPath).href).catch(() => {
    // Hooks must fail open: never block the host because our layer broke.
    process.exit(0);
  });
}

main();
