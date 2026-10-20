import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { ensureHypercontextDirs, getHypercontextPaths } from "./paths.ts";

export const RoutingModeSchema = z.enum(["strict", "balanced", "advisory"]);
export type RoutingMode = z.infer<typeof RoutingModeSchema>;

export const MemoryInjectionSchema = z.enum(["auto", "full", "minimal"]);
export type MemoryInjection = z.infer<typeof MemoryInjectionSchema>;

export const CompressionModeSchema = z.enum(["cooperative", "autofold"]);
export type CompressionMode = z.infer<typeof CompressionModeSchema>;

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
  summary: SummaryProviderSchema.optional(),
  autoUpdate: z.boolean().default(false),
  advisoryCheck: z.boolean().default(false),
  releaseNotesCheck: z.boolean().default(false),
});

const ClientOverrideSchema = z.object({
  sandbox: z.boolean().optional(),
  compression: z.boolean().optional(),
  compressionMode: z.enum(["auto", "launcher", "plugin", "proxy"]).optional(),
});

export const HypercontextConfigSchema = z
  .object({
    version: z.literal(1).default(1),
    profile: z.enum(["balanced", "lean", "maximum"]).default("balanced"),
    sandbox: SandboxSchema.default({}),
    compression: CompressionSchema.default({}),
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
