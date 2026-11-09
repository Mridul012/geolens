/** Shared failure vocabulary for the project use cases. */
import { invalidUrl, planLimitExceeded } from "../../domain/shared/app-error.js";
import type { AppError } from "../../domain/shared/app-error.js";
import type { UrlRejection } from "../../domain/crawl/url.js";
import type { PlanTier } from "../../config/plans.js";

/** Turns a normalization rejection into the contract's `INVALID_URL` with a real reason. */
export function urlRejectionToError(reason: UrlRejection, field: string): AppError {
  const detail: Record<UrlRejection, string> = {
    malformed: "That does not look like a web address.",
    unsupported_scheme: "Only http and https addresses can be crawled.",
    unsupported_port: "Only the standard web ports (80 and 443) can be crawled.",
    missing_host: "The address is missing a domain name.",
    non_public_host:
      "That address is not publicly reachable. We only crawl public websites — private, loopback and internal addresses are refused.",
  };
  return invalidUrl(`${field}: ${detail[reason]}`);
}

export function projectLimitError(plan: PlanTier, limit: number): AppError {
  return planLimitExceeded(
    limit === 1
      ? `The ${plan} plan allows 1 project. Upgrade to track more.`
      : `The ${plan} plan allows ${limit} projects.`,
  );
}

export function competitorLimitError(plan: PlanTier, limit: number): AppError {
  return planLimitExceeded(
    `The ${plan} plan allows ${limit} competitor${limit === 1 ? "" : "s"} per project.`,
  );
}
