# CLAUDE.md

## What Vryse Lite is

Vryse Lite is the analytics and optimization layer for AI search — what Ahrefs and Semrush did for Google rankings, applied to AI-generated answers (ChatGPT, Perplexity, and similar engines). It answers three questions a business currently has no instrumentation for: do AI engines mention or cite us when buyers ask relevant questions, can AI systems access and understand our content, and what should we change to improve. It measures AI visibility three ways — prompt-based citation tracking against real AI engines, retrievability simulation of RAG-style retrieval, and technical AI-crawler access audits — and every score is transparent, versioned, and evidence-linked rather than a black box. It ships as freemium SaaS: a free tier (limited crawl + AI crawler access check) as the growth loop, and one paid tier unlocking full crawls, prompt tracking, competitor comparison, and PDF reports.

## Locked stack

Node.js + TypeScript · Fastify · Prisma · BullMQ · Redis · PostgreSQL + pgvector · Cloudflare R2 · Better Auth · Crawlee + Playwright

No new ORMs, frameworks, queues, or state managers without explicit approval (Engineering-Rules §15.2).

## Dependency direction & import rules (Engineering-Rules §2, verbatim)

### 2.1 Dependency direction (lint-enforced)

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

### 2.2 The rules

- `domain/` **NEVER** imports Infrastructure, Prisma, Fastify, BullMQ, provider SDKs, or anything asynchronous. Pure functions and types only.
- `application/` depends on abstractions: every external system sits behind a port in `application/ports/` (AiGateway, JobQueue, ObjectStorage, CrawlerEngine, ProgressStore, Mailer, Clock). **One sanctioned relaxation:** repository classes from `infrastructure/db/repositories/` are injected directly — but Prisma types **NEVER** cross out of `infrastructure/db/`. Repositories accept and return domain/contract shapes.
- `infrastructure/` implements ports. Provider SDKs are importable **only** inside `infrastructure/ai/adapters/`. Raw SQL exists **only** inside `infrastructure/db/repositories/`.
- `composition/` is the only folder allowed to construct infrastructure. No `new PrismaClient()` or `new Queue()` anywhere else.
- Controllers (HTTP routes **and** worker processors — they are peers) **MUST** only: validate input → resolve auth/context → call exactly one use case → map the result. **No business logic in controllers.**
- **Two golden rules with single owners:** only `infrastructure/ai/` talks to LLM providers; only `application/scoring/` writes `scores` rows. Both are grep-checked in review.

### 2.3 Allowed vs forbidden imports

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

## The three golden rules

1. Provider SDKs are importable **only** inside `infrastructure/ai/adapters/`.
2. `scores` rows are written **only** inside `application/scoring/`.
3. Prisma types **never** leave `infrastructure/db/`.

Both are grep-checked in review; violating either is a blocking failure.

## AI Coding Agent Rules (Engineering-Rules §15, verbatim)

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

## Doc index

- `docs/PRD.md` — product vision, personas, features, business model, NFRs. Source of truth for **what and why**.
- `docs/Architecture.md` — technical architecture & ML pipeline overview; the Crawl→Extract→Index→Analyze→Score→Recommend pipeline shape.
- `docs/Backend.md` — backend system design: deployment topology, module breakdown, queues, workers, gateway, DB/storage/caching/auth/API/security choices and rationale.
- `docs/Database.md` — PostgreSQL schema design: tables, types, indexes, migrations, multi-tenancy. Source of truth for **DDL**.
- `docs/API.md` — REST API contract v1: routes, request/response shapes, error codes. Source of truth for **endpoint behavior**.
- `docs/AI-Pipeline.md` — exact prompts, tiers, output schemas, thresholds, and scoring formulas. The implementable layer for the AI pipeline.
- `docs/Engineering-Rules.md` — the constitution: architecture boundaries, coding/testing/security/perf standards, AI agent rules. This file is derived from it.
- `docs/Milestones.md` — implementation roadmap: milestone sequence, acceptance criteria, build order, cut lines. Read the current milestone before writing code.
- `docs/Frontend-Design.md` — frontend visual direction, screen inventory tied to real API shapes, animation direction, component sourcing (shadcn/ui + 21st.dev). Source of truth for the Next.js build's **look and screen contract**.

## Commands

| Task | Command |
|---|---|
| Dev server | `npm run dev` |
| Tests | `npm test` |
| Lint (incl. boundaries) | `npm run lint` |
| Typecheck | `npm run typecheck` |
| Migrate | `npx prisma migrate dev` |
