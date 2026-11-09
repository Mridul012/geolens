-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "citext";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "vector";

-- CreateEnum
CREATE TYPE "PlanTier" AS ENUM ('FREE', 'PRO');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELED');

-- CreateEnum
CREATE TYPE "ProjectStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "SiteRole" AS ENUM ('OWN', 'COMPETITOR');

-- CreateEnum
CREATE TYPE "CrawlStatus" AS ENUM ('QUEUED', 'CRAWLING', 'ANALYZING', 'COMPLETED', 'COMPLETED_DEGRADED', 'FAILED', 'CANCELED');

-- CreateEnum
CREATE TYPE "RunTrigger" AS ENUM ('MANUAL', 'SCHEDULED');

-- CreateEnum
CREATE TYPE "PromptRunStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'COMPLETED_DEGRADED', 'FAILED');

-- CreateEnum
CREATE TYPE "GeneratedSource" AS ENUM ('GENERATED', 'USER');

-- CreateEnum
CREATE TYPE "ArchivableStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "Sentiment" AS ENUM ('POSITIVE', 'NEUTRAL', 'NEGATIVE');

-- CreateEnum
CREATE TYPE "RecSource" AS ENUM ('RULE', 'AI');

-- CreateEnum
CREATE TYPE "RecPriority" AS ENUM ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW');

-- CreateEnum
CREATE TYPE "RecStatus" AS ENUM ('OPEN', 'DONE', 'DISMISSED', 'VALIDATED', 'REGRESSED');

-- CreateEnum
CREATE TYPE "ReportKind" AS ENUM ('ON_DEMAND', 'SCHEDULED');

-- CreateEnum
CREATE TYPE "ReportStatus" AS ENUM ('QUEUED', 'GENERATING', 'READY', 'FAILED');

-- CreateEnum
CREATE TYPE "JobKind" AS ENUM ('CRAWL', 'PROMPT_SIM', 'REPORT', 'DIGEST', 'CLEANUP', 'ROLLUP');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('QUEUED', 'ACTIVE', 'COMPLETED', 'FAILED', 'DELAYED', 'CANCELED');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" CITEXT NOT NULL,
    "name" TEXT,
    "image_url" TEXT,
    "password_hash" TEXT,
    "email_verified_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "ip" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "oauth_accounts" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "provider_account_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oauth_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "stripe_customer_id" TEXT NOT NULL,
    "stripe_subscription_id" TEXT,
    "plan" "PlanTier" NOT NULL DEFAULT 'FREE',
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'ACTIVE',
    "current_period_end" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projects" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "status" "ProjectStatus" NOT NULL DEFAULT 'ACTIVE',
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "deleted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sites" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "url" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "role" "SiteRole" NOT NULL,
    "name" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crawls" (
    "id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "status" "CrawlStatus" NOT NULL DEFAULT 'QUEUED',
    "trigger" "RunTrigger" NOT NULL,
    "pages_discovered" INTEGER NOT NULL DEFAULT 0,
    "pages_crawled" INTEGER NOT NULL DEFAULT 0,
    "pages_changed" INTEGER NOT NULL DEFAULT 0,
    "pages_failed" INTEGER NOT NULL DEFAULT 0,
    "degradation" JSONB,
    "error_reason" TEXT,
    "ai_cost_usd_micros" BIGINT NOT NULL DEFAULT 0,
    "scoring_config_version" TEXT,
    "pipeline_version" TEXT,
    "queued_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ(6),
    "finished_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "crawls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pages" (
    "id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "url" TEXT NOT NULL,
    "url_hash" TEXT NOT NULL,
    "latest_content_hash" TEXT,
    "first_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "page_snapshots" (
    "id" UUID NOT NULL,
    "crawl_id" UUID NOT NULL,
    "page_id" UUID NOT NULL,
    "http_status" SMALLINT,
    "content_hash" TEXT NOT NULL,
    "changed" BOOLEAN NOT NULL DEFAULT true,
    "carried_forward_from_id" UUID,
    "title" TEXT,
    "word_count" INTEGER,
    "published_at" TIMESTAMPTZ(6),
    "page_updated_at" TIMESTAMPTZ(6),
    "has_structured_data" BOOLEAN NOT NULL DEFAULT false,
    "internal_link_count" INTEGER,
    "external_link_count" INTEGER,
    "quality_score" SMALLINT,
    "extracted" JSONB NOT NULL,
    "quality" JSONB,
    "storage_key" TEXT NOT NULL,
    "fetched_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "page_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chunks" (
    "id" BIGSERIAL NOT NULL,
    "page_snapshot_id" UUID NOT NULL,
    "crawl_id" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "heading_path" TEXT,
    "content" TEXT NOT NULL,
    "token_count" INTEGER NOT NULL,
    "embedding" vector(1536),
    "tsv" tsvector,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chunks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "topics" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT,
    "embedding" vector(1536),
    "source" "GeneratedSource" NOT NULL,
    "status" "ArchivableStatus" NOT NULL DEFAULT 'ACTIVE',
    "position" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "topics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "topic_coverage" (
    "crawl_id" UUID NOT NULL,
    "topic_id" UUID NOT NULL,
    "coverage_score" SMALLINT NOT NULL,
    "depth_chunks" INTEGER NOT NULL,
    "evidence" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "topic_coverage_pkey" PRIMARY KEY ("crawl_id","topic_id")
);

