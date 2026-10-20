import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { ensureHypercontextDirs, getHypercontextPaths } from "./paths.ts";

export const RoutingModeSchema = z.enum(["strict", "balanced", "advisory"]);
export type RoutingMode = z.infer<typeof RoutingModeSchema>;

export const MemoryInjectionSchema = z.enum(["auto", "full", "minimal"]);
export type MemoryInjection = z.infer<typeof MemoryInjectionSchema>;

export const CompressionModeSchema = z.enum(["cooperative", "autofold"]);
export type CompressionMode = z.infer<typeof CompressionModeSchema>;

export const ProfileSchema = z.enum(["balanced", "lean", "maximum"]);
export type Profile = z.infer<typeof ProfileSchema>;

export const McpToolsetSchema = z.enum(["auto", "full", "lean"]);
export type McpToolset = z.infer<typeof McpToolsetSchema>;

export const SummaryApiSchema = z.enum(["openai", "anthropic", "responses", "google"]);
export type SummaryApi = z.infer<typeof SummaryApiSchema>;

const SummaryProviderSchema = z
  .object({
    baseUrl: z
      .string()
      .url()
      .refine((value) => value.startsWith("http://") || value.startsWith("https://"), {
        message: "baseUrl must be an http(s) URL",
      }),
    api: SummaryApiSchema.default("openai"),
    apiKeyEnv: z.string().min(1).optional(),
    credentialRef: z.string().min(1).optional(),
    model: z.string().min(1),
    autoFoldTargetTokens: z.number().int().min(8192).max(10_000_000).default(40_000),
    concurrency: z.number().int().min(1).max(32).optional(),
  })
  .refine((value) => Boolean(value.apiKeyEnv) !== Boolean(value.credentialRef), {
    message: "Exactly one of apiKeyEnv or credentialRef is required",
    path: ["apiKeyEnv"],
  });

export type SummaryProvider = z.infer<typeof SummaryProviderSchema>;

const SandboxSchema = z.object({
  enabled: z.boolean().default(true),
  routing: RoutingModeSchema.default("balanced"),
  memoryInjection: MemoryInjectionSchema.default("auto"),
  autoIndexSessionEvents: z.boolean().default(true),
});

const CompressionSchema = z.object({
  enabled: z.boolean().default(true),
  host: z.string().default("127.0.0.1"),
  port: z.number().int().min(1024).max(65535).default(8787),
  mode: CompressionModeSchema.default("cooperative"),
  /** Do not inject the compression prompt/tools until the raw request is this
   *  large. A session latches open once it crosses the threshold, so native
   *  compaction cannot make the injection surface disappear mid-session. */
  coldStartTokens: z.number().int().min(0).max(10_000_000).default(32_000),
  /** Whether the compression surface (prompt + tools + nudge) is injected.
   *  "auto" keeps it on for cooperative mode and off for autoFold (the proxy
   *  folds by itself there). "off" removes it even in cooperative mode — the
   *  host's own compaction then owns the window and no folding tax is paid.
   *  Measured on a natively-compacting host: the injection costs ~4.5K tokens
   *  per request and pushed OpenCode's own compaction from 2 to 6 times over
   *  12 turns (+61% bytes on the wire). */
  inject: z.enum(["auto", "on", "off"]).default("auto"),
  summary: SummaryProviderSchema.optional(),
  autoUpdate: z.boolean().default(false),
  advisoryCheck: z.boolean().default(false),
  releaseNotesCheck: z.boolean().default(false),
});

const PricingSchema = z
  .object({
    currency: z.string().min(1).max(8).default("USD"),
    inputPerMTok: z.number().min(0).default(0),
    cachedInputPerMTok: z.number().min(0).default(0),
    outputPerMTok: z.number().min(0).default(0),
    summaryInputPerMTok: z.number().min(0).default(0),
    summaryOutputPerMTok: z.number().min(0).default(0),
  })
  .default({});

const ClientOverrideSchema = z.object({
  sandbox: z.boolean().optional(),
  compression: z.boolean().optional(),
  compressionMode: z.enum(["auto", "launcher", "plugin", "proxy"]).optional(),
});

