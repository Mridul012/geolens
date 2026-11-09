import { AuthHero } from "@/components/auth-hero";
import { SignInForm } from "./sign-in-form";

export default function SignInPage() {
  return (
    <div className="panel flex w-full max-w-5xl overflow-hidden">
      <AuthHero />
      <div className="flex flex-1 items-center justify-center p-6 sm:p-16">
        <SignInForm />
      </div>
    </div>
  );
}
