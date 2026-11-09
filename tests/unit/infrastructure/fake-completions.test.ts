/**
 * The fake adapter's completions, checked against the *real* shipped prompts.
 *
 * This suite exists because of a specific failure mode. The fake routes on the language of
 * the system prompt and reads the judge's context out of the user prompt's delimiters — so
 * versioning a prompt can silently drop it onto the wrong branch, or drop the judge back to
 * a coin flip, and every downstream test would keep passing with numbers that mean nothing.
 * These tests fail loudly instead.
 */
import { describe, expect, it } from "vitest";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { FakeAdapter, routeFor } from "../../../src/infrastructure/ai/adapters/fake.adapter.js";
import { loadPrompt, render } from "../../../src/infrastructure/ai/prompts/registry.js";
import { questionSetOutputSchema, coverageJudgmentSchema } from "../../../src/contracts/ai/retrievability.js";
import { taxonomyOutputSchema } from "../../../src/contracts/ai/taxonomy.js";
import { recommendationSetSchema } from "../../../src/contracts/ai/recommendations.js";
import { pageQualityOutputSchema } from "../../../src/contracts/ai/page-quality.js";
import { execSummaryOutputSchema } from "../../../src/contracts/ai/exec-summary.js";
import { promptSetOutputSchema } from "../../../src/contracts/ai/prompt-gen.js";

const adapter = new FakeAdapter();

async function complete(system: string, user: string): Promise<unknown> {
  const result = await adapter.complete({
    system,
    user,
    model: "fake",
    timeoutMs: 1_000,
    temperature: 0,
    maxOutputTokens: 4_000,
    jsonMode: true,
    cacheSystemPrompt: false,
  });
  return JSON.parse(result.text);
}

const TOPICS = [
  "- Pricing and plans: What the product costs and how the plans compare.",
  "- Security and compliance: Certifications, encryption, audits and data protection.",
  "- Migration guides: Migrating and importing data from another tool, step by step.",
].join("\n");

function questionPrompt(): { system: string; user: string } {
  const template = loadPrompt("buyer-questions", "v1");
  return {
    system: template.system,
    user: render(template.user, {
      siteDomain: "acme.com",
      niche: "AI search analytics",
      topics: TOPICS,
      minQuestions: "30",
      maxQuestions: "50",
    }),
  };
}

function judgePrompt(question: string, context: string): { system: string; user: string } {
  const template = loadPrompt("retrievability-judge", "v1");
  return {
    system: template.system,
    user: render(template.user, { question, context }),
  };
}

describe("every shipped prompt routes to exactly one branch", () => {
  // The regression this guards: an earlier version matched the substring "judge", which
  // also matches "judgement" in the recommendations prompt — so recommendation requests
  // were answered with a coverage judgment, failed validation, burned a repair retry and
  // produced nothing. Adding a prompt without a fake branch now fails here.
  const PROMPTS = readdirSync(join(process.cwd(), "src", "infrastructure", "ai", "prompts"), {
    withFileTypes: true,
  })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  it("covers every prompt directory", () => {
    expect(PROMPTS.length).toBeGreaterThanOrEqual(6);
    for (const name of PROMPTS) {
      const route = routeFor(loadPrompt(name, "v1").system);
      expect(route, `${name}/v1 matches no fake branch`).not.toBeNull();
    }
  });

  it("gives each prompt a different branch", () => {
    const routes = PROMPTS.map((name) => routeFor(loadPrompt(name, "v1").system));
    expect(new Set(routes).size).toBe(PROMPTS.length);
  });
});

