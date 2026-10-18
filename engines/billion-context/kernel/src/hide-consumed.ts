import { clampPrefix } from "./truncate.js";
import { BLOCKED_REF } from "./refs.js";
import { COMPRESS_TOOL_NAME } from "./compress-tools.js";
import type { CompressionState, CoreMessage } from "./types.js";

// Orphaned compress calls (no matching block — failed attempts, or historical
// calls whose blocks predate compressCallId recording) keep their NEWEST two
// call+result pairs visible: failures must stay observable or a deterministic
// model re-issues the same no-op compress forever, pinned at a fixed point
// (billion-context-pi issue #9: 3,849 identical calls over 5h13m under
// KEEP_LAST_ORPHANED=0). Older orphans are hidden, so the residue is bounded
// at two pairs regardless of session length — PR #18's unbounded accumulation
// does not return (its own live check showed the cap: 10 in → 6 out).
const KEEP_LAST_ORPHANED = 2;

export interface HideConsumedResult {
  messages: CoreMessage[];
  hidden: number;
  /** Padded refs of the orphan compress call/result messages hidden by this
   *  pass (orphans beyond the keep window). Consumed by boundary resolution to
   *  snap a range endpoint onto a hidden-but-intact orphan (#396). */
  hiddenOrphanRefs: string[];
}

function rangeKey(startRef: string, endRef: string): string {
  return `${startRef}::${endRef}`;
}

// Named return type (not inline): with the object literal in the signature,
// prettier's layout heuristic was not idempotent here (#416).
interface ParsedCallText {
  prefix: string;
  obj: Record<string, unknown>;
  content: unknown[];
  contentWasString: boolean;
}

// Adapters (pi) persist the rendered ref tag in front of the tool-call text,
// so the JSON args no longer start at index 0. Locate the first "{" instead of
// parsing the raw text — the prefix is preserved on output.
function parseCallText(text: string | undefined): ParsedCallText | null {
  const raw = text ?? "";
  const start = raw.indexOf("{");
  if (start < 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  let content: unknown[] | null = null;
  let contentWasString = false;
  if (Array.isArray(obj.content)) {
    content = obj.content;
  } else if (typeof obj.content === "string") {
    // Non-strict-tool providers (qwen etc.) sometimes stringify the content
    // array inside the JSON args; the compress tool accepts it, so the
    // rewrite must too. Measured: ALL 52 calls in the billion-context-pi
    // #336 storm session used this form (#230).
    contentWasString = true;
    try {
      const inner: unknown = JSON.parse(obj.content);
      if (Array.isArray(inner)) content = inner;
    } catch {
      content = null;
    }
  }
  if (!content || content.length === 0) return null;
  return { prefix: raw.slice(0, start), obj, content, contentWasString };
}

// Range keys a compress call's args quote, using the same startId/endId
// (messageId fallback) extraction as rewriteCompressText so identity-by-range
// resolves against exactly what the live-range compaction compares.
function quotedRangeKeys(text: string | undefined): Set<string> {
  const parsed = parseCallText(text);
  if (!parsed) return new Set<string>();
  const out = new Set<string>();
  for (const entry of parsed.content) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const s =
      typeof e.startId === "string"
        ? e.startId
        : typeof e.messageId === "string"
          ? e.messageId
          : "";
    const end =
      typeof e.endId === "string"
        ? e.endId
        : typeof e.messageId === "string"
          ? e.messageId
          : "";
    if (s && end) out.add(rangeKey(s, end));
  }
  return out;
}

function rewriteCompressText(
  text: string | undefined,
  liveKeys: Set<string>,
): string | null {
  const parsed = parseCallText(text);
  if (!parsed) return null;
  const { prefix, obj, content, contentWasString } = parsed;

  const kept = content.filter((entry): entry is Record<string, unknown> => {
    if (!entry || typeof entry !== "object") return false;
    const e = entry as Record<string, unknown>;
    const s =
      typeof e.startId === "string"
        ? e.startId
        : typeof e.messageId === "string"
          ? e.messageId
          : "";
    const end =
      typeof e.endId === "string"
        ? e.endId
        : typeof e.messageId === "string"
          ? e.messageId
          : "";
    return liveKeys.has(rangeKey(s, end));
  });

  if (kept.length === 0) return null;

  return prefix + serializeCompacted(obj, kept, contentWasString).text;
}

