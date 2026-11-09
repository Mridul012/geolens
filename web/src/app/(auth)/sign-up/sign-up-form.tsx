"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation } from "@tanstack/react-query";
import { signUpBodySchema } from "@contracts/api/auth";
import type { SessionInfo } from "@contracts/api/auth";
import { apiFetch, ApiError } from "@/lib/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { GoogleSignInButton } from "@/components/google-sign-in-button";
import { OrDivider } from "@/components/or-divider";
import type { z } from "zod";

type SignUpValues = z.infer<typeof signUpBodySchema>;

export function SignUpForm() {
  const router = useRouter();
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<SignUpValues>({ resolver: zodResolver(signUpBodySchema) });

  const mutation = useMutation({
    mutationFn: (values: SignUpValues) =>
      apiFetch<SessionInfo>("/v1/auth/sign-up/email", { method: "POST", body: values }),
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
        <h2 className="text-2xl font-extrabold tracking-tight">Create your account</h2>
        <p className="mt-1.5 text-sm text-muted-foreground">
          No credit card. Free tier included.
        </p>
      </div>

      {mutation.isError && (
        <Alert variant="destructive">
          <AlertDescription>{errorMessage(mutation.error)}</AlertDescription>
        </Alert>
      )}

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="name">Name</Label>
        <Input id="name" autoComplete="name" {...register("name")} />
        {errors.name && <p className="text-xs text-destructive">{errors.name.message}</p>}
      </div>

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
          autoComplete="new-password"
          {...register("password")}
        />
        {errors.password && (
          <p className="text-xs text-destructive">{errors.password.message}</p>
        )}
      </div>

      <Button type="submit" disabled={mutation.isPending} className="mt-1">
        {mutation.isPending ? "Creating account…" : "Create account →"}
      </Button>

      <OrDivider />
      <GoogleSignInButton />

      <p className="text-center text-sm text-muted-foreground">
        Already have an account?{" "}
        <Link href="/sign-in" className="font-semibold text-foreground hover:text-primary">
          Sign in
        </Link>
      </p>
    </form>
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.problem.code === "EMAIL_IN_USE") return "That email is already registered.";
    return error.problem.detail ?? error.problem.title;
  }
  return "Something went wrong. Please try again.";
}
