import {
  FORMATTING_CATEGORY,
  findFormattingRuns,
  isFormattingChar,
} from '../../shared/formatting-symbols.js';
import { codePointLength, codePointSlice } from '../../shared/unicode-offsets.js';

function sortSegments(segments) {
  return [...(segments ?? [])]
    .map((segment) => ({
      begin: Number(segment.begin),
      end: Number(segment.end),
      category: String(segment.category ?? '').trim(),
    }))
    .filter((segment) => Number.isInteger(segment.begin) && Number.isInteger(segment.end) && segment.category)
    .sort((a, b) => (a.begin - b.begin) || (a.end - b.end));
}

function mergeAdjacentSegments(segments) {
  if (segments.length <= 1) return segments;
  const merged = [{ ...segments[0] }];
  for (let i = 1; i < segments.length; i += 1) {
    const current = segments[i];
    const prev = merged[merged.length - 1];
    if (prev.category === current.category && prev.end === current.begin) {
      prev.end = current.end;
      continue;
    }
    merged.push({ ...current });
  }
  return merged;
}

function findSegmentCoveringIndex(segments, index) {
  let low = 0;
  let high = segments.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const segment = segments[mid];
    if (index < segment.begin) {
      high = mid - 1;
    } else if (index >= segment.end) {
      low = mid + 1;
    } else {
      return segment;
    }
  }
  return null;
}

function splitFormattingInsideSegments({ segments, reviewText, reviewBegin }) {
  const result = [];
  for (const segment of segments) {
    if (segment.category === FORMATTING_CATEGORY) {
      result.push({ ...segment });
      continue;
    }

    const localBegin = segment.begin - reviewBegin;
    const localEnd = segment.end - reviewBegin;
    const segmentText = codePointSlice(reviewText, localBegin, localEnd);
    const formattingRuns = findFormattingRuns(segmentText, {
      category: segment.category,
    });
    if (formattingRuns.length === 0) {
      result.push({ ...segment });
      continue;
    }

    let cursor = 0;
    for (const run of formattingRuns) {
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
    if (cursor < codePointLength(segmentText)) {
      result.push({
        begin: segment.begin + cursor,
        end: segment.end,
        category: segment.category,
      });
    }
  }
  return result;
}

function collectBoundaryFormattingSegments({
  segments,
  reviewText,
  reviewBegin,
  reviewEnd,
  triggerRange,
}) {
  if (!triggerRange) return [];

  const runs = [];
  const leftStart = Math.max(reviewBegin, triggerRange.begin) - 1;
  const rightStart = Math.min(reviewEnd, triggerRange.end);

  let leftCursor = leftStart;
  while (leftCursor >= reviewBegin) {
    if (findSegmentCoveringIndex(segments, leftCursor)) break;
    const char = reviewText[leftCursor - reviewBegin];
    if (!isFormattingChar(char)) break;
    leftCursor -= 1;
  }
  const leftRunBegin = leftCursor + 1;
  if (leftRunBegin < triggerRange.begin) {
    runs.push({
      begin: leftRunBegin,
      end: triggerRange.begin,
      category: FORMATTING_CATEGORY,
    });
  }

  let rightCursor = rightStart;
  while (rightCursor < reviewEnd) {
    if (findSegmentCoveringIndex(segments, rightCursor)) break;
    const char = reviewText[rightCursor - reviewBegin];
    if (!isFormattingChar(char)) break;
    rightCursor += 1;
  }
  if (rightStart < rightCursor) {
    runs.push({
      begin: rightStart,
      end: rightCursor,
      category: FORMATTING_CATEGORY,
    });
  }

  return runs;
}

export function applyOnlineFormattingToSegments({
  segments,
  reviewText,
  reviewBegin,
  reviewEnd,
  triggerRange,
}) {
  const normalizedSegments = sortSegments(segments);
  if (normalizedSegments.length === 0) return [];

  const text = String(reviewText ?? '');
  const splitSegments = splitFormattingInsideSegments({
    segments: normalizedSegments,
    reviewText: text,
    reviewBegin: Number(reviewBegin ?? 0),
  }).sort((a, b) => (a.begin - b.begin) || (a.end - b.end));

  const boundaryFormattingSegments = collectBoundaryFormattingSegments({
    segments: splitSegments,
    reviewText: text,
    reviewBegin: Number(reviewBegin ?? 0),
    reviewEnd: Number(reviewEnd ?? 0),
    triggerRange,
  });

  return mergeAdjacentSegments(
    [...splitSegments, ...boundaryFormattingSegments].sort(
      (a, b) => (a.begin - b.begin) || (a.end - b.end),
    ),
  );
}