// Live compress-call args duplicate every range's full summary text while the
// rendered acp_summary message already carries it — on long sessions the
// duplication alone measured ~22K tokens (billion-context-pi #336). Keep a
// leading stub for recall; the block remains the durable record.
const SUMMARY_STUB_CHARS = 200;

function compactEntry(entry: unknown): unknown {
  if (!entry || typeof entry !== "object") return entry;
  const e = entry as Record<string, unknown>;
  if (typeof e.summary !== "string" || e.summary.length <= SUMMARY_STUB_CHARS)
    return entry;
  return {
    ...e,
    summary: `${clampPrefix(e.summary, SUMMARY_STUB_CHARS - 1)}…`,
  };
}

function serializeCompacted(
  obj: Record<string, unknown>,
  content: unknown[],
  contentWasString: boolean,
): { text: string; changed: boolean } {
  let changed = false;
  const compacted = content.map((entry) => {
    const out = compactEntry(entry);
    if (out !== entry) changed = true;
    return out;
  });
  // Preserve the original shape: a stringified content array stays a string
  // so downstream text comparisons and replays are unaffected.
  const outContent = contentWasString ? JSON.stringify(compacted) : compacted;
  return { text: JSON.stringify({ ...obj, content: outContent }), changed };
}

function compactCompressText(text: string | undefined): string | null {
  const parsed = parseCallText(text);
  if (!parsed) return null;
  const { prefix, obj, content, contentWasString } = parsed;
  const { text: out, changed } = serializeCompacted(
    obj,
    content,
    contentWasString,
  );
  return changed ? prefix + out : null;
}

