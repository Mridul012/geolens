# GEOlens — REST API Contract (v1)

**Author:** Principal Backend Engineering
**Status:** Design review draft
**Pairs with:** Backend Architecture doc, Database Schema doc, Backend Structure doc
**Implementation note:** the zod schemas in `contracts/api` are the runtime source of truth; `@fastify/swagger` generates the live OpenAPI from them. This document is the design contract those schemas implement.

---

## 1. API Conventions

**Base URL & versioning.** All routes live under `https://api.geolens.example/v1`. Version in the path, bumped only for breaking changes. Additive changes (new fields, new endpoints) are not breaking.

**Authentication.** Cookie sessions (Better Auth), httpOnly + Secure + `SameSite=Lax`, DB-backed (revocable). Every endpoint requires a session unless marked `public`. **CSRF stance:** SameSite=Lax cookies + a strict CORS origin allowlist + an Origin-header check on all mutating requests. No tokens in localStorage, ever. API keys are a V2 credential type (per PRD) and are absent from this contract.

**Authorization.** Every resource is project-scoped and nested under `/projects/{projectId}/…` — the URL structure *is* the ownership guard's input. A projectId the session doesn't own returns `404` (not `403`) to avoid existence leaks; `403` is reserved for plan-limit and state violations.

**Errors.** `application/problem+json` (RFC 7807) with a stable machine-readable `code` the UI switches on:

```json
{
  "type": "https://api.geolens.example/errors/plan-limit-exceeded",
  "title": "Plan limit exceeded",
  "status": 403,
  "code": "PLAN_LIMIT_EXCEEDED",
  "detail": "Free plan allows 1 project.",
  "requestId": "req_01J…",
  "errors": [{ "path": "url", "message": "Must be a valid http(s) URL" }]
}
```

