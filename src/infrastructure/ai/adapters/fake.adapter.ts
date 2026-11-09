/**
 * The deterministic adapter — how the whole pipeline runs with no API keys and no spend.
 *
 * This is **not** a stub pretending to be a model (Engineering-Rules §15.5). It returns
 * schema-valid, deterministic output derived from the prompt, so tests exercise the real
 * gateway, the real validation path, the real ledger and the real scoring maths. What it
 * does not do is form opinions — the content is obviously synthetic.
 *
 * `config/env.ts` refuses `AI_PROVIDER_MODE=fake` in production, because a fabricated
 * score is indistinguishable from a real one once it is in the database.
 */
import { createHash } from "node:crypto";
import type {
  CompletionRequest,
  CompletionResult,
  EmbeddingRequest,
  EmbeddingResult,
  ProviderAdapter,
} from "./provider.js";

/** Deterministic pseudo-randomness: the same prompt always yields the same answer. */
function seedFrom(text: string): number {
  const digest = createHash("sha256").update(text).digest();
  return digest.readUInt32BE(0);
}

function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const TOPIC_STEMS = [
  "Pricing and plans",
  "Security and compliance",
  "Getting started",
  "Integrations",
  "Migration guides",
  "Comparison with alternatives",
  "Case studies",
  "API reference",
  "Data retention",
  "Team collaboration",
  "Reporting and analytics",
  "Onboarding best practices",
  "Automation workflows",
  "Access control",
  "Service reliability",
  "Support and escalation",
] as const;

const INTENTS = ["awareness", "consideration", "decision"] as const;

/** Words carrying no topical signal, so two unrelated texts do not look alike. */
const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "can", "for", "from", "has", "have",
  "how", "in", "is", "it", "its", "of", "on", "or", "our", "that", "the", "their", "them",
  "then", "there", "these", "they", "this", "to", "was", "we", "were", "what", "when", "which",
  "who", "will", "with", "you", "your",
]);

/**
 * Crude stemming: enough that "pricing", "prices" and "price" collide, and no more.
 *
 * A real stemmer is a dependency and a distraction — the point is only that vocabulary
 * about the same subject lands on the same dimensions.
 */
function stem(word: string): string {
  for (const suffix of ["ings", "ing", "ies", "ers", "er", "es", "s"]) {
    if (word.length > suffix.length + 2 && word.endsWith(suffix)) {
      return suffix === "ies" ? `${word.slice(0, -3)}y` : word.slice(0, -suffix.length);
    }
  }
  return word;
}

/** The stemmed content words of a text, which is all these crude heuristics look at. */
function contentTerms(text: string): Set<string> {
  const terms = new Set<string>();
  for (const word of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (word.length < 2 || STOPWORDS.has(word)) continue;
    terms.add(stem(word));
  }
  return terms;
}

/** Pulls the contents of a `<tag>…</tag>` block out of a rendered prompt. */
function section(prompt: string, tag: string): string | null {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(prompt);
  return match?.[1]?.trim() ?? null;
}

const QUESTION_SHAPES = [
  (topic: string): string => `What does ${topic} actually involve?`,
  (topic: string): string => `How should I compare options for ${topic}?`,
  (topic: string): string => `What do I need to know about ${topic} before buying?`,
  (topic: string): string => `Which ${topic} details matter most for a small team?`,
];

/**
 * Buyer questions derived from the taxonomy in the prompt.
 *
 * Reusing each topic's own words is the whole point: a question about pricing has to be
 * findable in the pricing chunks, or the retrievability simulation measures nothing but
 * this function's imagination.
 */
function synthesiseQuestions(user: string, random: () => number): string {
  const topics = [...(section(user, "untrusted-site-content") ?? "").matchAll(/^-\s*(.+?):/gm)]
    .map((match) => (match[1] ?? "").trim())
    .filter((label) => label.length > 0);

  const labels = topics.length > 0 ? topics : [...TOPIC_STEMS];
  const target = Math.min(50, Math.max(30, labels.length * 3));

  const questions: Array<{ text: string; topicLabel: string; intent: string }> = [];
  for (let index = 0; questions.length < target; index += 1) {
    const label = labels[index % labels.length] as string;
    const shape = QUESTION_SHAPES[
      Math.floor(index / labels.length) % QUESTION_SHAPES.length
    ] as (topic: string) => string;
    questions.push({
      text: shape(label.toLowerCase()).slice(0, 300),
      topicLabel: label.slice(0, 60),
      intent: INTENTS[index % INTENTS.length] as string,
    });
  }

  // Keeps the count deterministic per prompt while still varying between sites.
  const jitter = Math.floor(random() * Math.max(1, Math.min(5, questions.length - 30 + 1)));
  return JSON.stringify({ questions: questions.slice(0, questions.length - jitter) });
}

