/**
 * A crawled site with *real, topical* content, for indexing and coverage tests.
 *
 * The crawler fixtures elsewhere serve HTML over sockets to prove the crawl works. This
 * one starts one layer later: rows in `page_snapshots` whose `extracted.sections` hold
 * prose a retriever could plausibly be asked about, so coverage can be measured rather
 * than merely executed.
 *
 * The prose is deliberately vocabulary-dense per topic, which is what a well-structured
 * pricing or security page actually looks like — and what makes "covered" separable from
 * "absent" without tuning any threshold to the fixture.
 */
import type { PrismaClient } from "@prisma/client";
import type { DocumentSection } from "../../src/contracts/crawl/extraction.js";

export interface SeededPage {
  readonly path: string;
  readonly title: string;
  readonly sections: readonly DocumentSection[];
}

export interface SeededSite {
  readonly siteId: string;
  readonly crawlId: string;
  readonly snapshotIds: readonly string[];
}

export interface SeededProject {
  readonly userId: string;
  readonly projectId: string;
  readonly own: SeededSite;
}

/**
 * Paragraph pools per subject — each one a short, self-contained passage of the kind a
 * real subject page carries, not a stray sentence. Vocabulary density is the point: a
 * pricing page says "plan", "cost" and "pricing" repeatedly because that is what it is
 * about, and that is what makes a retriever find it.
 */
const PRICING = [
  "Our pricing is simple. The Starter plan costs ten dollars per month, the Growth plan costs fifty dollars per month, and the Enterprise plan has custom pricing. Compare plans to see what each plan costs and which plan fits your team.",
  "Every plan includes unlimited seats at no extra cost. Annual billing saves twenty percent on any plan, and you can change plan at any time with the cost prorated to the day. Billing for a downgraded plan starts at the next cycle.",
  "Compare plans side by side. The Starter plan covers one project, the Growth plan covers three projects, and the Enterprise plan covers unlimited projects with volume pricing. Each plan lists its cost per seat on the pricing page.",
  "There are no setup fees on any plan and no long-term contract. If you cancel, the plan stays active until the end of the billing period and no further cost is charged. Refunds are prorated for an annual plan.",
  "Enterprise pricing is negotiated per seat. Contact sales for a quote covering volume discounts, annual plan terms and invoiced billing. Enterprise plan pricing includes a dedicated success manager at no extra cost.",
  "Frequently asked pricing questions. What does each plan cost, how does plan billing work, and can I downgrade my plan mid-cycle? The pricing page answers each of these and lists the cost of every plan.",
];

const SECURITY = [
  "Security is central to how we build. We are SOC 2 Type II certified, complete an annual penetration test with an independent security auditor, and publish every compliance report. Our security posture is reviewed quarterly.",
  "All customer data is encrypted at rest with AES-256 and encrypted in transit with TLS 1.3. Encryption keys are rotated quarterly and stored in a hardware security module. Encryption is enabled on every plan.",
  "Our security team reviews every subprocessor and vendor for compliance before any data is shared. The compliance page lists each certification, each audit report and the scope of every security review.",
  "Single sign-on with SAML and SCIM provisioning is available, alongside role-based access control and a complete audit log. These access security controls satisfy most enterprise compliance requirements.",
  "We are GDPR compliant and support data residency in the EU. Our data processing agreement, our security whitepaper and our compliance certifications are available on request from the security team.",
  "Report a security vulnerability to our security team. We run a coordinated disclosure programme with a published response window, and every reported security issue is triaged within one business day.",
];

const API_DOCS = [
  "The REST API is authenticated with a bearer token. Every API endpoint returns JSON and uses conventional HTTP status codes. The API reference documents each endpoint with its request and response schema.",
  "Rate limits apply per API token: sixty requests per minute on the default endpoint tier. When an API request is rate limited the endpoint returns 429 with a Retry-After header telling the client when to retry.",
  "The API reference documents every endpoint, its request schema, its response schema and its error codes. Each API error code maps to one HTTP status, and every endpoint documents the errors it can return.",
  "Webhooks deliver API events to an endpoint you control with a signed payload. Verify the webhook signature before processing the request; the API reference documents the signing scheme for every event.",
  "Use the pagination cursor returned by each API list endpoint rather than an offset, which this API does not support. Every list endpoint returns a cursor, and the API reference shows how to page through results.",
  "SDKs wrap the API for TypeScript, Python and Go. Each SDK mirrors the endpoint names used in the API reference exactly, so an example in the reference translates directly into an SDK call.",
];

const MIGRATION = [
  "Migrating from another tool takes about an hour. The migration wizard imports your existing projects and keeps their history, so nothing is lost when you migrate. Start the migration from the import settings page.",
  "This migration guide walks through exporting data from your current provider, mapping the exported fields, and running the import. Follow each migration step in order and the import will complete cleanly.",
  "During a migration both tools can run side by side, so you can verify the migrated data before switching over. Nothing is deleted from the source until you confirm the migration is complete.",
  "Common migration problems: duplicate records after a partial import, unmapped custom fields, and time zones in migrated timestamps. This migration guide explains how to fix each import problem.",
  "After the migration completes, run the verification report to confirm every migrated record matches the source export. The migration report lists any record the import skipped and why.",
  "If a migration fails midway it is safe to re-run the import. The migration importer is idempotent and skips every record it has already migrated, so a repeated migration cannot duplicate data.",
];

const COMPANY = [
  "We build analytics for teams who want to understand how their content performs, and we have been doing it since 2023. Our team is distributed across five countries and works asynchronously.",
];

