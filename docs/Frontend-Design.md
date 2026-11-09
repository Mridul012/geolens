# Vryse Lite — Frontend Design Spec

**Status:** Visual direction locked via mockup canvas (Claude Design). Next.js build not yet started.
**Pairs with:** docs/API.md (data contract), docs/PRD.md (personas/journey), docs/Engineering-Rules.md §8 (frontend stack).

---

## 1. Positioning

Vryse Lite is Ahrefs/Semrush, but for what AI engines say about you. It tells a business
whether ChatGPT, Perplexity, and similar engines mention or cite them when buyers ask
relevant questions, whether those engines can actually access and understand their content,
and exactly what to fix. Every screen should read as **evidence-first**: a score or claim is
never shown without a way to see the real crawl snapshot, real AI answer text, or real check
result behind it.

## 2. Two decisions resolved this session

### 2.1 "Claude design" = the built-in Claude Design canvas, not an external tool

The mockups for this spec were produced with Claude Code's own `design` skill (multi-artboard
canvas, published as an Artifact) — not exported anywhere and not a text prompt handed to a
third-party tool. Treat the canvas as the source of visual truth; this document is the
written record of what it encodes.

### 2.2 Frontend talks to the existing Fastify API over HTTP — it does not replace it

docs/Backend.md's original architecture diagram called for a single Next.js process serving
both UI and API via Route Handlers, explicitly rejecting a separate Fastify server ("extra
hop, no gain yet"). The last 20 milestones built exactly that rejected shape instead: a
complete, tested, standalone Fastify API under `src/http/`.

This is a real conflict between the docs and what was actually built. Raised with the
project owner directly rather than resolved silently (per Engineering-Rules §15.1): **the
decision is to keep the Fastify API as-is and build Next.js as a separate frontend app that
calls it over HTTP**, with the session cookie Better Auth already issues carried cross-origin
via `credentials: "include"`.

This was already anticipated in the codebase, just never acted on:
- `.env.example` has both `API_BASE_URL=http://localhost:3000` (the Fastify API) and
  `APP_BASE_URL=http://localhost:3001` (reserved for the web app) as distinct origins.
- `container.ts` already builds its CORS allow-list as
  `[env.APP_BASE_URL, ...env.CORS_ORIGINS]` — the web app's origin is always trusted.

So the Next.js app should run on port 3001 in local dev, call `API_BASE_URL` for every
request, and rely on the Fastify server's existing CORS + cookie configuration. No backend
change is required to start the frontend build.

## 3. Visual direction

Claude.ai-inspired, made concrete — deliberately **not** generic-SaaS (no default shadcn
slate/zinc theme, no bootstrap blue, no dark-mode-first design):

- **Base:** warm neutral/cream background, not stark white.
- **Accent:** one confident, warm accent (coral/terracotta family) used sparingly — CTAs,
  active states, the score's positive-trend color — never spread across the whole UI.
- **Space:** generous whitespace, calm density even on data-heavy screens (dashboard,
  prompt-tracking evidence).
- **Shape:** soft, large corner radii on cards and inputs.
- **Depth:** restrained shadows — soft, low-contrast elevation, not heavy drop shadows.
- **Type:** a clean sans with a clear hierarchy (large confident numerals for scores, calm
  body text for evidence/answer text).

## 4. Animation direction

"Very cool, little animations" — subtle, never gratuitous or slow:

- Entrance/stagger animation on cards and list rows as a screen loads.
- The composite score (and other headline numbers) **count up** rather than snapping to
  their value.
- Skeleton → loaded transition on every data fetch (TanStack Query's `isPending` state).
- Hover micro-interactions on interactive cards (slight lift/scale, not full trigger).
- Real implementation lands in the Next.js build via Framer Motion; the mockup canvas
  encodes intent as annotations, not live motion.

## 5. Component sourcing

- **Base primitives** — shadcn/ui: button, card, tabs, table, dialog, sheet, skeleton,
  badge, dropdown, toast. Matches the locked stack (Engineering-Rules §8) exactly.
- **Higher-polish / animated pieces** — 21st.dev, a shadcn/Tailwind-compatible component
  marketplace. Installs through the same `npx shadcn add <url>` CLI flow shadcn itself uses,
  so anything picked drops into `web/components/` as ordinary editable React/Tailwind code —
  never an opaque embed or a separate design system to reconcile later. Good candidates:
  animated stat/counter components (score), animated card grids (recommendations,
  dashboard), polished nav/sidebar patterns.

## 6. Screen inventory (build/priority order)

Every shape below is the *actual* response schema from docs/API.md's OpenAPI spec — not
invented placeholder data.

1. **Auth** — sign in / sign up. Better Auth: email+password and Google OAuth
   (`POST /auth/sign-up/email`, `POST /auth/sign-in/email`, `POST /auth/sign-in/social`).

2. **Project switcher / create project** — `POST /projects { name, url, competitorUrl?,
   timezone? }` → `Project { id, name, status, timezone, createdAt, sites[] }`, where each
   `Site` has `{ id, url, domain, role: OWN|COMPETITOR, name }`.

3. **Dashboard** — the single most important screen; first thing a returning user sees.
   `GET /projects/{id}/dashboard` → `Dashboard`:
   - `hasCompletedCrawl: boolean`
   - `latestScore`: nullable `Score { composite (0-100), scoreCitation, scoreRetrievability,
     scoreContentQuality, scoreTopicCoverage, scoreTechnical, scoreTrust }` — all six
     sub-scores independently nullable.
   - `scoreTrend[]`: `{ date, composite }` — the trend sparkline.
   - `crawlStatus`: nullable `Crawl` with a 7-state enum (`QUEUED, CRAWLING, ANALYZING,
     COMPLETED, COMPLETED_DEGRADED, FAILED, CANCELED`) and a freeform `degradation` object,
     e.g. `{"budget":true,"provider:gemini":true}` — surfaced as a banner, never hidden.
   - `indexedPages: integer`, `recentPages: PageSnapshotSummary[]`.
   - `topRecommendations: Recommendation[]`, `topMissingTopics: TopicCoverage[]`.
   - `promptSummary`: nullable `{ mentionRate, citationShare, lastRunAt }`.
   - `comparisonSummary`: freeform object.

4. **AI Crawler Access panel** — PRD's "aha moment #1"; give it its own prominent artboard,
   don't bury it in a generic analysis screen. From `AnalysisReport.accessCheck`:
   - `bots[]`: one row per `GPTBot / ClaudeBot / PerplexityBot / Google-Extended / CCBot /
     Bytespider` with `allowed: boolean`, `blockedBy: robots|cdn|null`, and copy-paste
     `fix: string|null` remediation text.
   - `llmsTxt: { present, valid }`.

5. **Crawl detail / page list / snapshot evidence** — `Crawl.stats { pagesDiscovered,
   pagesCrawled, pagesChanged, pagesFailed }`; `PageSnapshotSummary[] { title, httpStatus,
   qualityScore (nullable), changed, wordCount }`; snapshot detail adds `extracted` (heading
   outline, meta, schema.org) and the `quality` rubric behind `qualityScore`.

6. **Topics & coverage** — `TopicCoverage[] { label, ownCoverage, ownDepth,
   competitorCoverage, gap, missing }`. `competitorCoverage`/`gap` are null until the
   competitor has its own completed crawl — do not render as zero. `missing: true` marks a
   topic strong for the competitor and absent for the user; this drives the gap-ranked table.

7. **Prompt tracking** — PRD's "aha moment #2." `PromptTemplate[] { text, intent, pinned }`;
   `PromptRun { mentionRate, citationShare, metrics (per-engine) }`; per-cell
   `PromptResult { engine, sampleIndex, brandMentioned, brandCited, sentiment,
   competitorsMentioned[] {name, cited}, citations[], answerText }`. The evidence viewer
   shows the real `answerText` with brand/competitor mentions and citation URLs highlighted
   inline — this is the product's credibility moment, never paraphrase it away.

8. **Competitor comparison** — `Comparison { own, competitor }`, each `{ siteId, crawlId,
   metrics: ComparisonMetrics }` where `ComparisonMetrics = { aiVisibility, topicCoverage,
   authority, contentFreshness, pageCount, blogCoverage }` (all nullable); plus
   `shareOfVoice` (per-engine own vs. competitor) and `missingTopics[]`.

9. **Recommendations** — `Recommendation { title, priority: CRITICAL|HIGH|MEDIUM|LOW,
   impact (1-5), difficulty (1-5), status }`. `OPEN/DONE/DISMISSED` are user-set (PATCH);
   `VALIDATED/REGRESSED` are pipeline-only — render as visually distinct, non-interactive
   badges, never as a status the user can click into. Detail view adds `body` and `evidence`
   (snapshot/prompt-result/check references).

10. **Reports** — list with `status`, generate button, download via 302 redirect to a
    short-lived signed URL.

11. **Billing / plan / usage** — `Me { plan: FREE|PRO, usage: { projects, activePrompts,
    onDemandRunsThisWeek } }`, each usage field `{ used, limit }`; upgrade CTA for FREE.

## 7. A recurring rule every screen must encode

**Null is not zero.** `retrievability`, `competitorCoverage`, `latestScore` and its
sub-scores, and `promptSummary` are all legitimately `null` — "not yet measured" or "no
crawl/competitor yet" — as distinct from a real, low, measured value. Every screen needs one
consistent "not yet available" visual treatment (used throughout the mockup canvas) that
never looks like "measured and it's bad."
