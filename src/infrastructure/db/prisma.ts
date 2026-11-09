// The Prisma client factory. Construction happens in composition/ (Engineering-Rules §2.2)
// — this module only knows how to build one correctly. Prisma types never leave this
// folder (golden rule #3): repositories accept and return domain/contract shapes.
import { PrismaClient } from "@prisma/client";
import { env } from "../../config/env.js";

export type Database = PrismaClient;

export function createPrismaClient(): PrismaClient {
  return new PrismaClient({
    datasources: { db: { url: env.DATABASE_URL } },
    log: env.DATABASE_LOG_QUERIES
      ? [{ emit: "stdout", level: "query" }, { emit: "stdout", level: "warn" }]
      : [{ emit: "stdout", level: "warn" }],
  });
}

/** Readiness probe used by /health on every process. */
export async function pingDatabase(prisma: PrismaClient): Promise<boolean> {
  await prisma.$queryRaw`SELECT 1`;
  return true;
}
