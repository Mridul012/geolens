/**
 * Notification email bodies (M18) — pure template tests.
 */
import { describe, expect, it } from "vitest";
import {
  budgetWarningEmail,
  crawlCompleteEmail,
  digestEmail,
  sweeperAlertEmail,
} from "../../../src/domain/notifications/templates.js";

describe("crawlCompleteEmail", () => {
  it("includes the domain and composite score", () => {
    const email = crawlCompleteEmail({
      projectName: "Acme",
      domain: "acme.com",
      composite: 72,
      dashboardUrl: "https://app.geolens.example/p/1",
    });
    expect(email.subject).toContain("Acme");
    expect(email.html).toContain("acme.com");
    expect(email.html).toContain("72");
    expect(email.text).toContain("acme.com");
  });

  it("says the score is pending rather than printing null", () => {
    const email = crawlCompleteEmail({
      projectName: "Acme",
      domain: "acme.com",
      composite: null,
      dashboardUrl: "https://app.geolens.example/p/1",
    });
    expect(email.html).toContain("pending");
    expect(email.html).not.toContain("null");
  });

  it("escapes an untrusted project name", () => {
    const email = crawlCompleteEmail({
      projectName: '<script>alert(1)</script>',
      domain: "acme.com",
      composite: 50,
      dashboardUrl: "https://app.geolens.example/p/1",
    });
    expect(email.html).not.toContain("<script>alert");
  });
});

describe("digestEmail", () => {
  it("describes a rise and a fall correctly", () => {
    const rise = digestEmail({
      projectName: "Acme",
      domain: "acme.com",
      dashboardUrl: "https://app.geolens.example/p/1",
      content: {
        scoreDelta: 8,
        currentComposite: 72,
        citationGained: 1,
        citationLost: 0,
        recommendationsOpened: 0,
        recommendationsResolved: 2,
      },
    });
    expect(rise.html).toContain("rose");
    expect(rise.html).toContain("8");
    expect(rise.html).toContain("1 new citation win");
    expect(rise.html).toContain("2 recommendation(s) resolved");

    const fall = digestEmail({
      projectName: "Acme",
      domain: "acme.com",
      dashboardUrl: "https://app.geolens.example/p/1",
      content: {
        scoreDelta: -5,
        currentComposite: 60,
        citationGained: 0,
        citationLost: 1,
        recommendationsOpened: 0,
        recommendationsResolved: 0,
      },
    });
    expect(fall.html).toContain("fell");
    expect(fall.html).toContain("1 citation loss");
  });
});

describe("sweeperAlertEmail", () => {
  it("reports the failure rate as a percentage", () => {
    const email = sweeperAlertEmail({ failureRate: 0.12, windowMinutes: 60, failed: 6, total: 50 });
    expect(email.subject).toContain("12%");
    expect(email.text).toContain("6 of 50");
  });
});

describe("budgetWarningEmail", () => {
  it("formats micro-USD as dollars", () => {
    const email = budgetWarningEmail({
      projectName: "Acme",
      spentMicros: 4_200_000n,
      budgetMicros: 5_000_000,
      windowDays: 30,
    });
    expect(email.text).toContain("$4.20");
    expect(email.text).toContain("$5.00");
  });
});
