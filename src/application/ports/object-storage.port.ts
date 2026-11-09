/**
 * Object storage behind a port (Engineering-Rules §2.2). R2 today, S3 tomorrow — the
 * difference is an endpoint, and no use case should be able to tell.
 */
export interface PutObjectInput {
  readonly key: string;
  readonly body: Uint8Array;
  readonly contentType: string;
  readonly contentEncoding?: string;
}

export interface ObjectStorage {
  put(input: PutObjectInput): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  deleteMany(keys: readonly string[]): Promise<void>;
  /** Short-lived signed URL; the API authorizes, storage serves (docs/Backend.md §9). */
  signedUrl(key: string, expiresInSeconds: number): Promise<string>;
}
