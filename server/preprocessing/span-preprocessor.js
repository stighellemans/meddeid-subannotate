import {
  DEFAULT_FORMATTING_POLICY,
  FORMATTING_CATEGORY,
  findFormattingRuns,
} from '../../shared/formatting-symbols.js';
import { codePointLength, codePointSlice } from '../../shared/unicode-offsets.js';
import { neutralSubannotationProfile } from '../subannotation-profile.js';

const FORMATTING_RULE_ID = 'split_formatting_runs';

function mergeAdjacentSegments(segments) {
  if (segments.length === 0) return [];
  const merged = [{ ...segments[0] }];
  for (let index = 1; index < segments.length; index += 1) {
    const current = segments[index];
    const previous = merged[merged.length - 1];
    if (previous.category === current.category && previous.end === current.begin) {
      previous.end = current.end;
    } else {
      merged.push({ ...current });
    }
  }
  return merged;
}

function normalizeSegments(item, segments) {
  const reviewBegin = Number(item?.reviewBegin ?? 0);
  const reviewText = String(item?.reviewText ?? '');
  const reviewEnd = Number(item?.reviewEnd ?? reviewBegin + codePointLength(reviewText));

  return (Array.isArray(segments) ? segments : [])
    .map((segment) => ({
      begin: Math.max(reviewBegin, Number(segment?.begin)),
      end: Math.min(reviewEnd, Number(segment?.end)),
      category: String(segment?.category ?? 'additional_info'),
    }))
    .filter((segment) => Number.isFinite(segment.begin) && Number.isFinite(segment.end) && segment.end > segment.begin)
    .sort((left, right) => left.begin - right.begin || left.end - right.end);
}

function splitFormatting(item, segment, profile) {
  const formattingCategory = profile?.formattingCategory ?? FORMATTING_CATEGORY;
  if (segment.category === formattingCategory) return [{ ...segment }];
  const reviewBegin = Number(item?.reviewBegin ?? 0);
  const reviewText = String(item?.reviewText ?? '');
  const text = codePointSlice(
    reviewText,
    segment.begin - reviewBegin,
    segment.end - reviewBegin,
  );
  const runs = findFormattingRuns(text, {
    category: segment.category,
    policy: profile?.formattingPolicy ?? DEFAULT_FORMATTING_POLICY,
  });
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
      category: formattingCategory,
    });
    cursor = run.end;
  }
  if (cursor < codePointLength(text)) {
    result.push({ begin: segment.begin + cursor, end: segment.end, category: segment.category });
  }
  return result;
}

function segmentsEqual(left, right) {
  return left.length === right.length && left.every((segment, index) => (
    segment.begin === right[index].begin &&
    segment.end === right[index].end &&
    segment.category === right[index].category
  ));
}

function traceSegments(item, segments) {
  const reviewBegin = Number(item?.reviewBegin ?? 0);
  const reviewText = String(item?.reviewText ?? '');
  return segments.map((segment) => ({
    ...segment,
    localBegin: segment.begin - reviewBegin,
    localEnd: segment.end - reviewBegin,
    text: codePointSlice(reviewText, segment.begin - reviewBegin, segment.end - reviewBegin),
  }));
}

export const SPAN_PREPROCESSOR_RULES = Object.freeze([
  Object.freeze({ ruleId: FORMATTING_RULE_ID }),
]);

export function runSpanPreprocessorForItem({
  item,
  segments,
  profile = neutralSubannotationProfile,
  includeTrace = false,
}) {
  const originalSegments = normalizeSegments(item, segments);
  let workingSegments = originalSegments.map((segment) => ({ ...segment }));
  const ruleHits = {};
  const ruleTrace = [];
  const reviewBegin = Number(item?.reviewBegin ?? 0);
  const reviewText = String(item?.reviewText ?? '');

  for (const rule of profile.rules ?? []) {
    const before = workingSegments.map((segment) => ({ ...segment }));
    const next = [];
    let hitCount = 0;
    for (const segment of workingSegments) {
      const text = codePointSlice(
        reviewText,
        segment.begin - reviewBegin,
        segment.end - reviewBegin,
      );
      const transformed = rule.transformSegment({ item, segment, text, profile });
      if (transformed == null) {
        next.push({ ...segment });
      } else {
        hitCount += 1;
        next.push(...normalizeSegments(item, transformed));
      }
    }
    workingSegments = mergeAdjacentSegments(next);
    if (hitCount > 0) ruleHits[rule.ruleId] = hitCount;
    if (includeTrace) {
      ruleTrace.push({
        phase: 'semantic',
        ruleId: rule.ruleId,
        hitCount,
        changed: !segmentsEqual(before, workingSegments),
        beforeSegments: traceSegments(item, before),
        afterSegments: traceSegments(item, workingSegments),
      });
    }
  }

  const beforeFormatting = workingSegments.map((segment) => ({ ...segment }));
  workingSegments = mergeAdjacentSegments(
    workingSegments.flatMap((segment) => splitFormatting(item, segment, profile)),
  );
  const formattingChanged = !segmentsEqual(beforeFormatting, workingSegments);
  if (formattingChanged) ruleHits[FORMATTING_RULE_ID] = 1;
  if (includeTrace) {
    ruleTrace.push({
      phase: 'structural',
      ruleId: FORMATTING_RULE_ID,
      hitCount: formattingChanged ? 1 : 0,
      changed: formattingChanged,
      beforeSegments: traceSegments(item, beforeFormatting),
      afterSegments: traceSegments(item, workingSegments),
    });
  }

  return {
    segments: workingSegments,
    changed: !segmentsEqual(originalSegments, workingSegments),
    ruleHits,
    ...(includeTrace ? { ruleTrace } : {}),
  };
}
