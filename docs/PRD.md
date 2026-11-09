# Vryse Lite — Product Requirements Document

**Version:** 1.0 (Draft)
**Owner:** CTO
**Status:** For review
**Last updated:** July 2026

---

## 1. Product Vision

Search behavior is shifting from ranked links to synthesized answers. When a buyer asks ChatGPT "what's the best tool for X" or Perplexity "how do I solve Y", the AI engine composes one answer from a handful of sources — and every business that isn't in that answer is invisible, regardless of how well it ranks on Google.

Today, businesses have zero instrumentation for this. They cannot answer three basic questions:

1. Do AI engines mention or cite us when buyers ask relevant questions?
2. Can AI systems even access and understand our content?
3. What specifically should we change to improve?

**Vision statement:** Vryse Lite is the analytics and optimization layer for AI search. We help businesses measure, understand, and improve how AI engines discover, retrieve, and cite their content.

**Positioning:** What Ahrefs and Semrush did for Google rankings, Vryse does for AI answers.

**Core product belief:** AI visibility is measurable, not a vibe. We measure it three ways — by running real buyer prompts against real AI engines (citation tracking), by simulating how RAG systems retrieve the site's content (retrievability), and by auditing technical access (crawler checks). Everything in the product flows from these measurements, and every score is transparent and evidence-linked. Black-box scores are how we lose trust; evidence is how we win it.

**Business model (summary):** Freemium SaaS. Free tier acts as the lead magnet (limited crawl + AI crawler access check). One paid tier at launch (~$29–49/mo range, final pricing TBD) unlocking full crawls, prompt tracking, competitor comparison, and reports.

---

## 2. Target Users

### Primary persona — SaaS Founder / Head of Growth ("Priya")
10–50 person B2B SaaS company. Owns pipeline. Already invests in SEO and content. Has heard "AI is eating search" and has no data on it.

- **Job to be done:** "Tell me whether buyers see us when they ask AI tools for solutions like ours — and what to fix if they don't."
- **Buying trigger:** A prospect mentions "ChatGPT recommended a competitor," or organic traffic dips with no ranking change.
- **Success looks like:** A number she can report to the board, and a monthly fix-list her team can execute.

### Secondary persona — SEO / Content Agency ("Marcus")
Runs 5–20 client accounts. Needs to sell a new line item ("AI visibility audit") and prove ongoing value with reports.

- **Job to be done:** "Give me client-ready reports and a repeatable audit I can charge for."
- **Success looks like:** A PDF he can send to a client with his recommendations attached, and month-over-month trend lines.

### Tertiary persona — In-house Content Marketer ("Ana")
Executes the content roadmap. Not technical. Drowning in generic AI advice.

- **Job to be done:** "Tell me exactly which topics to write and which pages to fix, in priority order."

### Explicitly not targeting at MVP
Enterprise brands (procurement cycles, SSO, security reviews), local/offline businesses, e-commerce catalogs with 10,000+ SKUs, and developers wanting API access. These are V2+ decisions, not accidents.

---

## 3. User Stories

Stories are grouped by epic. P0 stories carry acceptance criteria (AC).

### Epic A — Onboarding & Projects
- **A1 (P0):** As a founder, I want to create a project by pasting my website URL so setup takes under a minute.
  *AC: URL validated and normalized; project created; crawl start offered immediately; total time to first crawl start < 60 seconds.*
- **A2 (P0):** As a user, I want to add one competitor URL during setup so comparison data is ready after my first crawl.
  *AC: Competitor is crawled with the same pipeline; comparison page populated after both crawls complete.*
- **A3 (P0):** As a returning user, I want to switch projects from the top navigation without losing context.

### Epic B — Crawl Experience
- **B1 (P0):** As a user, I want to watch live crawl progress — pages discovered, current page, friendly stage messages — so the wait feels transparent rather than broken.
  *AC: Progress updates stream in near-real-time; stage messages match the design spec ("Analyzing content structure…", "Evaluating AI discoverability…"); estimated time remaining shown.*
- **B2 (P0):** As a user, I want an email and in-app notification when analysis completes so I don't have to keep the tab open.
- **B3 (P1):** As a user, I want re-crawls to skip unchanged pages so they finish faster and my history shows what actually changed.

### Epic C — Visibility Measurement (Prompt Tracking)
- **C1 (P0):** As a founder, I want to see the actual questions buyers ask AI engines and whether my brand appears in the answers, so I know my real visibility instead of guessing.
  *AC: ≥10 auto-generated buyer-intent prompts; results across 2 engines; each cell shows mention status, citation status, and lets me read the answer excerpt.*
