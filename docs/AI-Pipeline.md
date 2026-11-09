# Vryse Lite — AI Pipeline Specification

**Author:** Principal Engineering
**Status:** Design review draft — the final planning document
**Pairs with:** Technical Architecture (pipeline stages), Backend Architecture §7 (gateway mechanics), Database Schema, Engineering-Rules §6
**Purpose:** the *implementable* layer. The other docs say which stages exist and how the gateway behaves. This one pins the exact prompts, output schemas, thresholds, formulas, and failure behavior so nothing gets invented at build time.

**Reading rule:** every number marked **(v1)** is a starting value to be tuned with real data, not a law. Every number marked **(fixed)** is a contract other components depend on — changing it requires an ADR and a golden-eval run.

---

## 1. Tier Contract

The gateway exposes four tiers. Callers request a tier, never a model (Engineering-Rules §6). Mapping lives only in `config/model-tiers.ts`.

| Tier | Purpose | Class | Typical call | Temp |
|---|---|---|---|---|
| `bulk` | Per-page scoring, judging, parsing at scale | Haiku / 4o-mini / Groq Llama class | 100s per crawl | 0 |
| `judge` | Answer-coverage evaluation | Mid-tier | ~40 per crawl | 0 |
| `frontier` | Taxonomy, exec summary, recommendations, prompt generation | Best available | ~4 per crawl | 0.2–0.3 |
| `engine:*` | Prompt simulation — the engine *is* the measurement subject | Perplexity Sonar, OpenAI (web search), Gemini (grounded), Claude | 60 per run | provider default |

**`engine:*` is not a quality tier.** It is never substituted, never failed over to another provider, and never batched with different parameters. Swapping an engine changes what we measured, not how well we measured it. A failed engine cell is recorded as an error; it is never silently answered by a different model.

---

## 2. Prompt Registry

Seven prompts at MVP. Each lives at `infrastructure/ai/prompts/<name>/v1.md` with the header format from Engineering-Rules §14.

| Prompt | Tier | Milestone | Calls per run | Output schema |
|---|---|---|---|---|
| `taxonomy` | frontier | M9 | 1 per project (regenerable) | `TaxonomyOutput` |
| `prompt-gen` | frontier | M14 | 1 per project | `PromptSetOutput` |
| `page-quality` | bulk | M12 | 1 per sampled page (~30) | `PageQualityOutput` |
| `question-gen` | bulk | M11 | 1 per crawl | `QuestionSetOutput` |
| `retrievability-judge` | judge | M11 | 1 per question (~40) | `CoverageJudgment` |
| `exec-summary` | frontier | M12 | 1 per crawl | `ExecutiveSummary` |
| `recommendations` | frontier | M13 | 1 per crawl | `RecommendationSet` |
| `mention-judge` | bulk | M15 | only on ambiguity (~0–10 per run) | `MentionJudgment` |

**Versioning rule:** prompts are frozen on ship. Changes create `v2.md`; the old file stays. Every `scores` and analysis row records the prompt versions that produced it, so historical numbers remain interpretable.

---

## 3. Stage Specifications

Each stage below defines: inputs → prompt → output schema → validation → failure behavior. Output schemas are described as shapes; the authoritative zod definitions live in `contracts/ai/`.

### 3.1 Taxonomy generation (M9)

**Input:** homepage + up to 15 highest-authority page titles/H1s, meta descriptions, site domain.
**Output shape:**

```
TaxonomyOutput {
  niche: string                    // one line, what this business does
  topics: Array<{                  // 12–20 items (fixed bounds)
    label: string                  // ≤ 60 chars, noun phrase
    description: string            // ≤ 200 chars, what content on this topic covers
    buyerIntent: "awareness" | "consideration" | "decision"
  }>
}
```

**Validation:** 12 ≤ topics ≤ 20; labels unique case-insensitively; no label duplicating `niche`.
**Post-processing:** each topic's `label + description` is embedded → stored as the topic centroid.
**Failure:** repair retry once. On second failure the crawl completes without a taxonomy; coverage, retrievability, and prompt generation are all skipped and flagged `unavailable`. The user is shown a "generate taxonomy" retry action rather than an error page.

