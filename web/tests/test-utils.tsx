import type { ReactElement, ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";

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

export function renderWithQueryClient(ui: ReactElement) {
  const queryClient = createTestQueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { queryClient, ...render(ui, { wrapper }) };
}
