-- Queue-binding attestation (@kontourai/survey 2.4.0, kontourai/survey#213):
-- a review decision is only projectable against the exact queue bytes it was
-- recorded against. The binding is taken ONCE (bindReviewQueue) when the
-- review round opens and persisted beside the queue IN THE SAME TRANSACTION
-- as the SurveyReviewSession insert; every later read/apply validates the
-- stored queue against this stored binding and never recomputes it — a digest
-- a writer recomputes as it saves attests nothing.
--
-- Legacy rows deliberately keep NULL rather than a backfilled binding: a
-- binding minted at migration time from whatever bytes the row holds NOW is
-- the exact self-agreement tautology the attestation exists to remove. An
-- unbound session is treated as stale — recreated (with a binding) on next
-- open, refused at read/apply.
ALTER TABLE "SurveyReviewSession"
  ADD COLUMN IF NOT EXISTS binding jsonb;
