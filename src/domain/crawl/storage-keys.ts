/**
 * The object-storage key scheme (docs/Backend.md §9) — pure, so the layout is one
 * readable file rather than a string template scattered across three adapters.
 *
 * Keys are prefixed by project so a tenant's objects can be listed, exported or purged
 * with a single prefix scan, which is what makes the deletion SLA a WHERE clause rather
 * than a migration.
 */

/** `snapshots/{projectId}/{crawlId}/{contentHash}.html.gz` */
export function snapshotKey(projectId: string, crawlId: string, contentHash: string): string {
  return `snapshots/${projectId}/${crawlId}/${contentHash}.html.gz`;
}

/** `reports/{projectId}/{reportId}.pdf` */
export function reportKey(projectId: string, reportId: string): string {
  return `reports/${projectId}/${reportId}.pdf`;
}

/** Everything belonging to one project — the purge job's prefix. */
export function projectPrefix(projectId: string): readonly string[] {
  return [`snapshots/${projectId}/`, `reports/${projectId}/`];
}
