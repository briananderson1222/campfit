-- Provider proposal queue for assistant/admin suggested provider updates

CREATE TABLE IF NOT EXISTS "ProviderChangeProposal" (
  id                  TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "providerId"        TEXT NOT NULL REFERENCES "Provider"(id) ON DELETE CASCADE,
  "createdAt"         TIMESTAMPTZ NOT NULL DEFAULT now(),
  "reviewedAt"        TIMESTAMPTZ,
  "reviewedBy"        TEXT,
  status              TEXT NOT NULL DEFAULT 'PENDING',
  "sourceUrl"         TEXT NOT NULL,
  "proposedChanges"   JSONB NOT NULL DEFAULT '{}'::jsonb,
  "overallConfidence" FLOAT NOT NULL DEFAULT 0,
  "reviewerNotes"     TEXT
);

CREATE INDEX IF NOT EXISTS "ProviderChangeProposal_provider_idx" ON "ProviderChangeProposal"("providerId");
CREATE INDEX IF NOT EXISTS "ProviderChangeProposal_status_idx" ON "ProviderChangeProposal"(status);
