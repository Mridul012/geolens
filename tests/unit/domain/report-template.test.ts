/**
 * The report page (M17) — pure HTML generation against fixed data.
 *
 * The rule under test: every section either shows real data or an honest "not available
 * yet" placeholder — a report requested an hour into a new account must render cleanly,
 * not blow up or silently omit a section.
 */
import { describe, expect, it } from "vitest";
import { renderReportHtml, type ReportTemplateData } from "../../../src/domain/reports/template.js";

const FULL_DATA: ReportTemplateData = {
  projectName: "Acme",
  domain: "acme.com",
  generatedAt: "2026-09-01T00:00:00.000Z",
  sections: ["summary", "score", "trends", "recommendations", "comparison"],
  summary: {
    executiveSummary: "Acme is visible for pricing questions but weak on comparisons.",
    strengths: ["Strong pricing page", "Fast site"],
    weaknesses: ["No comparison content"],
  },
  score: {
    composite: 72,
    citation: 60,
    retrievability: 80,
    contentQuality: 75,
    topicCoverage: 65,
    technical: 90,
    trust: 55,
  },
  trend: [
    { date: "2026-08-01T00:00:00.000Z", composite: 60 },
    { date: "2026-09-01T00:00:00.000Z", composite: 72 },
  ],
  recommendations: [
    { title: "Add comparison page", priority: "HIGH", impact: 4, difficulty: 2 },
    { title: "Fix meta descriptions", priority: "LOW", impact: 2, difficulty: 1 },
  ],
  comparison: {
    own: { domain: "acme.com", aiVisibility: 72, topicCoverage: 65, authority: 50 },
    competitor: { domain: "rival.com", aiVisibility: 60, topicCoverage: 55, authority: 40 },
    missingTopics: [{ label: "Migration guides", ownCoverage: 5, competitorCoverage: 85, gap: 80 }],
  },
};

const EMPTY_DATA: ReportTemplateData = {
  projectName: "Fresh Co",
  domain: "fresh.co",
  generatedAt: "2026-09-01T00:00:00.000Z",
  sections: ["summary", "score", "trends", "recommendations", "comparison"],
  summary: null,
  score: null,
  trend: [],
  recommendations: [],
  comparison: { own: { domain: "fresh.co", aiVisibility: null, topicCoverage: null, authority: null }, competitor: null, missingTopics: [] },
};

describe("renderReportHtml", () => {
  it("produces a full HTML document with the project's name and domain", () => {
    const html = renderReportHtml(FULL_DATA);
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("Acme");
    expect(html).toContain("acme.com");
  });

  it("renders real content for every populated section", () => {
    const html = renderReportHtml(FULL_DATA);
    expect(html).toContain("Acme is visible for pricing questions");
    expect(html).toContain("Strong pricing page");
    expect(html).toContain("72"); // composite score
    expect(html).toContain("Add comparison page");
    expect(html).toContain("rival.com");
    expect(html).toContain("Migration guides");
  });

  it("renders an honest placeholder for every null section rather than omitting it or crashing", () => {
    const html = renderReportHtml(EMPTY_DATA);
    expect(html).toContain("No executive summary yet");
    expect(html).toContain("No score yet");
    expect(html).toContain("No trend history yet");
    expect(html).toContain("No open recommendations");
    expect(html).toContain("No competitor tracked yet");
  });

  it("omits a section entirely when it was not requested", () => {
    const html = renderReportHtml({ ...FULL_DATA, sections: ["score"] });
    expect(html).toContain("AI Visibility Score");
    expect(html).not.toContain("Executive Summary");
    expect(html).not.toContain("Score Trend");
    expect(html).not.toContain("Recommendations</h2>");
    expect(html).not.toContain("Competitor Comparison");
  });

  it("escapes HTML in user-controlled strings rather than injecting them raw", () => {
    const html = renderReportHtml({
      ...FULL_DATA,
      projectName: '<script>alert("x")</script>',
      summary: { executiveSummary: "<img src=x onerror=alert(1)>", strengths: [], weaknesses: [] },
    });
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("<img src=x onerror");
    expect(html).toContain("&lt;script&gt;");
  });

  it("sorts recommendations by priority, most urgent first", () => {
    const html = renderReportHtml({
      ...FULL_DATA,
      recommendations: [
        { title: "Low one", priority: "LOW", impact: 1, difficulty: 1 },
        { title: "Critical one", priority: "CRITICAL", impact: 5, difficulty: 3 },
        { title: "Medium one", priority: "MEDIUM", impact: 3, difficulty: 2 },
      ],
    });
    const criticalIndex = html.indexOf("Critical one");
    const mediumIndex = html.indexOf("Medium one");
    const lowIndex = html.indexOf("Low one");
    expect(criticalIndex).toBeLessThan(mediumIndex);
    expect(mediumIndex).toBeLessThan(lowIndex);
  });

  it("is deterministic — the same data always prints the same page", () => {
    expect(renderReportHtml(FULL_DATA)).toBe(renderReportHtml(FULL_DATA));
  });
});
