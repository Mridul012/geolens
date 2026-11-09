/**
 * The buyer stage vocabulary, in the domain so both `config/scoring/` and the scoring
 * maths can name it without either depending on the other (ADR 0004).
 *
 * The authoritative definition of the three values is `contracts/ai/taxonomy.ts`; this is
 * the same union, restated where pure code can reach it.
 */
export type TopicBuyerIntent = "awareness" | "consideration" | "decision";