export const HypercontextConfigSchema = z
  .object({
    version: z.literal(1).default(1),
    profile: ProfileSchema.default("balanced"),
    sandbox: SandboxSchema.default({}),
    compression: CompressionSchema.default({}),
    mcp: z
      .object({
        toolset: McpToolsetSchema.default("auto"),
      })
      .default({}),
    pricing: PricingSchema,
    memory: z
      .object({
        retentionDays: z.number().int().min(1).max(3650).default(30),
      })
      .default({}),
    clients: z.record(z.string(), ClientOverrideSchema).default({}),
    update: z
      .object({
        auto: z.boolean().default(false),
      })
      .default({}),
    telemetry: z
      .object({
        enabled: z.boolean().default(false),
      })
      .default({}),
  })
  .passthrough()
  .superRefine((config, ctx) => {
    if (config.compression.mode === "autofold" && !config.compression.summary) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["compression", "summary"],
        message: "compression.summary is required when compression.mode is autofold",
      });
    }
  });

export type HypercontextConfig = z.infer<typeof HypercontextConfigSchema>;

export class ConfigError extends Error {
  readonly configPath: string;

  constructor(configPath: string, message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "ConfigError";
    this.configPath = configPath;
  }
}

export function defaultConfig(): HypercontextConfig {
  return HypercontextConfigSchema.parse({});
}

/**
 * Apply a named operating preset. Presets are explicit user actions (the
 * `hctx profile` command or `hctx config set profile`); loading a config never
 * silently rewrites fields. Compression switches to auto-fold only when a
 * summary provider is already configured, because auto-fold without one would
 * pass the schema but fail closed at runtime.
 */
export function applyProfilePreset(config: HypercontextConfig, profile: Profile): HypercontextConfig {
  config.profile = profile;
  const hasSummary = config.compression.summary !== undefined;
  if (profile === "lean") {
    config.sandbox.enabled = true;
    config.compression.enabled = false;
    config.sandbox.memoryInjection = "full";
    config.mcp.toolset = "lean";
    return config;
  }
  config.sandbox.enabled = true;
  config.compression.enabled = true;
  config.compression.mode = hasSummary ? "autofold" : "cooperative";
  if (profile === "maximum") {
    config.sandbox.memoryInjection = "minimal";
    config.mcp.toolset = "full";
  } else {
    config.sandbox.memoryInjection = "auto";
    config.mcp.toolset = "auto";
  }
  return config;
}

/** Resolve the MCP facade preset. `auto` keeps the full surface only for the
 *  maximum profile; every other profile pays the lean schema cost. */
export function resolveMcpToolset(config: HypercontextConfig): "full" | "lean" {
  if (config.mcp.toolset === "full" || config.mcp.toolset === "lean") return config.mcp.toolset;
  return config.profile === "maximum" ? "full" : "lean";
}

export function loadConfig(opts: { create?: boolean } = {}): HypercontextConfig {
  const paths = ensureHypercontextDirs(getHypercontextPaths());
  const create = opts.create ?? true;

  if (!existsSync(paths.configFile)) {
    if (!create) return defaultConfig();
    const config = defaultConfig();
    saveConfig(config, paths.configFile);
    return config;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(paths.configFile, "utf8"));
  } catch (error) {
    throw new ConfigError(
      paths.configFile,
      `Invalid JSON in ${paths.configFile}. Fix or remove the file before continuing.`,
      error,
    );
  }

  const parsed = HypercontextConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ");
    throw new ConfigError(paths.configFile, `Invalid configuration at ${paths.configFile}: ${detail}`);
  }
  return parsed.data;
}

export function saveConfig(config: HypercontextConfig, file = getHypercontextPaths().configFile): void {
  ensureHypercontextDirs();
  const validated = HypercontextConfigSchema.parse(config);
  writeFileSync(file, `${JSON.stringify(validated, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  if (process.platform !== "win32") {
    try {
      chmodSync(file, 0o600);
    } catch {
      // best effort
    }
  }
}

export function updateConfig(mutator: (config: HypercontextConfig) => void): HypercontextConfig {
  const config = loadConfig();
  mutator(config);
  saveConfig(config);
  return config;
}
