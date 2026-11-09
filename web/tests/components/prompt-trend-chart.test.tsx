import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PromptRunTrend } from "@contracts/api/prompt-runs";
import {
  PromptTrendChart,
  segments,
} from "@/app/(app)/projects/[projectId]/prompts/prompt-trend-chart";

type Point = PromptRunTrend["data"][number];

function point(index: number, overrides: Partial<Point> = {}): Point {
  return {
    runId: `00000000-0000-0000-0000-00000000000${index}`,
    at: `2026-11-0${index}T10:00:00.000Z`,
    mentionRate: 40 + index,
    citationShare: 10 + index,
    perEngine: [
      { engine: "perplexity", mentionRate: 50, citationShare: 20 },
      { engine: "openai", mentionRate: 30, citationShare: 5 },
    ],
    ...overrides,
  };
}

describe("PromptTrendChart", () => {
  it("waits for a second run before drawing a direction", () => {
    render(<PromptTrendChart trend={[point(1)]} />);
    expect(screen.getByText(/appears after two prompt runs/i)).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("draws the overall line plus one line per engine, with readable engine names", () => {
    const { container } = render(<PromptTrendChart trend={[point(1), point(2), point(3)]} />);

    expect(screen.getByText("All engines")).toBeInTheDocument();
    expect(screen.getByText("Perplexity")).toBeInTheDocument();
    expect(screen.getByText("ChatGPT")).toBeInTheDocument();
    expect(container.querySelector('[data-series="overall"]')).not.toBeNull();
    expect(container.querySelector('[data-series="perplexity"]')).not.toBeNull();
    expect(container.querySelector('[data-series="openai"]')).not.toBeNull();
  });

  it("switches between mention rate and citation share", async () => {
    const user = userEvent.setup();
    render(<PromptTrendChart trend={[point(1), point(2)]} />);

    expect(screen.getByRole("img")).toHaveAccessibleName(/mention rate across 2 prompt runs/i);
    await user.click(screen.getByRole("button", { name: "Citation share" }));
    expect(screen.getByRole("button", { name: "Citation share" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("img")).toHaveAccessibleName(/citation share across 2 prompt runs/i);
  });

  it("leaves a gap for a run that couldn't be measured instead of dropping to zero", () => {
    const { container } = render(
      <PromptTrendChart
        trend={[point(1), point(2, { mentionRate: null }), point(3), point(4)]}
      />,
    );
    // Run 2 is unmeasured: the overall line splits into a lone dot (run 1) and a line (3→4).
    const overallLines = container.querySelectorAll('[data-series="overall"]:not([data-lone])');
    expect(overallLines).toHaveLength(1);
    expect(overallLines[0]!.getAttribute("points")!.split(" ")).toHaveLength(2);
    expect(container.querySelectorAll('[data-series="overall"][data-lone]')).toHaveLength(1);
  });
});

describe("segments", () => {
  it("splits on nulls and keeps each point's run index", () => {
    expect(segments([10, 20, null, 30, null, null, 40, 50])).toEqual([
      [
        { index: 0, value: 10 },
        { index: 1, value: 20 },
      ],
      [{ index: 3, value: 30 }],
      [
        { index: 6, value: 40 },
        { index: 7, value: 50 },
      ],
    ]);
  });

  it("treats a measured zero as a real value, not a gap", () => {
    expect(segments([0, 0])).toEqual([
      [
        { index: 0, value: 0 },
        { index: 1, value: 0 },
      ],
    ]);
  });
});
