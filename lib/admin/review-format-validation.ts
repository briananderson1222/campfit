/**
 * review-format-validation.ts — per-field format-conformance check for the
 * review panel's diff rows (campfit#91, R1/AC1).
 *
 * Consumes the pipeline's OWN field schema
 * (`lib/ingestion/traverse-schema.ts`'s `CAMP_TARGET_SCHEMA` /
 * `SCALAR_SCHEMA_PATHS` / `ENUM_ARRAY_SCHEMA_PATHS` / `ITEMS_ARRAY_PREFIX`) —
 * read-only import, no edits to that file (hard lane boundary). This is
 * deliberately NOT a new schema authority: it validates a proposed value
 * against the same per-item schema the extraction pipeline already targets,
 * so "valid"/"invalid" here means "conforms to the schema the extractor was
 * told to produce," not a separate/duplicated notion of correctness.
 */

import {
  CAMP_TARGET_SCHEMA,
  ENUM_ARRAY_SCHEMA_PATHS,
  ITEMS_ARRAY_PREFIX,
  SCALAR_SCHEMA_PATHS,
} from '@/lib/ingestion/traverse-schema';

export type FieldFormatState = 'valid' | 'invalid' | 'uncheckable';

const SCALAR_SCHEMA_PATH_SET: ReadonlySet<string> = new Set(SCALAR_SCHEMA_PATHS);
const ENUM_ARRAY_SCHEMA_PATH_SET: ReadonlySet<string> = new Set(ENUM_ARRAY_SCHEMA_PATHS);

// Mirrors the ISO YYYY-MM-DD-prefix shape review-panel.tsx's own `formatValue`
// already assumes elsewhere in the same file (consistency, not a new
// invention) — see review-panel.tsx's `formatValue`.
const ISO_DATE_PREFIX = /^\d{4}-\d{2}-\d{2}/;

/**
 * Checks a single proposed field value against the pipeline's own schema.
 *
 * - `value == null || value === ''` -> `'uncheckable'` (nothing to check).
 * - A scalar field (`SCALAR_SCHEMA_PATHS`) is looked up in
 *   `CAMP_TARGET_SCHEMA` at `items[].<field>` and validated against that
 *   entry's declared `type`.
 * - An enum-array field (`ENUM_ARRAY_SCHEMA_PATHS`, i.e. `campTypes` /
 *   `categories`) requires an array whose every member is one of the
 *   matching `items[].<field>[]` entry's `enumValues`.
 * - Anything else (row-array families like `ageGroups`/`schedules`/`pricing`,
 *   or a camp-record-only field with no matching schema path, e.g. `notes`,
 *   `dataConfidence`, `lastVerifiedAt`, `communitySlug`, `region`, singular
 *   `campType`) -> `'uncheckable'`: this schema has no per-field type
 *   declaration to check it against.
 */
export function checkFieldFormat(field: string, value: unknown): FieldFormatState {
  if (value == null || value === '') return 'uncheckable';

  if (SCALAR_SCHEMA_PATH_SET.has(field)) {
    const entry = CAMP_TARGET_SCHEMA.find((s) => s.path === ITEMS_ARRAY_PREFIX + field);
    if (!entry) return 'uncheckable';
    return checkScalarValue(value, entry.type, entry.enumValues) ? 'valid' : 'invalid';
  }

  if (ENUM_ARRAY_SCHEMA_PATH_SET.has(field)) {
    const entry = CAMP_TARGET_SCHEMA.find((s) => s.path === `${ITEMS_ARRAY_PREFIX}${field}[]`);
    if (!entry) return 'uncheckable';
    if (!Array.isArray(value)) return 'invalid';
    const enumValues = entry.enumValues ?? [];
    return value.every((member) => enumValues.includes(member as string)) ? 'valid' : 'invalid';
  }

  return 'uncheckable';
}

function checkScalarValue(
  value: unknown,
  type: string,
  enumValues: string[] | undefined,
): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'date':
      return typeof value === 'string' && ISO_DATE_PREFIX.test(value);
    case 'enum':
      return typeof value === 'string' && (enumValues ?? []).includes(value);
    case 'object':
      // socialLinks is the one SCALAR_SCHEMA_PATHS member declared `object`
      // — check it's a plain object, not the array/object shape itself
      // (no per-key schema declared to check further).
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'array':
      return Array.isArray(value);
    default:
      return true;
  }
}