/**
 * A judgment that actually reads the passages it was given.
 *
 * The earlier version rolled a deterministic die on the prompt hash, which made the
 * keyless build's retrievability score a coin flip dressed up as a measurement. This
 * compares the question's content words against the retrieved context — crude, but it is
 * genuinely a function of whether the right content came back, which is the property every
 * test of this component depends on.
 */
function synthesiseJudgment(user: string, random: () => number): string {
  const question = section(user, "question");
  const context = section(user, "untrusted-site-content");

  if (question === null || context === null) {
    // The prompt no longer looks the way this adapter expects. Fall back to the old
    // deterministic roll rather than silently judging everything "no"; the prompt-routing
    // test is what catches the drift.
    const roll = random();
    return JSON.stringify({
      answered: roll > 0.6 ? "fully" : roll > 0.3 ? "partially" : "no",
      confidence: Math.round(50 + random() * 50),
      missingElement: roll > 0.6 ? null : "Synthetic missing element from the fake adapter.",
    });
  }

  const asked = contentTerms(question);
  const supplied = contentTerms(context);
  let overlap = 0;
  for (const term of asked) if (supplied.has(term)) overlap += 1;
  const ratio = asked.size === 0 ? 0 : overlap / asked.size;

  const answered = ratio >= 0.6 ? "fully" : ratio >= 0.25 ? "partially" : "no";
  return JSON.stringify({
    answered,
    confidence: Math.round(50 + 50 * Math.min(1, ratio)),
    missingElement:
      answered === "fully"
        ? null
        : `The retrieved passages cover ${Math.round(ratio * 100)}% of what the question asks about.`,
  });
}

/**
 * Which shipped prompt a request belongs to.
 *
 * Keyed on each system prompt's distinctive opening sentence rather than on a loose
 * keyword. That is not fussiness: an earlier version matched `"judge"`, which also matches
 * the word "judgement" in the recommendations prompt, so recommendation requests were
 * silently answered with a coverage judgment — schema-invalid, repaired once, then failed,
 * and every recommendation quietly disappeared. `fake-completions.test.ts` now asserts
 * every prompt routes to exactly one branch.
 */
const PROMPT_ROUTES = [
  ["taxonomy", "you are a b2b market analyst"],
  ["questions", "you write the questions real buyers"],
  ["judge", "you judge whether"],
  ["page-quality", "you score one web page"],
  ["exec-summary", "you write the opening paragraph"],
  ["recommendations", "you advise one business"],
  ["prompt-gen", "you write the questions a buyer actually types"],
  ["mention-judge", "you decide one narrow question"],
] as const;

export type FakePromptRoute = (typeof PROMPT_ROUTES)[number][0];

/** The branch a system prompt selects, or null when none claims it. */
export function routeFor(system: string): FakePromptRoute | null {
  const lowered = system.toLowerCase();
  for (const [route, marker] of PROMPT_ROUTES) {
    if (lowered.includes(marker)) return route;
  }
  return null;
}

/** Produces output matching whichever prompt is being run. */
function synthesise(request: CompletionRequest): string {
  const random = mulberry32(seedFrom(`${request.system}\n${request.user}`));

  switch (routeFor(request.system)) {
    case "taxonomy": {
      const count = 12 + Math.floor(random() * 5);
      return JSON.stringify({
        niche: "Synthetic analytics category (fake adapter)",
        topics: TOPIC_STEMS.slice(0, count).map((label, index) => ({
          label,
          description: `Synthetic description for ${label.toLowerCase()}, produced by the fake adapter.`,
          buyerIntent: INTENTS[index % INTENTS.length],
        })),
      });
    }
    case "questions":
      return synthesiseQuestions(request.user, random);
    case "judge":
      return synthesiseJudgment(request.user, random);
    case "page-quality":
      return synthesisePageQuality(request.user, random);
    case "exec-summary":
      return synthesiseExecSummary(request.user);
    case "recommendations":
      return synthesiseRecommendations(request.user);
    case "prompt-gen":
      return synthesiseTrackedPrompts(request.user);
    case "mention-judge":
      return synthesiseMentionJudgment(request.user);
    default:
      // An engine answer. Deliberately names no vendor and cites nothing: this adapter has
      // no knowledge of who a real assistant would recommend, and inventing a mention
      // would fabricate the exact number the product exists to measure. A keyless prompt
      // run therefore reports 0% honestly, while still exercising every cell, the
      // aggregation, the scoring and the degradation paths.
      return [
        "This is a synthetic answer produced by the fake adapter, with no model involved.",
        "It exists so the pipeline can be exercised end to end without spend, and it",
        "deliberately names no product, because guessing one would fabricate a measurement.",
      ].join(" ");
  }
}

