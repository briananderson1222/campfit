import assert from 'node:assert/strict';
import { toReviewValueDescriptor } from '../lib/admin/survey-value-descriptor';
import { CAMP_TARGET_SCHEMA } from '../lib/ingestion/traverse-schema';

// enum (single-choice) → { type: 'enum', enumValues: [...] }
const registrationStatus = toReviewValueDescriptor('registrationStatus');
assert.equal(registrationStatus?.type, 'enum');
assert.deepEqual(registrationStatus?.enumValues, [
  'OPEN', 'FULL', 'WAITLIST', 'CLOSED', 'COMING_SOON', 'UNKNOWN',
]);

// category (singular enum) is also typed — sanity that single-choice enums map.
const category = toReviewValueDescriptor('category');
assert.equal(category?.type, 'enum');
assert.ok((category?.enumValues?.length ?? 0) > 0);

// date / boolean / number → { type } (no enumValues)
assert.deepEqual(toReviewValueDescriptor('registrationOpenDate'), { type: 'date' });
assert.deepEqual(toReviewValueDescriptor('registrationCloseDate'), { type: 'date' });
assert.deepEqual(toReviewValueDescriptor('lunchIncluded'), { type: 'boolean' });
assert.deepEqual(toReviewValueDescriptor('minAge'), { type: 'number' });
assert.deepEqual(toReviewValueDescriptor('maxAge'), { type: 'number' });
assert.deepEqual(toReviewValueDescriptor('amount'), { type: 'number' });

// string / unknown fields → undefined (keep free-text, today's behavior)
assert.equal(toReviewValueDescriptor('name'), undefined);
assert.equal(toReviewValueDescriptor('description'), undefined);
assert.equal(toReviewValueDescriptor('socialLinks'), undefined); // type: object
assert.equal(toReviewValueDescriptor('not-a-real-field'), undefined);

// ENUM-ARRAY EXCLUSION (correctness-critical): campTypes/categories are declared
// enum but are multi-select array-of-enum — must stay free-text (undefined),
// NOT collapse to a single-choice <select>.
assert.equal(toReviewValueDescriptor('campTypes'), undefined);
assert.equal(toReviewValueDescriptor('categories'), undefined);

// Structural guard: EVERY schema enum whose path ends in `[]` (array-of-enum)
// must be excluded; every singular enum path must be typed. Locks the exclusion
// to the structural signal rather than a name list.
for (const entry of CAMP_TARGET_SCHEMA) {
  if (entry.type !== 'enum') continue;
  const field = entry.path.replace(/\[\]$/, '').split('.').pop()!;
  if (entry.path.endsWith('[]')) {
    assert.equal(
      toReviewValueDescriptor(field),
      undefined,
      `array-of-enum field ${entry.path} must stay free-text`,
    );
  } else {
    assert.equal(
      toReviewValueDescriptor(field)?.type,
      'enum',
      `singular enum field ${entry.path} must render a typed <select>`,
    );
  }
}

console.log('survey value descriptor verification passed');
