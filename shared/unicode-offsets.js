// Canonical MedDeID offsets count Unicode code points, not JavaScript UTF-16
// code units. Keep conversions at explicit text boundaries.
export function codePoints(text) {
  return Array.from(String(text ?? ''));
}

export function codePointLength(text) {
  return codePoints(text).length;
}

export function codePointSlice(text, begin, end) {
  return codePoints(text).slice(begin, end).join('');
}
