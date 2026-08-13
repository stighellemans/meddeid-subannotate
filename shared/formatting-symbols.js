import { codePoints } from './unicode-offsets.js';

export const FORMATTING_CATEGORY = 'formatting';

export const FORMATTING_SYMBOLS = Object.freeze([
  "'",
  '"',
  "’",
  "“",
  "”",
  "°",
  '/',
  '-',
  '–',
  '_',
  '+',
  '.',
  ',',
  ':',
  ';',
  '|',
  '(',
  ')',
  '[',
  ']',
  '{',
  '}',
]);

const FORMATTING_SYMBOL_SET = new Set(FORMATTING_SYMBOLS);
const WHITESPACE_CHAR_PATTERN = /\s/u;
const AGE_VALUE_CATEGORY_SET = new Set([
  'age_year',
  'age_month',
  'age_week',
  'age_day',
]);
const AGE_DECIMAL_SEPARATOR_SET = new Set(['.', ',']);

function isDigitChar(char) {
  return char >= '0' && char <= '9';
}

export function isFormattingChar(char) {
  if (!char) return false;
  return WHITESPACE_CHAR_PATTERN.test(char) || FORMATTING_SYMBOL_SET.has(char);
}

export function isFormattingText(text) {
  const value = codePoints(text);
  if (!value.length) return false;
  for (const char of value) {
    if (!isFormattingChar(char)) return false;
  }
  return true;
}

function isProtectedFormattingIndex(value, index, category) {
  if (!AGE_VALUE_CATEGORY_SET.has(String(category ?? ''))) return false;
  const char = value[index];
  if (!AGE_DECIMAL_SEPARATOR_SET.has(char)) return false;
  return isDigitChar(value[index - 1] ?? '') && isDigitChar(value[index + 1] ?? '');
}

export function findFormattingRuns(text, { category = '' } = {}) {
  const value = codePoints(text);
  const runs = [];
  let runStart = -1;
  for (let i = 0; i < value.length; i += 1) {
    if (isFormattingChar(value[i]) && !isProtectedFormattingIndex(value, i, category)) {
      if (runStart < 0) runStart = i;
      continue;
    }
    if (runStart >= 0) {
      runs.push({ start: runStart, end: i });
      runStart = -1;
    }
  }
  if (runStart >= 0) {
    runs.push({ start: runStart, end: value.length });
  }
  return runs;
}
