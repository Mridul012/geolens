/**
 * Turning model text into a validated value (Engineering-Rules §6).
 *
 * Three rules, none negotiable:
 *
 * 1. **Never parse leniently.** No coercing, no "close enough", no filling in fields the
 *    model omitted. Model output is untrusted input.
 * 2. **Exactly one repair retry.** Enough to survive a stray markdown fence or a trailing
 *    comma; not enough to burn budget arguing with a model that cannot follow the schema.
 * 3. **Then a typed failure.** The caller degrades and flags. It never guesses, and it
 *    never half-saves.
 */

export interface ExtractedJson {
  readonly value: unknown;
  /** True when the raw text needed unwrapping — a signal worth logging, not an error. */
  readonly unwrapped: boolean;
}

/**
 * Pulls a JSON value out of model text.
 *
 * Models wrap JSON in ```json fences, prepend "Here is the JSON:", or append a closing
 * remark, however firmly instructed otherwise. Stripping that is not lenient parsing — the
 * JSON itself is still parsed strictly and still validated against the schema.
 */
export function extractJson(text: string): ExtractedJson | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;

  const direct = tryParse(trimmed);
  if (direct !== undefined) return { value: direct, unwrapped: false };

  // ```json … ``` or bare ``` … ```
  const fenced = /```(?:json)?\s*\n?([\s\S]*?)\n?```/.exec(trimmed);
  if (fenced?.[1] !== undefined) {
    const parsed = tryParse(fenced[1].trim());
    if (parsed !== undefined) return { value: parsed, unwrapped: true };
  }

  // Prose around a single object or array: take the outermost balanced span.
  const span = outermostJsonSpan(trimmed);
  if (span !== null) {
    const parsed = tryParse(span);
    if (parsed !== undefined) return { value: parsed, unwrapped: true };
  }

  return null;
}

function tryParse(text: string): unknown | undefined {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Finds the outermost balanced `{…}` or `[…]`, ignoring braces inside strings. */
function outermostJsonSpan(text: string): string | null {
  const start = text.search(/[{[]/);
  if (start === -1) return null;

  const opener = text[start];
  const closer = opener === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (char === opener) depth += 1;
    else if (char === closer) {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}

export interface SchemaLike<T> {
  safeParse: (value: unknown) => { success: true; data: T } | { success: false; error: unknown };
}

export type ValidationOutcome<T> =
  | { readonly ok: true; readonly value: T; readonly unwrapped: boolean }
  | { readonly ok: false; readonly reason: "unparseable"; readonly detail: string }
  | { readonly ok: false; readonly reason: "invalid"; readonly detail: string };

export function validateAgainst<T>(text: string, schema: SchemaLike<T>): ValidationOutcome<T> {
  const extracted = extractJson(text);
  if (extracted === null) {
    return {
      ok: false,
      reason: "unparseable",
      detail: `No JSON value found in ${text.length} characters of output.`,
    };
  }

  const parsed = schema.safeParse(extracted.value);
  if (!parsed.success) {
    return { ok: false, reason: "invalid", detail: describeIssues(parsed.error) };
  }

  return { ok: true, value: parsed.data, unwrapped: extracted.unwrapped };
}

/** A short, model-readable account of what was wrong — the repair prompt's payload. */
export function describeIssues(error: unknown): string {
  const issues = (error as { issues?: Array<{ path?: unknown[]; message?: string }> }).issues;
  if (!Array.isArray(issues)) return String((error as Error).message ?? error);
  return issues
    .slice(0, 10)
    .map((issue) => `- ${(issue.path ?? []).join(".") || "(root)"}: ${issue.message ?? "invalid"}`)
    .join("\n");
}

/**
 * The repair instruction.
 *
 * Deliberately terse and mechanical: it names what failed and asks for the object again.
 * Re-sending the whole original prompt would double the input cost for a formatting slip.
 */
export function repairPrompt(previousOutput: string, problem: string): string {
  return [
    "Your previous response did not match the required schema.",
    "",
    "Problems:",
    problem,
    "",
    "Previous response:",
    previousOutput.slice(0, 4_000),
    "",
    "Return the corrected JSON object only. No markdown fences, no explanation.",
  ].join("\n");
}
