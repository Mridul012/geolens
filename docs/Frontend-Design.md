# GEOlens — Frontend Design Spec

**Status:** Built (web/). Visual direction **revised 2026-11-09** by the project owner: the original
cream/terracotta direction read as a generic AI-generated look and is replaced by the "Optician"
direction in §3–§4.
**Pairs with:** docs/API.md (data contract), docs/PRD.md (personas/journey), docs/Engineering-Rules.md §8 (frontend stack).

---

## 1. Positioning

GEOlens is Ahrefs/Semrush, but for what AI engines say about you. It tells a business
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

So the Next.js app runs on port 3005 in local dev (3001 is the browser worker's health port), calls `API_BASE_URL` for every
request, and rely on the Fastify server's existing CORS + cookie configuration. No backend
change is required to start the frontend build.

## 3. Visual direction — "Optician"

GEOlens is a lens: it measures how clearly AI engines can *see* a business. The design takes
its vocabulary from the optician's room — the eye chart, the duochrome test, focus — rather
than from SaaS-dashboard defaults. The original cream/terracotta direction (and the dark
acid-green, broadsheet and gradient alternatives considered on 2026-11-09) were rejected
because each is a recognisable AI-generated default rather than a choice made for this product.

**Palette** (light only; tokens in `web/src/app/globals.css`):

| Name | Hex | Role |
|---|---|---|
| Wall | `#EEF0EC` | Page background — the cool grey of an exam-room wall, never cream |
| Chart white | `#FFFFFF` | Panels: the test card the content sits on |
| Ink | `#000000` | Text, primary buttons, the active nav row — true black, never tinted |
| Graphite | `#585D59` | Secondary text (≥ 5.5:1 on both wall and chart white) |
| Coating violet | `#4A2FF5` | The one interactive accent: links, focus rings, selected state |
| Duochrome red / green | `#D6001C` / `#007A38` | The brand mark and status — always paired with an icon or word, never colour alone |

**Type:** Atkinson Hyperlegible Next for everything — designed by the Braille Institute for
low-vision readers, because legibility *is* this product's subject. Atkinson Hyperlegible Mono
only for things the user copies (robots.txt fixes, URLs in evidence), never for labels.
Scale is a perfect fourth from 16px (12 · 14 · 16 · 21 · 28 · 37 · 50 · 67 · 89); headings at
800 weight with slight negative tracking; body at 400 with 1.55 line height and ≤ 75ch lines.

**The one bold thing — focus.** Optical blur encodes visibility, and it is the only decorative
effect in the system:
- The dashboard opens on the project's own domain set huge, rendered as out of focus as AI
  engines find it (blur scales with 100 − composite score). Improving the score literally
  sharpens your name.
- **Null is not zero (§7) has one treatment everywhere:** an unmeasured value is rendered out
  of focus (`.out-of-focus`) with plain words beside it, never as `0` or a bare dash.
- The sign-in screen is an eye chart: rows of letters shrinking and blurring line by line.

**The dashboard is an eye exam** (chosen 2026-11-09 from three live prototypes — The Lens,
The Eye Exam, Through the Lens). It reads top to bottom as one chart. The chart's title is the
site's own domain, blurred by its score, with the composite beside it. Below it, five acuity
lines, each a question set smaller than the one before and numbered by acuity because they
are a real sequence:

| Acuity | Question | Answers it with |
|---|---|---|
| 20/200 | Can AI reach you? | Access check per bot, llms.txt/robots.txt, technical score |
| 20/100 | Can it read you? | Retrievability verdict, retrievability/quality/coverage scores, missing topics, link to the page lens |
| 20/50 | Does it cite you? | Mention rate and citation share, citation score, one real AI answer as evidence |
| 20/30 | What to fix first | The ranked recommendations |
| 20/20 | The fine print | Pages indexed, trust score, score trend, competitor, links out |

These are the PRD's three questions in the order a buyer's visibility actually breaks down.
Every number the panel dashboard showed still appears, on the line it answers. On very wide
screens an acuity ladder on the right edge tracks the line being read.

**Through the lens — the page-evidence view.** On Crawl detail, one crawled page at a time is
shown as AI engines find it: **sharp only if an AI answer in the latest prompt run cited
that exact page**, otherwise blurred as its content-quality score drops, and blurriest when it
was never scored. A lens the user drags (or moves with arrow keys) shows the page as written;
its rim is engraved with the evidence (cited or not, quality, word count). Blur is per page —
the data does not support per-paragraph claims, so none are made.

**Layout:** no sidebar rail. Every project page has a white top bar (wordmark, project
switcher, account) and a row of text tabs whose active tab carries a 3px ink underline;
content sits in a centered column (max 1200px). Under the tabs, every page except the
dashboard shows the **focus strip**: the site's own domain at 28px, blurred by its score,
with the score beside it, so the number being improved is always in view. On the dashboard
the full-size hero replaces it. Phones get the same structure: the tab row scrolls sideways.
Hero type steps down for long domains and only breaks after `.` and `-`.

**Structure:** panels are chart-white with a hairline border and **no shadow**; radius follows
hierarchy (panels 10px, inputs 6px, buttons fully round like a lens). Section labels are
sentence case in ink, not tracked-out grey capitals. No `→` glued to button text, no
middle-dot meta strings, no numbered markers unless the content is a sequence (acuity lines
on the eye chart are one).

## 4. Animation direction

Motion is rare and means something:
- **One orchestrated moment per screen:** on the dashboard the domain pulls into focus from
  12px of blur to its measured sharpness (≈1.2s). Nothing else animates on load — no
  staggered card entrances.
- **Reading, not loading:** each eye-exam line's question sharpens once (500ms) as it first
  reaches the middle of the screen, and never blurs again. It answers the user's scroll, so it
  is not a load animation.
- Animated blur stays under 20px everywhere (it is one of the costlier things to animate).
- Motion that answers an action is welcome: a toggle sliding, a panel expanding, a toast.
- `prefers-reduced-motion` skips the focus pull and shows the final state.
- Implemented with CSS transitions/keyframes — no animation library is needed.

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
