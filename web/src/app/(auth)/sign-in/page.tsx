import { AuthHero } from "@/components/auth-hero";
import { SignInForm } from "./sign-in-form";

export default function SignInPage() {
  return (
    <div className="flex w-full max-w-4xl overflow-hidden rounded-3xl border border-border bg-card shadow-sm">
      <AuthHero />
      <div className="flex flex-1 items-center justify-center p-10 sm:p-16">
        <SignInForm />
      </div>
    </div>
  );
}