| HTTP | code | Meaning |
|---|---|---|
| 400 | `VALIDATION_FAILED` | Body/params failed schema; field errors in `errors[]` |
| 400 | `INVALID_URL` | URL unreachable, non-public, or fails SSRF policy |
| 401 | `AUTH_REQUIRED` | No/expired session |
| 401 | `INVALID_CREDENTIALS` | Sign-in failure |
| 403 | `PLAN_LIMIT_EXCEEDED` | Projects/pages/prompts/runs over plan (deliberate: 403+code, not 402 — 402's semantics are payment-flow, not entitlement) |
| 403 | `PROMPT_TEXT_IMMUTABLE` | Attempt to edit tracked prompt text (see §4) |
| 404 | `NOT_FOUND` | Missing, or not yours (indistinguishable by design) |
| 409 | `CRAWL_ALREADY_ACTIVE` | Active crawl exists for this site (DB partial-unique backstop) |
| 409 | `PROMPT_RUN_ALREADY_ACTIVE` | Active prompt run exists for this project |
| 409 | `IDEMPOTENCY_KEY_REUSED` | Same key, different payload |
| 409 | `EMAIL_IN_USE` | Sign-up conflict |
| 409 | `REPORT_NOT_READY` | Download before `status=READY` |
| 409 | `NO_COMPLETED_CRAWL` | Report requested before the site has a completed crawl |
| 429 | `RATE_LIMITED` | Bucket exhausted; `Retry-After` header set |
| 503 | `DEGRADED` | Dependency down and no partial answer possible |

**Async job pattern.** The three job-triggering POSTs (`crawls`, `prompt-runs`, `reports`) return **`202 Accepted`** with the created resource and a `Location` header pointing at it; progress streams via SSE. They require an **`Idempotency-Key`** header (UUID): replays with the same key+payload return the original `202` response; same key with a different payload → `409 IDEMPOTENCY_KEY_REUSED`. Keys are held 24h in Redis.

**Pagination.** Cursor-based everywhere: `?cursor=…&limit=…` (limit ≤ 100, default 20) → `{ "data": [...], "nextCursor": "…" | null }`. No offsets, no page numbers, no total counts on volume tables.

**Rate limits.** Redis token buckets per user; standard headers `RateLimit-Limit / RateLimit-Remaining / RateLimit-Reset` on every response; stricter buckets on the three async POSTs.

**SSE.** Progress endpoints emit `text/event-stream` with named events: `stage` (`{"message":"Analyzing content structure…"}`), `progress` (`{"pagesFound":42,"pagesCrawled":17,"currentUrl":"…","etaSeconds":180}`), `done` (`{"status":"COMPLETED"}`), `error` (Problem shape). Resume-safe: reconnecting replays current state, never misses terminal events. Server heartbeats every 15s.

**IDs & time.** UUIDs (`bigint` string-encoded where the table uses identity ids), all timestamps ISO-8601 UTC.

---

## 2. Endpoint Index — every route at a glance

| Group | Method & Path | Auth | Purpose |
|---|---|---|---|
| Auth | `POST /auth/sign-up/email` | public | Create account (Better Auth mount) |
| Auth | `POST /auth/sign-in/email` | public | Email sign-in |
| Auth | `POST /auth/sign-in/social` | public | Start Google OAuth |
| Auth | `POST /auth/sign-out` | session | End session |
| Auth | `GET /auth/session` | session | Current session/user |
| Auth | `GET /me` | session | Profile + plan + usage vs limits |
| Projects | `GET /projects` | session | List projects |
| Projects | `POST /projects` | session | Create project (+ own site, optional competitor) |
| Projects | `GET /projects/{projectId}` | session | Project detail (sites, latest crawl, latest score) |
| Projects | `PATCH /projects/{projectId}` | session | Rename / timezone / archive |
| Projects | `DELETE /projects/{projectId}` | session | Soft-delete → async purge (202) |
| Competitors | `GET /projects/{projectId}/competitors` | session | List competitor sites |
| Competitors | `POST /projects/{projectId}/competitors` | session | Add competitor |
| Competitors | `DELETE /projects/{projectId}/competitors/{siteId}` | session | Remove competitor |
| Competitors | `GET /projects/{projectId}/comparison` | session | Side-by-side metrics, share of voice, missing topics |
| Crawler | `POST /projects/{projectId}/crawls` | session | Start crawl (202, Idempotency-Key) |
| Crawler | `GET /projects/{projectId}/crawls` | session | Crawl history |
| Crawler | `GET /projects/{projectId}/crawls/{crawlId}` | session | Crawl detail + stats + degradation |
| Crawler | `POST /projects/{projectId}/crawls/{crawlId}/cancel` | session | Cancel active crawl |
| Crawler | `GET /projects/{projectId}/crawls/{crawlId}/progress` | session | SSE progress stream |
| Crawler | `GET /projects/{projectId}/crawls/{crawlId}/pages` | session | Page snapshots of a crawl |
| Crawler | `GET /projects/{projectId}/snapshots/{snapshotId}` | session | Snapshot detail (evidence view) |
| Analysis | `GET /projects/{projectId}/dashboard` | session | The one precomputed dashboard read |
| Analysis | `GET /projects/{projectId}/crawls/{crawlId}/analysis` | session | Exec summary, access check, retrievability, issues |
| Analysis | `GET /projects/{projectId}/scores` | session | Score history (trend) |
| Analysis | `GET /projects/{projectId}/scores/latest` | session | Latest score + breakdown drawer |
| Analysis | `GET /projects/{projectId}/topics` | session | Taxonomy |
| Analysis | `POST /projects/{projectId}/topics` | session | Add custom topic |
| Analysis | `PATCH /projects/{projectId}/topics/{topicId}` | session | Edit / archive topic |
| Analysis | `GET /projects/{projectId}/topics/coverage` | session | Coverage + gaps (own vs competitor) |
| Recommendations | `GET /projects/{projectId}/recommendations` | session | List (filter status/priority) |
| Recommendations | `GET /projects/{projectId}/recommendations/{recId}` | session | Detail + expanded evidence |
| Recommendations | `PATCH /projects/{projectId}/recommendations/{recId}` | session | done / dismissed / reopen |
| Prompt Tracking | `GET /projects/{projectId}/prompts` | session | Tracked prompt templates |
| Prompt Tracking | `POST /projects/{projectId}/prompts` | session | Add prompt |
| Prompt Tracking | `PATCH /projects/{projectId}/prompts/{promptId}` | session | Pin / archive (text immutable) |
| Prompt Tracking | `GET /projects/{projectId}/prompts/{promptId}/trend` | session | Per-prompt mention/citation over time — **planned, not implemented** (deferred out of M21) |
| Prompt Tracking | `POST /projects/{projectId}/prompt-runs` | session | Trigger on-demand run (202, Idempotency-Key) |
| Prompt Tracking | `GET /projects/{projectId}/prompt-runs` | session | Run history |
| Prompt Tracking | `GET /projects/{projectId}/prompt-runs/trend` | session | Project-level mention rate + citation share per run, overall and per engine |
| Prompt Tracking | `GET /projects/{projectId}/prompt-runs/{runId}` | session | Run detail + metrics |
| Prompt Tracking | `GET /projects/{projectId}/prompt-runs/{runId}/results` | session | Per-cell results (engine × prompt × sample) |
| Prompt Tracking | `GET /projects/{projectId}/prompt-runs/{runId}/progress` | session | SSE progress stream |
| Reports | `POST /projects/{projectId}/reports` | session | Generate PDF (202, Idempotency-Key) |
| Reports | `GET /projects/{projectId}/reports` | session | List reports |
| Reports | `GET /projects/{projectId}/reports/{reportId}` | session | Report status |
| Reports | `GET /projects/{projectId}/reports/{reportId}/download` | session | 302 → short-lived signed URL |
| History | `GET /projects/{projectId}/events` | session | "What changed" feed (cursor, filter by kind) |
| Billing* | `POST /billing/checkout` | session | Stripe Checkout session |
| Billing* | `POST /billing/portal` | session | Stripe customer portal |
| System* | `POST /webhooks/stripe` | signature | Stripe webhook (public path, verified) |
| System* | `GET /health` | public | Liveness/readiness |

\* Billing/System included for completeness; not part of the nine requested groups.

---

## 3. OpenAPI 3.1 Specification

```yaml
openapi: 3.1.0
info:
  title: GEOlens API
  version: 1.0.0-mvp
  description: >
    AI Visibility platform API. Cookie-session auth, project-scoped resources,
    cursor pagination, RFC-7807 errors, 202+SSE for async pipelines.
servers:
  - url: https://api.geolens.example/v1
  - url: http://localhost:3000/v1
    description: local development

security:
  - cookieAuth: []

tags:
  - name: Auth
  - name: Projects
  - name: Competitors
  - name: Crawler
  - name: Analysis
  - name: Recommendations
  - name: Prompt Tracking
  - name: Reports
  - name: History
  - name: Billing

paths:

  # ───────────────────────── Auth ─────────────────────────
  # Implemented by the Better Auth mount (api/plugins); shapes below are the
  # contract the frontend relies on.

  /auth/sign-up/email:
    post:
      tags: [Auth]
      summary: Create an account with email + password
      security: []
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [email, password, name]
              properties:
                email: { type: string, format: email }
                password: { type: string, minLength: 10 }
                name: { type: string, maxLength: 120 }
      responses:
        "200":
          description: Account created; session cookie set
          headers:
            Set-Cookie: { schema: { type: string } }
          content:
            application/json:
              schema: { $ref: "#/components/schemas/SessionInfo" }
        "400": { $ref: "#/components/responses/BadRequest" }
        "409":
          description: EMAIL_IN_USE
          content:
            application/problem+json:
              schema: { $ref: "#/components/schemas/Problem" }
        "429": { $ref: "#/components/responses/TooManyRequests" }

  /auth/sign-in/email:
    post:
      tags: [Auth]
      summary: Sign in with email + password
      security: []
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [email, password]
              properties:
                email: { type: string, format: email }
                password: { type: string }
      responses:
        "200":
          description: Signed in; session cookie set
          content:
            application/json:
              schema: { $ref: "#/components/schemas/SessionInfo" }
        "401":
          description: INVALID_CREDENTIALS
          content:
            application/problem+json:
              schema: { $ref: "#/components/schemas/Problem" }
        "429": { $ref: "#/components/responses/TooManyRequests" }

  /auth/sign-in/social:
    post:
      tags: [Auth]
      summary: Start Google OAuth (returns redirect URL)
      security: []
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [provider]
              properties:
                provider: { type: string, enum: [google] }
                callbackURL: { type: string }
      responses:
        "200":
          description: OAuth redirect URL
          content:
            application/json:
              schema:
                type: object
                properties:
                  url: { type: string, format: uri }
        "400": { $ref: "#/components/responses/BadRequest" }

  /auth/sign-out:
    post:
      tags: [Auth]
      summary: End the current session
      responses:
        "200": { description: Session revoked; cookie cleared }
        "401": { $ref: "#/components/responses/Unauthorized" }

  /auth/session:
    get:
      tags: [Auth]
      summary: Current session + user
      responses:
        "200":
          description: Active session
          content:
            application/json:
              schema: { $ref: "#/components/schemas/SessionInfo" }
        "401": { $ref: "#/components/responses/Unauthorized" }

  /me:
    get:
      tags: [Auth]
      summary: Profile, plan, and usage vs limits
      responses:
        "200":
          description: The authenticated user
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Me" }
        "401": { $ref: "#/components/responses/Unauthorized" }

  # ─────────────────────── Projects ───────────────────────

  /projects:
    get:
      tags: [Projects]
      summary: List projects
      parameters:
        - $ref: "#/components/parameters/Cursor"
        - $ref: "#/components/parameters/Limit"
      responses:
        "200":
          description: Projects owned by the session user
          content:
            application/json:
              schema:
                type: object
                properties:
                  data:
                    type: array
                    items: { $ref: "#/components/schemas/Project" }
                  nextCursor: { type: ["string", "null"] }
        "401": { $ref: "#/components/responses/Unauthorized" }
    post:
      tags: [Projects]
      summary: Create a project (creates the OWN site; optional competitor)
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [name, url]
              properties:
                name: { type: string, maxLength: 120 }
                url: { type: string, format: uri, description: Root URL of the user's website }
                competitorUrl: { type: string, format: uri }
                timezone: { type: string, default: UTC }
      responses:
        "201":
          description: Created (normalized URLs)
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Project" }
        "400":
          description: VALIDATION_FAILED or INVALID_URL (SSRF policy, non-public host)
          content:
            application/problem+json:
              schema: { $ref: "#/components/schemas/Problem" }
        "403":
          description: PLAN_LIMIT_EXCEEDED (project count)
          content:
            application/problem+json:
              schema: { $ref: "#/components/schemas/Problem" }
        "401": { $ref: "#/components/responses/Unauthorized" }

  /projects/{projectId}:
    parameters: [ { $ref: "#/components/parameters/ProjectId" } ]
    get:
      tags: [Projects]
      summary: Project detail (sites, latest crawl, latest score summary)
      responses:
        "200":
          description: Project
          content:
            application/json:
              schema: { $ref: "#/components/schemas/ProjectDetail" }
        "404": { $ref: "#/components/responses/NotFound" }
        "401": { $ref: "#/components/responses/Unauthorized" }
    patch:
      tags: [Projects]
      summary: Update name, timezone, or archive state
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              minProperties: 1
              properties:
                name: { type: string, maxLength: 120 }
                timezone: { type: string }
                status: { type: string, enum: [ACTIVE, ARCHIVED] }
      responses:
        "200":
          description: Updated project
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Project" }
        "400": { $ref: "#/components/responses/BadRequest" }
        "404": { $ref: "#/components/responses/NotFound" }
    delete:
      tags: [Projects]
      summary: Soft-delete project; async purge within 30 days (snapshots) / immediate (derived)
      responses:
        "202":
          description: Purge scheduled
          content:
            application/json:
              schema:
                type: object
                properties:
                  status: { type: string, enum: [PURGE_SCHEDULED] }
        "404": { $ref: "#/components/responses/NotFound" }

  # ────────────────────── Competitors ─────────────────────

  /projects/{projectId}/competitors:
    parameters: [ { $ref: "#/components/parameters/ProjectId" } ]
    get:
      tags: [Competitors]
      summary: List competitor sites
      responses:
        "200":
          description: Competitor sites
          content:
            application/json:
              schema:
                type: object
                properties:
                  data:
                    type: array
                    items: { $ref: "#/components/schemas/Site" }
        "404": { $ref: "#/components/responses/NotFound" }
    post:
      tags: [Competitors]
      summary: Add a competitor site
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [url]
              properties:
                url: { type: string, format: uri }
                name: { type: string, maxLength: 120 }
      responses:
        "201":
          description: Competitor added
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Site" }
        "400":
          description: VALIDATION_FAILED / INVALID_URL / duplicate URL for project
          content:
            application/problem+json:
              schema: { $ref: "#/components/schemas/Problem" }
        "403":
          description: PLAN_LIMIT_EXCEEDED (1 competitor at MVP)
          content:
            application/problem+json:
              schema: { $ref: "#/components/schemas/Problem" }
        "404": { $ref: "#/components/responses/NotFound" }

  /projects/{projectId}/competitors/{siteId}:
    parameters:
      - $ref: "#/components/parameters/ProjectId"
      - name: siteId
        in: path
        required: true
        schema: { type: string, format: uuid }
    delete:
      tags: [Competitors]
      summary: Remove a competitor (its crawl history is retained but detached from comparisons)
      responses:
        "204": { description: Removed }
        "400":
          description: Cannot remove the OWN site via this route
          content:
            application/problem+json:
              schema: { $ref: "#/components/schemas/Problem" }
        "404": { $ref: "#/components/responses/NotFound" }

  /projects/{projectId}/comparison:
    parameters: [ { $ref: "#/components/parameters/ProjectId" } ]
    get:
      tags: [Competitors]
      summary: Side-by-side comparison (latest completed crawls + latest prompt run)
      responses:
        "200":
          description: Comparison payload; competitor block null until its first crawl completes
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Comparison" }
        "404": { $ref: "#/components/responses/NotFound" }

  # ──────────────────────── Crawler ───────────────────────

  /projects/{projectId}/crawls:
    parameters: [ { $ref: "#/components/parameters/ProjectId" } ]
    post:
      tags: [Crawler]
      summary: Start a crawl (defaults to the OWN site)
      parameters: [ { $ref: "#/components/parameters/IdempotencyKey" } ]
      requestBody:
        required: false
        content:
          application/json:
            schema:
              type: object
              properties:
                siteId:
                  type: string
                  format: uuid
                  description: Crawl a specific site (e.g. the competitor); defaults to OWN
      responses:
        "202":
          description: Crawl queued
          headers:
            Location:
              description: URL of the created crawl
              schema: { type: string }
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Crawl" }
        "409":
          description: CRAWL_ALREADY_ACTIVE or IDEMPOTENCY_KEY_REUSED
          content:
            application/problem+json:
              schema: { $ref: "#/components/schemas/Problem" }
        "403":
          description: PLAN_LIMIT_EXCEEDED (on-demand crawl quota)
          content:
            application/problem+json:
              schema: { $ref: "#/components/schemas/Problem" }
        "404": { $ref: "#/components/responses/NotFound" }
        "429": { $ref: "#/components/responses/TooManyRequests" }
    get:
      tags: [Crawler]
      summary: Crawl history for the project
      parameters:
        - $ref: "#/components/parameters/Cursor"
        - $ref: "#/components/parameters/Limit"
        - name: siteId
          in: query
          schema: { type: string, format: uuid }
      responses:
        "200":
          description: Crawls, newest first
          content:
            application/json:
              schema:
                type: object
                properties:
                  data:
                    type: array
                    items: { $ref: "#/components/schemas/Crawl" }
                  nextCursor: { type: ["string", "null"] }
        "404": { $ref: "#/components/responses/NotFound" }

  /projects/{projectId}/crawls/{crawlId}:
    parameters:
      - $ref: "#/components/parameters/ProjectId"
      - $ref: "#/components/parameters/CrawlId"
    get:
      tags: [Crawler]
      summary: Crawl detail — status, stats, degradation flags, cost version stamps
      responses:
        "200":
          description: Crawl
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Crawl" }
        "404": { $ref: "#/components/responses/NotFound" }

  /projects/{projectId}/crawls/{crawlId}/cancel:
    parameters:
      - $ref: "#/components/parameters/ProjectId"
      - $ref: "#/components/parameters/CrawlId"
    post:
      tags: [Crawler]
      summary: Cancel an active crawl
      responses:
        "200":
          description: Crawl moved to CANCELED
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Crawl" }
        "409":
          description: Crawl already terminal (completed/failed)
          content:
            application/problem+json:
              schema: { $ref: "#/components/schemas/Problem" }
        "404": { $ref: "#/components/responses/NotFound" }

  /projects/{projectId}/crawls/{crawlId}/progress:
    parameters:
      - $ref: "#/components/parameters/ProjectId"
      - $ref: "#/components/parameters/CrawlId"
    get:
      tags: [Crawler]
      summary: SSE progress stream (stage, progress, done, error events)
      responses:
        "200":
          description: >
            text/event-stream. Events: `stage` {message}, `progress`
            {pagesFound, pagesCrawled, currentUrl, etaSeconds}, `done` {status},
            `error` {Problem}. Heartbeat every 15s. Reconnect-safe.
          content:
            text/event-stream:
              schema: { type: string }
        "404": { $ref: "#/components/responses/NotFound" }

  /projects/{projectId}/crawls/{crawlId}/pages:
    parameters:
      - $ref: "#/components/parameters/ProjectId"
      - $ref: "#/components/parameters/CrawlId"
    get:
      tags: [Crawler]
      summary: Page snapshots captured by a crawl
      parameters:
        - $ref: "#/components/parameters/Cursor"
        - $ref: "#/components/parameters/Limit"
        - name: changed
          in: query
          schema: { type: boolean }
          description: Filter to pages that changed in this crawl
      responses:
        "200":
          description: Snapshots
          content:
            application/json:
              schema:
                type: object
                properties:
                  data:
                    type: array
                    items: { $ref: "#/components/schemas/PageSnapshotSummary" }
                  nextCursor: { type: ["string", "null"] }
        "404": { $ref: "#/components/responses/NotFound" }

  /projects/{projectId}/snapshots/{snapshotId}:
    parameters:
      - $ref: "#/components/parameters/ProjectId"
      - name: snapshotId
        in: path
        required: true
        schema: { type: string, format: uuid }
    get:
      tags: [Crawler]
      summary: Snapshot detail — the evidence view behind recommendations and analysis
      responses:
        "200":
          description: Snapshot with extraction artifacts and quality detail
          content:
            application/json:
              schema: { $ref: "#/components/schemas/PageSnapshotDetail" }
        "404": { $ref: "#/components/responses/NotFound" }

  # ─────────────────────── Analysis ───────────────────────

  /projects/{projectId}/dashboard:
    parameters: [ { $ref: "#/components/parameters/ProjectId" } ]
    get:
      tags: [Analysis]
      summary: The single precomputed dashboard read (Redis-cached; never computes)
      responses:
        "200":
          description: Dashboard payload; empty-state flags when no crawl exists yet
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Dashboard" }
        "404": { $ref: "#/components/responses/NotFound" }

  /projects/{projectId}/crawls/{crawlId}/analysis:
    parameters:
      - $ref: "#/components/parameters/ProjectId"
      - $ref: "#/components/parameters/CrawlId"
    get:
      tags: [Analysis]
      summary: Full analysis for a crawl — exec summary, access check, retrievability, issues
      responses:
        "200":
          description: Analysis payload (fields null-flagged when degraded)
          content:
            application/json:
              schema: { $ref: "#/components/schemas/AnalysisReport" }
        "409":
          description: Crawl not yet completed
          content:
            application/problem+json:
              schema: { $ref: "#/components/schemas/Problem" }
        "404": { $ref: "#/components/responses/NotFound" }

  /projects/{projectId}/scores:
    parameters: [ { $ref: "#/components/parameters/ProjectId" } ]
    get:
      tags: [Analysis]
      summary: Score history for trend charts
      parameters:
        - name: from
          in: query
          schema: { type: string, format: date-time }
        - name: to
          in: query
          schema: { type: string, format: date-time }
        - $ref: "#/components/parameters/Cursor"
        - $ref: "#/components/parameters/Limit"
      responses:
        "200":
          description: Score points, oldest→newest within the window
          content:
            application/json:
              schema:
                type: object
                properties:
                  data:
                    type: array
                    items: { $ref: "#/components/schemas/Score" }
                  nextCursor: { type: ["string", "null"] }
        "404": { $ref: "#/components/responses/NotFound" }

  /projects/{projectId}/scores/latest:
    parameters: [ { $ref: "#/components/parameters/ProjectId" } ]
    get:
      tags: [Analysis]
      summary: Latest score with full component breakdown (the drawer)
      responses:
        "200":
          description: Latest score; 200 with null when no score exists yet
          content:
            application/json:
              schema: { $ref: "#/components/schemas/ScoreBreakdown" }
        "404": { $ref: "#/components/responses/NotFound" }

  /projects/{projectId}/topics:
    parameters: [ { $ref: "#/components/parameters/ProjectId" } ]
    get:
      tags: [Analysis]
      summary: Taxonomy (active + archived)
      responses:
        "200":
          description: Topics
          content:
            application/json:
              schema:
                type: object
                properties:
                  data:
                    type: array
                    items: { $ref: "#/components/schemas/Topic" }
        "404": { $ref: "#/components/responses/NotFound" }
    post:
      tags: [Analysis]
      summary: Add a custom topic
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [label]
              properties:
                label: { type: string, maxLength: 120 }
                description: { type: string, maxLength: 500 }
      responses:
        "201":
          description: Topic created (embedding computed async; coverage from next crawl)
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Topic" }
        "400":
          description: VALIDATION_FAILED / duplicate label
          content:
            application/problem+json:
              schema: { $ref: "#/components/schemas/Problem" }
        "404": { $ref: "#/components/responses/NotFound" }

  /projects/{projectId}/topics/{topicId}:
    parameters:
      - $ref: "#/components/parameters/ProjectId"
      - name: topicId
        in: path
        required: true
        schema: { type: string, format: uuid }
    patch:
      tags: [Analysis]
      summary: Edit label/description, reorder, or archive
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              minProperties: 1
              properties:
                label: { type: string, maxLength: 120 }
                description: { type: string, maxLength: 500 }
                position: { type: integer, minimum: 0 }
                status: { type: string, enum: [ACTIVE, ARCHIVED] }
      responses:
        "200":
          description: Updated topic
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Topic" }
        "400": { $ref: "#/components/responses/BadRequest" }
        "404": { $ref: "#/components/responses/NotFound" }

  /projects/{projectId}/topics/coverage:
    parameters: [ { $ref: "#/components/parameters/ProjectId" } ]
    get:
      tags: [Analysis]
      summary: Topic coverage — own vs competitor (latest completed crawls), gaps ranked
      responses:
        "200":
          description: Coverage rows; competitor columns null until it has a crawl
          content:
            application/json:
              schema:
                type: object
                properties:
                  ownCrawlId: { type: ["string", "null"], format: uuid }
                  competitorCrawlId: { type: ["string", "null"], format: uuid }
                  data:
                    type: array
                    items: { $ref: "#/components/schemas/TopicCoverage" }
        "404": { $ref: "#/components/responses/NotFound" }

  # ──────────────────── Recommendations ───────────────────

  /projects/{projectId}/recommendations:
    parameters: [ { $ref: "#/components/parameters/ProjectId" } ]
    get:
      tags: [Recommendations]
      summary: Recommendations, ranked by impact ÷ difficulty
      parameters:
        - name: status
          in: query
          schema: { type: string, enum: [OPEN, DONE, DISMISSED, VALIDATED, REGRESSED] }
        - name: priority
          in: query
          schema: { type: string, enum: [CRITICAL, HIGH, MEDIUM, LOW] }
        - $ref: "#/components/parameters/Cursor"
        - $ref: "#/components/parameters/Limit"
      responses:
        "200":
          description: Recommendations
          content:
            application/json:
              schema:
                type: object
                properties:
                  data:
                    type: array
                    items: { $ref: "#/components/schemas/Recommendation" }
                  nextCursor: { type: ["string", "null"] }
        "404": { $ref: "#/components/responses/NotFound" }

  /projects/{projectId}/recommendations/{recId}:
    parameters:
      - $ref: "#/components/parameters/ProjectId"
      - name: recId
        in: path
        required: true
        schema: { type: string, format: uuid }
    get:
      tags: [Recommendations]
      summary: Recommendation detail with expanded evidence links
      responses:
        "200":
          description: Recommendation
          content:
            application/json:
              schema: { $ref: "#/components/schemas/RecommendationDetail" }
        "404": { $ref: "#/components/responses/NotFound" }
    patch:
      tags: [Recommendations]
      summary: Transition status (OPEN→DONE, OPEN→DISMISSED, DONE/DISMISSED→OPEN)
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [status]
              properties:
                status: { type: string, enum: [OPEN, DONE, DISMISSED] }
      responses:
        "200":
          description: Updated (VALIDATED/REGRESSED are pipeline-set, not client-set)
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Recommendation" }
        "400":
          description: Illegal transition
          content:
            application/problem+json:
              schema: { $ref: "#/components/schemas/Problem" }
        "404": { $ref: "#/components/responses/NotFound" }

  # ───────────────────── Prompt Tracking ──────────────────

  /projects/{projectId}/prompts:
    parameters: [ { $ref: "#/components/parameters/ProjectId" } ]
    get:
      tags: [Prompt Tracking]
      summary: Tracked prompt templates
      parameters:
        - name: status
          in: query
          schema: { type: string, enum: [ACTIVE, ARCHIVED], default: ACTIVE }
      responses:
        "200":
          description: Prompt templates
          content:
            application/json:
              schema:
                type: object
                properties:
                  data:
                    type: array
                    items: { $ref: "#/components/schemas/PromptTemplate" }
        "404": { $ref: "#/components/responses/NotFound" }
    post:
      tags: [Prompt Tracking]
      summary: Add a prompt to track
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [text]
              properties:
                text: { type: string, minLength: 8, maxLength: 500 }
                intent: { type: string, maxLength: 40 }
                pinned: { type: boolean, default: false }
      responses:
        "201":
          description: Prompt created; included from the next run
          content:
            application/json:
              schema: { $ref: "#/components/schemas/PromptTemplate" }
        "400":
          description: VALIDATION_FAILED / duplicate active prompt
          content:
            application/problem+json:
              schema: { $ref: "#/components/schemas/Problem" }
        "403":
          description: PLAN_LIMIT_EXCEEDED (10 active prompts at MVP)
          content:
            application/problem+json:
              schema: { $ref: "#/components/schemas/Problem" }
        "404": { $ref: "#/components/responses/NotFound" }

  /projects/{projectId}/prompts/{promptId}:
    parameters:
      - $ref: "#/components/parameters/ProjectId"
      - name: promptId
        in: path
        required: true
        schema: { type: string, format: uuid }
    patch:
      tags: [Prompt Tracking]
      summary: Pin or archive a prompt. Text is immutable (see doc §4).
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              minProperties: 1
              properties:
                pinned: { type: boolean }
                status: { type: string, enum: [ACTIVE, ARCHIVED] }
                position: { type: integer, minimum: 0 }
      responses:
        "200":
          description: Updated
          content:
            application/json:
              schema: { $ref: "#/components/schemas/PromptTemplate" }
        "403":
          description: PROMPT_TEXT_IMMUTABLE (if `text` is sent)
          content:
            application/problem+json:
              schema: { $ref: "#/components/schemas/Problem" }
        "404": { $ref: "#/components/responses/NotFound" }

  # Planned, not implemented: deferred out of M21 (docs/Milestones.md). The implemented
  # trend is project-level: GET /projects/{projectId}/prompt-runs/trend.
  /projects/{projectId}/prompts/{promptId}/trend:
    parameters:
      - $ref: "#/components/parameters/ProjectId"
      - name: promptId
        in: path
        required: true
        schema: { type: string, format: uuid }
    get:
      tags: [Prompt Tracking]
      summary: Per-prompt mention/citation trend across runs (per engine)
      responses:
        "200":
          description: Trend points, oldest first
          content:
            application/json:
              schema:
                type: object
                properties:
                  data:
                    type: array
                    items: { $ref: "#/components/schemas/PromptTrendPoint" }
        "404": { $ref: "#/components/responses/NotFound" }

  /projects/{projectId}/prompt-runs:
    parameters: [ { $ref: "#/components/parameters/ProjectId" } ]
    post:
      tags: [Prompt Tracking]
      summary: Trigger an on-demand run across configured engines
      parameters: [ { $ref: "#/components/parameters/IdempotencyKey" } ]
      responses:
        "202":
          description: Run queued
          headers:
            Location: { schema: { type: string } }
          content:
            application/json:
              schema: { $ref: "#/components/schemas/PromptRun" }
        "409":
          description: PROMPT_RUN_ALREADY_ACTIVE or IDEMPOTENCY_KEY_REUSED
          content:
            application/problem+json:
              schema: { $ref: "#/components/schemas/Problem" }
        "403":
          description: PLAN_LIMIT_EXCEEDED (on-demand run quota)
          content:
            application/problem+json:
              schema: { $ref: "#/components/schemas/Problem" }
        "404": { $ref: "#/components/responses/NotFound" }
        "429": { $ref: "#/components/responses/TooManyRequests" }
    get:
      tags: [Prompt Tracking]
      summary: Run history
      parameters:
        - $ref: "#/components/parameters/Cursor"
        - $ref: "#/components/parameters/Limit"
      responses:
        "200":
          description: Runs, newest first
          content:
            application/json:
              schema:
                type: object
                properties:
                  data:
                    type: array
                    items: { $ref: "#/components/schemas/PromptRun" }
                  nextCursor: { type: ["string", "null"] }
        "404": { $ref: "#/components/responses/NotFound" }

  /projects/{projectId}/prompt-runs/trend:
    parameters: [ { $ref: "#/components/parameters/ProjectId" } ]
    get:
      tags: [Prompt Tracking]
      summary: Mention rate and citation share per run, overall and per engine, oldest first
      responses:
        "200":
          description: One point per run; a metric is null when that run could not measure it (never zero)
          content:
            application/json:
              schema:
                type: object
                properties:
                  data:
                    type: array
                    items: { $ref: "#/components/schemas/PromptRunTrendPoint" }
        "401": { $ref: "#/components/responses/Unauthorized" }
        "404": { $ref: "#/components/responses/NotFound" }

  /projects/{projectId}/prompt-runs/{runId}:
    parameters:
      - $ref: "#/components/parameters/ProjectId"
      - $ref: "#/components/parameters/RunId"
    get:
      tags: [Prompt Tracking]
      summary: Run detail — aggregate metrics, per-engine breakdown
      responses:
        "200":
          description: Prompt run
          content:
            application/json:
              schema: { $ref: "#/components/schemas/PromptRun" }
        "404": { $ref: "#/components/responses/NotFound" }

  /projects/{projectId}/prompt-runs/{runId}/results:
    parameters:
      - $ref: "#/components/parameters/ProjectId"
      - $ref: "#/components/parameters/RunId"
    get:
      tags: [Prompt Tracking]
      summary: Per-cell results (prompt × engine × sample) with answer excerpts
      parameters:
        - name: engine
          in: query
          schema: { type: string }
        - name: promptTemplateId
          in: query
          schema: { type: string, format: uuid }
        - $ref: "#/components/parameters/Cursor"
        - $ref: "#/components/parameters/Limit"
      responses:
        "200":
          description: Result cells
          content:
            application/json:
              schema:
                type: object
                properties:
                  data:
                    type: array
                    items: { $ref: "#/components/schemas/PromptResult" }
                  nextCursor: { type: ["string", "null"] }
        "404": { $ref: "#/components/responses/NotFound" }

  /projects/{projectId}/prompt-runs/{runId}/progress:
    parameters:
      - $ref: "#/components/parameters/ProjectId"
      - $ref: "#/components/parameters/RunId"
    get:
      tags: [Prompt Tracking]
      summary: SSE progress stream for an active run
      responses:
        "200":
          description: text/event-stream — `progress` {cellsDone, cellsTotal}, `done`, `error`
          content:
            text/event-stream:
              schema: { type: string }
        "404": { $ref: "#/components/responses/NotFound" }

  # ──────────────────────── Reports ───────────────────────

  /projects/{projectId}/reports:
    parameters: [ { $ref: "#/components/parameters/ProjectId" } ]
    post:
      tags: [Reports]
      summary: Generate a PDF report from the latest completed inputs
      parameters: [ { $ref: "#/components/parameters/IdempotencyKey" } ]
      requestBody:
        required: false
        content:
          application/json:
            schema:
              type: object
              properties:
                sections:
                  type: array
                  items:
                    type: string
                    enum: [summary, score, trends, recommendations, comparison]
                  description: Defaults to all sections
      responses:
        "202":
          description: Report queued
          headers:
            Location: { schema: { type: string } }
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Report" }
        "409":
          description: No completed crawl to report on / IDEMPOTENCY_KEY_REUSED
          content:
            application/problem+json:
              schema: { $ref: "#/components/schemas/Problem" }
        "404": { $ref: "#/components/responses/NotFound" }
        "429": { $ref: "#/components/responses/TooManyRequests" }
    get:
      tags: [Reports]
      summary: List reports
      parameters:
        - $ref: "#/components/parameters/Cursor"
        - $ref: "#/components/parameters/Limit"
      responses:
        "200":
          description: Reports, newest first
          content:
            application/json:
              schema:
                type: object
                properties:
                  data:
                    type: array
                    items: { $ref: "#/components/schemas/Report" }
                  nextCursor: { type: ["string", "null"] }
        "404": { $ref: "#/components/responses/NotFound" }

  /projects/{projectId}/reports/{reportId}:
    parameters:
      - $ref: "#/components/parameters/ProjectId"
      - name: reportId
        in: path
        required: true
        schema: { type: string, format: uuid }
    get:
      tags: [Reports]
      summary: Report status (poll after the 202)
      responses:
        "200":
          description: Report
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Report" }
        "404": { $ref: "#/components/responses/NotFound" }

  /projects/{projectId}/reports/{reportId}/download:
    parameters:
      - $ref: "#/components/parameters/ProjectId"
      - name: reportId
        in: path
        required: true
        schema: { type: string, format: uuid }
    get:
      tags: [Reports]
      summary: Redirect to a short-lived signed URL (API never proxies bytes)
      responses:
        "302":
          description: Redirect to signed R2 URL (valid ~5 minutes)
          headers:
            Location: { schema: { type: string, format: uri } }
        "409":
          description: REPORT_NOT_READY
          content:
            application/problem+json:
              schema: { $ref: "#/components/schemas/Problem" }
        "404": { $ref: "#/components/responses/NotFound" }

  # ──────────────────────── History ───────────────────────

  /projects/{projectId}/events:
    parameters: [ { $ref: "#/components/parameters/ProjectId" } ]
    get:
      tags: [History]
      summary: The "what changed" feed
      parameters:
        - name: kind
          in: query
          schema: { type: string }
          description: Filter (score_changed, citation_gained, citation_lost, pages_stale, crawl_completed, rec_validated, …)
        - $ref: "#/components/parameters/Cursor"
        - $ref: "#/components/parameters/Limit"
      responses:
        "200":
          description: Events, newest first
          content:
            application/json:
              schema:
                type: object
                properties:
                  data:
                    type: array
                    items: { $ref: "#/components/schemas/Event" }
                  nextCursor: { type: ["string", "null"] }
        "404": { $ref: "#/components/responses/NotFound" }

  # ──────────────────────── Billing ───────────────────────

  /billing/checkout:
    post:
      tags: [Billing]
      summary: Create a Stripe Checkout session for the PRO plan
      responses:
        "200":
          description: Checkout URL
          content:
            application/json:
              schema:
                type: object
                properties:
                  url: { type: string, format: uri }
        "401": { $ref: "#/components/responses/Unauthorized" }

  /billing/portal:
    post:
      tags: [Billing]
      summary: Create a Stripe customer-portal session (manage/cancel)
      responses:
        "200":
          description: Portal URL
          content:
            application/json:
              schema:
                type: object
                properties:
                  url: { type: string, format: uri }
        "401": { $ref: "#/components/responses/Unauthorized" }

  /webhooks/stripe:
    post:
      tags: [Billing]
      summary: Stripe webhook (signature-verified; not session-authenticated)
      security: []
      responses:
        "200": { description: Received }
        "400": { description: Bad signature }

components:
  securitySchemes:
    cookieAuth:
      type: apiKey
      in: cookie
      name: geolens.session

  parameters:
    ProjectId:
      name: projectId
      in: path
      required: true
      schema: { type: string, format: uuid }
    CrawlId:
      name: crawlId
      in: path
      required: true
      schema: { type: string, format: uuid }
    RunId:
      name: runId
      in: path
      required: true
      schema: { type: string, format: uuid }
    Cursor:
      name: cursor
      in: query
      schema: { type: string }
    Limit:
      name: limit
      in: query
      schema: { type: integer, minimum: 1, maximum: 100, default: 20 }
    IdempotencyKey:
      name: Idempotency-Key
      in: header
      required: true
      schema: { type: string, format: uuid }

  responses:
    BadRequest:
      description: VALIDATION_FAILED
      content:
        application/problem+json:
          schema: { $ref: "#/components/schemas/Problem" }
    Unauthorized:
      description: AUTH_REQUIRED
      content:
        application/problem+json:
          schema: { $ref: "#/components/schemas/Problem" }
    NotFound:
      description: NOT_FOUND (missing or not owned — indistinguishable by design)
      content:
        application/problem+json:
          schema: { $ref: "#/components/schemas/Problem" }
    TooManyRequests:
      description: RATE_LIMITED (Retry-After set)
      content:
        application/problem+json:
          schema: { $ref: "#/components/schemas/Problem" }

  schemas:
    Problem:
      type: object
      required: [title, status, code]
      properties:
        type: { type: string, format: uri }
        title: { type: string }
        status: { type: integer }
        code: { type: string }
        detail: { type: string }
        requestId: { type: string }
        errors:
          type: array
          items:
            type: object
            properties:
              path: { type: string }
              message: { type: string }

    SessionInfo:
      type: object
      properties:
        user:
          type: object
          properties:
            id: { type: string, format: uuid }
            email: { type: string, format: email }
            name: { type: ["string", "null"] }
        session:
          type: object
          properties:
            expiresAt: { type: string, format: date-time }

    Me:
      type: object
      properties:
        id: { type: string, format: uuid }
        email: { type: string, format: email }
        name: { type: ["string", "null"] }
        plan: { type: string, enum: [FREE, PRO] }
        usage:
          type: object
          description: Current usage vs plan limits
          properties:
            projects: { type: object, properties: { used: { type: integer }, limit: { type: integer } } }
            activePrompts: { type: object, properties: { used: { type: integer }, limit: { type: integer } } }
            onDemandRunsThisWeek: { type: object, properties: { used: { type: integer }, limit: { type: integer } } }

    Site:
      type: object
      properties:
        id: { type: string, format: uuid }
        url: { type: string, format: uri }
        domain: { type: string }
        role: { type: string, enum: [OWN, COMPETITOR] }
        name: { type: ["string", "null"] }

    Project:
      type: object
      properties:
        id: { type: string, format: uuid }
        name: { type: string }
        status: { type: string, enum: [ACTIVE, ARCHIVED] }
        timezone: { type: string }
        createdAt: { type: string, format: date-time }
        sites:
          type: array
          items: { $ref: "#/components/schemas/Site" }

    ProjectDetail:
      allOf:
        - $ref: "#/components/schemas/Project"
        - type: object
          properties:
            latestCrawl: { oneOf: [{ $ref: "#/components/schemas/Crawl" }, { type: "null" }] }
            latestScore: { oneOf: [{ $ref: "#/components/schemas/Score" }, { type: "null" }] }

    Crawl:
      type: object
      properties:
        id: { type: string, format: uuid }
        siteId: { type: string, format: uuid }
        status:
          type: string
          enum: [QUEUED, CRAWLING, ANALYZING, COMPLETED, COMPLETED_DEGRADED, FAILED, CANCELED]
        trigger: { type: string, enum: [MANUAL, SCHEDULED] }
        stats:
          type: object
          properties:
            pagesDiscovered: { type: integer }
            pagesCrawled: { type: integer }
            pagesChanged: { type: integer }
            pagesFailed: { type: integer }
        degradation:
          type: ["object", "null"]
          additionalProperties: true
          description: e.g. {"budget":true,"provider:gemini":true}
        errorReason: { type: ["string", "null"] }
        scoringConfigVersion: { type: ["string", "null"] }
        queuedAt: { type: string, format: date-time }
        startedAt: { type: ["string", "null"], format: date-time }
        finishedAt: { type: ["string", "null"], format: date-time }

    PageSnapshotSummary:
      type: object
      properties:
        id: { type: string, format: uuid }
        pageId: { type: string, format: uuid }
        url: { type: string, format: uri }
        title: { type: ["string", "null"] }
        httpStatus: { type: ["integer", "null"] }
        changed: { type: boolean }
        wordCount: { type: ["integer", "null"] }
        qualityScore: { type: ["integer", "null"], description: null = not in sampled set }
        fetchedAt: { type: string, format: date-time }

    PageSnapshotDetail:
      allOf:
        - $ref: "#/components/schemas/PageSnapshotSummary"
        - type: object
          properties:
            hasStructuredData: { type: boolean }
            internalLinkCount: { type: ["integer", "null"] }
            externalLinkCount: { type: ["integer", "null"] }
            extracted:
              type: object
              additionalProperties: true
              description: Heading outline, meta, schema.org payloads, alt coverage
            quality:
              type: ["object", "null"]
              additionalProperties: true
              description: Rubric detail behind qualityScore
            carriedForwardFromId: { type: ["string", "null"], format: uuid }

    Score:
      type: object
      properties:
        id: { type: string, format: uuid }
        composite: { type: integer, minimum: 0, maximum: 100 }
        scoreCitation: { type: ["integer", "null"] }
        scoreRetrievability: { type: ["integer", "null"] }
        scoreContentQuality: { type: ["integer", "null"] }
        scoreTopicCoverage: { type: ["integer", "null"] }
        scoreTechnical: { type: ["integer", "null"] }
        scoreTrust: { type: ["integer", "null"] }
        crawlId: { type: ["string", "null"], format: uuid }
        promptRunId: { type: ["string", "null"], format: uuid }
        scoringConfigVersion: { type: string }
        createdAt: { type: string, format: date-time }

    ScoreBreakdown:
      type: object
      properties:
        score: { oneOf: [{ $ref: "#/components/schemas/Score" }, { type: "null" }] }
        components:
          type: ["object", "null"]
          additionalProperties: true
          description: Per-component weight + evidence refs (breakdown drawer payload)

    Dashboard:
      type: object
      description: Precomputed at aggregate time; served from cache
      properties:
        hasCompletedCrawl: { type: boolean }
        latestScore: { oneOf: [{ $ref: "#/components/schemas/Score" }, { type: "null" }] }
        scoreTrend:
          type: array
          items:
            type: object
            properties:
              date: { type: string, format: date-time }
              composite: { type: integer }
        crawlStatus: { oneOf: [{ $ref: "#/components/schemas/Crawl" }, { type: "null" }] }
        indexedPages: { type: integer }
        recentPages:
          type: array
          items: { $ref: "#/components/schemas/PageSnapshotSummary" }
        topRecommendations:
          type: array
          items: { $ref: "#/components/schemas/Recommendation" }
        topMissingTopics:
          type: array
          items: { $ref: "#/components/schemas/TopicCoverage" }
        promptSummary:
          type: ["object", "null"]
          properties:
            mentionRate: { type: ["number", "null"] }
            citationShare: { type: ["number", "null"] }
            lastRunAt: { type: ["string", "null"], format: date-time }
        comparisonSummary:
          type: ["object", "null"]
          additionalProperties: true

    AnalysisReport:
      type: object
      properties:
        crawlId: { type: string, format: uuid }
        executiveSummary: { type: ["string", "null"] }
        strengths: { type: array, items: { type: string } }
        weaknesses: { type: array, items: { type: string } }
        accessCheck:
          type: object
          properties:
            bots:
              type: array
              items:
                type: object
                properties:
                  bot: { type: string, description: GPTBot, ClaudeBot, PerplexityBot, Google-Extended, CCBot, Bytespider }
                  allowed: { type: boolean }
                  blockedBy: { type: ["string", "null"], enum: [robots, cdn, null] }
                  fix: { type: ["string", "null"], description: Copy-paste remediation }
            llmsTxt:
              type: object
              properties:
                present: { type: boolean }
                valid: { type: ["boolean", "null"] }
        retrievability:
          # null when the simulation could not run (no taxonomy, no vectors, question
          # generation failed, or fewer than 70% of questions judged). The reason is
          # carried on `degradation`. M11.
          type: ["object", "null"]
          properties:
            score: { type: ["integer", "null"], minimum: 0, maximum: 100 }
            questionsTotal: { type: integer }
            questionsJudged: { type: integer }
            questionsAnswered: { type: integer }
            questionsPartial: { type: integer }
            questionsUnanswered: { type: integer }
            questions:
              type: array
              description: Per-question evidence — what was asked, the verdict, and the chunks it was judged on
              items:
                type: object
                properties:
                  question: { type: string }
                  topicLabel: { type: string }
                  answered:
                    type: ["string", "null"]
                    enum: [fully, partially, no, null]
                    description: null when the judge could not be reached for this question
                  confidence: { type: ["integer", "null"], minimum: 0, maximum: 100 }
                  missingElement: { type: ["string", "null"] }
                  chunkIds: { type: array, items: { type: string } }
        structuredDataHealth:
          type: ["object", "null"]
          additionalProperties: true
        technicalIssues:
          type: array
          items:
            type: object
            properties:
              key: { type: string }
              severity: { type: string, enum: [CRITICAL, HIGH, MEDIUM, LOW] }
              summary: { type: string }
        degradation:
          type: ["object", "null"]
          additionalProperties: true

    Topic:
      type: object
      properties:
        id: { type: string, format: uuid }
        label: { type: string }
        description: { type: ["string", "null"] }
        source: { type: string, enum: [GENERATED, USER] }
        status: { type: string, enum: [ACTIVE, ARCHIVED] }
        position: { type: integer }

    TopicCoverage:
      type: object
      properties:
        topicId: { type: string, format: uuid }
        label: { type: string }
        ownCoverage: { type: ["integer", "null"], minimum: 0, maximum: 100 }
        ownDepth: { type: ["integer", "null"] }
        competitorCoverage: { type: ["integer", "null"] }
        gap: { type: ["integer", "null"], description: competitorCoverage - ownCoverage }
        missing: { type: boolean, description: Strong for competitor, absent for you }

    Recommendation:
      type: object
      properties:
        id: { type: string, format: uuid }
        title: { type: string }
        source: { type: string, enum: [RULE, AI] }
        priority: { type: string, enum: [CRITICAL, HIGH, MEDIUM, LOW] }
        impact: { type: integer, minimum: 1, maximum: 5 }
        difficulty: { type: integer, minimum: 1, maximum: 5 }
        status: { type: string, enum: [OPEN, DONE, DISMISSED, VALIDATED, REGRESSED] }
        firstSeenAt: { type: string, format: date-time }
        updatedAt: { type: string, format: date-time }

    RecommendationDetail:
      allOf:
        - $ref: "#/components/schemas/Recommendation"
        - type: object
          properties:
            body: { type: string }
            ruleKey: { type: ["string", "null"] }
            evidence:
              type: object
              description: Snapshot/prompt-result/check references, resolvable via their endpoints
              properties:
                snapshots:
                  type: array
                  items: { type: string, format: uuid }
                promptResults:
                  type: array
                  items: { type: string }
                checks:
                  type: array
                  items: { type: string }

    PromptTemplate:
      type: object
      properties:
        id: { type: string, format: uuid }
        text: { type: string }
        intent: { type: ["string", "null"] }
        source: { type: string, enum: [GENERATED, USER] }
        pinned: { type: boolean }
        status: { type: string, enum: [ACTIVE, ARCHIVED] }
        position: { type: integer }

    PromptRun:
      type: object
      properties:
        id: { type: string, format: uuid }
        status:
          type: string
          enum: [QUEUED, RUNNING, COMPLETED, COMPLETED_DEGRADED, FAILED]
        trigger: { type: string, enum: [MANUAL, SCHEDULED] }
        engines:
          type: array
          items: { type: string }
        mentionRate: { type: ["number", "null"], description: 0–100 }
        citationShare: { type: ["number", "null"], description: 0–100 }
        metrics:
          type: ["object", "null"]
          additionalProperties: true
          description: Per-engine breakdown + share of voice vs competitor
        startedAt: { type: ["string", "null"], format: date-time }
        finishedAt: { type: ["string", "null"], format: date-time }
        createdAt: { type: string, format: date-time }

    PromptResult:
      type: object
      properties:
        id: { type: string, description: bigint, string-encoded }
        promptTemplateId: { type: string, format: uuid }
        engine: { type: string }
        sampleIndex: { type: integer }
        brandMentioned: { type: boolean }
        brandCited: { type: boolean }
        mentionPosition: { type: ["integer", "null"] }
        sentiment: { type: ["string", "null"], enum: [POSITIVE, NEUTRAL, NEGATIVE, null] }
        competitorsMentioned:
          type: ["array", "null"]
          items:
            type: object
            properties:
              name: { type: string }
              cited: { type: boolean }
        citations:
          type: ["array", "null"]
          items: { type: string, format: uri }
        answerText: { type: ["string", "null"] }
        model: { type: string }
        error: { type: ["string", "null"] }

    PromptRunTrendPoint:
      type: object
      properties:
        runId: { type: string, format: uuid }
        at: { type: string, format: date-time }
        mentionRate: { type: ["number", "null"] }
        citationShare: { type: ["number", "null"] }
        perEngine:
          type: array
          items:
            type: object
            properties:
              engine: { type: string }
              mentionRate: { type: ["number", "null"] }
              citationShare: { type: ["number", "null"] }

    PromptTrendPoint:
      description: For the planned per-prompt trend endpoint (not implemented yet).
      type: object
      properties:
        runId: { type: string, format: uuid }
        createdAt: { type: string, format: date-time }
        engine: { type: string }
        mentioned: { type: boolean }
        cited: { type: boolean }

    Comparison:
      type: object
      properties:
        own:
          type: object
          properties:
            siteId: { type: string, format: uuid }
            crawlId: { type: ["string", "null"], format: uuid }
            metrics: { $ref: "#/components/schemas/ComparisonMetrics" }
        competitor:
          type: ["object", "null"]
          properties:
            siteId: { type: string, format: uuid }
            crawlId: { type: ["string", "null"], format: uuid }
            metrics: { $ref: "#/components/schemas/ComparisonMetrics" }
        shareOfVoice:
          type: ["object", "null"]
          additionalProperties: true
          description: From the latest prompt run — per-engine own vs competitor mention/citation shares
        missingTopics:
          type: array
          items: { $ref: "#/components/schemas/TopicCoverage" }

    ComparisonMetrics:
      type: object
      properties:
        aiVisibility: { type: ["integer", "null"] }
        topicCoverage: { type: ["integer", "null"] }
        authority: { type: ["integer", "null"] }
        contentFreshness: { type: ["integer", "null"] }
        pageCount: { type: ["integer", "null"] }
        blogCoverage: { type: ["integer", "null"] }
        trustSignals: { type: ["integer", "null"] }

    Report:
      type: object
      properties:
        id: { type: string, format: uuid }
        kind: { type: string, enum: [ON_DEMAND, SCHEDULED] }
        status: { type: string, enum: [QUEUED, GENERATING, READY, FAILED] }
        crawlId: { type: ["string", "null"], format: uuid }
        promptRunId: { type: ["string", "null"], format: uuid }
        sizeBytes: { type: ["integer", "null"] }
        generatedAt: { type: ["string", "null"], format: date-time }
        createdAt: { type: string, format: date-time }

    Event:
      type: object
      properties:
        id: { type: string, description: bigint, string-encoded }
        kind: { type: string }
        payload:
          type: object
          additionalProperties: true
        crawlId: { type: ["string", "null"], format: uuid }
        promptRunId: { type: ["string", "null"], format: uuid }
        createdAt: { type: string, format: date-time }
```

---

## 4. Deliberate Decisions Worth Defending

1. **Prompt text is immutable.** Editing a tracked prompt's wording would silently corrupt its trend line — last month's "mention rate" would refer to a different question. Changing a prompt = archive + create. The API enforces this with `403 PROMPT_TEXT_IMMUTABLE`; the schema doc's `Restrict` FK on results is the same decision one layer down.
2. **`404` for not-owned resources.** Returning `403` on someone else's projectId confirms the resource exists. Ownership failures and true misses are deliberately indistinguishable.
3. **`202 + Location + SSE`, never long-polling POSTs.** The three pipeline triggers return immediately with the resource; the connection that watches progress is a separate, resumable, read-only stream. A dropped connection can never lose a crawl.
4. **Idempotency-Key required (not optional) on job triggers.** Double-clicks and mobile retries are the common case, not the edge case. Optional idempotency is idempotency that isn't there when it matters.
5. **`403 + PLAN_LIMIT_EXCEEDED` instead of `402`.** 402's semantics are payment-transaction failures; entitlement ceilings are authorization outcomes. The stable `code` is what the UI upgrade-prompt switches on.
6. **Comparison and coverage are server-computed reads.** The client never joins two crawls or diffs topic tables — "latest own vs latest competitor" logic lives once, in `app/`, not in every frontend.
7. **Download is a `302` to a signed URL.** The API never proxies PDF bytes; R2 does the serving, the API does the authorizing — consistent with the storage design.
8. **VALIDATED/REGRESSED are pipeline-owned statuses.** Clients may set DONE/DISMISSED/OPEN; only the next crawl's validation pass may claim a fix actually worked. The API is where that honesty is enforced.

---