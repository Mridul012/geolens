/**
 * Branded identifiers (Engineering-Rules §3): mixing a `CrawlId` into a `ProjectId` slot
 * is a compile error, not a runtime mystery. The brand exists only in the type system —
 * at runtime every one of these is a plain string.
 */
declare const brand: unique symbol;

export type Brand<T, B extends string> = T & { readonly [brand]: B };

export type UserId = Brand<string, "UserId">;
export type ProjectId = Brand<string, "ProjectId">;
export type SiteId = Brand<string, "SiteId">;
export type CrawlId = Brand<string, "CrawlId">;
export type PageId = Brand<string, "PageId">;
export type SnapshotId = Brand<string, "SnapshotId">;
export type ChunkId = Brand<bigint, "ChunkId">;
export type TopicId = Brand<string, "TopicId">;
export type PromptTemplateId = Brand<string, "PromptTemplateId">;
export type PromptRunId = Brand<string, "PromptRunId">;
export type PromptResultId = Brand<bigint, "PromptResultId">;
export type ScoreId = Brand<string, "ScoreId">;
export type RecommendationId = Brand<string, "RecommendationId">;
export type ReportId = Brand<string, "ReportId">;
export type JobRunId = Brand<string, "JobRunId">;
export type EventId = Brand<bigint, "EventId">;

/**
 * Applies a brand to a value already known to be of that kind — at a trust boundary this
 * belongs *after* validation, never instead of it.
 */
export function brandId<B extends Brand<string, string>>(value: string): B {
  return value as B;
}

export function brandBigIntId<B extends Brand<bigint, string>>(value: bigint): B {
  return value as B;
}
