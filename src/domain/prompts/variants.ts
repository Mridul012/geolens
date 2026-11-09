/**
 * Brand variant sets and text normalization (AI-Pipeline §4.1) — pure.
 *
 * The whole mention detector rests on this: if the variant set is wrong, every mention
 * rate in the product is wrong, and the customer has no way to tell. So the rules are
 * fixed and small rather than clever — a generated variant that only sometimes matches
 * would put noise in a trend line people make decisions from.
 */

/**
 * Casefold, strip diacritics, strip punctuation, collapse whitespace.
 *
 * Applied identically to the variant and to the answer text, which is the only way a
 * comparison between them means anything. NFD + combining-mark removal handles the
 * accented spellings that show up constantly in engine output ("Nestlé" → "nestle").
 */
export function normalizeForMatching(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Common prefixes companies bolt onto a domain when the bare one was taken. */
const DOMAIN_PREFIXES = ["get", "try", "use", "join", "go", "my", "the"];

/** The registrable domain's label, without its public suffix: `vryse.com` → `vryse`. */
export function domainRoot(registrableDomain: string): string {
  const [root] = registrableDomain.split(".");
  return root ?? registrableDomain;
}

export interface BrandVariantInput {
  /** `sites.name`, when the user set one. */
  readonly siteName: string | null;
  /** The project's own name. */
  readonly projectName: string | null;
  /** eTLD+1, resolved by the caller against a public-suffix list. */
  readonly registrableDomain: string;
}

/**
 * Every spelling of a brand we will look for.
 *
 * Deliberately does not include the full domain (`vryse.com`): a URL in the answer text is
 * a *citation*, and counting it as a mention too would double-count the same evidence.
 */
export function brandVariants(input: BrandVariantInput): readonly string[] {
  const root = domainRoot(input.registrableDomain);
  const candidates = new Set<string>();

  const add = (value: string | null): void => {
    if (value === null) return;
    const normalized = normalizeForMatching(value);
    if (normalized.length > 0) candidates.add(normalized);
  };

  add(input.siteName);
  add(input.projectName);
  add(root);

  // `getvryse` → `vryse`; `vryse-lite` → `vryse lite`, which normalization has already
  // turned into a space-separated phrase.
  for (const prefix of DOMAIN_PREFIXES) {
    if (root.length > prefix.length + 2 && root.startsWith(prefix)) {
      add(root.slice(prefix.length));
    }
  }

  // Longest first, so the most specific spelling wins the first match.
  return [...candidates].sort((a, b) => b.length - a.length || a.localeCompare(b));
}

/**
 * English words common enough that a brand named after one cannot be matched blindly.
 *
 * The pipeline doc's rule is "a matched variant is a common English dictionary word", with
 * Notion, Stripe and Linear as the examples. A real dictionary is a dependency we have not
 * declared and would mostly not use, so this is a curated list of the words that actually
 * collide with technology brand names.
 *
 * It is a heuristic and will miss some. Missing one means an LLM judge is *not* consulted
 * for a name that needed it, so the failure mode is a false positive mention on an unusual
 * brand name — visible in the per-cell evidence, which is why every cell stores its answer
 * text.
 */
const COMMON_WORDS = new Set([
  "acme", "air", "amber", "anchor", "apex", "apple", "arc", "ark", "array", "aspect",
  "atlas", "aurora",
  "basis", "beam", "bench", "block", "bolt", "box", "branch", "bridge", "buffer", "canvas",
  "carbon", "cargo", "chain", "chalk", "charge", "chart", "circle", "clay", "cloud", "coda",
  "coil", "compass", "core", "crest", "crown", "cube", "current", "dart", "dash", "delta",
  "domain", "draft", "drift", "echo", "edge", "element", "ember", "envoy", "epoch", "fabric",
  "factor", "flow", "flux", "focus", "forge", "frame", "front", "gather", "glass", "grain",
  "grid", "grove", "harbor", "harbour", "haven", "helix", "hive", "horizon", "hub", "index",
  "ink", "iron", "island", "jet", "keel", "key", "kite", "knot", "lattice", "layer", "leaf",
  "ledger", "lever", "lift", "light", "linear", "link", "loop", "lumen", "maple", "mark",
  "mason", "matrix", "meridian", "mesh", "meter", "mint", "mode", "monday", "motion", "nest",
  "node", "north", "notion", "nova", "oak", "onward", "orbit", "order", "origin", "otter",
  "outline", "oxide", "pace", "panel", "paper", "parallel", "path", "peak", "pebble", "pilot",
  "pivot", "plane", "plum", "point", "polar", "portal", "prism", "pulse", "quill", "quorum",
  "radar", "raft", "range", "reach", "relay", "render", "rise", "river", "root", "rune",
  "sage", "sail", "scale", "scope", "seed", "sentry", "shift", "shore", "signal", "slack",
  "slate", "sonar", "spark", "sphere", "spire", "square", "stack", "stage", "stream",
  "stripe", "summit", "swift", "table", "tempo", "thread", "tide", "torch", "trace", "track",
  "trellis", "tribe", "trust", "unit", "vault", "vector", "vertex", "vessel", "vine", "wave",
  "well", "whisper", "willow", "wire", "zenith",
]);

export function isCommonWord(variant: string): boolean {
  return COMMON_WORDS.has(variant);
}
