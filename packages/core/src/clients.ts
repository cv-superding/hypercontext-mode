/**
 * Unified client capability matrix.
 *
 * `sandbox` is the context-mode half (hook routing + MCP sandbox tools).
 * `compression` is the billion-context half (model API proxy, launcher or
 * native plugin). `proxy: true` means the client can always be routed through
 * the proxy by pointing its base URL at the local proxy, even when no launcher
 * or native plugin exists.
 */
export interface ClientDefinition {
  id: string;
  label: string;
  aliases: readonly string[];
  sandbox: {
    hooks: boolean;
    mcp: boolean;
    platform?: string;
  };
  compression: {
    proxy: boolean;
    launcher?: string;
    plugin?: string;
  };
  notes?: string;
}

const CLIENTS: readonly ClientDefinition[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    aliases: ["claude", "claudecode"],
    sandbox: { hooks: true, mcp: true, platform: "claude-code" },
    compression: { proxy: true, launcher: "claude", plugin: "claude" },
  },
  {
    id: "codex",
    label: "OpenAI Codex CLI",
    aliases: ["codex-cli"],
    sandbox: { hooks: true, mcp: true, platform: "codex" },
    compression: { proxy: true, launcher: "codex", plugin: "codex" },
  },
  {
    id: "gemini-cli",
    label: "Gemini CLI",
    aliases: ["gemini"],
    sandbox: { hooks: true, mcp: true, platform: "gemini-cli" },
    compression: { proxy: true, launcher: "gemini" },
  },
  {
    id: "qwen-code",
    label: "Qwen Code",
    aliases: ["qwen"],
    sandbox: { hooks: true, mcp: true, platform: "qwen-code" },
    compression: { proxy: true, launcher: "qwen" },
  },
  {
    id: "opencode",
    label: "OpenCode",
    aliases: [],
    sandbox: { hooks: true, mcp: true, platform: "opencode" },
    compression: { proxy: true, launcher: "opencode", plugin: "opencode" },
  },
  {
    id: "kilo",
    label: "Kilo Code",
    aliases: ["kilocode"],
    sandbox: { hooks: true, mcp: true, platform: "kilo" },
    compression: { proxy: true },
    notes: "Hooks reuse the OpenCode adapter.",
  },
  {
    id: "omp",
    label: "OMP (oh-my-pi)",
    aliases: ["oh-my-pi"],
    sandbox: { hooks: true, mcp: true, platform: "omp" },
    compression: { proxy: true, launcher: "omp", plugin: "omp" },
  },
  {
    id: "pi",
    label: "pi",
    aliases: [],
    sandbox: { hooks: true, mcp: true, platform: "pi" },
    compression: { proxy: true, launcher: "pi", plugin: "pi" },
  },
  {
    id: "cursor",
    label: "Cursor",
    aliases: [],
    sandbox: { hooks: true, mcp: true, platform: "cursor" },
    compression: { proxy: true },
  },
  {
    id: "copilot-cli",
    label: "GitHub Copilot CLI",
    aliases: ["copilot"],
    sandbox: { hooks: true, mcp: true, platform: "copilot-cli" },
    compression: { proxy: true, launcher: "copilot" },
  },
  {
    id: "vscode-copilot",
    label: "VS Code Copilot",
    aliases: ["vscode"],
    sandbox: { hooks: true, mcp: true, platform: "vscode-copilot" },
    compression: { proxy: true },
  },
  {
    id: "jetbrains-copilot",
    label: "JetBrains Copilot",
    aliases: ["jetbrains"],
    sandbox: { hooks: true, mcp: true, platform: "jetbrains-copilot" },
    compression: { proxy: true },
  },
  {
    id: "zed",
    label: "Zed",
    aliases: [],
    sandbox: { hooks: true, mcp: true, platform: "zed" },
    compression: { proxy: true, launcher: "zed" },
  },
  {
    id: "kiro",
    label: "Kiro",
    aliases: [],
    sandbox: { hooks: true, mcp: true, platform: "kiro" },
    compression: { proxy: true },
  },
  {
    id: "antigravity",
    label: "Antigravity IDE",
    aliases: ["antigravity-ide"],
    sandbox: { hooks: true, mcp: true, platform: "antigravity" },
    compression: { proxy: true, launcher: "antigravity" },
  },
  {
    id: "antigravity-cli",
    label: "Antigravity CLI (agy)",
    aliases: ["agy"],
    sandbox: { hooks: true, mcp: true, platform: "antigravity-cli" },
    compression: { proxy: true, launcher: "antigravity" },
  },
  {
    id: "kimi",
    label: "Kimi Code",
    aliases: ["kimi-code"],
    sandbox: { hooks: true, mcp: true, platform: "kimi" },
    compression: { proxy: true, launcher: "kimi", plugin: "kimi" },
  },
  {
    id: "openclaw",
    label: "OpenClaw",
    aliases: [],
    sandbox: { hooks: true, mcp: true, platform: "openclaw" },
    compression: { proxy: true },
  },
  {
    id: "qoder-intl",
    label: "Qoder 国际版",
    aliases: ["qoder", "qoder-international"],
    sandbox: { hooks: false, mcp: true },
    compression: { proxy: true, launcher: "qoder" },
    notes: "Compression uses the launcher's certificate MITM path. Sandbox is available through the unified MCP endpoint.",
  },
  {
    id: "qoder-cn",
    label: "Qoder 国内版",
    aliases: ["qoder-china", "qoder-cn-version"],
    sandbox: { hooks: false, mcp: true },
    compression: { proxy: true, launcher: "qoder" },
    notes: "国内版与国际版分开管理；代理启动器共用 qoder，MCP 工件单独生成。",
  },
  {
    id: "workbuddy-intl",
    label: "WorkBuddy 国际版",
    aliases: ["workbuddy", "workbuddy-international"],
    sandbox: { hooks: false, mcp: true },
    compression: { proxy: true },
    notes: "Manual MCP/proxy integration: use the generated MCP artifact and point the model base URL at the local proxy.",
  },
  {
    id: "workbuddy-cn",
    label: "WorkBuddy 国内版",
    aliases: ["workbuddy-china"],
    sandbox: { hooks: false, mcp: true },
    compression: { proxy: true },
    notes: "国内版单独生成 MCP 工件；压缩层通过本地代理 base URL 接入。",
  },
  {
    id: "trae",
    label: "TRAE",
    aliases: [],
    sandbox: { hooks: false, mcp: true },
    compression: { proxy: true, launcher: "trae" },
  },
  {
    id: "codebuddy",
    label: "CodeBuddy",
    aliases: [],
    sandbox: { hooks: false, mcp: true },
    compression: { proxy: true, launcher: "codebuddy" },
  },
  {
    id: "iflow",
    label: "iFlow CLI",
    aliases: [],
    sandbox: { hooks: false, mcp: true },
    compression: { proxy: true, launcher: "iflow" },
  },
  {
    id: "mcode",
    label: "MiniMax Code",
    aliases: ["minimax", "minimax-code"],
    sandbox: { hooks: false, mcp: true },
    compression: { proxy: true, launcher: "mcode" },
  },
  {
    id: "aider",
    label: "aider",
    aliases: [],
    sandbox: { hooks: false, mcp: true },
    compression: { proxy: true, launcher: "aider" },
  },
  {
    id: "amp",
    label: "Amp CLI",
    aliases: [],
    sandbox: { hooks: false, mcp: true },
    compression: { proxy: true, launcher: "amp" },
  },
  {
    id: "crush",
    label: "Charm Crush",
    aliases: [],
    sandbox: { hooks: false, mcp: true },
    compression: { proxy: true, launcher: "crush" },
  },
  {
    id: "goose",
    label: "Goose",
    aliases: [],
    sandbox: { hooks: false, mcp: true },
    compression: { proxy: true, launcher: "goose" },
  },
  {
    id: "hermes",
    label: "Hermes Agent",
    aliases: [],
    sandbox: { hooks: false, mcp: true },
    compression: { proxy: true, launcher: "hermes", plugin: "hermes" },
  },
  {
    id: "dsh",
    label: "deepseek-harness",
    aliases: ["deepseek-harness"],
    sandbox: { hooks: false, mcp: true },
    compression: { proxy: true, launcher: "dsh", plugin: "dsh" },
  },
  {
    id: "jcode",
    label: "jcode",
    aliases: [],
    sandbox: { hooks: false, mcp: true },
    compression: { proxy: true, launcher: "jcode" },
  },
  {
    id: "zcode",
    label: "zcode (Z.ai)",
    aliases: ["z-ai"],
    sandbox: { hooks: false, mcp: true },
    compression: { proxy: true, launcher: "zcode" },
    notes: "Native plugin; the launcher is used as a fallback.",
  },
];

const BY_ID = new Map<string, ClientDefinition>(CLIENTS.map((client) => [client.id, client]));
const BY_ALIAS = new Map<string, ClientDefinition>();
for (const client of CLIENTS) {
  for (const alias of client.aliases) BY_ALIAS.set(alias.toLowerCase(), client);
  BY_ALIAS.set(client.id.toLowerCase(), client);
}

export function listClients(): readonly ClientDefinition[] {
  return CLIENTS;
}

export function resolveClient(name: string): ClientDefinition | undefined {
  const key = name.trim().toLowerCase();
  return BY_ID.get(key) ?? BY_ALIAS.get(key);
}

export function requireClient(name: string): ClientDefinition {
  const client = resolveClient(name);
  if (!client) {
    const known = CLIENTS.map((entry) => entry.id).join(", ");
    throw new Error(`Unknown client "${name}". Known clients: ${known}`);
  }
  return client;
}

export function findClientByPlatform(platform: string): ClientDefinition | undefined {
  return CLIENTS.find((client) => client.sandbox.platform === platform);
}

export function findClientByLauncher(launcher: string): ClientDefinition | undefined {
  return CLIENTS.find((client) => client.compression.launcher === launcher);
}
