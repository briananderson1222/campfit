/**
 * survey-value-descriptor.ts — derives a neutral {@link ReviewValueDescriptor}
 * for a reviewed camp field from CampFit's OWN extraction schema
 * ({@link CAMP_TARGET_SCHEMA}), so the Survey review workbench can render a
 * typed editor (enum `<select>`, date/number/boolean input) instead of a
 * free-text box.
 *
 * This descriptor is intentionally derived from campfit's caller-owned schema,
 * NOT from traverse's `ExtractionProposal` — the workbench only needs the
 * declared value SHAPE, which the schema already carries. Survey's
 * `ReviewItemSpec.valueDescriptor` is optional: returning `undefined` leaves a
 * field as today's plain-text editor with no behavior change.
 */
import type { ReviewValueDescriptor } from '@kontourai/survey';
import type { TargetFieldSchema } from '@kontourai/traverse';
import { CAMP_TARGET_SCHEMA } from '@/lib/ingestion/traverse-schema';

/**
 * Last dot-delimited segment of a schema path, with a trailing array marker
 * (`[]`) stripped first. Proposal/diff field keys are these bare segment names
 * (e.g. `registrationStatus`, `minAge`, `campTypes`), not full schema paths
 * (`items[].registrationStatus`, `items[].ageGroups[].minAge`,
 * `items[].campTypes[]`).
 */
function lastPathSegment(path: string): string {
  const withoutTrailingArray = path.replace(/\[\]$/, '');
  const segments = withoutTrailingArray.split('.');
  return segments[segments.length - 1] ?? withoutTrailingArray;
}

// Built once: last path segment (trailing `[]` stripped) -> schema entry.
const SCHEMA_BY_FIELD: ReadonlyMap<string, TargetFieldSchema> = new Map(
  CAMP_TARGET_SCHEMA.map((entry) => [lastPathSegment(entry.path), entry]),
);

/**
 * Map a reviewed field name to a neutral Survey value descriptor, or
 * `undefined` to keep the field free-text.
 *
 * ENUM-ARRAY EXCLUSION (correctness-critical): `campTypes` and `categories`
 * are declared `type: "enum"` in the schema but are semantically an ARRAY of
 * enum values (multi-select — a camp can be both SLEEPAWAY and FAMILY, or span
 * several categories). Survey's enum descriptor renders a SINGLE-choice
 * `<select>` and cannot express multi-select, so mapping them would let a
 * reviewer silently collapse a multi-value field down to one value. They must
 * stay free-text.
 *
 * We detect this STRUCTURALLY rather than with a hardcoded name list: an enum
 * whose schema path ends in `[]` (e.g. `items[].campTypes[]`,
 * `items[].categories[]`) is an array-of-enum, whereas a singular enum path
 * (`items[].category`, `items[].registrationStatus`) is single-choice. This is
 * derived from the schema data itself, so any future array-of-enum field is
 * excluded automatically — no list to keep in sync. (It mirrors, and stays
 * consistent with, `traverse-schema.ts`'s `ENUM_ARRAY_SCHEMA_PATHS` and
 * `diff-engine.ts`'s `ENUM_ARRAY_FIELDS`, but does not depend on them.)
 */
export function toReviewValueDescriptor(field: string): ReviewValueDescriptor | undefined {
  const entry = SCHEMA_BY_FIELD.get(field);
  if (!entry) return undefined;

  switch (entry.type) {
    case 'enum': {
      // Array-of-enum (multi-select) — structurally identified by a trailing
      // `[]` on the schema path. Keep free-text; a single-choice <select>
      // cannot represent it. See the doc comment above.
      if (entry.path.endsWith('[]')) return undefined;
      const enumValues = entry.enumValues;
      if (!enumValues || enumValues.length === 0) return undefined;
      return { type: 'enum', enumValues: [...enumValues] };
    }
    case 'number':
    case 'date':
    case 'boolean':
      return { type: entry.type };
    default:
      // string, array, object → keep free-text (undefined preserves behavior).
      return undefined;
  }
}
