# GEOlens — Technical Architecture & ML Pipeline

This section extends the product spec with the engineering and ML layer. Append it after the design sections.

---

## System Overview

Two workloads, cleanly separated:

• App layer — auth, projects, dashboards, CRUD (synchronous)

• Analysis pipeline — crawling, embeddings, LLM scoring, prompt simulation (async jobs on a queue)

Pipeline shape:

Crawl → Extract → Index → Analyze → Score → Recommend → Track over time

Every stage writes results to the database so the dashboard reads precomputed data — never runs analysis on page load.

---

## Stage 1 — Crawling & Extraction

• Crawlee + Playwright for crawling (handles JS-rendered sites, which basic fetchers miss)

• Discover pages via sitemap.xml, fall back to link-following

• Respect robots.txt, per-domain rate limits, page cap per plan tier (e.g. 100 pages on Lite)

• Boilerplate removal → clean main content with heading structure preserved

• Extract per page: title, meta description, heading outline, word count, publish/updated dates, schema.org JSON-LD, canonical URL, internal/external links, image alt coverage

• Store raw HTML snapshot in object storage (S3 / Cloudflare R2), cleaned text in Postgres

• Content hash per page — on re-crawls, skip unchanged pages entirely (saves embedding + LLM cost)

---

## Stage 2 — AI Crawler Access Check

The cheapest, highest-value feature in the product. Many sites unknowingly block AI crawlers at the robots.txt or CDN level, which makes them invisible to AI engines regardless of content quality.

• Parse robots.txt for AI user agents: GPTBot, ClaudeBot, PerplexityBot, Google-Extended, CCBot, Bytespider

• Check for llms.txt presence and validity

• Fetch key pages with AI-bot user agents and compare responses to detect CDN-level blocking

• Result feeds directly into AI Readiness Score and renders as a green/red panel per bot

This is the fastest "aha" moment in onboarding — a site can go from "why is our score low" to "we've been blocking GPTBot for a year" in one crawl.

---

## Stage 3 — Semantic Indexing

• Heading-aware chunking that mirrors how RAG systems ingest pages

• Embed chunks with a cheap embedding model (text-embedding-3-small class)

• Store vectors in Postgres + pgvector — one database for everything, no separate vector DB to operate

• Embedding cache keyed by content hash — only changed pages get re-embedded

---

## Stage 4 — Topic Coverage & Gap Analysis

• Generate a topic taxonomy for the project's niche with an LLM (user can review and edit it)

• Map every chunk to taxonomy topics via embedding similarity

• Coverage = which topics have strong matches; Depth = how many quality chunks per topic

• Run the same mapping on competitor crawls

• Missing Topics = topics where competitors score strongly and you have nothing

This powers the Topic Coverage map, Top Missing Topics, and half the Competitor Comparison page.

---

## Stage 5 — Retrievability Simulation (AI Readiness)

Simulate what an AI search engine actually does with the site's content:

• Generate 30–50 synthetic buyer questions from the taxonomy

• Run hybrid retrieval over the site's own chunks: BM25 + vector search, fused with Reciprocal Rank Fusion

• Metrics: hit rate (did any chunk answer the question), answer coverage (LLM-judged), retrieved chunk quality

The logic: if a site's content can't answer its own customers' questions when chunked and retrieved, AI engines won't cite it either. This turns AI Readiness Score into an actual measurement instead of a vibe.

---

## Stage 6 — Prompt Simulation & Citation Tracking

The core differentiator. Without this, "AI Visibility Score" is an estimate. With it, it's a measurement.

• Generate 10–20 high-intent prompts per project ("best X for Y teams", "how do I solve Z", "Brand vs Competitor")

• User can edit and pin prompts

• Run them on a schedule against real engines via API: OpenAI (web search enabled), Gemini (search grounding), Perplexity Sonar, Claude

• Parse each answer: brand mentioned? domain cited or linked? position in answer? sentiment? which competitors appeared?

• Metrics per engine and overall: Mention Rate, Citation Share, Share of Voice vs competitors

• Weekly scheduled runs feed trend charts; on-demand runs on paid tiers

---

## Scoring Engine

AI Visibility Score = a transparent weighted composite. Never a black box — clicking the score opens a breakdown drawer.

Starting weights (tune later with real data):

