import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { PageLens } from "@/components/page-lens";
import type { LensPage } from "@/lib/evidence";

function lensPage(overrides: Partial<LensPage> = {}): LensPage {
  return {
    id: "page-1",
    url: "https://acme.example/pricing",
    title: "Pricing",
    qualityScore: 40,
    wordCount: 320,
    cited: false,
    sections: [{ heading: "Plans", text: "Starter is $9 a month." }],
    ...overrides,
  };
}

describe("PageLens", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the page blurred as AI finds it, with a sharp copy for the lens", () => {
    const { container } = render(<PageLens page={lensPage()} />);

    // Two copies of the article: the blurred page and the sharp one revealed by the lens.
    expect(screen.getAllByText("Starter is $9 a month.")).toHaveLength(2);
    const blurred = container.querySelector('[aria-hidden="true"][style*="blur"]');
    expect(blurred).not.toBeNull();
  });

  it("renders a cited page with no blur at all", () => {
    const { container } = render(<PageLens page={lensPage({ cited: true })} />);
    expect(container.querySelector('[style*="blur"]')).toBeNull();
  });

  it("engraves the page's evidence on the rim", () => {
    render(<PageLens page={lensPage({ cited: true, qualityScore: 82 })} />);
    expect(screen.getByText(/Cited by AI\s+◦\s+Quality 82\s+◦\s+320 words/)).toBeInTheDocument();
  });

  it("says when a page was never scored instead of showing a number", () => {
    render(<PageLens page={lensPage({ qualityScore: null })} />);
    expect(screen.getByText(/Quality not scored/)).toBeInTheDocument();
  });

  it("moves with the arrow keys for keyboard users", () => {
    // jsdom lays nothing out; give the stage a real size so the lens has room to move.
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
    render(<PageLens page={lensPage()} />);
    const lens = screen.getByRole("group", { name: /lens/i });
    const before = lens.style.transform;

    fireEvent.keyDown(lens, { key: "ArrowDown" });

    expect(lens.style.transform).not.toBe(before);
  });

  it("explains a page with no extracted text", () => {
    render(<PageLens page={lensPage({ sections: [] })} />);
    expect(screen.getAllByText("No readable text was extracted from this page.")).toHaveLength(2);
  });
});
