/**
 * Extraction behind a port: the use case decides *when* a page is extracted, the adapter
 * knows *how*. Keeps the HTML parser out of the application layer and lets the pipeline be
 * tested with a hand-written extractor.
 */
import type { ExtractedPage } from "../../contracts/crawl/extraction.js";

export interface PageExtractorOptions {
  readonly pageUrl: string;
  readonly siteHost: string;
}

export type PageExtractor = (html: string, options: PageExtractorOptions) => ExtractedPage;
