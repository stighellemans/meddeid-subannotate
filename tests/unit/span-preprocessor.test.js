import test from "node:test";
import assert from "node:assert/strict";

import { runSpanPreprocessorForItem } from "../../server/preprocessing/span-preprocessor.js";

test("splits formatting without lexical lookup data", () => {
  const item = {
    reviewBegin: 100,
    reviewEnd: 111,
    reviewText: "Jan, Peeters",
  };
  const outcome = runSpanPreprocessorForItem({
    item,
    segments: [{ begin: 100, end: 111, category: "name_identifier" }],
  });

  assert.deepEqual(outcome.segments, [
    { begin: 100, end: 103, category: "name_identifier" },
    { begin: 103, end: 105, category: "formatting" },
    { begin: 105, end: 111, category: "name_identifier" },
  ]);
  assert.deepEqual(outcome.ruleHits, { split_formatting_runs: 1 });
});

test("preserves semantic text exactly and clamps ranges to the review window", () => {
  const item = { reviewBegin: 5, reviewEnd: 8, reviewText: "UZA" };
  const outcome = runSpanPreprocessorForItem({
    item,
    segments: [{ begin: 0, end: 99, category: "organization_identifier" }],
  });

  assert.equal(outcome.changed, false);
  assert.deepEqual(outcome.segments, [
    { begin: 5, end: 8, category: "organization_identifier" },
  ]);
});

test("returns a reproducible trace without exposing lookup provenance", () => {
  const item = { reviewBegin: 0, reviewEnd: 5, reviewText: "09/11" };
  const outcome = runSpanPreprocessorForItem({
    item,
    segments: [{ begin: 0, end: 5, category: "datetime_identifier" }],
    includeTrace: true,
  });

  assert.equal(outcome.ruleTrace.length, 1);
  assert.equal(outcome.ruleTrace[0].ruleId, "split_formatting_runs");
  assert.deepEqual(
    outcome.ruleTrace[0].afterSegments.map(({ localBegin, localEnd }) => ({ localBegin, localEnd })),
    [
      { localBegin: 0, localEnd: 2 },
      { localBegin: 2, localEnd: 3 },
      { localBegin: 3, localEnd: 5 },
    ],
  );
  assert.deepEqual(
    outcome.segments.map((segment) => segment.category),
    ["datetime_identifier", "formatting", "datetime_identifier"],
  );
});
