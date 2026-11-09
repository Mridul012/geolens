-- ADR 0004 — persist the buyer stage the taxonomy already produces, so
-- `score_topic_coverage` can apply the 2x decision-intent weight AI-Pipeline §3.4 fixes.
--
-- Nullable on purpose: user-added topics have no stage, and taxonomies generated before
-- this migration are not backfilled. Scoring treats null as the base weight.

-- CreateEnum
CREATE TYPE "buyer_intent" AS ENUM ('awareness', 'consideration', 'decision');

-- AlterTable
ALTER TABLE "topics" ADD COLUMN     "buyer_intent" "buyer_intent";
