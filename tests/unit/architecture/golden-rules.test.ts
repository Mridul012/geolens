/**
 * The golden rules, enforced by grep as the constitution specifies (Engineering-Rules
 * §2.2, §15.12: "both are grep-checked in review").
 *
 * The boundary lint already blocks the import paths. This suite catches what lint cannot:
 * a model name hardcoded in a prompt file, a raw SQL `INSERT INTO scores` in a repository,
 * a `console.log` that slipped past a disabled rule. It is deliberately crude, because
 * crude is what survives a refactor.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = join(process.cwd(), "src");

function walk(dir: string, extensions: readonly string[]): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      found.push(...walk(path, extensions));
    } else if (extensions.some((extension) => entry.endsWith(extension))) {
      found.push(path);
    }
  }
  return found;
}

const tsFiles = walk(SRC, [".ts"]);
const read = (path: string): string => readFileSync(path, "utf8");
const relative = (path: string): string => path.slice(SRC.length + 1);

/**
 * Strips comments before grepping.
 *
 * These files document the very rules being checked — `logger.ts` explains that
 * `console.log` is a lint error — so scanning raw text finds the prose, not a violation.
 * Approximate but adequate: block comments, then line comments, leaving `://` in URLs.
 */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => {
      const index = line.search(/(?<!:)\/\//);
      return index === -1 ? line : line.slice(0, index);
    })
    .join("\n");
}

describe("golden rule #1 — only infrastructure/ai talks to providers", () => {
  const PROVIDER_SDKS = [
    "openai",
    "@anthropic-ai/sdk",
    "groq-sdk",
    "@google/generative-ai",
    "langfuse",
  ];

  it("imports no provider SDK outside infrastructure/ai/adapters", () => {
    const offenders = tsFiles.filter((path) => {
      if (relative(path).startsWith(join("infrastructure", "ai", "adapters"))) return false;
      const source = code(read(path));
      return PROVIDER_SDKS.some((sdk) =>
        new RegExp(`from\\s+["']${sdk.replace(/[/@-]/g, "\\$&")}["']`).test(source),
      );
    });

    expect(offenders.map(relative)).toEqual([]);
  });
});

