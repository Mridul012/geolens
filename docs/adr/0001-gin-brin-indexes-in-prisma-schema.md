# ADR 0001 — Declare GIN/BRIN indexes in `schema.prisma`, not in the SQL-only layer

**Status:** Accepted (M2)
**Deviates from:** `docs/Database.md` §1.10 and §5, which list GIN/BRIN among the
"SQL-only features" that live exclusively in hand-edited migrations.

## Context

`docs/Database.md` §5 places five categories of object in a hand-appended SQL block:
extensions, partial unique indexes, expression unique indexes, CHECK constraints, and the
GIN/BRIN search and time-series indexes. The stated rationale is that Prisma's schema
language cannot express them, and that keeping them inside migration history keeps the
shadow-database diff clean.

That holds for four of the five. It does not hold for GIN/BRIN. Prisma models index access
methods natively (`@@index([...], type: Gin | Brin)`), including on an
`Unsupported("tsvector")` column. Because Prisma *can* represent them, it also diffs them:
with the three indexes present only in raw SQL, the very next `prisma migrate dev` produced
a migration whose entire content was

```sql
DROP INDEX "ai_usage_created_brin";
DROP INDEX "chunks_tsv_gin";
DROP INDEX "events_created_brin";
```

— silently deleting the FTS index the retrievability pipeline depends on. The acceptance
criterion "CI runs migrations against the shadow DB without drift" (M2) is unachievable
while they are SQL-only.

## Decision

Declare the three indexes in `prisma/schema.prisma`:

- `chunks` → `@@index([tsv], type: Gin)`
- `ai_usage` → `@@index([createdAt], type: Brin)`
- `events` → `@@index([createdAt], type: Brin)`

and remove them from the hand-appended SQL block, leaving a comment there pointing here.
The SQL-only layer keeps exactly what Prisma genuinely cannot express: the three partial
unique indexes, the two expression uniques, and the four CHECK constraints.

The deferred HNSW index on `chunks.embedding` stays commented out in the migration, per
`docs/Database.md` §1 — retrieval is always scoped to one crawl, so an exact scan over
~3k rows is the right call at MVP.

## Consequences

- **Positive:** `migrate dev` and the shadow-DB diff are stable; the physical schema
  matches the declared schema; the index that serves `ts_rank_cd` cannot be dropped by an
  unrelated migration.
- **Positive:** the indexes are visible to anyone reading the schema, next to the columns
  they serve.
- **Negative:** `docs/Database.md` §5's SQL block is no longer copy-pasteable verbatim.
  The migration comments and this ADR record why.
- **Neutral:** the emitted DDL is identical (`USING GIN`, `USING BRIN`); only the source of
  truth moved.
