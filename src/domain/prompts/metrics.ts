/**
 * Prompt-run aggregation (AI-Pipeline §4.4) — pure.
 *
 * Two rules carry all the weight here, and both exist to stop the trend line lying.
 *
 * **Majority vote over three samples.** Engines are non-deterministic; asking once and
 * recording the answer would make week-to-week movement mostly noise. Two of three is the
 * cheapest thing that is stable enough to plot.
 *
 * **A cell with fewer than two successful samples leaves the denominator.** Recording an
 * API timeout as "not mentioned" would be a lie — indistinguishable, in the chart, from a
 * week where the brand genuinely stopped being cited. Partial cells are reported as
 * partial, and the rate is over the cells we actually measured.
 */

export interface SampleOutcome {
  readonly promptTemplateId: string;
  readonly engine: string;
  readonly sampleIndex: number;
  /** Null when the sample failed — never coerced to false. */
  readonly brandMentioned: boolean | null;
  readonly brandCited: boolean | null;
  readonly competitorsCited: readonly string[];
  readonly failed: boolean;
}

export interface CellOutcome {
  readonly promptTemplateId: string;
  readonly engine: string;
  readonly samples: number;
  readonly successfulSamples: number;
  /** Majority verdict, or null when the cell is not evaluable. */
  readonly brandMentioned: boolean | null;
  readonly brandCited: boolean | null;
  /** Competitors cited in at least one successful sample. */
  readonly competitorsCited: readonly string[];
  /** True when too few samples came back to vote on. */
  readonly partial: boolean;
}

/** Samples needed before a cell counts. Two of three is the documented rule. */
export const MIN_SUCCESSFUL_SAMPLES = 2;

function majority(values: readonly boolean[]): boolean | null {
  if (values.length < MIN_SUCCESSFUL_SAMPLES) return null;
  const yes = values.filter(Boolean).length;
  return yes * 2 >= values.length;
}

/** Folds a cell's samples into one verdict. */
export function aggregateCell(samples: readonly SampleOutcome[]): CellOutcome {
  const first = samples[0];
  const successful = samples.filter((sample) => !sample.failed);

  const mentioned = majority(
    successful.flatMap((sample) => (sample.brandMentioned === null ? [] : [sample.brandMentioned])),
  );
  const cited = majority(
    successful.flatMap((sample) => (sample.brandCited === null ? [] : [sample.brandCited])),
  );

  return {
    promptTemplateId: first?.promptTemplateId ?? "",
    engine: first?.engine ?? "",
    samples: samples.length,
    successfulSamples: successful.length,
    brandMentioned: mentioned,
    brandCited: cited,
    competitorsCited: [
      ...new Set(successful.flatMap((sample) => [...sample.competitorsCited])),
    ].sort(),
    partial: successful.length < MIN_SUCCESSFUL_SAMPLES,
  };
}

export interface EngineMetrics {
  readonly engine: string;
  readonly cells: number;
  readonly evaluableCells: number;
  readonly mentions: number;
  readonly citations: number;
  readonly mentionRate: number | null;
  readonly citationShare: number | null;
  /** Own citations ÷ (own + every competitor's), on this engine. */
  readonly shareOfVoice: number | null;
}

export interface RunMetrics {
  readonly cells: number;
  readonly evaluableCells: number;
  readonly partialCells: number;
  readonly mentionRate: number | null;
  readonly citationShare: number | null;
  readonly shareOfVoice: number | null;
  readonly perEngine: readonly EngineMetrics[];
  readonly competitorCitations: Readonly<Record<string, number>>;
  /** True when at least one engine produced nothing usable. */
  readonly degraded: boolean;
}

function rate(part: number, whole: number): number | null {
  return whole === 0 ? null : Math.round((part / whole) * 10_000) / 100;
}

function metricsForCells(engine: string, cells: readonly CellOutcome[]): EngineMetrics {
  const evaluable = cells.filter((cell) => !cell.partial);
  const mentions = evaluable.filter((cell) => cell.brandMentioned === true).length;
  const citations = evaluable.filter((cell) => cell.brandCited === true).length;
  const competitorCitations = evaluable.reduce(
    (sum, cell) => sum + cell.competitorsCited.length,
    0,
  );
  const voiceDenominator = citations + competitorCitations;

  return {
    engine,
    cells: cells.length,
    evaluableCells: evaluable.length,
    mentions,
    citations,
    mentionRate: rate(mentions, evaluable.length),
    citationShare: rate(citations, evaluable.length),
    shareOfVoice: voiceDenominator === 0 ? null : rate(citations, voiceDenominator),
  };
}

/**
 * The run's headline numbers.
 *
 * Rates are over *evaluable* cells throughout. A run where one engine was down reports a
 * real rate for the engine that answered and says so, rather than halving every number and
 * calling it a drop.
 */
export function summariseRun(cells: readonly CellOutcome[]): RunMetrics {
  const engines = [...new Set(cells.map((cell) => cell.engine))].sort();
  const perEngine = engines.map((engine) =>
    metricsForCells(
      engine,
      cells.filter((cell) => cell.engine === engine),
    ),
  );

  const evaluable = cells.filter((cell) => !cell.partial);
  const mentions = evaluable.filter((cell) => cell.brandMentioned === true).length;
  const citations = evaluable.filter((cell) => cell.brandCited === true).length;

  const competitorCitations: Record<string, number> = {};
  for (const cell of evaluable) {
    for (const competitor of cell.competitorsCited) {
      competitorCitations[competitor] = (competitorCitations[competitor] ?? 0) + 1;
    }
  }
  const rivalTotal = Object.values(competitorCitations).reduce((sum, count) => sum + count, 0);

  return {
    cells: cells.length,
    evaluableCells: evaluable.length,
    partialCells: cells.length - evaluable.length,
    mentionRate: rate(mentions, evaluable.length),
    citationShare: rate(citations, evaluable.length),
    shareOfVoice: citations + rivalTotal === 0 ? null : rate(citations, citations + rivalTotal),
    perEngine,
    competitorCitations,
    // An engine that produced no evaluable cell at all is an outage, not a zero.
    degraded: perEngine.some((engine) => engine.evaluableCells === 0),
  };
}

/**
 * The citation component score (AI-Pipeline §5.1).
 *
 * `round(0.6 · citation_share + 0.4 · mention_rate)` — being *linked* is the stronger
 * visibility signal, so it carries more weight than being named.
 */
export function citationScore(metrics: RunMetrics): number | null {
  if (metrics.citationShare === null || metrics.mentionRate === null) return null;
  return Math.round(0.6 * metrics.citationShare + 0.4 * metrics.mentionRate);
}
