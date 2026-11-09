/**
 * Result types for *expected* failures (Engineering-Rules §3).
 *
 * `throw` stays reserved for programmer errors and infrastructure faults, which the edge's
 * error mapper converts to problem+json. Anything a well-behaved caller might legitimately
 * hit — a plan limit, a duplicate label, a state conflict — comes back as a value.
 */

export type Result<T, E> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

export function isOk<T, E>(result: Result<T, E>): result is { readonly ok: true; readonly value: T } {
  return result.ok;
}

/**
 * Compile-time exhaustiveness guard. Adding a variant to a discriminated union breaks the
 * build at every switch that forgot it — which is the point.
 */
export function assertNever(value: never): never {
  throw new Error(`Unhandled variant: ${String(value)}`);
}
