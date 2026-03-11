-- Add array columns
ALTER TABLE "Camp" ADD COLUMN IF NOT EXISTS "campTypes" TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE "Camp" ADD COLUMN IF NOT EXISTS "categories" TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE "Camp" ADD COLUMN IF NOT EXISTS state TEXT;
ALTER TABLE "Camp" ADD COLUMN IF NOT EXISTS zip TEXT;

-- Backfill arrays from existing single values (only where arrays are empty)
UPDATE "Camp" SET "campTypes" = ARRAY["campType"::text] WHERE array_length("campTypes", 1) IS NULL;
UPDATE "Camp" SET "categories" = ARRAY["category"::text] WHERE array_length("categories", 1) IS NULL;
