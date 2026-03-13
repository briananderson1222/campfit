-- Community-scoped moderator roles

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'AdminRole') THEN
    CREATE TYPE "AdminRole" AS ENUM ('ADMIN', 'MODERATOR');
  END IF;
END $$;

ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "isAdmin" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS "CommunityModeratorAssignment" (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "userId"        TEXT NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
  "communitySlug" TEXT NOT NULL,
  role            "AdminRole" NOT NULL DEFAULT 'MODERATOR',
  "createdBy"     TEXT,
  "createdAt"     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "CommunityModeratorAssignment_user_community_key"
  ON "CommunityModeratorAssignment"("userId", "communitySlug");
CREATE INDEX IF NOT EXISTS "CommunityModeratorAssignment_user_idx"
  ON "CommunityModeratorAssignment"("userId");
