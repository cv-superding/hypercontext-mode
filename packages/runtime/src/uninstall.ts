/**
 * Reversible uninstall.
 *
 * Order matters: stop the proxy first (it owns daemon.json), roll host configs
 * back second (they reference files we are about to delete), and only then drop
 * the unified state directory.
 */
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getHypercontextPaths, loadConfig } from "@hypercontext/core";
import { stopDaemon } from "./daemon.ts";
import { isHypercontextHookEntry } from "./setup.ts";

export type UninstallKind = "stop" | "restore" | "delete" | "manual";

export interface UninstallAction {
  id: string;
  kind: UninstallKind;
  label: string;
  target: string;
  detail: string;
}

export interface UninstallOptions {
  keepData?: boolean;
  /** Account home that holds client config dirs (~/.claude, ~/.codex, …). */
  userHome?: string;
  env?: Record<string, string | undefined>;
}

export interface UninstallPlan {
  userHome: string;
  stateDir: string;
  actions: UninstallAction[];
}

export interface UninstallResult {
  done: string[];
  skipped: string[];
  errors: string[];
}

function hookSettingsFiles(home: string, env: Record<string, string | undefined>): Array<{ label: string; file: string }> {
  const claudeDir = env.CLAUDE_CONFIG_DIR?.trim() || join(home, ".claude");
  return [
    { label: "Claude Code", file: join(claudeDir, "settings.json") },
    { label: "Gemini CLI", file: join(home, ".gemini", "settings.json") },
    { label: "Qwen Code", file: join(home, ".qwen", "settings.json") },
  ];
}

function countHookEntries(settings: Record<string, unknown>): number {
  const hooks = settings.hooks;
  if (!hooks || typeof hooks !== "object") return 0;
  let count = 0;
  for (const entries of Object.values(hooks as Record<string, unknown>)) {
    if (!Array.isArray(entries)) continue;
    count += entries.filter((entry) => isHypercontextHookEntry(entry)).length;
  }
  return count;
}