/**
 * Length of the prefix gram emitted alongside each term.
 *
 * Four characters is enough to align the morphology a suffix stripper cannot reach —
 * encrypted/encryption, certified/certification, migrate/migration — without collapsing
 * genuinely different words. Half weight, so an exact term match always outranks a
 * morphological one.
 */
const PREFIX_GRAM_LENGTH = 4;
const PREFIX_GRAM_WEIGHT = 0.5;

/**
 * A hashing bag-of-words embedding.
 *
 * The earlier version returned a pseudo-random unit vector seeded by the exact text. That
 * is deterministic but *meaningless*: two 1,536-dimensional random vectors are almost
 * exactly orthogonal, so every cosine similarity came out near zero and topic coverage
 * could only ever score 0 — the pipeline ran, but nothing it computed was checkable.
 *
 * This is a real (if primitive) embedding function instead: text sharing vocabulary lands
 * on shared dimensions and scores high, unrelated text stays near zero, and identical text
 * still embeds identically.
 *
 * What it is **not** is calibrated. A sentence embedder places all English text in a narrow
 * cone, where related passages sit around 0.5–0.8 and unrelated ones around 0.1–0.3; this
 * one is sparse, so related passages land wherever their shared vocabulary puts them and
 * unrelated ones land near 0.00. It ranks correctly and it has no idea that "cost" and
 * "pricing" mean the same thing. Tests may therefore rely on its *ordering*, never on its
 * absolute similarity clearing a threshold tuned for a real model.
 */
function hashingEmbedding(text: string, dimensions = 1_536): number[] {
  const vector = new Array<number>(dimensions).fill(0);
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

  const add = (term: string, weight: number): void => {
    const digest = createHash("sha256").update(term).digest();
    // Two independent hash draws per term: the bucket, and a sign that keeps unrelated
    // collisions cancelling out rather than accumulating.
    const bucket = digest.readUInt32BE(0) % dimensions;
    const sign = (digest[4] as number) % 2 === 0 ? 1 : -1;
    vector[bucket] = (vector[bucket] as number) + sign * weight;
  };

  for (const word of words) {
    if (word.length < 2 || STOPWORDS.has(word)) continue;
    const stemmed = stem(word);
    add(stemmed, 1);
    if (stemmed.length > PREFIX_GRAM_LENGTH) {
      add(`^${stemmed.slice(0, PREFIX_GRAM_LENGTH)}`, PREFIX_GRAM_WEIGHT);
    }
  }

  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  // An input with no content words still has to be a valid vector; a fixed unit basis
  // vector keeps it well-formed and similar to nothing in particular.
  if (norm === 0) {
    vector[0] = 1;
    return vector;
  }
  return vector.map((value) => value / norm);
}

/** Reads a `Key: value` line out of a rendered prompt. */
function field(prompt: string, key: string): string | null {
  const match = new RegExp(`^${key}:\\s*(.*)$`, "m").exec(prompt);
  return match?.[1]?.trim() ?? null;
}

/**
 * A quality rubric derived from what is actually observable in the page.
 *
 * Not a language model's opinion, but not noise either: depth tracks length, evidence
 * tracks whether the page cites anything concrete, clarity tracks whether it has a heading
 * outline. That makes the golden baseline a measurement of the fixtures rather than of a
 * random seed, while staying obviously synthetic.
 */
