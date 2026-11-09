/**
 * The report page (docs/Architecture.md §"Reports: server-rendered page → PDF via
 * Playwright print") — pure HTML generation from already-fetched data.
 *
 * Pure and synchronous by construction: everything this file needs has already been read
 * by the time it runs, so the same `ReportTemplateData` always prints the same page. The
 * infrastructure layer's job is only to hand Chromium the string this returns.
 *
 * Every field is nullable and every null renders as an honest "not available yet" block
 * rather than a missing section — a report generated an hour into a new account is not a
 * broken report.
 */
import type { ReportSection } from "../../contracts/api/reports.js";

export interface ReportComponentScores {
  readonly composite: number;
  readonly citation: number | null;
  readonly retrievability: number | null;
  readonly contentQuality: number | null;
  readonly topicCoverage: number | null;
  readonly technical: number | null;
  readonly trust: number | null;
}

export interface ReportSummary {
  readonly executiveSummary: string | null;
  readonly strengths: readonly string[];
  readonly weaknesses: readonly string[];
}

export interface ReportRecommendation {
  readonly title: string;
  readonly priority: string;
  readonly impact: number;
  readonly difficulty: number;
}

export interface ReportComparisonSide {
  readonly domain: string;
  readonly aiVisibility: number | null;
  readonly topicCoverage: number | null;
  readonly authority: number | null;
}

export interface ReportMissingTopic {
  readonly label: string;
  readonly ownCoverage: number | null;
  readonly competitorCoverage: number | null;
  readonly gap: number | null;
}

export interface ReportComparison {
  readonly own: ReportComparisonSide;
  readonly competitor: ReportComparisonSide | null;
  readonly missingTopics: readonly ReportMissingTopic[];
}

