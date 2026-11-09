/**
 * Indexing one batch of pages (docs/Architecture.md Stage 3).
 *
 * The single biggest cost lever in the product lives here. A page whose content hash is
 * unchanged has its chunks — vectors and all — copied forward from the snapshot it carries
 * from, costing one SQL statement and zero tokens. Only genuinely changed pages are
 * chunked and embedded. On a weekly re-crawl of a stable site that is the difference
 * between a few cents and nothing at all, and the `ai_usage` ledger is what proves it.
 *
 * Idempotent by construction: chunks are replaced per snapshot, so a retried batch
 * converges on the same rows rather than duplicating them.
 */
import { chunkDocument, embeddableText } from "../../domain/content/chunking.js";
import type { Result } from "../../domain/shared/result.js";
import { err, ok } from "../../domain/shared/result.js";
import type { AppError } from "../../domain/shared/app-error.js";
import { notFound } from "../../domain/shared/app-error.js";
import type { AiGateway } from "../ports/ai-gateway.port.js";
import type { JobLogger } from "../ports/job-context.port.js";
import type { ChunksRepo, ChunkEmbedding } from "../../infrastructure/db/repositories/chunks.repo.js";
import type { CrawlsRepo } from "../../infrastructure/db/repositories/crawls.repo.js";

export interface IndexPagesDeps {
  readonly gateway: AiGateway;
  readonly chunks: ChunksRepo;
  readonly crawls: CrawlsRepo;
  readonly log: JobLogger;
}

export interface IndexPagesInput {
  readonly crawlId: string;
  readonly projectId: string;
  readonly snapshotIds: readonly string[];
  readonly requestId?: string | undefined;
}

export interface IndexPagesResult {
  readonly pagesIndexed: number;
  readonly pagesCarriedForward: number;
  readonly chunksWritten: number;
  readonly chunksCarriedForward: number;
  readonly embeddingsStored: number;
  /** True when chunks exist but have no vectors — retrieval degrades to its lexical arm. */
  readonly embeddingsDegraded: boolean;
}

export async function indexPages(
  deps: IndexPagesDeps,
  input: IndexPagesInput,
): Promise<Result<IndexPagesResult, AppError>> {
  const targets = await deps.crawls.listIndexTargets(input.crawlId);
  const wanted = new Set(input.snapshotIds);
  const batch = targets.filter((target) => wanted.has(target.snapshotId));

  if (batch.length === 0) {
    // The crawl or its snapshots were deleted between enqueue and execution. Nothing to
    // retry and nothing broken.
    return err(notFound("Page snapshots"));
  }

  const changed = batch.filter((target) => target.changed || target.carriedForwardFromId === null);
  const carried = batch.filter(
    (target) => !target.changed && target.carriedForwardFromId !== null,
  );

  let chunksCarriedForward = 0;
  for (const target of carried) {
    chunksCarriedForward += await deps.chunks.carryForward(
      input.crawlId,
      target.snapshotId,
      target.carriedForwardFromId as string,
    );
  }

  const contents = await deps.crawls.loadSnapshotContent(
    changed.map((target) => target.snapshotId),
  );

  // All chunks in the batch are embedded in one call: the gateway batches to the
  // provider's cap internally, and one call means one ledger row per batch to reason about.
  const pendingEmbeddings: Array<{ id: string; text: string }> = [];
  let chunksWritten = 0;

  for (const content of contents) {
    const drafts = chunkDocument({ sections: content.sections, fallbackText: content.mainText });
    if (drafts.length === 0) {
      // A page with no readable prose is a finding for the recommendations engine, not an
      // error: it still exists, it just indexes to nothing.
      await deps.chunks.replaceForSnapshot(input.crawlId, content.snapshotId, []);
      continue;
    }

    const stored = await deps.chunks.replaceForSnapshot(
      input.crawlId,
      content.snapshotId,
      drafts.map((draft) => ({
        ordinal: draft.ordinal,
        headingPath: draft.headingPath,
        content: draft.content,
        tokenCount: draft.tokenCount,
      })),
    );
    chunksWritten += stored.length;

    for (const chunk of stored) {
      pendingEmbeddings.push({
        id: chunk.id,
        text: embeddableText({ headingPath: chunk.headingPath, content: chunk.content }),
      });
    }
  }

  let embeddingsStored = 0;
  let embeddingsDegraded = false;

  if (pendingEmbeddings.length > 0) {
    const embedded = await deps.gateway.embed({
      inputs: pendingEmbeddings.map((pending) => pending.text),
      context: {
        purpose: "indexing",
        projectId: input.projectId,
        crawlId: input.crawlId,
        ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
      },
    });

    if (embedded.ok) {
      const pairs: ChunkEmbedding[] = [];
      for (const [index, pending] of pendingEmbeddings.entries()) {
        const vector = embedded.value.vectors[index];
        if (vector === undefined) continue;
        pairs.push({ id: pending.id, vector });
      }
      embeddingsStored = await deps.chunks.setEmbeddings(pairs);
    } else {
      // Documented degradation: the rows and their tsvectors are already written, so
      // lexical retrieval still works and topic coverage reports honestly as unavailable
      // rather than as zero (AI-Pipeline §9).
      embeddingsDegraded = true;
      deps.log.warn(
        { crawlId: input.crawlId, chunks: pendingEmbeddings.length, reason: embedded.error.detail },
        "embeddings unavailable for this batch; chunks stored without vectors",
      );
    }
  }

  deps.log.info(
    {
      crawlId: input.crawlId,
      pagesIndexed: contents.length,
      pagesCarriedForward: carried.length,
      chunksWritten,
      chunksCarriedForward,
      embeddingsStored,
    },
    "index batch complete",
  );

  return ok({
    pagesIndexed: contents.length,
    pagesCarriedForward: carried.length,
    chunksWritten,
    chunksCarriedForward,
    embeddingsStored,
    embeddingsDegraded,
  });
}