- **C2 (P0):** As a user, I want to edit, delete, and pin prompts so tracking matches the questions my actual buyers ask.
- **C3 (P0):** As a founder, I want a share-of-voice view against my competitor so I can see who AI engines prefer and by how much.

### Epic D — Score & Analysis
- **D1 (P0):** As a user, I want one AI Visibility Score with a transparent breakdown so I can explain it to my team and trust its movement.
  *AC: Clicking the score opens a breakdown of weighted components; every component links to its underlying evidence.*
- **D2 (P0):** As a user, I want to know if AI crawlers are blocked from my site, with exact fix instructions, because this silently zeroes out everything else.
  *AC: Per-bot green/red status (GPTBot, ClaudeBot, PerplexityBot, Google-Extended, CCBot, Bytespider); llms.txt detection; copy-paste fix snippet.*
- **D3 (P0):** As a marketer, I want to see topics my competitor covers that I don't, ranked by importance, so I know what to write next.
- **D4 (P0):** As a non-technical user, I want a plain-language executive summary of strengths and weaknesses so I understand my situation in two minutes.

### Epic E — Recommendations
- **E1 (P0):** As a content marketer, I want recommendations ranked by impact versus difficulty so I always know the single next best action.
- **E2 (P0):** As a skeptical user, I want every recommendation to show its evidence — the pages, prompts, or checks that triggered it — so I trust it isn't generic AI filler.
- **E3 (P1):** As a user, I want to mark recommendations done or dismissed, and see completed ones validated in the next crawl.

### Epic F — Reporting & History
- **F1 (P0):** As an agency, I want a clean downloadable PDF report — summary, score, trends, recommendations — that I can send to a client.
- **F2 (P0):** As a user, I want score history and a "what changed" feed so I can connect the actions I took to the outcomes I got.

---

## 4. Functional Requirements

Priorities: **P0** = MVP must-ship. **P1** = MVP if time allows, else fast-follow. **P2** = V2.

### FR-1: Accounts & Authentication
- 1.1 (P0) Email/password and Google OAuth sign-up and sign-in.
- 1.2 (P0) Single-user accounts at MVP.
- 1.3 (P2) Team seats, roles, and workspaces.

### FR-2: Projects
- 2.1 (P0) Create project with a root URL; validation and normalization (protocol, www, trailing slash).
- 2.2 (P0) Limits: 1 project on free tier, 3 on paid.
- 2.3 (P0) One competitor URL per project.
- 2.4 (P0) Delete project purges all derived data and snapshots.
- 2.5 (P2) Multiple competitors per project.

### FR-3: Crawling & Extraction
- 3.1 (P0) Page discovery via sitemap.xml with link-following fallback; JavaScript rendering supported.
- 3.2 (P0) Hard cap of 100 pages per crawl (25 on free tier); per-domain rate limiting; robots.txt honored.
- 3.3 (P0) Per-page extraction: title, meta description, heading outline, word count, publish/updated dates, schema.org structured data, canonical URL, internal/external links, image alt coverage.
- 3.4 (P0) Raw HTML snapshots retained per crawl for evidence and diffing.
- 3.5 (P0) Manual on-demand crawls.
- 3.6 (P1) Content-hash change detection; unchanged pages skipped on re-crawl.
- 3.7 (P1) Scheduled weekly re-crawls on paid tier.

### FR-4: AI Crawler Access Check
- 4.1 (P0) Parse robots.txt for major AI user agents and report allow/block per bot.
- 4.2 (P0) Detect llms.txt presence and validity.
- 4.3 (P0) Detect CDN/WAF-level bot blocking by comparing responses under AI-bot user agents.
- 4.4 (P0) Per-issue fix instructions with copy-paste snippets.

### FR-5: Topic & Content Analysis
- 5.1 (P0) Auto-generate a topic taxonomy for the project's niche; user can review and edit before it locks in.
- 5.2 (P0) Map site content to taxonomy; report coverage (which topics) and depth (how much, how good) per topic.
- 5.3 (P0) Missing-topics report versus competitor, ranked.
- 5.4 (P0) Content quality scoring against a fixed rubric on a representative sample of pages.
- 5.5 (P1) Quality scoring on all crawled pages.
- 5.6 (P1) Internal link graph: strongest pages, orphan pages, under-linked important topics.

### FR-6: Retrievability Simulation
- 6.1 (P0) Generate 30–50 synthetic buyer questions from the taxonomy.
- 6.2 (P0) Run retrieval over the site's own content the way an AI engine would, and measure whether the content can answer the questions.
- 6.3 (P0) Output a retrievability score with per-question pass/fail detail available as evidence.