• Citation & mention performance (prompt simulation) — 35%

• Retrievability (RAG simulation) — 20%

• Content quality & depth (LLM-judged rubric) — 15%

• Topic coverage — 15%

• Technical AI readiness (crawler access, schema, llms.txt, page speed) — 10%

• Trust & authority signals (author bios, about/contact pages, outbound citations, HTTPS) — 5%

Rules:

• LLM-as-judge only for subjective components, always with a fixed rubric and structured JSON output

• Scoring config is versioned — historical scores stay comparable, and "why did my score change" is always answerable

---

## Recommendation Engine

Two layers, cheapest first:

• Layer 1 — deterministic rules: missing schema, blocked AI bots, no llms.txt, orphan pages, thin content, stale content, broken internal links. Instant, free, always correct.

• Layer 2 — LLM-generated recommendations from the analysis artifacts, constrained to JSON: title, why it matters, priority, estimated impact, difficulty, action steps

• Dedupe recommendations via embedding similarity

• Rank by impact ÷ difficulty

• Every recommendation card links to its evidence — the pages, prompts, or checks that triggered it

---

## Internal Linking & Authority Analysis

• Build the internal link graph from crawl data

• Compute in-degree and a simple PageRank pass to find the site's strongest pages

• Detect orphan pages (zero internal links pointing in)

• Flag important topics whose pages have weak internal authority

---

## Model Strategy & Cost Control

This is what keeps unit economics sane:

• Tiered models — cheap fast model (Groq Llama / Haiku / 4o-mini class) for per-page scoring at scale; frontier model only for the executive summary and top-10 recommendations

• Prompt caching — the site profile and rubric are shared context across hundreds of per-page calls; cache them

• Batch APIs for scheduled scoring runs (roughly half price)

• Content-hash diffing — only re-analyze pages that changed since last crawl

• Hard cost budget per crawl, tracked internally per project

---

## Infrastructure

• Frontend: Next.js + Tailwind + shadcn/ui + Recharts

• Backend: Node + TypeScript, single codebase (Next API routes or Fastify)

• Jobs: BullMQ + Redis — separate workers for crawl, analysis, and prompt simulation

• Database: Postgres + pgvector, Prisma

• Realtime crawl progress: SSE from a job-status endpoint streaming progress %, current URL, and the friendly stage messages from the design spec

• Object storage: S3 / Cloudflare R2 for HTML snapshots and generated reports

• Reports: server-rendered page → PDF via Playwright print

Keep it one language for MVP. Add a Python service later only if heavier clustering or RAGAS-style evaluation becomes worth the operational cost.

---

## Reliability & Quality

• Every LLM output validated against a zod schema; on failure, retry once with a repair prompt

• LLM call tracing (Langfuse or Helicone) for cost visibility and debugging

• Golden test set: 5–10 known sites re-scored on every prompt or model change to catch scoring drift

• Crawler politeness: per-domain concurrency limits, exponential backoff, honor 429s

---

## Trend & History

• Every crawl and every prompt run is an immutable snapshot

• Score deltas computed between snapshots with attributed causes: "Citation share dropped on Perplexity", "3 pages went stale", "Competitor added 12 pages on pricing topics"

• Powers trend charts, the growth timeline in reports, and the History page

---

## New UI Surfaces This Architecture Creates

Add these to the design spec:

• Prompt Tracking page — table of tracked prompts × engines, with mention/citation status chips per cell

• Share of Voice chart on the Competitor Comparison page

• AI Crawler Access panel — green/red status per bot, with fix instructions

• Score breakdown drawer — click any score to see its weighted components

• "What changed" feed on the History page

---

## MVP vs V2

MVP (Lite):

• Crawl + extraction + AI crawler access check

• Embeddings + topic coverage + missing topics (1 competitor)

• Retrievability simulation

• Rules-based + LLM recommendations

• Composite score, dashboard, PDF report

• Prompt simulation, scoped: 10 prompts, 2 engines, weekly runs — small, but present, because it is the product's core promise

V2:

• More engines, daily tracking, sentiment analysis on mentions

• Multiple competitors, industry benchmarks

• Alerts: score drops, lost citations, competitor movement

• Content brief generator for missing topics — the natural upsell

• Agency workspaces and multi-tenant reporting