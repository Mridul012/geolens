import { cn } from "@/lib/utils";

/**
 * The duochrome lens: an optician's red/green test split inside a ring. The brand's only
 * use of the pair as decoration (docs/Frontend-Design.md §3).
 */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cn("h-8 w-8 shrink-0", className)} aria-hidden="true">
      {/* Two half-discs rather than a clip-path: no SVG id to collide when the mark repeats. */}
      <path d="M16 3 A13 13 0 0 0 16 29 Z" fill="var(--duo-red)" />
      <path d="M16 3 A13 13 0 0 1 16 29 Z" fill="var(--duo-green)" />
      <circle cx="16" cy="16" r="13" fill="none" stroke="#000" strokeWidth="3" />
      <circle cx="16" cy="16" r="4.5" fill="#000" />
    </svg>
  );
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn("flex items-center gap-2.5", className)}>
      <BrandMark />
      <span className="text-xl font-extrabold tracking-[-0.02em]">GEOlens</span>
    </span>
  );
}