### FR-7: Prompt Simulation & Citation Tracking
- 7.1 (P0) 10 tracked prompts per project across 2 AI engines, via official APIs with web search/grounding enabled.
- 7.2 (P0) Weekly scheduled runs plus one on-demand run per week on paid tier.
- 7.3 (P0) Per-answer parsing: brand mentioned, domain cited/linked, position in answer, competitors that appeared.
- 7.4 (P0) Metrics: mention rate, citation share, share of voice versus competitor; per-engine and overall.
- 7.5 (P0) Full answer text viewable as evidence for every result.
- 7.6 (P1) Sentiment of brand mentions.
- 7.7 (P2) 4+ engines, daily runs, larger prompt sets.

### FR-8: Scoring Engine
- 8.1 (P0) AI Visibility Score (0–100) as a weighted composite: citation & mention performance, retrievability, content quality, topic coverage, technical AI readiness, trust signals.
- 8.2 (P0) Score breakdown drawer showing every component, its weight, and links to evidence.
- 8.3 (P0) Scoring configuration is versioned; historical scores remain comparable and re-interpretable.
- 8.4 (P0) Sub-scores surfaced on the dashboard per the design spec (Website Health, Content Coverage, Authority, Trust Signals, AI Readiness).

### FR-9: Recommendations
- 9.1 (P0) Rules-based recommendations for deterministic issues (blocked bots, missing schema, no llms.txt, thin content, stale content, orphan pages).
- 9.2 (P0) AI-generated recommendations derived from analysis artifacts; every card has priority, estimated impact, difficulty, and concrete action steps.
- 9.3 (P0) Every recommendation links to its triggering evidence.
- 9.4 (P0) Ranking by impact ÷ difficulty; deduplication across crawls.
- 9.5 (P1) Mark done / dismiss; done items validated against the next crawl.

### FR-10: Competitor Comparison
- 10.1 (P0) Side-by-side comparison against one competitor: AI visibility, topic coverage, authority, content freshness, page count, blog coverage, trust signals.
- 10.2 (P0) Share-of-voice chart from prompt simulation results.
- 10.3 (P0) Missing-topics view integrated here.

### FR-11: Dashboard
- 11.1 (P0) KPI cards, trend chart, latest crawl status, recent recommendations, competitor summary, quick actions — per the design spec.
- 11.2 (P0) All dashboard data is precomputed; the dashboard never triggers analysis.
- 11.3 (P0) Skeleton loading states and designed empty states for every module.

### FR-12: Reports
- 12.1 (P0) Downloadable PDF: executive summary, score breakdown, trend charts, top recommendations, competitor summary.
- 12.2 (P1) Scheduled monthly report email.
- 12.3 (P2) White-label reports for agencies.

### FR-13: History & Trends
- 13.1 (P0) Every crawl and prompt run stored as an immutable snapshot.
- 13.2 (P0) Score deltas between snapshots with attributed causes ("citation share dropped on engine X", "3 pages went stale").
- 13.3 (P0) History page with a "what changed" feed.

### FR-14: Notifications
- 14.1 (P0) Email + in-app notification on crawl completion.
- 14.2 (P2) Alerts: score drop beyond threshold, lost citation, competitor movement.

### FR-15: Billing
- 15.1 (P0) Free and paid tiers with enforced usage limits (pages, prompts, projects, runs).
- 15.2 (P0) Self-serve checkout and cancellation (Stripe or Razorpay).

---

## 5. Non-Functional Requirements

### Performance
- Dashboard loads interactive in under 2 seconds (reads precomputed data only).
- Full crawl + analysis of 100 pages completes in under 15 minutes at p90.
- A prompt simulation run (10 prompts × 2 engines) completes in under 5 minutes.

### Reliability & Degradation
- 99.5% availability target for the app layer.
- Pipeline is degradable: if one AI provider is down, the run completes with partial results, a visible banner, and automatic retry — never a silent failure or a blank dashboard.
- Crawl job success rate ≥ 95%; all failures retried with backoff and surfaced with a human-readable reason.

### Unit Economics (treated as a hard requirement, not a wish)
- Variable cost per full crawl + analysis ≤ $0.50 at MVP scale.
- Variable cost per prompt simulation run ≤ $0.30.
- Total COGS ≤ 25% of subscription price at target usage. Enforced via model tiering, prompt caching, batch processing, change-detection, and a hard per-project cost budget with internal metering.