/** Turns a paragraph pool into headed sections, one paragraph each. */
function sectionsFrom(
  heading: string,
  paragraphs: readonly string[],
): readonly DocumentSection[] {
  return paragraphs.map((text, index) => ({
    headingPath: index === 0 ? heading : `${heading} > Part ${index + 1}`,
    text,
  }));
}

/**
 * One page per paragraph — a subject area, the way a real site lays one out.
 *
 * This matters for what coverage measures. Depth is counted in *chunks*, and chunking
 * merges small adjacent sections of the same page, so six short paragraphs stacked on one
 * page are one chunk, not six. A real site with a pricing page, an enterprise page and a
 * pricing FAQ produces several — and that spread is exactly the "is there enough of it"
 * signal the coverage formula is asking about.
 */
export function pagesFor(
  area: string,
  heading: string,
  paragraphs: readonly string[],
): readonly SeededPage[] {
  return paragraphs.map((text, index) => ({
    path: index === 0 ? `/${area}` : `/${area}/${index}`,
    title: index === 0 ? heading : `${heading} — ${index}`,
    sections: [{ headingPath: heading, text }],
  }));
}

function joinText(sections: readonly DocumentSection[]): string {
  return sections.map((section) => section.text).join(" ");
}

/**
 * Writes a site with one crawl and one snapshot per page.
 *
 * `changed` is true, as it is for a first crawl, so the index job treats every page as new
 * work. The carry-forward path is set up explicitly by the test that exercises it.
 */
export async function seedCrawledSite(
  prisma: PrismaClient,
  input: {
    readonly projectId: string;
    readonly domain: string;
    readonly role: "OWN" | "COMPETITOR";
    readonly pages: readonly SeededPage[];
  },
): Promise<SeededSite> {
  const site = await prisma.site.create({
    data: {
      projectId: input.projectId,
      url: `https://${input.domain}`,
      domain: input.domain,
      role: input.role,
    },
  });
  const crawl = await prisma.crawl.create({
    data: {
      siteId: site.id,
      projectId: input.projectId,
      status: "ANALYZING",
      trigger: "MANUAL",
      pagesCrawled: input.pages.length,
      pagesChanged: input.pages.length,
    },
  });

  const snapshotIds: string[] = [];
  for (const [index, page] of input.pages.entries()) {
    const text = joinText(page.sections);
    const row = await prisma.page.create({
      data: {
        siteId: site.id,
        url: `https://${input.domain}${page.path}`,
        urlHash: `${input.domain}-${page.path}`,
        latestContentHash: `content-${index}`,
      },
    });
    const snapshot = await prisma.pageSnapshot.create({
      data: {
        crawlId: crawl.id,
        pageId: row.id,
        contentHash: `content-${index}`,
        changed: true,
        title: page.title,
        wordCount: text.split(/\s+/).length,
        extracted: {
          title: page.title,
          metaDescription: `${page.title} — ${input.domain}`,
          headings: page.sections.map((section) => ({
            level: 2,
            text: section.headingPath ?? "",
            path: section.headingPath ?? "",
          })),
          mainText: text,
          sections: page.sections.map((section) => ({
            headingPath: section.headingPath,
            text: section.text,
          })),
        },
        storageKey: `snapshots/${site.id}/${index}`,
        fetchedAt: new Date(),
      },
    });
    snapshotIds.push(snapshot.id);
  }

  return { siteId: site.id, crawlId: crawl.id, snapshotIds };
}

/** A project owned by a fresh user, with its own site already crawled. */
export async function seedProject(
  prisma: PrismaClient,
  pages: readonly SeededPage[],
  domain = "acme.com",
): Promise<SeededProject> {
  const user = await prisma.user.create({
    data: { email: `idx-${Date.now()}-${Math.random()}@example.test` },
  });
  const project = await prisma.project.create({ data: { userId: user.id, name: "Indexing" } });
  const own = await seedCrawledSite(prisma, {
    projectId: project.id,
    domain,
    role: "OWN",
    pages,
  });
  return { userId: user.id, projectId: project.id, own };
}

/** The own-site fixture: strong on pricing, security and the API; silent on migration. */
export const OWN_PAGES: readonly SeededPage[] = [
  { path: "/", title: "Acme", sections: sectionsFrom("About Acme", COMPANY) },
  ...pagesFor("pricing", "Pricing", PRICING),
  ...pagesFor("security", "Security", SECURITY),
  ...pagesFor("docs/api", "API reference", API_DOCS),
];

/**
 * The thin fixture: a real site, but one with nothing to say.
 *
 * Two pages of company boilerplate and no subject content at all — the shape of a site
 * that looks fine to a human and answers none of its buyers' questions. It exists so
 * "rich scores higher than thin" is a comparison between two plausible sites rather than
 * between a site and an empty database.
 */
export const THIN_PAGES: readonly SeededPage[] = [
  { path: "/", title: "Acme", sections: sectionsFrom("About Acme", COMPANY) },
  {
    path: "/contact",
    title: "Contact",
    sections: [
      {
        headingPath: "Contact",
        text: "Get in touch with the team. We usually reply within one business day, and we would love to hear what you are working on.",
      },
    ],
  },
];

/** The competitor fixture: has the migration content the own site lacks. */
export const COMPETITOR_PAGES: readonly SeededPage[] = [
  ...pagesFor("pricing", "Pricing", PRICING),
  ...pagesFor("migration-guide", "Migration guide", MIGRATION),
];
