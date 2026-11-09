/**
 * Notification email bodies — pure string templates, mirroring the report page
 * (`domain/reports/template.ts`): everything needed has already been read, so building the
 * message is a deterministic function of already-fetched data.
 */
import type { DigestContent } from "./digest.js";

export interface EmailContent {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function wrap(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html>
  <body style="font-family: -apple-system, Helvetica, Arial, sans-serif; color: #1a1a2e; max-width: 560px; margin: 0 auto; padding: 24px;">
    <h1 style="font-size: 18px;">${escapeHtml(title)}</h1>
    ${bodyHtml}
  </body>
</html>`;
}

export function crawlCompleteEmail(input: {
  readonly projectName: string;
  readonly domain: string;
  readonly composite: number | null;
  readonly dashboardUrl: string;
}): EmailContent {
  const subject = `${input.projectName}: crawl complete`;
  const scoreLine =
    input.composite === null
      ? "Your AI visibility score is pending — it publishes once enough signal is in."
      : `Your AI visibility score is now ${input.composite}.`;

  return {
    subject,
    html: wrap(subject, `
      <p>Your crawl of ${escapeHtml(input.domain)} has finished.</p>
      <p>${escapeHtml(scoreLine)}</p>
      <p><a href="${escapeHtml(input.dashboardUrl)}">View the dashboard</a></p>
    `),
    text: `Your crawl of ${input.domain} has finished.\n${scoreLine}\n${input.dashboardUrl}`,
  };
}

export function digestEmail(input: {
  readonly projectName: string;
  readonly domain: string;
  readonly content: DigestContent;
  readonly dashboardUrl: string;
}): EmailContent {
  const { content } = input;
  const subject = `${input.projectName}: this week's AI visibility digest`;

  const scoreLine =
    content.scoreDelta === null
      ? `Your score is now ${content.currentComposite ?? "pending"}.`
      : content.scoreDelta === 0
        ? `Your score held steady at ${content.currentComposite}.`
        : `Your score ${content.scoreDelta > 0 ? "rose" : "fell"} ${Math.abs(content.scoreDelta)} points, to ${content.currentComposite}.`;

  const lines = [
    scoreLine,
    content.citationGained > 0 ? `${content.citationGained} new citation win(s).` : null,
    content.citationLost > 0 ? `${content.citationLost} citation loss(es) to watch.` : null,
    content.recommendationsResolved > 0
      ? `${content.recommendationsResolved} recommendation(s) resolved.`
      : null,
    content.recommendationsOpened > 0
      ? `${content.recommendationsOpened} new recommendation(s) opened.`
      : null,
  ].filter((line): line is string => line !== null);

  return {
    subject,
    html: wrap(subject, `
      <p>What changed for ${escapeHtml(input.domain)} this week:</p>
      <ul>${lines.map((line) => `<li>${escapeHtml(line)}</li>`).join("")}</ul>
      <p><a href="${escapeHtml(input.dashboardUrl)}">View the dashboard</a></p>
    `),
    text: `What changed for ${input.domain} this week:\n${lines.map((line) => `- ${line}`).join("\n")}\n${input.dashboardUrl}`,
  };
}

export function sweeperAlertEmail(input: {
  readonly failureRate: number;
  readonly windowMinutes: number;
  readonly failed: number;
  readonly total: number;
}): EmailContent {
  const pct = Math.round(input.failureRate * 100);
  const subject = `Alert: job failure rate at ${pct}% in the last ${input.windowMinutes} minutes`;
  return {
    subject,
    html: wrap(subject, `
      <p>${input.failed} of ${input.total} jobs failed in the last ${input.windowMinutes} minutes (${pct}%).</p>
    `),
    text: `${input.failed} of ${input.total} jobs failed in the last ${input.windowMinutes} minutes (${pct}%).`,
  };
}

export function budgetWarningEmail(input: {
  readonly projectName: string;
  readonly spentMicros: bigint;
  readonly budgetMicros: number;
  readonly windowDays: number;
}): EmailContent {
  const spentUsd = (Number(input.spentMicros) / 1_000_000).toFixed(2);
  const budgetUsd = (input.budgetMicros / 1_000_000).toFixed(2);
  const subject = `Budget warning: ${input.projectName} is trending over its AI spend budget`;
  return {
    subject,
    html: wrap(subject, `
      <p>${escapeHtml(input.projectName)} has spent $${spentUsd} of its $${budgetUsd} budget over the trailing ${input.windowDays} days.</p>
    `),
    text: `${input.projectName} has spent $${spentUsd} of its $${budgetUsd} budget over the trailing ${input.windowDays} days.`,
  };
}
