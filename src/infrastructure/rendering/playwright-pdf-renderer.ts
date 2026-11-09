/**
 * PDF rendering via Playwright print (docs/Backend.md §6 — "one rendering stack for both
 * crawling and reports"). The report page is server-assembled HTML with no external
 * requests, so there is nothing here for the SSRF guard to intercept — unlike
 * `PlaywrightPageFetcher`, this browser only ever navigates to content it was handed.
 *
 * One browser per worker process, lazily launched, mirroring the crawler's fetcher so a
 * report job on the `report` queue never pays for Chromium until the first request needs
 * it — and never launches a second Chromium alongside the crawler's.
 */
import { chromium, type Browser } from "playwright";
import type { PdfRenderer } from "../../application/ports/pdf-renderer.port.js";

export class PlaywrightPdfRenderer implements PdfRenderer {
  #browser: Browser | null = null;

  async #ensureBrowser(): Promise<Browser> {
    if (this.#browser !== null) return this.#browser;
    this.#browser = await chromium.launch({
      args: ["--disable-dev-shm-usage", "--no-sandbox"],
    });
    return this.#browser;
  }

  async renderPdf(html: string): Promise<Uint8Array> {
    const browser = await this.#ensureBrowser();
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      // No `waitUntil: "networkidle"` needed — the page has no subresources to settle.
      await page.setContent(html, { waitUntil: "load" });
      const pdf = await page.pdf({
        format: "A4",
        printBackground: true,
        margin: { top: "0", bottom: "0", left: "0", right: "0" },
      });
      return pdf;
    } finally {
      await context.close();
    }
  }

  async close(): Promise<void> {
    await this.#browser?.close();
    this.#browser = null;
  }
}
