import test from 'node:test';
import assert from 'node:assert/strict';

import { applyOnlineFormattingToSegments } from '../../src/annotation/online-formatter.js';

test('splits formatting characters inside an assigned segment', () => {
  const outcome = applyOnlineFormattingToSegments({
    reviewText: 'Jan Janssens',
    reviewBegin: 0,
    reviewEnd: 12,
    triggerRange: { begin: 0, end: 12 },
    segments: [{ begin: 0, end: 12, category: 'family' }],
  });

  assert.deepEqual(outcome, [
    { begin: 0, end: 3, category: 'family' },
    { begin: 3, end: 4, category: 'formatting' },
    { begin: 4, end: 12, category: 'family' },
  ]);
});

test('creates formatting segment on uncovered boundary next to new assignment', () => {
  const outcome = applyOnlineFormattingToSegments({
    reviewText: '12/05/1987',
    reviewBegin: 0,
    reviewEnd: 10,
    triggerRange: { begin: 0, end: 2 },
    segments: [{ begin: 0, end: 2, category: 'day' }],
  });

  assert.deepEqual(outcome, [
    { begin: 0, end: 2, category: 'day' },
    { begin: 2, end: 3, category: 'formatting' },
  ]);
});

test('merges adjacent formatting annotations', () => {
  const outcome = applyOnlineFormattingToSegments({
    reviewText: 'A / B',
    reviewBegin: 0,
    reviewEnd: 5,
    triggerRange: { begin: 0, end: 1 },
    segments: [
      { begin: 0, end: 1, category: 'given' },
      { begin: 1, end: 2, category: 'formatting' },
      { begin: 2, end: 3, category: 'formatting' },
    ],
  });

  assert.deepEqual(outcome, [
    { begin: 0, end: 1, category: 'given' },
    { begin: 1, end: 3, category: 'formatting' },
  ]);
});

test('keeps decimal dots inside age value segments', () => {
  const outcome = applyOnlineFormattingToSegments({
    reviewText: '76.5',
    reviewBegin: 0,
    reviewEnd: 4,
    triggerRange: { begin: 0, end: 4 },
    segments: [{ begin: 0, end: 4, category: 'age_year' }],
  });

  assert.deepEqual(outcome, [
    { begin: 0, end: 4, category: 'age_year' },
  ]);
});

test('keeps decimal commas inside age value segments', () => {
  const outcome = applyOnlineFormattingToSegments({
    reviewText: '61,2',
    reviewBegin: 0,
    reviewEnd: 4,
    triggerRange: { begin: 0, end: 4 },
    segments: [{ begin: 0, end: 4, category: 'age_year' }],
  });

  assert.deepEqual(outcome, [
    { begin: 0, end: 4, category: 'age_year' },
  ]);
});
