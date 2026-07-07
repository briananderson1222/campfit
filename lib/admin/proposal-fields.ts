/**
 * lib/admin/proposal-fields.ts — shared scalar-field/relation-table lists for
 * `CampChangeProposal` (campfit#51, Wave 1 Task 1.1).
 *
 * Extracted verbatim from `lib/admin/review-apply.ts`'s previously
 * module-private `SCALAR_FIELDS`/`RELATION_TABLES` consts — a pure refactor,
 * no behavior change (`review-apply.ts` now imports both from here instead
 * of declaring its own copies; its own `tests/integration/review-apply.test.ts`
 * suite is unmodified and must still pass). `lib/admin/claim-corroboration.ts`
 * and `lib/admin/review-repository.ts` import the SAME list rather than
 * duplicating it, per the plan's "Existing concepts consumed" section.
 *
 * Relation fields (`ageGroups`/`schedules`/`pricing`) are explicitly out of
 * scope for exact-corroboration/batch-accept in this slice (more complex
 * reconciliation semantics) — callers restrict corroboration derivation to
 * `CAMP_SCALAR_FIELDS` themselves; this module makes no claim about which
 * caller uses which list.
 */

/** Scalar (single-value) Camp fields a Review Apply can write directly via `UPDATE "Camp"`. */
export const CAMP_SCALAR_FIELDS: readonly string[] = [
  'name', 'organizationName', 'description', 'campType', 'category', 'registrationStatus',
  'registrationOpenDate', 'registrationCloseDate', 'lunchIncluded', 'address', 'neighborhood', 'city',
  'websiteUrl', 'applicationUrl', 'contactEmail', 'contactPhone', 'socialLinks',
  'interestingDetails', 'state', 'zip',
];

/** Relation fields (`FieldDiff.new` is an array of child rows) and the table each one replaces. */
export const CAMP_RELATION_TABLES: Record<string, string> = {
  ageGroups: 'CampAgeGroup',
  schedules: 'CampSchedule',
  pricing: 'CampPricing',
};
