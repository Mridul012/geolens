/**
 * Maps a Stripe subscription status onto our own (docs/Database.md §2.3's
 * `SubscriptionStatus` enum: TRIALING, ACTIVE, PAST_DUE, CANCELED). Pure: Stripe's status
 * vocabulary is wider than ours, and this is the one place that narrowing happens.
 */
export type SubscriptionStatus = "TRIALING" | "ACTIVE" | "PAST_DUE" | "CANCELED";

/**
 * Stripe's subscription statuses. `incomplete`/`incomplete_expired` cover a checkout that
 * never collected a valid payment method, and `paused` a subscription on a billing pause —
 * none of them grant entitlements, so all three fall out to CANCELED alongside a genuine
 * cancellation. `unpaid` keeps PAST_DUE's grace-period framing rather than an immediate cutoff.
 */
export function mapStripeSubscriptionStatus(status: string): SubscriptionStatus {
  switch (status) {
    case "trialing":
      return "TRIALING";
    case "active":
      return "ACTIVE";
    case "past_due":
    case "unpaid":
      return "PAST_DUE";
    default:
      return "CANCELED";
  }
}
