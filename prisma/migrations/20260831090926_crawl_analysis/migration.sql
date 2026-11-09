-- Add the analysis artifact to crawls (docs/adr/0003).
--
-- What: a nullable JSONB column holding the payload GET /crawls/{id}/analysis returns.
-- Why JSONB: the artifact is rendered, never queried or aggregated, and it is assembled
-- across five milestones — the schema doc's own JSONB policy (§1.3) points here.

-- AlterTable
ALTER TABLE "crawls" ADD COLUMN     "analysis" JSONB;

