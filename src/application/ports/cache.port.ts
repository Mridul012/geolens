/**
 * A read-through cache behind a port (Engineering-Rules §2.2).
 *
 * Exists for exactly one thing at M12: the dashboard, which must serve in single-digit
 * milliseconds and must never compute (docs/Backend.md §4). The invariant that makes that
 * safe is that the cache is *written by the pipeline*, not by the read path — a cache miss
 * is a fallback, not the normal case.
 *
 * Losing the cache must never lose data. Everything stored through this port is derived
 * and rebuildable from Postgres.
 */
export interface Cache {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttlSeconds: number): Promise<void>;
  delete(key: string): Promise<void>;
}
