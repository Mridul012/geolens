"use client";

/**
 * "Through the lens": a crawled page shown as AI engines find it — blurred by
 * `pageBlurPx` — with a lens the user drags (or moves with the arrow keys) to read it as they
 * wrote it. The lens moves by writing element styles directly, never React state per frame,
 * so dragging stays off the render path.
 */
import { useCallback, useEffect, useRef, type KeyboardEvent, type PointerEvent } from "react";
import { pageBlurPx, type LensPage } from "@/lib/evidence";

const LENS_RADIUS = 104;
const RIM = 14;
const SECTION_LIMIT = 6;
const SECTION_CHARS = 700;

export function PageLens({ page }: { page: LensPage }) {
  const stageRef = useRef<HTMLDivElement>(null);
  const sharpRef = useRef<HTMLDivElement>(null);
  const lensRef = useRef<HTMLDivElement>(null);
  const position = useRef({ x: 0, y: 0 });
  const dragging = useRef(false);
  const blur = pageBlurPx(page);

  const place = useCallback((x: number, y: number) => {
    const stage = stageRef.current;
    if (!stage) return;
    const half = LENS_RADIUS * 0.5;
    const nx = Math.max(half, Math.min(stage.clientWidth - half, x));
    const ny = Math.max(half, Math.min(stage.clientHeight - half, y));
    position.current = { x: nx, y: ny };
    if (sharpRef.current) sharpRef.current.style.clipPath = `circle(${LENS_RADIUS}px at ${nx}px ${ny}px)`;
    if (lensRef.current) {
      lensRef.current.style.transform = `translate(${nx - LENS_RADIUS - RIM}px, ${ny - LENS_RADIUS - RIM}px)`;
    }
  }, []);

  useEffect(() => {
    const stage = stageRef.current;
    if (stage) place(stage.clientWidth * 0.62, Math.min(220, stage.clientHeight / 2));
  }, [place]);

  const pointFrom = (event: PointerEvent<HTMLDivElement>) => {
    const rect = stageRef.current!.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    dragging.current = true;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const { x, y } = pointFrom(event);
    place(x, y);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    const { x, y } = pointFrom(event);
    place(x, y);
  };
  const stopDragging = () => {
    dragging.current = false;
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 64 : 24;
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const move = moves[event.key];
    if (!move) return;
    event.preventDefault();
    place(position.current.x + move[0], position.current.y + move[1]);
  };

  const rim = [
    page.cited ? "Cited by AI" : "Not cited",
    page.qualityScore === null ? "Quality not scored" : `Quality ${page.qualityScore}`,
    page.wordCount === null ? null : `${page.wordCount} words`,
  ]
    .filter(Boolean)
    .join("  ◦  ");
  const size = (LENS_RADIUS + RIM) * 2;
  const c = LENS_RADIUS + RIM;

  return (
    <div>
      <div
        ref={stageRef}
        className="panel relative cursor-grab touch-none overflow-hidden select-none active:cursor-grabbing"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={stopDragging}
        onPointerCancel={stopDragging}
      >
        <div style={{ filter: blur > 0 ? `blur(${blur.toFixed(2)}px)` : undefined }} aria-hidden="true">
          <LensArticle page={page} />
        </div>
        <div ref={sharpRef} className="absolute inset-0 bg-card" style={{ clipPath: "circle(0px at 0 0)" }}>
          <LensArticle page={page} />
        </div>

        <div
          ref={lensRef}
          tabIndex={0}
          role="group"
          aria-label="Lens: shows this page as you wrote it. Drag it, or use the arrow keys to move it."
          onKeyDown={onKeyDown}
          className="group pointer-events-none absolute top-0 left-0 rounded-full outline-none"
          style={{ width: size, height: size }}
        >
          <svg viewBox={`0 0 ${size} ${size}`} className="h-full w-full overflow-visible" aria-hidden="true">
            <circle
              cx={c}
              cy={c}
              r={LENS_RADIUS + 4}
              fill="none"
              strokeWidth="10"
              className="stroke-foreground group-focus-visible:stroke-[var(--ring)]"
            />
            <path
              d={`M${c} ${c - LENS_RADIUS + 1} A ${LENS_RADIUS - 1} ${LENS_RADIUS - 1} 0 0 0 ${c} ${c + LENS_RADIUS - 1}`}
              fill="none"
              stroke="var(--duo-red)"
              strokeWidth="1.5"
            />
            <path
              d={`M${c} ${c - LENS_RADIUS + 1} A ${LENS_RADIUS - 1} ${LENS_RADIUS - 1} 0 0 1 ${c} ${c + LENS_RADIUS - 1}`}
              fill="none"
              stroke="var(--duo-green)"
              strokeWidth="1.5"
            />
            <defs>
              <path
                id={`lens-rim-${page.id}`}
                d={`M ${c} ${c} m -${LENS_RADIUS + 13} 0 a ${LENS_RADIUS + 13} ${LENS_RADIUS + 13} 0 1 1 ${(LENS_RADIUS + 13) * 2} 0`}
              />
            </defs>
            {/* Engraved like a lens rim — the one place capitals are the subject's own vernacular. */}
            <text className="fill-foreground text-[10px] font-bold tracking-[0.18em] uppercase">
              <textPath href={`#lens-rim-${page.id}`} startOffset="50%" textAnchor="middle">
                {rim}
              </textPath>
            </text>
          </svg>
        </div>
      </div>
      <p className="mt-3 text-sm text-muted-foreground">
        Drag the lens, or focus it and use the arrow keys. Inside the lens is the page as you wrote it; outside is how
        clearly AI engines can use it — sharp only where an AI answer cited it.
      </p>
    </div>
  );
}

function LensArticle({ page }: { page: LensPage }) {
  return (
    <article className="px-8 py-9 md:px-12">
      <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{page.url}</p>
      <h3 className="mt-2 text-[37px] leading-tight font-extrabold tracking-[-0.02em] [overflow-wrap:anywhere]">
        {page.title}
      </h3>
      <div className="mt-6 flex max-w-[68ch] flex-col gap-5">
        {page.sections.length === 0 ? (
          <p className="text-muted-foreground">No readable text was extracted from this page.</p>
        ) : (
          page.sections.slice(0, SECTION_LIMIT).map((section, index) => (
            <section key={index}>
              {section.heading && <h4 className="mb-1.5 text-lg font-bold">{section.heading}</h4>}
              <p className="leading-relaxed">
                {section.text.length > SECTION_CHARS ? `${section.text.slice(0, SECTION_CHARS)}…` : section.text}
              </p>
            </section>
          ))
        )}
      </div>
    </article>
  );
}
