# Engineering-Rules.md

**Status:** Constitution — source of truth for all engineering work on Vryse Lite.
**Applies to:** every human engineer and every AI coding agent (Claude Code, Cursor, Copilot, or any other), on every change, forever.
**Relationship to other documents:** the PRD, System Architecture, Database Design, Backend Structure, API Contract, AI Pipeline, and Implementation Roadmap define **what** we build. This file defines **how**. If code conflicts with this file, the code is wrong. If this file must change, that change happens through a pull request with an ADR — never silently.

**Keywords:** **MUST** = non-negotiable, CI-enforced where possible. **NEVER** = a violation is a blocking review failure. **SHOULD** = default; deviating requires a written reason in the PR.

---

# 1. Project Philosophy

1. **Production-quality only.** There is no "prototype mode" flag in this repo. Every merge to `main` deploys.
2. **Maintainability first.** Optimize for the engineer reading this code in 12 months, not for lines saved today.
3. **Simplicity over cleverness.** If two designs work, ship the boring one. Cleverness must justify itself in the PR description.
4. **Clean Architecture, pragmatically.** We keep the dependency rule and thin edges; we skip ceremony (see §2). The boundaries are lint-enforced, not aspirational.
5. **The backend is the source of truth.** Scores, limits, comparisons, entitlements, and derived data are computed server-side exactly once. The frontend renders; it never re-derives.
6. **Every feature is observable.** If it can't be seen in logs, traces, `job_runs`, or the `ai_usage` ledger, it isn't done.
7. **Everything is testable.** Code that can't be tested at its layer (pure domain, faked ports, real infra in containers) is mis-layered — fix the layering, not the test.
8. **Never trade correctness for speed.** Cut scope using the roadmap's cut lines. Never cut invariants, tests, security, or score integrity. Trust is the product.

---

# 2. Architecture Rules

## 2.1 Dependency direction (lint-enforced)

```
        http/  ·  workers/          ← thin edges (controllers)
              │
              ▼
        application/                ← use cases; owns transactions, authz,
              │                       enqueueing, event emission
              ▼
          domain/                   ← pure, sync, deterministic; imports nothing
              
   infrastructure/  → implements application/ports/*; touches the world
   composition/     → the ONLY place that wires concrete → abstract
```

## 2.2 The rules

- `domain/` **NEVER** imports Infrastructure, Prisma, Fastify, BullMQ, provider SDKs, or anything asynchronous. Pure functions and types only.
- `application/` depends on abstractions: every external system sits behind a port in `application/ports/` (AiGateway, JobQueue, ObjectStorage, CrawlerEngine, ProgressStore, Mailer, Clock). **One sanctioned relaxation:** repository classes from `infrastructure/db/repositories/` are injected directly — but Prisma types **NEVER** cross out of `infrastructure/db/`. Repositories accept and return domain/contract shapes.
- `infrastructure/` implements ports. Provider SDKs are importable **only** inside `infrastructure/ai/adapters/`. Raw SQL exists **only** inside `infrastructure/db/repositories/`.
- `composition/` is the only folder allowed to construct infrastructure. No `new PrismaClient()` or `new Queue()` anywhere else.
- Controllers (HTTP routes **and** worker processors — they are peers) **MUST** only: validate input → resolve auth/context → call exactly one use case → map the result. **No business logic in controllers.**
- **Two golden rules with single owners:** only `infrastructure/ai/` talks to LLM providers; only `application/scoring/` writes `scores` rows. Both are grep-checked in review.

## 2.3 Allowed vs forbidden imports

```ts
// ✅ edge → application
import { startCrawl } from "../../application/crawls/start-crawl";

// ✅ application → port (type-only)
import type { AiGateway } from "../ports/ai-gateway.port";

// ✅ infrastructure adapter → provider SDK (ONLY here)
import OpenAI from "openai"; // legal only in infrastructure/ai/adapters/

// ❌ application → Prisma            (ESLint: blocked)
import { PrismaClient } from "@prisma/client";

// ❌ domain → infrastructure         (ESLint: blocked)
import { prisma } from "../../infrastructure/db/prisma";

// ❌ application → BullMQ            (use the JobQueue port)
import { Queue } from "bullmq";

// ❌ http route → repository directly (must go through a use case)
import { ProjectsRepo } from "../../infrastructure/db/repositories/projects.repo";
```

