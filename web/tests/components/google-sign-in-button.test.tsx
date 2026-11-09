import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { GoogleSignInButton } from "@/components/google-sign-in-button";
import { apiFetch, ApiError } from "@/lib/api/client";
import { navigateAway } from "@/lib/navigate";
import { renderWithQueryClient } from "../test-utils";

vi.mock("@/lib/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/client")>();
  return { ...actual, apiFetch: vi.fn() };
});
vi.mock("@/lib/navigate", () => ({ navigateAway: vi.fn() }));

describe("GoogleSignInButton", () => {
  afterEach(() => {
    vi.mocked(apiFetch).mockReset();
    vi.mocked(navigateAway).mockReset();
  });

  it("asks the API for Google's consent URL and follows it", async () => {
    vi.mocked(apiFetch).mockResolvedValue({ url: "https://accounts.google.com/o/oauth2/auth?x=1" });
    const user = userEvent.setup();
    renderWithQueryClient(<GoogleSignInButton />);

    await user.click(screen.getByRole("button", { name: /continue with google/i }));

    await waitFor(() =>
      expect(navigateAway).toHaveBeenCalledWith("https://accounts.google.com/o/oauth2/auth?x=1"),
    );
    expect(apiFetch).toHaveBeenCalledWith("/v1/auth/sign-in/social", {
      method: "POST",
      body: { provider: "google", callbackURL: `${window.location.origin}/projects` },
    });
  });

  it("shows the API's own reason when Google isn't configured", async () => {
    vi.mocked(apiFetch).mockRejectedValue(
      new ApiError({
        type: "https://api.geolens.example/errors/validation-failed",
        title: "Validation failed",
        status: 400,
        code: "VALIDATION_FAILED",
        errors: [{ path: "provider", message: "Google sign-in is not configured." }],
      }),
    );
    const user = userEvent.setup();
    renderWithQueryClient(<GoogleSignInButton />);

    await user.click(screen.getByRole("button", { name: /continue with google/i }));

    expect(await screen.findByText("Google sign-in is not configured.")).toBeInTheDocument();
    expect(navigateAway).not.toHaveBeenCalled();
  });

  it("refuses to follow a non-http redirect", async () => {
    vi.mocked(apiFetch).mockResolvedValue({ url: "javascript:alert(1)" });
    const user = userEvent.setup();
    renderWithQueryClient(<GoogleSignInButton />);

    await user.click(screen.getByRole("button", { name: /continue with google/i }));

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(navigateAway).not.toHaveBeenCalled();
  });
});
