"use client";

import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { LogOut } from "lucide-react";
import { apiFetch, ApiError } from "@/lib/api/client";
import { problemMessage } from "@/lib/api/problem-message";
import { cn } from "@/lib/utils";

/** Ends the session server-side, drops every cached query, and returns to sign-in. */
export function SignOutButton({ withLabel = false }: { withLabel?: boolean }) {
  const router = useRouter();
  const queryClient = useQueryClient();

  const leave = () => {
    // Nothing cached for this account may survive into the next one's session.
    queryClient.clear();
    router.replace("/sign-in");
    router.refresh();
  };

  const signOut = useMutation({
    mutationFn: () => apiFetch<unknown>("/v1/auth/sign-out", { method: "POST" }),
    onSuccess: leave,
    onError: (error) => {
      // Already signed out (expired or revoked elsewhere): the goal is reached anyway.
      if (error instanceof ApiError && error.problem.code === "AUTH_REQUIRED") {
        leave();
        return;
      }
      toast.error(problemMessage(error));
    },
  });

  return (
    <button
      type="button"
      onClick={() => signOut.mutate()}
      disabled={signOut.isPending}
      aria-label="Sign out"
      title="Sign out"
      className={cn(
        "flex h-8 shrink-0 items-center justify-center gap-2 rounded-[10px] text-sm font-semibold text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-50",
        withLabel ? "px-3" : "w-8",
      )}
    >
      <LogOut className="h-4 w-4" />
      {withLabel && "Sign out"}
    </button>
  );
}
