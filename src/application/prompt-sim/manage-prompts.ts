/**
 * Tracked prompt curation (docs/API.md §3 — Prompt Tracking).
 *
 * One rule shapes this whole file: **prompt text is immutable** (docs/API.md §4.1).
 * Editing a tracked prompt's wording would silently corrupt its own trend line — last
 * month's mention rate would refer to a different question, and nothing in the chart would
 * say so. Changing a prompt means archiving it and creating a new one, which keeps the old
 * results attached to the question that actually produced them.
 *
 * The API enforces it with `403 PROMPT_TEXT_IMMUTABLE`; the schema's `Restrict` FK from
 * `prompt_results` is the same decision one layer down.
 */
import { PLAN_LIMITS } from "../../config/plans.js";
import type { PromptTemplate } from "../../contracts/api/prompts.js";
import type { Result } from "../../domain/shared/result.js";
import { err, ok } from "../../domain/shared/result.js";
import type { AppError } from "../../domain/shared/app-error.js";
import {
  notFound,
  planLimitExceeded,
  promptTextImmutable,
  validationFailed,
} from "../../domain/shared/app-error.js";
import type { ProjectsRepo } from "../../infrastructure/db/repositories/projects.repo.js";
import type { UsersRepo } from "../../infrastructure/db/repositories/users.repo.js";
import type {
  PromptTemplateRecord,
  PromptTemplatesRepo,
} from "../../infrastructure/db/repositories/prompt-templates.repo.js";
import { isDuplicatePrompt } from "../../infrastructure/db/repositories/prompt-templates.repo.js";
import { assertProjectAccess } from "../projects/assert-project-access.js";

export interface PromptDeps {
  readonly projects: ProjectsRepo;
  readonly users: UsersRepo;
  readonly prompts: PromptTemplatesRepo;
}

function toContract(record: PromptTemplateRecord): PromptTemplate {
  return {
    id: record.id,
    text: record.text,
    intent: record.intent,
    source: record.source,
    pinned: record.pinned,
    status: record.status,
    position: record.position,
  };
}

const duplicateText = (): AppError =>
  validationFailed([
    {
      path: "text",
      message: "You are already tracking that prompt. Archive it first to add it again.",
    },
  ]);

export async function listPrompts(
  deps: PromptDeps,
  projectId: string,
  userId: string,
  status: "ACTIVE" | "ARCHIVED" | undefined,
): Promise<Result<readonly PromptTemplate[], AppError>> {
  const access = await assertProjectAccess(deps.projects, projectId, userId);
  if (!access.ok) return access;

  const records = await deps.prompts.listForProject(projectId, status);
  return ok(records.map(toContract));
}

export async function addPrompt(
  deps: PromptDeps,
  projectId: string,
  userId: string,
  input: {
    readonly text: string;
    readonly intent?: string | undefined;
    readonly pinned?: boolean | undefined;
  },
): Promise<Result<PromptTemplate, AppError>> {
  const access = await assertProjectAccess(deps.projects, projectId, userId);
  if (!access.ok) return access;

  const text = input.text.trim();
  if (text.length < 8) {
    return err(validationFailed([{ path: "text", message: "A prompt needs at least 8 characters." }]));
  }

  const plan = await deps.users.findPlan(userId);
  const limit = PLAN_LIMITS[plan].activePrompts;
  if ((await deps.prompts.countActive(projectId)) >= limit) {
    // 403 with a code rather than 402: this is an entitlement boundary, not a payment flow
    // (docs/API.md §1 error table).
    return err(
      planLimitExceeded(
        `The ${plan} plan tracks ${limit} prompts at a time. Archive one to add another.`,
      ),
    );
  }

  try {
    const created = await deps.prompts.create(projectId, {
      text,
      intent: input.intent?.trim() ?? null,
      source: "USER",
      pinned: input.pinned ?? false,
      position: await deps.prompts.nextPosition(projectId),
    });
    return ok(toContract(created));
  } catch (error) {
    // The partial unique index is the real arbiter; a pre-check would race with itself.
    if (isDuplicatePrompt(error)) return err(duplicateText());
    throw error;
  }
}

export async function updatePrompt(
  deps: PromptDeps,
  projectId: string,
  userId: string,
  promptId: string,
  patch: {
    readonly pinned?: boolean | undefined;
    readonly status?: "ACTIVE" | "ARCHIVED" | undefined;
    readonly position?: number | undefined;
    /** Never applied. Present only so sending it can be refused explicitly. */
    readonly text?: unknown;
  },
): Promise<Result<PromptTemplate, AppError>> {
  const access = await assertProjectAccess(deps.projects, projectId, userId);
  if (!access.ok) return access;

  if (patch.text !== undefined) {
    // Explicit 403 rather than silently ignoring the field: a client that thinks it edited
    // a prompt and did not is worse off than one that got an error.
    return err(promptTextImmutable());
  }

  const existing = await deps.prompts.findInProject(projectId, promptId);
  if (existing === null) return err(notFound("Prompt"));

  // Un-archiving can collide with a prompt added in the meantime.
  if (patch.status === "ACTIVE" && existing.status === "ARCHIVED") {
    const plan = await deps.users.findPlan(userId);
    const limit = PLAN_LIMITS[plan].activePrompts;
    if ((await deps.prompts.countActive(projectId)) >= limit) {
      return err(
        planLimitExceeded(
          `The ${plan} plan tracks ${limit} prompts at a time. Archive one to restore this.`,
        ),
      );
    }
  }

  try {
    return ok(toContract(await deps.prompts.update(promptId, patch)));
  } catch (error) {
    if (isDuplicatePrompt(error)) return err(duplicateText());
    throw error;
  }
}
