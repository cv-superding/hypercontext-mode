// hooks/platform-bridge.mjs — Fire-and-forget event forwarder.
// Reads ~/.context-mode/platform.json {api_key, platform_url}.
// POSTs every event to ${platform_url}/events.
// Privacy: redacts secrets + normalizes $HOME before send.
// Backward-compat (PRD §5.3 Upgrade Lag): v1 events_url → platform_url; token → api_key.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";

const CACHE_TTL_MS = 60_000;
const FETCH_TIMEOUT_MS = 2_000;
const MAX_FIELD_LEN = 200;
const MAX_DEPTH = 4;

// Negative-cache sentinel — distinguishes "uninitialized" (null) from
// "we checked recently and there's no config" (NO_CONFIG). Without this,
// the unconfigured-user path would hit fs.readFileSync on every event.
const NO_CONFIG = Symbol("no-config");

let _cache = null;
let _cacheLoadedAt = 0;
let _warned = false; // dedupe stderr — log first failure only, reset on success
let _fsLoads = 0;    // test-only counter: how many times readConfig hit the FS

// === Cross-platform config path (bug-free across Win/Linux/Mac/WSL) ===
export function configPath() {
  if (process.platform === "win32") {
    const appdata = process.env.APPDATA;
    if (appdata) return path.join(appdata, "context-mode", "platform.json");
    // Fallback if APPDATA unset (rare — Git Bash without env)
    return path.join(os.homedir(), "AppData", "Roaming", "context-mode", "platform.json");
  }
  if (process.env.XDG_CONFIG_HOME) {
    return path.join(process.env.XDG_CONFIG_HOME, "context-mode", "platform.json");
  }
  return path.join(os.homedir(), ".context-mode", "platform.json");
}

function warn(msg) {
  if (_warned) return;
  _warned = true;
  process.stderr.write(`[context-mode] ${msg}\n`);
}

// v1 events_url + token alias kept for Upgrade Lag (PRD §5.3).
// Stray fields (version, hostname, device_id, endpoints.sessions, routes) silently ignored.
function normalizeConfig(raw) {
  if (!raw || typeof raw !== "object") return null;
  const api_key = raw.api_key ?? raw.token;
  let platform_url = raw.platform_url;
  if (!platform_url && raw.endpoints?.events) platform_url = String(raw.endpoints.events).replace(/\/events$/, "");
  if (!platform_url && raw.events_url) platform_url = String(raw.events_url).replace(/\/events$/, "");
  if (typeof api_key !== "string" || !api_key.startsWith("ctxm_")) return null;
  if (typeof platform_url !== "string" || !platform_url) return null;
  return { api_key, platform_url: platform_url.replace(/\/$/, "") };
}

function readConfig() {
  const now = Date.now();
  // Cache hit — covers BOTH positive (config object) and negative (NO_CONFIG) results.
  if (_cache !== null && now - _cacheLoadedAt < CACHE_TTL_MS) {
    return _cache === NO_CONFIG ? null : _cache;
  }
  _cacheLoadedAt = now;
  _fsLoads++;
  const cfgPath = configPath();

  let raw;
  try {
    raw = fs.readFileSync(cfgPath, "utf8");
  } catch (e) {
    if (e.code !== "ENOENT") warn(`cannot read ${cfgPath}: ${e.code || e.message}`);
    _cache = NO_CONFIG;
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    warn(`${cfgPath} is not valid JSON: ${e.message}`);
    _cache = NO_CONFIG;
    return null;
  }

  const normalized = normalizeConfig(parsed);
  if (!normalized) {
    warn(`${cfgPath} schema invalid — expected {api_key (ctxm_*), platform_url}`);
    _cache = NO_CONFIG;
    return null;
  }

  _warned = false; // success — re-arm warning for future failures
  _cache = normalized;
  return _cache;
}

// === Gate — cheap boolean for callers that want to skip allocations entirely ===
// `session-loaders.mjs` uses this BEFORE the per-event forwarding loop so the
// loop never executes when ~/.context-mode/platform.json is missing. Honors
// the same 60s TTL as readConfig() — first call hits the FS, subsequent calls
// within the TTL return the cached decision (positive or negative).
export function hasPlatformConfig() {
  return readConfig() !== null;
}

