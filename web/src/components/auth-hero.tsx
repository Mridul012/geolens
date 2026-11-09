export function AuthHero() {
  return (
    <div className="relative hidden flex-1 flex-col justify-center overflow-hidden rounded-l-3xl bg-gradient-to-br from-accent to-background px-16 py-12 lg:flex">
      <div className="absolute -top-20 -right-20 h-80 w-80 rounded-full bg-primary/10" />
      <div className="absolute -bottom-24 -left-16 h-64 w-64 rounded-full bg-primary/10" />

      <div className="relative flex items-center gap-2.5">
        <div className="flex h-9 w-9 items-center justify-center rounded-[11px] bg-primary">
          <CheckIcon className="h-4.5 w-4.5 text-primary-foreground" />
        </div>
        <span className="text-lg font-extrabold tracking-tight">Vryse</span>
      </div>

      <h1 className="relative mt-14 max-w-md text-4xl leading-tight font-extrabold tracking-tight">
        Know what AI engines say about you — before your buyers do.
      </h1>
      <p className="relative mt-4 max-w-sm text-muted-foreground">
        Track citations across ChatGPT and Perplexity, check whether AI crawlers can even
        read your site, and get a prioritized fix list.
      </p>

      <ul className="relative mt-10 flex flex-col gap-4">
        {[
          "Free AI crawler access check — no card required",
          "First real insight in under 10 minutes",
        ].map((item) => (
          <li key={item} className="flex items-center gap-3 text-sm">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary">
              <CheckIcon className="h-3 w-3 text-primary-foreground" />
            </span>
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className}>
      <path
        d="M4 12L10 18L20 6"
        stroke="currentColor"
        strokeWidth={2.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
