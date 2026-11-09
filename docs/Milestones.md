# GEOlens — Implementation Roadmap

**Author:** Tech Lead
**Status:** Execution plan v1
**Inputs (all finalized):** PRD · Backend Architecture · Database Schema · Backend Structure · API Contract · AI Pipeline
**Team assumption:** one developer + Claude Code, focused. Estimates reflect that.

---

## 0. How to Work This Roadmap

**Four principles (from the task rules, made operational):**

1. **Vertical slices.** Every milestone after the three foundations cuts through all layers — route → application → domain/infrastructure → database → something a user or operator can see. No "build all repositories" milestones.
2. **Always deployable.** Every milestone merges to `main`, deploys to staging and production, and leaves health checks green. Surfaces that don't exist yet return honest empty states (the API contract's `hasCompletedCrawl` pattern) — no feature-flag system at MVP.
3. **Walking skeleton first.** M1–M3 are deliberately horizontal (skeleton, schema, queue plumbing appears in M5) because every vertical stands on them — but each still ends in observable, testable behavior, not "it compiles."
4. **MVP over completeness.** §3 lists the cut lines. When behind, cut there — never by skipping tests or the hardening milestone.

**Global Definition of Done (applies to every milestone; not repeated below):**
CI green (typecheck, lint incl. boundary rules, unit, integration) · deployed to staging and prod · all three processes healthy · new env vars in `.env.example` · squash-merged from branch `milestone/NN-name` with the recommended commit message.

**Complexity legend:** S ≈ ≤1 day · M ≈ 2–3 days · L ≈ 4–5 days. Nothing is allowed to be XL — if it is, it was split (see M6/M7, M14/M15).

**Checkpoints:** 🚩 after **M15** — design-partner ready (both aha moments live). 🚩 after **M19** — public-launch ready. M20 gates opening signups broadly.

---

## 1. Milestone Map

