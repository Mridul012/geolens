/**
 * The `chunks` table (docs/Database.md §2.9) — the semantic index.
 *
 * ── Raw SQL justification (Engineering-Rules §5, docs/Database.md §9) ─────────
 * `chunks.embedding` is `vector(1536)` and `chunks.tsv` is `tsvector`; both are
 * `Unsupported(...)` in the Prisma schema, so Prisma Client can neither write nor read
 * them. This module is the sanctioned escape hatch the schema doc names, and it is the
 * *only* place raw SQL touches chunks. Every value is bound as a parameter — nothing
 * derived from crawled content is ever interpolated into a statement.
 *
 * The two-phase write is deliberate: rows first with `embedding` null, then the vectors in
 * a second pass. A crashed embedding call therefore leaves recoverable rows rather than a
 * half-populated staging table, and the FTS arm of retrieval works before a single vector
 * exists.
 */
import type { Database } from "../prisma.js";

export interface NewChunk {
  readonly ordinal: number;
  readonly headingPath: string | null;
  readonly content: string;
  readonly tokenCount: number;
}

export interface StoredChunk {
  /** `bigint` in Postgres; carried as a string so it survives JSON without precision loss. */
  readonly id: string;
  readonly ordinal: number;
  readonly headingPath: string | null;
  readonly content: string;
}

export interface ChunkEmbedding {
  readonly id: string;
  readonly vector: readonly number[];
}

/** One arm's ranked hit. `score` is that arm's own metric, never compared across arms. */
export interface RankedChunk {
  readonly id: string;
  readonly score: number;
}

/** A chunk with enough context to be quoted as evidence. */
export interface ChunkContext {
  readonly id: string;
  readonly headingPath: string | null;
  readonly content: string;
  readonly url: string;
}

/** One topic's similarity profile against a crawl's corpus. */
export interface TopicMatchRow {
  readonly topicId: string;
  readonly maxSimilarity: number;
  readonly depthChunks: number;
  readonly evidenceChunkIds: readonly string[];
}

/** Postgres emits `1 - (a <=> b)` as a float that may sit a hair outside [-1, 1]. */
function clampSimilarity(value: number): number {
  return Math.min(1, Math.max(-1, value));
}

/** pgvector's text input format. */
function toVectorLiteral(vector: readonly number[]): string {
  return `[${vector.join(",")}]`;
}

