import { Wordmark } from "@/components/brand-mark";

/**
 * An eye chart that asks the product's question. Each acuity line is smaller and a little
 * further out of focus than the last — the same blur the dashboard uses to show how clearly
 * AI engines can see a site. The acuity column is a real sequence, so it is numbered.
 */
const LINES: ReadonlyArray<{ letters: string; acuity: string; size: string; blur: number }> = [
  { letters: "CAN", acuity: "20/200", size: "text-[89px]", blur: 0 },
  { letters: "AI", acuity: "20/100", size: "text-[67px]", blur: 0 },
  { letters: "SEE", acuity: "20/50", size: "text-[50px]", blur: 0.6 },
  { letters: "YOU?", acuity: "20/30", size: "text-[37px]", blur: 1.6 },
  { letters: "BEFORE YOUR BUYERS DO", acuity: "20/20", size: "text-[16px]", blur: 2.4 },
];

export function AuthHero() {
  return (
    <div className="relative hidden flex-1 flex-col border-r border-border bg-card px-14 py-12 lg:flex">
      <Wordmark />

      <h1 className="sr-only">Can AI see you before your buyers do?</h1>
      <div aria-hidden="true" className="mt-12 flex flex-col gap-3">
        {LINES.map((line) => (
          <div key={line.acuity} className="grid grid-cols-[3.5rem_1fr] items-center gap-6">
            <span className="text-right text-xs text-muted-foreground tabular-nums">
              {line.acuity}
            </span>
            <span
              className={`${line.size} justify-self-center pl-[0.22em] leading-none font-extrabold tracking-[0.22em]`}
              style={line.blur > 0 ? { filter: `blur(${line.blur}px)` } : undefined}
            >
              {line.letters}
            </span>
          </div>
        ))}
      </div>

      <div className="mt-auto max-w-sm pt-12">
        <p className="text-[21px] leading-snug font-bold tracking-[-0.01em]">
          GEOlens checks how clearly ChatGPT and Perplexity can read, retrieve and cite your
          site — then tells you what to fix.
        </p>
        <p className="mt-4 text-sm text-muted-foreground">
          The AI crawler check is free, no card needed. First results arrive in about ten
          minutes.
        </p>
      </div>
    </div>
  );
}
