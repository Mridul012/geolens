/**
 * PDF rendering behind a port (Engineering-Rules §2.2). The use case hands over a finished
 * HTML string; it never learns that a headless browser produced the bytes.
 */
export interface PdfRenderer {
  renderPdf(html: string): Promise<Uint8Array>;
}
