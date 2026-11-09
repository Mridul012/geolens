/**
 * Visibility as optical focus (docs/Frontend-Design.md §3): the lower the AI visibility
 * score, the more out of focus the site's own name renders. A perfect 100 is perfectly sharp;
 * an unmeasured score is blurrier than any measured one, so it never reads as "a low score".
 *
 * `scale` sizes the blur to the text it is applied to — the same score must look equally
 * out of focus on a 88px hero and a 28px strip.
 */
const MAX_BLUR_EM = 0.08;
const UNMEASURED_BLUR_EM = 0.1;

export function focusBlur(score: number | null, fontSizePx: number): string {
  const em =
    score === null
      ? UNMEASURED_BLUR_EM
      : (Math.max(0, 100 - Math.min(100, score)) / 100) * MAX_BLUR_EM;
  return `blur(${(em * fontSizePx).toFixed(2)}px)`;
}