function stripHookEntries(settings: Record<string, unknown>): Record<string, unknown> {
  const source = settings.hooks;
  const hooks: Record<string, unknown> = {};
  if (source && typeof source === "object") {
    for (const [event, entries] of Object.entries(source as Record<string, unknown>)) {
      if (!Array.isArray(entries)) {
        hooks[event] = entries;
        continue;
      }
      const kept = entries.filter((entry) => !isHypercontextHookEntry(entry));
      if (kept.length > 0) hooks[event] = kept;
    }
  }
  return { ...settings, hooks };
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function stripCodexBlock(text: string): { text: string; removed: number } {
  const lines = text.split(/\r?\n/);
  const kept: string[] = [];
  let skipping = false;
  let removed = 0;
  for (const line of lines) {
    const header = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (header) {
      skipping = header[1].trim().toLowerCase() === "mcp_servers.hypercontext";
      if (skipping) {
        removed++;
        continue;
      }
    } else if (skipping) {
      continue;
    }
    kept.push(line);
  }
  return { text: kept.join("\n").replace(/\n{3,}/g, "\n\n"), removed };
}

export async function planUninstall(options: UninstallOptions = {}): Promise<UninstallPlan> {
  const env = options.env ?? process.env;
  const configured = env.HYPERCONTEXT_HOME?.trim();
  const userHome = options.userHome ?? homedir();
  const stateDir = configured && configured.length > 0 ? configured : join(userHome, ".hypercontext");
  const paths = getHypercontextPaths({ ...env, HYPERCONTEXT_HOME: stateDir });
  const actions: UninstallAction[] = [];

  if (existsSync(paths.daemonStateFile)) {
    actions.push({
      id: "daemon",
      kind: "stop",
      label: "停止本地压缩代理",
      target: paths.daemonStateFile,
      detail: "按 daemon.json 里的 pid 优雅退出",
    });
  }

  for (const { label, file } of hookSettingsFiles(userHome, env)) {
    if (!existsSync(file)) continue;
    const settings = readJson(file);
    if (!settings) continue;
    const count = countHookEntries(settings);
    if (count === 0) continue;
    actions.push({
      id: `hooks:${label}`,
      kind: "restore",
      label: `还原 ${label} hooks`,
      target: file,
      detail: `移除 ${count} 条 hypercontext hook 条目，其余配置原样保留`,
    });
  }

  const codexFile = join(userHome, ".codex", "config.toml");
  if (existsSync(codexFile) && /^\s*\[mcp_servers\.hypercontext\]\s*$/m.test(readFileSync(codexFile, "utf-8"))) {
    actions.push({
      id: "codex",
      kind: "restore",
      label: "还原 Codex MCP 配置",
      target: codexFile,
      detail: "删除 [mcp_servers.hypercontext] 段，其余内容不动",
    });
  }

  if (options.keepData) {
    actions.push({
      id: "keep:data",
      kind: "manual",
      label: "保留统一数据",
      target: stateDir,
      detail: "--keep-data：配置、会话与索引留在原地，重装时可直接复用",
    });
  } else {
    actions.push({
      id: "del:state",
      kind: "delete",
      label: "删除统一目录",
      target: stateDir,
      detail: "配置、会话记忆、压缩索引、启动器工件（不可恢复）",
    });
  }

  const installerRoot = env.LOCALAPPDATA ? join(env.LOCALAPPDATA, "HyperContext") : "";
  if (installerRoot && existsSync(installerRoot)) {
    actions.push({
      id: "del:installer",
      kind: "delete",
      label: "删除安装器目录",
      target: installerRoot,
      detail: "安装器下载的便携 Node / 源码副本 / 日志",
    });
  }

  actions.push({
    id: "manual:clients",
    kind: "manual",
    label: "需手动处理",
    target: "Qoder / WorkBuddy / DeepSeek Harness",
    detail: "这些客户端里的 MCP 条目要在客户端自己的设置中删除；源码仓库目录请自行删除",
  });

  return { userHome, stateDir, actions };
}

export async function runUninstall(plan: UninstallPlan, options: UninstallOptions & { dryRun?: boolean } = {}): Promise<UninstallResult> {
  const result: UninstallResult = { done: [], skipped: [], errors: [] };

  for (const action of plan.actions) {
    if (action.kind === "manual") {
      result.skipped.push(`${action.label}：${action.detail}`);
      continue;
    }
    if (options.dryRun) {
      result.skipped.push(`[dry-run] ${action.label} → ${action.target}`);
      continue;
    }

    try {
      if (action.kind === "stop") {
        const stopped = await stopDaemon(loadConfig({ create: false }));
        result.done.push(`${action.label}：${stopped.reason}`);
        continue;
      }
      if (action.kind === "restore") {
        if (action.id === "codex") {
          const original = readFileSync(action.target, "utf-8");
          const stripped = stripCodexBlock(original);
          if (stripped.removed === 0) {
            result.skipped.push(`${action.label}：未找到该段`);
            continue;
          }
          copyFileSync(action.target, `${action.target}.hypercontext-uninstall.bak`);
          writeFileSync(action.target, stripped.text, "utf-8");
          result.done.push(`${action.label}：已删除 ${stripped.removed} 段，备份 ${action.target}.hypercontext-uninstall.bak`);
          continue;
        }
        const settings = readJson(action.target);
        if (!settings) {
          result.skipped.push(`${action.label}：文件不是合法 JSON，未改动`);
          continue;
        }
        const count = countHookEntries(settings);
        if (count === 0) {
          result.skipped.push(`${action.label}：没有需要移除的条目`);
          continue;
        }
        copyFileSync(action.target, `${action.target}.hypercontext-uninstall.bak`);
        writeFileSync(action.target, JSON.stringify(stripHookEntries(settings), null, 2) + "\n", "utf-8");
        result.done.push(`${action.label}：移除 ${count} 条，备份 ${action.target}.hypercontext-uninstall.bak`);
        continue;
      }
      if (action.kind === "delete") {
        if (!existsSync(action.target)) {
          result.skipped.push(`${action.label}：目录不存在`);
          continue;
        }
        rmSync(action.target, { recursive: true, force: true });
        result.done.push(`${action.label}：已删除 ${action.target}`);
      }
    } catch (error) {
      result.errors.push(`${action.label} 失败：${String(error)}`);
    }
  }

  return result;
}
