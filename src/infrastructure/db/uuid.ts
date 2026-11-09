// Supplies the clock and entropy the pure UUIDv7 formatter refuses to assume.
// Lives beside the repositories because id generation is a persistence concern here:
// use cases receive created rows, they never mint ids themselves.
import { randomFillSync } from "node:crypto";
import { formatUuidV7 } from "../../domain/shared/uuid.js";

const buffer = new Uint8Array(10);

export function newUuidV7(): string {
  randomFillSync(buffer);
  return formatUuidV7(Date.now(), buffer);
}
