import assert from 'node:assert/strict';
import { evaluateAdminAccess } from '../lib/admin/access';

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

test('admin always has access', () => {
  const result = evaluateAdminAccess({
    userId: 'u1',
    email: 'admin@example.com',
    isAdmin: true,
    assignments: [],
    requestedCommunity: 'denver',
    allowModerator: true,
  });
  assert.ok('access' in result);
  if ('access' in result) {
    assert.equal(result.access.isAdmin, true);
  }
});

test('moderator has scoped community access when allowed', () => {
  const result = evaluateAdminAccess({
    userId: 'u2',
    email: 'mod@example.com',
    isAdmin: false,
    assignments: [{ communitySlug: 'denver', role: 'MODERATOR' }],
    requestedCommunity: 'denver',
    allowModerator: true,
  });
  assert.ok('access' in result);
});

test('moderator is blocked outside assigned community', () => {
  const result = evaluateAdminAccess({
    userId: 'u2',
    email: 'mod@example.com',
    isAdmin: false,
    assignments: [{ communitySlug: 'denver', role: 'MODERATOR' }],
    requestedCommunity: 'boulder',
    allowModerator: true,
  });
  assert.ok('error' in result);
});

test('moderator is blocked when moderator access is not allowed', () => {
  const result = evaluateAdminAccess({
    userId: 'u2',
    email: 'mod@example.com',
    isAdmin: false,
    assignments: [{ communitySlug: 'denver', role: 'MODERATOR' }],
    requestedCommunity: 'denver',
    allowModerator: false,
  });
  assert.ok('error' in result);
});

console.log('access tests complete');
