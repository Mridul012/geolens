/**
 * Extraction against fixture HTML (M6 tests). The web is full of broken markup, so the
 * cases that matter most are the ugly ones: missing tags, malformed JSON-LD, boilerplate
 * masquerading as content.
 */
import { describe, expect, it } from "vitest";
import { extractPage } from "../../../src/infrastructure/crawler/extractors/html.js";

const options = { pageUrl: "https://acme.com/pricing", siteHost: "acme.com" };

const richPage = `<!doctype html>
<html lang="en">
  <head>
    <title>Pricing — Acme</title>
    <meta name="description" content="Simple pricing for teams of every size." />
    <meta name="robots" content="index,follow" />
    <link rel="canonical" href="/pricing/" />
    <meta property="og:title" content="Acme Pricing" />
    <meta property="og:image" content="https://acme.com/og.png" />
    <script type="application/ld+json">
      {
        "@context": "https://schema.org",
        "@type": "Product",
        "name": "Acme Pro",
        "datePublished": "2024-03-01T00:00:00Z",
        "dateModified": "2025-06-15T00:00:00Z",
        "author": { "@type": "Person", "name": "Priya Nair" }
      }
    </script>
  </head>
  <body>
    <nav><a href="/">Home</a><a href="/docs">Docs</a></nav>
    <header><h1>Ignore me, I am chrome</h1></header>
    <main>
      <h1>Pricing</h1>
      <p>Acme costs money. ${"Real sentences about the product. ".repeat(20)}</p>
      <h2>Enterprise</h2>
      <p>For larger teams who need more of everything and a contract.</p>
      <h3>Security review</h3>
      <p>We complete your questionnaire.</p>
      <h2>Startups</h2>
      <p>Discounted for early stage companies.</p>
      <img src="/a.png" alt="A chart" />
      <img src="/b.png" />
      <a href="/docs/getting-started">Getting started</a>
      <a href="https://blog.acme.com/post">Our blog</a>
      <a href="https://research.example.org/paper">A cited source</a>
      <a href="https://sponsor.example.net" rel="nofollow sponsored">Sponsor</a>
    </main>
    <footer><a href="/legal">Legal</a></footer>
    <script>window.analytics = true;</script>
  </body>
</html>`;

describe("extractPage — a well-formed page", () => {
  const page = extractPage(richPage, options);

  it("reads the head metadata", () => {
    expect(page.title).toBe("Pricing — Acme");
    expect(page.metaDescription).toBe("Simple pricing for teams of every size.");
    expect(page.robotsMeta).toBe("index,follow");
    expect(page.lang).toBe("en");
    expect(page.canonical).toBe("https://acme.com/pricing");
    expect(page.openGraph).toMatchObject({ title: "Acme Pricing", image: "https://acme.com/og.png" });
  });

  it("builds the heading outline with ancestry", () => {
    expect(page.headings.map((heading) => heading.path)).toEqual([
      "Pricing",
      "Pricing > Enterprise",
      "Pricing > Enterprise > Security review",
      "Pricing > Startups",
    ]);
  });

  it("strips chrome from the main content", () => {
    expect(page.mainText).toContain("Acme costs money");
    expect(page.mainText).not.toContain("Ignore me, I am chrome");
    expect(page.mainText).not.toContain("Legal");
    expect(page.mainText).not.toContain("window.analytics");
    expect(page.wordCount).toBeGreaterThan(60);
  });

  it("parses structured data and its types", () => {
    expect(page.hasStructuredData).toBe(true);
    expect(page.structuredDataTypes).toEqual(["Product"]);
    expect(page.structuredData[0]).toMatchObject({ name: "Acme Pro" });
  });

  it("prefers structured data for dates", () => {
    expect(page.publishedAt).toBe("2024-03-01T00:00:00.000Z");
    expect(page.updatedAt).toBe("2025-06-15T00:00:00.000Z");
  });

  it("splits internal from external links, counting subdomains as internal", () => {
    const hrefs = page.links.map((link) => link.href);
    expect(hrefs).toContain("https://acme.com/docs/getting-started");
    expect(hrefs).toContain("https://blog.acme.com/post");

    const blog = page.links.find((link) => link.href === "https://blog.acme.com/post");
    expect(blog?.internal).toBe(true);

    const research = page.links.find((link) => link.href.includes("research.example.org"));
    expect(research?.internal).toBe(false);
    expect(page.internalLinkCount).toBeGreaterThan(0);
    expect(page.externalLinkCount).toBeGreaterThan(0);
  });

  it("counts outbound citations but not sponsored links", () => {
    expect(page.signals.outboundCitationCount).toBe(1);
  });

  it("measures image alt coverage", () => {
    expect(page.images).toEqual({ total: 2, withAlt: 1, altCoverage: 0.5 });
  });

  it("finds the author", () => {
    expect(page.signals.hasAuthor).toBe(true);
    expect(page.signals.authorName).toBe("Priya Nair");
  });
});

