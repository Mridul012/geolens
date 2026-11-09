/**
 * An embedding adapter with *controlled* similarity, for testing threshold behaviour.
 *
 * Why this exists alongside `FakeAdapter`:
 *
 * The coverage thresholds (match ≥ 0.62, quality ramp from 0.55) are calibrated for a real
 * sentence embedder, which places all English text in a narrow cone. `FakeAdapter` is a
 * hashing bag-of-words function — it ranks correctly and separates cleanly, but its
 * absolute cosines are not on that scale. Asserting "coverage ≥ 60" against it would be
 * measuring the fake's calibration, not the product's behaviour.
 *
 * So the two are used for different jobs. `FakeAdapter` proves the pipeline runs and ranks
 * correctly on real prose. This adapter fixes similarity at a stated value per subject, so
 * the thresholds themselves do real work and a change to them fails a test.
 *
 * It is a test double for the *model* only. Every other part of the path — the gateway,
 * the ledger, the SQL, the formula — stays real.
 */
import type {
  CompletionRequest,
  CompletionResult,
  EmbeddingRequest,
  EmbeddingResult,
  ProviderAdapter,
} from "../../src/infrastructure/ai/adapters/provider.js";
import { FakeAdapter } from "../../src/infrastructure/ai/adapters/fake.adapter.js";

const DIMENSIONS = 1_536;

/** Subjects the fixture content is written about, one orthogonal axis each. */
const SUBJECTS = ["pricing", "security", "api", "migration", "careers"] as const;
type Subject = (typeof SUBJECTS)[number];

/**
 * Words that identify a subject. Matching is on the text itself, so a chunk lands on the
 * axis its content is actually about rather than on one the test asserts it into.
 */
const MARKERS: Readonly<Record<Subject, readonly string[]>> = {
  pricing: ["pricing", "plan", "cost", "billing"],
  security: ["security", "compliance", "encrypt", "soc 2", "gdpr"],
  api: ["api", "endpoint", "sdk", "webhook"],
  migration: ["migrat", "import"],
  careers: ["career", "hiring", "interview"],
};

interface SubjectAdapterOptions {
  /** Cosine similarity between any two texts about the same subject. */
  readonly sameSubjectSimilarity?: number;
}

/** The subject a text is about: whichever marker set it mentions most. */
function subjectOf(text: string): Subject | null {
  const lowered = text.toLowerCase();
  let best: Subject | null = null;
  let bestHits = 0;
  for (const subject of SUBJECTS) {
    let hits = 0;
    for (const marker of MARKERS[subject]) {
      hits += lowered.split(marker).length - 1;
    }
    if (hits > bestHits) {
      best = subject;
      bestHits = hits;
    }
  }
  return best;
}

/**
 * Every text about a subject leans the same amount onto that subject's shared axis, and
 * the rest of the way onto a private axis of its own.
 *
 * Two such texts overlap only on the shared axis, so their cosine is exactly `tilt²` —
 * which is why the tilt is `√p` for a requested pairwise similarity `p`. Texts about
 * different subjects share no axis at all and sit at exactly zero.
 */
function subjectVector(subject: Subject, tilt: number, variance: number): number[] {
  const vector = new Array<number>(DIMENSIONS).fill(0);
  const axis = SUBJECTS.indexOf(subject);
  vector[axis] = tilt;
  // A private axis per (subject, variance), well clear of every shared axis.
  vector[100 + axis * 50 + (variance % 50)] = Math.sqrt(Math.max(0, 1 - tilt * tilt));
  return vector;
}

/** Text mentioning no subject at all: orthogonal to every topic. */
function neutralVector(seed: number): number[] {
  const vector = new Array<number>(DIMENSIONS).fill(0);
  vector[1_000 + (seed % 500)] = 1;
  return vector;
}

export class SubjectAdapter implements ProviderAdapter {
  readonly name = "fake";
  readonly #completions = new FakeAdapter();
  readonly #tilt: number;
  #calls = 0;

  constructor(options: SubjectAdapterOptions = {}) {
    // 0.80 sits above the 0.62 match threshold and high on the 0.55–0.85 quality ramp,
    // which is where a real embedder puts a passage about its own subject.
    this.#tilt = Math.sqrt(options.sameSubjectSimilarity ?? 0.8);
  }

  /** Completions are not what this adapter is for; the real fake handles them. */
  async complete(request: CompletionRequest): Promise<CompletionResult> {
    return this.#completions.complete(request);
  }

  async embed(request: EmbeddingRequest): Promise<EmbeddingResult> {
    const vectors = request.inputs.map((input, index) => {
      const subject = subjectOf(input);
      this.#calls += 1;
      return subject === null
        ? neutralVector(index + this.#calls)
        : subjectVector(subject, this.#tilt, index + this.#calls);
    });

    return {
      vectors,
      inputTokens: request.inputs.reduce((sum, input) => sum + Math.ceil(input.length / 4), 0),
    };
  }
}
