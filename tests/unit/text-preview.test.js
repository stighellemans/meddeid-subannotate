import test from 'node:test';
import assert from 'node:assert/strict';

import { collapseWhitespaceForInlinePreview } from '../../src/text-preview.js';

test('collapses repeated whitespace for inline preview text', () => {
  assert.equal(
    collapseWhitespaceForInlinePreview('  009/\n\n 17-06-2016\t\t  '),
    '009/ 17-06-2016',
  );
});

test('returns empty string for empty inline preview text', () => {
  assert.equal(collapseWhitespaceForInlinePreview(' \n\t '), '');
});