### Measurement Integrity
- Prompt simulation results are averaged over multiple samples per prompt to smooth LLM non-determinism; the product emphasizes trends over single data points.
- Score variance on an unchanged site between consecutive runs ≤ ±3 points.
- Scoring changes are versioned and announced in-product; scores are never silently redefined.

### Security & Privacy
- TLS everywhere; secrets in a managed store; tenant data isolation; standard OWASP protections and rate limiting.
- We crawl only publicly accessible pages. Never behind logins, never bypassing paywalls.
- Our crawler identifies itself with a documented user agent and honors robots.txt and opt-out requests.
- Project deletion purges derived data immediately and raw snapshots within 30 days.

### Scalability
- All heavy work runs on horizontally scalable queue workers. MVP infrastructure sized for 500 concurrently active projects without re-architecture.

### Usability & Accessibility
- Written for non-technical readers: executive summaries at roughly an 8th-grade reading level; jargon always accompanied by plain-language explanation.
- Responsive layouts; keyboard navigation and command palette; WCAG AA color contrast.

### Observability
- Every AI call traced with cost attribution per project; job success dashboards; alerting when failure rate exceeds 5% or per-project cost exceeds budget.

---

## 6. User Journey

### First-run journey (target: signup → first real insight in under 10 minutes)

1. **Sign up** with Google. No credit card.
2. **Create project** — paste URL, optionally add one competitor. Under a minute.
3. **Crawl starts immediately.** Live progress with friendly stage messages makes the pipeline feel alive and trustworthy rather than opaque.
4. **Aha moment #1 (often before the crawl finishes):** the AI Crawler Access panel lights up. A meaningful share of sites discover they've been blocking GPTBot or PerplexityBot without knowing. This alone justifies the signup.
5. **Analysis completes** → notification → Dashboard reveals the AI Visibility Score with its breakdown.
6. **Aha moment #2:** the Prompt Tracking page shows real AI answers to real buyer questions — and whether the brand appears in them. Seeing a competitor cited where you aren't is the moment this product becomes un-ignorable.
7. **User opens Recommendations**, sorted by impact ÷ difficulty, each with evidence. They know exactly what to do Monday morning.

### Recurring journey (the retention loop)

1. Weekly scheduled crawl + prompt run happens automatically.
2. User gets a digest: score movement, citation wins/losses, what changed.
3. User checks trends, actions one or two recommendations, marks them done.
4. Next run validates the fixes; the score moves; the user screenshots the trend chart for their team.

The retention loop depends on **change**: automated weekly runs exist precisely so there is always something new to come back to.

---

## 7. MVP Scope

### In scope (P0 set)
- Auth, projects (1 competitor), billing with free + one paid tier
- Crawl up to 100 pages with live progress, extraction, snapshots
- AI Crawler Access Check with fixes
- Topic taxonomy, coverage, missing topics vs one competitor
- Retrievability simulation
- Prompt simulation: 10 prompts × 2 engines, weekly + limited on-demand
- Transparent composite score with breakdown and history
- Rules + AI recommendations with evidence links
- Competitor comparison page with share of voice
- Dashboard per design spec, PDF report, history with "what changed"
- Email notification on crawl completion

### MVP constraints (deliberate)
- 100 pages/crawl, 1 competitor, 10 prompts, 2 engines, weekly cadence, English-language sites only.

### Out of scope for MVP (non-goals)
- Auto-fixing or auto-publishing content changes
- CMS integrations (WordPress, Webflow) and Google Search Console import
- More than 2 engines, daily tracking, sentiment analysis
- Multiple competitors, industry benchmarks
- Agency workspaces, white-label, team seats, public API
- Mobile apps, non-English content analysis

Cutting these is what makes the MVP shippable by a small team in one quarter.

---

## 8. V2 Scope

Ordered by expected impact:

1. **Tracking depth** — 4+ engines, daily runs, larger prompt sets, sentiment on mentions.
2. **Alerts** — score drops, lost citations, competitor movement. Turns the product from a dashboard into a guardian.
3. **Content brief generator** — one click turns a missing topic into an AI-optimized content brief. The natural upsell and the bridge from "measurement" to "action."
4. **Multi-competitor + benchmarks** — compare against 3–5 competitors; anonymized industry benchmark scores.
5. **Agency mode** — workspaces, client roles, white-label reports, portfolio dashboard.
6. **Integrations** — Google Search Console (correlate AI visibility with traditional search), CMS plugins for one-click fixes.
7. **Recommendation validation loop** — automatic before/after measurement for every completed recommendation, building our proprietary "what actually works" dataset.

---

## 9. Success Metrics

**North star: Weekly Active Projects** — projects whose owner viewed results of a crawl or prompt run that week. It captures delivered value, not logins.