function synthesisePageQuality(user: string, random: () => number): string {
  const content = section(user, "untrusted-site-content") ?? "";
  const words = Number(field(user, "Word count") ?? "0");
  const headings = (field(user, "Heading outline") ?? "").length;
  const structured = (field(user, "Structured data present") ?? "").toLowerCase() === "true";
  const updated = field(user, "Published") ?? "";

  // Digits and links are the cheapest proxy for "says something specific".
  const specifics = (content.match(/\b\d[\d.,%]*\b|https?:\/\//g) ?? []).length;
  const scale = (value: number, at: number): number =>
    Math.round(100 * Math.min(1, value / Math.max(1, at)));

  // A few points of deterministic jitter, so identical pages do not all score identically
  // and the mean is not an artefact of three distinct values.
  const jitter = Math.round(random() * 6) - 3;
  const bounded = (value: number): number => Math.min(100, Math.max(0, value + jitter));

  return JSON.stringify({
    depth: bounded(scale(words, 600)),
    clarity: bounded(scale(headings, 60)),
    evidence: bounded(scale(specifics, 8)),
    freshness: bounded(updated.includes("null") || updated.length === 0 ? 40 : 75),
    aiReadability: bounded(structured ? 80 : 60),
    notes: `Synthetic rubric from the fake adapter: ${words} words, ${specifics} specific references.`,
  });
}

/**
 * An executive summary assembled from the components it was handed.
 *
 * Deliberately mechanical prose — it must be impossible to mistake for a real model's
 * output — but it names the actual weakest component, so a test that the summary reflects
 * the analysis is a test of something.
 */
function synthesiseExecSummary(user: string): string {
  const scored = [...user.matchAll(/^- (\w+): (\d+)/gm)]
    .map((match) => ({ name: match[1] ?? "", value: Number(match[2]) }))
    .sort((a, b) => a.value - b.value);

  const weakest = scored[0]?.name ?? "coverage";
  const strongest = scored.at(-1)?.name ?? "technical";
  const composite = field(user, "Composite score") ?? "unknown";

  return JSON.stringify({
    summary: `Synthetic summary from the fake adapter. This site scores ${composite} overall. Its weakest component is ${weakest}, which is where a change would move the number most; ${strongest} is already its strongest.`,
    strengths: [
      `The ${strongest} component is this site's strongest signal.`,
      "Synthetic strength produced without a model.",
    ],
    weaknesses: [
      `The ${weakest} component is the biggest lever available.`,
      "Synthetic weakness produced without a model.",
    ],
  });
}

/**
 * Recommendations built from the findings supplied, citing only ids that were in them.
 *
 * The caller drops any recommendation whose evidence it cannot resolve, so a fake that
 * invented ids would silently produce an empty list and every test of the drop rule would
 * pass for the wrong reason. This one cites what it was given.
 */
function synthesiseRecommendations(user: string): string {
  const findings = section(user, "untrusted-site-content") ?? "";
  const topics = [...findings.matchAll(/^topic:\s*(.+)$/gm)].map((match) => (match[1] ?? "").trim());
  const snapshots = [...findings.matchAll(/^snapshot:\s*(\S+)/gm)].map((match) => match[1] ?? "");

  const recommendations: Array<Record<string, unknown>> = [];

  if (topics.length > 0) {
    recommendations.push({
      title: `Write a dedicated page on ${topics[0]}`,
      body: `Synthetic recommendation from the fake adapter. The analysis shows no substantial content on ${topics[0]}, and a competitor covers it.`,
      ruleHint: null,
      impact: 4,
      difficulty: 3,
      evidenceRefs: { topicLabels: topics.slice(0, 3) },
    });
  }

  if (snapshots.length > 0) {
    recommendations.push({
      title: "Rewrite the weakest pages the analysis found",
      body: "Synthetic recommendation from the fake adapter, citing the lowest-scoring pages in the supplied analysis.",
      ruleHint: null,
      impact: 3,
      difficulty: 3,
      evidenceRefs: { snapshotIds: snapshots.slice(0, 3) },
    });
  }

  if (recommendations.length === 0) {
    recommendations.push({
      title: "Publish content a buyer would search for",
      body: "Synthetic recommendation from the fake adapter; the supplied analysis carried no resolvable evidence.",
      ruleHint: null,
      impact: 2,
      difficulty: 3,
      evidenceRefs: {},
    });
  }

  return JSON.stringify({ recommendations });
}

/**
 * Ten tracked prompts built from the taxonomy supplied.
 *
 * Shaped so the intent spread and the distinctness the schema demands are real properties
 * of the output rather than accidents — a fake that produced ten copies of one sentence
 * would make every M14 test pass against a set no engine could measure anything with.
 */
function synthesiseTrackedPrompts(user: string): string {
  const labels = [...(section(user, "untrusted-site-content") ?? "").matchAll(/^-\s*(.+?):/gm)]
    .map((match) => (match[1] ?? "").trim().toLowerCase())
    .filter((label) => label.length > 0);
  const niche = (field(user, "Category") ?? "this category").toLowerCase();
  // Deduped: a regex that captured the same label twice must not shrink the real distinct-
  // subject count the guarantee below depends on.
  const subjects = labels.length > 0 ? [...new Set(labels)] : [niche];

  // Ten distinct phrasings spanning all three intents. Fixed at exactly 10 for a reason: it
  // makes `subjects.length * shapes.length >= 10` true for every possible `subjects` (even
  // the minimum, a single fallback niche) — see the loop bound below. Shrinking this array
  // reopens the bug it exists to prevent.
  const shapes: ReadonlyArray<[string, (topic: string) => string]> = [
    ["recommendation", (topic) => `best tool for ${topic} for a small team`],
    ["comparison", (topic) => `how do the leading options for ${topic} compare`],
    ["howto", (topic) => `how do I get started with ${topic}`],
    ["recommendation", (topic) => `what should I use for ${topic} on a tight budget`],
    ["comparison", (topic) => `${topic}: which provider is actually worth it`],
    ["howto", (topic) => `step by step guide to ${topic} for beginners`],
    ["recommendation", (topic) => `top rated options for ${topic} this year`],
    ["comparison", (topic) => `pros and cons of the top choices for ${topic}`],
    ["howto", (topic) => `how to evaluate options for ${topic} before buying`],
    ["recommendation", (topic) => `which provider handles ${topic} best for a growing business`],
  ];

  const prompts: Array<{ text: string; intent: string }> = [];
  const seen = new Set<string>();
  // Bounded by construction: subjects.length * shapes.length distinct (subject, shape) pairs
  // exist, so this always reaches ten unique prompts within that many iterations — it can
  // never spin. The previous version retried on every duplicate with no bound, which hung
  // forever once a small `subjects` array (few distinct real topic labels — exactly what a
  // shallow real site's taxonomy produces) exhausted every combination it could ever reach.
  const maxIterations = subjects.length * shapes.length;
  for (let index = 0; index < maxIterations && prompts.length < 10; index += 1) {
    const subject = subjects[index % subjects.length] as string;
    const shape = shapes[index % shapes.length] as [string, (topic: string) => string];
    const text = shape[1](subject).slice(0, 500);
    if (seen.has(text)) continue;
    seen.add(text);
    prompts.push({ text, intent: shape[0] });
  }

  return JSON.stringify({ prompts });
}

/**
 * An ambiguity verdict from the excerpt itself.
 *
 * Crude but genuinely a function of the text: a matched word immediately followed by a
 * company-ish cue ("uses", "with", ".com", a capital letter in the original) reads as a
 * brand. Defaults to false, which is also the instruction the real prompt gives — a false
 * positive inflates the customer's own number, which is the error they cannot catch.
 */
function synthesiseMentionJudgment(user: string): string {
  const matched = (field(user, "Matched text") ?? "").toLowerCase();
  const excerpt = (section(user, "untrusted-site-content") ?? "").toLowerCase();
  const brandDomain = (field(user, "Company") ?? "").toLowerCase();

  const cues = ["use ", "using ", "uses ", "with ", "switch to ", "moved to ", "try "];
  const nearBrandCue =
    cues.some((cue) => excerpt.includes(`${cue}${matched}`)) ||
    (brandDomain.length > 0 && excerpt.includes(brandDomain.replace(/^.*\(|\).*$/g, "")));

  return JSON.stringify({
    refersToBrand: nearBrandCue,
    reasoning: nearBrandCue
      ? "Synthetic judgment: the excerpt uses the term the way a product name is used."
      : "Synthetic judgment: the excerpt reads as ordinary usage, so the default is no.",
  });
}

export class FakeAdapter implements ProviderAdapter {
  readonly name = "fake";

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const text = synthesise(request);
    // Token counts are estimated the same way the budget code estimates them, so budget
    // and degradation paths are exercised rather than bypassed.
    const inputTokens = Math.ceil((request.system.length + request.user.length) / 4);
    return {
      text,
      usage: { inputTokens, outputTokens: Math.ceil(text.length / 4), cachedInputTokens: 0 },
      citations: [],
    };
  }

  async embed(request: EmbeddingRequest): Promise<EmbeddingResult> {
    // Deterministic and *semantically ordered*: see `hashingEmbedding`.
    const vectors = request.inputs.map((input) => hashingEmbedding(input));

    return {
      vectors,
      inputTokens: request.inputs.reduce((sum, input) => sum + Math.ceil(input.length / 4), 0),
    };
  }
}
