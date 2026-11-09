"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation } from "@tanstack/react-query";
import { signInBodySchema } from "@contracts/api/auth";
import type { SessionInfo } from "@contracts/api/auth";
import { apiFetch, ApiError } from "@/lib/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import type { z } from "zod";

type SignInValues = z.infer<typeof signInBodySchema>;

export function SignInForm() {
  const router = useRouter();
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<SignInValues>({ resolver: zodResolver(signInBodySchema) });

  const mutation = useMutation({
    mutationFn: (values: SignInValues) =>
      apiFetch<SessionInfo>("/v1/auth/sign-in/email", { method: "POST", body: values }),
    onSuccess: () => {
      router.push("/projects");
      router.refresh();
    },
  });

  return (
    <form
      onSubmit={handleSubmit((values) => mutation.mutate(values))}
      className="flex w-full max-w-sm flex-col gap-5"
    >
      <div>
        <h2 className="text-2xl font-extrabold tracking-tight">Welcome back</h2>
        <p className="mt-1.5 text-sm text-muted-foreground">Sign in to your projects.</p>
      </div>

      {mutation.isError && (
        <Alert variant="destructive">
          <AlertDescription>{errorMessage(mutation.error)}</AlertDescription>
        </Alert>
      )}

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="email">Work email</Label>
        <Input id="email" type="email" autoComplete="email" {...register("email")} />
        {errors.email && <p className="text-xs text-destructive">{errors.email.message}</p>}
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="password">Password</Label>
        <Input
          id="password"
          type="password"
          autoComplete="current-password"
          {...register("password")}
        />
        {errors.password && (
          <p className="text-xs text-destructive">{errors.password.message}</p>
        )}
      </div>

      <Button type="submit" disabled={mutation.isPending} className="mt-1">
        {mutation.isPending ? "Signing in…" : "Sign in →"}
      </Button>

      <p className="text-center text-sm text-muted-foreground">
        New here?{" "}
        <Link href="/sign-up" className="font-semibold text-foreground hover:text-primary">
          Create an account
        </Link>
      </p>
    </form>
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.problem.code === "INVALID_CREDENTIALS") return "Invalid email or password.";
    return error.problem.detail ?? error.problem.title;
  }
  return "Something went wrong. Please try again.";
}
