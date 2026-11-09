import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";

export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (session) redirect("/projects");

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-6 py-12">
      {children}
    </div>
  );
}
