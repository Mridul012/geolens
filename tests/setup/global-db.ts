/**
 * Integration-suite bootstrap: make sure the test database exists and carries the current
 * migration history. Runs once per `vitest` invocation, before any integration file.
 *
 * The suites talk to a real Postgres (Engineering-Rules §9: never mock the thing under
 * test) — locally the compose stack, in CI the service container.
 */
import { execFileSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { testDatabaseUrl, maintenanceUrlFor, databaseNameOf } from "../helpers/db.js";

export async function setup(): Promise<void> {
  const url = testDatabaseUrl();
  const name = databaseNameOf(url);

  const admin = new PrismaClient({ datasources: { db: { url: maintenanceUrlFor(url) } } });
  try {
    const existing = await admin.$queryRawUnsafe<Array<{ count: bigint }>>(
      "SELECT count(*)::bigint AS count FROM pg_database WHERE datname = $1",
      name,
    );
    if ((existing[0]?.count ?? 0n) === 0n) {
      // Identifier interpolation: CREATE DATABASE cannot be parameterised. The name comes
      // from our own env var and is quoted.
      await admin.$executeRawUnsafe(`CREATE DATABASE "${name.replaceAll('"', '""')}"`);
    }
  } finally {
    await admin.$disconnect();
  }

  execFileSync("npx", ["prisma", "migrate", "deploy"], {
    env: { ...process.env, DATABASE_URL: url },
    stdio: "pipe",
  });
}
