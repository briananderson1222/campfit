import assert from 'node:assert/strict';
import { displayExternalUrl, safeExternalHref } from '../lib/admin/safe-url';

assert.equal(safeExternalHref('https://example.test/path'), 'https://example.test/path');
assert.equal(safeExternalHref('http://example.test/path'), 'http://example.test/path');
assert.equal(safeExternalHref('javascript:alert(1)'), undefined);
assert.equal(safeExternalHref('data:text/html,<script>alert(1)</script>'), undefined);
assert.equal(safeExternalHref('mailto:admin@example.test'), undefined);
assert.equal(safeExternalHref('tel:+13035550100'), undefined);
assert.equal(safeExternalHref('/admin/review'), undefined);
assert.equal(safeExternalHref('not a url'), undefined);

assert.equal(displayExternalUrl('https://example.test/path'), 'example.test/path');
assert.equal(displayExternalUrl('http://example.test/path', 7), 'example');
assert.equal(displayExternalUrl('javascript:alert(1)'), 'javascript:alert(1)');

console.log('safe URL verification passed');
