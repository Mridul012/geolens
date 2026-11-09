import { PrismaClient } from "@prisma/client";

/** Integration suites use a dedicated database so a local dev seed is never clobbered. */
export function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "TEST_DATABASE_URL (or DATABASE_URL) must be set to run the integration suites",
    );
  }
  return url;
}

export function databaseNameOf(url: string): string {
  return new URL(url).pathname.replace(/^\//, "");
}

/** Same server, `postgres` database — used only to CREATE DATABASE. */
export function maintenanceUrlFor(url: string): string {
  const parsed = new URL(url);
  parsed.pathname = "/postgres";
  return parsed.toString();
}

export function createTestPrisma(): PrismaClient {
  return new PrismaClient({ datasources: { db: { url: testDatabaseUrl() } } });
}

/** Every domain table, ordered so TRUNCATE ... CASCADE has nothing to complain about. */
const TABLES = [
  "events",
  "ai_usage",
  "job_runs",
  "reports",
  "recommendations",
  "scores",
  "prompt_results",
  "prompt_runs",
  "prompt_templates",
  "topic_coverage",
  "topics",
  "chunks",
  "page_snapshots",
  "pages",
  "crawls",
  "sites",
  "projects",
  "subscriptions",
  "oauth_accounts",
  "sessions",
  "users",
] as const;

export async function truncateAll(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE ${TABLES.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`,
  );
}
