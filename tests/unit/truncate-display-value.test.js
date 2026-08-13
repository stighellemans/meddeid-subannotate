import test from 'node:test';
import assert from 'node:assert/strict';

import { truncateDisplayValue } from '../../src/truncate-display-value.js';

test('returns the original value when it is within the limit', () => {
  assert.equal(truncateDisplayValue('text0', 10), 'text0');
});

test('truncates values after the requested number of characters', () => {
  assert.equal(
    truncateDisplayValue('99c5d29b7551938b6977e40c87f3f6d9', 10),
    '99c5d29b75...',
  );
});

test('leaves the value unchanged when the limit is invalid', () => {
  assert.equal(truncateDisplayValue('text0', 0), 'text0');
});
