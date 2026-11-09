import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    globals: false,
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/**/*.test.{ts,tsx}"],
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
      // Mirrors next.config.ts's turbopack `resolveAlias`: the contract *types* come from
      // ../src/contracts via tsconfig's path (see tsconfig.json), but a runtime import of a
      // contract module (e.g. a zod schema used for client-side validation) needs real,
      // resolvable JS — and src/contracts' own internal imports are NodeNext-style
      // `.js`-suffixed relative paths pointing at sibling `.ts` files, which Vite's
      // resolver does not rewrite. Pointing at the backend's compiled output sidesteps that
      // with zero backend changes, same tradeoff, same reason, as the Turbopack config.
      // Run `npm run build` in the repo root before `npm test` here.
      "@contracts": path.resolve(import.meta.dirname, "../dist/contracts"),
    },
  },
});
