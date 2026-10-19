import {
  buildPolicy,
  collectStats,
  ensureBillionConfig,
  federatedSearch,
  getEnginePaths,
  getHypercontextPaths,
  listClients,
  loadConfig,
  prepareRuntime,
  resolveClient,
  runtimeEnv,
  saveConfig,
  updateConfig,
} from "@hypercontext/core";
import {
  detectInstalledClients,
  formatDoctor,
  formatProxyOverview,
  formatSearchResult,
  formatStats,
  getDaemonStatus,
  getEngineStatus,
  planUninstall,
  requireBuiltEngines,
  runDoctor,
  runUninstall,
  runInteractive,
  runUnifiedMcp,
  setupClients,
  startDaemon,
  stopDaemon,
} from "@hypercontext/runtime";

const VERSION = "0.1.4";

const useColor = process.stdout.isTTY === true && !process.env.NO_COLOR;
const paint = (code: number) => (text: string): string =>
  useColor ? `\x1b[${code}m${text}\x1b[0m` : text;
const bold = paint(1);
const dim = paint(2);
const red = paint(31);
const green = paint(32);
const yellow = paint(33);
const cyan = paint(36);

interface ParsedArgs {
  options: Map<string, string>;
  flags: Set<string>;
  positionals: string[];
}

function parseArgs(argv: string[], valueFlags: ReadonlySet<string>): ParsedArgs {
  const options = new Map<string, string>();
  const flags = new Set<string>();
  const positionals: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--") {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (arg.startsWith("--")) {
      const equals = arg.indexOf("=");
      if (equals > 2) {
        options.set(arg.slice(2, equals), arg.slice(equals + 1));
      } else {
        const key = arg.slice(2);
        const next = argv[index + 1];
        if (valueFlags.has(key) && next !== undefined && !next.startsWith("-")) {
          options.set(key, next);
          index += 1;
        } else {
          flags.add(key);
        }
      }
    } else if (arg.startsWith("-") && arg !== "-") {
      flags.add(arg.replace(/^-+/, ""));
    } else {
      positionals.push(arg);
    }
  }
  return { options, flags, positionals };
}

function printHelp(): void {
  const lines = [
    `${bold("hctx")} ${dim(`v${VERSION}`)} — unified context runtime for AI coding agents`,
    "",
    "Usage:",
    "  hctx init                         Create the unified config and data directories",
    "  hctx setup [client...]            Show or write client integration artifacts",
    "  hctx clients                      List the client capability matrix",
    "  hctx start [--foreground]         Start the compression proxy daemon",
    "  hctx stop                         Stop the managed proxy",
    "  hctx status                       Unified health and savings report",
    "  hctx stats                        Detailed cross-layer statistics",
    "  hctx search <query...>            Search sandbox memory + compressed history",
    "                                    (current project by default; --all-projects to widen)",
    "  hctx index <path>                 Index a file or directory into the sandbox store",
    "  hctx doctor                       Diagnose the unified runtime",
    "  hctx mcp [--client <id>]          Run the unified stdio MCP server",
    "  hctx launch <client> [args...]    Launch a client through the proxy",
    "  hctx hook <platform> <event>      Dispatch a context-mode hook with unified env",
    "  hctx uninstall [--keep-data]      回滚客户端配置并删除统一状态",
  "  hctx config <path|show|set>       Inspect or edit the unified config",
    "  hctx version                      Print versions",
    "",
    "Setup flags:",
    "  --all            Select every client",
    "  --apply          Apply plugin + hook integration where supported (writes host config)",
    "  --plugin         Install the billion-context native plugin where supported",
    "  --hooks          Install context-mode hooks (writes host config; backup first)",
    "  --json           Machine-readable output",
    "",
    "All state lives under ~/.hypercontext (override with HYPERCONTEXT_HOME).",
  ];
  console.log(lines.join("\n"));
}

function printWarnings(warnings: string[]): void {
  if (warnings.length === 0) return;
  console.log("");
  for (const warning of warnings) console.log(`${yellow("warn")} ${warning}`);
}

