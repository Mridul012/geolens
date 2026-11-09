/**
 * The project purge (PRD privacy NFR: derived data immediately, raw snapshots within 30
 * days).
 *
 * Runs on a worker, in batches, and is safe to run twice: every step is a delete, so a
 * re-run of a partially completed purge simply finds less to do (Engineering-Rules §7).
 */
import type { PurgeRepo, PurgeProgress } from "../../infrastructure/db/repositories/purge.repo.js";
import type { ObjectStorage } from "../ports/object-storage.port.js";

export interface PurgeProjectDeps {
  readonly purge: PurgeRepo;
  /** Absent until M6 owns R2; derived rows still go, objects follow within the SLA. */
  readonly storage?: ObjectStorage | undefined;
  readonly onProgress?: ((progress: PurgeProgress) => Promise<void> | void) | undefined;
  /** Checked between batches so a draining worker stops cleanly (§7 graceful shutdown). */
  readonly shouldStop?: (() => boolean) | undefined;
}

export interface PurgeProjectResult {
  readonly projectId: string;
  readonly deletedByTable: readonly PurgeProgress[];
  readonly objectsDeleted: number;
  readonly completed: boolean;
}

const STORAGE_KEY_PAGE = 1_000;

export async function purgeProject(
  deps: PurgeProjectDeps,
  projectId: string,
): Promise<PurgeProjectResult> {
  // Object keys are read before the rows that name them — afterwards there is nothing left
  // to tell us what to delete from storage.
  const storageKeys =
    deps.storage === undefined ? [] : await deps.purge.listStorageKeys(projectId, STORAGE_KEY_PAGE);

  const deletedByTable = await deps.purge.purgeDerivedRows(projectId, async (progress) => {
    await deps.onProgress?.(progress);
  });

  if (deps.shouldStop?.() === true) {
    return { projectId, deletedByTable, objectsDeleted: 0, completed: false };
  }

  let objectsDeleted = 0;
  if (deps.storage !== undefined && storageKeys.length > 0) {
    await deps.storage.deleteMany(storageKeys);
    objectsDeleted = storageKeys.length;
  }

  await deps.purge.deleteProjectRow(projectId);

  return { projectId, deletedByTable, objectsDeleted, completed: true };
}