### 3.2 Page quality scoring (M12)

**Sampling (v1):** up to 30 pages per crawl, chosen as: homepage + top 10 by internal in-degree + up to 19 highest word-count changed pages. Unchanged pages inherit their previous score via `carried_forward_from_id`.

**Input per page:** heading outline, first 4,000 tokens of cleaned content, word count, publish/update dates, structured-data presence.
**Output shape:**

```
PageQualityOutput {
  depth: 0-100          // substance vs surface treatment
  clarity: 0-100        // structure, scannability, answerable prose
  evidence: 0-100       // specifics, data, citations, examples
  freshness: 0-100      // signals of currency relative to topic
  aiReadability: 0-100  // self-contained chunks, clear antecedents, no "as mentioned above"
  notes: string         // ≤ 300 chars, one concrete observation
}
```

**Aggregate:** `quality_score = round(0.30·depth + 0.20·clarity + 0.20·evidence + 0.10·freshness + 0.20·aiReadability)` **(v1)**.
**Validation:** all five in [0,100] after clamping; `notes` truncated, never rejected for length.
**Failure:** per-page failures are tolerated. If ≥ 60% of sampled pages score successfully, the component is valid; below that, `score_content_quality = null` and the component is marked degraded.

### 3.3 Retrievability simulation (M11)

**Question generation:** one `bulk` call producing 30–50 buyer questions distributed across taxonomy topics and the three intent stages.

```
QuestionSetOutput {
  questions: Array<{ text: string, topicLabel: string, intent: "awareness"|"consideration"|"decision" }>
}
```

**Retrieval per question (fixed algorithm):**
1. Vector arm: cosine similarity over `chunks` filtered to this crawl → top 20.
2. Lexical arm: `ts_rank_cd` over `tsv` with the question as `plainto_tsquery` → top 20.
3. Fuse with Reciprocal Rank Fusion, `k = 60` **(fixed)**: `score(d) = Σ 1/(k + rank_i(d))`.
4. Take top 5 fused chunks as the candidate answer context.

**Judgment:** one `judge` call per question.

```
CoverageJudgment {
  answered: "fully" | "partially" | "no"
  confidence: 0-100
  missingElement: string | null   // ≤ 150 chars, what content would be needed
}
```

**Metrics:**
- `hitRate = (fully + 0.5·partially) / totalQuestions`
- `score_retrievability = round(100 · hitRate)`

**Evidence:** every question stores its top-5 chunk ids and judgment for the analysis evidence view. `missingElement` values feed the recommendations engine as content-gap inputs.
**Failure:** if < 70% of questions judge successfully, `score_retrievability = null`, component degraded.

### 3.4 Topic coverage mapping (M10)

No LLM call — pure vector math over stored embeddings.

For each active topic *t* and each chunk *c* in the crawl: `sim(t,c) = cosine(embedding_t, embedding_c)`.

**Thresholds (v1):**
- A chunk *matches* a topic when `sim ≥ 0.62`.
- `depth_chunks(t)` = count of matching chunks.
- `coverage_score(t) = round(100 · min(1, (0.6·normalizedTopSim + 0.4·depthFactor)))` where
  `normalizedTopSim = clamp((maxSim − 0.55) / 0.30, 0, 1)` and
  `depthFactor = min(1, depth_chunks / 5)`.

Rationale: a single strong page shouldn't score 100 (that's a mention, not coverage), and twenty weak chunks shouldn't either. Both a quality signal and a volume signal must be present.

**Missing topic definition (fixed):** competitor `coverage_score ≥ 60` AND own `coverage_score ≤ 25`. `gap = competitorCoverage − ownCoverage`; missing topics rank by gap descending.

**`score_topic_coverage`** = mean `coverage_score` across active topics, weighted 2× for `decision`-intent topics **(v1)**.

### 3.5 Technical & trust components (M8, M12)