-- CreateTable
CREATE TABLE "prompt_templates" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "text" TEXT NOT NULL,
    "intent" TEXT,
    "source" "GeneratedSource" NOT NULL,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "status" "ArchivableStatus" NOT NULL DEFAULT 'ACTIVE',
    "position" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "prompt_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prompt_runs" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "trigger" "RunTrigger" NOT NULL,
    "status" "PromptRunStatus" NOT NULL DEFAULT 'QUEUED',
    "engines" TEXT[],
    "mention_rate" DECIMAL(5,2),
    "citation_share" DECIMAL(5,2),
    "metrics" JSONB,
    "ai_cost_usd_micros" BIGINT NOT NULL DEFAULT 0,
    "started_at" TIMESTAMPTZ(6),
    "finished_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prompt_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prompt_results" (
    "id" BIGSERIAL NOT NULL,
    "prompt_run_id" UUID NOT NULL,
    "prompt_template_id" UUID NOT NULL,
    "engine" TEXT NOT NULL,
    "sample_index" SMALLINT NOT NULL,
    "brand_mentioned" BOOLEAN NOT NULL DEFAULT false,
    "brand_cited" BOOLEAN NOT NULL DEFAULT false,
    "mention_position" SMALLINT,
    "sentiment" "Sentiment",
    "competitors_mentioned" JSONB,
    "citations" JSONB,
    "answer_text" TEXT,
    "model" TEXT NOT NULL,
    "latency_ms" INTEGER,
    "error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prompt_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scores" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "crawl_id" UUID,
    "prompt_run_id" UUID,
    "composite" SMALLINT NOT NULL,
    "score_citation" SMALLINT,
    "score_retrievability" SMALLINT,
    "score_content_quality" SMALLINT,
    "score_topic_coverage" SMALLINT,
    "score_technical" SMALLINT,
    "score_trust" SMALLINT,
    "components" JSONB NOT NULL,
    "scoring_config_version" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scores_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recommendations" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "source" "RecSource" NOT NULL,
    "rule_key" TEXT,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "priority" "RecPriority" NOT NULL,
    "impact" SMALLINT NOT NULL,
    "difficulty" SMALLINT NOT NULL,
    "status" "RecStatus" NOT NULL DEFAULT 'OPEN',
    "evidence" JSONB NOT NULL,
    "first_seen_crawl_id" UUID,
    "last_seen_crawl_id" UUID,
    "resolved_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "recommendations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reports" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "kind" "ReportKind" NOT NULL,
    "status" "ReportStatus" NOT NULL DEFAULT 'QUEUED',
    "crawl_id" UUID,
    "prompt_run_id" UUID,
    "params" JSONB,
    "storage_key" TEXT,
    "size_bytes" INTEGER,
    "generated_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_runs" (
    "id" UUID NOT NULL,
    "project_id" UUID,
    "kind" "JobKind" NOT NULL,
    "ref_id" UUID,
    "queue" TEXT NOT NULL,
    "bullmq_job_id" TEXT,
    "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
    "attempts" SMALLINT NOT NULL DEFAULT 0,
    "progress" JSONB,
    "error" TEXT,
    "queued_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ(6),
    "finished_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_usage" (
    "id" BIGSERIAL NOT NULL,
    "project_id" UUID,
    "crawl_id" UUID,
    "prompt_run_id" UUID,
    "purpose" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "input_tokens" INTEGER NOT NULL DEFAULT 0,
    "output_tokens" INTEGER NOT NULL DEFAULT 0,
    "cached_input_tokens" INTEGER NOT NULL DEFAULT 0,
    "cost_usd_micros" BIGINT NOT NULL,
    "latency_ms" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_usage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "events" (
    "id" BIGSERIAL NOT NULL,
    "project_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "crawl_id" UUID,
    "prompt_run_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_key" ON "sessions"("token");

-- CreateIndex
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");

-- CreateIndex
CREATE INDEX "sessions_expires_at_idx" ON "sessions"("expires_at");

-- CreateIndex
CREATE INDEX "oauth_accounts_user_id_idx" ON "oauth_accounts"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "oauth_accounts_provider_provider_account_id_key" ON "oauth_accounts"("provider", "provider_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_user_id_key" ON "subscriptions"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_stripe_customer_id_key" ON "subscriptions"("stripe_customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_stripe_subscription_id_key" ON "subscriptions"("stripe_subscription_id");

-- CreateIndex
CREATE INDEX "projects_user_id_idx" ON "projects"("user_id");

-- CreateIndex
CREATE INDEX "sites_project_id_idx" ON "sites"("project_id");

-- CreateIndex
CREATE UNIQUE INDEX "sites_project_id_url_key" ON "sites"("project_id", "url");

-- CreateIndex
CREATE INDEX "crawls_project_id_created_at_idx" ON "crawls"("project_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "crawls_site_id_created_at_idx" ON "crawls"("site_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "pages_site_id_last_seen_at_idx" ON "pages"("site_id", "last_seen_at");

-- CreateIndex
CREATE UNIQUE INDEX "pages_site_id_url_hash_key" ON "pages"("site_id", "url_hash");

-- CreateIndex
CREATE INDEX "page_snapshots_page_id_created_at_idx" ON "page_snapshots"("page_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "page_snapshots_crawl_id_page_id_key" ON "page_snapshots"("crawl_id", "page_id");

-- CreateIndex
CREATE INDEX "chunks_crawl_id_idx" ON "chunks"("crawl_id");

-- CreateIndex
CREATE INDEX "chunks_tsv_idx" ON "chunks" USING GIN ("tsv");

-- CreateIndex
CREATE INDEX "topics_project_id_status_idx" ON "topics"("project_id", "status");

-- CreateIndex
CREATE INDEX "topic_coverage_topic_id_idx" ON "topic_coverage"("topic_id");

-- CreateIndex
CREATE INDEX "prompt_templates_project_id_status_idx" ON "prompt_templates"("project_id", "status");

-- CreateIndex
CREATE INDEX "prompt_runs_project_id_created_at_idx" ON "prompt_runs"("project_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "prompt_results_prompt_template_id_created_at_idx" ON "prompt_results"("prompt_template_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "prompt_results_prompt_run_id_prompt_template_id_engine_samp_key" ON "prompt_results"("prompt_run_id", "prompt_template_id", "engine", "sample_index");

-- CreateIndex
CREATE INDEX "scores_project_id_created_at_idx" ON "scores"("project_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "recommendations_project_id_status_idx" ON "recommendations"("project_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "recommendations_project_id_fingerprint_key" ON "recommendations"("project_id", "fingerprint");

-- CreateIndex
CREATE INDEX "reports_project_id_created_at_idx" ON "reports"("project_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "job_runs_project_id_created_at_idx" ON "job_runs"("project_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "job_runs_kind_status_idx" ON "job_runs"("kind", "status");

-- CreateIndex
CREATE INDEX "ai_usage_project_id_created_at_idx" ON "ai_usage"("project_id", "created_at");

-- CreateIndex
CREATE INDEX "ai_usage_crawl_id_idx" ON "ai_usage"("crawl_id");

-- CreateIndex
CREATE INDEX "ai_usage_created_at_idx" ON "ai_usage" USING BRIN ("created_at");

-- CreateIndex
CREATE INDEX "events_project_id_created_at_idx" ON "events"("project_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "events_created_at_idx" ON "events" USING BRIN ("created_at");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_accounts" ADD CONSTRAINT "oauth_accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sites" ADD CONSTRAINT "sites_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crawls" ADD CONSTRAINT "crawls_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crawls" ADD CONSTRAINT "crawls_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pages" ADD CONSTRAINT "pages_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "page_snapshots" ADD CONSTRAINT "page_snapshots_crawl_id_fkey" FOREIGN KEY ("crawl_id") REFERENCES "crawls"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "page_snapshots" ADD CONSTRAINT "page_snapshots_page_id_fkey" FOREIGN KEY ("page_id") REFERENCES "pages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "page_snapshots" ADD CONSTRAINT "page_snapshots_carried_forward_from_id_fkey" FOREIGN KEY ("carried_forward_from_id") REFERENCES "page_snapshots"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_page_snapshot_id_fkey" FOREIGN KEY ("page_snapshot_id") REFERENCES "page_snapshots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_crawl_id_fkey" FOREIGN KEY ("crawl_id") REFERENCES "crawls"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "topics" ADD CONSTRAINT "topics_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "topic_coverage" ADD CONSTRAINT "topic_coverage_crawl_id_fkey" FOREIGN KEY ("crawl_id") REFERENCES "crawls"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "topic_coverage" ADD CONSTRAINT "topic_coverage_topic_id_fkey" FOREIGN KEY ("topic_id") REFERENCES "topics"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prompt_templates" ADD CONSTRAINT "prompt_templates_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prompt_runs" ADD CONSTRAINT "prompt_runs_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prompt_results" ADD CONSTRAINT "prompt_results_prompt_run_id_fkey" FOREIGN KEY ("prompt_run_id") REFERENCES "prompt_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prompt_results" ADD CONSTRAINT "prompt_results_prompt_template_id_fkey" FOREIGN KEY ("prompt_template_id") REFERENCES "prompt_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scores" ADD CONSTRAINT "scores_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scores" ADD CONSTRAINT "scores_crawl_id_fkey" FOREIGN KEY ("crawl_id") REFERENCES "crawls"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scores" ADD CONSTRAINT "scores_prompt_run_id_fkey" FOREIGN KEY ("prompt_run_id") REFERENCES "prompt_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reports" ADD CONSTRAINT "reports_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_runs" ADD CONSTRAINT "job_runs_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "events" ADD CONSTRAINT "events_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ═══════════════════════════════════════════════════════════════════════════
-- SQL-only layer (docs/Database.md §5), hand-appended per Engineering-Rules §5.
--
-- What: business invariants as partial unique indexes, case-insensitive/expression
-- uniques, and range CHECK constraints.
-- Why manual: Prisma's schema language cannot express partial uniques, expression
-- indexes, or CHECK constraints. Keeping them inside migration history is what stops
-- the shadow-database diff from drifting.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Business invariants as partial unique indexes ──
CREATE UNIQUE INDEX one_own_site_per_project
  ON sites (project_id) WHERE role = 'OWN';

CREATE UNIQUE INDEX one_active_crawl_per_site
  ON crawls (site_id) WHERE status IN ('QUEUED','CRAWLING','ANALYZING');

CREATE UNIQUE INDEX one_active_prompt_run_per_project
  ON prompt_runs (project_id) WHERE status IN ('QUEUED','RUNNING');

-- ── Expression uniques ──
CREATE UNIQUE INDEX topics_project_label_ci
  ON topics (project_id, lower(label)) WHERE status = 'ACTIVE';

CREATE UNIQUE INDEX prompt_templates_project_text_dedupe
  ON prompt_templates (project_id, md5(text)) WHERE status = 'ACTIVE';

-- ── Search indexes ──
-- GIN(tsv) and both BRIN time-series indexes are declared in schema.prisma instead
-- (docs/adr/0001) so the shadow-DB diff stays clean. Deferred until a cross-corpus
-- feature exists (docs/Database.md §1 refinement):
-- CREATE INDEX chunks_embedding_hnsw ON chunks USING hnsw (embedding vector_cosine_ops);

-- ── CHECK constraints ──
ALTER TABLE scores ADD CONSTRAINT scores_have_input
  CHECK (crawl_id IS NOT NULL OR prompt_run_id IS NOT NULL);
ALTER TABLE scores ADD CONSTRAINT scores_ranges CHECK (
  composite BETWEEN 0 AND 100
  AND (score_citation        IS NULL OR score_citation        BETWEEN 0 AND 100)
  AND (score_retrievability  IS NULL OR score_retrievability  BETWEEN 0 AND 100)
  AND (score_content_quality IS NULL OR score_content_quality BETWEEN 0 AND 100)
  AND (score_topic_coverage  IS NULL OR score_topic_coverage  BETWEEN 0 AND 100)
  AND (score_technical       IS NULL OR score_technical       BETWEEN 0 AND 100)
  AND (score_trust           IS NULL OR score_trust           BETWEEN 0 AND 100)
);
ALTER TABLE topic_coverage ADD CONSTRAINT coverage_range
  CHECK (coverage_score BETWEEN 0 AND 100);
ALTER TABLE recommendations ADD CONSTRAINT rec_effort_ranges
  CHECK (impact BETWEEN 1 AND 5 AND difficulty BETWEEN 1 AND 5);

-- ── Optional hardening: strict integrity for denormalized project_id ──
-- Prisma can't model a second relation over crawls.project_id, so if/when
-- you want DB-enforced consistency, add (and re-add after any table rebuild):
-- ALTER TABLE sites ADD CONSTRAINT sites_id_project_uk UNIQUE (id, project_id);
-- ALTER TABLE crawls ADD CONSTRAINT crawls_site_project_fk
--   FOREIGN KEY (site_id, project_id) REFERENCES sites (id, project_id);