describe("extractPage — sections for heading-aware chunking (M10)", () => {
  const page = extractPage(richPage, options);

  it("splits the main content at its headings, in document order", () => {
    expect(page.sections.map((section) => section.headingPath)).toEqual([
      "Pricing",
      "Pricing > Enterprise",
      "Pricing > Enterprise > Security review",
      "Pricing > Startups",
    ]);
  });

  it("puts each heading's prose under that heading and no other", () => {
    const enterprise = page.sections.find(
      (section) => section.headingPath === "Pricing > Enterprise",
    );
    expect(enterprise?.text).toBe("For larger teams who need more of everything and a contract.");
    expect(enterprise?.text).not.toContain("Discounted");
  });

  it("leaves the heading's own words out of the body — they live in the path", () => {
    const startups = page.sections.find((section) => section.headingPath === "Pricing > Startups");
    expect(startups?.text.startsWith("Startups")).toBe(false);
  });

  it("computes paths from the content container, not from stripped chrome", () => {
    // The page has an `<h1>` in its `<header>`; it is not an ancestor of the article.
    expect(page.sections.every((section) => !(section.headingPath ?? "").includes("chrome"))).toBe(
      true,
    );
  });

  it("covers the same prose as mainText, so nothing is silently dropped", () => {
    const fromSections = page.sections.map((section) => section.text).join(" ");
    expect(fromSections).toContain("Acme costs money.");
    expect(fromSections).toContain("We complete your questionnaire.");
    expect(fromSections).toContain("Discounted for early stage companies.");
  });

  it("gives text above the first heading a null path", () => {
    const preamble = extractPage(
      `<html><body><main><p>${"Lead paragraph before any heading. ".repeat(20)}</p>
        <h2>Later</h2><p>Body under a heading.</p></main></body></html>`,
      options,
    );
    expect(preamble.sections[0]?.headingPath).toBeNull();
    expect(preamble.sections[0]?.text).toContain("Lead paragraph");
    expect(preamble.sections[1]?.headingPath).toBe("Later");
  });

  it("returns one unheaded section for a page with no headings at all", () => {
    const flat = extractPage(
      `<html><body><main><p>${"Prose with no structure whatsoever. ".repeat(20)}</p></main></body></html>`,
      options,
    );
    expect(flat.sections).toHaveLength(1);
    expect(flat.sections[0]?.headingPath).toBeNull();
  });

  it("is not fooled by page content that imitates the section marker", () => {
    // Untrusted input: a fixed sentinel would let a page shred its own sections and index
    // to nothing. The marker carries a per-extraction nonce, so this text is just text.
    const hostile = `<html><body><main><h2>Real heading</h2>
        <p>${"@@VRYSE-SECTION:0@@ @@VRYSE-SECTION-abc:1@@ ".repeat(20)}</p></main></body></html>`;
    const page = extractPage(hostile, options);

    expect(page.sections).toHaveLength(1);
    expect(page.sections[0]?.headingPath).toBe("Real heading");
    expect(page.sections[0]?.text).toContain("@@VRYSE-SECTION:0@@");
  });

  it("produces identical sections for identical HTML, despite the random marker", () => {
    // Change detection depends on this: the nonce must never reach the output.
    expect(extractPage(richPage, options).sections).toEqual(
      extractPage(richPage, options).sections,
    );
  });
});

