/**
 * The prompt registry (Engineering-Rules §6: every prompt is a versioned file; inline
 * prompt strings in code are forbidden).
 *
 * Prompts are loaded from `<name>/vN.md`, split on the `## System` / `## User` headings,
 * with YAML-ish frontmatter carrying purpose, tier and eval notes. Versions are frozen on
 * ship: a change creates `v2.md` and the old file stays, so a score computed months ago
 * remains interpretable.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PROMPTS_DIR = dirname(fileURLToPath(import.meta.url));

export interface PromptTemplate {
  /** `name/version`, e.g. `taxonomy/v1` — recorded on every row it influences. */
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly system: string;
  readonly user: string;
  readonly frontmatter: Readonly<Record<string, string>>;
}

export class PromptNotFoundError extends Error {
  constructor(id: string, cause?: unknown) {
    super(`Prompt not found: ${id}`);
    this.name = "PromptNotFoundError";
    this.cause = cause;
  }
}

/** Minimal frontmatter reader — top-level `key: value` only, which is all the header needs. */
function parseFrontmatter(block: string): Record<string, string> {
  const result: Record<string, string> = {};
  let currentKey: string | null = null;

  for (const line of block.split("\n")) {
    const match = /^([a-z_]+):\s*(.*)$/i.exec(line);
    if (match !== null && match[1] !== undefined) {
      currentKey = match[1];
      result[currentKey] = (match[2] ?? "").trim();
      continue;
    }
    // Folded scalars (`>`) and list items continue the previous key.
    if (currentKey !== null && /^\s+\S/.test(line)) {
      result[currentKey] = `${result[currentKey] ?? ""} ${line.trim()}`.trim();
    }
  }
  return result;
}

const cache = new Map<string, PromptTemplate>();

/**
 * Loads and caches a prompt.
 *
 * Cached because prompts are immutable once shipped and a per-page analysis call should
 * not re-read the filesystem three hundred times.
 */
export function loadPrompt(name: string, version: string): PromptTemplate {
  const id = `${name}/${version}`;
  const cached = cache.get(id);
  if (cached !== undefined) return cached;

  let raw: string;
  try {
    raw = readFileSync(join(PROMPTS_DIR, name, `${version}.md`), "utf8");
  } catch (error) {
    throw new PromptNotFoundError(id, error);
  }

  const frontmatterMatch = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw);
  const frontmatter = frontmatterMatch === null ? {} : parseFrontmatter(frontmatterMatch[1] ?? "");
  const body = frontmatterMatch === null ? raw : (frontmatterMatch[2] ?? "");

  const systemMatch = /##\s+System\s*\n([\s\S]*?)(?=\n##\s+|$)/.exec(body);
  const userMatch = /##\s+User\s*\n([\s\S]*?)(?=\n##\s+|$)/.exec(body);

  if (systemMatch === null || userMatch === null) {
    throw new PromptNotFoundError(`${id} (missing a "## System" or "## User" section)`);
  }

  const template: PromptTemplate = {
    id,
    name,
    version,
    system: (systemMatch[1] ?? "").trim(),
    user: (userMatch[1] ?? "").trim(),
    frontmatter,
  };
  cache.set(id, template);
  return template;
}

/**
 * Fills `{{placeholders}}`.
 *
 * A missing variable throws rather than rendering an empty hole: silently sending a prompt
 * with a blank site name would produce plausible, wrong output — the worst failure mode
 * available to this system.
 */
export function render(template: string, variables: Readonly<Record<string, string>>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    const value = variables[key];
    if (value === undefined) {
      throw new Error(`Prompt variable "${key}" was not provided`);
    }
    return value;
  });
}

/** Clears the cache — for tests that edit prompt files. */
export function clearPromptCache(): void {
  cache.clear();
}
