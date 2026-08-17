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

export const DEFAULT_FORMATTING_POLICY = Object.freeze({
  symbols: FORMATTING_SYMBOLS,
  protectedDecimalCategories: Object.freeze([
    'age_year',
    'age_month',
    'age_week',
    'age_day',
  ]),
  decimalSeparators: Object.freeze(['.', ',']),
});

const WHITESPACE_CHAR_PATTERN = /\s/u;

function isDigitChar(char) {
  return char >= '0' && char <= '9';
}

export function isFormattingChar(char, policy = DEFAULT_FORMATTING_POLICY) {
  if (!char) return false;
  const symbols = new Set(policy?.symbols ?? DEFAULT_FORMATTING_POLICY.symbols);
  return WHITESPACE_CHAR_PATTERN.test(char) || symbols.has(char);
}

export function isFormattingText(text, policy = DEFAULT_FORMATTING_POLICY) {
  const value = codePoints(text);
  if (!value.length) return false;
  for (const char of value) {
    if (!isFormattingChar(char, policy)) return false;
  }
  return true;
}

function isProtectedFormattingIndex(value, index, category, policy) {
  const protectedCategories = new Set(
    policy?.protectedDecimalCategories ?? DEFAULT_FORMATTING_POLICY.protectedDecimalCategories,
  );
  if (!protectedCategories.has(String(category ?? ''))) return false;
  const char = value[index];
  const decimalSeparators = new Set(
    policy?.decimalSeparators ?? DEFAULT_FORMATTING_POLICY.decimalSeparators,
  );
  if (!decimalSeparators.has(char)) return false;
  return isDigitChar(value[index - 1] ?? '') && isDigitChar(value[index + 1] ?? '');
}

export function findFormattingRuns(
  text,
  { category = '', policy = DEFAULT_FORMATTING_POLICY } = {},
) {
  const value = codePoints(text);
  const runs = [];
  let runStart = -1;
  for (let i = 0; i < value.length; i += 1) {
    if (
      isFormattingChar(value[i], policy) &&
      !isProtectedFormattingIndex(value, i, category, policy)
    ) {
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