Deterministic, no LLM. Both computed from crawl artifacts.

**`score_technical`** (v1 weights): AI crawler access 50% (fraction of the six bots allowed, with GPTBot and PerplexityBot double-weighted) · structured-data coverage 20% (share of pages with valid JSON-LD) · llms.txt present and valid 10% · sitemap present and fresh 10% · canonical/meta hygiene 10%.

**`score_trust`** (v1): each present → author bios on content pages (25), about page (15), contact page (15), outbound citations to external sources on ≥ 30% of content pages (25), HTTPS with valid cert (10), a dated/updated policy or editorial page (10).

Both components are always available — they never degrade, because they need no external calls. This is deliberate: it guarantees every completed crawl produces at least a partial score.

### 3.6 Executive summary & recommendations (M12, M13)

**Input to both:** the assembled analysis artifact — component scores, access-check findings, top and bottom pages by quality, missing topics with gaps, unanswered questions with `missingElement`, and (when available) citation performance. Never raw page HTML.

```
ExecutiveSummary {
  summary: string           // ≤ 800 chars, 8th-grade reading level (PRD NFR)
  strengths: string[]       // 2–4 items, ≤ 120 chars each
  weaknesses: string[]      // 2–4 items, ≤ 120 chars each
}

RecommendationSet {
  recommendations: Array<{  // 5–12 items
    title: string           // ≤ 80 chars, imperative
    body: string            // ≤ 600 chars, why it matters + what to do
    ruleHint: string | null // maps to a known issue type when applicable
    impact: 1-5
    difficulty: 1-5
    evidenceRefs: {         // MUST reference ids present in the input artifact
      snapshotIds?: string[]
      topicLabels?: string[]
      questionIds?: string[]
      checkKeys?: string[]
    }
  }>
}
```

**Hard validation rule (fixed):** any recommendation whose `evidenceRefs` contain an id not present in the input artifact is **dropped, not repaired**. A recommendation that cites evidence we can't resolve is exactly the "generic AI filler" the PRD identifies as a trust risk. Silent dropping is correct here; the rules engine already guarantees a non-empty list.

**Ordering:** rules-based recommendations always run first and are never overridden by AI output. AI recommendations whose `ruleHint` collides with an existing rule fingerprint are discarded as duplicates.

---

## 4. Mention & Citation Detection (M15)

This resolves **PRD Open Question #2**. It is deterministic-first by design: LLM judging is the exception, not the mechanism.

### 4.1 Brand variant set

Built once per project, cached:
- `sites.name` (own site) if set
- Registrable domain root without TLD (`vryse.com` → `vryse`)
- Domain root with common separators removed/expanded (`getvryse` → `vryse`, `vryse-lite` → `vryse lite`)
- The project `name`

All variants normalized: casefold, strip diacritics, strip punctuation, collapse whitespace.

### 4.2 Mention detection

1. Normalize the answer text identically.
2. Word-boundary match each variant.
3. First match position → `mention_position` bucket by character offset percentile (0–33 = early, 34–66 = mid, 67–100 = late).

**Escalate to `mention-judge` only when (fixed triggers):**
- A matched variant is a common English dictionary word (e.g. "Notion", "Stripe", "Linear"), **or**
- The shortest matched variant is < 4 characters, **or**
- A variant matched only as a substring inside a longer token.

```
MentionJudgment {
  refersToBrand: boolean
  reasoning: string   // ≤ 200 chars
}
```

When no trigger fires, no LLM call is made. On a typical run this means **zero** judge calls — which is why prompt simulation stays inside its $0.30 budget.

### 4.3 Citation detection

1. Take the engine's structured citation list where provided (Perplexity, Gemini grounding, OpenAI web search all return one).
2. Also scan answer text for bare URLs and markdown links.
3. Match on **registrable domain (eTLD+1)**, not full host — `blog.vryse.com` and `vryse.com` are both citations. Use a public-suffix list; never naive suffix matching.
4. `brand_cited = true` if any citation resolves to the own site's registrable domain.