function engineSummary(): string {
  const status = getEngineStatus();
  const context = status.contextMode.built
    ? `${green("built")} ${dim(status.contextMode.version ?? "")}`
    : red("missing");
  const compression = status.billionContext.built
    ? `${green("built")} ${dim(status.billionContext.version ?? "")}`
    : red("missing");
  return `context-mode ${context} · billion-context ${compression} · node ${status.node}`;
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const [command = "help", ...rest] = argv;
  if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }
  if (command === "version" || command === "--version" || command === "-V") {
    const status = getEngineStatus();
    console.log(`hctx ${VERSION}`);
    console.log(`context-mode ${status.contextMode.version ?? "not built"} (${status.contextMode.built ? "built" : "missing"})`);
    console.log(`billion-context ${status.billionContext.version ?? "not built"} (${status.billionContext.built ? "built" : "missing"})`);
    console.log(`node ${status.node}`);
    return;
  }

  if (command === "init") {
    const config = loadConfig();
    prepareRuntime(config);
    const paths = getHypercontextPaths();
    console.log(`${green("ok")} config: ${paths.configFile}`);
    console.log(`${green("ok")} data:   ${paths.dataDir}`);
    printWarnings(buildPolicy({ config }).warnings);
    console.log("");
    console.log(`Next: hctx setup --all   (or hctx setup <client>)`);
    return;
  }

  if (command === "setup") {
    const parsed = parseArgs(rest, new Set(["client"]));
    const json = parsed.flags.has("json");
    const all = parsed.flags.has("all");
    const apply = parsed.flags.has("apply");
    const applyHooks = apply || parsed.flags.has("hooks");
    const applyPlugin = apply || parsed.flags.has("plugin");
    const config = loadConfig();
    prepareRuntime(config);

    if (parsed.positionals.length === 0 && !all) {
      const detected = detectInstalledClients();
      if (json) {
        console.log(
          JSON.stringify(
            detected.map((entry) => ({
              id: entry.client.id,
              label: entry.client.label,
              detected: entry.detected,
              hints: entry.hints,
              hooks: entry.client.sandbox.hooks,
              mcp: entry.client.sandbox.mcp,
              launcher: entry.client.compression.launcher ?? null,
              plugin: entry.client.compression.plugin ?? null,
            })),
            null,
            2,
          ),
        );
        return;
      }
      console.log(bold("Detected clients"));
      for (const entry of detected) {
        const mark = entry.detected ? green("detected") : dim("not found");
        console.log(`  ${entry.client.id.padEnd(20)} ${mark.padEnd(18)} ${dim(entry.client.label)}`);
      }
      console.log("");
      console.log("Write integration artifacts for all clients: hctx setup --all");
      console.log("Write for selected clients:                  hctx setup qoder claude-code");
      console.log("Apply host changes where supported:         hctx setup --all --apply");
      console.log(dim("Setup never writes host config unless --apply / --hooks / --plugin is passed."));
      return;
    }

    const names = all ? listClients().map((client) => client.id) : parsed.positionals;
    const results = await setupClients(names, {
      applyHooks,
      applyPlugin,
      applyOnlyDetected: all,
      config,
      projectDir: process.cwd(),
    });
    if (json) {
      console.log(JSON.stringify(results, null, 2));
      return;
    }
    console.log(bold(`Setup: ${results.length} client(s)`));
    for (const result of results) {
      console.log("");
      console.log(`${cyan(result.client)}`);
      console.log(`  MCP config: ${result.artifacts.mcpConfigFile}`);
      console.log(`  Launcher:   ${result.artifacts.launcherCmd}`);
      if (result.hookResult) {
        if (result.hookResult.error) {
          console.log(`  Hooks:      ${red("failed")} ${result.hookResult.error}`);
        } else {
          console.log(`  Hooks:      ${green("ok")} ${result.hookResult.changes.length} change(s)${result.hookResult.backup ? ` · backup ${result.hookResult.backup}` : ""}`);
          for (const change of result.hookResult.changes) console.log(`              ${dim(change)}`);
        }
      } else if (!result.artifacts.hookSupported && result.artifacts.notes.some((note) => note.includes("no automatic"))) {
        console.log(`  Hooks:      ${dim("not available; unified MCP covers this client")}`);
      }
      if (result.pluginOutput) console.log(`  Plugin:     ${green("ok")} ${result.pluginOutput.split("\n")[0]}`);
      if (result.pluginError) console.log(`  Plugin:     ${red("failed")} ${result.pluginError}`);
      for (const note of result.artifacts.notes) console.log(`  ${dim(note)}`);
    }
    if (applyHooks || applyPlugin) {
      const changed = results.filter((result) => result.hostChanged);
      console.log("");
      if (changed.length > 0) {
        console.log(yellow(`Host settings modified for ${changed.length} client(s). Every supported adapter writes a backup before changes.`));
      } else {
        console.log(yellow("No host settings were modified (no selected client was detected or applicable)."));
      }
    }
    return;
  }

  if (command === "clients") {
    const parsed = parseArgs(rest, new Set());
    const rows = listClients().map((client) => ({
      id: client.id,
      label: client.label,
      hooks: client.sandbox.hooks,
      mcp: client.sandbox.mcp,
      launcher: client.compression.launcher ?? null,
      plugin: client.compression.plugin ?? null,
    }));
    if (parsed.flags.has("json")) {
      console.log(JSON.stringify(rows, null, 2));
      return;
    }
    console.log(`${bold("client".padEnd(20))} ${bold("hooks".padEnd(7))} ${bold("mcp".padEnd(5))} ${bold("compression".padEnd(14))} label`);
    for (const row of rows) {
      const compression = row.plugin ? `plugin:${row.plugin}` : row.launcher ? `launcher:${row.launcher}` : "proxy-only";
      console.log(
        `${row.id.padEnd(20)} ${(row.hooks ? "yes" : "-").padEnd(7)} ${(row.mcp ? "yes" : "-").padEnd(5)} ${compression.padEnd(14)} ${dim(row.label)}`,
      );
    }
    return;
  }

  if (command === "start") {
    const parsed = parseArgs(rest, new Set());
    const config = loadConfig();
    const policy = prepareRuntime(config);
    try {
      const state = await startDaemon(config, {
        foreground: parsed.flags.has("foreground"),
        restart: parsed.flags.has("restart"),
      });
      console.log(`${green("ok")} compression proxy: ${state.origin} (${state.mode}${state.pid ? `, pid ${state.pid}` : ""})`);
      console.log(`   MCP: hctx setup <client> writes the unified MCP config`);
      console.log(`   Log: ${state.logFile}`);
      printWarnings(policy.warnings);
    } catch (error) {
      console.error(`${red("error")} ${String(error)}`);
      process.exitCode = 1;
    }
    return;
  }

  if (command === "stop") {
    const config = loadConfig();
    prepareRuntime(config);
    const result = await stopDaemon(config);
    console.log(`${result.stopped ? green("ok") : yellow("noop")} ${result.reason}`);
    return;
  }

  if (command === "status") {
    const parsed = parseArgs(rest, new Set());
    const config = loadConfig();
    const policy = prepareRuntime(config);
    const daemon = await getDaemonStatus(config);
    const stats = collectStats();
    const report = {
      version: VERSION,
      policy: {
        mode: policy.mode,
        routing: policy.routingMode,
        memoryInjection: policy.memoryInjection,
        proxyOrigin: policy.proxyOrigin,
        warnings: policy.warnings,
      },
      daemon,
      engines: getEngineStatus(),
      stats,
    };
    if (parsed.flags.has("json")) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    console.log(bold(`HyperContext status ${dim(`v${VERSION}`)}`));
    console.log(`  engines: ${engineSummary()}`);
    console.log(`  policy:  ${policy.mode} · routing=${policy.routingMode} · memory=${policy.memoryInjection}`);
    console.log(
      `  proxy:   ${daemon.health.ok ? green(`healthy at ${policy.proxyOrigin}`) : yellow(`not running at ${policy.proxyOrigin}`)}${daemon.health.version ? dim(` v${daemon.health.version}`) : ""}`,
    );
    if (daemon.overview) console.log(`           ${dim(formatProxyOverview(daemon.overview))}`);
    if (daemon.stale) console.log(`  ${yellow("stale daemon state detected; run hctx stop or hctx start --restart")}`);
    printWarnings(policy.warnings);
    console.log("");
    console.log(formatStats(stats));
    return;
  }

  if (command === "stats") {
    const parsed = parseArgs(rest, new Set());
    const stats = collectStats();
    if (parsed.flags.has("json")) {
      console.log(JSON.stringify(stats, null, 2));
      return;
    }
    console.log(formatStats(stats));
    return;
  }

  if (command === "search") {
    const parsed = parseArgs(rest, new Set(["scope", "limit"]));
    const query = parsed.positionals.join(" ").trim();
    if (!query) {
      console.error(`${red("error")} hctx search requires a query`);
      process.exitCode = 2;
      return;
    }
    const scopeValue = parsed.options.get("scope");
    const scope = scopeValue === "sandbox" || scopeValue === "compression" ? scopeValue : "all";
    const limit = Number(parsed.options.get("limit") ?? "10");
    const allProjects = parsed.flags.has("all-projects");
    const result = federatedSearch({
      query,
      scope,
      limit: Number.isFinite(limit) ? limit : 10,
      projectDir: allProjects ? undefined : process.cwd(),
      allProjects,
    });
    if (parsed.flags.has("json")) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(formatSearchResult(result));
    return;
  }

  if (command === "index") {
    if (rest.length === 0) {
      console.error(`${red("error")} hctx index requires a file or directory path`);
      process.exitCode = 2;
      return;
    }
    requireBuiltEngines("context");
    const config = loadConfig();
    const policy = prepareRuntime(config);
    const code = await runInteractive(process.execPath, [getEnginePaths().contextMode.cliBundle, "index", ...rest], {
      env: runtimeEnv(policy),
      cwd: process.cwd(),
    });
    process.exitCode = code;
    return;
  }

  if (command === "doctor") {
    const parsed = parseArgs(rest, new Set());
    const config = loadConfig();
    prepareRuntime(config);
    if (parsed.flags.has("fix")) {
      const changed = ensureBillionConfig().changed;
      console.log(`${changed ? green("fixed") : dim("unchanged")} managed update channels`);
    }
    const report = await runDoctor(config);
    if (parsed.flags.has("json")) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(formatDoctor(report.checks));
    }
    if (!report.ok) process.exitCode = 1;
    return;
  }

  if (command === "mcp") {
    const parsed = parseArgs(rest, new Set(["client", "project"]));
    const client = parsed.options.get("client");
    const config = loadConfig();
    const policy = prepareRuntime(config, client);
    Object.assign(process.env, policy.env);
    try {
      await runUnifiedMcp({
        config,
        client,
        projectDir: parsed.options.get("project"),
      });
    } catch (error) {
      console.error(`hypercontext MCP failed: ${String(error)}`);
      process.exitCode = 1;
    }
    return;
  }

  if (command === "launch") {
    const clientId = rest[0];
    const clientArgs = rest.slice(1);
    if (!clientId) {
      console.error(`${red("error")} hctx launch requires a client id (see hctx clients)`);
      process.exitCode = 2;
      return;
    }
    const client = resolveClient(clientId);
    if (!client) {
      console.error(`${red("error")} Unknown client "${clientId}"`);
      process.exitCode = 2;
      return;
    }
    const config = loadConfig();
    const policy = prepareRuntime(config, client.id);
    const { planClientLaunch } = await import("@hypercontext/runtime");
    const plan = planClientLaunch(client.id, config, clientArgs);
    if (plan.command.length === 0) {
      console.log(plan.note);
      process.exitCode = 2;
      return;
    }
    requireBuiltEngines("compression");
    console.error(dim(plan.note));
    const code = await runInteractive(plan.command[0]!, plan.command.slice(1), {
      env: plan.env,
      cwd: plan.cwd,
    });
    process.exitCode = code;
    return;
  }

  if (command === "uninstall") {
    const parsed = parseArgs(rest, new Set());
    const keepData = parsed.flags.has("keep-data");
    const dryRun = parsed.flags.has("dry-run");
    const execute = parsed.flags.has("yes");
    const plan = await planUninstall({ keepData });

    if (parsed.flags.has("json")) {
      const result = execute ? await runUninstall(plan, { keepData, dryRun }) : null;
      console.log(JSON.stringify({ plan, executed: execute, dryRun, result }, null, 2));
      return;
    }

    console.log(bold("卸载计划 ") + dim(plan.stateDir));
    for (const action of plan.actions) {
      const mark =
        action.kind === "delete" ? red("delete ") : action.kind === "restore" ? yellow("restore") : action.kind === "stop" ? cyan("stop   ") : dim("manual ");
      console.log(`  ${mark} ${action.label} ${dim(action.target)}`);
      console.log(`           ${dim(action.detail)}`);
    }
    console.log("");
    if (!execute) {
      console.log(`${yellow("未执行")} 加 --yes 才真正动手；--keep-data 保留 ~/.hypercontext；--dry-run 演练。`);
      return;
    }
    const result = await runUninstall(plan, { keepData, dryRun });
    for (const line of result.done) console.log(`${green("ok  ")} ${line}`);
    for (const line of result.skipped) console.log(`${dim("skip")} ${line}`);
    for (const line of result.errors) console.log(`${red("err ")} ${line}`);
    if (dryRun) return;
    console.log("");
    console.log(
      result.errors.length > 0
        ? yellow("卸载未完全成功，请检查上面的 err。")
        : green("卸载完成。最后把源码仓库目录删掉即可。"),
    );
    return;
  }

  if (command === "hook") {
    const [platform, event, ...extra] = rest;
    if (!platform || !event) {
      console.error(`${red("error")} hctx hook requires <platform> <event>`);
      process.exitCode = 2;
      return;
    }
    const config = loadConfig();
    const policy = prepareRuntime(config);
    const env = { ...runtimeEnv(policy), CONTEXT_MODE_PLATFORM: platform };
    const code = await runInteractive(
      process.execPath,
      [getEnginePaths().contextMode.cliBundle, "hook", platform, event, ...extra],
      { env, cwd: process.cwd() },
    );
    process.exitCode = code;
    return;
  }

  if (command === "config") {
    const action = rest[0] ?? "show";
    const config = loadConfig();
    const paths = getHypercontextPaths();
    if (action === "path") {
      console.log(paths.configFile);
      return;
    }
    if (action === "show" || action === "get") {
      console.log(JSON.stringify(config, null, 2));
      return;
    }
    if (action === "init") {
      saveConfig(config);
      console.log(`${green("ok")} wrote ${paths.configFile}`);
      return;
    }
    if (action === "set") {
      const key = rest[1];
      const rawValue = rest[2];
      if (!key || rawValue === undefined) {
        console.error(`${red("error")} hctx config set requires <key> <value>`);
        process.exitCode = 2;
        return;
      }
      try {
        updateConfig((current) => setDottedValue(current as unknown as Record<string, unknown>, key, parseValue(rawValue)));
        console.log(`${green("ok")} ${key} = ${rawValue}`);
      } catch (error) {
        console.error(`${red("error")} ${String(error)}`);
        process.exitCode = 1;
      }
      return;
    }
    console.error(`${red("error")} Unknown config action "${action}". Use path, show, init or set.`);
    process.exitCode = 2;
    return;
  }

  console.error(`${red("error")} Unknown command "${command}". Run hctx help.`);
  process.exitCode = 2;
}

function parseValue(value: string): unknown {
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value;
}

function setDottedValue(target: Record<string, unknown>, key: string, value: unknown): void {
  const parts = key.split(".");
  if (parts.some((part) => part === "__proto__" || part === "prototype" || part === "constructor")) {
    throw new Error("Refusing to set a dangerous key.");
  }
  let cursor: Record<string, unknown> = target;
  for (const part of parts.slice(0, -1)) {
    const next = cursor[part];
    if (next === null || typeof next !== "object" || Array.isArray(next)) {
      cursor[part] = {};
    }
    cursor = cursor[part] as Record<string, unknown>;
  }
  cursor[parts[parts.length - 1]!] = value;
}

