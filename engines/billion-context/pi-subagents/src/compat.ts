/** Normalize systemPrompt to a single string (join with newlines if array). */
export function normalizeSystemPrompt(input: string | string[] | undefined): string {
  if (input === undefined) return "";
  if (Array.isArray(input)) return input.join("\n");
  return input;
}

/** Append this package's prompt section to the host's current system prompt.
 *  Always returns a string to satisfy pi's type definition, but handles both
 *  string (pi) and string[] (omp) input types at runtime. */
export function formatSystemPromptForEvent(base: string | string[], append: string): string {
  const normalized = normalizeSystemPrompt(base);
  return `${normalized}\n\n${append}`;
}
