/**
 * Tracked prompt templates (docs/Database.md §2.12).
 *
 * The table carries `unique (project_id, md5(text)) where status = 'ACTIVE'` — an
 * expression index the schema doc defines in SQL, so Prisma surfaces its violation as a
 * raw constraint name rather than P2002. `isDuplicatePrompt` below is what turns that back
 * into a field error the API can return.
 *
 * Text is never updated. Not "should not be" — the update method has no `text` parameter,
 * because editing a tracked prompt's wording silently redefines what its own trend line
 * has been measuring (docs/API.md §4.1).
 */
import type { Database } from "../prisma.js";
import { newUuidV7 } from "../uuid.js";

export interface PromptTemplateRecord {
  readonly id: string;
  readonly text: string;
  readonly intent: string | null;
  readonly source: "GENERATED" | "USER";
  readonly pinned: boolean;
  readonly status: "ACTIVE" | "ARCHIVED";
  readonly position: number;
  readonly createdAt: string;
}

export interface NewPromptTemplate {
  readonly text: string;
  readonly intent: string | null;
  readonly source: "GENERATED" | "USER";
  readonly pinned: boolean;
  readonly position: number;
}

export interface PromptTemplateUpdate {
  readonly pinned?: boolean | undefined;
  readonly status?: "ACTIVE" | "ARCHIVED" | undefined;
  readonly position?: number | undefined;
}

const UNIQUE_VIOLATION = "P2002";

/** The partial expression index reports itself by name; P2002 covers the plain case. */
export function isDuplicatePrompt(error: unknown): boolean {
  const code = (error as { code?: string }).code;
  const message = (error as { message?: string }).message ?? "";
  return code === UNIQUE_VIOLATION || message.includes("prompt_templates_project_text_dedupe");
}

interface Row {
  id: string;
  text: string;
  intent: string | null;
  source: "GENERATED" | "USER";
  pinned: boolean;
  status: "ACTIVE" | "ARCHIVED";
  position: number;
  createdAt: Date;
}

const select = {
  id: true,
  text: true,
  intent: true,
  source: true,
  pinned: true,
  status: true,
  position: true,
  createdAt: true,
} as const;

function toRecord(row: Row): PromptTemplateRecord {
  return {
    id: row.id,
    text: row.text,
    intent: row.intent,
    source: row.source,
    pinned: row.pinned,
    status: row.status,
    position: row.position,
    createdAt: row.createdAt.toISOString(),
  };
}

export class PromptTemplatesRepo {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  /**
   * A project's prompts, pinned first.
   *
   * Pinned prompts lead because they are the ones a user chose to watch; within each
   * group, `position` is theirs to set.
   *
   * Index: `prompt_templates(project_id, status)`.
   */
  async listForProject(
    projectId: string,
    status?: "ACTIVE" | "ARCHIVED",
  ): Promise<readonly PromptTemplateRecord[]> {
    const rows = await this.#db.promptTemplate.findMany({
      where: { projectId, ...(status === undefined ? {} : { status }) },
      orderBy: [{ pinned: "desc" }, { position: "asc" }, { createdAt: "asc" }],
      select,
    });
    return rows.map((row) => toRecord(row as Row));
  }

  async countActive(projectId: string): Promise<number> {
    return this.#db.promptTemplate.count({ where: { projectId, status: "ACTIVE" } });
  }

  /**
   * Whether the seed set has been generated for this project.
   *
   * Deliberately not "does the project have any prompts": a user who added one by hand
   * before the first crawl finished should still get the generated ten. The plan limit
   * gates what they add next, not what we seed.
   */
  async countGenerated(projectId: string): Promise<number> {
    return this.#db.promptTemplate.count({ where: { projectId, source: "GENERATED" } });
  }

  async findInProject(projectId: string, id: string): Promise<PromptTemplateRecord | null> {
    const row = await this.#db.promptTemplate.findFirst({ where: { id, projectId }, select });
    return row === null ? null : toRecord(row as Row);
  }

  /** Throws a duplicate error when the same active text already exists for the project. */
  async create(projectId: string, prompt: NewPromptTemplate): Promise<PromptTemplateRecord> {
    const row = await this.#db.promptTemplate.create({
      data: {
        id: newUuidV7(),
        projectId,
        text: prompt.text,
        intent: prompt.intent,
        source: prompt.source,
        pinned: prompt.pinned,
        position: prompt.position,
      },
      select,
    });
    return toRecord(row as Row);
  }

  /** Pin, reorder, archive. Deliberately cannot touch `text`. */
  async update(id: string, patch: PromptTemplateUpdate): Promise<PromptTemplateRecord> {
    const row = await this.#db.promptTemplate.update({
      where: { id },
      data: {
        ...(patch.pinned === undefined ? {} : { pinned: patch.pinned }),
        ...(patch.status === undefined ? {} : { status: patch.status }),
        ...(patch.position === undefined ? {} : { position: patch.position }),
      },
      select,
    });
    return toRecord(row as Row);
  }

  /**
   * Seeds a project's generated prompts, once.
   *
   * Unlike the taxonomy, this does *not* archive-and-replace on a later crawl. A tracked
   * prompt's whole value is its history, and silently swapping the set every week would
   * reset every trend line in the account. Generation runs when there are none.
   */
  async createGenerated(
    projectId: string,
    prompts: readonly NewPromptTemplate[],
  ): Promise<readonly PromptTemplateRecord[]> {
    return this.#db.$transaction(async (tx) => {
      const created: PromptTemplateRecord[] = [];
      for (const prompt of prompts) {
        const row = await tx.promptTemplate.create({
          data: {
            id: newUuidV7(),
            projectId,
            text: prompt.text,
            intent: prompt.intent,
            source: prompt.source,
            pinned: prompt.pinned,
            position: prompt.position,
          },
          select,
        });
        created.push(toRecord(row as Row));
      }
      return created;
    });
  }

  /** The next free slot, so a new prompt lands at the end rather than on top of one. */
  async nextPosition(projectId: string): Promise<number> {
    const row = await this.#db.promptTemplate.findFirst({
      where: { projectId },
      orderBy: { position: "desc" },
      select: { position: true },
    });
    return (row?.position ?? -1) + 1;
  }
}