export interface ReportTemplateData {
  readonly projectName: string;
  readonly domain: string;
  readonly generatedAt: string;
  readonly sections: readonly ReportSection[];
  readonly summary: ReportSummary | null;
  readonly score: ReportComponentScores | null;
  readonly trend: ReadonlyArray<{ readonly date: string; readonly composite: number }>;
  readonly recommendations: readonly ReportRecommendation[];
  readonly comparison: ReportComparison | null;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatScore(value: number | null): string {
  return value === null ? "—" : String(Math.round(value));
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? escapeHtml(iso)
    : date.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

function placeholder(message: string): string {
  return `<p class="placeholder">${escapeHtml(message)}</p>`;
}

function renderSummary(summary: ReportSummary | null): string {
  if (summary === null || (summary.executiveSummary === null && summary.strengths.length === 0)) {
    return placeholder("No executive summary yet — this appears after the first completed crawl.");
  }
  const strengths = summary.strengths
    .map((item) => `<li class="strength">${escapeHtml(item)}</li>`)
    .join("");
  const weaknesses = summary.weaknesses
    .map((item) => `<li class="weakness">${escapeHtml(item)}</li>`)
    .join("");
  return `
    ${summary.executiveSummary === null ? "" : `<p class="lede">${escapeHtml(summary.executiveSummary)}</p>`}
    ${strengths.length === 0 ? "" : `<h3>Strengths</h3><ul>${strengths}</ul>`}
    ${weaknesses.length === 0 ? "" : `<h3>Weaknesses</h3><ul>${weaknesses}</ul>`}
  `;
}

const COMPONENT_LABELS: ReadonlyArray<{ readonly key: keyof ReportComponentScores; readonly label: string }> = [
  { key: "citation", label: "AI Citation" },
  { key: "retrievability", label: "Retrievability" },
  { key: "contentQuality", label: "Content Quality" },
  { key: "topicCoverage", label: "Topic Coverage" },
  { key: "technical", label: "Technical" },
  { key: "trust", label: "Trust" },
];

function renderScore(score: ReportComponentScores | null): string {
  if (score === null) {
    return placeholder("No score yet — the publication floor has not been met.");
  }
  const rows = COMPONENT_LABELS.map(
    ({ key, label }) => `
      <tr>
        <td>${escapeHtml(label)}</td>
        <td class="num">${formatScore(score[key])}</td>
      </tr>`,
  ).join("");
  return `
    <div class="composite">
      <span class="composite-value">${formatScore(score.composite)}</span>
      <span class="composite-label">AI Visibility Score</span>
    </div>
    <table class="breakdown">
      <thead><tr><th>Component</th><th class="num">Score</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function renderTrend(trend: ReportTemplateData["trend"]): string {
  if (trend.length === 0) {
    return placeholder("No trend history yet — scores accumulate one point per crawl.");
  }
  const rows = trend
    .map(
      (point) => `
      <tr>
        <td>${formatDate(point.date)}</td>
        <td class="num">${formatScore(point.composite)}</td>
      </tr>`,
    )
    .join("");
  return `
    <table class="trend">
      <thead><tr><th>Date</th><th class="num">Composite</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

const PRIORITY_ORDER: Readonly<Record<string, number>> = {
  CRITICAL: 0,
  HIGH: 1,
  MEDIUM: 2,
  LOW: 3,
};

function renderRecommendations(recommendations: readonly ReportRecommendation[]): string {
  if (recommendations.length === 0) {
    return placeholder("No open recommendations — either everything is fixed, or nothing has run yet.");
  }
  const rows = [...recommendations]
    .sort((a, b) => (PRIORITY_ORDER[a.priority] ?? 9) - (PRIORITY_ORDER[b.priority] ?? 9))
    .map(
      (rec) => `
      <tr>
        <td>${escapeHtml(rec.title)}</td>
        <td><span class="priority priority-${escapeHtml(rec.priority.toLowerCase())}">${escapeHtml(rec.priority)}</span></td>
        <td class="num">${rec.impact}</td>
        <td class="num">${rec.difficulty}</td>
      </tr>`,
    )
    .join("");
  return `
    <table class="recommendations">
      <thead><tr><th>Recommendation</th><th>Priority</th><th class="num">Impact</th><th class="num">Effort</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function renderComparison(comparison: ReportComparison | null): string {
  if (comparison === null || comparison.competitor === null) {
    return placeholder("No competitor tracked yet — add one to unlock side-by-side comparison.");
  }
  const { own, competitor, missingTopics } = comparison;
  const topicRows = missingTopics
    .map(
      (topic) => `
      <tr>
        <td>${escapeHtml(topic.label)}</td>
        <td class="num">${formatScore(topic.ownCoverage)}</td>
        <td class="num">${formatScore(topic.competitorCoverage)}</td>
      </tr>`,
    )
    .join("");
  return `
    <table class="comparison">
      <thead><tr><th></th><th class="num">${escapeHtml(own.domain)}</th><th class="num">${escapeHtml(competitor.domain)}</th></tr></thead>
      <tbody>
        <tr><td>AI Visibility</td><td class="num">${formatScore(own.aiVisibility)}</td><td class="num">${formatScore(competitor.aiVisibility)}</td></tr>
        <tr><td>Topic Coverage</td><td class="num">${formatScore(own.topicCoverage)}</td><td class="num">${formatScore(competitor.topicCoverage)}</td></tr>
        <tr><td>Authority</td><td class="num">${formatScore(own.authority)}</td><td class="num">${formatScore(competitor.authority)}</td></tr>
      </tbody>
    </table>
    ${
      topicRows.length === 0
        ? ""
        : `<h3>Biggest Gaps</h3>
           <table class="topics">
             <thead><tr><th>Topic</th><th class="num">You</th><th class="num">Competitor</th></tr></thead>
             <tbody>${topicRows}</tbody>
           </table>`
    }
  `;
}

const SECTION_RENDERERS: Readonly<
  Record<ReportSection, { readonly title: string; readonly render: (data: ReportTemplateData) => string }>
> = {
  summary: { title: "Executive Summary", render: (data) => renderSummary(data.summary) },
  score: { title: "AI Visibility Score", render: (data) => renderScore(data.score) },
  trends: { title: "Score Trend", render: (data) => renderTrend(data.trend) },
  recommendations: {
    title: "Recommendations",
    render: (data) => renderRecommendations(data.recommendations),
  },
  comparison: { title: "Competitor Comparison", render: (data) => renderComparison(data.comparison) },
};

/** The stylesheet is inlined: a printed page has no network to fetch one from. */
const STYLE = `
  * { box-sizing: border-box; }
  body { font-family: -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; color: #1a1a2e; margin: 0; }
  .page { padding: 48px; }
  header { display: flex; justify-content: space-between; align-items: baseline; border-bottom: 2px solid #1a1a2e; padding-bottom: 16px; margin-bottom: 24px; }
  header h1 { font-size: 22px; margin: 0; }
  header .domain { color: #555; font-size: 13px; }
  header .generated { color: #888; font-size: 11px; }
  section { margin-bottom: 32px; page-break-inside: avoid; }
  section h2 { font-size: 15px; text-transform: uppercase; letter-spacing: 0.04em; color: #444; border-bottom: 1px solid #ddd; padding-bottom: 6px; }
  h3 { font-size: 13px; margin: 12px 0 4px; }
  .lede { font-size: 13px; line-height: 1.5; }
  ul { margin: 4px 0; padding-left: 20px; font-size: 12px; }
  .placeholder { color: #999; font-style: italic; font-size: 12px; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; margin-top: 8px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #eee; }
  th.num, td.num { text-align: right; }
  .composite { display: flex; align-items: baseline; gap: 8px; margin-bottom: 8px; }
  .composite-value { font-size: 36px; font-weight: 700; }
  .composite-label { color: #666; font-size: 12px; }
  .priority { padding: 2px 6px; border-radius: 3px; font-size: 10px; font-weight: 600; }
  .priority-critical { background: #fde2e2; color: #9b1c1c; }
  .priority-high { background: #fef3c7; color: #92400e; }
  .priority-medium { background: #e0f2fe; color: #075985; }
  .priority-low { background: #f1f5f9; color: #475569; }
`;

/** Renders the printable report page. Sections not requested are simply not written. */
export function renderReportHtml(data: ReportTemplateData): string {
  const sections = data.sections
    .map((key) => SECTION_RENDERERS[key])
    .filter((section): section is (typeof SECTION_RENDERERS)[ReportSection] => section !== undefined)
    .map(
      (section) => `
      <section>
        <h2>${escapeHtml(section.title)}</h2>
        ${section.render(data)}
      </section>`,
    )
    .join("\n");

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>${escapeHtml(data.projectName)} — AI Visibility Report</title>
    <style>${STYLE}</style>
  </head>
  <body>
    <div class="page">
      <header>
        <div>
          <h1>${escapeHtml(data.projectName)}</h1>
          <div class="domain">${escapeHtml(data.domain)}</div>
        </div>
        <div class="generated">Generated ${formatDate(data.generatedAt)}</div>
      </header>
      ${sections}
    </div>
  </body>
</html>`;
}