export function hideConsumedCompressCalls(
  state: CompressionState,
  messages: CoreMessage[],
  isCompressTool: (toolName: string) => boolean = (name) =>
    name === COMPRESS_TOOL_NAME,
): HideConsumedResult {
  const allBlockCallIds = new Set<string>();
  const activeCallIds = new Set<string>();
  const liveRangeKeysByCallId = new Map<string, Set<string>>();
  const legacyLiveByCallId = new Set<string>();
  // Range keys over ALL blocks / ACTIVE blocks only — identity-by-range for
  // foreign-name carriers whose synthetic block id never equals the re-sent
  // host call id (#2970). Only consulted for non-bare-name calls, so the
  // proxy / in-process path is untouched.
  const anyBlockRangeKeys = new Set<string>();
  const activeRangeKeys = new Set<string>();
  for (const block of state.blocks) {
    if (!block.compressCallId) continue;
    allBlockCallIds.add(block.compressCallId);
    if (block.startRef !== undefined && block.endRef !== undefined) {
      anyBlockRangeKeys.add(rangeKey(block.startRef, block.endRef));
    }
    if (!block.active) continue;
    activeCallIds.add(block.compressCallId);
    if (block.startRef === undefined || block.endRef === undefined) {
      legacyLiveByCallId.add(block.compressCallId);
      continue;
    }
    activeRangeKeys.add(rangeKey(block.startRef, block.endRef));
    let keys = liveRangeKeysByCallId.get(block.compressCallId);
    if (!keys) {
      keys = new Set<string>();
      liveRangeKeysByCallId.set(block.compressCallId, keys);
    }
    keys.add(rangeKey(block.startRef, block.endRef));
  }

  type Fate = "active" | "inactive" | "orphan";
  const resolveFate = (message: CoreMessage): Fate => {
    const id = message.toolCallId;
    if (id && activeCallIds.has(id)) return "active";
    if (id && allBlockCallIds.has(id)) return "inactive";
    // Foreign-name carriers resolve by the range they quote (their block's
    // startRef/endRef). Bare-name is always id-matched, so this branch is
    // unreachable for it — stated explicitly so it cannot drift onto that path.
    if (!id || message.toolName === COMPRESS_TOOL_NAME) return "orphan";
    const quoted = quotedRangeKeys(message.text);
    for (const k of quoted) if (activeRangeKeys.has(k)) return "active";
    for (const k of quoted) if (anyBlockRangeKeys.has(k)) return "inactive";
    return "orphan";
  };

  const infos: { isCompressCall: boolean; fate: Fate }[] = messages.map(
    (message) => {
      const isCompressCall =
        !!message.toolName &&
        isCompressTool(message.toolName) &&
        message.contentType === "tool-call";
      return {
        isCompressCall,
        fate: isCompressCall ? resolveFate(message) : "orphan",
      };
    },
  );

  const lastOrphaned = new Set<string>();
  for (
    let i = messages.length - 1;
    i >= 0 && lastOrphaned.size < KEEP_LAST_ORPHANED;
    i--
  ) {
    const info = infos[i]!;
    const callId = messages[i]!.toolCallId;
    if (info.isCompressCall && callId && info.fate === "orphan") {
      lastOrphaned.add(callId);
    }
  }

  const keepCallIds = new Set<string>();
  const hiddenCallIds = new Set<string>();
  for (let i = 0; i < messages.length; i++) {
    const info = infos[i]!;
    const callId = messages[i]!.toolCallId;
    if (!info.isCompressCall || !callId) continue;
    if (
      info.fate === "inactive" ||
      (info.fate === "orphan" && !lastOrphaned.has(callId))
    ) {
      hiddenCallIds.add(callId);
    } else {
      keepCallIds.add(callId);
    }
  }

  const fateByCallId = new Map<string, Fate>();
  for (let i = 0; i < messages.length; i++) {
    const info = infos[i]!;
    const callId = messages[i]!.toolCallId;
    if (info.isCompressCall && callId) fateByCallId.set(callId, info.fate);
  }

  let hidden = 0;
  const hiddenOrphanRefs: string[] = [];
  const rememberHiddenRef = (message: CoreMessage): void => {
    const fate = message.toolCallId
      ? fateByCallId.get(message.toolCallId)
      : undefined;
    if (fate !== "orphan") return;
    const ref = state.messageRefs.byRaw[message.id];
    if (ref && ref !== BLOCKED_REF && !hiddenOrphanRefs.includes(ref)) {
      hiddenOrphanRefs.push(ref);
    }
  };
  const result: CoreMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!;
    const info = infos[i]!;
    if (
      info.isCompressCall &&
      (!message.toolCallId || hiddenCallIds.has(message.toolCallId))
    ) {
      hidden++;
      rememberHiddenRef(message);
      continue;
    }
    if (
      message.contentType === "tool-result" &&
      message.toolCallId &&
      hiddenCallIds.has(message.toolCallId)
    ) {
      hidden++;
      rememberHiddenRef(message);
      continue;
    }
    if (
      info.isCompressCall &&
      message.toolCallId &&
      keepCallIds.has(message.toolCallId)
    ) {
      let liveKeys = liveRangeKeysByCallId.get(message.toolCallId);
      if (
        !liveKeys &&
        !legacyLiveByCallId.has(message.toolCallId) &&
        message.toolName !== COMPRESS_TOOL_NAME
      ) {
        // Foreign-name carrier: derive live ranges from what it quotes (its own
        // block's active ranges) — the by-callId index is keyed on the synthetic
        // block id, not the host call id.
        const derived = new Set<string>();
        for (const k of quotedRangeKeys(message.text)) {
          if (activeRangeKeys.has(k)) derived.add(k);
        }
        liveKeys = derived;
      }
      if (
        liveKeys &&
        liveKeys.size > 0 &&
        !legacyLiveByCallId.has(message.toolCallId)
      ) {
        const rewritten = rewriteCompressText(message.text, liveKeys);
        if (rewritten !== null) {
          result.push({ ...message, text: rewritten });
          continue;
        }
      }
      const compacted = compactCompressText(message.text);
      if (compacted !== null) {
        result.push({ ...message, text: compacted });
        continue;
      }
    }
    result.push(message);
  }

  return { messages: result, hidden, hiddenOrphanRefs };
}
