-- Extend the identity tables so Better Auth can own auth flows (docs/adr/0002).
--
-- What: adds Better Auth's required columns to `users`, `sessions` and `oauth_accounts`,
-- creates the `verifications` table, and drops the unused `users.password_hash` —
-- credential secrets live on the account row alongside every other provider credential.
-- Why manual edits: Prisma emits the two new `updated_at` columns as NOT NULL with no
-- default, which would fail on a populated table. Defaulting them to now() keeps this
-- expand-only and safe to run against a live database (Engineering-Rules §5).

-- AlterTable
ALTER TABLE "oauth_accounts" ADD COLUMN     "access_token" TEXT,
ADD COLUMN     "access_token_expires_at" TIMESTAMPTZ(6),
ADD COLUMN     "id_token" TEXT,
ADD COLUMN     "password" TEXT,
ADD COLUMN     "refresh_token" TEXT,
ADD COLUMN     "refresh_token_expires_at" TIMESTAMPTZ(6),
ADD COLUMN     "scope" TEXT,
ADD COLUMN     "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "sessions" ADD COLUMN     "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "users" DROP COLUMN "password_hash",
ADD COLUMN     "email_verified" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "verifications" (
    "id" UUID NOT NULL,
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "verifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "verifications_identifier_idx" ON "verifications"("identifier");

-- CreateIndex
CREATE INDEX "verifications_expires_at_idx" ON "verifications"("expires_at");