describe("routing against the real prompts", () => {
  it("answers the taxonomy prompt with a valid taxonomy", async () => {
    const template = loadPrompt("taxonomy", "v1");
    const output = await complete(
      template.system,
      render(template.user, {
        siteDomain: "acme.com",
        homepageTitle: "Acme",
        homepageDescription: "Analytics",
        pages: "URL: https://acme.com/",
      }),
    );
    expect(taxonomyOutputSchema.safeParse(output).success).toBe(true);
  });

  it("answers the buyer-questions prompt with a valid question set", async () => {
    const prompt = questionPrompt();
    const output = await complete(prompt.system, prompt.user);
    expect(questionSetOutputSchema.safeParse(output).success).toBe(true);
  });

  it("answers the judge prompt with a valid judgment, not with a question set", async () => {
    // The judge's own prompt necessarily mentions questions; if routing regressed, this
    // would come back as a question set and every retrievability score would be garbage.
    const prompt = judgePrompt("What does the Growth plan cost?", "The Growth plan costs fifty dollars.");
    const output = await complete(prompt.system, prompt.user);
    expect(coverageJudgmentSchema.safeParse(output).success).toBe(true);
  });

  it("answers the recommendations prompt with a recommendation set", async () => {
    const template = loadPrompt("recommendations", "v1");
    const output = await complete(
      template.system,
      render(template.user, {
        siteDomain: "acme.com",
        composite: "42",
        components: "[]",
        existingRules: "- thin-content",
        findings: "topic: Migration guides (competitor ahead by 80)",
      }),
    );
    expect(recommendationSetSchema.safeParse(output).success).toBe(true);
  });

  it("answers the page-quality prompt with a rubric", async () => {
    const template = loadPrompt("page-quality", "v1");
    const output = await complete(
      template.system,
      render(template.user, {
        url: "https://acme.com/pricing",
        title: "Pricing",
        wordCount: "800",
        publishedAt: "2026-01-01",
        updatedAt: "2026-02-01",
        hasStructuredData: "true",
        headings: "Pricing",
        content: "Our pricing is simple. Plans start at 10 dollars.",
      }),
    );
    expect(pageQualityOutputSchema.safeParse(output).success).toBe(true);
  });

  it("answers the exec-summary prompt with a summary", async () => {
    const template = loadPrompt("exec-summary", "v1");
    const output = await complete(
      template.system,
      render(template.user, {
        siteDomain: "acme.com",
        composite: "42",
        components: "- technical: 90\n- trust: 40",
        findings: "AI crawler access: blocked for GPTBot.",
      }),
    );
    expect(execSummaryOutputSchema.safeParse(output).success).toBe(true);
  });
});

describe("question generation", () => {
  it("derives questions from the taxonomy it was given, not from a canned list", async () => {
    const prompt = questionPrompt();
    const parsed = questionSetOutputSchema.parse(await complete(prompt.system, prompt.user));

    const labels = new Set(parsed.questions.map((question) => question.topicLabel));
    expect(labels).toContain("Pricing and plans");
    expect(labels).toContain("Migration guides");
    // Every question carries its topic's own words, which is what makes it retrievable.
    const pricing = parsed.questions.find((question) => question.topicLabel === "Pricing and plans");
    expect(pricing?.text.toLowerCase()).toContain("pricing");
  });

  it("covers every supplied topic and all three buyer stages", async () => {
    const prompt = questionPrompt();
    const parsed = questionSetOutputSchema.parse(await complete(prompt.system, prompt.user));

    expect(new Set(parsed.questions.map((question) => question.topicLabel)).size).toBe(3);
    expect(new Set(parsed.questions.map((question) => question.intent))).toEqual(
      new Set(["awareness", "consideration", "decision"]),
    );
  });

  it("stays inside the contract's 30–50 range for a large taxonomy", async () => {
    const template = loadPrompt("buyer-questions", "v1");
    const many = Array.from({ length: 20 }, (_unused, index) => `- Topic ${index}: About topic ${index}.`).join("\n");
    const output = await complete(
      template.system,
      render(template.user, {
        siteDomain: "acme.com",
        niche: "n",
        topics: many,
        minQuestions: "30",
        maxQuestions: "50",
      }),
    );
    expect(questionSetOutputSchema.safeParse(output).success).toBe(true);
  });

  it("is deterministic for the same taxonomy", async () => {
    const prompt = questionPrompt();
    expect(await complete(prompt.system, prompt.user)).toEqual(
      await complete(prompt.system, prompt.user),
    );
  });
});