describe("golden rule #2 — only application/scoring writes scores", () => {
  const SCORES_REPO = join("infrastructure", "db", "repositories", "scores.repo.ts");

  /**
   * Erasing a deleted project's data is not writing a score.
   *
   * The purge job deletes across every table a project owns, `scores` included, and that
   * is the GDPR path (§1.6) rather than the scoring path. It is named here explicitly so
   * the exception is a decision on the record instead of a looser regex.
   */
  const DELETE_ALLOWED = new Set([join("infrastructure", "db", "repositories", "purge.repo.ts")]);

  it("has no statement writing the scores table outside its own repository", () => {
    const offenders = tsFiles.filter((path) => {
      const rel = relative(path);
      if (rel === SCORES_REPO) return false;
      const source = code(read(path));
      const writes =
        // Prisma writes, whatever the client is bound to (`prisma`, `db`, `tx`, `this.#db`).
        /\.score\.(create|createMany|update|updateMany|upsert)\b/.test(source) ||
        /INSERT\s+INTO\s+scores/i.test(source) ||
        /UPDATE\s+scores\s+SET/i.test(source);
      const deletes =
        /\.score\.(delete|deleteMany)\b/.test(source) || /DELETE\s+FROM\s+scores/i.test(source);

      return writes || (deletes && !DELETE_ALLOWED.has(rel));
    });

    expect(offenders.map(relative)).toEqual([]);
  });

  it("calls the repository's write method only from application/scoring", () => {
    // The repository owns the statement; this is the rule that matters — the *decision* to
    // publish a score is made in one folder and nowhere else. There are two writers by
    // design (a crawl's score and a prompt run's), and both live there.
    const callers = tsFiles
      .filter((path) => relative(path) !== SCORES_REPO)
      .filter((path) => /\bscores\.insert\s*\(/.test(code(read(path))))
      .map(relative);

    expect(callers.length).toBeGreaterThan(0);
    const scoring = join("application", "scoring");
    expect(callers.filter((path) => !path.startsWith(scoring))).toEqual([]);
  });

  it("keeps the composite formula out of every layer but the domain", () => {
    // A second implementation of the weighted mean is how two surfaces start disagreeing
    // about what the score is.
    const offenders = tsFiles.filter((path) => {
      const rel = relative(path);
      if (rel.startsWith(join("domain", "scoring"))) return false;
      return /publicationFloor|effectiveWeight\s*=/.test(code(read(path)));
    });
    const allowed = new Set([join("config", "scoring", "v1.ts")]);
    expect(offenders.map(relative).filter((rel) => !allowed.has(rel))).toEqual([]);
  });
});

describe("golden rule #3 — Prisma types never leave infrastructure/db", () => {
  it("imports @prisma/client only inside infrastructure/db", () => {
    const offenders = tsFiles.filter((path) => {
      if (relative(path).startsWith(join("infrastructure", "db"))) return false;
      return /from\s+["']@prisma\/client["']/.test(code(read(path)));
    });

    expect(offenders.map(relative)).toEqual([]);
  });
});

describe("model names live only in config/model-tiers.ts", () => {
  /** Distinctive fragments that only ever appear in a real model identifier. */
  const MODEL_PATTERNS = [
    /\bgpt-4o\b/,
    /\bgpt-4-turbo\b/,
    /\bclaude-\d/,
    /\bclaude-sonnet\b/,
    /\bclaude-opus\b/,
    /\bllama-3/,
    /\btext-embedding-3\b/,
    /\bgemini-\d/,
    /\bsonar-/,
  ];

  it("has no model name outside the config that owns them", () => {
    const allowed = new Set([join("config", "model-tiers.ts")]);
    const offenders = tsFiles
      .filter((path) => !allowed.has(relative(path)))
      .filter((path) => {
        const source = code(read(path));
        return MODEL_PATTERNS.some((pattern) => pattern.test(source));
      });

    expect(offenders.map(relative)).toEqual([]);
  });
});

describe("prompts are versioned files, never inline strings", () => {
  it("keeps every prompt in infrastructure/ai/prompts/<name>/vN.md", () => {
    const promptFiles = walk(join(SRC, "infrastructure", "ai", "prompts"), [".md"]);
    expect(promptFiles.length).toBeGreaterThan(0);
    for (const file of promptFiles) {
      expect(file).toMatch(/prompts[/\\][a-z-]+[/\\]v\d+\.md$/);
    }
  });

  it("gives every prompt the documented header and both sections", () => {
    for (const file of walk(join(SRC, "infrastructure", "ai", "prompts"), [".md"])) {
      const source = read(file);
      expect(source, file).toMatch(/^---\n/);
      for (const key of ["name:", "version:", "purpose:", "tier:", "output_schema:"]) {
        expect(source, `${file} is missing "${key}"`).toContain(key);
      }
      expect(source, file).toContain("## System");
      expect(source, file).toContain("## User");
    }
  });
});

describe("structured logging only", () => {
  it("has no console calls in src", () => {
    const offenders = tsFiles.filter((path) =>
      /\bconsole\.(log|info|warn|error|debug)\b/.test(code(read(path))),
    );
    expect(offenders.map(relative)).toEqual([]);
  });
});

describe("no silent escape hatches", () => {
  it("has no eslint-disable without an adjacent justification", () => {
    const offenders: string[] = [];
    for (const path of tsFiles) {
      const lines = read(path).split("\n");
      lines.forEach((line, index) => {
        if (!line.includes("eslint-disable")) return;
        // §15.7: a disable needs an inline justification and a reviewer flag.
        const previous = lines[index - 1] ?? "";
        const hasReason = line.includes("--") || previous.trim().startsWith("//");
        if (!hasReason) offenders.push(`${relative(path)}:${index + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it("has no ts-ignore anywhere, and no unexplained ts-expect-error", () => {
    const ignores = tsFiles.filter((path) => read(path).includes("@ts-ignore"));
    expect(ignores.map(relative)).toEqual([]);

    const unexplained = tsFiles.filter((path) =>
      read(path)
        .split("\n")
        .some((line) => line.includes("@ts-expect-error") && !/@ts-expect-error\s+\S/.test(line)),
    );
    expect(unexplained.map(relative)).toEqual([]);
  });
});
