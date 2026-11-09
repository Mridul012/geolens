# ADR 0004 — Persist `topics.buyer_intent`

**Status:** Accepted (M12)
**Deviates from:** `docs/Database.md` §2.10, whose `topics` table has no intent column.
**Required by:** `docs/AI-Pipeline.md` §3.4 — "`score_topic_coverage` = mean
`coverage_score` across active topics, **weighted 2× for `decision`-intent topics** (v1)".

## Context

Two source documents disagree.

The AI pipeline defines the topic-coverage component score as an intent-weighted mean:
a decision-stage topic (pricing, security, migration, integration) counts double, because
a buyer at the decision stage is worth more than one at the awareness stage. The taxonomy
prompt already produces the intent — `TaxonomyOutput.topics[].buyerIntent` is one of
`awareness | consideration | decision`, validated by `contracts/ai/taxonomy.ts`, and M9
has been generating it since the component shipped.

The schema doc's `topics` table has no column for it, so M9 discarded the value on write.
Without it the M12 formula cannot be implemented as specified, and every project's
topic-coverage score would be a plain mean — silently, with nothing in the codebase
recording that a documented weight had been dropped.

Three options were considered:

1. **Weight every topic equally and document the deviation.** Rejected. It changes what a
   published score means, for the convenience of not running a migration, and the
   difference is invisible to anyone reading the score later.
2. **Recover the intent at scoring time by re-asking a model.** Rejected: a paid call to
   recompute a value we already had, and it would not be stable across runs — directly
   against the ±3-point stability requirement (§5.3).
3. **Add the column.** Chosen.

## Decision

Add `topics.buyer_intent buyer_intent null`, with a Postgres enum matching the taxonomy
contract's three values.

Nullable, deliberately:

- Topics the **user** adds have no intent. The API's `POST /topics` body (`docs/API.md` §3)
  takes a label and a description and nothing else, and inventing a stage on their behalf
  would be a guess presented as data.
- Topics generated **before this migration** have none either, and backfilling them would
  mean re-deriving intent for taxonomies that may since have been edited.

`domain/scoring/` therefore treats a null intent as the base weight — the same treatment
`awareness` and `consideration` get. Only an explicit `decision` doubles. That keeps the
formula honest for the rows that carry the data and neutral for the rows that do not.

## Consequences

- `generate-taxonomy` now persists `buyerIntent` instead of discarding it. Existing
  generated topics keep a null intent until their project's taxonomy is regenerated.
- The enum is named `buyer_intent` and its values match `contracts/ai/taxonomy.ts` exactly;
  the contract stays the single definition of the vocabulary.
- The column is written, never queried on its own, and is not indexed: it is read as part
  of the topic row during scoring, which already loads every active topic.
- Topic coverage scores computed before M12 used an unweighted mean. They are not
  recomputed — `scoring_config_version` on each `scores` row is what makes the difference
  interpretable rather than mysterious.
