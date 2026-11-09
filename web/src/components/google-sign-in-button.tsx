"use client";

import { useMutation } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api/client";
import { problemMessage } from "@/lib/api/problem-message";
import { navigateAway } from "@/lib/navigate";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";

/**
 * Starts Google OAuth through the API (`POST /v1/auth/sign-in/social`), which answers with
 * the provider's consent URL. The same call signs up a new user, so both auth screens use it.
 */
export function GoogleSignInButton() {
  const mutation = useMutation({
    mutationFn: async () => {
      const { url } = await apiFetch<{ url: string }>("/v1/auth/sign-in/social", {
        method: "POST",
        body: { provider: "google", callbackURL: `${window.location.origin}/projects` },
      });
      // Only ever follow an http(s) URL: a `javascript:` URL here would run in our origin.
      const target = new URL(url);
      if (target.protocol !== "https:" && target.protocol !== "http:") {
        throw new Error("Sign-in returned an unexpected redirect.");
      }
      return target.toString();
    },
    onSuccess: (target) => navigateAway(target),
  });

  return (
    <div className="flex flex-col gap-3">
      {mutation.isError && (
        <Alert variant="destructive">
          <AlertDescription>{problemMessage(mutation.error)}</AlertDescription>
        </Alert>
      )}
      <Button
        type="button"
        variant="outline"
        disabled={mutation.isPending}
        onClick={() => mutation.mutate()}
      >
        <GoogleMark className="h-4 w-4" />
        {mutation.isPending ? "Opening Google…" : "Continue with Google"}
      </Button>
    </div>
  );
}

function GoogleMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path
        fill="#4285F4"
        d="M23.5 12.27c0-.85-.08-1.67-.22-2.45H12v4.64h6.45a5.52 5.52 0 0 1-2.4 3.62v3h3.88c2.27-2.09 3.57-5.17 3.57-8.81Z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.24 0 5.96-1.07 7.94-2.9l-3.88-3.01c-1.08.72-2.45 1.15-4.06 1.15-3.12 0-5.77-2.11-6.71-4.95H1.28v3.11A12 12 0 0 0 12 24Z"
      />
      <path
        fill="#FBBC05"
        d="M5.29 14.29A7.2 7.2 0 0 1 4.91 12c0-.79.14-1.57.38-2.29V6.6H1.28A12 12 0 0 0 0 12c0 1.94.46 3.77 1.28 5.4l4.01-3.11Z"
      />
      <path
        fill="#EA4335"
        d="M12 4.77c1.76 0 3.34.61 4.59 1.8l3.44-3.44C17.95 1.19 15.24 0 12 0A12 12 0 0 0 1.28 6.6l4.01 3.11C6.23 6.88 8.88 4.77 12 4.77Z"
      />
    </svg>
  );
}
