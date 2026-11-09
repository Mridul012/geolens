import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    testTimeout: 30_000,
    // Integration suites need a migrated database; unit and e2e suites must stay runnable
    // without one, so only the integration project pays for the bootstrap.
    projects: [
      {
        test: {
          name: "unit",
          environment: "node",
          include: ["tests/unit/**/*.test.ts"],
        },
      },
      {
        test: {
          name: "integration",
          environment: "node",
          // e2e drives the real app factory against real Postgres and Redis (§9:
          // "live wiring, faked providers"), so it boots with the integration project.
          include: ["tests/integration/**/*.test.ts", "tests/e2e/**/*.test.ts"],
          globalSetup: ["tests/setup/global-db.ts"],
          testTimeout: 60_000,
          // The suites share one database and truncate between tests, so they must not
          // race each other across files.
          poolOptions: { forks: { singleFork: true } },
        },
      },
    ],
    hookTimeout: 120_000,
    pool: "forks",
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.d.ts", "src/workers/*.entry.ts", "src/composition/**"],
      // Engineering-Rules §9: coverage floors are CI-enforced.
      thresholds: {
        lines: 80,
        "src/domain/**/*.ts": { lines: 95, functions: 95, statements: 95 },
        "src/application/**/*.ts": { lines: 85, functions: 85, statements: 85 },
      },
    },
  },
});
