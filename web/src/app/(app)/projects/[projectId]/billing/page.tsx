import type { Me } from "@contracts/api/auth";
import { apiFetchServer } from "@/lib/api/server";
import { BillingView } from "./billing-view";

export default async function ProjectBillingPage() {
  const me = await apiFetchServer<Me>("/v1/me");

  return <BillingView initialMe={me} />;
}