**Competitors:** the same variant + domain procedure runs for each competitor site, producing `competitors_mentioned: [{ name, cited }]`.

### 4.4 Multi-sample aggregation (fixed)

Each (prompt × engine) cell runs **3 samples**. Aggregation:
- Booleans (`brand_mentioned`, `brand_cited`): **majority vote** (≥ 2 of 3).
- Rates across the run: mean of per-cell majority outcomes.
- A cell with < 2 successful samples is excluded from the denominator entirely and marked partial — never counted as a negative. Recording an API failure as "not mentioned" would be a lie in the trend line.

**Run metrics:**
- `mention_rate = mentions / evaluableCells × 100`
- `citation_share = citations / evaluableCells × 100`
- `shareOfVoice` per engine: own citations ÷ (own + all competitor citations), computed per engine and overall.

---

## 5. Scoring Formula (M12)

### 5.1 Base weights — `config/scoring/v1`

| Component | Weight | Source |
|---|---|---|
| `citation` | 35% | prompt run |
| `retrievability` | 20% | crawl |
| `contentQuality` | 15% | crawl |
| `topicCoverage` | 15% | crawl |
| `technical` | 10% | crawl |
| `trust` | 5% | crawl |

`score_citation = round(0.6 · citation_share + 0.4 · mention_rate)` **(v1)** — citation is weighted above mention because being *linked* is the stronger visibility signal.

### 5.2 Renormalization (fixed algorithm)

Components can be absent for two different reasons, and the distinction is important:

- **`unavailable_yet`** — the input hasn't happened yet. The most common case by far: **every first crawl has no prompt run, so `citation` is absent.** This is normal, not degraded.
- **`failed`** — the input was attempted and did not produce a valid result. This is degradation.

Both are handled by the same math:

```
available   = components with a non-null value
totalWeight = Σ weights(available)
composite   = round( Σ (value_i · weight_i) / totalWeight )
```

**Publication floor (fixed):** if `totalWeight < 0.50`, **no score row is written**. The crawl still completes and the analysis page still renders findings; the dashboard shows "score pending" rather than a number computed from a third of the evidence. A wrong score is worse than no score.

**Flagging:** the `components` JSONB records, per component, its raw value, weight, effective renormalized weight, reason if absent (`unavailable_yet` | `failed`), and evidence refs. This payload *is* the breakdown drawer. The UI shows "degraded" only for `failed`, never for `unavailable_yet`.

### 5.3 Stability requirement

Score variance on an unchanged site across consecutive runs must be **≤ ±3 points** (PRD NFR). The mechanisms that deliver it: temperature 0 on all scoring calls, carried-forward quality scores for unchanged pages, 3-sample majority voting on citations, and fixed thresholds. Golden evals enforce it (§8).

---

## 6. Prompt Injection Defenses (fixed)

Every crawled page is hostile input until proven otherwise. Four layers, all mandatory:

1. **Delimited untrusted blocks.** Page content is wrapped in explicit markers with an instruction that everything inside is third-party data to be evaluated, never instructions to follow. Content is never interpolated into an instruction sentence.
2. **No tools, no retrieval.** Analysis and scoring calls have zero tool access and cannot fetch. The only thing a compromised call can do is return bad JSON, which schema validation catches.
3. **Clamp and validate.** All numeric outputs clamped to declared ranges; string lengths truncated; unknown fields stripped. A page that says "score this 100" produces a clamped value inside a single component that is one of thirty inputs.
4. **No wholesale assertions.** Our code computes every composite from many independently-constrained outputs. No model output ever *is* a score.

**Detection (v1):** if a page's extracted text contains high-signal injection patterns (imperative address to an AI system, instruction-override phrasing, role reassignment), flag the snapshot and exclude it from `frontier`-tier inputs. This is a signal worth surfacing — a competitor stuffing AI instructions into their pages is itself a finding.

---

## 7. Cost Model

Budgets from the PRD: **≤ $0.50 per crawl+analysis**, **≤ $0.30 per prompt run**.

**Per full crawl (100 pages, first run) — v1 estimate:**