Disabling a boundary rule to make an import compile is **NEVER** acceptable. Fix the layering.

---

# 3. TypeScript Standards

- `strict: true`, plus `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`. These flags **MUST NOT** be weakened.
- **NEVER** `any`. Use `unknown` at trust boundaries and narrow explicitly. `as` casts require an adjacent comment justifying them; `@ts-ignore`/`@ts-expect-error` require a reason string and reviewer sign-off.
- `readonly` by default: function parameters, arrays (`readonly T[]`), and object fields that never mutate.
- **Branded IDs** for every entity id — mixing a `CrawlId` into a `ProjectId` slot must be a compile error:

```ts
declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };
export type ProjectId = Brand<string, "ProjectId">;
export type CrawlId   = Brand<string, "CrawlId">;
```

- **Result types for expected failures** in `domain/` and `application/`; `throw` is reserved for programmer errors and infrastructure faults, which the edge's error mapper converts to problem+json:

```ts
export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };
```

- **Discriminated unions + exhaustive switches** for every finite state (crawl status, rec status, job kinds):

```ts
function assertNever(x: never): never { throw new Error(`Unhandled variant: ${String(x)}`); }

switch (crawl.status) {
  case "QUEUED": /* … */ break;
  case "CRAWLING": /* … */ break;
  // …every case…
  default: assertNever(crawl.status); // adding a status breaks the build here — good
}
```

- Prefer union literal types over TS `enum` in our own code (Prisma-generated enums are fine to consume).
- No default exports (except where a framework demands one). No barrel `index.ts` re-export files — explicit paths keep dependency direction visible.
- `bigint` database ids are string-encoded at the API boundary; never leak `BigInt` into JSON serialization.

---

# 4. API Standards

- REST under `/v1`; version bumps only for breaking changes. Additive changes (new optional fields/endpoints) are non-breaking and allowed.
- **Zod at every boundary.** Request and response schemas live in `contracts/api` and are the single source of truth; `@fastify/swagger` generates the live spec from them. Hand-written duplicate types are forbidden.
- **Errors are RFC-7807 problem+json** with the stable `code` table from the API Contract (`CRAWL_ALREADY_ACTIVE`, `PLAN_LIMIT_EXCEEDED`, `PROMPT_TEXT_IMMUTABLE`, …). New codes are added to the contract doc in the same PR. Clients switch on `code`, never on message text.
- **Request IDs everywhere:** every response carries `requestId`; every log line in that request's scope carries it; workers propagate the originating id into job context.
- **Structured logging only** (pino, JSON). `console.log` is a lint error. Never log secrets, cookies, full answer texts, or raw page HTML.
- **Idempotency:** the three async triggers (`POST /crawls`, `POST /prompt-runs`, `POST /reports`) **MUST** require `Idempotency-Key`; replay returns the original 202; key reuse with a different payload → `409 IDEMPOTENCY_KEY_REUSED`.
- Async pattern is **202 + Location + SSE** — HTTP handlers never perform pipeline work inline.
- Ownership semantics: not-yours → **404**, never 403. `403` is reserved for entitlement/state violations.
- Cursor pagination only: `{ data, nextCursor }`. No offsets, no totals on volume tables.

---

# 5. Database Standards

