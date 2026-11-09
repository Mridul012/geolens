# ADR 0003 — Store the analysis artifact as `crawls.analysis` JSONB

**Status:** Accepted (M8)
**Deviates from:** `docs/Database.md` §2, which defines no home for the payload
`GET /crawls/{id}/analysis` returns.

## Context

The API contract defines `AnalysisReport` (`docs/API.md` §3): executive summary, strengths
and weaknesses, the AI-crawler `accessCheck` block, retrievability metrics, structured-data
health, and technical issues. The schema doc defines no table or column that holds it.

The pieces arrive across five milestones — access check in M8, retrievability in M11,
executive summary and technical/trust in M12 — so whatever holds it must accept partial
writes and evolve without a migration each time.

Three options were considered:

1. **Assemble at read time** from `page_snapshots`, `topic_coverage` and `scores`. Rejected:
   it contradicts the architecture's central read rule — analysis reads serve precomputed
   rows, and the dashboard never computes (`docs/Backend.md` §4, Engineering-Rules §13).
   It would also make the read cost grow with page count.
2. **A dedicated `crawl_analyses` table** with a column per field. Rejected: every one of
   the five milestones would add columns to it, and most fields are never queried or
   aggregated — only rendered.
3. **A JSONB column on `crawls`.** Chosen.

## Decision

Add `crawls.analysis jsonb null`.

This follows the schema doc's own JSONB policy (§1.3): "anything queried, filtered,
aggregated, or charted gets a real column; anything that is evolving payload … is JSONB."
The analysis artifact is rendered, never aggregated. Nothing in it is filtered on, and the
numbers that *are* charted — component scores — already live as real columns on `scores`.

`crawls` is the right owner: the schema doc calls it "the snapshot anchor for everything
derived" (§2.6), and it already carries a `degradation` JSONB for exactly this kind of
evolving payload.

Each pipeline stage merges its own block into the object rather than overwriting it, so a
degraded stage leaves the others intact — the partial-answer guarantee in
`docs/AI-Pipeline.md` §9 depends on that.

## Consequences

- **Positive:** the analysis read is one indexed row fetch, no joins, no computation.
- **Positive:** M11 and M12 add their blocks without a migration.
- **Positive:** partial results survive a degraded stage, which is the documented behaviour.
- **Negative:** the payload is not queryable. Accepted — nothing needs to query it, and the
  moment something does, that field earns a real column per §1.3.
- **Negative:** merge-on-write means two stages finishing simultaneously could race. The
  fan-in runs stages sequentially within one aggregate job, so this does not arise today;
  if that changes, the merge moves into a transaction with a row lock.
