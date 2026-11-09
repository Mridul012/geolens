import { AuthHero } from "@/components/auth-hero";
import { SignUpForm } from "./sign-up-form";

export default function SignUpPage() {
  return (
    <div className="flex w-full max-w-4xl overflow-hidden rounded-3xl border border-border bg-card shadow-sm">
      <AuthHero />
      <div className="flex flex-1 items-center justify-center p-10 sm:p-16">
        <SignUpForm />
      </div>
    </div>
  );
}
