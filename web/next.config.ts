import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Turbopack auto-infers this as the repo root anyway (it finds the backend's lockfile
  // one level up) — made explicit to silence the warning. Keep it at the repo root, not
  // web/, since web/ imports contract types from ../src/contracts (outside web/) by design.
  turbopack: {
    root: path.join(__dirname, ".."),
    // src/contracts/** (backend, NodeNext module resolution) uses `.js`-suffixed relative
    // imports pointing at sibling `.ts` files, so its OWN internal imports don't resolve
    // under Turbopack the way tsconfig's `@contracts/*` path alias resolves the entry file.
    // Point the runtime alias at the compiled output instead (`npm run build` in the repo
    // root produces it) — those files really are named `.js` on disk, so the backend's own
    // `.js`-suffixed imports resolve natively, with zero backend changes. Types still come
    // from the `.ts` source via tsconfig's `@contracts/*` path (see tsconfig.json) — tsc and
    // Turbopack read paths independently, so this only affects bundling, not typechecking.
    resolveAlias: {
      "@contracts/*": "../dist/contracts/*",
    },
  },
};

export default nextConfig;