describe("the judge reads its context", () => {
  const question = "What does the Growth plan cost per month?";

  it("judges content that answers the question as fully answered", async () => {
    const prompt = judgePrompt(
      question,
      "Pricing: the Growth plan costs fifty dollars per month, billed monthly.",
    );
    const judgment = coverageJudgmentSchema.parse(await complete(prompt.system, prompt.user));

    expect(judgment.answered).toBe("fully");
    expect(judgment.missingElement).toBeNull();
  });

  it("judges unrelated content as not answered", async () => {
    const prompt = judgePrompt(question, "Our office sits above a bakery in Lisbon.");
    const judgment = coverageJudgmentSchema.parse(await complete(prompt.system, prompt.user));

    expect(judgment.answered).toBe("no");
    expect(judgment.missingElement).not.toBeNull();
  });

  it("judges on-subject-but-incomplete content as partial", async () => {
    const prompt = judgePrompt(question, "We offer a Growth plan for teams that are scaling.");
    const judgment = coverageJudgmentSchema.parse(await complete(prompt.system, prompt.user));

    expect(judgment.answered).toBe("partially");
  });

  it("judges an empty context as not answered", async () => {
    const prompt = judgePrompt(question, "(no passages were retrieved for this question)");
    const judgment = coverageJudgmentSchema.parse(await complete(prompt.system, prompt.user));

    expect(judgment.answered).toBe("no");
  });

  it("is a function of the context, not of the question alone", async () => {
    // The property every retrievability test depends on: change only the passages and the
    // verdict must change.
    const good = judgePrompt(question, "The Growth plan costs fifty dollars per month.");
    const bad = judgePrompt(question, "Unrelated prose about bakeries and weather.");

    const first = coverageJudgmentSchema.parse(await complete(good.system, good.user));
    const second = coverageJudgmentSchema.parse(await complete(bad.system, bad.user));

    expect(first.answered).not.toBe(second.answered);
  });

  it("is deterministic for the same question and passages", async () => {
    const prompt = judgePrompt(question, "The Growth plan costs fifty dollars per month.");
    expect(await complete(prompt.system, prompt.user)).toEqual(
      await complete(prompt.system, prompt.user),
    );
  });
});

describe("tracked-prompt generation on a shallow taxonomy", () => {
  // Regression: a real site with very few distinct topic labels (a shallow taxonomy is
  // normal — not every business has fifteen things to say) drove `subjects.length` down to
  // where the old implementation could never assemble ten unique combinations and spun at
  // 100% CPU forever, silently wedging the crawl. Bounded timeouts so a regression fails
  // loudly instead of hanging the suite.
  function promptGenPrompt(topics: string): { system: string; user: string } {
    const template = loadPrompt("prompt-gen", "v1");
    return {
      system: template.system,
      user: render(template.user, {
        brandName: "Acme",
        siteDomain: "acme.com",
        niche: "this category",
        competitors: "none",
        topics,
      }),
    };
  }

  it(
    "still yields ten distinct prompts from a single topic line",
    async () => {
      const prompt = promptGenPrompt("- Pricing and plans: What the product costs.");
      const output = await complete(prompt.system, prompt.user);
      const parsed = promptSetOutputSchema.parse(output);

      expect(parsed.prompts).toHaveLength(10);
      expect(new Set(parsed.prompts.map((p) => p.text)).size).toBe(10);
      expect(new Set(parsed.prompts.map((p) => p.intent)).size).toBeGreaterThan(1);
    },
    2_000,
  );

  it(
    "still yields ten distinct prompts with no topic lines at all (falls back to the niche)",
    async () => {
      const prompt = promptGenPrompt("");
      const output = await complete(prompt.system, prompt.user);
      const parsed = promptSetOutputSchema.parse(output);

      expect(parsed.prompts).toHaveLength(10);
      expect(new Set(parsed.prompts.map((p) => p.text)).size).toBe(10);
    },
    2_000,
  );
});

describe("the prompt registry", () => {
  for (const [name, tier] of [
    ["buyer-questions", "bulk"],
    ["retrievability-judge", "judge"],
  ] as const) {
    it(`loads ${name}/v1 with both sections and the documented tier`, () => {
      const prompt = loadPrompt(name, "v1");
      expect(prompt.id).toBe(`${name}/v1`);
      expect(prompt.frontmatter["tier"]).toBe(tier);
      expect(prompt.system.length).toBeGreaterThan(0);
      expect(prompt.user.length).toBeGreaterThan(0);
    });
  }

  it("throws on a missing variable rather than rendering a blank hole", () => {
    const prompt = loadPrompt("retrievability-judge", "v1");
    expect(() => render(prompt.user, { question: "only one of two" })).toThrow(/context/);
  });
});
