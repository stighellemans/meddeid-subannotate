import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { applyOnlineFormattingToSegments } from "./annotation/online-formatter.js";
import { collapseWhitespaceForInlinePreview } from "./text-preview.js";
import { truncateDisplayValue } from "./truncate-display-value.js";
import { codePointSlice, codePoints } from "../shared/unicode-offsets.js";

function hashString(value) {
  let h = 0;
  for (let i = 0; i < value.length; i += 1) {
    h = (h * 31 + value.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

const CATEGORY_COLOR_PALETTE = (() => {
  const saturationSteps = [64, 72, 80];
  const lightnessSteps = [78, 84];
  const palette = [];
  for (let i = 0; i < 72; i += 1) {
    const hue = Math.round((i * 137.508) % 360);
    const saturation = saturationSteps[i % saturationSteps.length];
    const lightness =
      lightnessSteps[
        Math.floor(i / saturationSteps.length) % lightnessSteps.length
      ];
    palette.push({
      hue,
      saturation,
      lightness,
      css: `hsl(${hue} ${saturation}% ${lightness}%)`,
    });
  }
  return palette;
})();

const CATEGORY_COLOR_OVERRIDES = new Map([
  ["given", "hsl(205 78% 79%)"],
  ["family", "hsl(24 84% 80%)"],
]);

function getCategoryColorOverride(category) {
  const normalized = String(category ?? "")
    .trim()
    .toLowerCase();
  return CATEGORY_COLOR_OVERRIDES.get(normalized) ?? null;
}

function colorDistance(a, b) {
  const hueDiff = Math.abs(a.hue - b.hue);
  const wrappedHueDiff = Math.min(hueDiff, 360 - hueDiff);
  const saturationDiff = Math.abs(a.saturation - b.saturation);
  const lightnessDiff = Math.abs(a.lightness - b.lightness);
  return wrappedHueDiff + saturationDiff * 1.5 + lightnessDiff * 1.2;
}

function fallbackCategoryColor(category) {
  const hash = hashString(String(category ?? ""));
  const hue = hash % 360;
  const saturation = 62 + (Math.floor(hash / 360) % 4) * 8;
  const lightness = 76 + (Math.floor(hash / (360 * 4)) % 3) * 6;
  return `hsl(${hue} ${saturation}% ${lightness}%)`;
}

function buildCategoryColorMap(categoryNames) {
  const colors = new Map();
  const uniqueCategories = uniqueStringsInOrder(categoryNames);
  if (uniqueCategories.length === 0) return colors;

  const paletteSize = CATEGORY_COLOR_PALETTE.length;
  const probeStep = 29;
  const usedPaletteIndexes = [];
  const usedPaletteIndexSet = new Set();
  const orderedCategories = [...uniqueCategories].sort(
    (a, b) => hashString(a) - hashString(b) || a.localeCompare(b)
  );

  for (const category of orderedCategories) {
    const overrideColor = getCategoryColorOverride(category);
    if (overrideColor) {
      colors.set(category, overrideColor);
      continue;
    }

    const baseIndex = hashString(category) % paletteSize;
    let bestPaletteIndex = null;
    let bestScore = -Infinity;
    let bestAttempt = Infinity;

    for (let attempt = 0; attempt < paletteSize; attempt += 1) {
      const paletteIndex = (baseIndex + attempt * probeStep) % paletteSize;
      if (usedPaletteIndexSet.has(paletteIndex)) continue;

      const candidate = CATEGORY_COLOR_PALETTE[paletteIndex];
      const minDistance =
        usedPaletteIndexes.length === 0
          ? Number.POSITIVE_INFINITY
          : usedPaletteIndexes.reduce((bestDistance, usedIndex) => {
              const used = CATEGORY_COLOR_PALETTE[usedIndex];
              return Math.min(bestDistance, colorDistance(candidate, used));
            }, Number.POSITIVE_INFINITY);

      if (
        minDistance > bestScore ||
        (minDistance === bestScore && attempt < bestAttempt)
      ) {
        bestScore = minDistance;
        bestAttempt = attempt;
        bestPaletteIndex = paletteIndex;
      }
    }

    if (bestPaletteIndex !== null) {
      usedPaletteIndexSet.add(bestPaletteIndex);
      usedPaletteIndexes.push(bestPaletteIndex);
      colors.set(category, CATEGORY_COLOR_PALETTE[bestPaletteIndex].css);
    } else {
      colors.set(category, fallbackCategoryColor(category));
    }
  }

  return colors;
}

function mergeAdjacentSegments(segments) {
  if (segments.length <= 1) return segments;
  const sorted = [...segments].sort(
    (a, b) => a.begin - b.begin || a.end - b.end
  );
  const merged = [{ ...sorted[0] }];
  for (let i = 1; i < sorted.length; i += 1) {
    const current = sorted[i];
    const prev = merged[merged.length - 1];
    if (prev.category === current.category && prev.end === current.begin) {
      prev.end = current.end;
    } else {
      merged.push({ ...current });
    }
  }
  return merged;
}

function applyCategoryToSegments(segments, range, category) {
  const next = [];
  for (const segment of segments) {
    if (segment.end <= range.begin || segment.begin >= range.end) {
      next.push({ ...segment });
      continue;
    }
    if (segment.begin < range.begin) {
      next.push({ ...segment, end: range.begin });
    }
    if (segment.end > range.end) {
      next.push({ ...segment, begin: range.end });
    }
  }
  next.push({ begin: range.begin, end: range.end, category });
  return mergeAdjacentSegments(next);
}

function computeCoverage(item, segments) {
  const total = item.reviewEnd - item.reviewBegin;
  const sorted = [...segments].sort(
    (a, b) => a.begin - b.begin || a.end - b.end
  );
  let cursor = item.reviewBegin;
  let covered = 0;
  let complete = true;
  for (const segment of sorted) {
    if (segment.begin !== cursor) complete = false;
    covered += segment.end - segment.begin;
    cursor = segment.end;
  }
  if (cursor !== item.reviewEnd) complete = false;
  return {
    totalChars: total,
    coveredChars: covered,
    uncategorizedChars: Math.max(0, total - covered),
    complete,
  };
}

function mergeRanges(ranges) {
  const normalized = (ranges ?? [])
    .map((range) => ({
      begin: Number(range.begin),
      end: Number(range.end),
    }))
    .filter(
      (range) =>
        Number.isInteger(range.begin) &&
        Number.isInteger(range.end) &&
        range.begin < range.end
    )
    .sort((a, b) => a.begin - b.begin || a.end - b.end);
  if (normalized.length === 0) return [];

  const merged = [{ ...normalized[0] }];
  for (let i = 1; i < normalized.length; i += 1) {
    const prev = merged[merged.length - 1];
    const cur = normalized[i];
    if (cur.begin <= prev.end) {
      prev.end = Math.max(prev.end, cur.end);
      continue;
    }
    merged.push({ ...cur });
  }
  return merged;
}

function extractSegmentsWithinRanges(segments, ranges) {
  const mergedRanges = mergeRanges(ranges);
  if (mergedRanges.length === 0) return [];

  const extracted = [];
  for (const segment of segments ?? []) {
    for (const range of mergedRanges) {
      const begin = Math.max(segment.begin, range.begin);
      const end = Math.min(segment.end, range.end);
      if (begin < end) {
        extracted.push({
          begin,
          end,
          category: String(segment.category ?? "").trim(),
        });
      }
      if (range.begin >= segment.end) {
        break;
      }
    }
  }

  return mergeAdjacentSegments(
    extracted.sort(
      (a, b) =>
        a.begin - b.begin || a.end - b.end || a.category.localeCompare(b.category)
    )
  );
}

function segmentsEqual(left, right) {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    const a = left[i];
    const b = right[i];
    if (a.begin !== b.begin || a.end !== b.end || a.category !== b.category) {
      return false;
    }
  }
  return true;
}

function rangeOverlapsRanges(range, ranges) {
  return (ranges ?? []).some(
    (lockedRange) =>
      Math.max(range.begin, lockedRange.begin) < Math.min(range.end, lockedRange.end)
  );
}

function getUnlockedIntervalContainingIndex(item, index) {
  if (!item) return null;
  const reviewBegin = Number(item.reviewBegin);
  const reviewEnd = Number(item.reviewEnd);
  if (index < reviewBegin || index >= reviewEnd) return null;

  const lockedRanges = mergeRanges(item.lockedRanges ?? []);
  let intervalBegin = reviewBegin;
  let intervalEnd = reviewEnd;
  for (const lockedRange of lockedRanges) {
    if (index >= lockedRange.begin && index < lockedRange.end) {
      return null;
    }
    if (lockedRange.end <= index) {
      intervalBegin = Math.max(intervalBegin, lockedRange.end);
      continue;
    }
    if (lockedRange.begin > index) {
      intervalEnd = Math.min(intervalEnd, lockedRange.begin);
      break;
    }
  }

  if (intervalBegin >= intervalEnd) return null;
  return {
    begin: intervalBegin,
    end: intervalEnd,
  };
}

function formatPercent(value, total) {
  if (!total) return "0%";
  return `${Math.round((value / total) * 100)}%`;
}

function formatPercentOneDecimal(value, total) {
  if (!total) return "0.0%";
  return `${((value / total) * 100).toFixed(1)}%`;
}

function renderChar(ch) {
  if (ch === "\t") return "    ";
  return ch;
}

function isEditableTarget(target) {
  if (!target || !(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

function uniqueStringsInOrder(values) {
  const result = [];
  const seen = new Set();
  for (const value of values ?? []) {
    const next = String(value ?? "").trim();
    if (!next || seen.has(next)) continue;
    seen.add(next);
    result.push(next);
  }
  return result;
}

function formatDocFilterOptionLabel(doc) {
  return `${doc.documentId} (${doc.confirmedItems ?? doc.confirmedGoldSpans}/${
    doc.itemCount ?? doc.goldSpanCount
  })`;
}

function getDocFilterOptionId(value) {
  return `doc-filter-option-${String(value ?? "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "-")}`;
}

const METADATA_FILLER = "N/A";

function normalizeMetadataValue(value) {
  const normalized = String(value ?? "").trim();
  return normalized || METADATA_FILLER;
}

function normalizeDocumentMetadata(doc) {
  return {
    patientGivenName: normalizeMetadataValue(doc?.patientGivenName),
    patientLastName: normalizeMetadataValue(doc?.patientLastName),
    patientBirthdate: normalizeMetadataValue(doc?.patientBirthdate),
    textCreationDate: normalizeMetadataValue(doc?.textCreationDate),
    language: normalizeMetadataValue(doc?.language),
  };
}

function buildSourceColorTokens(sourceId) {
  const normalizedSource = normalizeMetadataValue(sourceId);
  if (normalizedSource === METADATA_FILLER) {
    return {
      border: "#93a0b6",
      chipBackground: "#eef2f7",
      chipText: "#3d4a61",
    };
  }

  // Color is derived from the exact annotation_id to keep mapping stable.
  const seed = hashString(normalizedSource.toLowerCase());
  const hue = seed % 360;
  const saturation = 58 + (Math.floor(seed / 360) % 12);
  const softLightness = 89 - (Math.floor(seed / (360 * 12)) % 8);
  const accentLightness = 42 + (Math.floor(seed / (360 * 12 * 8)) % 10);

  return {
    border: `hsl(${hue} ${Math.min(88, saturation + 18)}% ${accentLightness}%)`,
    chipBackground: `hsl(${hue} ${saturation}% ${softLightness}%)`,
    chipText: `hsl(${hue} ${Math.min(92, saturation + 20)}% 28%)`,
  };
}

function normalizeCategoryGroupKey(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

function getOffsetTopWithinAncestor(element, ancestor) {
  let top = 0;
  let node = element;
  while (node && node !== ancestor) {
    top += node.offsetTop;
    node = node.offsetParent;
  }
  return node === ancestor ? top : null;
}

const KEYBOARD_LAYOUT_STORAGE_KEY = "annotator.keyboardLayout";
const FILTERS_SHORTCUT_LABEL = "Shift+F";
const ITEM_STATUS_FILTER_OPTIONS = [
  { key: "confirmed", label: "Confirmed" },
  { key: "ready_to_confirm", label: "Ready to confirm" },
  { key: "in_progress", label: "In progress" },
];
const ITEM_STATUS_LABELS = Object.fromEntries(
  ITEM_STATUS_FILTER_OPTIONS.map((option) => [option.key, option.label])
);
const KEYBOARD_LAYOUTS = new Set(["qwerty", "azerty"]);
const CATEGORY_SHORTCUT_LETTER_POOLS = {
  qwerty: [
    "q",
    "w",
    "r",
    "t",
    "y",
    "u",
    "i",
    "o",
    "p",
    "s",
    "d",
    "f",
    "v",
    "b",
    "m",
    "z",
  ],
  azerty: [
    "a",
    "z",
    "e",
    "r",
    "t",
    "y",
    "u",
    "i",
    "o",
    "p",
    "s",
    "d",
    "f",
    "v",
    "b",
    "m",
    "w",
  ],
};
const RESERVED_CATEGORY_SHORTCUT_TOKENS = new Set([
  // Keep category tokens off keys already used by app shortcuts.
  "a", // Select full annotation span
  "x", // Clear all labels
]);

function normalizeKeyboardLayout(value) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  return KEYBOARD_LAYOUTS.has(normalized) ? normalized : "qwerty";
}

function getCategoryShortcutTokenFromEvent(event) {
  if (!event) return null;
  const { code, key } = event;

  if (typeof code === "string") {
    const digitMatch = /^Digit([1-9])$/.exec(code);
    if (digitMatch) return digitMatch[1];
    const numpadMatch = /^Numpad([1-9])$/.exec(code);
    if (numpadMatch) return numpadMatch[1];
  }

  if (typeof key !== "string" || key.length !== 1) return null;
  if (key >= "1" && key <= "9") return key;
  if (/^[a-z]$/i.test(key)) return key.toLowerCase();
  return null;
}

function getItemStatusKey(item) {
  if (!item) return "in_progress";
  if (item.saved?.status === "confirmed") return "confirmed";
  const coverage =
    item.coverage ?? computeCoverage(item, item.saved?.segments ?? []);
  return coverage.complete ? "ready_to_confirm" : "in_progress";
}

function getItemDisplayLabel(item) {
  if (!item) return "(No label)";
  const rawLabel = String(item.gold?.label ?? "").trim();
  return rawLabel || "(No label)";
}

function formatDebugSegmentsBlock(segments) {
  if (!Array.isArray(segments) || segments.length === 0) return "(none)";
  return segments
    .map(
      (segment) =>
        `[${segment.begin}, ${segment.end}) local[${segment.localBegin}, ${
          segment.localEnd
        }) ${segment.category} ${JSON.stringify(segment.text ?? "")}`
    )
    .join("\n");
}

function formatDebugSegmentsInline(segments) {
  if (!Array.isArray(segments) || segments.length === 0) return "(none)";
  return segments
    .map(
      (segment) =>
        `[${segment.localBegin}, ${segment.localEnd}) ${
          segment.category
        } ${JSON.stringify(segment.text ?? "")}`
    )
    .join(" | ");
}

function formatDebugRuleHits(ruleHits) {
  const entries = Object.entries(ruleHits ?? {});
  if (entries.length === 0) return "none";
  return entries.map(([ruleId, count]) => `${ruleId}=${count}`).join(", ");
}

function formatDebugScore(score) {
  if (!score) return "no score";
  return `PC ${score.primaryCoverage ?? 0} · PNF ${
    score.primaryNonFormattingCoverage ?? 0
  } · C ${score.coverage ?? 0} · NF ${score.nonFormattingCoverage ?? 0}`;
}

function CopyIcon() {
  return (
    <svg className="copyable-value-icon" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M15 9V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h4" />
    </svg>
  );
}

async function copyTextToClipboard(text) {
  const value = String(text ?? "");
  if (!value) return;

  if (globalThis.navigator?.clipboard?.writeText) {
    await globalThis.navigator.clipboard.writeText(value);
    return;
  }

  if (typeof document === "undefined") {
    throw new Error("Clipboard is unavailable");
  }

  const textArea = document.createElement("textarea");
  textArea.value = value;
  textArea.setAttribute("readonly", "");
  textArea.style.position = "fixed";
  textArea.style.opacity = "0";
  textArea.style.pointerEvents = "none";

  document.body.appendChild(textArea);

  try {
    textArea.focus();
    textArea.select();
    textArea.setSelectionRange(0, value.length);
    if (!document.execCommand("copy")) {
      throw new Error("Copy command failed");
    }
  } finally {
    document.body.removeChild(textArea);
  }
}

function CopyableTruncatedValue({
  value,
  className = "",
  textClassName = "",
  buttonClassName = "",
  copyAriaLabel = "Copy full value",
  maxDisplayChars = null,
}) {
  const displayValue = String(value ?? "").trim() || METADATA_FILLER;
  const truncatedDisplayValue = truncateDisplayValue(
    displayValue,
    maxDisplayChars
  );
  const [copyState, setCopyState] = useState("idle");

  useEffect(() => {
    if (copyState === "idle") return undefined;

    const timeoutId = setTimeout(
      () => {
        setCopyState("idle");
      },
      copyState === "copied" ? 1600 : 2200
    );

    return () => clearTimeout(timeoutId);
  }, [copyState]);

  async function handleCopy() {
    if (displayValue === METADATA_FILLER) return;

    try {
      await copyTextToClipboard(displayValue);
      setCopyState("copied");
    } catch {
      setCopyState("error");
    }
  }

  const buttonAriaLabel =
    copyState === "copied"
      ? `${copyAriaLabel} (copied)`
      : copyState === "error"
      ? `${copyAriaLabel} (retry)`
      : copyAriaLabel;
  const buttonTitle =
    displayValue === METADATA_FILLER
      ? "Nothing to copy"
      : copyState === "copied"
      ? `Copied full text name: ${displayValue}`
      : copyState === "error"
      ? `Retry copying full text name: ${displayValue}`
      : `Copy full text name: ${displayValue}`;

  return (
    <div className={["copyable-value", className].filter(Boolean).join(" ")}>
      <span
        className={["copyable-value-text", textClassName]
          .filter(Boolean)
          .join(" ")}
        title={displayValue}
      >
        {truncatedDisplayValue}
      </span>
      <button
        type="button"
        className={[
          "copyable-value-button",
          copyState === "copied" ? "is-copied" : "",
          copyState === "error" ? "is-error" : "",
          buttonClassName,
        ]
          .filter(Boolean)
          .join(" ")}
        onClick={handleCopy}
        disabled={displayValue === METADATA_FILLER}
        aria-label={buttonAriaLabel}
        title={buttonTitle}
      >
        <CopyIcon />
      </button>
    </div>
  );
}

function docCharColor(category, categoryColors) {
  if (!category) return undefined;
  const normalized = String(category).trim();
  return (
    getCategoryColorOverride(normalized) ??
    categoryColors.get(normalized) ??
    fallbackCategoryColor(normalized)
  );
}

function docCharClassName(charInfo, lockBypassActive) {
  return [
    "doc-char",
    charInfo.inReview ? "in-review" : "dimmed",
    charInfo.inGold ? "in-gold" : "",
    charInfo.inSelection ? "is-selected" : "",
    charInfo.isLocked ? "is-locked" : "",
    charInfo.isLocked && lockBypassActive ? "lock-bypass-active" : "",
    charInfo.category ? "is-categorized" : "",
    charInfo.inReview && !charInfo.category ? "needs-category" : "",
    charInfo.isReviewStart ? "review-start" : "",
    charInfo.isReviewEnd ? "review-end" : "",
  ]
    .filter(Boolean)
    .join(" ");
}

function docCharTitle(charInfo, lockBypassActive) {
  const titleBits = [];
  if (charInfo.inGold) titleBits.push("gold");
  if (charInfo.isLocked) {
    titleBits.push(lockBypassActive ? "imported-lock (Shift)" : "imported-lock");
  }
  if (charInfo.category) titleBits.push(`category=${charInfo.category}`);
  if (!charInfo.category && charInfo.inReview) titleBits.push("uncategorized");
  return titleBits.join(" · ") || undefined;
}

// Renders the document text. Memoized so unrelated state changes (filtering, save
// spinner, panel toggles) don't re-render thousands of character nodes. Only the
// selectable in-review characters get per-char spans + handlers; the dimmed
// context is coalesced into runs of identical styling, cutting DOM/paint cost
// massively (and keeping selection behaviour identical, since drag-select and the
// per-char handlers only ever act on in-review indices).
const DocCharLayer = memo(function DocCharLayer({
  charMeta,
  categoryColors,
  lockBypassActive,
  focusCharRef,
  onCharMouseDown,
  onCharMouseEnter,
}) {
  const nodes = [];
  let run = null;
  const flushRun = () => {
    if (!run) return;
    nodes.push(
      <span
        key={`run-${run.begin}`}
        className={run.className}
        style={run.color ? { backgroundColor: run.color } : undefined}
        title={run.title}
      >
        {run.text}
      </span>
    );
    run = null;
  };

  for (const charInfo of charMeta) {
    const className = docCharClassName(charInfo, lockBypassActive);
    const color = docCharColor(charInfo.category, categoryColors);
    const title = docCharTitle(charInfo, lockBypassActive);

    if (charInfo.inReview) {
      flushRun();
      nodes.push(
        <span
          key={charInfo.index}
          ref={charInfo.isReviewStart ? focusCharRef : null}
          className={className}
          style={color ? { backgroundColor: color } : undefined}
          title={title}
          onMouseDown={(event) => onCharMouseDown(charInfo.index, event)}
          onMouseEnter={() => onCharMouseEnter(charInfo.index)}
        >
          {charInfo.display}
        </span>
      );
      continue;
    }

    const sig = `${className}||${color ?? ""}||${title ?? ""}`;
    if (run && run.sig === sig) {
      run.text += charInfo.display;
    } else {
      flushRun();
      run = { begin: charInfo.index, sig, className, color, title, text: charInfo.display };
    }
  }
  flushRun();
  return nodes;
});

function App() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [documentsById, setDocumentsById] = useState({});
  const [documentMetadataById, setDocumentMetadataById] = useState({});
  const [itemsById, setItemsById] = useState({});
  const [orderedItemIds, setOrderedItemIds] = useState([]);
  const [progress, setProgress] = useState(null);
  const [bootstrapMeta, setBootstrapMeta] = useState({});
  const [startingCategoryGroups, setStartingCategoryGroups] = useState({});
  const [categories, setCategories] = useState([]);
  const [selectedItemId, setSelectedItemId] = useState("");
  const [selectedRange, setSelectedRange] = useState(null); // local to active review span
  const [selectedCategory, setSelectedCategory] = useState("");
  const [selectionCopyState, setSelectionCopyState] = useState("idle");
  const [docFilterQuery, setDocFilterQuery] = useState("");
  const [docFilterQueryDirty, setDocFilterQueryDirty] = useState(false);
  const [docFilterOpen, setDocFilterOpen] = useState(false);
  const [docFilterActiveIndex, setDocFilterActiveIndex] = useState(0);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [includedStatusKeys, setIncludedStatusKeys] = useState(() =>
    ITEM_STATUS_FILTER_OPTIONS.map((option) => option.key)
  );
  const [includedLabels, setIncludedLabels] = useState([]);
  const [saveState, setSaveState] = useState({
    state: "idle",
    itemId: null,
    message: "",
  });
  const [preprocessorBusy, setPreprocessorBusy] = useState(false);
  const [historyTick, setHistoryTick] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [rebaseOpen, setRebaseOpen] = useState(false);
  const [rebaseBusy, setRebaseBusy] = useState("");
  const [rebaseError, setRebaseError] = useState("");
  const [rebaseReport, setRebaseReport] = useState(null);
  const [rebaseApplied, setRebaseApplied] = useState(null);
  const [rebaseUpToDate, setRebaseUpToDate] = useState(false);
  const [rebaseSourceLabel, setRebaseSourceLabel] = useState("");
  const [deleteAllLabelsConfirmOpen, setDeleteAllLabelsConfirmOpen] =
    useState(false);
  const [spansAnalyticsOpen, setSpansAnalyticsOpen] = useState(false);
  const [metadataOpen, setMetadataOpen] = useState(false);
  const [preprocessDebugOpen, setPreprocessDebugOpen] = useState(false);
  const [preprocessDebugState, setPreprocessDebugState] = useState({
    state: "idle",
    itemId: null,
    data: null,
    error: "",
  });
  const [keyboardLayout, setKeyboardLayout] = useState(() => {
    if (typeof window === "undefined") return "qwerty";
    try {
      return normalizeKeyboardLayout(
        window.localStorage.getItem(KEYBOARD_LAYOUT_STORAGE_KEY)
      );
    } catch {
      return "qwerty";
    }
  });
  const [shiftPressed, setShiftPressed] = useState(false);

  const saveSeqRef = useRef({});
  const dragRef = useRef({ active: false, startAbs: null });
  const documentScrollRef = useRef(null);
  const documentTextRef = useRef(null);
  const docFilterRef = useRef(null);
  const docFilterInputRef = useRef(null);
  const focusCharRef = useRef(null);
  const otherCategorySelectRef = useRef(null);
  const previousFilterLabelOptionsRef = useRef([]);
  const itemHistoryRef = useRef({ itemId: null, past: [], future: [] });
  const preprocessDebugSeqRef = useRef(0);
  const categoryColors = useMemo(
    () => buildCategoryColorMap(categories),
    [categories]
  );
  const getCategoryColor = (category) => {
    const normalized = String(category ?? "").trim();
    return (
      getCategoryColorOverride(normalized) ??
      categoryColors.get(normalized) ??
      fallbackCategoryColor(normalized)
    );
  };

  // Stable wrappers around the (re-created-every-render) char handlers, so the
  // memoized DocCharLayer isn't invalidated on every parent render.
  const charHandlersRef = useRef({ down: () => {}, enter: () => {} });
  const stableCharMouseDown = useCallback(
    (index, event) => charHandlersRef.current.down(index, event),
    []
  );
  const stableCharMouseEnter = useCallback(
    (index) => charHandlersRef.current.enter(index),
    []
  );

  function applyBootstrapPayload(payload, { preserveSelection = true } = {}) {
    const nextItemsById = {};
    for (const item of payload.items ?? []) {
      nextItemsById[item.itemId] = item;
    }
    const nextDocs = {};
    const nextDocumentMetadata = {};
    for (const doc of payload.documents ?? []) {
      nextDocs[doc.documentId] = doc.text ?? "";
      nextDocumentMetadata[doc.documentId] = normalizeDocumentMetadata(doc);
    }

    const nextOrdered = (payload.items ?? []).map((item) => item.itemId);
    setDocumentsById(nextDocs);
    setDocumentMetadataById(nextDocumentMetadata);
    setItemsById(nextItemsById);
    setOrderedItemIds(nextOrdered);
    setProgress(payload.progress);
    setBootstrapMeta(payload.meta ?? {});
    setStartingCategoryGroups(payload.startingCategories ?? {});
    setCategories(payload.categories ?? []);
    setSelectedCategory((prev) => prev || (payload.categories?.[0] ?? ""));
    setSelectedItemId((prev) => {
      if (preserveSelection && prev && nextItemsById[prev]) return prev;
      const firstIncomplete = (payload.items ?? []).find(
        (item) => item.saved?.status !== "confirmed"
      );
      return firstIncomplete?.itemId ?? nextOrdered[0] ?? "";
    });
  }

  async function fetchBootstrap() {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/bootstrap", { cache: "no-store" });
      const payload = await res.json();
      if (!res.ok)
        throw new Error(payload.detail || payload.error || "Failed to load");
      applyBootstrapPayload(payload, { preserveSelection: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  function resetRebasePreview() {
    setRebaseError("");
    setRebaseReport(null);
    setRebaseApplied(null);
    setRebaseUpToDate(false);
  }

  function openRebaseModal() {
    resetRebasePreview();
    setRebaseOpen(true);
    void submitRebase("check");
  }

  function closeRebaseModal() {
    if (rebaseBusy) return;
    setRebaseOpen(false);
    resetRebasePreview();
  }

  async function submitRebase(operation) {
    if (rebaseBusy) return;
    const applying = operation === "apply";
    setRebaseBusy(operation);
    setRebaseError("");
    if (!applying) setRebaseApplied(null);

    try {
      const response = await fetch(`/api/rebase/${operation}`, {
        method: "POST",
        headers: applying ? { "Content-Type": "application/json" } : undefined,
        body: applying
          ? JSON.stringify({
              expectedAnnotationsSha256: rebaseReport?.to_annotations_sha256,
            })
          : undefined,
      });
      const contentType = response.headers.get("content-type") ?? "";
      const payload = contentType.includes("application/json")
        ? await response.json()
        : { detail: await response.text() };
      if (!response.ok) {
        throw new Error(
          payload.detail || payload.error || "Primary-gold update failed"
        );
      }
      setRebaseSourceLabel(payload.sourceLabel ?? rebaseSourceLabel);
      setRebaseUpToDate(Boolean(payload.upToDate));
      setRebaseReport(payload.report ?? null);
      if (applying) {
        applyBootstrapPayload(payload.bootstrap ?? {}, {
          preserveSelection: true,
        });
        setRebaseApplied({
          backupPath: payload.backupPath ?? null,
          reportPath: payload.reportPath ?? null,
        });
        setSaveState({
          state: "saved",
          itemId: null,
          message: "Primary annotations updated",
        });
      }
    } catch (err) {
      setRebaseError(err instanceof Error ? err.message : String(err));
    } finally {
      setRebaseBusy("");
    }
  }

  async function handleRerunPreprocessing() {
    if (preprocessorBusy) return;
    setPreprocessorBusy(true);
    setSaveState({
      state: "saving",
      itemId: null,
      message: "Preprocessing…",
    });

    try {
      const res = await fetch("/api/preprocess/rerun", {
        method: "POST",
      });
      const payload = await res.json();
      if (!res.ok) {
        throw new Error(
          payload.detail || payload.error || "Failed to rerun preprocessing"
        );
      }

      applyBootstrapPayload(payload.bootstrap ?? payload, {
        preserveSelection: true,
      });
      const changedItems = Number(payload.stats?.changedItems ?? 0);
      setSaveState({
        state: "saved",
        itemId: null,
        message: `Preprocessed ${changedItems} item${
          changedItems === 1 ? "" : "s"
        }`,
      });
    } catch (err) {
      setSaveState({
        state: "error",
        itemId: null,
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setPreprocessorBusy(false);
    }
  }

  async function fetchPreprocessDebug(itemId) {
    const normalizedItemId = String(itemId ?? "").trim();
    if (!normalizedItemId) {
      setPreprocessDebugState({
        state: "idle",
        itemId: null,
        data: null,
        error: "",
      });
      return;
    }

    const seq = preprocessDebugSeqRef.current + 1;
    preprocessDebugSeqRef.current = seq;
    setPreprocessDebugState({
      state: "loading",
      itemId: normalizedItemId,
      data: null,
      error: "",
    });

    try {
      const res = await fetch("/api/items/preprocess-debug", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemId: normalizedItemId }),
      });
      const payload = await res.json();
      if (!res.ok) {
        throw new Error(
          payload.detail ||
            payload.error ||
            "Failed to load preprocessing diagnostics"
        );
      }
      if (preprocessDebugSeqRef.current !== seq) return;
      setPreprocessDebugState({
        state: "loaded",
        itemId: normalizedItemId,
        data: payload,
        error: "",
      });
    } catch (err) {
      if (preprocessDebugSeqRef.current !== seq) return;
      setPreprocessDebugState({
        state: "error",
        itemId: normalizedItemId,
        data: null,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  useEffect(() => {
    fetchBootstrap();
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(KEYBOARD_LAYOUT_STORAGE_KEY, keyboardLayout);
    } catch {
      // Ignore storage write failures in restricted environments.
    }
  }, [keyboardLayout]);

  useEffect(() => {
    function handleKeyDown(event) {
      if (event.key === "Shift") {
        setShiftPressed(true);
      }
    }

    function handleKeyUp(event) {
      if (event.key === "Shift") {
        setShiftPressed(false);
      }
    }

    function handleBlur() {
      setShiftPressed(false);
    }

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", handleBlur);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", handleBlur);
    };
  }, []);

  const activeItem = selectedItemId ? itemsById[selectedItemId] : null;
  const importMode = bootstrapMeta.importMode ?? {
    active: false,
    path: null,
  };
  const activeLockedRanges = useMemo(
    () => mergeRanges(activeItem?.lockedRanges ?? []),
    [activeItem]
  );
  const lockBypassActive = shiftPressed && activeLockedRanges.length > 0;
  const currentDocId = activeItem?.documentId ?? "";
  const activeDocText = activeItem
    ? documentsById[activeItem.documentId] ?? ""
    : "";
  const activeDocMetadata = activeItem
    ? normalizeDocumentMetadata(
        documentMetadataById[activeItem.documentId] ?? {}
      )
    : normalizeDocumentMetadata({});
  const activeAnnotations = activeItem
    ? [
        ...(activeItem.gold
          ? (() => {
              const sourceId = "gold_annotations";
              const sourceColors = buildSourceColorTokens(sourceId);
              return [
                {
                  key: `${activeItem.itemId}::gold-annotation`,
                  sourceId,
                  label: normalizeMetadataValue(activeItem.gold.label),
                  text: normalizeMetadataValue(activeItem.gold.text),
                  sourceBorderColor: sourceColors.border,
                  sourceChipBackground: sourceColors.chipBackground,
                  sourceChipText: sourceColors.chipText,
                },
              ];
            })()
          : []),
      ]
    : [];

  const categoryDisplayConfig = useMemo(() => {
    const allCategories = uniqueStringsInOrder(categories);
    if (allCategories.length === 0) {
      return {
        quickCategories: [],
        overflowCategories: [],
        mode: "empty",
        matchedGroup: null,
        goldCategoryValue: "",
      };
    }

    const groupsByNormalizedKey = new Map();
    for (const [groupName, groupCategories] of Object.entries(
      startingCategoryGroups ?? {}
    )) {
      const normalizedKey = normalizeCategoryGroupKey(groupName);
      if (!normalizedKey) continue;
      groupsByNormalizedKey.set(normalizedKey, {
        groupName,
        categories: uniqueStringsInOrder(groupCategories),
      });
    }

    const generalGroup = groupsByNormalizedKey.get("general")?.categories ?? [];
    const categorySet = new Set(allCategories);

    if (!activeItem) {
      return {
        quickCategories: allCategories,
        overflowCategories: [],
        mode: "all",
        matchedGroup: null,
        goldCategoryValue: "",
      };
    }

    const goldCategoryValue = String(
      activeItem.gold?.category ?? ""
    ).trim();

    const matchedGroup =
      groupsByNormalizedKey.get(normalizeCategoryGroupKey(goldCategoryValue)) ??
      null;

    // No gold category metadata: expose everything so the annotator is not constrained.
    if (!goldCategoryValue) {
      return {
        quickCategories: allCategories,
        overflowCategories: [],
        mode: "all",
        matchedGroup: null,
        goldCategoryValue,
      };
    }

    const preferredFromYaml = uniqueStringsInOrder([
      ...generalGroup,
      ...(matchedGroup?.categories ?? []),
    ]);

    if (preferredFromYaml.length === 0) {
      return {
        quickCategories: allCategories,
        overflowCategories: [],
        mode: "all",
        matchedGroup: null,
        goldCategoryValue,
      };
    }

    const quickCategories = preferredFromYaml.filter((category) =>
      categorySet.has(category)
    );
    const quickSet = new Set(quickCategories);
    const overflowCategories = allCategories.filter(
      (category) => !quickSet.has(category)
    );

    return {
      quickCategories:
        quickCategories.length > 0 ? quickCategories : allCategories,
      overflowCategories: quickCategories.length > 0 ? overflowCategories : [],
      mode: quickCategories.length > 0 ? "focused" : "all",
      matchedGroup,
      goldCategoryValue,
    };
  }, [activeItem, categories, startingCategoryGroups]);

  const shortcutCategories = categoryDisplayConfig.quickCategories;
  const categoryShortcutLetterPool = useMemo(() => {
    const basePool =
      CATEGORY_SHORTCUT_LETTER_POOLS[keyboardLayout] ??
      CATEGORY_SHORTCUT_LETTER_POOLS.qwerty;
    return basePool.filter(
      (token) => !RESERVED_CATEGORY_SHORTCUT_TOKENS.has(token)
    );
  }, [keyboardLayout]);

  const quickCategoryShortcutEntries = useMemo(() => {
    return shortcutCategories.map((category, index) => {
      if (index < 9) {
        return { category, token: String(index + 1) };
      }
      const letterToken = categoryShortcutLetterPool[index - 9] ?? null;
      return { category, token: letterToken };
    });
  }, [shortcutCategories, categoryShortcutLetterPool]);

  const quickCategoryShortcutLegend = useMemo(() => {
    const firstLetterShortcut = categoryShortcutLetterPool[0];
    return quickCategoryShortcutEntries.length > 9 && firstLetterShortcut
      ? `1..9, ${firstLetterShortcut.toUpperCase()}..`
      : "1..9";
  }, [quickCategoryShortcutEntries, categoryShortcutLetterPool]);

  const categoryByShortcutToken = useMemo(() => {
    const mapping = {};
    for (const entry of quickCategoryShortcutEntries) {
      if (!entry.token) continue;
      mapping[entry.token] = entry.category;
    }
    return mapping;
  }, [quickCategoryShortcutEntries]);

  const filterLabelOptions = useMemo(() => {
    const labels = orderedItemIds
      .map((itemId) => getItemDisplayLabel(itemsById[itemId]))
      .filter(Boolean);
    return uniqueStringsInOrder(labels).sort((a, b) => a.localeCompare(b));
  }, [orderedItemIds, itemsById]);

  useEffect(() => {
    const previousOptions = previousFilterLabelOptionsRef.current;
    const previousOptionsSet = new Set(previousOptions);

    setIncludedLabels((prev) => {
      const availableSet = new Set(filterLabelOptions);
      const nextSet = new Set(prev.filter((label) => availableSet.has(label)));

      // First load: all labels are selected.
      if (previousOptions.length === 0 && prev.length === 0) {
        for (const label of filterLabelOptions) {
          nextSet.add(label);
        }
      } else {
        // Later updates: keep user choices, but include brand-new labels.
        for (const label of filterLabelOptions) {
          if (!previousOptionsSet.has(label)) {
            nextSet.add(label);
          }
        }
      }

      const next = filterLabelOptions.filter((label) => nextSet.has(label));
      if (
        prev.length === next.length &&
        prev.every((label, index) => label === next[index])
      ) {
        return prev;
      }
      return next;
    });

    previousFilterLabelOptionsRef.current = filterLabelOptions;
  }, [filterLabelOptions]);

  const includedStatusSet = useMemo(
    () => new Set(includedStatusKeys),
    [includedStatusKeys]
  );
  const includedLabelsSet = useMemo(
    () => new Set(includedLabels),
    [includedLabels]
  );

  const visibleItemIds = useMemo(() => {
    return orderedItemIds.filter((itemId) => {
      const item = itemsById[itemId];
      if (!item) return false;
      if (!includedStatusSet.has(getItemStatusKey(item))) return false;
      if (!includedLabelsSet.has(getItemDisplayLabel(item))) return false;
      return true;
    });
  }, [orderedItemIds, itemsById, includedStatusSet, includedLabelsSet]);

  const visibleNavigation = useMemo(() => {
    const itemsByDoc = {};
    const docIds = [];
    for (const itemId of visibleItemIds) {
      const item = itemsById[itemId];
      if (!item) continue;
      if (!itemsByDoc[item.documentId]) {
        itemsByDoc[item.documentId] = [];
        docIds.push(item.documentId);
      }
      itemsByDoc[item.documentId].push(itemId);
    }
    return { itemsByDoc, docIds };
  }, [visibleItemIds, itemsById]);

  const activeVisibleIndex = useMemo(() => {
    if (!selectedItemId) return -1;
    return visibleItemIds.indexOf(selectedItemId);
  }, [visibleItemIds, selectedItemId]);

  const activeItemIdsInDoc = useMemo(() => {
    if (!activeItem) return [];
    return visibleNavigation.itemsByDoc[activeItem.documentId] ?? [];
  }, [activeItem, visibleNavigation]);

  const activeIndexInDoc = useMemo(() => {
    if (!selectedItemId || activeItemIdsInDoc.length === 0) return -1;
    return activeItemIdsInDoc.indexOf(selectedItemId);
  }, [selectedItemId, activeItemIdsInDoc]);
  const selectionAbs = getActiveRangeAbsolute();
  const selectionTouchesLockedRanges =
    Boolean(activeItem) &&
    Boolean(selectionAbs) &&
    rangeOverlapsRanges(selectionAbs, activeLockedRanges);
  const selectionText =
    activeItem && selectedRange
      ? codePointSlice(activeItem.reviewText, selectedRange.start, selectedRange.end)
      : "";

  function setLockedRangeMessage(message = "Hold Shift to edit imported ranges") {
    setSaveState({
      state: "error",
      itemId: activeItem?.itemId ?? null,
      message,
    });
  }

  function itemSegmentsChangeLockedRanges(item, nextSegments) {
    const lockedRanges = mergeRanges(item?.lockedRanges ?? []);
    if (lockedRanges.length === 0) return false;
    const currentLockedSegments = extractSegmentsWithinRanges(
      item?.saved?.segments ?? [],
      lockedRanges
    );
    const nextLockedSegments = extractSegmentsWithinRanges(
      nextSegments ?? [],
      lockedRanges
    );
    return !segmentsEqual(currentLockedSegments, nextLockedSegments);
  }

  const activeDocIndexInVisible = useMemo(() => {
    if (!activeItem) return -1;
    return visibleNavigation.docIds.indexOf(activeItem.documentId);
  }, [activeItem, visibleNavigation]);

  const docProgressById = useMemo(
    () =>
      new Map(
        (progress?.docs ?? []).map((doc) => [String(doc.documentId ?? ""), doc])
      ),
    [progress]
  );
  const normalizedDocFilterQuery = docFilterQueryDirty
    ? docFilterQuery.trim().toLowerCase()
    : "";
  const filteredDocIds = useMemo(() => {
    if (!normalizedDocFilterQuery) return visibleNavigation.docIds;
    return visibleNavigation.docIds.filter((docId) =>
      docId.toLowerCase().includes(normalizedDocFilterQuery)
    );
  }, [visibleNavigation.docIds, normalizedDocFilterQuery]);
  const docFilterOptions = useMemo(() => {
    return filteredDocIds.map((docId) => {
      const progressEntry = docProgressById.get(docId);
      return {
        value: docId,
        primaryText: docId,
        secondaryText: progressEntry
          ? `(${
              progressEntry.confirmedItems ?? progressEntry.confirmedGoldSpans
            }/${progressEntry.itemCount ?? progressEntry.goldSpanCount})`
          : "",
        fullLabel: progressEntry
          ? formatDocFilterOptionLabel(progressEntry)
          : docId,
      };
    });
  }, [filteredDocIds, docProgressById]);
  const activeDocFilterOption =
    docFilterOptions[
      Math.min(docFilterActiveIndex, Math.max(0, docFilterOptions.length - 1))
    ] ?? null;

  const activeDocProgress = useMemo(() => {
    if (!activeItem) return null;
    return (
      (progress?.docs ?? []).find(
        (doc) => doc.documentId === activeItem.documentId
      ) ?? null
    );
  }, [progress, activeItem]);

  useEffect(() => {
    if (!selectedItemId && visibleItemIds.length > 0) {
      setSelectedItemId(visibleItemIds[0]);
      return;
    }
    if (
      selectedItemId &&
      visibleItemIds.length > 0 &&
      !visibleItemIds.includes(selectedItemId)
    ) {
      setSelectedItemId(visibleItemIds[0]);
    }
  }, [visibleItemIds, selectedItemId]);

  useEffect(() => {
    setSelectedRange(null);
    dragRef.current = { active: false, startAbs: null };
    itemHistoryRef.current = {
      itemId: selectedItemId || null,
      past: [],
      future: [],
    };
    setHistoryTick((v) => v + 1);
  }, [selectedItemId]);

  useEffect(() => {
    if (!selectionAbs || lockBypassActive || !selectionTouchesLockedRanges) {
      return;
    }
    setSelectedRange(null);
    dragRef.current = { active: false, startAbs: null };
  }, [selectionAbs, selectionTouchesLockedRanges, lockBypassActive]);

  useEffect(() => {
    setSelectionCopyState("idle");
  }, [selectedItemId, selectedRange]);

  useEffect(() => {
    if (!preprocessDebugOpen) return;
    if (!activeItem?.itemId) {
      setPreprocessDebugState({
        state: "idle",
        itemId: null,
        data: null,
        error: "",
      });
      return;
    }
    void fetchPreprocessDebug(activeItem.itemId);
  }, [
    preprocessDebugOpen,
    activeItem?.itemId,
    activeItem?.saved?.updatedAt,
    activeItem?.saved?.status,
  ]);

  useEffect(() => {
    if (docFilterOpen && docFilterQueryDirty) return;
    setDocFilterQuery(currentDocId);
    setDocFilterQueryDirty(false);
  }, [currentDocId, docFilterOpen, docFilterQueryDirty]);

  useEffect(() => {
    if (!docFilterOpen) return;
    const selectedIndex = docFilterOptions.findIndex(
      (option) => option.value === currentDocId
    );
    setDocFilterActiveIndex(selectedIndex >= 0 ? selectedIndex : 0);
  }, [docFilterOpen, docFilterOptions, currentDocId]);

  useEffect(() => {
    if (!docFilterOpen || !activeDocFilterOption) return;
    const option = document.getElementById(
      getDocFilterOptionId(activeDocFilterOption.value)
    );
    option?.scrollIntoView?.({ block: "nearest" });
  }, [docFilterOpen, activeDocFilterOption]);

  useEffect(() => {
    const container = documentScrollRef.current;
    const focusChar = focusCharRef.current;
    if (!container || !focusChar) return;

    const focusTopFromOffsets = getOffsetTopWithinAncestor(
      focusChar,
      container
    );
    const focusTopInContainer =
      focusTopFromOffsets ??
      (() => {
        const containerRect = container.getBoundingClientRect();
        const focusRect = focusChar.getBoundingClientRect();
        return focusRect.top - containerRect.top + container.scrollTop;
      })();
    const focusBottomInContainer =
      focusTopInContainer + Math.max(1, focusChar.offsetHeight);
    const viewTop = container.scrollTop;
    const viewBottom = viewTop + container.clientHeight;
    const margin = Math.max(24, container.clientHeight * 0.12);
    let targetTop = viewTop;

    // Keep the active annotation visible with a small buffer, without recentering every time.
    if (focusTopInContainer < viewTop + margin) {
      targetTop = focusTopInContainer - margin;
    } else if (focusBottomInContainer > viewBottom - margin) {
      targetTop = focusBottomInContainer - container.clientHeight + margin;
    }

    const maxTop = Math.max(0, container.scrollHeight - container.clientHeight);

    container.scrollTop = Math.min(Math.max(0, targetTop), maxTop);
  }, [selectedItemId]);

  useEffect(() => {
    function handleMouseUp() {
      dragRef.current.active = false;
    }
    window.addEventListener("mouseup", handleMouseUp);
    return () => window.removeEventListener("mouseup", handleMouseUp);
  }, []);

  useEffect(() => {
    if (selectionCopyState === "idle") return undefined;

    const timeoutId = setTimeout(
      () => {
        setSelectionCopyState("idle");
      },
      selectionCopyState === "copied" ? 1600 : 2200
    );

    return () => clearTimeout(timeoutId);
  }, [selectionCopyState]);

  function updateItemLocal(itemId, nextSegments, nextStatus = "in_progress") {
    setItemsById((prev) => {
      const item = prev[itemId];
      if (!item) return prev;
      const coverage = computeCoverage(item, nextSegments);
      return {
        ...prev,
        [itemId]: {
          ...item,
          saved: {
            ...(item.saved ?? {}),
            status: nextStatus,
            segments: nextSegments,
            updatedAt: new Date().toISOString(),
            confirmedAt:
              nextStatus === "confirmed"
                ? item.saved?.confirmedAt ?? new Date().toISOString()
                : null,
          },
          coverage,
        },
      };
    });
  }

  async function persistItem(itemId, segments, status) {
    const seq = (saveSeqRef.current[itemId] ?? 0) + 1;
    saveSeqRef.current[itemId] = seq;
    setSaveState({
      state: "saving",
      itemId,
      message: status === "confirmed" ? "Confirming…" : "Saving…",
    });

    try {
      const res = await fetch("/api/items/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          itemId,
          segments,
          status,
          lockBypass: shiftPressed,
        }),
      });
      const payload = await res.json();
      if (!res.ok) {
        throw new Error(payload.detail || payload.error || "Save failed");
      }

      if (saveSeqRef.current[itemId] !== seq) return;

      setItemsById((prev) => ({ ...prev, [itemId]: payload.item }));
      setProgress(payload.progress);
      setCategories(payload.categories ?? []);
      setSaveState({
        state: "saved",
        itemId,
        message: status === "confirmed" ? "Confirmed" : "Saved",
      });
    } catch (err) {
      setSaveState({
        state: "error",
        itemId,
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  async function saveInProgress(itemId, segments) {
    updateItemLocal(itemId, segments, "in_progress");
    try {
      await persistItem(itemId, segments, "in_progress");
    } catch {
      // error reflected in saveState
    }
  }

  function cloneSegments(segments) {
    return (segments ?? []).map((segment) => ({ ...segment }));
  }

  function makeItemSnapshot(item) {
    return {
      status: item?.saved?.status ?? "empty",
      segments: cloneSegments(item?.saved?.segments ?? []),
    };
  }

  function ensureHistoryForItem(itemId) {
    if (itemHistoryRef.current.itemId !== itemId) {
      itemHistoryRef.current = { itemId, past: [], future: [] };
      setHistoryTick((v) => v + 1);
    }
    return itemHistoryRef.current;
  }

  function pushUndoSnapshotForItem(item) {
    if (!item) return;
    const history = ensureHistoryForItem(item.itemId);
    history.past.push(makeItemSnapshot(item));
    history.future = [];
    if (history.past.length > 100) {
      history.past.splice(0, history.past.length - 100);
    }
    setHistoryTick((v) => v + 1);
  }

  async function applySnapshotToItem(itemId, snapshot) {
    const normalizedStatus =
      snapshot?.status === "confirmed" ? "confirmed" : "in_progress";
    const segments = cloneSegments(snapshot?.segments ?? []);
    updateItemLocal(itemId, segments, normalizedStatus);
    try {
      await persistItem(itemId, segments, normalizedStatus);
    } catch {
      // error reflected in saveState
    }
  }

  function getActiveRangeAbsolute() {
    if (!activeItem || !selectedRange) return null;
    return {
      begin: activeItem.reviewBegin + selectedRange.start,
      end: activeItem.reviewBegin + selectedRange.end,
    };
  }

  function getDocumentNativeSelectionText() {
    if (typeof window === "undefined") return "";
    const documentText = documentTextRef.current;
    if (!documentText) return "";

    const selection = window.getSelection?.();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      return "";
    }

    const commonAncestor = selection.getRangeAt(0).commonAncestorContainer;
    const ancestorElement =
      commonAncestor instanceof HTMLElement
        ? commonAncestor
        : commonAncestor.parentElement;

    if (!ancestorElement || !documentText.contains(ancestorElement)) {
      return "";
    }

    return selection.toString();
  }

  function setSelectionFromAbsolute(startAbs, endAbsInclusive) {
    if (!activeItem) return;
    const minAllowed = activeItem.reviewBegin;
    const maxAllowed = activeItem.reviewEnd - 1;
    if (maxAllowed < minAllowed) return;

    let a = Math.min(maxAllowed, Math.max(minAllowed, startAbs));
    let b = Math.min(maxAllowed, Math.max(minAllowed, endAbsInclusive));
    if (!lockBypassActive && activeLockedRanges.length > 0) {
      const unlockedInterval = getUnlockedIntervalContainingIndex(activeItem, a);
      if (!unlockedInterval) {
        setSelectedRange(null);
        return;
      }
      const minUnlocked = unlockedInterval.begin;
      const maxUnlocked = unlockedInterval.end - 1;
      a = Math.min(maxUnlocked, Math.max(minUnlocked, a));
      b = Math.min(maxUnlocked, Math.max(minUnlocked, b));
    }
    const beginAbs = Math.min(a, b);
    const endAbs = Math.max(a, b) + 1;
    setSelectedRange({
      start: beginAbs - activeItem.reviewBegin,
      end: endAbs - activeItem.reviewBegin,
    });
  }

  function focusDocumentText() {
    documentTextRef.current?.focus?.({ preventScroll: true });
  }

  function resetDocFilterQueryToSelection() {
    setDocFilterQuery(currentDocId);
    setDocFilterQueryDirty(false);
  }

  function closeDocFilterMenu() {
    setDocFilterOpen(false);
    resetDocFilterQueryToSelection();
  }

  function goToDocumentId(targetDocId) {
    const targetDocItems = visibleNavigation.itemsByDoc[targetDocId] ?? [];
    if (targetDocItems.length === 0) return false;
    if (!activeItem) {
      setSelectedItemId(targetDocItems[0]);
      return true;
    }
    const localIdx = Math.max(0, activeIndexInDoc);
    const targetItemIdx = Math.min(targetDocItems.length - 1, localIdx);
    setSelectedItemId(targetDocItems[targetItemIdx]);
    return true;
  }

  function handleSelectDocFilterOption(nextValue) {
    goToDocumentId(nextValue);
    setDocFilterQuery(nextValue);
    setDocFilterQueryDirty(false);
    setDocFilterOpen(false);
    docFilterInputRef.current?.blur();
  }

  function handleDocFilterInputFocus(event) {
    setDocFilterOpen(true);
    event.target.select();
  }

  function handleDocFilterContainerBlur(event) {
    const nextTarget = event.relatedTarget;
    if (
      nextTarget instanceof Node &&
      docFilterRef.current?.contains(nextTarget)
    ) {
      return;
    }
    closeDocFilterMenu();
  }

  function handleDocFilterInputChange(event) {
    setDocFilterQuery(event.target.value);
    setDocFilterQueryDirty(true);
    setDocFilterOpen(true);
    setDocFilterActiveIndex(0);
  }

  function handleDocFilterInputKeyDown(event) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (!docFilterOpen) {
        setDocFilterOpen(true);
        return;
      }
      setDocFilterActiveIndex((prev) =>
        Math.min(docFilterOptions.length - 1, prev + 1)
      );
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (!docFilterOpen) {
        setDocFilterOpen(true);
        return;
      }
      setDocFilterActiveIndex((prev) => Math.max(0, prev - 1));
      return;
    }
    if (event.key === "Enter") {
      if (!docFilterOpen || !activeDocFilterOption) return;
      event.preventDefault();
      handleSelectDocFilterOption(activeDocFilterOption.value);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      closeDocFilterMenu();
      docFilterInputRef.current?.blur();
    }
  }

  function handleDocFilterToggleMouseDown(event) {
    event.preventDefault();
  }

  function handleDocFilterToggleClick() {
    if (docFilterOpen) {
      closeDocFilterMenu();
      docFilterInputRef.current?.blur();
      return;
    }
    setDocFilterOpen(true);
    docFilterInputRef.current?.focus();
  }

  function handleCharMouseDown(index, event) {
    if (!activeItem) return;
    if (index < activeItem.reviewBegin || index >= activeItem.reviewEnd) {
      dragRef.current = { active: false, startAbs: null };
      setSelectedRange(null);
      return;
    }
    if (!lockBypassActive && !getUnlockedIntervalContainingIndex(activeItem, index)) {
      dragRef.current = { active: false, startAbs: null };
      setSelectedRange(null);
      setLockedRangeMessage();
      return;
    }
    event.preventDefault();
    focusDocumentText();
    dragRef.current = { active: true, startAbs: index };
    setSelectionFromAbsolute(index, index);
  }

  function handleCharMouseEnter(index) {
    if (!activeItem || !dragRef.current.active) return;
    if (index < activeItem.reviewBegin || index >= activeItem.reviewEnd) return;
    setSelectionFromAbsolute(dragRef.current.startAbs, index);
  }

  // Keep the stable wrappers pointing at the current closures.
  charHandlersRef.current.down = handleCharMouseDown;
  charHandlersRef.current.enter = handleCharMouseEnter;

  function clearSelection() {
    setSelectedRange(null);
    if (typeof window !== "undefined") {
      window.getSelection?.()?.removeAllRanges();
    }
  }

  function selectFullAnnotationSpan() {
    if (!activeItem) return;
    if (!lockBypassActive && activeLockedRanges.length > 0) {
      setLockedRangeMessage();
      return;
    }
    const spanLength = activeItem.reviewEnd - activeItem.reviewBegin;
    if (spanLength <= 0) return;
    focusDocumentText();
    setSelectedRange({
      start: 0,
      end: spanLength,
    });
  }

  async function handleCopySelection(textOverride = null) {
    const textToCopy = String(textOverride ?? selectionText ?? "");
    if (textToCopy.length === 0) return false;

    try {
      await copyTextToClipboard(textToCopy);
      setSelectionCopyState("copied");
      return true;
    } catch {
      setSelectionCopyState("error");
      return false;
    }
  }

  function handleDocumentCopy(event) {
    const nativeSelectionText = getDocumentNativeSelectionText();
    const textToCopy = nativeSelectionText || selectionText;
    if (!textToCopy) return;

    if (event.clipboardData) {
      event.preventDefault();
      event.clipboardData.setData("text/plain", textToCopy);
      setSelectionCopyState("copied");
      return;
    }

    void handleCopySelection(textToCopy);
  }

  async function handleApplyCategory(categoryOverride) {
    if (!activeItem) return;
    const selection = getActiveRangeAbsolute();
    if (!selection) return;
    if (selectionTouchesLockedRanges && !lockBypassActive) {
      setLockedRangeMessage();
      return;
    }
    const category = String(
      (categoryOverride ?? null) || selectedCategory || ""
    ).trim();
    if (!category) return;

    pushUndoSnapshotForItem(activeItem);
    const appliedSegments = applyCategoryToSegments(
      activeItem.saved?.segments ?? [],
      selection,
      category
    );
    const nextSegments = applyOnlineFormattingToSegments({
      segments: appliedSegments,
      reviewText: activeItem.reviewText ?? "",
      reviewBegin: activeItem.reviewBegin,
      reviewEnd: activeItem.reviewEnd,
      triggerRange: selection,
      formattingPolicy:
        bootstrapMeta?.subannotationProfile?.formattingPolicy,
      formattingCategory:
        bootstrapMeta?.subannotationProfile?.formattingCategory,
    });
    if (!categories.includes(category)) {
      setCategories((prev) =>
        Array.from(new Set([...prev, category])).sort((a, b) =>
          a.localeCompare(b)
        )
      );
    }
    setSelectedCategory(category);
    await saveInProgress(activeItem.itemId, nextSegments);
  }

  async function handleClearAll() {
    if (!activeItem) return;
    if (itemSegmentsChangeLockedRanges(activeItem, []) && !lockBypassActive) {
      setLockedRangeMessage();
      return;
    }
    pushUndoSnapshotForItem(activeItem);
    await saveInProgress(activeItem.itemId, []);
  }

  async function handleConfirmDeleteAllLabels() {
    setDeleteAllLabelsConfirmOpen(false);
    setSaveState({
      state: "saving",
      itemId: null,
      message: "Deleting all labels…",
    });

    try {
      const res = await fetch("/api/items/clear-all-labels", {
        method: "POST",
      });
      const payload = await res.json();
      if (!res.ok) {
        throw new Error(
          payload.detail || payload.error || "Failed to delete all labels"
        );
      }

      applyBootstrapPayload(payload.bootstrap ?? payload, {
        preserveSelection: true,
      });
      const clearedItems = Number(payload.stats?.clearedItems ?? 0);
      setSaveState({
        state: "saved",
        itemId: null,
        message: `Deleted labels for ${clearedItems} item${
          clearedItems === 1 ? "" : "s"
        }`,
      });
    } catch (err) {
      setSaveState({
        state: "error",
        itemId: null,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  function closeSettingsModal() {
    setDeleteAllLabelsConfirmOpen(false);
    setSettingsOpen(false);
  }

  async function handleConfirm() {
    if (!activeItem) return;
    const segments = activeItem.saved?.segments ?? [];
    const coverage = computeCoverage(activeItem, segments);
    if (!coverage.complete) return;

    pushUndoSnapshotForItem(activeItem);
    updateItemLocal(activeItem.itemId, segments, "confirmed");
    try {
      await persistItem(activeItem.itemId, segments, "confirmed");
      const nextTarget =
        activeVisibleIndex >= 0
          ? visibleItemIds
              .slice(activeVisibleIndex + 1)
              .find((id) => itemsById[id]?.saved?.status !== "confirmed")
          : null;
      if (nextTarget) setSelectedItemId(nextTarget);
    } catch {
      // error reflected in saveState
    }
  }

  async function handleUndo() {
    if (!activeItem) return;
    const history = ensureHistoryForItem(activeItem.itemId);
    if (history.past.length === 0) return;
    const previous = history.past.pop();
    if (
      itemSegmentsChangeLockedRanges(activeItem, previous?.segments ?? []) &&
      !lockBypassActive
    ) {
      history.past.push(previous);
      setLockedRangeMessage();
      return;
    }
    history.future.push(makeItemSnapshot(activeItem));
    setHistoryTick((v) => v + 1);
    await applySnapshotToItem(activeItem.itemId, previous);
  }

  async function handleRedo() {
    if (!activeItem) return;
    const history = ensureHistoryForItem(activeItem.itemId);
    if (history.future.length === 0) return;
    const next = history.future.pop();
    if (
      itemSegmentsChangeLockedRanges(activeItem, next?.segments ?? []) &&
      !lockBypassActive
    ) {
      history.future.push(next);
      setLockedRangeMessage();
      return;
    }
    history.past.push(makeItemSnapshot(activeItem));
    setHistoryTick((v) => v + 1);
    await applySnapshotToItem(activeItem.itemId, next);
  }

  async function handleSelectOrApplyCategory(category) {
    if (!category) return false;
    setSelectedCategory(category);
    if (selectedRange) {
      await handleApplyCategory(category);
    }
    return true;
  }

  async function handleCategoryShortcutToken(token) {
    const normalized = String(token ?? "").toLowerCase();
    if (!normalized) return false;
    const category = categoryByShortcutToken[normalized];
    return handleSelectOrApplyCategory(category);
  }

  function goToAnnotationInCurrentText(offset) {
    if (visibleItemIds.length === 0) return;
    if (!activeItem) {
      setSelectedItemId(visibleItemIds[0]);
      return;
    }
    const docItems = visibleNavigation.itemsByDoc[activeItem.documentId] ?? [];
    if (docItems.length === 0) return;
    const currentIdx = Math.max(0, docItems.indexOf(selectedItemId));
    const nextIdx = currentIdx + offset;
    if (nextIdx >= 0 && nextIdx < docItems.length) {
      setSelectedItemId(docItems[nextIdx]);
      return;
    }

    const docIds = visibleNavigation.docIds;
    const currentDocIdx = docIds.indexOf(activeItem.documentId);
    if (currentDocIdx < 0) return;
    const direction = Math.sign(offset);
    if (!direction) return;
    const targetDocIdx = currentDocIdx + direction;
    if (targetDocIdx < 0 || targetDocIdx >= docIds.length) return;
    const targetDocId = docIds[targetDocIdx];
    const targetDocItems = visibleNavigation.itemsByDoc[targetDocId] ?? [];
    if (targetDocItems.length === 0) return;
    setSelectedItemId(
      direction > 0
        ? targetDocItems[0]
        : targetDocItems[targetDocItems.length - 1]
    );
  }

  function goToTextRelative(offset) {
    if (visibleItemIds.length === 0) return;
    if (!activeItem) {
      setSelectedItemId(visibleItemIds[0]);
      return;
    }
    const docIds = visibleNavigation.docIds;
    if (docIds.length === 0) return;
    const currentDocIdx = Math.max(0, docIds.indexOf(activeItem.documentId));
    const nextDocIdx = Math.min(
      docIds.length - 1,
      Math.max(0, currentDocIdx + offset)
    );
    const targetDocId = docIds[nextDocIdx];
    goToDocumentId(targetDocId);
  }

  useEffect(() => {
    async function onKeyDown(event) {
      if (event.defaultPrevented) return;

      if (rebaseOpen) {
        if (event.key === "Escape" && !rebaseBusy) {
          event.preventDefault();
          closeRebaseModal();
        }
        return;
      }

      if (preprocessDebugOpen) {
        if (event.key === "Escape") {
          event.preventDefault();
          setPreprocessDebugOpen(false);
        }
        return;
      }

      if (metadataOpen) {
        if (event.key === "Escape") {
          event.preventDefault();
          setMetadataOpen(false);
        }
        return;
      }

      if (settingsOpen) {
        if (event.key === "Escape") {
          event.preventDefault();
          if (deleteAllLabelsConfirmOpen) {
            setDeleteAllLabelsConfirmOpen(false);
          } else {
            closeSettingsModal();
          }
        }
        return;
      }

      if (spansAnalyticsOpen) {
        if (event.key === "Escape") {
          event.preventDefault();
          setSpansAnalyticsOpen(false);
        }
        return;
      }

      if (filtersOpen) {
        const key = event.key.toLowerCase();
        if (event.key === "Escape") {
          event.preventDefault();
          setFiltersOpen(false);
          return;
        }
        if (
          event.shiftKey &&
          !event.metaKey &&
          !event.ctrlKey &&
          !event.altKey &&
          key === "f"
        ) {
          event.preventDefault();
          setFiltersOpen(false);
        }
        return;
      }

      if (isEditableTarget(event.target)) {
        if (event.key === "Escape") {
          event.preventDefault();
          event.target.blur?.();
        }
        return;
      }

      const key = event.key.toLowerCase();
      const hasPrimaryModifier = event.metaKey || event.ctrlKey;
      if (hasPrimaryModifier && !event.altKey) {
        const nativeDocumentSelectionText = getDocumentNativeSelectionText();
        if (
          key === "c" &&
          !event.shiftKey &&
          document.activeElement === documentTextRef.current &&
          selectedRange &&
          !nativeDocumentSelectionText
        ) {
          event.preventDefault();
          await handleCopySelection();
          return;
        }
        if (key === "z") {
          event.preventDefault();
          if (event.shiftKey) {
            await handleRedo();
          } else {
            await handleUndo();
          }
          return;
        }
      }

      if (
        event.shiftKey &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        key === "f"
      ) {
        event.preventDefault();
        setFiltersOpen((prev) => !prev);
        return;
      }

      if (event.metaKey || event.ctrlKey || event.altKey) return;

      const categoryShortcutToken = getCategoryShortcutTokenFromEvent(event);
      if (
        categoryShortcutToken &&
        categoryByShortcutToken[categoryShortcutToken]
      ) {
        if (await handleCategoryShortcutToken(categoryShortcutToken)) {
          event.preventDefault();
        }
        return;
      }

      if (event.key === "ArrowRight") {
        event.preventDefault();
        goToTextRelative(1);
        return;
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        goToTextRelative(-1);
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        goToAnnotationInCurrentText(1);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        goToAnnotationInCurrentText(-1);
        return;
      }
      if (event.key === "Backspace" || event.key === "Delete") {
        event.preventDefault();
        clearSelection();
        return;
      }
      if (key === "a") {
        event.preventDefault();
        selectFullAnnotationSpan();
        return;
      }
      if (key === "x") {
        event.preventDefault();
        await handleClearAll();
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        await handleConfirm();
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        clearSelection();
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    categoryByShortcutToken,
    selectedRange,
    activeItem,
    activeVisibleIndex,
    activeIndexInDoc,
    historyTick,
    visibleNavigation,
    visibleItemIds,
    orderedItemIds,
    itemsById,
    preprocessDebugOpen,
    metadataOpen,
    settingsOpen,
    deleteAllLabelsConfirmOpen,
    spansAnalyticsOpen,
    filtersOpen,
    rebaseOpen,
    rebaseBusy,
    shiftPressed,
    lockBypassActive,
    selectionTouchesLockedRanges,
    activeLockedRanges,
  ]);

  const activeSegments = activeItem?.saved?.segments ?? [];
  const activeCoverage =
    activeItem?.coverage ??
    (activeItem ? computeCoverage(activeItem, activeSegments) : null);
  const importedLockCount = activeLockedRanges.length;
  const importedLockCharCount = activeLockedRanges.reduce(
    (total, range) => total + (range.end - range.begin),
    0
  );
  const completionStatusKey = getItemStatusKey(activeItem);
  const completionStatus = {
    key: completionStatusKey,
    label: ITEM_STATUS_LABELS[completionStatusKey] ?? "In progress",
  };
  const selectionCopyButtonLabel =
    selectionCopyState === "copied"
      ? "Copied"
      : selectionCopyState === "error"
      ? "Retry copy"
      : "Copy";
  const selectionCopyButtonTitle = !selectionText
    ? "Select text to copy"
    : selectionCopyState === "copied"
    ? "Copied current selection"
    : selectionCopyState === "error"
    ? "Retry copying the current selection"
    : "Copy current selection (Ctrl/Cmd+C)";
  const assignedLabelEntries = useMemo(() => {
    if (!activeItem) return [];
    return [...activeSegments]
      .sort(
        (a, b) =>
          a.begin - b.begin ||
          a.end - b.end ||
          a.category.localeCompare(b.category)
      )
      .map((segment, idx) => ({
        id: `${segment.begin}:${segment.end}:${segment.category}:${idx}`,
        category: segment.category,
        text: codePointSlice(activeDocText, segment.begin, segment.end),
      }));
  }, [activeItem, activeSegments, activeDocText]);

  const fullTextCharMeta = useMemo(() => {
    if (!activeItem || !activeDocText) return [];

    const text = codePoints(activeDocText);
    const categoryByIndex = new Array(text.length).fill(null);

    for (const segment of activeSegments) {
      const begin = Math.max(0, segment.begin);
      const end = Math.min(text.length, segment.end);
      for (let i = begin; i < end; i += 1) {
        categoryByIndex[i] = segment.category;
      }
    }

    const reviewBegin = activeItem.reviewBegin;
    const reviewEnd = activeItem.reviewEnd;
    const goldBegin = activeItem.gold?.begin ?? null;
    const goldEnd = activeItem.gold?.end ?? null;
    const selectionBegin = selectionAbs?.begin ?? null;
    const selectionEnd = selectionAbs?.end ?? null;
    const lockedRanges = mergeRanges(activeItem.lockedRanges ?? []);

    const result = [];
    for (let index = 0; index < text.length; index += 1) {
      const ch = text[index];
      const inReview = index >= reviewBegin && index < reviewEnd;
      const inGold =
        typeof goldBegin === "number" &&
        typeof goldEnd === "number" &&
        index >= goldBegin &&
        index < goldEnd;
      const inSelection =
        typeof selectionBegin === "number" &&
        typeof selectionEnd === "number" &&
        index >= selectionBegin &&
        index < selectionEnd;
      const isLocked = lockedRanges.some(
        (range) => index >= range.begin && index < range.end
      );

      result.push({
        index,
        ch,
        display: renderChar(ch),
        inReview,
        inGold,
        inSelection,
        isLocked,
        category: categoryByIndex[index],
        isReviewStart: index === reviewBegin,
        isReviewEnd: index === reviewEnd - 1,
      });
    }
    return result;
  }, [activeItem, activeDocText, activeSegments, selectionAbs]);

  const spansAnalytics = useMemo(() => {
    const byLabel = new Map();
    let total = 0;
    let started = 0;
    let readyToConfirm = 0;
    let confirmed = 0;
    let covered = 0;
    let coveredChars = 0;
    let totalChars = 0;

    for (const item of Object.values(itemsById)) {
      if (!item) continue;
      total += 1;
      const statusKey = getItemStatusKey(item);
      const coverage =
        item.coverage ?? computeCoverage(item, item.saved?.segments ?? []);
      const status = item.saved?.status ?? "empty";
      const isStarted = status !== "empty";
      const isConfirmed = statusKey === "confirmed";
      const isReadyToConfirm = statusKey === "ready_to_confirm";
      const isCovered = coverage.complete;

      if (isStarted) started += 1;
      if (isReadyToConfirm) readyToConfirm += 1;
      if (isConfirmed) confirmed += 1;
      if (isCovered) covered += 1;

      coveredChars += coverage.coveredChars ?? 0;
      totalChars += coverage.totalChars ?? 0;

      const label = getItemDisplayLabel(item);
      if (!byLabel.has(label)) {
        byLabel.set(label, {
          label,
          total: 0,
          started: 0,
          readyToConfirm: 0,
          confirmed: 0,
          covered: 0,
          coveredChars: 0,
          totalChars: 0,
        });
      }
      const entry = byLabel.get(label);
      entry.total += 1;
      if (isStarted) entry.started += 1;
      if (isReadyToConfirm) entry.readyToConfirm += 1;
      if (isConfirmed) entry.confirmed += 1;
      if (isCovered) entry.covered += 1;
      entry.coveredChars += coverage.coveredChars ?? 0;
      entry.totalChars += coverage.totalChars ?? 0;
    }

    const labels = Array.from(byLabel.values()).sort((a, b) => {
      const aCoverage = a.total > 0 ? a.covered / a.total : 0;
      const bCoverage = b.total > 0 ? b.covered / b.total : 0;
      if (aCoverage !== bCoverage) return aCoverage - bCoverage;
      if (a.total !== b.total) return b.total - a.total;
      return a.label.localeCompare(b.label);
    });

    return {
      total,
      started,
      readyToConfirm,
      confirmed,
      covered,
      coveredChars,
      totalChars,
      labels,
    };
  }, [itemsById]);

  const spansProgress = {
    total: spansAnalytics.total,
    started: spansAnalytics.started,
    confirmed: spansAnalytics.confirmed,
  };
  const textsProgress = progress?.texts ?? { total: 0, confirmed: 0 };
  const visibleDocCount = visibleNavigation.docIds.length;
  const activeDocStackIndex =
    activeDocIndexInVisible >= 0 ? activeDocIndexInVisible : 0;
  const activeDocStackPosition =
    activeDocIndexInVisible >= 0
      ? activeDocIndexInVisible + 1
      : visibleDocCount > 0
      ? 1
      : 0;
  const docStackDotOffsetPct =
    visibleDocCount <= 1
      ? visibleDocCount === 1 && activeDocStackPosition === 1
        ? 50
        : 0
      : (activeDocStackIndex / (visibleDocCount - 1)) * 100;
  const docStackCountLabel =
    visibleDocCount > 0
      ? `${activeDocStackPosition}/${visibleDocCount}`
      : "0/0";
  const docStackLabel =
    visibleDocCount > 0
      ? `Text ${activeDocStackPosition} of ${visibleDocCount} in the current navigation stack`
      : "No texts match the current filters";
  const activeDocConfirmedItems = activeDocProgress?.confirmedItems ?? 0;
  const activeDocItemCount = activeDocProgress?.itemCount ?? 0;
  const activeDocProgressPct = activeDocItemCount
    ? Math.min(100, (activeDocConfirmedItems / activeDocItemCount) * 100)
    : 0;
  const activeDocComplete =
    activeDocItemCount > 0 && activeDocConfirmedItems >= activeDocItemCount;

  const currentItemLabel = activeItem ? getItemDisplayLabel(activeItem) : "";
  const currentItemStatus = activeItem
    ? saveState.itemId === activeItem.itemId
      ? saveState.message || saveState.state
      : activeItem.saved?.status || "empty"
    : "";
  const currentItemTitle = [currentItemLabel, currentItemStatus]
    .filter(Boolean)
    .join(" · ");

  const currentItemSnippet = activeItem ? activeItem.gold?.text ?? "" : "";
  const currentItemSnippetDisplay =
    collapseWhitespaceForInlinePreview(currentItemSnippet);
  const preprocessDebugData =
    preprocessDebugState.itemId === activeItem?.itemId
      ? preprocessDebugState.data
      : preprocessDebugState.itemId && !activeItem
      ? preprocessDebugState.data
      : null;
  const selectedPreprocessCandidate =
    preprocessDebugData?.candidates?.find((candidate) => candidate.selected) ??
    null;
  const otherPreprocessCandidates =
    preprocessDebugData?.candidates?.filter(
      (candidate) => !candidate.selected
    ) ?? [];

  const canUndo =
    Boolean(activeItem) &&
    itemHistoryRef.current.itemId === activeItem?.itemId &&
    itemHistoryRef.current.past.length > 0 &&
    (lockBypassActive ||
      !itemSegmentsChangeLockedRanges(
        activeItem,
        itemHistoryRef.current.past[itemHistoryRef.current.past.length - 1]
          ?.segments ?? []
      ));
  const canRedo =
    Boolean(activeItem) &&
    itemHistoryRef.current.itemId === activeItem?.itemId &&
    itemHistoryRef.current.future.length > 0 &&
    (lockBypassActive ||
      !itemSegmentsChangeLockedRanges(
        activeItem,
        itemHistoryRef.current.future[itemHistoryRef.current.future.length - 1]
          ?.segments ?? []
      ));
  const clearAllBlocked =
    Boolean(activeItem) &&
    !lockBypassActive &&
    itemSegmentsChangeLockedRanges(activeItem, []);
  const quickCategories = categoryDisplayConfig.quickCategories;
  const dropdownCategories = uniqueStringsInOrder(categories);
  const selectedDropdownCategory = dropdownCategories.includes(selectedCategory)
    ? selectedCategory
    : "";
  const allStatusesSelected =
    includedStatusKeys.length === ITEM_STATUS_FILTER_OPTIONS.length;
  const allLabelsSelected =
    filterLabelOptions.length > 0 &&
    includedLabels.length === filterLabelOptions.length;
  const statusFilterActive = !allStatusesSelected;
  const labelFilterActive = includedLabels.length !== filterLabelOptions.length;
  const activeFilterGroupCount =
    Number(statusFilterActive) + Number(labelFilterActive);

  if (loading) {
    return <div className="page-state">Loading annotation workspace…</div>;
  }

  if (error) {
    return (
      <div className="page-state error">
        <div>{error}</div>
        <button type="button" onClick={fetchBootstrap}>
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="immersive-shell">
      <header className="topbar">
        <div className="title-block">
          <div className="app-title">Subspan Annotator</div>
        </div>
        <div className="topbar-toolbar">
          <div className="topbar-main-controls">
            <div className="topbar-control topbar-control-inline">
              <div
                ref={docFilterRef}
                className={`topbar-doc-filter ${
                  docFilterOpen ? "is-open" : ""
                }`}
                onBlur={handleDocFilterContainerBlur}
              >
                <input
                  ref={docFilterInputRef}
                  id="doc-filter"
                  type="text"
                  className="topbar-doc-filter-input"
                  role="combobox"
                  aria-label="Navigate texts in stack"
                  aria-autocomplete="list"
                  aria-expanded={docFilterOpen}
                  aria-controls={
                    docFilterOpen ? "doc-filter-listbox" : undefined
                  }
                  aria-activedescendant={
                    docFilterOpen && activeDocFilterOption
                      ? getDocFilterOptionId(activeDocFilterOption.value)
                      : undefined
                  }
                  placeholder="Jump to text in stack..."
                  autoComplete="off"
                  spellCheck={false}
                  value={docFilterQuery}
                  onFocus={handleDocFilterInputFocus}
                  onChange={handleDocFilterInputChange}
                  onKeyDown={handleDocFilterInputKeyDown}
                />
                <button
                  type="button"
                  className="topbar-doc-filter-toggle"
                  aria-label={
                    docFilterOpen ? "Close text list" : "Open text list"
                  }
                  tabIndex={-1}
                  onMouseDown={handleDocFilterToggleMouseDown}
                  onClick={handleDocFilterToggleClick}
                >
                  <span aria-hidden="true">{docFilterOpen ? "▴" : "▾"}</span>
                </button>
                {docFilterOpen ? (
                  <div
                    id="doc-filter-listbox"
                    className="topbar-doc-filter-menu"
                    role="listbox"
                    aria-label="Available texts"
                  >
                    {docFilterOptions.length === 0 ? (
                      <div className="topbar-doc-filter-empty">
                        No texts in this stack match that search.
                      </div>
                    ) : (
                      docFilterOptions.map((option, index) => (
                        <button
                          key={option.value}
                          id={getDocFilterOptionId(option.value)}
                          type="button"
                          role="option"
                          aria-selected={currentDocId === option.value}
                          data-doc-filter-value={option.value}
                          className={`topbar-doc-filter-option ${
                            currentDocId === option.value ? "is-current" : ""
                          } ${
                            index === docFilterActiveIndex ? "is-active" : ""
                          }`}
                          title={option.fullLabel}
                          onMouseDown={(event) => {
                            event.preventDefault();
                            handleSelectDocFilterOption(option.value);
                          }}
                          onMouseEnter={() => setDocFilterActiveIndex(index)}
                        >
                          <span className="topbar-doc-filter-option-primary">
                            {option.primaryText}
                          </span>
                          {option.secondaryText ? (
                            <span className="topbar-doc-filter-option-secondary">
                              {option.secondaryText}
                            </span>
                          ) : null}
                        </button>
                      ))
                    )}
                  </div>
                ) : null}
              </div>
            </div>
            <div className="topbar-filter">
              <button
                type="button"
                className={`topbar-filter-trigger ${
                  filtersOpen ? "is-open" : ""
                } ${activeFilterGroupCount > 0 ? "is-active" : ""}`}
                title={`Open filters (${FILTERS_SHORTCUT_LABEL})`}
                onClick={() => setFiltersOpen((prev) => !prev)}
                aria-label="Open filters"
                aria-haspopup="dialog"
                aria-expanded={filtersOpen}
                aria-controls={filtersOpen ? "filters-dialog" : undefined}
              >
                <span>Filters</span>
                {activeFilterGroupCount > 0 ? (
                  <span className="topbar-filter-count">
                    {activeFilterGroupCount}
                  </span>
                ) : null}
                <span className="topbar-summary-caret" aria-hidden="true">
                  {filtersOpen ? "▴" : "▾"}
                </span>
              </button>
            </div>
          </div>
          <div
            className={`topbar-stack-position ${
              visibleDocCount === 0 ? "is-empty" : ""
            }`}
            aria-label={docStackLabel}
            title={docStackLabel}
          >
            <div
              className="topbar-stack-position-track"
              style={{ "--stack-position": docStackDotOffsetPct }}
              aria-hidden="true"
            >
              <span className="topbar-stack-position-dot" />
            </div>
            <span className="topbar-stack-position-count">
              {docStackCountLabel}
            </span>
          </div>
          <div className="topbar-meta">
            <div className="topbar-summary" aria-label="Overall progress">
              {importMode.active ? (
                <span
                  className={`topbar-summary-chip import-mode-chip ${
                    lockBypassActive ? "is-bypass" : ""
                  }`}
                  title={
                    importMode.path
                      ? `Import mode active: ${importMode.path}`
                      : "Import mode active"
                  }
                >
                  Imports {lockBypassActive ? "Unlocked (Shift)" : "Locked"}
                </span>
              ) : null}
              <button
                type="button"
                className={`topbar-summary-chip topbar-summary-chip-button ${
                  spansAnalyticsOpen ? "is-open" : ""
                }`}
                onClick={() => setSpansAnalyticsOpen((prev) => !prev)}
                aria-label="Open span coverage analytics"
                aria-haspopup="dialog"
                aria-expanded={spansAnalyticsOpen}
                aria-controls={
                  spansAnalyticsOpen ? "spans-analytics-dialog" : undefined
                }
              >
                Spans {spansProgress.confirmed}/{spansProgress.total} (
                {formatPercent(spansProgress.confirmed, spansProgress.total)})
                <span className="topbar-summary-caret" aria-hidden="true">
                  {spansAnalyticsOpen ? "▴" : "▾"}
                </span>
              </button>
              <span className="topbar-summary-chip">
                Texts {textsProgress.confirmed}/{textsProgress.total} (
                {formatPercent(textsProgress.confirmed, textsProgress.total)})
              </span>
            </div>
          </div>
          <div className="topbar-actions">
            <button
              type="button"
              className="update-gold-btn"
              onClick={() => {
                setSpansAnalyticsOpen(false);
                setSettingsOpen(false);
                openRebaseModal();
              }}
              aria-haspopup="dialog"
              aria-expanded={rebaseOpen}
              aria-controls={rebaseOpen ? "rebase-dialog" : undefined}
              title="Check the linked annotations for changes"
            >
              Annotation updates
            </button>
            <button
              type="button"
              className="settings-icon-btn"
              onClick={() => {
                void handleRerunPreprocessing();
              }}
              aria-label="Rerun preprocessing on all non-confirmed items"
              title="Rerun preprocessing (all non-confirmed items)"
              disabled={preprocessorBusy}
            >
              <span aria-hidden="true">{preprocessorBusy ? "…" : "↻"}</span>
            </button>
            <button
              type="button"
              className="settings-icon-btn"
              onClick={() => {
                setSpansAnalyticsOpen(false);
                setSettingsOpen(true);
              }}
              aria-label="Open settings"
              aria-haspopup="dialog"
              aria-expanded={settingsOpen}
              aria-controls={settingsOpen ? "settings-dialog" : undefined}
              title="Settings"
            >
              <span aria-hidden="true">&#9881;</span>
            </button>
          </div>
        </div>
      </header>

      <div className="workspace">
        <section className="text-stage">
          {activeItem ? (
            <>
              <div className="focus-header">
                <div className="focus-main-row">
                  <div className="focus-main">
                    <div className="focus-title">{currentItemTitle}</div>
                    <div
                      className="focus-snippet"
                      title={currentItemSnippet || undefined}
                    >
                      “{currentItemSnippetDisplay}”
                    </div>
                  </div>
                  <div className="focus-side">
                    <div className="focus-pills">
                      <CopyableTruncatedValue
                        value={activeItem.documentId}
                        className="pill pill-copyable focus-doc-pill"
                        textClassName="focus-doc-pill-text"
                        buttonClassName="focus-doc-pill-button"
                        copyAriaLabel="Copy full text name"
                        maxDisplayChars={10}
                      />
                    </div>
                    {activeDocProgress ? (
                      <div
                        className={`doc-progress ${
                          activeDocComplete ? "is-complete" : ""
                        }`}
                      >
                        <div className="doc-progress-row">
                          <span>Doc progress</span>
                          <span>
                            {activeDocConfirmedItems}/{activeDocItemCount} (
                            {formatPercent(
                              activeDocConfirmedItems,
                              activeDocItemCount
                            )}
                            )
                          </span>
                        </div>
                        <div className="doc-progress-track" aria-hidden>
                          <div
                            className="doc-progress-fill"
                            style={{ width: `${activeDocProgressPct}%` }}
                          />
                        </div>
                      </div>
                    ) : null}
                  </div>
                </div>

                <div className="focus-legend">
                  <span className="legend-chip">
                    <span className="legend-mark legend-gold" />
                    Gold chars
                  </span>
                  <span className="legend-chip">
                    <span className="legend-mark legend-dim" />
                    Dimmed context
                  </span>
                  <span className="legend-chip">
                    <span className="legend-mark legend-selection" />
                    Mouse selection
                  </span>
                  {importMode.active ? (
                    <span className="legend-chip">
                      <span
                        className={`legend-mark legend-lock ${
                          lockBypassActive ? "is-bypass" : ""
                        }`}
                      />
                      Imported lock {lockBypassActive ? "(Shift)" : ""}
                    </span>
                  ) : null}
                  <div
                    className="legend-history"
                    role="group"
                    aria-label="History controls"
                  >
                    <button
                      type="button"
                      className="history-icon-btn"
                      onClick={handleUndo}
                      disabled={!canUndo}
                      title="Undo (Ctrl/Cmd+Z)"
                      aria-label="Undo (Ctrl/Cmd+Z)"
                    >
                      <svg
                        className="history-icon-svg"
                        viewBox="0 0 24 24"
                        aria-hidden="true"
                        focusable="false"
                      >
                        <path d="M9 14 4 9l5-5" />
                        <path d="M4 9h10a4 4 0 0 1 0 8h-1" />
                      </svg>
                    </button>
                    <button
                      type="button"
                      className="history-icon-btn"
                      onClick={handleRedo}
                      disabled={!canRedo}
                      title="Redo (Ctrl/Cmd+Shift+Z)"
                      aria-label="Redo (Ctrl/Cmd+Shift+Z)"
                    >
                      <svg
                        className="history-icon-svg"
                        viewBox="0 0 24 24"
                        aria-hidden="true"
                        focusable="false"
                      >
                        <path d="m15 14 5-5-5-5" />
                        <path d="M20 9H10a4 4 0 0 0 0 8h1" />
                      </svg>
                    </button>
                    <button
                      type="button"
                      className="history-text-btn"
                      onClick={clearSelection}
                      disabled={!selectedRange}
                      title="Clear selection (Delete / Backspace)"
                    >
                      Clear Selection
                    </button>
                    <button
                      type="button"
                      className="history-text-btn"
                      onClick={handleClearAll}
                      disabled={clearAllBlocked}
                      title={
                        clearAllBlocked
                          ? "Hold Shift to clear imported ranges"
                          : "Clear all labels (X)"
                      }
                    >
                      Clear All Labels
                    </button>
                    <button
                      type="button"
                      className="history-text-btn"
                      onClick={() => setMetadataOpen(true)}
                      title="Show text metadata"
                      disabled={!activeItem}
                    >
                      Metadata
                    </button>
                    <button
                      type="button"
                      className="history-text-btn"
                      onClick={() => setPreprocessDebugOpen(true)}
                      title="Show preprocessing diagnostics"
                      disabled={!activeItem}
                    >
                      Preprocess Debug
                    </button>
                  </div>
                </div>
              </div>

              <div className="document-frame">
                <div
                  className="document-scroll"
                  ref={documentScrollRef}
                  role="region"
                  aria-label="document text"
                >
                  <div
                    className="document-text"
                    ref={documentTextRef}
                    tabIndex={0}
                    onCopy={handleDocumentCopy}
                    onMouseLeave={() => {}}
                    onMouseDown={(event) => {
                      // Dimmed (out-of-review) text is coalesced into handler-less
                      // runs; preserve the old "click outside the review range
                      // clears the selection" behaviour at the container level.
                      const charSpan =
                        event.target?.closest?.(".doc-char");
                      if (!charSpan || charSpan.classList.contains("in-review")) {
                        return;
                      }
                      dragRef.current = { active: false, startAbs: null };
                      setSelectedRange(null);
                    }}
                  >
                    <DocCharLayer
                      charMeta={fullTextCharMeta}
                      categoryColors={categoryColors}
                      lockBypassActive={lockBypassActive}
                      focusCharRef={focusCharRef}
                      onCharMouseDown={stableCharMouseDown}
                      onCharMouseEnter={stableCharMouseEnter}
                    />
                  </div>
                </div>
              </div>
            </>
          ) : (
            <div className="empty-main">
              No item matches the current filter.
            </div>
          )}
        </section>

        <aside className="command-panel">
          <section className="panel-section annotate-panel">
            <div className="section-heading">Annotate</div>

            <div className="annotate-top">
              {importMode.active ? (
                <div className="import-mode-note">
                  Imported confirmed ranges are locked.
                  {activeItem && importedLockCount > 0
                    ? ` ${importedLockCharCount} char${
                        importedLockCharCount === 1 ? "" : "s"
                      } locked in this item.`
                    : ""}
                  {" "}
                  Hold Shift to edit them temporarily.
                </div>
              ) : null}
              <div className="selection-card">
                {selectedRange ? (
                  <>
                    <div className="selection-card-actions">
                      <div className="selection-copy-hint">Ctrl/Cmd+C</div>
                      <button
                        type="button"
                        className="selection-copy-btn"
                        onClick={() => {
                          void handleCopySelection();
                        }}
                        disabled={!selectionText}
                        title={selectionCopyButtonTitle}
                      >
                        {selectionCopyButtonLabel}
                      </button>
                    </div>
                    <code className="selection-code selection-code-compact">
                      {JSON.stringify(selectionText)}
                    </code>
                  </>
                ) : (
                  <div className="muted">
                    Drag over characters in the bright focus span to define a
                    subspan.
                    {importMode.active && activeLockedRanges.length > 0
                      ? " Locked imported ranges require Shift."
                      : ""}
                  </div>
                )}
              </div>

              <div
                className={`assigned-labels-panel status-${completionStatus.key}`}
              >
                <div className="assigned-labels-head">
                  <span>Assigned Labels</span>
                  <div className="assigned-labels-metrics">
                    <strong>
                      {activeCoverage?.coveredChars ?? 0}/
                      {activeCoverage?.totalChars ?? 0}
                    </strong>
                    <span
                      className={`assigned-labels-status status-${completionStatus.key}`}
                    >
                      {completionStatus.label}
                    </span>
                  </div>
                </div>
                <div className="assigned-labels-progress-track" aria-hidden>
                  <div
                    className="assigned-labels-progress-fill"
                    style={{
                      width: `${
                        activeCoverage?.totalChars
                          ? (activeCoverage.coveredChars /
                              activeCoverage.totalChars) *
                            100
                          : 0
                      }%`,
                    }}
                  />
                </div>
                <div className="assigned-labels-list">
                  {assignedLabelEntries.length === 0 ? (
                    <div className="muted">No labels assigned yet.</div>
                  ) : (
                    assignedLabelEntries.map((entry) => (
                      <div key={entry.id} className="assigned-label-row">
                        <span
                          className="assigned-label-tag"
                          style={{
                            backgroundColor: getCategoryColor(entry.category),
                          }}
                        >
                          {entry.category}
                        </span>
                        <code
                          className="assigned-label-text"
                          title={JSON.stringify(entry.text)}
                        >
                          {JSON.stringify(entry.text)}
                        </code>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>

            <div className="annotate-sticky-controls">
              <div className="category-grid">
                {quickCategories.length === 0 ? (
                  <div className="muted">No categories yet.</div>
                ) : null}
                {quickCategoryShortcutEntries.map(({ category, token }) => (
                  <button
                    key={category}
                    type="button"
                    className={`category-tile ${
                      selectedCategory === category ? "selected" : ""
                    }`}
                    style={{ backgroundColor: getCategoryColor(category) }}
                    onClick={() => {
                      void handleSelectOrApplyCategory(category);
                    }}
                    title={`Select category: ${category}${
                      token ? ` (${token.toUpperCase()})` : ""
                    }`}
                  >
                    {token ? (
                      <span className="tile-shortcut">
                        {token.toUpperCase()}
                      </span>
                    ) : null}
                    <span>{category}</span>
                  </button>
                ))}
              </div>

              <div className="control-row compact">
                <select
                  ref={otherCategorySelectRef}
                  id="other-categories"
                  aria-label="Other categories"
                  value={selectedDropdownCategory}
                  disabled={dropdownCategories.length === 0}
                  onChange={(e) => {
                    void handleSelectOrApplyCategory(e.target.value);
                  }}
                  onKeyDown={(e) => {
                    const shortcutToken = getCategoryShortcutTokenFromEvent(e);
                    if (
                      shortcutToken &&
                      categoryByShortcutToken[shortcutToken]
                    ) {
                      e.preventDefault();
                      e.stopPropagation();
                      void handleCategoryShortcutToken(shortcutToken);
                    }
                  }}
                >
                  <option value="">
                    {dropdownCategories.length > 0
                      ? "Select category…"
                      : "No categories yet"}
                  </option>
                  {dropdownCategories.map((category) => (
                    <option key={category} value={category}>
                      {category}
                    </option>
                  ))}
                </select>
              </div>

              <div className="action-grid">
                <button
                  type="button"
                  className="confirm-btn"
                  onClick={handleConfirm}
                  disabled={!activeCoverage?.complete}
                  title="Confirm item (Enter)"
                >
                  Confirm Item
                </button>
              </div>
            </div>
          </section>
        </aside>
      </div>

      {spansAnalyticsOpen ? (
        <div
          className="spans-analytics-backdrop"
          role="presentation"
          onClick={() => setSpansAnalyticsOpen(false)}
        >
          <div
            id="spans-analytics-dialog"
            className="spans-analytics-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="spans-analytics-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="spans-analytics-head">
              <h2 id="spans-analytics-title">Span Coverage Analytics</h2>
              <button
                type="button"
                className="spans-analytics-close-btn"
                onClick={() => setSpansAnalyticsOpen(false)}
                aria-label="Close span coverage analytics"
              >
                Close
              </button>
            </div>

            <div className="spans-analytics-note">
              Fully covered spans are immediately ready to confirm or already
              confirmed. Rows are sorted by lowest coverage first.
            </div>

            <div className="spans-analytics-overview">
              <div className="spans-analytics-stat">
                <span>Ready to confirm</span>
                <strong>
                  {spansAnalytics.readyToConfirm}/{spansAnalytics.total} (
                  {formatPercent(
                    spansAnalytics.readyToConfirm,
                    spansAnalytics.total
                  )}
                  )
                </strong>
              </div>
              <div className="spans-analytics-stat">
                <span>Confirmed</span>
                <strong>
                  {spansAnalytics.confirmed}/{spansAnalytics.total} (
                  {formatPercent(
                    spansAnalytics.confirmed,
                    spansAnalytics.total
                  )}
                  )
                </strong>
              </div>
              <div className="spans-analytics-stat">
                <span>Fully covered</span>
                <strong>
                  {spansAnalytics.covered}/{spansAnalytics.total} (
                  {formatPercent(spansAnalytics.covered, spansAnalytics.total)})
                </strong>
              </div>
              <div className="spans-analytics-stat">
                <span>Character coverage</span>
                <strong>
                  {formatPercentOneDecimal(
                    spansAnalytics.coveredChars,
                    spansAnalytics.totalChars
                  )}
                </strong>
              </div>
            </div>

            <div className="spans-analytics-table-wrap">
              <table className="spans-analytics-table">
                <thead>
                  <tr>
                    <th>Label</th>
                    <th>Spans</th>
                    <th>Covered</th>
                    <th>Ready</th>
                    <th>Confirmed</th>
                    <th>Chars</th>
                  </tr>
                </thead>
                <tbody>
                  {spansAnalytics.labels.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="spans-analytics-empty-row">
                        No annotation labels found.
                      </td>
                    </tr>
                  ) : (
                    spansAnalytics.labels.map((entry) => (
                      <tr key={entry.label}>
                        <td className="spans-analytics-label-cell">
                          {entry.label}
                        </td>
                        <td>{entry.total}</td>
                        <td>
                          {entry.covered}/{entry.total} (
                          {formatPercent(entry.covered, entry.total)})
                        </td>
                        <td>{entry.readyToConfirm}</td>
                        <td>{entry.confirmed}</td>
                        <td>
                          {formatPercentOneDecimal(
                            entry.coveredChars,
                            entry.totalChars
                          )}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      ) : null}

      {filtersOpen ? (
        <div
          className="filters-backdrop"
          role="presentation"
          onClick={() => setFiltersOpen(false)}
        >
          <div
            id="filters-dialog"
            className="filters-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="filters-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="filters-head">
              <h2 id="filters-title">Filters</h2>
              <button
                type="button"
                className="filters-close-btn"
                onClick={() => setFiltersOpen(false)}
                aria-label="Close filters"
              >
                Close
              </button>
            </div>
            <div className="filters-panels">
              <div className="topbar-filter-section">
                <div className="topbar-filter-section-head">
                  <span>Status</span>
                  <label className="checkbox-row topbar-filter-select-all">
                    <input
                      type="checkbox"
                      checked={allStatusesSelected}
                      onChange={(event) => {
                        setIncludedStatusKeys(
                          event.target.checked
                            ? ITEM_STATUS_FILTER_OPTIONS.map(
                                (option) => option.key
                              )
                            : []
                        );
                      }}
                    />
                    <span>Select all</span>
                  </label>
                </div>
                <div className="topbar-filter-options">
                  {ITEM_STATUS_FILTER_OPTIONS.map((option) => (
                    <label
                      key={option.key}
                      className="checkbox-row topbar-filter-option"
                    >
                      <input
                        type="checkbox"
                        checked={includedStatusSet.has(option.key)}
                        onChange={(event) => {
                          const checked = event.target.checked;
                          setIncludedStatusKeys((prev) => {
                            const nextSet = new Set(prev);
                            if (checked) {
                              nextSet.add(option.key);
                            } else {
                              nextSet.delete(option.key);
                            }
                            return ITEM_STATUS_FILTER_OPTIONS.map(
                              (entry) => entry.key
                            ).filter((key) => nextSet.has(key));
                          });
                        }}
                      />
                      <span>{option.label}</span>
                    </label>
                  ))}
                </div>
              </div>
              <div className="topbar-filter-section">
                <div className="topbar-filter-section-head">
                  <span>Labels</span>
                  <label className="checkbox-row topbar-filter-select-all">
                    <input
                      type="checkbox"
                      checked={allLabelsSelected}
                      disabled={filterLabelOptions.length === 0}
                      onChange={(event) => {
                        setIncludedLabels(
                          event.target.checked ? [...filterLabelOptions] : []
                        );
                      }}
                    />
                    <span>Select all</span>
                  </label>
                </div>
                <div className="topbar-filter-options is-scrollable">
                  {filterLabelOptions.length === 0 ? (
                    <div className="muted">No labels found.</div>
                  ) : (
                    filterLabelOptions.map((label) => (
                      <label
                        key={label}
                        className="checkbox-row topbar-filter-option"
                      >
                        <input
                          type="checkbox"
                          checked={includedLabelsSet.has(label)}
                          onChange={(event) => {
                            const checked = event.target.checked;
                            setIncludedLabels((prev) => {
                              const nextSet = new Set(prev);
                              if (checked) {
                                nextSet.add(label);
                              } else {
                                nextSet.delete(label);
                              }
                              return filterLabelOptions.filter((entry) =>
                                nextSet.has(entry)
                              );
                            });
                          }}
                        />
                        <span>{label}</span>
                      </label>
                    ))
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {preprocessDebugOpen ? (
        <div
          className="preprocess-debug-modal-backdrop"
          role="presentation"
          onClick={() => setPreprocessDebugOpen(false)}
        >
          <div
            id="preprocess-debug-dialog"
            className="preprocess-debug-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="preprocess-debug-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="preprocess-debug-head">
              <div className="preprocess-debug-title-group">
                <h2 id="preprocess-debug-title">Preprocess Debug</h2>
                <div className="preprocess-debug-subtitle">
                  {activeItem ? currentItemTitle : "No active item selected"}
                </div>
              </div>
              <button
                type="button"
                className="preprocess-debug-close-btn"
                onClick={() => setPreprocessDebugOpen(false)}
                aria-label="Close preprocessing diagnostics"
              >
                Close
              </button>
            </div>

            {preprocessDebugState.state === "loading" ? (
              <div className="preprocess-debug-note">
                Loading preprocessing diagnostics…
              </div>
            ) : preprocessDebugState.state === "error" ? (
              <div className="preprocess-debug-note is-error">
                {preprocessDebugState.error || "Failed to load diagnostics."}
              </div>
            ) : preprocessDebugData ? (
              <div className="preprocess-debug-details">
                <div className="preprocess-debug-summary-grid">
                  <div className="preprocess-debug-summary-card">
                    <span>Winner</span>
                    <strong>
                      {selectedPreprocessCandidate?.source ?? "none"}
                    </strong>
                  </div>
                  <div className="preprocess-debug-summary-card">
                    <span>Saved state</span>
                    <strong>
                      {preprocessDebugData.saved?.status ?? "empty"}
                    </strong>
                  </div>
                  <div className="preprocess-debug-summary-card">
                    <span>Review range</span>
                    <strong>
                      [{preprocessDebugData.item?.reviewRange?.begin ?? 0},{" "}
                      {preprocessDebugData.item?.reviewRange?.end ?? 0})
                    </strong>
                  </div>
                  <div className="preprocess-debug-summary-card">
                    <span>Candidates tried</span>
                    <strong>
                      {preprocessDebugData.candidates?.length ?? 0}
                    </strong>
                  </div>
                </div>

                <div className="preprocess-debug-top-grid">
                  <div className="preprocess-debug-card">
                    <div className="preprocess-debug-card-title">
                      What The Item Looks Like
                    </div>
                    <div className="preprocess-debug-inline-label">
                      Review text
                    </div>
                    <pre className="preprocess-debug-code">
                      {JSON.stringify(
                        preprocessDebugData.item?.reviewText ?? "",
                        null,
                        2
                      )}
                    </pre>
                    <div className="preprocess-debug-inline-label">
                      Seed sent into preprocessing
                    </div>
                    <pre className="preprocess-debug-code compact">
                      {formatDebugSegmentsBlock(
                        preprocessDebugData.seedSegments ?? []
                      )}
                    </pre>
                    <div className="preprocess-debug-inline-label">
                      Current saved segments
                    </div>
                    <pre className="preprocess-debug-code compact">
                      {formatDebugSegmentsBlock(
                        preprocessDebugData.saved?.segments ?? []
                      )}
                    </pre>
                  </div>
                  <div className="preprocess-debug-card">
                    <div className="preprocess-debug-card-title">Context</div>
                    <div className="preprocess-debug-context-grid">
                      <div>
                        <span className="preprocess-debug-context-label">
                          Before
                        </span>
                        <pre className="preprocess-debug-code">
                          {JSON.stringify(
                            preprocessDebugData.item?.textContextBefore ?? "",
                            null,
                            2
                          )}
                        </pre>
                      </div>
                      <div>
                        <span className="preprocess-debug-context-label">
                          After
                        </span>
                        <pre className="preprocess-debug-code">
                          {JSON.stringify(
                            preprocessDebugData.item?.textContextAfter ?? "",
                            null,
                            2
                          )}
                        </pre>
                      </div>
                    </div>
                    <div className="preprocess-debug-inline-label">
                      Gold annotation
                    </div>
                    {preprocessDebugData.item?.gold ? (
                      <div className="preprocess-debug-annotation-list compact">
                        <div className="preprocess-debug-annotation-row compact">
                          <strong>gold</strong>
                          <span>
                            {`${preprocessDebugData.item.gold.label} [${preprocessDebugData.item.gold.begin}, ${preprocessDebugData.item.gold.end})`}
                          </span>
                        </div>
                      </div>
                    ) : (
                      <div className="preprocess-debug-note">
                        No gold annotation.
                      </div>
                    )}
                  </div>
                </div>

                {selectedPreprocessCandidate ? (
                  <section className="preprocess-debug-candidate is-selected">
                    <div className="preprocess-debug-candidate-head">
                      <div className="preprocess-debug-candidate-title-group">
                        <strong>{selectedPreprocessCandidate.source}</strong>
                        <span className="preprocess-debug-selected-chip">
                          selected
                        </span>
                      </div>
                      <div className="preprocess-debug-score is-selected">
                        {formatDebugScore(selectedPreprocessCandidate.score)}
                      </div>
                    </div>

                    <div className="preprocess-debug-inline-grid">
                      <div className="preprocess-debug-card compact">
                        <div className="preprocess-debug-card-title">Input</div>
                        <pre className="preprocess-debug-code compact">
                          {formatDebugSegmentsBlock(
                            selectedPreprocessCandidate.inputSegments ?? []
                          )}
                        </pre>
                      </div>
                      <div className="preprocess-debug-card compact">
                        <div className="preprocess-debug-card-title">
                          Output
                        </div>
                        <pre className="preprocess-debug-code compact">
                          {formatDebugSegmentsBlock(
                            selectedPreprocessCandidate.outcome?.segments ?? []
                          )}
                        </pre>
                      </div>
                    </div>

                    <div className="preprocess-debug-rule-hits">
                      Rule hits:{" "}
                      {formatDebugRuleHits(
                        selectedPreprocessCandidate.outcome?.ruleHits ?? {}
                      )}
                    </div>

                    <div className="preprocess-debug-table-wrap">
                      <table className="preprocess-debug-table">
                        <thead>
                          <tr>
                            <th>Status</th>
                            <th>Rule</th>
                            <th>Hits</th>
                            <th>Result</th>
                          </tr>
                        </thead>
                        <tbody>
                          {(
                            selectedPreprocessCandidate.outcome?.ruleTrace ?? []
                          ).map((entry) => {
                            const applied = entry.changed || entry.hitCount > 0;
                            return (
                              <tr
                                key={`${selectedPreprocessCandidate.source}:${selectedPreprocessCandidate.sourceOrder}:${entry.ruleId}`}
                                className={`preprocess-debug-rule-row ${
                                  applied ? "is-applied" : "is-checked"
                                }`}
                              >
                                <td>
                                  <span
                                    className={`preprocess-debug-rule-chip ${
                                      applied ? "is-applied" : "is-checked"
                                    }`}
                                  >
                                    {applied ? "applied" : "checked"}
                                  </span>
                                </td>
                                <td>{entry.ruleId}</td>
                                <td>{entry.hitCount}</td>
                                <td className="preprocess-debug-table-after">
                                  <code>
                                    {formatDebugSegmentsInline(
                                      entry.afterSegments ?? []
                                    )}
                                  </code>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </section>
                ) : null}

                {otherPreprocessCandidates.length > 0 ? (
                  <div className="preprocess-debug-other-card">
                    <div className="preprocess-debug-card-title">
                      Other candidates
                    </div>
                    <div className="preprocess-debug-other-list">
                      {otherPreprocessCandidates.map((candidate) => (
                        <div
                          key={`${candidate.source}:${candidate.sourceOrder}`}
                          className="preprocess-debug-other-row"
                        >
                          <div className="preprocess-debug-other-main">
                            <strong>{candidate.source}</strong>
                            <span className="preprocess-debug-other-score">
                              {formatDebugScore(candidate.score)}
                            </span>
                          </div>
                          <div className="preprocess-debug-other-meta">
                            <span>
                              Hits:{" "}
                              {formatDebugRuleHits(
                                candidate.outcome?.ruleHits ?? {}
                              )}
                            </span>
                            <code>
                              {formatDebugSegmentsInline(
                                candidate.outcome?.segments ?? []
                              )}
                            </code>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="preprocess-debug-note">
                No preprocessing diagnostics available.
              </div>
            )}
          </div>
        </div>
      ) : null}

      {metadataOpen ? (
        <div
          className="metadata-modal-backdrop"
          role="presentation"
          onClick={() => setMetadataOpen(false)}
        >
          <div
            id="metadata-dialog"
            className="metadata-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="metadata-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="metadata-modal-head">
              <div className="metadata-modal-title-group">
                <h2 id="metadata-title">Metadata</h2>
                <CopyableTruncatedValue
                  value={activeItem?.documentId ?? METADATA_FILLER}
                  className="metadata-doc-name"
                  textClassName="metadata-doc-name-text"
                  buttonClassName="metadata-doc-name-button"
                  copyAriaLabel="Copy full text name"
                />
              </div>
              <button
                type="button"
                className="metadata-close-btn"
                onClick={() => setMetadataOpen(false)}
                aria-label="Close text metadata"
              >
                Close
              </button>
            </div>

            {activeItem ? (
              <div className="metadata-details">
                <div className="metadata-grid">
                  <div className="metadata-entry">
                    <span>Given name patient</span>
                    <strong>{activeDocMetadata.patientGivenName}</strong>
                  </div>
                  <div className="metadata-entry">
                    <span>Last name patient</span>
                    <strong>{activeDocMetadata.patientLastName}</strong>
                  </div>
                  <div className="metadata-entry">
                    <span>Birthdate patient</span>
                    <strong>{activeDocMetadata.patientBirthdate}</strong>
                  </div>
                  <div className="metadata-entry">
                    <span>Date of text creation</span>
                    <strong>{activeDocMetadata.textCreationDate}</strong>
                  </div>
                  <div className="metadata-entry">
                    <span>Document language</span>
                    <strong>{activeDocMetadata.language}</strong>
                  </div>
                  <div className="metadata-entry">
                    <span>Subannotation profile</span>
                    <strong>
                      {bootstrapMeta?.subannotationProfile
                        ? `${bootstrapMeta.subannotationProfile.profileId}@${bootstrapMeta.subannotationProfile.profileVersion}`
                        : METADATA_FILLER}
                    </strong>
                  </div>
                </div>
                <div className="metadata-annotations-section">
                  <div className="metadata-annotations-title">
                    Annotations ({activeAnnotations.length})
                  </div>
                  {activeAnnotations.length > 0 ? (
                    <div className="metadata-grid">
                      {activeAnnotations.map((annotation) => (
                        <div
                          key={annotation.key}
                          className="metadata-entry metadata-annotation-entry"
                          style={{
                            borderLeftColor: annotation.sourceBorderColor,
                          }}
                        >
                          <strong>{annotation.text}</strong>
                          <span className="metadata-annotation-meta">
                            <span
                              className="metadata-annotation-source"
                              style={{
                                backgroundColor:
                                  annotation.sourceChipBackground,
                                borderColor: annotation.sourceBorderColor,
                                color: annotation.sourceChipText,
                              }}
                            >
                              {annotation.sourceId}
                            </span>
                            <span className="metadata-annotation-label">
                              {annotation.label}
                            </span>
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="metadata-note">
                      No annotations for this item.
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="metadata-note">No active text selected.</div>
            )}
          </div>
        </div>
      ) : null}

      {settingsOpen ? (
        <div
          className="settings-modal-backdrop"
          role="presentation"
          onClick={closeSettingsModal}
        >
          <div
            id="settings-dialog"
            className="settings-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="settings-modal-head">
              <h2 id="settings-title">Settings</h2>
              <button
                type="button"
                className="settings-close-btn"
                onClick={closeSettingsModal}
                aria-label="Close settings"
              >
                Close
              </button>
            </div>

            <div className="settings-list">
              <label className="settings-field" htmlFor="keyboard-layout">
                <span>Keyboard layout</span>
                <select
                  id="keyboard-layout"
                  value={keyboardLayout}
                  onChange={(event) =>
                    setKeyboardLayout(
                      normalizeKeyboardLayout(event.target.value)
                    )
                  }
                >
                  <option value="qwerty">QWERTY</option>
                  <option value="azerty">AZERTY</option>
                </select>
              </label>
              <div className="settings-note">
                This setting controls letter-based category shortcuts and their
                labels.
              </div>
              <div className="settings-shortcuts">
                <div className="section-heading">Shortcuts</div>
                <div className="shortcut-list">
                  <div>
                    <kbd>Mouse Drag</kbd>
                    <span>Select subspan in focus</span>
                  </div>
                  <div>
                    <kbd>A</kbd>
                    <span>Select full annotation span</span>
                  </div>
                  <div>
                    <kbd>{quickCategoryShortcutLegend}</kbd>
                    <span>Assign/select quick category</span>
                  </div>
                  <div>
                    <kbd>Delete</kbd>/<kbd>Backspace</kbd>
                    <span>Clear selection</span>
                  </div>
                  <div>
                    <kbd>X</kbd>
                    <span>Clear all labels</span>
                  </div>
                  <div>
                    <kbd>Enter</kbd>
                    <span>Confirm item</span>
                  </div>
                  <div>
                    <kbd>Ctrl/Cmd+C</kbd>
                    <span>Copy current selection</span>
                  </div>
                  <div>
                    <kbd>Ctrl/Cmd+Z</kbd>
                    <span>Undo (current annotation only)</span>
                  </div>
                  <div>
                    <kbd>Ctrl/Cmd+Shift+Z</kbd>
                    <span>Redo</span>
                  </div>
                  <div>
                    <kbd>←</kbd>
                    <span>Prev text</span>
                  </div>
                  <div>
                    <kbd>→</kbd>
                    <span>Next text</span>
                  </div>
                  <div>
                    <kbd>↑</kbd>
                    <span>Prev annotation (jumps to prev text at top)</span>
                  </div>
                  <div>
                    <kbd>↓</kbd>
                    <span>Next annotation (jumps to next text at end)</span>
                  </div>
                  <div>
                    <kbd>{FILTERS_SHORTCUT_LABEL}</kbd>
                    <span>Open/close filters</span>
                  </div>
                  <div>
                    <kbd>Esc</kbd>
                    <span>Close open popup / clear selection / blur input</span>
                  </div>
                </div>
              </div>
              <button
                type="button"
                className="settings-danger-btn settings-delete-all-btn"
                onClick={() => setDeleteAllLabelsConfirmOpen(true)}
                disabled={loading || orderedItemIds.length === 0}
                title="Delete all labels for the entire project"
              >
                Delete all labels
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {rebaseOpen ? (
        <div
          className="rebase-modal-backdrop"
          role="presentation"
          onClick={closeRebaseModal}
        >
          <div
            id="rebase-dialog"
            className="rebase-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="rebase-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="rebase-modal-head">
              <div>
                <h2 id="rebase-title">Annotation updates</h2>
                <p>Review changes before continuing</p>
              </div>
              <button
                type="button"
                className="settings-close-btn"
                onClick={closeRebaseModal}
                disabled={Boolean(rebaseBusy)}
              >
                Close
              </button>
            </div>

            <div className="rebase-note">
              {rebaseBusy === "check"
                ? "Checking the linked annotations for changes…"
                : rebaseSourceLabel
                ? `Linked source: ${rebaseSourceLabel}. No file selection is needed.`
                : "This workspace checks its linked annotations automatically; no files need to be selected."}
            </div>

            {rebaseError ? (
              <div className="rebase-message is-error" role="alert">
                {rebaseError}
              </div>
            ) : null}

            {rebaseReport ? (
              <div className="rebase-preview" aria-live="polite">
                <p>These are the effects of applying the changed annotations:</p>
                <div className="rebase-impact-grid">
                  <div><strong>{rebaseReport.summary?.confirmedPreserved ?? 0}</strong><span>Confirmed preserved</span></div>
                  <div><strong>{rebaseReport.summary?.requiresReview ?? 0}</strong><span>Need review</span></div>
                  <div><strong>{rebaseReport.summary?.remapped ?? 0}</strong><span>Safely remapped</span></div>
                  <div><strong>{rebaseReport.summary?.newItems ?? 0}</strong><span>New spans</span></div>
                  <div><strong>{rebaseReport.summary?.unmatched ?? 0}</strong><span>Archived spans</span></div>
                  <div><strong>{rebaseReport.summary?.ambiguous ?? 0}</strong><span>Ambiguous</span></div>
                </div>
              </div>
            ) : null}

            {rebaseUpToDate && !rebaseApplied ? (
              <div className="rebase-message is-success" role="status">
                <strong>You are up to date.</strong> This workspace already uses the
                current linked annotations.
              </div>
            ) : null}

            {rebaseApplied ? (
              <div className="rebase-message is-success" role="status">
                <strong>Update complete.</strong> The open workspace now uses the new
                annotations; no restart is needed. Anything requiring attention is in
                the normal review queue.
                {rebaseApplied.reportPath ? (
                  <small>Audit report: {rebaseApplied.reportPath}</small>
                ) : null}
              </div>
            ) : null}

            <div className="rebase-actions">
              {rebaseApplied ? (
                <button
                  type="button"
                  className="rebase-apply-btn"
                  onClick={closeRebaseModal}
                >
                  Continue annotating
                </button>
              ) : rebaseReport ? (
                <>
                  <button
                    type="button"
                    className="history-text-btn"
                    onClick={() => void submitRebase("check")}
                    disabled={Boolean(rebaseBusy)}
                  >
                    Check again
                  </button>
                  <button
                    type="button"
                    className="rebase-apply-btn"
                    onClick={() => void submitRebase("apply")}
                    disabled={
                      !rebaseReport ||
                      Boolean(rebaseBusy) ||
                      saveState.state === "saving"
                    }
                  >
                    {rebaseBusy === "apply" ? "Updating…" : "Apply and continue"}
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="history-text-btn"
                  onClick={() => void submitRebase("check")}
                  disabled={Boolean(rebaseBusy)}
                >
                  {rebaseBusy === "check" ? "Checking…" : "Check again"}
                </button>
              )}
            </div>
          </div>
        </div>
      ) : null}

      {settingsOpen && deleteAllLabelsConfirmOpen ? (
        <div
          className="settings-confirm-backdrop"
          role="presentation"
          onClick={() => setDeleteAllLabelsConfirmOpen(false)}
        >
          <div
            className="settings-confirm-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-all-labels-title"
            onClick={(event) => event.stopPropagation()}
          >
            <h3 id="delete-all-labels-title">Delete all labels?</h3>
            <p>
              Are you sure you want to delete all labels for the entire project?
            </p>
            <div className="settings-confirm-actions">
              <button
                type="button"
                className="history-text-btn"
                onClick={() => setDeleteAllLabelsConfirmOpen(false)}
              >
                No
              </button>
              <button
                type="button"
                className="settings-danger-btn"
                onClick={() => {
                  void handleConfirmDeleteAllLabels();
                }}
              >
                Yes
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default App;