// === URL construction (single endpoint per ADR-0006) ===
export function buildUrl(cfg, _eventType) {
  return `${cfg.platform_url}/events`;
}

// === Project identity resolution — worktree-invariant canonicalization ===
// Filesystem path is the wrong identifier for "project": git worktrees fork
// the path while keeping the same repo, monorepos collapse N packages into
// one umbrella, and forks of the same repo look like different projects.
// Resolve to a stable identity using:
//   1. Closest package.json `name` if it lives DEEPER than the .git root
//      (monorepo sub-package — preserve granularity)
//   2. git config remote.origin.url, normalized
//      (worktrees of one repo collapse to one identity)
//   3. Closest package.json `name` at any depth
//      (local-only Node project)
//   4. basename(projectDir) (last resort)
const _projectIdentityCache = new Map();

function resolveProjectIdentity(projectDir) {
  if (typeof projectDir !== "string" || !projectDir) return null;
  if (_projectIdentityCache.has(projectDir)) return _projectIdentityCache.get(projectDir);
  const id = computeProjectIdentity(projectDir);
  _projectIdentityCache.set(projectDir, id);
  return id;
}

function computeProjectIdentity(projectDir) {
  let absoluteDir;
  try {
    absoluteDir = path.resolve(projectDir);
  } catch {
    return null;
  }
  const walked = walkUpFromDir(absoluteDir);
  const pkg = walked.packageJson;
  const gitTop = walked.gitToplevel;

  // (1) Monorepo sub-package: package.json STRICTLY deeper than .git root.
  if (pkg && gitTop && pkg.dir !== gitTop && pkg.dir.length > gitTop.length && pkg.name) {
    return pkg.name;
  }
  // (2) Git remote URL.
  const remote = gitTop ? readGitRemote(gitTop) : null;
  if (remote) return normalizeRemoteUrl(remote);
  // (3) Closest package.json (any depth).
  if (pkg?.name) return pkg.name;
  // (4) Basename.
  return path.basename(absoluteDir);
}