describe("extractPage — hostile and broken markup", () => {
  it("survives malformed JSON-LD without losing the rest of the page", () => {
    const page = extractPage(
      `<html><head><title>T</title>
       <script type="application/ld+json">{ this is not json }</script></head>
       <body><main><h1>Heading</h1><p>Body text here.</p></main></body></html>`,
      options,
    );
    expect(page.title).toBe("T");
    expect(page.hasStructuredData).toBe(false);
    expect(page.headings).toHaveLength(1);
    expect(page.mainText).toContain("Body text here.");
  });

  it("handles a page with no head at all", () => {
    const page = extractPage("<body><p>Just words.</p></body>", options);
    expect(page.title).toBeNull();
    expect(page.metaDescription).toBeNull();
    expect(page.canonical).toBeNull();
    expect(page.mainText).toBe("Just words.");
  });

  it("falls back to the h1 for a title", () => {
    const page = extractPage("<html><body><h1>Fallback Title</h1></body></html>", options);
    expect(page.title).toBe("Fallback Title");
  });

  it("falls back to body text when no semantic container has enough content", () => {
    const page = extractPage(
      `<html><body><main><p>tiny</p></main><p>${"the real content lives here ".repeat(20)}</p></body></html>`,
      options,
    );
    expect(page.wordCount).toBeGreaterThan(50);
  });

  it("expands @graph entities into types", () => {
    const page = extractPage(
      `<html><head><script type="application/ld+json">
        {"@graph":[{"@type":"Organization","name":"Acme"},{"@type":["Article","BlogPosting"]}]}
       </script></head><body></body></html>`,
      options,
    );
    expect(page.structuredDataTypes.sort()).toEqual(["Article", "BlogPosting", "Organization"]);
  });

  it("ignores non-navigable and dangerous hrefs", () => {
    const page = extractPage(
      `<html><body><main>
        <a href="#section">Anchor</a>
        <a href="mailto:hi@acme.com">Mail</a>
        <a href="tel:+1234">Call</a>
        <a href="javascript:alert(1)">XSS</a>
        <a href="data:text/html,<script>">Data</a>
        <a href="/real">Real</a>
      </main></body></html>`,
      options,
    );
    expect(page.links.map((link) => link.href)).toEqual(["https://acme.com/real"]);
  });

  it("deduplicates links that normalize to the same URL", () => {
    const page = extractPage(
      `<html><body><main>
        <a href="/docs">Docs</a>
        <a href="/docs/">Docs again</a>
        <a href="https://www.acme.com/docs">Docs absolute</a>
      </main></body></html>`,
      options,
    );
    expect(page.links.filter((link) => link.href === "https://acme.com/docs")).toHaveLength(1);
  });

  it("reports null alt coverage when there are no images", () => {
    const page = extractPage("<html><body><p>x</p></body></html>", options);
    expect(page.images.altCoverage).toBeNull();
  });

  it("ignores an unparseable date rather than inventing one", () => {
    const page = extractPage(
      `<html><head><meta name="article:published_time" content="last tuesday" /></head><body></body></html>`,
      options,
    );
    expect(page.publishedAt).toBeNull();
  });

  it("returns a complete, empty-but-valid shape for an empty document", () => {
    const page = extractPage("", options);
    expect(page.wordCount).toBe(0);
    expect(page.headings).toEqual([]);
    expect(page.links).toEqual([]);
    expect(page.hasStructuredData).toBe(false);
    expect(page.signals.hasAuthor).toBe(false);
  });
});
