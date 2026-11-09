// Engineering-Rules §2.1 — the dependency direction is lint-enforced, not aspirational.
// Disabling a boundary rule to make an import compile is never acceptable (§2.3).
//
// Policy precedence in eslint-plugin-boundaries v7: within one policy `disallow` beats
// `allow`; across policies the LAST match wins. The golden rules are therefore last.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import boundaries from "eslint-plugin-boundaries";

/** Provider SDKs: legal only inside infrastructure/ai/adapters (golden rule #1). */
const PROVIDER_SDKS = [
  "openai",
  "openai/**",
  "@anthropic-ai/sdk",
  "@anthropic-ai/sdk/**",
  "groq-sdk",
  "groq-sdk/**",
  "@google/generative-ai",
  "langfuse",
];

/** Everything that touches the world; illegal above the infrastructure layer. */
const INFRA_ONLY = [
  "@prisma/client",
  "prisma",
  "prisma/**",
  "bullmq",
  "ioredis",
  "crawlee",
  "@crawlee/**",
  "playwright",
  "playwright-core",
  "@aws-sdk/**",
  "stripe",
  "resend",
  "better-auth",
  "better-auth/**",
  "cheerio",
  "tldts",
  ...PROVIDER_SDKS,
];

const ELEMENT_TYPES = [
  "config",
  "contracts",
  "domain",
  "ports",
  "application",
  "repositories",
  "db",
  "ai-adapters",
  "infrastructure",
  "http",
  "workers",
  "composition",
];

/** Sugar: `to("a", "b")` → an element selector matching any of those types. */
const to = (...types) => ({ to: { element: { types: { anyOf: types } } } });

/**
 * Sugar: a list of external module selectors. The matcher treats `source` as a single
 * micromatch template, so multiple packages must be expressed as separate selectors.
 */
const externals = (sources) => sources.map((source) => ({ origin: "external", source }));

export default tseslint.config(
  {
    // web/ is a fully independent Next.js app with its own package.json, tsconfig, and
    // eslint config — it is not part of the layered src/ tree these rules police.
    ignores: ["dist/**", "node_modules/**", "coverage/**", "prisma/migrations/**", "*.tmp.mjs", "web/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts", "**/*.js"],
    plugins: { boundaries },
    settings: {
      // NodeNext source imports carry a `.js` extension that resolves to a `.ts` file.
      // Without a TS-aware resolver the boundary rules silently stop classifying relative
      // imports — enforcement would become theatre (proven by tests/unit/architecture).
      "import/resolver": { typescript: { project: "./tsconfig.json" } },
      // Ordered most-specific first: the first matching pattern wins.
      "boundaries/elements": [
        { type: "config", pattern: "src/config/**" },
        { type: "contracts", pattern: "src/contracts/**" },
        { type: "domain", pattern: "src/domain/**" },
        { type: "ports", pattern: "src/application/ports/**" },
        { type: "application", pattern: "src/application/**" },
        { type: "repositories", pattern: "src/infrastructure/db/repositories/**" },
        { type: "db", pattern: "src/infrastructure/db/**" },
        { type: "ai-adapters", pattern: "src/infrastructure/ai/adapters/**" },
        { type: "infrastructure", pattern: "src/infrastructure/**" },
        { type: "http", pattern: "src/http/**" },
        { type: "workers", pattern: "src/workers/**" },
        { type: "composition", pattern: "src/composition/**" },
      ],
    },
    rules: {
      "boundaries/dependencies": [
        "error",
        {
          default: "disallow",
          // External packages are the whole point of the golden rules, so they must be
          // evaluated rather than waved through (the plugin skips them by default).
          checkAllOrigins: true,
          message:
            "{{ from.element.type }} is not allowed to import {{ target.element.type }} (Engineering-Rules §2.2)",
          policies: [
            // ── Baseline: node core modules and npm packages ──────────────────
            { allow: { to: { module: { origin: "core" } } } },
            {
              from: { element: { type: "!domain" } },
              allow: { to: { module: { origin: "external" } } },
            },

            // ── Dependency direction (Engineering-Rules §2.1) ─────────────────
            // domain/ is pure: itself and contract types only.
            { from: { element: { type: "domain" } }, allow: to("domain", "contracts") },
            { from: { element: { type: "contracts" } }, allow: to("contracts") },
            { from: { element: { type: "config" } }, allow: to("config", "contracts", "domain") },
            {
              from: { element: { type: "ports" } },
              allow: to("ports", "contracts", "domain", "config"),
            },
            // application/ depends on abstractions; repository classes are the one
            // sanctioned concrete injection (§2.2).
            {
              from: { element: { type: "application" } },
              allow: to("application", "ports", "domain", "contracts", "config", "repositories"),
            },
            // infrastructure/ implements ports.
            {
              from: {
                element: { types: { anyOf: ["infrastructure", "repositories", "db", "ai-adapters"] } },
              },
              allow: to(
                "infrastructure",
                "repositories",
                "db",
                "ai-adapters",
                "ports",
                "domain",
                "contracts",
                "config",
              ),
            },
            // Thin edges: validate → resolve context → call one use case → map the result.
            {
              from: { element: { types: { anyOf: ["http", "workers"] } } },
              allow: to(
                "http",
                "workers",
                "application",
                "ports",
                "contracts",
                "config",
                "domain",
                "composition",
              ),
            },
            // The only place allowed to construct infrastructure.
            { from: { element: { type: "composition" } }, allow: to(...ELEMENT_TYPES) },

            // ── Golden rules — last, so they override the baseline allows ─────
            {
              from: { element: { type: "domain" } },
              disallow: { to: { module: { origin: "external" } } },
              message: "domain/ is pure — no external packages (Engineering-Rules §2.2)",
            },
            {
              from: {
                element: {
                  types: {
                    anyOf: ["application", "ports", "http", "workers", "config", "contracts"],
                  },
                },
              },
              disallow: { to: { module: externals(INFRA_ONLY) } },
              message:
                "{{ target.module.source }} may only be imported inside infrastructure/ — use a port (Engineering-Rules §2.2)",
            },
            {
              from: { element: { type: "!ai-adapters" } },
              disallow: { to: { module: externals(PROVIDER_SDKS) } },
              message:
                "Golden rule #1: provider SDKs are importable only inside infrastructure/ai/adapters/",
            },
            {
              from: { element: { types: { noneOf: ["repositories", "db", "composition"] } } },
              disallow: { to: { module: externals(["@prisma/client", "@prisma/client/**"]) } },
              message: "Golden rule #3: Prisma types never leave infrastructure/db/",
            },
          ],
        },
      ],
      // §3 TypeScript standards.
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": ["error", { prefer: "type-imports" }],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // §4 API standards: structured logging only.
      "no-console": "error",
      "no-restricted-syntax": [
        "error",
        {
          selector: "TSEnumDeclaration",
          message: "Prefer union literal types over TS enums (Engineering-Rules §3)",
        },
      ],
      eqeqeq: ["error", "smart"],
    },
  },
  // Tooling and tests live outside the layered tree.
  {
    files: ["scripts/**/*.ts", "evals/**/*.ts", "tests/**/*.ts", "*.ts", "*.js", "*.mjs"],
    rules: { "boundaries/dependencies": "off", "no-console": "off" },
  },
);