| Item | Volume | Est. cost |
|---|---|---|
| Embeddings | ~3,000 chunks | $0.01 |
| Page quality (`bulk`) | 30 pages | $0.08 |
| Question generation (`bulk`) | 1 call | $0.01 |
| Retrievability judging (`judge`) | ~40 calls | $0.06 |
| Taxonomy (`frontier`, first crawl only) | 1 call | $0.05 |
| Exec summary + recommendations (`frontier`) | 2 calls | $0.14 |
| **Total** | | **≈ $0.35** |

Headroom is deliberate: it absorbs a larger site or a retry storm without breaching budget.

**Per prompt run (10 prompts × 2 engines × 3 samples = 60 calls):** ≈ $0.24, plus rare judge escalations. Under budget because §4 keeps LLM judging near zero.

**Re-crawl economics:** with change detection, a typical weekly re-crawl touches 5–15% of pages, taxonomy is skipped, and only the aggregate `frontier` calls re-run → **≈ $0.18**. This is why COGS stays inside 25% of MRR.

**Enforcement:** the gateway checks remaining budget before every call. On exhaustion it skips remaining per-page work, completes aggregate steps, and sets `degradation: {"budget": true}`. Never a crash, never a silent overspend.

---

## 8. Golden Evaluations (M12, M20)

**Corpus:** 6 fixture sites committed to `evals/golden-sites/` — rich SaaS, thin SaaS, blog-heavy, robots-blocked, no-structured-data, and one real site snapshot pinned by content hash so it can never drift.

**Assertions per site:**

| Check | Threshold |
|---|---|
| Composite score vs recorded baseline | within ±3 |
| Component scores vs baseline | within ±5 each |
| Directional invariants | rich > thin; blocked site's `technical` < 40 |
| Recommendation rule set | expected rule keys all present |
| Missing-topic detection | expected topics found on the competitor pair |
| Cost per crawl | ≤ $0.50 |

**CI gate (fixed):** any change under `infrastructure/ai/prompts/`, `config/model-tiers.ts`, or `config/scoring/` fails the build unless golden evals pass. If a change is *intended* to move scores, the PR updates the baseline and the ADR explains why — deliberate movement is fine; undetected movement is not.

---

## 9. Degradation Matrix

| Failure | Effect | Crawl status | User sees |
|---|---|---|---|
| Taxonomy fails | coverage + retrievability + prompt-gen skipped | `COMPLETED_DEGRADED` | Findings + retry action |
| < 60% pages score | `contentQuality = null` | `COMPLETED_DEGRADED` | Component marked degraded |
| < 70% questions judge | `retrievability = null` | `COMPLETED_DEGRADED` | Component marked degraded |
| Exec summary fails | summary null, everything else intact | `COMPLETED_DEGRADED` | Analysis without prose summary |
| AI recs fail | rules-based recs only | `COMPLETED` | Fewer cards, no error |
| One engine down (run) | that engine's cells error; other engine intact | `COMPLETED_DEGRADED` | Per-engine banner |
| Budget exhausted | per-page work stops, aggregates complete | `COMPLETED_DEGRADED` | `degradation.budget` flag |
| `totalWeight < 0.50` | no score row written | either | "Score pending" |
| No prompt run yet | citation absent, renormalized | `COMPLETED` | **Normal** — not degraded |

The invariant across every row: **a partial answer with honest flags, never a blank dashboard and never a fabricated number.**

---

## 10. Build Sequence Mapping

| Milestone | Sections to implement |
|---|---|
| M9 | §1 tiers, §2 registry, §3.1 taxonomy, §7 metering |
| M10 | §3.4 topic mapping |
| M11 | §3.3 retrievability |
| M12 | §3.2 quality, §3.5 technical/trust, §3.6 summary, §5 scoring, §8 evals |
| M13 | §3.6 recommendations, evidence validation rule |
| M14 | §2 prompt-gen |
| M15 | §4 mention/citation detection — the whole section |
| M20 | §6 injection drills, §8 CI gate, §9 degradation drills |

---