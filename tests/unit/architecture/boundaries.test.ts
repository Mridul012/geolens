// M1 acceptance: "a deliberate boundary violation (import Prisma inside application/)
// fails CI". This asserts the lint rules themselves, so weakening eslint.config.js
// breaks the build rather than passing silently.
import { describe, expect, it } from "vitest";
import { ESLint } from "eslint";

const eslint = new ESLint({ cwd: process.cwd() });

async function lint(filePath: string, code: string): Promise<readonly string[]> {
  const [result] = await eslint.lintText(code, { filePath, warnIgnored: false });
  return (result?.messages ?? []).map((m) => `${m.ruleId ?? "unknown"}: ${m.message}`);
}

describe("architecture boundaries", () => {
  it("rejects Prisma inside application/", async () => {
    const messages = await lint(
      "src/application/projects/probe.ts",
      `import { PrismaClient } from "@prisma/client";\nexport const c = PrismaClient;\n`,
    );
    expect(messages.some((m) => m.startsWith("boundaries/"))).toBe(true);
  });

  it("rejects BullMQ inside application/ — the JobQueue port is the only door", async () => {
    const messages = await lint(
      "src/application/crawls/probe.ts",
      `import { Queue } from "bullmq";\nexport const q = Queue;\n`,
    );
    expect(messages.some((m) => m.startsWith("boundaries/"))).toBe(true);
  });

  it("rejects infrastructure imports inside domain/", async () => {
    const messages = await lint(
      "src/domain/crawl/probe.ts",
      `import { createLogger } from "../../infrastructure/telemetry/logger.js";\nexport const l = createLogger;\n`,
    );
    expect(messages.some((m) => m.startsWith("boundaries/"))).toBe(true);
  });

  it("rejects external packages inside domain/ — it is pure", async () => {
    const messages = await lint(
      "src/domain/scoring/probe.ts",
      `import { z } from "zod";\nexport const s = z.string();\n`,
    );
    expect(messages.some((m) => m.startsWith("boundaries/"))).toBe(true);
  });

  it("rejects a provider SDK outside infrastructure/ai/adapters/ (golden rule #1)", async () => {
    const messages = await lint(
      "src/infrastructure/crawler/probe.ts",
      `import OpenAI from "openai";\nexport const o = OpenAI;\n`,
    );
    expect(messages.some((m) => m.startsWith("boundaries/"))).toBe(true);
  });

  it("allows a provider SDK inside infrastructure/ai/adapters/", async () => {
    const messages = await lint(
      "src/infrastructure/ai/adapters/probe.ts",
      `import OpenAI from "openai";\nexport const o = OpenAI;\n`,
    );
    expect(messages.filter((m) => m.startsWith("boundaries/"))).toEqual([]);
  });

  it("rejects an http route reaching straight into infrastructure", async () => {
    const messages = await lint(
      "src/http/routes/probe.ts",
      `import { createLogger } from "../../infrastructure/telemetry/logger.js";\nexport const l = createLogger;\n`,
    );
    expect(messages.some((m) => m.startsWith("boundaries/"))).toBe(true);
  });

  it("rejects application/ importing infrastructure outside the repository relaxation", async () => {
    const messages = await lint(
      "src/application/projects/probe.ts",
      `import { createLogger } from "../../infrastructure/telemetry/logger.js";\nexport const l = createLogger;\n`,
    );
    expect(messages.some((m) => m.startsWith("boundaries/"))).toBe(true);
  });

  it("allows an edge to call a use case", async () => {
    const messages = await lint(
      "src/http/routes/probe.ts",
      `import type { AppDependencies } from "../app.js";\nimport type { Container } from "../../composition/container.js";\nexport type D = AppDependencies | Container;\n`,
    );
    expect(messages.filter((m) => m.startsWith("boundaries/"))).toEqual([]);
  });
});
