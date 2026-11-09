import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Me } from "@contracts/api/auth";
import { BillingView } from "@/app/(app)/projects/[projectId]/billing/billing-view";
import { apiFetch, ApiError } from "@/lib/api/client";
import { toast } from "sonner";
import { renderWithQueryClient } from "../test-utils";

vi.mock("@/lib/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/client")>();
  return { ...actual, apiFetch: vi.fn() };
});

// jsdom doesn't implement `window.matchMedia`, which sonner's real <Toaster> needs at mount
// time — and tests/setup.ts (shared test infra, out of this screen's scope) has no polyfill
// for it. Mocking `sonner` and asserting `toast.error` was called (rather than rendering the
// real Toaster and reading its portal) sidesteps that without touching shared test setup.
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

function me(overrides: Partial<Me> = {}): Me {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    email: "mridul@buildablelabs.com",
    name: "Mridul",
    plan: "FREE",
    usage: {
      projects: { used: 1, limit: 2 },
      activePrompts: { used: 3, limit: 10 },
      onDemandRunsThisWeek: { used: 0, limit: 0 },
    },
    ...overrides,
  };
}

describe("BillingView", () => {
  afterEach(() => {
    vi.mocked(apiFetch).mockReset();
  });

  it("renders the FREE plan with usage bars and an Upgrade CTA", () => {
    renderWithQueryClient(<BillingView initialMe={me()} />);

    expect(screen.getByText("FREE")).toBeInTheDocument();
    expect(screen.getByText("Free plan")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /upgrade to pro/i })).toBeEnabled();
    expect(screen.queryByRole("button", { name: /manage billing/i })).not.toBeInTheDocument();

    expect(screen.getByText("Projects")).toBeInTheDocument();
    expect(screen.getByText("1 / 2")).toBeInTheDocument();
    expect(screen.getByText("Active prompts")).toBeInTheDocument();
    expect(screen.getByText("3 / 10")).toBeInTheDocument();
    expect(screen.getByText("On-demand runs this week")).toBeInTheDocument();
    // limit === 0 must render as 0%, not NaN%.
    expect(screen.getByText("0 / 0")).toBeInTheDocument();
  });

  it("renders the PRO plan with a Manage billing CTA instead of Upgrade", () => {
    renderWithQueryClient(<BillingView initialMe={me({ plan: "PRO" })} />);

    expect(screen.getByText("PRO")).toBeInTheDocument();
    expect(screen.getByText("Pro plan")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /manage billing/i })).toBeEnabled();
    expect(screen.queryByRole("button", { name: /upgrade to pro/i })).not.toBeInTheDocument();
  });

  it("starts checkout on Upgrade and calls the checkout endpoint", async () => {
    vi.mocked(apiFetch).mockResolvedValue({ url: "https://checkout.stripe.com/session/abc" });
    const user = userEvent.setup();
    renderWithQueryClient(<BillingView initialMe={me()} />);

    await user.click(screen.getByRole("button", { name: /upgrade to pro/i }));

    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        "/v1/billing/checkout",
        expect.objectContaining({ method: "POST", body: {} }),
      ),
    );
  });

  it("starts a portal session on Manage billing and calls the portal endpoint", async () => {
    vi.mocked(apiFetch).mockResolvedValue({ url: "https://billing.stripe.com/portal/abc" });
    const user = userEvent.setup();
    renderWithQueryClient(<BillingView initialMe={me({ plan: "PRO" })} />);

    await user.click(screen.getByRole("button", { name: /manage billing/i }));

    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        "/v1/billing/portal",
        expect.objectContaining({ method: "POST", body: {} }),
      ),
    );
  });

  it("surfaces a checkout failure via toast rather than crashing", async () => {
    vi.mocked(apiFetch).mockRejectedValue(
      new ApiError({
        type: "https://api.vryse.example/errors/internal-error",
        code: "INTERNAL_ERROR",
        title: "Internal error",
        status: 500,
        detail: "Stripe is unavailable right now.",
      }),
    );
    const user = userEvent.setup();
    renderWithQueryClient(<BillingView initialMe={me()} />);

    await user.click(screen.getByRole("button", { name: /upgrade to pro/i }));

    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    await waitFor(() =>
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith("Stripe is unavailable right now."),
    );
  });
});
