export function truncateDisplayValue(value, maxDisplayChars) {
  const normalizedValue = String(value ?? "");

  if (
    !Number.isInteger(maxDisplayChars) ||
    maxDisplayChars < 1 ||
    normalizedValue.length <= maxDisplayChars
  ) {
    return normalizedValue;
  }

  return `${normalizedValue.slice(0, maxDisplayChars)}...`;
}
