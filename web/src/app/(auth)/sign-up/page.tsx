import { AuthHero } from "@/components/auth-hero";
import { SignUpForm } from "./sign-up-form";

export default function SignUpPage() {
  return (
    <div className="panel flex w-full max-w-5xl overflow-hidden">
      <AuthHero />
      <div className="flex flex-1 items-center justify-center p-6 sm:p-16">
        <SignUpForm />
      </div>
    </div>
  );
}
