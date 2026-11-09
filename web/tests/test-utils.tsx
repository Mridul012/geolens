import type { ReactElement, ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { vi } from "vitest";

/**
 * A fresh QueryClient per test so mutations/queries settle deterministically.
 *
 * `staleTime` mirrors `providers.tsx`'s real default: every screen renders with
 * `initialData` from a Server Component, and with the default `staleTime: 0` TanStack
 * Query treats that data as stale the instant it mounts and fires an unmocked background
 * refetch — which then races the assertions and mutations under test. Matching production
 * here isn't a test-only fudge; it reproduces the same "fresh initial data, no refetch on
 * mount" behavior the real app relies on.
 */
export function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: 10_000 },
      mutations: { retry: false },
    },
  });
}

/**
 * A fresh in-memory `localStorage` for one test. Node 25+ ships its own global
 * `localStorage` that shadows jsdom's and, without `--localstorage-file`, has no working
 * methods — so code that persists per-device conveniences gets a real Storage here.
 */
export function stubLocalStorage(): Storage {
  const store = new Map<string, string>();
  const storage: Storage = {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => void store.set(key, String(value)),
    removeItem: (key) => void store.delete(key),
    clear: () => store.clear(),
    key: (index) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  };
  vi.stubGlobal("localStorage", storage);
  return storage;
}

export function renderWithQueryClient(ui: ReactElement) {
  const queryClient = createTestQueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { queryClient, ...render(ui, { wrapper }) };
}