| Metric | Definition | Target (90 days post-launch) |
|---|---|---|
| Activation rate | Signups completing first crawl within 24h | ≥ 60% |
| Aha rate | Activated users viewing prompt-tracking results in first session | ≥ 40% |
| Time to first insight | Signup → first crawler-check or score visible | ≤ 10 min (p75) |
| Week-4 retention | Activated users active in week 4 | ≥ 30% |
| Free → paid conversion | Within 30 days of activation | ≥ 4% |
| Recommendation adoption | Median recs marked done per active project per month | ≥ 2 |
| Score efficacy | Active (8+ week) projects showing score improvement | ≥ 50% |
| Crawl success rate | Crawl jobs completing without fatal error | ≥ 95% |
| COGS ratio | Variable AI/crawl cost as % of MRR | ≤ 25% |

Guardrail metric: support tickets disputing score accuracy per 100 active projects — if this climbs, our transparency and evidence-linking is failing, and it outranks growth work.

---

## 10. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| **LLM API costs break unit economics** | High | High | Model tiering, prompt caching, batch APIs, change-detection re-crawls, hard per-project cost budgets, cost metering from day one. Treated as an NFR, not an afterthought. |
| **API answers differ from consumer AI UIs** (fidelity gap) | High | Medium | Use official search-grounded APIs only; disclose methodology in-product; average multiple samples; emphasize trends over point values; periodically validate correlation against manual UI checks. |
| **Engines change behavior, pricing, or access terms** | Medium | High | Provider-agnostic abstraction layer; 2-engine MVP limits blast radius; official APIs only — never scraping consumer UIs, which is a ToS and reliability trap. |
| **Score credibility fails — users don't trust the number** | Medium | High | Transparent weighted breakdown, evidence links on every component and recommendation, versioned scoring, guardrail metric above. |
| **Prompt simulation noise misreads as signal** | Medium | Medium | Multi-sample averaging, confidence indicators, weekly cadence framing ("trend, not tick"). |
| **Crawling friction: blocked, throttled, or complained about** | Medium | Medium | Identified user agent with docs page, robots.txt compliance, conservative rate limits, opt-out honored same-day, public pages only. |
| **Incumbents (Semrush/Ahrefs) or AEO startups outrun us** | High | Medium | Speed and focus: SMB/agency wedge, evidence-first UX, free crawler-check as growth loop. We win on trust and time-to-insight, not feature count. |
| **Category is early — buyers don't know they need this** | Medium | Medium | Free AI Crawler Check as a standalone lead magnet; content marketing that publishes our own visibility research; agency channel educates clients for us. |
| **Generic AI recommendations erode trust** | Medium | High | Rules-first architecture; AI recs always grounded in this site's artifacts and evidence-linked; dedupe and quality review of rec templates. |
| **Small-team execution risk** | High | High | Ruthless P0 scope, one language/one codebase, buy-not-build for infra, weekly scope review against this document. |

---

## 11. Future Roadmap

### Now — Months 0–3: Prove the insight
Ship MVP to 10–15 design partners (founders and one or two agencies from our network). Obsess over activation and the two aha moments. Launch the free standalone AI Crawler Check as the top-of-funnel tool.

### Next — Months 3–6: Prove the habit
V2 tracking depth and alerts. Weekly digest tuned until week-4 retention clears 30%. First paid conversions at scale; pricing validated. Begin publishing "State of AI Visibility" content from aggregate data.

### Later — Months 6–12: Prove the action loop
Content brief generator and recommendation validation loop — close the measure → act → verify cycle inside the product. Agency mode and white-label reports open the multi-account revenue channel. GSC integration bridges traditional SEO teams into the category.

### Someday — Year 2+
Become the system of record for AI visibility: public API, benchmark datasets, CMS-level one-click fixes, and eventually optimization that executes with approval rather than just recommending. The long-term asset is the proprietary dataset linking content changes to citation outcomes — that's what nobody can copy quickly.

---

## 12. Open Questions

1. Which two engines launch first? Leading candidates: Perplexity (cleanest citation-grounded API) + one of OpenAI/Gemini. Decide on API stability and cost per call.
2. Brand-mention detection edge cases: common-word brand names, misspellings, and product-vs-company mentions. Needs a detection spec before FR-7 build.
3. Final price point and whether the free tier includes any prompt tracking at all (growth vs. cost tension).
4. Taxonomy quality for niche industries — do we need a human-in-the-loop review step at onboarding, or is edit-after-generation enough?
5. Report branding at MVP: fully unbranded PDF, or light Vryse branding as a growth channel?

---