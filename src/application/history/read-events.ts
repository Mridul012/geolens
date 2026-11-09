/** The History feed read (docs/API.md §3 — History group). */
import type { Page } from "../../contracts/api/common.js";
import type { EventPayload } from "../../contracts/api/snapshots.js";
import type { Result } from "../../domain/shared/result.js";
import { ok } from "../../domain/shared/result.js";
import type { AppError } from "../../domain/shared/app-error.js";
import type { EventsRepo } from "../../infrastructure/db/repositories/events.repo.js";
import type { ProjectsRepo } from "../../infrastructure/db/repositories/projects.repo.js";
import { assertProjectAccess } from "../projects/assert-project-access.js";

export interface ReadEventsDeps {
  readonly projects: ProjectsRepo;
  readonly events: EventsRepo;
}

export async function listEvents(
  deps: ReadEventsDeps,
  input: {
    readonly projectId: string;
    readonly userId: string;
    readonly limit: number;
    readonly cursor: string | undefined;
    readonly kind: string | undefined;
  },
): Promise<Result<Page<EventPayload>, AppError>> {
  const access = await assertProjectAccess(deps.projects, input.projectId, input.userId);
  if (!access.ok) return access;

  const rows = await deps.events.list(input.projectId, input.limit + 1, input.cursor, input.kind);
  const data = rows.slice(0, input.limit);
  return ok({
    data,
    nextCursor: rows.length > input.limit ? (data.at(-1)?.id ?? null) : null,
  });
}
