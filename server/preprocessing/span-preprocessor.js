import {
  FORMATTING_CATEGORY,
  findFormattingRuns,
} from "../../shared/formatting-symbols.js";
import { codePointLength, codePointSlice } from "../../shared/unicode-offsets.js";

// Broad seed categories used by project-store when it converts a primary gold
// span into an initial core PII subannotation. This module deliberately
// has no external-lexicon loader or resource discovery mechanism.
export const DATETIME_IDENTIFIER_CATEGORY = "datetime_identifier";
export const NAME_IDENTIFIER_CATEGORY = "name_identifier";
export const ADDRESS_IDENTIFIER_CATEGORY = "address_identifier";
export const ORGANIZATION_IDENTIFIER_CATEGORY = "organization_identifier";
export const CONTACT_IDENTIFIER_CATEGORY = "contact_identifier";
export const ID_IDENTIFIER_CATEGORY = "id_identifier";
export const MEDICAL_INFO_CATEGORY = "medical_info";
export const ADDITIONAL_INFO_CATEGORY = "additional_info";

const FORMATTING_RULE_ID = "split_formatting_runs";

function normalizeSegments(item, segments) {
  const reviewBegin = Number(item?.reviewBegin ?? 0);
  const reviewText = String(item?.reviewText ?? "");
  const reviewEnd = Number(item?.reviewEnd ?? reviewBegin + codePointLength(reviewText));

  return (Array.isArray(segments) ? segments : [])
    .map((segment) => ({
      begin: Math.max(reviewBegin, Number(segment?.begin)),
      end: Math.min(reviewEnd, Number(segment?.end)),
      category: String(segment?.category ?? ADDITIONAL_INFO_CATEGORY),
    }))
    .filter(
      (segment) =>
        Number.isFinite(segment.begin) &&
        Number.isFinite(segment.end) &&
        segment.end > segment.begin,
    )
    .sort((left, right) => left.begin - right.begin || left.end - right.end);
}

function splitFormatting(item, segment) {
  const reviewBegin = Number(item?.reviewBegin ?? 0);
  const reviewText = String(item?.reviewText ?? "");
  const localBegin = segment.begin - reviewBegin;
  const localEnd = segment.end - reviewBegin;
  const text = codePointSlice(reviewText, localBegin, localEnd);
  const runs = findFormattingRuns(text, { category: segment.category });
  if (runs.length === 0) return [{ ...segment }];

  const result = [];
  let cursor = 0;
  for (const run of runs) {
    if (run.start > cursor) {
      result.push({
        begin: segment.begin + cursor,
        end: segment.begin + run.start,
        category: segment.category,
      });
    }
    result.push({
      begin: segment.begin + run.start,
      end: segment.begin + run.end,
      category: FORMATTING_CATEGORY,
    });
    cursor = run.end;
  }
  if (cursor < codePointLength(text)) {
    result.push({
      begin: segment.begin + cursor,
      end: segment.end,
      category: segment.category,
    });
  }
  return result;
}

function segmentsEqual(left, right) {
  return (
    left.length === right.length &&
    left.every(
      (segment, index) =>
        segment.begin === right[index].begin &&
        segment.end === right[index].end &&
        segment.category === right[index].category,
    )
  );
}

function traceSegments(item, segments) {
  const reviewBegin = Number(item?.reviewBegin ?? 0);
  const reviewText = String(item?.reviewText ?? "");
  return segments.map((segment) => ({
    ...segment,
    localBegin: segment.begin - reviewBegin,
    localEnd: segment.end - reviewBegin,
    text: codePointSlice(reviewText, segment.begin - reviewBegin, segment.end - reviewBegin),
  }));
}

// Identifying core content is determined by a gold annotator. The initializer
// therefore performs only a structural, fully reproducible operation: it marks
// whitespace and punctuation as formatting. Semantic subdivision is left to
// the reviewer instead of being guessed from unpublished lexical resources.
export const SPAN_PREPROCESSOR_RULES = Object.freeze([
  Object.freeze({ ruleId: FORMATTING_RULE_ID }),
]);

export function runSpanPreprocessorForItem({
  item,
  segments,
  includeTrace = false,
}) {
  const originalSegments = normalizeSegments(item, segments);
  const processedSegments = originalSegments.flatMap((segment) =>
    splitFormatting(item, segment),
  );
  const changed = !segmentsEqual(originalSegments, processedSegments);
  const ruleHits = changed ? { [FORMATTING_RULE_ID]: 1 } : {};

  return {
    segments: processedSegments,
    changed,
    ruleHits,
    ...(includeTrace
      ? {
          ruleTrace: [
            {
              phase: "structural",
              ruleId: FORMATTING_RULE_ID,
              hitCount: changed ? 1 : 0,
              changed,
              beforeSegments: traceSegments(item, originalSegments),
              afterSegments: traceSegments(item, processedSegments),
            },
          ],
        }
      : {}),
  };
}
