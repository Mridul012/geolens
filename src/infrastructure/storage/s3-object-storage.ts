/**
 * The `ObjectStorage` port over the S3 API (docs/Backend.md §9).
 *
 * One adapter serves every environment because R2, MinIO and S3 all speak the same
 * protocol — the difference is an endpoint and an addressing style, both owned by the
 * environment. Construction happens in composition/ (Engineering-Rules §2.2).
 */
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "../../config/env.js";
import type { ObjectStorage, PutObjectInput } from "../../application/ports/object-storage.port.js";

/** S3's hard cap on keys per DeleteObjects request. */
const DELETE_BATCH_SIZE = 1_000;

export function createS3Client(): S3Client {
  return new S3Client({
    endpoint: env.STORAGE_ENDPOINT,
    region: env.STORAGE_REGION,
    // MinIO needs path-style addressing; R2 and S3 accept it too.
    forcePathStyle: env.STORAGE_FORCE_PATH_STYLE,
    credentials: {
      accessKeyId: env.STORAGE_ACCESS_KEY_ID,
      secretAccessKey: env.STORAGE_SECRET_ACCESS_KEY,
    },
  });
}

export class S3ObjectStorage implements ObjectStorage {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(client: S3Client, bucket: string = env.STORAGE_BUCKET) {
    this.client = client;
    this.bucket = bucket;
  }

  async put(input: PutObjectInput): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: input.key,
        Body: input.body,
        ContentType: input.contentType,
        ...(input.contentEncoding === undefined ? {} : { ContentEncoding: input.contentEncoding }),
      }),
    );
  }

  /** Null only for a key that does not exist; every other failure throws. */
  async get(key: string): Promise<Uint8Array | null> {
    try {
      const response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      if (response.Body === undefined) return null;
      return await response.Body.transformToByteArray();
    } catch (error) {
      if (error instanceof NoSuchKey) return null;
      if (error instanceof S3ServiceException && error.$metadata.httpStatusCode === 404) return null;
      throw error;
    }
  }

  /**
   * Deleting a key that is already gone is not an error — a purge that retries after a
   * partial failure must converge, not fail on the half it already finished.
   */
  async deleteMany(keys: readonly string[]): Promise<void> {
    for (let start = 0; start < keys.length; start += DELETE_BATCH_SIZE) {
      const batch = keys.slice(start, start + DELETE_BATCH_SIZE);
      const response = await this.client.send(
        new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: { Objects: batch.map((key) => ({ Key: key })), Quiet: true },
        }),
      );
      const failed = (response.Errors ?? []).filter((entry) => entry.Code !== "NoSuchKey");
      if (failed.length > 0) {
        const first = failed[0];
        throw new Error(
          `object storage refused to delete ${failed.length} of ${batch.length} keys ` +
            `(first: ${first?.Key ?? "unknown"} — ${first?.Code ?? "unknown"})`,
        );
      }
    }
  }

  async signedUrl(key: string, expiresInSeconds: number): Promise<string> {
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn: expiresInSeconds,
    });
  }
}