| # | Milestone | Complexity | Est. | Depends on |
|---|---|---|---|---|
| M1 | Walking skeleton & deploy pipeline | M | 2d | — |
| M2 | Database foundation | M | 2d | M1 |
| M3 | Authentication & API conventions | M | 2d | M1, M2 |
| M4 | Projects, sites & ownership guard | M | 2d | M3 |
| M5 | Queue infrastructure + deletion purge | M | 2d | M2 |
| M6 | Crawl pipeline end-to-end (no AI) | L | 5d | M4, M5 |
| M7 | Change detection, cancel, evidence reads | M | 3d | M6 |
| M8 | AI crawler access check (aha #1) | M | 2d | M6 |
| M9 | AI gateway + taxonomy generation | M | 3d | M6 |
| M10 | Indexing, embeddings & topic coverage | L | 4d | M7, M9 |
| M11 | Retrievability simulation | M | 3d | M10 |
| M12 | Scoring engine + dashboard | L | 4d | M8, M10, M11 |
| M13 | Recommendations engine | L | 4d | M12 |
| M14 | Prompt templates & generation | M | 2d | M9 |
| M15 | Prompt runs & citation tracking (aha #2) 🚩 | L | 5d | M12, M14 |
| M16 | Competitor comparison & share of voice | M | 2d | M12, M15 |
| M17 | PDF reports | M | 3d | M12, M13 |
| M18 | Scheduling, notifications & digest | M | 3d | M15, M17 |
| M19 | Billing & plan enforcement 🚩 | M | 2d | M4 |
| M20 | Hardening & launch gate | M | 3d | all |

**Total ≈ 58 focused days ≈ 12 weeks** — matches the PRD's one-quarter target with slack for reality.

---

## 2. Milestones

### M1 — Walking Skeleton & Deploy Pipeline

**Objective:** the repo compiles, all three processes deploy, health is observable — the tree from the structure doc exists and is enforceable.

**Features:** repo scaffold with layer folders; ESLint boundary rules active; one Docker image with three commands; local stack (Postgres, Redis, MinIO) via compose; CI pipeline; `/health` per process; structured logging + Sentry wired.

**Files/folders:** `package.json`, `tsconfig.json`, `eslint.config.js`, `docker/Dockerfile`, `docker/docker-compose.local.yml`, `.github/workflows/ci.yml`, `src/config/env.ts`, `src/composition/container.ts` (stub), `src/http/{server,app}.ts`, `src/http/routes/health`, `src/workers/{browser,ai}.entry.ts` (empty), `src/infrastructure/telemetry/`.

**Dependencies:** none.

**Acceptance criteria:**
- [ ] `docker compose up` + three local processes boot against it
- [ ] Staging + prod deployed; `/health` returns 200 for api and both workers
- [ ] A deliberate boundary violation (import Prisma inside `application/`) fails CI
- [ ] Missing env var crashes at boot with a named error, not at first use

**Complexity:** M (≈2d)
**Tests:** CI smoke (boot server via `app.inject()` on `/health`); boundary-lint negative test; env-parse unit tests.
**Commit:** `chore(skeleton): three-process walking skeleton with CI, boundaries, and health checks`

---

### M2 — Database Foundation

**Objective:** the entire schema from the Database doc lives in migrations and deploys automatically; invariants are enforced by Postgres, provably.

**Features:** `schema.prisma` verbatim from the schema doc; hand-edited migration with extensions, partial uniques, expression uniques, CHECKs, GIN/BRIN; `migrate deploy` in the release step; seed script.

**Files/folders:** `prisma/schema.prisma`, `prisma/migrations/*` (incl. manual SQL), `scripts/seed.ts`, `src/infrastructure/db/prisma.ts`, `tests/integration/db/`.

**Dependencies:** M1.

**Acceptance criteria:**
- [ ] Fresh database migrates clean; CI runs migrations against the shadow DB without drift
- [ ] Integration tests prove the invariants: second active crawl for a site → unique violation; two OWN sites → violation; score without inputs → CHECK violation; duplicate `(run, template, engine, sample)` result → violation
- [ ] Seed produces a user, project, sites, and one fake completed crawl for local dev

**Complexity:** M (≈2d)
**Tests:** constraint integration suite (testcontainers); seed idempotency.
**Commit:** `feat(db): full schema, manual SQL invariants, and seed`

---

### M3 — Authentication & API Conventions

**Objective:** a person can create an account and hold a session; every convention from the API contract (problem+json codes, rate limits, CORS/CSRF stance) exists once, as plugins, before any feature route.

**Features:** Better Auth mount (email + Google); `GET /auth/session`, `POST /auth/sign-out`, `GET /me` with usage-vs-limits shape; error-handler plugin emitting stable codes; request-context (requestId + child logger); Redis rate limiting; CORS allowlist + Origin check on mutations.

**Files/folders:** `src/http/plugins/*`, `src/http/routes/{auth,me}`, `src/http/schemas/`, `src/application/auth/`, `src/config/plans.ts`.

**Dependencies:** M1, M2.

**Acceptance criteria:**
- [ ] Sign-up → cookie set → `/me` returns profile + FREE plan usage
- [ ] Wrong password → `401 INVALID_CREDENTIALS` in problem+json with `requestId`
- [ ] Mutation from a disallowed Origin is rejected; rate-limit headers on every response
- [ ] Google OAuth round-trips locally

**Complexity:** M (≈2d)
**Tests:** e2e auth happy/sad paths via `app.inject()`; error-mapper unit tests (typed error → code); rate-limit integration.
**Commit:** `feat(auth): sessions, /me, and API conventions (problem+json, rate limits, CORS)`

---

### M4 — Projects, Sites & Ownership Guard

**Objective:** the tenancy spine — projects with exactly one OWN site and optional competitor, guarded the way every later route will be.

**Features:** projects CRUD per contract (create bundles URL→OWN site + optional competitor); competitors add/remove; URL normalization + public-host validation (`INVALID_URL`); `assertProjectAccess` with 404-not-403 semantics; plan limits (1 project FREE / 3 PRO, 1 competitor).

**Files/folders:** `src/application/projects/`, `src/domain/shared/` (branded ids), `src/domain/crawl/` (URL normalization, `url_hash`), `src/infrastructure/db/repositories/{projects,sites}.repo.ts`, `src/http/guards/project-access.ts`, `src/http/routes/{projects,competitors}`.

**Dependencies:** M3.

**Acceptance criteria:**
- [ ] Full lifecycle via API: create → detail → patch → add/remove competitor
- [ ] Another user's projectId → `404 NOT_FOUND` (not 403) — proven by test
- [ ] Second project on FREE → `403 PLAN_LIMIT_EXCEEDED`; private/localhost URL → `400 INVALID_URL`
- [ ] `DELETE` returns `202 PURGE_SCHEDULED` and soft-deletes (purge lands in M5)

**Complexity:** M (≈2d)
**Tests:** domain unit (normalization: scheme/case/trailing-slash/hash); guard e2e matrix (owner/stranger/missing); plan-limit e2e.
**Commit:** `feat(projects): tenancy spine — projects, sites, ownership guard, plan limits`

---

### M5 — Queue Infrastructure + Deletion Purge

**Objective:** the job system exists and proves itself with real product behavior: project deletion actually purges, in batches, on a worker.

**Features:** BullMQ connection + queue factories; `JobQueue` port + typed enqueue; payload validation at enqueue and dequeue; `job_runs` recorder (QueueEvents sync); worker lifecycle (SIGTERM drain, per-process health); housekeeping processor running the batched purge (derived rows now, R2 objects within SLA); Bull Board behind admin basic-auth.

**Files/folders:** `src/infrastructure/queue/*`, `src/infrastructure/redis/`, `src/application/ports/job-queue.port.ts`, `src/application/jobs/`, `src/workers/lifecycle/`, `src/workers/processors/housekeeping.ts`, `src/composition/workers.ts`.

**Dependencies:** M2.

**Acceptance criteria:**
- [ ] Deleting a seeded project (fake crawl data) empties its child rows in batches — no long locks — and writes a `job_runs` audit row
- [ ] Malformed payload at dequeue → job fails cleanly with a readable error, retries per policy
- [ ] `SIGTERM` mid-job drains: job completes or checkpoints, process exits 0
- [ ] Redis flush loses no domain data; `job_runs` history survives

**Complexity:** M (≈2d)
**Tests:** integration against real Redis (enqueue→process→record); drain test; purge batching test on seeded volume.
**Commit:** `feat(queue): BullMQ foundation, job_runs audit, and batched deletion purge`

---

### M6 — Crawl Pipeline End-to-End (No AI)

**Objective:** the product's spine: click Start Crawl, watch live progress, get pages and snapshots — zero LLM spend. This alone demos.

**Features:** `POST /crawls` (202 + Location, **Idempotency-Key**, active-crawl 409); crawl processor on the browser pool — sitemap discovery + link fallback, Playwright rendering, **SSRF guard on every fetch**, per-domain politeness, page cap; extraction (main content, headings, meta, schema.org presence, links, dates); gzip snapshots to R2 under the key scheme; `pages`/`page_snapshots` writes; progress → Redis; SSE stream (stage/progress/done/error, heartbeat); crawl list + detail; `crawl_completed` event + `GET /events`.

**Files/folders:** `src/infrastructure/crawler/{crawlee,ssrf-guard,extractors}`, `src/infrastructure/storage/`, `src/infrastructure/redis/` (progress adapter), `src/application/crawls/{StartCrawl,CrawlSite}`, `src/application/ports/{crawler-engine,object-storage,progress-store}.port.ts`, `src/workers/processors/crawl.ts`, `src/http/routes/{crawls,progress,events}`, `src/http/sse/` (in structure doc terms: the SSE helper), `src/application/history/`.

**Dependencies:** M4, M5.

**Acceptance criteria:**
- [ ] Crawling a real ~50-page site completes < 10 min; snapshots in R2; rows in `pages`/`page_snapshots` with extracted columns populated
- [ ] SSE narrates the friendly stage messages and ends with `done`; reconnect mid-crawl resumes cleanly
- [ ] Second POST while active → `409 CRAWL_ALREADY_ACTIVE`; replayed Idempotency-Key returns the original 202
- [ ] SSRF suite: localhost, RFC-1918, metadata IPs, and a redirect-to-internal all rejected — **merge-blocking**
- [ ] `GET /events` shows `crawl_completed`

**Complexity:** L (≈5d)
**Tests:** SSRF unit+integration matrix; extractor unit tests on fixture HTML; e2e crawl against a local fixture site (compose-served); SSE integration.
**Commit:** `feat(crawl): end-to-end crawl with SSE progress, SSRF guard, and R2 snapshots`

---

### M7 — Change Detection, Cancel & Evidence Reads

**Objective:** re-crawls become cheap and auditable; the evidence layer opens.

**Features:** content-hash change detection against `pages.latest_content_hash`; unchanged snapshots marked with `carried_forward_from_id`; crawl cancel; frontier checkpoint → killed crawls resume, not restart; `GET /crawls/{id}/pages` (with `changed` filter) and `GET /snapshots/{id}` detail.

**Files/folders:** `src/domain/crawl/` (change policy), `src/application/crawls/` (cancel, checkpointing), `src/workers/lifecycle/` (checkpoint hook), `src/http/routes/{crawls,snapshots}`.

**Dependencies:** M6.

**Acceptance criteria:**
- [ ] Immediate re-crawl of an unchanged site: `pagesChanged = 0`, zero new R2 uploads for unchanged pages, carried-forward lineage set
- [ ] One edited fixture page → exactly that page marked changed
- [ ] Cancel mid-crawl → `CANCELED` with partial data retained; cancel after completion → 409
- [ ] `kill -TERM` mid-crawl, worker restarts → crawl resumes from checkpoint (page counts prove no restart)

**Complexity:** M (≈3d)
**Tests:** change-policy domain units; resume drill (scripted); evidence-endpoint e2e.
**Commit:** `feat(crawl): change detection with carry-forward lineage, cancel, and resume`

---

### M8 — AI Crawler Access Check (Aha #1)

**Objective:** the cheapest high-value feature ships: "you've been blocking GPTBot for a year," with the fix attached. Zero LLM cost.

**Features:** robots.txt evaluation for GPTBot, ClaudeBot, PerplexityBot, Google-Extended, CCBot, Bytespider; llms.txt presence/validity; CDN-block probe (AI-bot UA response comparison); per-bot findings with copy-paste fixes; `GET /crawls/{id}/analysis` serving the `accessCheck` block (other fields null until later milestones); access events.

**Files/folders:** `src/infrastructure/crawler/{robots,llms-txt}.ts` + CDN probe, `src/domain/crawl/` (robots evaluation logic — pure), `src/application/access-check/`, `src/http/routes/` (analysis read).

**Dependencies:** M6.

**Acceptance criteria:**
- [ ] Fixture matrix passes: fully open, robots-blocked per bot, CDN-blocked, llms.txt present/absent/invalid — each produces the right finding + fix text
- [ ] Runs inside every crawl; results visible in the analysis endpoint within the crawl's runtime
- [ ] A blocked bot appears as a finding, not a crawl failure (it *is* a finding)

**Complexity:** M (≈2d)
**Tests:** domain units on robots parsing; integration against fixture servers with per-UA behavior; analysis e2e.
**Commit:** `feat(access-check): AI crawler access audit with per-bot fixes`

---

### M9 — AI Gateway + Taxonomy Generation

**Objective:** the only door to LLM providers exists with all its guarantees — proven by the first real AI feature: an editable topic taxonomy per project.

**Features:** gateway with tier routing (`bulk/judge/frontier/engine:*`); provider adapters (OpenAI, Anthropic, Groq, Gemini, Perplexity — completion + embeddings); structured outputs (zod → validate → one repair retry → hard fail); prompt caching; budget pre-checks; `ai_usage` ledger; Langfuse tracing; versioned prompt file `taxonomy/v1`; taxonomy generated after first completed crawl; topics endpoints (list/add/edit/archive) with the case-insensitive uniqueness rule.

**Files/folders:** `src/infrastructure/ai/{adapters,tiering,structured,budgets,tracing}`, `src/infrastructure/ai/prompts/taxonomy/`, `src/application/ports/ai-gateway.port.ts`, `src/application/analysis/` (taxonomy), `src/http/routes/topics`, `src/config/model-tiers.ts`.

**Dependencies:** M6.

**Acceptance criteria:**
- [ ] First crawl of a fixture SaaS site yields 10–20 sensible topics, editable via API; duplicate active label → 400
- [ ] Every gateway call lands in `ai_usage` with purpose + cost and appears as a Langfuse trace
- [ ] Malformed model output → repair retry → on second failure a typed error, never a guessed parse
- [ ] Swapping a tier's model is a `config/model-tiers.ts` change only — proven by grep: no model names outside config

**Complexity:** M (≈3d)
**Tests:** structured-output unit (valid/repairable/unrepairable fixtures); metering integration; adapter contract tests against recorded fixtures; topics e2e.
**Commit:** `feat(ai): provider gateway with tiers, budgets, metering, tracing + taxonomy v1`

---

### M10 — Indexing, Embeddings & Topic Coverage

**Objective:** the semantic layer: chunks with vectors and FTS, topic coverage per crawl, and the first competitor-gap insight.

**Features:** heading-aware chunking (pure); two-phase chunk writes via the raw-SQL repo (rows, then embedding batch; `tsv` set in the INSERT); chunk→topic mapping by embedding similarity; `topic_coverage` per crawl; `GET /topics/coverage` (own vs competitor, gaps ranked); the fan-out **Flow** debuts — index/analyze children under an aggregate parent (parent just finalizes for now).

**Files/folders:** `src/domain/content/` (chunking), `src/domain/topics/` (coverage math), `src/application/indexing/`, `src/infrastructure/db/repositories/chunks.repo.ts`, `src/infrastructure/queue/` (flows), `src/workers/processors/{index,aggregate}.ts`, `src/http/routes/` (coverage).

**Dependencies:** M7, M9.

**Acceptance criteria:**
- [ ] Changed pages produce chunks with embeddings + tsvector; unchanged pages produce **zero** embedding calls (ledger proves it)
- [ ] Coverage rows exist per (crawl, topic); fixture site scores high on covered topics, ~0 on absent ones
- [ ] With a crawled competitor, `missing` topics surface exactly where the fixture says they should
- [ ] Killing an index child mid-flow → retry → aggregate still runs exactly once

**Complexity:** L (≈4d)
**Tests:** chunking domain units (heading paths, token budgets); raw-SQL repo integration (insert, cosine query, tsquery); flow fan-in integration; coverage e2e on fixtures.
**Commit:** `feat(indexing): chunks with vectors/FTS, topic coverage, and flow fan-out`

---

### M11 — Retrievability Simulation

**Objective:** the AI Readiness measurement: can this site's content answer its own customers' questions when chunked and retrieved?

**Features:** synthetic buyer questions from taxonomy (gateway, `bulk`); hybrid retrieval per question (cosine + `ts_rank_cd`, RRF-fused — pure math over repo results); answer-coverage judging (`judge` tier, `retrievability-judge/v1`); hit-rate + coverage metrics persisted on the crawl's analysis; analysis endpoint extended.

**Files/folders:** `src/domain/retrieval/` (RRF, metrics), `src/application/analysis/` (retrievability), `src/infrastructure/ai/prompts/retrievability-judge/`, `src/infrastructure/db/repositories/chunks.repo.ts` (hybrid query), `src/workers/processors/analyze.ts`.

**Dependencies:** M10.

**Acceptance criteria:**
- [ ] Rich fixture site scores visibly higher than thin fixture site — direction proven by test
- [ ] Per-question pass/fail detail retrievable as evidence
- [ ] Judge outage → retrievability null-flagged, crawl still completes (degradation, not failure)

**Complexity:** M (≈3d)
**Tests:** RRF/metrics domain units against hand-computed fixtures; hybrid-query integration; degraded-path integration.
**Commit:** `feat(analysis): retrievability simulation with hybrid retrieval and judged coverage`

---

### M12 — Scoring Engine + Dashboard

**Objective:** the number the product is named for — transparent, versioned, reproducible — and the dashboard that never computes.

**Features:** `config/scoring/v1` (weights frozen); pure composite computation with degradation handling (missing component → reweight + flag); `ComputeScore` as the **sole writer** of `scores`; aggregate parent now: score → events (`score_changed`) → dashboard rebuild; Redis-cached dashboard assembler + invalidation; `GET /dashboard`, `GET /scores`, `GET /scores/latest` (breakdown drawer); executive summary via `frontier` (`exec-summary/v1`); golden-eval baseline recorded in `evals/`.

**Files/folders:** `src/config/scoring/`, `src/domain/scoring/`, `src/application/scoring/`, `src/application/dashboard/`, `src/infrastructure/ai/prompts/exec-summary/`, `src/http/routes/{dashboard,scores}`, `evals/golden-sites/`, `evals/run-golden.ts`.

**Dependencies:** M8, M10, M11.

**Acceptance criteria:**
- [ ] Completed crawl → `scores` row with six components + composite + config version; breakdown drawer resolves every component to evidence
- [ ] Same inputs re-scored → identical output (pure function, proven by test); unchanged fixture across two crawls stays within ±3 points
- [ ] Dashboard p95 < 200ms from cache; correct empty state pre-first-crawl; cache invalidates on aggregate
- [ ] Grep proves no `scores` insert outside `application/scoring/`
- [ ] Golden baseline committed; `run-golden` passes against it

**Complexity:** L (≈4d)
**Tests:** scoring domain units (weights, degradation reweighting, ranges); dashboard cache integration (build/invalidate/serve); e2e drawer; golden run.
**Commit:** `feat(scoring): versioned composite score, breakdown drawer, and cached dashboard`

---

### M13 — Recommendations Engine

**Objective:** the Monday-morning to-do list: rules first, AI second, every card evidence-linked, deduped across crawls.

**Features:** rule predicates over snapshot/check shapes (blocked bots, no llms.txt, missing schema, thin/stale content, orphan pages); AI recommendations from analysis artifacts (`recommendations/v1`, schema-constrained); fingerprint dedupe (same issue updates `last_seen`, never duplicates); impact÷difficulty ranking; `GET`/`PATCH` per contract (client sets OPEN/DONE/DISMISSED only); evidence resolvable via snapshot/check endpoints; dashboard top-recommendations block.

**Files/folders:** `src/domain/recommendations/`, `src/application/recommendations/`, `src/infrastructure/ai/prompts/recommendations/`, `src/http/routes/recommendations`.

**Dependencies:** M12.

**Acceptance criteria:**
- [ ] Broken fixture (blocked bots, thin pages, no schema) → the expected rule recs, correct priorities, working evidence links
- [ ] Two consecutive crawls with the same issue → **one** rec with updated `last_seen`
- [ ] `PATCH status=VALIDATED` from a client → 400 (pipeline-owned)
- [ ] AI recs that fail schema validation are dropped, never half-saved

**Complexity:** L (≈4d)
**Tests:** rule-predicate units per rule; fingerprint dedupe units + integration across crawls; status-transition e2e matrix.
**Commit:** `feat(recommendations): rules + AI recs with fingerprint dedupe and evidence links`

---

### M14 — Prompt Templates & Generation

**Objective:** the tracked-prompt surface: generated from the taxonomy, user-curated, text-immutable.

**Features:** prompt generation post-first-crawl (10 buyer-intent prompts via `frontier`, new `prompt-gen/v1`); CRUD per contract — add (plan-limited, dedup by `md5(text)`), pin, archive, reorder; `403 PROMPT_TEXT_IMMUTABLE` on text edits; archive-and-create flow documented in the API response detail.

**Files/folders:** `src/application/prompt-sim/` (template management + generation), `src/infrastructure/ai/prompts/prompt-gen/`, `src/http/routes/prompts`.

**Dependencies:** M9.

**Acceptance criteria:**
- [ ] First crawl yields 10 plausible prompts spanning intents (comparison/recommendation/howto)
- [ ] 11th active prompt on MVP limits → `403 PLAN_LIMIT_EXCEEDED`; duplicate active text → 400
- [ ] Sending `text` in PATCH → `403 PROMPT_TEXT_IMMUTABLE`; archived prompts keep their results

**Complexity:** M (≈2d)
**Tests:** e2e CRUD matrix incl. immutability; generation output schema validation; limit tests.
**Commit:** `feat(prompts): tracked prompt templates with generation and text immutability`

---

### M15 — Prompt Runs & Citation Tracking (Aha #2) 🚩

**Objective:** the differentiator: real prompts against real engines, parsed into mention/citation truth, feeding the score. **Design-partner checkpoint.**

**Features:** `POST /prompt-runs` (202, Idempotency-Key, overlap 409, quota); processor expanding prompt × engine × 3 samples through `engine:*` tiers (Perplexity + OpenAI first, per PRD open question resolution); deterministic mention/citation parsing (brand variants, domain-matched citations) with `mention-judge` fallback for ambiguity only; per-cell `prompt_results` (unique-constraint idempotent); run metrics (mention rate, citation share, per-engine, SoV inputs); **new score row on run completion** (citation component live); run detail/results/trend endpoints + SSE; `citation_gained/lost` events.

**Files/folders:** `src/domain/prompts/` (variants, matching, metric math), `src/application/prompt-sim/RunPromptSimulation`, `src/infrastructure/ai/adapters/` (engine modes), `src/infrastructure/ai/prompts/mention-judge/`, `src/workers/processors/prompt-sim.ts`, `src/http/routes/prompt-runs`.

**Dependencies:** M12, M14.

**Acceptance criteria:**
- [ ] On-demand run (10×2×3 = 60 cells) completes < 5 min; every cell has parsed fields + answer text as evidence
- [ ] Deterministic parser handles fixture answers (mentioned/cited/neither/competitor-only); judge invoked only on the ambiguous fixture — ledger proves call counts
- [ ] Run completion creates a score row with `prompt_run_id` set; trend endpoint shows per-engine points
- [ ] One engine down → `COMPLETED_DEGRADED`, other engine's cells intact; per-cell errors don't fail the run
- [ ] Retry of a cell job cannot double-insert (constraint test)

**Complexity:** L (≈5d)
**Tests:** parser domain units (the fixture matrix above); run integration with faked engine adapters; degraded-run integration; SSE + trend e2e.
**Commit:** `feat(prompt-sim): engine runs with mention/citation parsing, metrics, and score integration`

---

### M16 — Competitor Comparison & Share of Voice

**Objective:** the comparison page's single server-computed read: latest own vs latest competitor, with SoV from real runs.

**Features:** `GET /comparison` assembling ComparisonMetrics for both sites (latest completed crawls), share-of-voice block from the latest run's metrics, missing-topics reuse; null-safe until the competitor has data; dashboard comparison summary block.

**Files/folders:** `src/application/analysis/` (comparison assembler), `src/http/routes/comparison`, `src/application/dashboard/` (summary block).

**Dependencies:** M12, M15.

**Acceptance criteria:**
- [ ] With both sites crawled + one run: full payload matches fixtures (metrics, SoV, gaps ranked)
- [ ] No competitor / competitor not yet crawled → nulls per contract, never 500
- [ ] Client performs zero joins — one request renders the page

**Complexity:** M (≈2d)
**Tests:** assembler integration across data-availability states; e2e contract-shape check.
**Commit:** `feat(comparison): server-computed competitor comparison with share of voice`

---

### M17 — PDF Reports

**Objective:** the client-ready artifact: assemble → render on the browser pool → store → signed download.

**Features:** `POST /reports` (202, Idempotency-Key, 409 when no completed crawl); report processor rendering a server-side report view via Playwright print; PDF to R2; status + list endpoints; `GET …/download` → 302 signed URL (~5 min); `REPORT_NOT_READY` before READY.

**Files/folders:** `src/application/reports/`, `src/workers/processors/report.ts`, `src/infrastructure/storage/` (signed URLs), `src/http/routes/reports`.

**Dependencies:** M12, M13.

**Acceptance criteria:**
- [ ] Report for a seeded project: summary, score + breakdown, trend, top recs, comparison — visually sane, < 60s generation
- [ ] Download 302s to a working signed URL; expired URL fails; API never streams bytes
- [ ] Generation shares the browser pool without starving an active crawl (concurrency test)

**Complexity:** M (≈3d)
**Tests:** render integration (PDF exists, page count sane, key scheme right); e2e status flow incl. NOT_READY; pool-contention test.
**Commit:** `feat(reports): PDF generation on the browser pool with signed downloads`

---

### M18 — Scheduling, Notifications & Digest

**Objective:** the retention loop runs itself: weekly crawls and runs, completion emails, a digest that respects the inbox.

**Features:** repeatable jobs — weekly crawl + prompt run per paid project, staggered by project hash in project timezone, overlap-guarded; crawl-complete email (Resend); weekly digest (score delta, citation wins/losses, what changed — **skipped if nothing changed**); housekeeping completed: retention cleanup, usage rollups, failed-job sweeper (>5% alert), budget monitor.

**Files/folders:** `src/workers/processors/` (schedule registration per structure doc), `src/infrastructure/queue/` (repeatables), `src/application/notifications/`, `src/infrastructure/email/` (templates), `src/workers/processors/housekeeping.ts`.

**Dependencies:** M15, M17.

**Acceptance criteria:**
- [ ] Repeatable registration is idempotent across worker restarts (no duplicate schedules)
- [ ] Scheduled crawl skips cleanly when one is already active; SCHEDULED trigger recorded
- [ ] Digest fixture with changes → email with correct deltas; quiet week → no email (test proves the skip)
- [ ] Sweeper alert fires on an induced failure spike

**Complexity:** M (≈3d)
**Tests:** schedule idempotency integration; digest composition units (delta math, skip logic); email snapshot tests.
**Commit:** `feat(schedule): weekly automation, notifications, and skip-if-quiet digest`

---

### M19 — Billing & Plan Enforcement 🚩

**Objective:** money moves and limits are real everywhere. **Public-launch checkpoint.**

**Features:** Stripe Checkout + customer portal endpoints; signature-verified webhook → subscription upserts (idempotent by Stripe IDs); entitlements resolved server-side at every enforcement point; full audit of gates (projects, competitor, prompts, on-demand runs, page caps FREE 25 / PRO 100); `/me` usage block accurate.

**Files/folders:** `src/infrastructure/payments/`, `src/application/billing/`, `src/http/routes/{billing,webhooks}`.

**Dependencies:** M4 (gates exist throughout; this makes them plan-driven).

**Acceptance criteria:**
- [ ] Test-mode checkout → webhook → plan flips to PRO → limits expand immediately; cancel → downgrade behavior defined and tested
- [ ] Replayed webhook events cause no duplicate state (idempotency by Stripe IDs)
- [ ] Gate audit checklist: every limit point verified against both plans (documented in the PR)

**Complexity:** M (≈2d)
**Tests:** webhook integration with Stripe fixtures incl. replays; entitlement e2e matrix.
**Commit:** `feat(billing): Stripe checkout, webhooks, and end-to-end plan enforcement`

---

### M20 — Hardening & Launch Gate

**Objective:** prove the failure stories before users find them; freeze the launch baseline.

**Features:** drill suite executed and scripted where possible — SSRF checklist re-run against prod config; provider-down drill (→ `COMPLETED_DEGRADED` + banner data, never blank); budget kill-switch drill (over-budget crawl degrades and flags); Redis-loss drill (reads fine, intake pauses honestly); resume drill re-run; load sanity (10 concurrent crawls + runs on staging); security pass (headers, dependency audit, secrets scan); golden evals gating CI on prompt/model/weight changes; alerts verified end-to-end; one-page runbook.

**Files/folders:** `evals/`, `scripts/` (drill scripts), `.github/workflows/` (golden gate), `docs/runbook.md`, config touch-ups only.

**Dependencies:** all.

**Acceptance criteria:**
- [ ] Every drill above executed with written results; any red finding fixed before sign-off
- [ ] Golden evals wired as a CI gate on the paths that can move scores
- [ ] Alert test-fires reach a human; runbook covers the five failure modes from the architecture doc
- [ ] Launch checklist signed — this milestone is the gate, not a formality

**Complexity:** M (≈3d)
**Tests:** the drills are the tests.
**Commit:** `chore(hardening): failure drills, golden-eval CI gate, and launch runbook`

---

## 3. Cut Lines (when reality bites)

Cut in this order, never by thinning tests or skipping M20:

1. **M17 reports** → post-launch fast-follow (design partners can screenshot the dashboard).
2. **M16 comparison page** → keep the data (competitor crawls + SoV metrics exist from M10/M15), ship the page later.
3. **M18 digest** → keep the schedules + completion email, cut the weekly digest.
4. **Second engine in M15** → launch with one engine, add the second in week one post-launch.
5. **M13 AI-layer recs** → rules-only recommendations are still genuinely useful; add the AI pass after.

What is never cut: M6's SSRF suite, M12's score purity/versioning, M15's parsing correctness, M20 entirely — these are the trust spine of the product.

---

*End of document. First action: create branch `milestone/01-walking-skeleton` and make the tree from the structure doc compile.*