- **Prisma is the only ORM.** All database access goes through `infrastructure/db/repositories/` — use cases **NEVER** touch `prisma` directly, and Prisma types never escape that folder.
- **Raw SQL only where documented:** vector + FTS operations in `chunks.repo.ts`, cursor internals in `events.repo.ts`. Any new raw SQL requires a comment block (why Prisma can't express it) and reviewer sign-off. Raw SQL is always parameterized — string-built SQL is a blocking failure.
- **Migrations:** `prisma migrate dev --create-only`, hand-append the manual SQL (extensions, partial/expression uniques, CHECKs, GIN/BRIN) so it lives in migration history. Every migration is reviewed. Applied migrations are **NEVER** edited. Zero-downtime via expand-and-contract (add nullable → backfill → enforce).
- **Foreign keys required** on every relation, with `onDelete` chosen deliberately (`Cascade` for owned children, `Restrict` where evidence must survive — e.g. prompt results → templates, `SetNull` for ledgers/audit).
- **Invariants live in the database:** one OWN site per project, one active crawl per site, no duplicate result cells — as (partial) unique constraints, not application checks. New business invariants **SHOULD** get the same treatment.
- **Indexes are decisions:** every new query pattern in a PR states which index serves it (existing or added). Unindexed hot-path queries are a review failure.
- **Transactions** (`$transaction`) wrap every multi-step write that must be atomic. **NEVER** perform network or LLM calls inside a transaction.
- Money is integer micro-USD `bigint`. Timestamps are `timestamptz`. Enum policy: Postgres enums for closed sets we control; `text` for open sets (engine names).

---

# 6. AI Standards

- **Every prompt is a versioned file** in `infrastructure/ai/prompts/<name>/vN.md` with a header (purpose, tier, inputs, output schema, eval notes). Inline prompt strings in code are forbidden.
- **All model access goes through the gateway.** Callers request a tier (`bulk` / `judge` / `frontier` / `engine:*`), never a model. Model names exist only in `config/model-tiers.ts` — grep-enforced.
- **JSON outputs only**, validated against zod schemas in `contracts/ai`. On failure: **exactly one repair retry**, then a typed failure. Never parse leniently, never guess, never half-save.
- **Never trust LLM output:** clamp numeric ranges, drop invalid items, and treat all crawled page content as untrusted data — delimited in prompts, analysis calls get **no tool access**, and no model output wholesale asserts a score (our code computes composites from constrained parts).
- **Track everything:** every call writes to the `ai_usage` ledger (purpose, provider, model, tokens, cost, latency) and emits a Langfuse trace. A model call without a ledger row is a bug.
- **Budgets:** the gateway pre-checks the per-crawl/per-run budget; over budget → degrade and flag (`degradation`), never silent overspend and never hard-crash the pipeline.
- **Cache deliberately:** provider prompt caching for shared prefixes (rubrics, site profile); change detection prevents re-analysis; scheduled work uses batch APIs.
- **Prompt/model/scoring changes require evaluation:** any edit under `infrastructure/ai/prompts/`, `config/model-tiers.ts`, or `config/scoring/` **MUST** ship as a new version file and pass `evals/run-golden` (CI-gated). Frozen versions are never edited in place.

---

# 7. Queue Standards

- **BullMQ only.** Queues, concurrency, rate limits, and backoff live in `config/queues.ts` — not scattered at call sites.
- **Idempotent jobs by construction:** deterministic job IDs (`crawl:{crawlId}`, `analyze:{snapshotId}`), upsert-style writers, and DB unique constraints as the backstop. Any job **MUST** be safe to run twice.
- **Payloads validated twice** (enqueue and dequeue) against `contracts/jobs` — a queue is a deploy boundary.
- **Retry policy documented per queue:** default 3 attempts, exponential backoff; deviations declared in `config/queues.ts` with a comment.
- **Dead letters are watched:** exhausted jobs stay in the failed set with full errors; the sweeper alerts at >5% failure and writes a human-readable reason onto the domain record (e.g. `crawls.error_reason`).
- **Progress** goes through the ProgressStore (Redis hash) feeding SSE — never invent a second progress channel.
- **Cancellation:** long jobs (crawls) check for cancellation at safe points and exit cleanly to `CANCELED`.
- **Graceful shutdown:** SIGTERM → stop claiming → drain or checkpoint → exit 0. Crawls resume from checkpoints; they never restart from zero.
- **Workers are stateless:** anything that must survive lives in Postgres (or Redis for operational state). A Redis flush may pause work; it may never lose domain data.
- Fan-out/fan-in uses BullMQ **Flows**; aggregate parents run exactly once. User-triggered jobs outrank scheduled ones. Every job execution mirrors into `job_runs`.

---

# 8. Frontend Standards

- **Stack (locked):** Next.js App Router · Tailwind · shadcn/ui · TanStack Query · React Hook Form (+ zodResolver) · Zustand.
- **Types come from `contracts/`** — the frontend **NEVER** hand-writes API types or re-validates with its own schemas.
- **TanStack Query owns all server state.** Server data **NEVER** lives in Zustand; Zustand is for ephemeral client state only (open drawers, wizard steps). Query keys are project-scoped and invalidated on mutation.
- **No business logic in components.** The backend computed it (§1.5); components render it. Derivations beyond formatting belong server-side or in query `select`.
- **Every async surface has a designed loading state** (skeletons per the design spec) and **every collection has a designed empty state** (the `hasCompletedCrawl` pattern). Blank divs and spinners-forever are review failures.
- **Error boundaries** per route segment; API errors are switched on problem+json `code` (e.g. `PLAN_LIMIT_EXCEEDED` → upgrade prompt), never on message strings.
- **Forms:** React Hook Form + the shared zod schema; mutations require pending states and disabled double-submit (the API's Idempotency-Key is the backstop, not the excuse).
- **SSE** via `EventSource` with reconnect handling — progress UIs must survive a dropped connection because the stream is resume-safe.
- **Auth is cookies.** No tokens in `localStorage`/`sessionStorage`, ever.
- Accessibility: WCAG AA contrast, keyboard navigation, labeled inputs — checked in review (§11).

---

# 9. Testing Standards

| Layer | Required tests | Doubles policy |
|---|---|---|
| `domain/` | Pure unit tests for every exported function | None — values in, values out |
| `application/` | Unit with fakes at ports; integration for transactional flows | Fake ports; real (containerized) DB for integration |
| `infrastructure/` | Integration against real Postgres + Redis (testcontainers/compose) | **Never mock the thing under test** |
| HTTP | e2e via the `server.ts` factory + `app.inject()` (happy + every documented error code) | Live wiring, faked providers |
| Workers | Real queue round-trip; drain/resume/retry behavior | Faked adapters |
| AI | Golden tests in `evals/` on fixture sites | Gate on prompt/model/scoring changes |

- **Every feature PR adds tests at the layer it changes.** A bugfix starts with a failing test that reproduces the bug.
- **Coverage floors (CI-enforced):** `domain/` ≥ 95% · `application/` ≥ 85% · repo overall ≥ 80% lines. Coverage is a floor, not a target — an untested invariant at 90% coverage is still a failure.
- **Merge-blocking suites** that may never be skipped or weakened: the SSRF matrix, the database-constraint suite, the mention/citation parser matrix, and the golden evals.
- Tests assert behavior and contracts, not implementation details. Snapshot tests only for rendered artifacts (emails, PDFs).

---

# 10. Git Workflow

- **One milestone = one branch = one PR = one squash merge.** Branch naming: `milestone/NN-short-name`. `main` is always deployable; direct pushes to `main` are disabled.
- Within a branch, commits are small and coherent — one logical change each. Never force-push a shared branch.
- **Conventional commits:**
  - `feat(scope):` new capability — `feat(crawl): resume from frontier checkpoint`
  - `fix(scope):` bug fix (names the failing test it satisfies)
  - `refactor(scope):` behavior-preserving change (tests unchanged and green)
  - `test(scope):` tests only
  - `docs(scope):` documentation, ADRs, this file
  - `chore(scope):` tooling, deps, CI
- The PR description **MUST** include: the milestone's acceptance-criteria checklist (checked), a list of every file created/changed with a one-line reason, and any deviations from the docs with their ADR link.

---

# 11. Code Review Checklist

Nothing merges until every line is honestly checkable:

- [ ] **Architecture** — boundary lint clean; no logic in controllers; golden-rule greps pass (no provider SDK outside adapters, no `scores` writes outside `application/scoring/`)
- [ ] **Performance** — new queries name their index; no N+1; heavy work is on a queue; pagination is cursor-based
- [ ] **Security** — any user-influenced URL fetch goes through the SSRF guard; inputs zod-validated; authz guard is the first line of every scoped path; nothing sensitive logged
- [ ] **Readability** — a new engineer could follow it; no cleverness without a comment earning it
- [ ] **Naming** — use cases are verbs; files match the structure doc; no `utils.ts` dumping grounds
- [ ] **Logging** — request/job IDs propagated; failures log a human-readable reason
- [ ] **Observability** — new jobs write `job_runs` + progress; new AI calls write `ai_usage` + trace
- [ ] **Error handling** — typed errors mapped to documented problem codes; degraded paths return partial results, never blanks
- [ ] **Testing** — right layer, right doubles policy, coverage floors held, merge-blocking suites untouched-or-passing
- [ ] **Accessibility** — (frontend) loading/empty states present; keyboard + contrast pass
- [ ] **Cost** — new LLM/embedding calls justify their tier, respect budgets, and are cache/change-detection aware

---

# 12. Security Standards

- **SSRF (threat #1 for this product):** every fetch of a user-influenced URL — crawler, CDN probe, robots, llms.txt — **MUST** pass the SSRF guard: DNS-resolve and reject private/reserved ranges and metadata endpoints, pin the resolved IP (anti-rebinding), re-validate every redirect hop, http/https on 80/443 only. Browser workers run egress-restricted. Touching the guard requires re-running its full matrix.
- **SQL injection:** Prisma parameterization everywhere; raw SQL only in repos, only parameterized. String-concatenated SQL is an automatic block.
- **XSS:** rely on framework escaping; `dangerouslySetInnerHTML` with user or model-produced content (answer texts, crawled titles) is forbidden. Model output is untrusted output.
- **CSRF:** `SameSite=Lax` httpOnly cookies + strict CORS allowlist + Origin check on all mutations. No token-in-JS auth.
- **Rate limiting:** Redis token buckets per user and IP on every route; stricter buckets on the three async POSTs; standard `RateLimit-*` headers.
- **Secrets:** environment only, parsed once in `config/env.ts`; never committed, never logged, never interpolated into prompts. Rotation must not require code changes.
- **Input validation:** zod at every boundary — HTTP, job payloads, webhooks (after signature verification), LLM outputs.
- **Authentication:** Better Auth, DB-backed revocable sessions, verified-email gates where the PRD requires.
- **Authorization:** `assertProjectAccess` is the first statement of every project-scoped use case; not-yours → 404; workers re-verify entity state from the DB and never trust job payloads for authz.
- **Object storage:** buckets private; access via short-lived signed URLs only; the API never proxies file bytes. (No user file uploads at MVP — adding them requires an ADR with content-type allowlist, size caps, and scanning stance.)
- **OWASP Top 10** is the review baseline; `npm audit`/dependency scanning runs in CI and highs are fixed before merge.

---

# 13. Performance Standards

- **Caching, in order of real value:** (1) change detection — unchanged content triggers zero embedding/analysis; (2) provider prompt caching; (3) the Redis dashboard payload cache, invalidated on aggregate. New caches must name their invalidation story or they don't ship.
- **The dashboard never computes.** All dashboard/analysis reads serve precomputed rows (p95 < 200ms from cache; page interactive < 2s per NFR).
- **Pagination:** cursor-based everywhere; `LIMIT` on every list query; no unbounded `findMany`.
- **Streaming:** progress via SSE; large payloads (snapshots) stream to/from R2 gzipped — never buffered whole in memory.
- **Batching:** embeddings in batches; scheduled AI work through provider batch APIs; per-page LLM calls share cached prefixes.
- **Connection pooling:** Prisma through the pooled endpoint (transaction mode); worker concurrency caps are the connection caps — raising one means checking the other.
- **Lazy loading (frontend):** route-level code splitting; heavy chart libs deferred; images sized.
- **Background jobs:** anything over ~500ms of work, or any external fan-out, runs on a queue. HTTP handlers enqueue; they never crawl, embed, or render.
- **Memory:** browser workers run 2–3 concurrent jobs max with per-page timeouts; AI workers are I/O-bound and capped by gateway rate limits; watch for unbounded arrays in aggregate steps.
- Every NFR number from the PRD (crawl < 15 min p90, run < 5 min, score variance ≤ ±3) is a regression test target, not a hope.

---

# 14. Documentation Rules

- **Exported functions in `domain/` and `application/` carry JSDoc** explaining the *why* and the contract (inputs, Result variants) — not a restatement of the code.
- **ADRs** (`docs/adr/NNNN-title.md`, format: Context → Decision → Consequences) are **required** for: any deviation from the seven planning docs, any new dependency, any change to this file, any new raw-SQL site, any security-posture change.
- **README stays runnable:** if setup steps drift, that's a bug fixed in the same PR that caused the drift.
- **API documentation is generated** from the zod/Fastify schemas; the API Contract doc is updated in the same PR as any route change. Contract and code may never disagree across a merge.
- **Prompt documentation:** every prompt version file's header documents purpose, tier, input variables, output schema link, and eval expectations. The golden-eval results for the active version are referenced.
- **Migration notes:** every migration begins with a comment — what changed, why, and the rationale for any manual SQL.
- **This file** is amended only by PR + ADR. Agents and engineers cite the section number when enforcing it in review.

---

# 15. AI Coding Agent Rules

*You — Claude Code, Cursor, Copilot, or any other coding agent — are bound by everything above. These instructions are written to you directly. They are mandatory.*

1. **You are implementing, not designing.** The seven planning documents plus this file are the source of truth. **Never redesign the architecture.** If the docs and reality conflict, **stop and ask** — do not resolve it silently.
2. **Never replace or add technologies without explicit approval.** No new ORMs, frameworks, queues, or state managers. Every new npm dependency must be justified in the PR and approved before use.
3. **Implement exactly one milestone at a time.** Read that milestone's roadmap section fully before writing anything. Do not start the next milestone, and do not "while I'm here" work outside the current scope. No drive-by refactors.
4. **Never skip, weaken, or delete tests.** The milestone's acceptance criteria are the definition of done. A bugfix begins with a failing test. The merge-blocking suites (§9) are untouchable.
5. **Never introduce TODO placeholders, stubs, or fake implementations presented as working.** If you cannot complete something, say so explicitly and stop — an honest gap beats a silent lie in the codebase.
6. **Never hardcode what the config owns:** model names live only in `config/model-tiers.ts`; scoring weights only in `config/scoring/`; queue policy only in `config/queues.ts`; secrets only in the environment.
7. **Run the gates before claiming done:** typecheck, lint (boundaries included), unit + integration tests. If boundary lint fails, fix the layering — **never disable the rule.** Any `eslint-disable` or `@ts-expect-error` needs an inline justification and a reviewer flag.
8. **Explain every file you create or modify** — one line each in the PR description, plus which acceptance criterion it serves.
9. **Ask before assuming.** Ambiguity in the docs → ask a question or propose an interpretation in the PR description; never invent APIs, fields, endpoints, statuses, or behaviors that the Schema/API Contract don't define. Check the contract first; it probably already answers you.
10. **Keep commits small and conventional** (§10). One logical change per commit. Never force-push shared branches.
11. **Respect the tripwires — these changes carry mandatory extra steps:**
    - Touching `infrastructure/ai/prompts/`, `config/model-tiers.ts`, or `config/scoring/` → create a **new version file** and pass `evals/run-golden`.
    - Touching the SSRF guard or anything that fetches user-influenced URLs → run the full SSRF matrix.
    - Adding an LLM call → declare its purpose, tier, budget behavior; verify the `ai_usage` row and trace exist.
    - Adding an endpoint → update the API Contract, add zod schemas, document its error codes, add e2e tests for every documented failure.
    - Adding a job → deterministic job ID, payload schema in `contracts/jobs`, `job_runs` recording, idempotency proof.
12. **Preserve the golden rules:** never call a provider SDK outside `infrastructure/ai/adapters/`; never write a `scores` row outside `application/scoring/`; never let Prisma types escape `infrastructure/db/`.
13. **When you are uncertain whether something violates these rules, it does.** Ask.

---
