/**
 * The clock, behind a port (Engineering-Rules §2.2). Time is an external system: reading
 * it directly from a use case makes "what happened this week" untestable.
 */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };
