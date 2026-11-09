/**
 * Topic curation (docs/API.md §3 — Analysis group).
 *
 * The taxonomy is generated but user-owned: the PRD's promise is that a user reviews and
 * edits it before it locks in (FR-5.1). Duplicate active labels are refused
 * case-insensitively, mirroring the database's own partial unique index.
 */
import type { Topic } from "../../contracts/api/topics.js";
import type { Result } from "../../domain/shared/result.js";
import { err, ok } from "../../domain/shared/result.js";
import type { AppError } from "../../domain/shared/app-error.js";
import { notFound, validationFailed } from "../../domain/shared/app-error.js";
import type { ProjectsRepo } from "../../infrastructure/db/repositories/projects.repo.js";
import type { TopicsRepo, TopicRecord } from "../../infrastructure/db/repositories/topics.repo.js";
import { isDuplicateTopic } from "../../infrastructure/db/repositories/topics.repo.js";
import { assertProjectAccess } from "../projects/assert-project-access.js";

export interface TopicDeps {
  readonly projects: ProjectsRepo;
  readonly topics: TopicsRepo;
}

function toContract(record: TopicRecord): Topic {
  return {
    id: record.id,
    label: record.label,
    description: record.description,
    source: record.source,
    buyerIntent: record.buyerIntent,
    status: record.status,
    position: record.position,
  };
}

export async function listTopics(
  deps: TopicDeps,
  projectId: string,
  userId: string,
  status: "ACTIVE" | "ARCHIVED" | undefined,
): Promise<Result<readonly Topic[], AppError>> {
  const access = await assertProjectAccess(deps.projects, projectId, userId);
  if (!access.ok) return access;
  const records = await deps.topics.listForProject(projectId, status);
  return ok(records.map(toContract));
}

const duplicateLabel = (): AppError =>
  validationFailed([
    { path: "label", message: "A topic with that label already exists in this project." },
  ]);

export async function addTopic(
  deps: TopicDeps,
  projectId: string,
  userId: string,
  input: { readonly label: string; readonly description?: string | undefined },
): Promise<Result<Topic, AppError>> {
  const access = await assertProjectAccess(deps.projects, projectId, userId);
  if (!access.ok) return access;

  const label = input.label.trim();
  if (label.length === 0) {
    return err(validationFailed([{ path: "label", message: "A label is required." }]));
  }

  // Checked here for a clean error; the expression index is the race-proof backstop.
  const existing = await deps.topics.listForProject(projectId, "ACTIVE");
  if (existing.some((topic) => topic.label.trim().toLowerCase() === label.toLowerCase())) {
    return err(duplicateLabel());
  }

  try {
    const created = await deps.topics.create(projectId, {
      label,
      description: input.description?.trim() ?? null,
      source: "USER",
      position: existing.length,
    });
    return ok(toContract(created));
  } catch (error) {
    if (isDuplicateTopic(error)) return err(duplicateLabel());
    throw error;
  }
}

export async function updateTopic(
  deps: TopicDeps,
  projectId: string,
  userId: string,
  topicId: string,
  patch: {
    readonly label?: string | undefined;
    readonly description?: string | undefined;
    readonly position?: number | undefined;
    readonly status?: "ACTIVE" | "ARCHIVED" | undefined;
  },
): Promise<Result<Topic, AppError>> {
  const access = await assertProjectAccess(deps.projects, projectId, userId);
  if (!access.ok) return access;

  const topic = await deps.topics.findInProject(projectId, topicId);
  if (topic === null) return err(notFound("Topic"));

  if (patch.label !== undefined) {
    const label = patch.label.trim();
    if (label.length === 0) {
      return err(validationFailed([{ path: "label", message: "A label is required." }]));
    }
    const siblings = await deps.topics.listForProject(projectId, "ACTIVE");
    const clashes = siblings.some(
      (candidate) =>
        candidate.id !== topicId && candidate.label.trim().toLowerCase() === label.toLowerCase(),
    );
    if (clashes) return err(duplicateLabel());
  }

  try {
    const updated = await deps.topics.update(topicId, patch);
    return ok(toContract(updated));
  } catch (error) {
    if (isDuplicateTopic(error)) return err(duplicateLabel());
    throw error;
  }
}
