"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import type { Me } from "@contracts/api/auth";
import type { CheckoutUrl } from "@contracts/api/billing";
import { apiFetch, ApiError } from "@/lib/api/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress, ProgressLabel, ProgressValue } from "@/components/ui/progress";

const USAGE_FIELDS: { key: keyof Me["usage"]; label: string }[] = [
  { key: "projects", label: "Projects" },
  { key: "activePrompts", label: "Active prompts" },
  { key: "onDemandRunsThisWeek", label: "On-demand runs this week" },
];

export function BillingView({ initialMe }: { initialMe: Me }) {
  const { data: me } = useQuery({
    queryKey: ["me"],
    queryFn: () => apiFetch<Me>("/v1/me"),
    initialData: initialMe,
  });

  // Both checkout and portal hand off to Stripe — there is nothing to invalidate or
  // navigate to internally, so the mutation's only job is to fetch the redirect URL.
  const checkout = useMutation({
    mutationFn: () => apiFetch<CheckoutUrl>("/v1/billing/checkout", { method: "POST", body: {} }),
    onSuccess: ({ url }) => {
      window.location.href = url;
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const portal = useMutation({
    mutationFn: () => apiFetch<CheckoutUrl>("/v1/billing/portal", { method: "POST", body: {} }),
    onSuccess: ({ url }) => {
      window.location.href = url;
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  return (
    <div className="flex flex-col gap-6 p-5 md:p-10">
      <div>
        <h1 className="text-[28px] leading-tight font-extrabold tracking-[-0.02em]">Billing</h1>
        <p className="text-sm text-muted-foreground">Manage your plan and usage.</p>
      </div>

      <div className="panel p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <Badge variant={me.plan === "PRO" ? "default" : "secondary"}>{me.plan}</Badge>
            <span className="text-lg font-bold">{me.plan === "PRO" ? "Pro plan" : "Free plan"}</span>
          </div>
          {me.plan === "FREE" ? (
            <Button onClick={() => checkout.mutate()} disabled={checkout.isPending}>
              {checkout.isPending ? "Redirecting…" : "Upgrade to Pro"}
            </Button>
          ) : (
            <Button variant="outline" onClick={() => portal.mutate()} disabled={portal.isPending}>
              {portal.isPending ? "Redirecting…" : "Manage billing"}
            </Button>
          )}
        </div>
      </div>

      <div className="panel p-6">
        <span className="section-label">Usage</span>
        <div className="mt-4 flex flex-col gap-5">
          {USAGE_FIELDS.map(({ key, label }) => {
            const counter = me.usage[key];
            const percent = counter.limit === 0 ? 0 : (counter.used / counter.limit) * 100;
            return (
              <Progress key={key} value={percent} aria-label={label}>
                <ProgressLabel>{label}</ProgressLabel>
                <ProgressValue>{() => `${counter.used} / ${counter.limit}`}</ProgressValue>
              </Progress>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.problem.detail ?? error.problem.title;
  return "Something went wrong. Please try again.";
}