export class ChunksRepo {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  /**
   * Replaces a snapshot's chunks with a freshly computed set.
   *
   * Delete-then-insert rather than upsert: a retried index job must be idempotent, and
   * re-chunking can legitimately produce a different number of rows than last time.
   */
  async replaceForSnapshot(
    crawlId: string,
    snapshotId: string,
    chunks: readonly NewChunk[],
  ): Promise<readonly StoredChunk[]> {
    return this.#db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`DELETE FROM chunks WHERE page_snapshot_id = $1::uuid`, snapshotId);
      if (chunks.length === 0) return [];

      const values: string[] = [];
      const params: unknown[] = [snapshotId, crawlId];
      for (const chunk of chunks) {
        const base = params.length;
        // `$n` for content is referenced twice — once as the column, once inside
        // to_tsvector — so the text is bound, never concatenated.
        values.push(
          `($1::uuid, $2::uuid, $${base + 1}::int, $${base + 2}, $${base + 3}, $${base + 4}::int, to_tsvector('english', $${base + 3}))`,
        );
        params.push(chunk.ordinal, chunk.headingPath, chunk.content, chunk.tokenCount);
      }

      const rows = await tx.$queryRawUnsafe<
        Array<{ id: bigint; ordinal: number; heading_path: string | null; content: string }>
      >(
        `INSERT INTO chunks (page_snapshot_id, crawl_id, ordinal, heading_path, content, token_count, tsv)
         VALUES ${values.join(", ")}
         RETURNING id, ordinal, heading_path, content`,
        ...params,
      );

      return rows.map((row) => ({
        id: row.id.toString(),
        ordinal: row.ordinal,
        headingPath: row.heading_path,
        content: row.content,
      }));
    });
  }

  /**
   * Copies an unchanged page's chunks forward into this crawl.
   *
   * This is what makes "unchanged pages cost zero embedding calls" true *and* leaves the
   * crawl with a complete corpus: retrieval and coverage filter on `crawl_id`, so a page
   * we skipped re-embedding must still be present under the new crawl. The vectors and the
   * tsvector come along unchanged — the content is byte-identical by definition, which is
   * precisely what change detection established (M7).
   */
  async carryForward(
    crawlId: string,
    targetSnapshotId: string,
    sourceSnapshotId: string,
  ): Promise<number> {
    return this.#db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `DELETE FROM chunks WHERE page_snapshot_id = $1::uuid`,
        targetSnapshotId,
      );
      return tx.$executeRawUnsafe(
        `INSERT INTO chunks (page_snapshot_id, crawl_id, ordinal, heading_path, content, token_count, embedding, tsv)
         SELECT $1::uuid, $2::uuid, ordinal, heading_path, content, token_count, embedding, tsv
         FROM chunks
         WHERE page_snapshot_id = $3::uuid
         ORDER BY ordinal`,
        targetSnapshotId,
        crawlId,
        sourceSnapshotId,
      );
    });
  }

  /** Writes the embedding batch — phase two of the two-phase write. */
  async setEmbeddings(embeddings: readonly ChunkEmbedding[]): Promise<number> {
    if (embeddings.length === 0) return 0;

    const values: string[] = [];
    const params: unknown[] = [];
    for (const embedding of embeddings) {
      const base = params.length;
      values.push(`($${base + 1}::bigint, $${base + 2}::vector)`);
      params.push(embedding.id, toVectorLiteral(embedding.vector));
    }

    return this.#db.$executeRawUnsafe(
      `UPDATE chunks AS c
       SET embedding = v.embedding
       FROM (VALUES ${values.join(", ")}) AS v(id, embedding)
       WHERE c.id = v.id`,
      ...params,
    );
  }

  async countForCrawl(crawlId: string): Promise<number> {
    const rows = await this.#db.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT count(*)::bigint AS count FROM chunks WHERE crawl_id = $1::uuid`,
      crawlId,
    );
    return Number(rows[0]?.count ?? 0n);
  }

  async countEmbeddedForCrawl(crawlId: string): Promise<number> {
    const rows = await this.#db.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT count(*)::bigint AS count FROM chunks WHERE crawl_id = $1::uuid AND embedding IS NOT NULL`,
      crawlId,
    );
    return Number(rows[0]?.count ?? 0n);
  }

  /**
   * The vector arm of hybrid retrieval (AI-Pipeline §3.3, step 1).
   *
   * Exact cosine over the crawl's own chunks. Scoped to one crawl, which is what keeps an
   * exact scan cheap and sidesteps filtered-ANN recall entirely (docs/Database.md §1).
   */
  async searchByVector(
    crawlId: string,
    vector: readonly number[],
    limit: number,
  ): Promise<readonly RankedChunk[]> {
    const rows = await this.#db.$queryRawUnsafe<Array<{ id: bigint; score: number }>>(
      `SELECT id, (1 - (embedding <=> $2::vector))::float8 AS score
       FROM chunks
       WHERE crawl_id = $1::uuid AND embedding IS NOT NULL
       ORDER BY embedding <=> $2::vector, id ASC
       LIMIT $3::int`,
      crawlId,
      toVectorLiteral(vector),
      limit,
    );
    return rows.map((row) => ({ id: row.id.toString(), score: clampSimilarity(Number(row.score)) }));
  }

  /**
   * The lexical arm (AI-Pipeline §3.3, step 2): `ts_rank_cd` over the stored tsvector.
   *
   * ── Documented deviation from the pipeline doc ────────────────────────────
   * The doc specifies "`ts_rank_cd` over `tsv` with the question as `plainto_tsquery`".
   * Taken literally that arm is dead weight: `plainto_tsquery` joins every term with AND,
   * so a twelve-word buyer question only matches a chunk containing *all twelve* stems.
   * On real prose that is almost never, the arm returns nothing, and the "hybrid"
   * retriever silently becomes vector-only.
   *
   * It also contradicts the doc's own choice of ranking function: `ts_rank_cd` measures
   * cover density across the *matched* terms, which only discriminates when candidates
   * match different subsets — that is, under OR.
   *
   * So the query is built by `plainto_tsquery` and then its `&` operators are swapped for
   * `|`. The rewrite happens after Postgres has already parsed the text into a `tsquery`,
   * so nothing user-supplied is being concatenated into SQL: the only thing changed is the
   * boolean operator between lexemes that Postgres itself produced. Stopword-only input
   * still yields an empty query that matches nothing, which RRF reads as an arm with no
   * opinion.
   *
   * Index: `GIN(tsv)`.
   */
  async searchByText(
    crawlId: string,
    query: string,
    limit: number,
  ): Promise<readonly RankedChunk[]> {
    const rows = await this.#db.$queryRawUnsafe<Array<{ id: bigint; score: number }>>(
      `WITH q AS (
         SELECT replace(plainto_tsquery('english', $2)::text, '&', '|')::tsquery AS query
       )
       SELECT c.id, ts_rank_cd(c.tsv, q.query)::float8 AS score
       FROM chunks c, q
       WHERE c.crawl_id = $1::uuid AND c.tsv @@ q.query
       ORDER BY score DESC, c.id ASC
       LIMIT $3::int`,
      crawlId,
      query,
      limit,
    );
    return rows.map((row) => ({ id: row.id.toString(), score: Number(row.score) }));
  }

  /**
   * Hydrates fused chunk ids into quotable context, in the order asked for.
   *
   * Order matters: the fused ranking is the retriever's answer, and re-sorting by id here
   * would hand the judge its context in an order no ranking produced.
   */
  async loadContext(chunkIds: readonly string[]): Promise<readonly ChunkContext[]> {
    if (chunkIds.length === 0) return [];
    const rows = await this.#db.$queryRawUnsafe<
      Array<{ id: bigint; heading_path: string | null; content: string; url: string }>
    >(
      `SELECT c.id, c.heading_path, c.content, p.url
       FROM chunks c
       JOIN page_snapshots s ON s.id = c.page_snapshot_id
       JOIN pages p ON p.id = s.page_id
       WHERE c.id = ANY($1::bigint[])`,
      chunkIds,
    );

    const byId = new Map(
      rows.map((row) => [
        row.id.toString(),
        {
          id: row.id.toString(),
          headingPath: row.heading_path,
          content: row.content,
          url: row.url,
        },
      ]),
    );
    return chunkIds.flatMap((id) => {
      const chunk = byId.get(id);
      return chunk === undefined ? [] : [chunk];
    });
  }

  /**
   * How much of the crawl actually made it into the index.
   *
   * `expected` counts pages that had readable prose — a page whose extraction yielded no
   * words legitimately produces no chunks, and counting it as missing would flag every
   * crawl of a site with a few image-only pages as degraded.
   */
  async indexingCompleteness(crawlId: string): Promise<{ expected: number; indexed: number }> {
    const rows = await this.#db.$queryRawUnsafe<Array<{ expected: bigint; indexed: bigint }>>(
      `SELECT
         (SELECT count(*)::bigint FROM page_snapshots
           WHERE crawl_id = $1::uuid AND coalesce(word_count, 0) > 0) AS expected,
         (SELECT count(DISTINCT page_snapshot_id)::bigint FROM chunks
           WHERE crawl_id = $1::uuid) AS indexed`,
      crawlId,
    );
    return {
      expected: Number(rows[0]?.expected ?? 0n),
      indexed: Number(rows[0]?.indexed ?? 0n),
    };
  }

  /** Chunks belonging to one page snapshot, in document order. */
  async listForSnapshot(snapshotId: string): Promise<readonly StoredChunk[]> {
    const rows = await this.#db.$queryRawUnsafe<
      Array<{ id: bigint; ordinal: number; heading_path: string | null; content: string }>
    >(
      `SELECT id, ordinal, heading_path, content
       FROM chunks WHERE page_snapshot_id = $1::uuid ORDER BY ordinal`,
      snapshotId,
    );
    return rows.map((row) => ({
      id: row.id.toString(),
      ordinal: row.ordinal,
      headingPath: row.heading_path,
      content: row.content,
    }));
  }

  /**
   * Similarity of every active topic against every chunk in one crawl.
   *
   * Exact cosine over the crawl's corpus, no ANN index: retrieval is always scoped to a
   * single crawl of at most a few thousand chunks, where an exact scan is single-digit
   * milliseconds and has none of pgvector's filtered-recall problems (docs/Database.md §1).
   * The HNSW index is the documented next step, not a missing piece.
   *
   * Topics with no matching rows are absent from the result — the caller scores them zero
   * rather than this query fabricating a row per topic.
   */
  async topicMatches(
    projectId: string,
    crawlId: string,
    matchThreshold: number,
    evidenceLimit: number,
  ): Promise<readonly TopicMatchRow[]> {
    const rows = await this.#db.$queryRawUnsafe<
      Array<{
        topic_id: string;
        max_sim: number;
        depth: bigint;
        evidence: string[] | null;
      }>
    >(
      `WITH similarities AS (
         SELECT t.id AS topic_id,
                c.id AS chunk_id,
                1 - (c.embedding <=> t.embedding) AS sim
         FROM topics t
         JOIN chunks c
           ON c.crawl_id = $2::uuid
          AND c.embedding IS NOT NULL
         WHERE t.project_id = $1::uuid
           AND t.status = 'ACTIVE'
           AND t.embedding IS NOT NULL
       ),
       ranked AS (
         SELECT topic_id, chunk_id, sim,
                row_number() OVER (PARTITION BY topic_id ORDER BY sim DESC, chunk_id ASC) AS position
         FROM similarities
       )
       SELECT topic_id,
              max(sim)::float8 AS max_sim,
              count(*) FILTER (WHERE sim >= $3::float8)::bigint AS depth,
              array_agg(chunk_id::text ORDER BY sim DESC, chunk_id ASC)
                FILTER (WHERE position <= $4::int) AS evidence
       FROM ranked
       GROUP BY topic_id`,
      projectId,
      crawlId,
      matchThreshold,
      evidenceLimit,
    );

    return rows.map((row) => ({
      topicId: row.topic_id,
      maxSimilarity: clampSimilarity(Number(row.max_sim)),
      depthChunks: Number(row.depth),
      evidenceChunkIds: row.evidence ?? [],
    }));
  }
}
