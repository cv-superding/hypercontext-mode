import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CORE_DIR = dirname(fileURLToPath(import.meta.url));

export const REPO_ROOT = resolve(CORE_DIR, "../../..");

export interface HypercontextPaths {
  home: string;
  configFile: string;
  stateDir: string;
  logsDir: string;
  dataDir: string;
  cacheDir: string;
  daemonStateFile: string;
  daemonLogFile: string;
  contextDataDir: string;
  contextSessionsDir: string;
  contextContentDir: string;
  compressionDataDir: string;
  compressionSessionsDir: string;
  compressionConfigFile: string;
  clientStateDir: string;
}

export interface EnginePaths {
  contextMode: {
    root: string;
    server: string;
    cliBundle: string;
    hooksDir: string;
    packageJson: string;
  };
  billionContext: {
    root: string;
    distEntry: string;
    packageJson: string;
  };
}

export function getHypercontextPaths(env: NodeJS.ProcessEnv = process.env): HypercontextPaths {
  const configured = env.HYPERCONTEXT_HOME?.trim();
  const home = configured ? resolve(configured) : join(homedir(), ".hypercontext");
  const stateDir = join(home, "state");
  const dataDir = join(home, "data");
  const contextDataDir = join(dataDir, "context-mode");
  const compressionDataDir = join(dataDir, "compression");

  return {
    home,
    configFile: join(home, "config.json"),
    stateDir,
    logsDir: join(stateDir, "logs"),
    dataDir,
    cacheDir: join(home, "cache"),
    daemonStateFile: join(stateDir, "daemon.json"),
    daemonLogFile: join(stateDir, "logs", "proxy.log"),
    contextDataDir,
    contextSessionsDir: join(contextDataDir, "sessions"),
    contextContentDir: join(contextDataDir, "content"),
    compressionDataDir,
    compressionSessionsDir: join(compressionDataDir, "sessions"),
    compressionConfigFile: join(compressionDataDir, "config.json"),
    clientStateDir: join(stateDir, "clients"),
  };
}

export function ensureHypercontextDirs(paths = getHypercontextPaths()): HypercontextPaths {
  for (const dir of [
    paths.home,
    paths.stateDir,
    paths.logsDir,
    paths.dataDir,
    paths.cacheDir,
    paths.contextDataDir,
    paths.contextSessionsDir,
    paths.contextContentDir,
    paths.compressionDataDir,
    paths.compressionSessionsDir,
    paths.clientStateDir,
  ]) {
    mkdirSync(dir, { recursive: true });
  }
  return paths;
}

export function getEnginePaths(repoRoot = REPO_ROOT): EnginePaths {
  const contextRoot = join(repoRoot, "engines", "context-mode");
  const billionRoot = join(repoRoot, "engines", "billion-context");
  return {
    contextMode: {
      root: contextRoot,
      server: join(contextRoot, "build", "server.js"),
      cliBundle: join(contextRoot, "cli.bundle.mjs"),
      hooksDir: join(contextRoot, "hooks"),
      packageJson: join(contextRoot, "package.json"),
    },
    billionContext: {
      root: billionRoot,
      distEntry: join(billionRoot, "dist", "index.js"),
      packageJson: join(billionRoot, "package.json"),
    },
  };
}
