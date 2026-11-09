-- Add Better Auth's `issuer` discriminator to oauth_accounts (docs/adr/0002).
--
-- What: a required `issuer` column plus its UNIQUE (issuer, provider_account_id).
-- Why NOT NULL with no backfill: this ships before any account exists — the identity
-- tables are empty in every environment. A later release would need expand-and-contract.

-- AlterTable
ALTER TABLE "oauth_accounts" ADD COLUMN     "issuer" TEXT NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "oauth_accounts_issuer_provider_account_id_key" ON "oauth_accounts"("issuer", "provider_account_id");

