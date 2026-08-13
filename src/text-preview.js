export function collapseWhitespaceForInlinePreview(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}