function walkUpFromDir(start) {
  let dir = start;
  let pkg = null;
  let gitTop = null;
  // Safety: cap walk to 64 levels; real filesystems never hit this.
  for (let i = 0; i < 64; i++) {
    if (!pkg) {
      const pkgPath = path.join(dir, "package.json");
      if (fs.existsSync(pkgPath)) {
        try {
          const parsed = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
          if (typeof parsed?.name === "string" && parsed.name.trim()) {
            pkg = { dir, name: parsed.name.trim() };
          }
        } catch { /* malformed — skip silently */ }
      }
    }
    if (!gitTop && fs.existsSync(path.join(dir, ".git"))) {
      gitTop = dir;
    }
    if (pkg && gitTop) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { packageJson: pkg, gitToplevel: gitTop };
}

function readGitRemote(gitTop) {
  try {
    const url = execSync("git config --get remote.origin.url", {
      cwd: gitTop,
      encoding: "utf8",
      timeout: 500,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return url || null;
  } catch {
    return null;
  }
}

// Canonical wire shape: host/path, lowercased host, no scheme, no .git suffix,
// no embedded credentials. All clone-equivalents collapse to one identity.
function normalizeRemoteUrl(url) {
  let u = String(url).trim();
  // SSH form (git@host:org/repo) → host/org/repo
  const sshMatch = u.match(/^[a-z0-9_-]+@([^:]+):(.+)$/i);
  if (sshMatch) {
    u = `${sshMatch[1]}/${sshMatch[2]}`;
  } else {
    // scheme://[user[:pass]@]host/path  →  host/path
    u = u.replace(/^[a-z]+:\/\/(?:[^@/]+@)?/i, "");
  }
  u = u.replace(/\.git\/?$/i, "").replace(/\/+$/, "");
  // Lowercase host segment only (paths can be case-sensitive)
  const slash = u.indexOf("/");
  if (slash > 0) {
    u = u.slice(0, slash).toLowerCase() + u.slice(slash);
  } else {
    u = u.toLowerCase();
  }
  return u;
}

// === Privacy: secret + PII redaction ===
const SECRETS = [
  /\b(?:ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]{20,}\b/g, // GitHub
  /\bAKIA[0-9A-Z]{16}\b/g,                                 // AWS
  /\bsk-(?:ant|proj)?-?[A-Za-z0-9_-]{32,}\b/g,             // OpenAI/Anthropic
  /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, // JWT
  /\bxox[bpoas]-[A-Za-z0-9-]{10,}\b/g,                     // Slack
  /\bglpat-[A-Za-z0-9_-]{20,}\b/g,                         // GitLab
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,   // emails
  /\b\d{3}-\d{2}-\d{4}\b/g,                                // SSN-like
];
const HOME = os.homedir();
const USER_DIR_RE = /(\/Users\/|\/home\/|\\+Users\\+)[^/\\]+/g;

function privacyTransform(s) {
  if (typeof s !== "string") return s;
  let out = s.split(HOME).join("<HOME>")
    .replace(USER_DIR_RE, (m) => m.replace(/[^/\\]+$/, "<USER>"));
  for (const re of SECRETS) out = out.replace(re, "[REDACTED]");
  return out;
}

function walk(obj, depth) {
  if (depth > MAX_DEPTH) return "[depth-limited]";
  if (obj == null) return obj;
  if (typeof obj === "string") {
    const cleaned = privacyTransform(obj);
    return cleaned.length > MAX_FIELD_LEN ? cleaned.slice(0, MAX_FIELD_LEN) + "…[truncated]" : cleaned;
  }
  if (Array.isArray(obj)) return obj.slice(0, 50).map((x) => walk(x, depth + 1));
  if (typeof obj === "object") {
    const out = {};
    for (const [k, v] of Object.entries(obj)) out[k] = walk(v, depth + 1);
    return out;
  }
  return obj;
}

export function sanitizeEvent(event) {
  return event && typeof event === "object" ? walk(event, 0) : event;
}

// === Public API ===
export async function maybeForward(event, platform, opts = {}) {
  const cfg = readConfig();
  if (!cfg) return;

  // Project identity must be resolved from the RAW projectDir — the resolver
  // reads `git config` against the actual filesystem path. After sanitize,
  // $HOME-normalization would break the lookup. We overlay the resolved id
  // back onto the event so the sanitize/walk path sees the canonical value
  // (URL or package name, which need no further normalization).
  const resolvedProject = resolveProjectIdentity(event?.projectDir);
  const eventWithProject = resolvedProject !== null
    ? { ...event, project: resolvedProject }
    : event;
  const ev = sanitizeEvent(eventWithProject);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(buildUrl(cfg, ev.type), {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${cfg.api_key}`,
        "Content-Type": "application/json",
        "X-Source-Platform": platform,
        "X-Schema-Version": "2",
      },
      // Canonical envelope (PRD §5.4 stability ABI):
      //   - All event fields passthrough — server-side Zod picks per event.type
      //   - `platform` envelope metadata (claude-code, cursor, ...)
      //   - `ts` defaulted from event or wall clock
      // Hand-mapping individual fields here is the anti-pattern: every new
      // event field forced a bridge release. With this envelope, new fields
      // ride the existing pipe and the platform schema is the only thing
      // that ever needs to learn them.
      body: JSON.stringify({
        ...ev,
        platform,
        ts: ev.ts ?? opts.ts ?? Math.floor(Date.now() / 1000),
      }),
      signal: ctrl.signal,
    });
    if (res.status === 401) { _cache = null; _cacheLoadedAt = 0; }
    else if (res.status === 429) {
      process.stderr.write(`[context-mode-platform] rate limited (retry after ${res.headers.get("Retry-After")}s)\n`);
    }
    return { ok: res.ok, status: res.status };
  } catch (e) {
    return { ok: false, status: 0, error: e.message };
  } finally {
    clearTimeout(t);
  }
}

export const _internal = {
  readConfig,
  normalizeConfig,
  buildUrl,
  sanitizeEvent,
  privacyTransform,
  configPath,
  resolveProjectIdentity,
  normalizeRemoteUrl,
  walkUpFromDir,
  resetState: () => {
    _cache = null;
    _cacheLoadedAt = 0;
    _warned = false;
    _fsLoads = 0;
    _projectIdentityCache.clear();
  },
  get fsLoads() { return _fsLoads; },
  get projectIdentityCacheSize() { return _projectIdentityCache.size; },
};
