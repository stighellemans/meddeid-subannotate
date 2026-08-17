import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { codePointLength, codePointSlice } from '../shared/unicode-offsets.js';
import { runSpanPreprocessorForItem } from './preprocessing/span-preprocessor.js';
import {
  assertProfileAcceptsLanguage,
  describeSubannotationProfile,
  neutralSubannotationProfile,
  validateSubannotationProfile,
} from './subannotation-profile.js';
import { writeEvaluationBundle } from './evaluation-bundle.js';

const SAVE_VERSION = 1;
const SAVE_ROOT_DIRNAME = 'subspan_annotations';
const IMPORTS_DIRNAME = 'imports';
const CONFIRMED_IMPORT_FILENAME = 'confirmed_subannotations.jsonl';
const CONFIRMED_IMPORT_LOCK_SOURCE = 'confirmed_import';
const METADATA_FILLER = 'N/A';

function parseJsonLines(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function docSortValue(docId) {
  const match = /(\d+)$/.exec(docId);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

function compareDocIds(a, b) {
  const aNum = docSortValue(a);
  const bNum = docSortValue(b);
  if (aNum !== bNum) return aNum - bNum;
  return a.localeCompare(b);
}

function normalizeMetadataValue(value) {
  const normalized = String(value ?? '').trim();
  return normalized || METADATA_FILLER;
}

function defaultDocumentMetadata() {
  return {
    language: null,
    patientGivenName: METADATA_FILLER,
    patientLastName: METADATA_FILLER,
    patientBirthdate: METADATA_FILLER,
    textCreationDate: METADATA_FILLER,
  };
}

function parseTextRecord(rawValue) {
  if (!rawValue || typeof rawValue !== 'object') {
    return {
      text: '',
      metadata: defaultDocumentMetadata(),
    };
  }

  const text = typeof rawValue.text === 'string' ? rawValue.text : '';

  const retiredMetadataKeys = ['patient_name', 'caregiver_names'].filter((key) =>
    Object.hasOwn(rawValue, key),
  );
  if (retiredMetadataKeys.length > 0) {
    throw new Error(
      `Retired metadata key(s) ${retiredMetadataKeys.join(', ')}; use patient and caregivers`,
    );
  }

  const patient =
    rawValue.patient && typeof rawValue.patient === 'object' ? rawValue.patient : {};
  const metadata = {
    language: String(rawValue.lang ?? rawValue.language ?? '').trim() || null,
    patientGivenName: normalizeMetadataValue(patient.given_name),
    patientLastName: normalizeMetadataValue(patient.family_name),
    patientBirthdate: normalizeMetadataValue(patient.birth_date),
    textCreationDate: normalizeMetadataValue(rawValue.document_creation_date),
  };

  return {
    text,
    metadata,
  };
}

function stableSpanId(documentId, span) {
  const payload = JSON.stringify([
    String(documentId),
    Number(span.begin),
    Number(span.end),
    String(span.label ?? ''),
  ]);
  return `span-${crypto.createHash('sha256').update(payload, 'utf8').digest('hex').slice(0, 24)}`;
}

function makeItemId(documentId, span) {
  const expected = stableSpanId(documentId, span);
  if (span.span_id != null && span.span_id !== expected) {
    throw new Error(
      `${documentId}: span_id ${JSON.stringify(span.span_id)} does not match canonical identity ${expected}`,
    );
  }
  return expected;
}

function sanitizeCategory(input) {
  return String(input ?? '').trim();
}

function mergeAdjacentSegments(segments) {
  if (segments.length === 0) return segments;
  const result = [{ ...segments[0] }];
  for (let i = 1; i < segments.length; i += 1) {
    const prev = result[result.length - 1];
    const cur = segments[i];
    if (prev.category === cur.category && prev.end >= cur.begin) {
      prev.end = Math.max(prev.end, cur.end);
      continue;
    }
    result.push({ ...cur });
  }
  return result;
}

function mergeRanges(ranges) {
  const normalized = (ranges ?? [])
    .map((range) => ({
      begin: Number(range.begin),
      end: Number(range.end),
    }))
    .filter((range) => Number.isInteger(range.begin) && Number.isInteger(range.end) && range.begin < range.end)
    .sort((a, b) => (a.begin - b.begin) || (a.end - b.end));
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

function clipSegmentToRange(segment, rangeBegin, rangeEnd) {
  const begin = Math.max(Number(segment.begin), rangeBegin);
  const end = Math.min(Number(segment.end), rangeEnd);
  if (!Number.isInteger(begin) || !Number.isInteger(end) || begin >= end) {
    return null;
  }
  return {
    begin,
    end,
    category: sanitizeCategory(segment.category),
  };
}

function overlaySegments(baseSegments, overlaySegmentsInput) {
  const overlaySegments = mergeAdjacentSegments(
    [...(overlaySegmentsInput ?? [])].sort((a, b) => (a.begin - b.begin) || (a.end - b.end)),
  );
  if (overlaySegments.length === 0) {
    return mergeAdjacentSegments(
      [...(baseSegments ?? [])]
        .map((segment) => ({ ...segment }))
        .sort((a, b) => (a.begin - b.begin) || (a.end - b.end)),
    );
  }

  let next = [...(baseSegments ?? [])]
    .map((segment) => ({ ...segment }))
    .sort((a, b) => (a.begin - b.begin) || (a.end - b.end));

  for (const overlay of overlaySegments) {
    const updated = [];
    for (const segment of next) {
      if (segment.end <= overlay.begin || segment.begin >= overlay.end) {
        updated.push(segment);
        continue;
      }
      if (segment.begin < overlay.begin) {
        updated.push({ ...segment, end: overlay.begin });
      }
      if (segment.end > overlay.end) {
        updated.push({ ...segment, begin: overlay.end });
      }
    }
    updated.push({ ...overlay });
    next = updated.sort((a, b) => (a.begin - b.begin) || (a.end - b.end));
  }

  return mergeAdjacentSegments(next);
}

function extractSegmentsWithinRanges(segments, ranges) {
  const mergedRanges = mergeRanges(ranges);
  if (mergedRanges.length === 0) return [];

  const extracted = [];
  for (const segment of segments ?? []) {
    for (const range of mergedRanges) {
      const clipped = clipSegmentToRange(segment, range.begin, range.end);
      if (clipped) {
        extracted.push(clipped);
      }
      if (range.begin >= segment.end) {
        break;
      }
    }
  }

  return mergeAdjacentSegments(
    extracted.sort((a, b) => (a.begin - b.begin) || (a.end - b.end) || a.category.localeCompare(b.category)),
  );
}

function subtractRangesFromSegments(segments, ranges) {
  const mergedRanges = mergeRanges(ranges);
  if (mergedRanges.length === 0) {
    return mergeAdjacentSegments(
      [...(segments ?? [])].map((segment) => ({ ...segment })).sort((a, b) => (a.begin - b.begin) || (a.end - b.end)),
    );
  }

  let remaining = [...(segments ?? [])]
    .map((segment) => ({ ...segment }))
    .sort((a, b) => (a.begin - b.begin) || (a.end - b.end));

  for (const range of mergedRanges) {
    const next = [];
    for (const segment of remaining) {
      if (segment.end <= range.begin || segment.begin >= range.end) {
        next.push(segment);
        continue;
      }
      if (segment.begin < range.begin) {
        next.push({ ...segment, end: range.begin });
      }
      if (segment.end > range.end) {
        next.push({ ...segment, begin: range.end });
      }
    }
    remaining = next;
  }

  return mergeAdjacentSegments(remaining);
}

function buildLockedRangesFromSegments(segments) {
  return mergeRanges((segments ?? []).map((segment) => ({ begin: segment.begin, end: segment.end })));
}

function rangesEqual(left, right) {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (a.begin !== b.begin || a.end !== b.end) {
      return false;
    }
  }
  return true;
}

function normalizeAndValidateSegments(item, segmentsInput) {
  if (!Array.isArray(segmentsInput)) {
    throw new Error('segments must be an array');
  }

  const segments = segmentsInput.map((segment) => {
    const begin = Number(segment.begin);
    const end = Number(segment.end);
    const category = sanitizeCategory(segment.category);
    if (!Number.isInteger(begin) || !Number.isInteger(end)) {
      throw new Error('segment begin/end must be integers');
    }
    if (begin >= end) {
      throw new Error('segment begin must be < end');
    }
    if (begin < item.reviewBegin || end > item.reviewEnd) {
      throw new Error('segment is outside review range');
    }
    if (!category) {
      throw new Error('segment category is required');
    }
    return { begin, end, category };
  });

  segments.sort((a, b) => (a.begin - b.begin) || (a.end - b.end));
  for (let i = 1; i < segments.length; i += 1) {
    if (segments[i].begin < segments[i - 1].end) {
      throw new Error('segments may not overlap');
    }
  }
  return mergeAdjacentSegments(segments);
}

function segmentsEqual(left, right) {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (a.begin !== b.begin || a.end !== b.end || a.category !== b.category) {
      return false;
    }
  }
  return true;
}

function computeCoverage(item, segments) {
  const total = item.reviewEnd - item.reviewBegin;
  let covered = 0;
  let cursor = item.reviewBegin;
  let complete = true;

  for (const segment of segments) {
    if (segment.begin !== cursor) {
      complete = false;
    }
    covered += segment.end - segment.begin;
    cursor = segment.end;
  }
  if (cursor !== item.reviewEnd) {
    complete = false;
  }

  return {
    totalChars: total,
    coveredChars: covered,
    uncategorizedChars: Math.max(0, total - covered),
    complete,
  };
}

function computeCoverageInRange(range, segments) {
  const total = Math.max(0, Number(range?.end ?? 0) - Number(range?.begin ?? 0));
  if (total === 0) {
    return {
      totalChars: 0,
      coveredChars: 0,
      uncategorizedChars: 0,
      complete: true,
    };
  }

  let covered = 0;
  let cursor = range.begin;
  let complete = true;

  for (const segment of segments) {
    if (segment.end <= range.begin || segment.begin >= range.end) continue;
    const clippedBegin = Math.max(range.begin, segment.begin);
    const clippedEnd = Math.min(range.end, segment.end);
    if (clippedBegin >= clippedEnd) continue;
    if (clippedBegin !== cursor) {
      complete = false;
    }
    covered += clippedEnd - clippedBegin;
    cursor = clippedEnd;
  }
  if (cursor !== range.end) {
    complete = false;
  }

  return {
    totalChars: total,
    coveredChars: covered,
    uncategorizedChars: Math.max(0, total - covered),
    complete,
  };
}

function enrichItem(item, savedEntry, { lockedRanges = [], lockSource = null } = {}) {
  const segments = savedEntry?.segments ?? [];
  const coverage = computeCoverage(item, segments);
  return {
    ...item,
    saved: savedEntry
      ? {
          status: savedEntry.status,
          segments,
          updatedAt: savedEntry.updatedAt,
          confirmedAt: savedEntry.confirmedAt ?? null,
        }
      : {
          status: 'empty',
          segments: [],
          updatedAt: null,
          confirmedAt: null,
        },
    lockedRanges: lockedRanges.map((range) => ({ begin: range.begin, end: range.end })),
    lockSource,
    coverage,
  };
}

function serializeDebugSegments(item, segments) {
  const reviewBegin = Number(item?.reviewBegin ?? 0);
  const reviewText = String(item?.reviewText ?? '');
  return (segments ?? []).map((segment) => {
    const begin = Number(segment.begin);
    const end = Number(segment.end);
    const localBegin = begin - reviewBegin;
    const localEnd = end - reviewBegin;
    const text =
      localBegin >= 0 &&
      localEnd <= codePointLength(reviewText) &&
      Number.isInteger(localBegin) &&
      Number.isInteger(localEnd) &&
      localBegin < localEnd
        ? codePointSlice(reviewText, localBegin, localEnd)
        : '';
    return {
      begin,
      end,
      localBegin,
      localEnd,
      category: String(segment.category ?? '').trim(),
      text,
    };
  });
}

function buildDocSaveItemRecord(item, savedEntry) {
  return {
    itemId: item.itemId,
    goldSpanId: item.goldSpanId,
    goldIndex: item.goldIndex,
    gold: item.gold,
    reviewRange: { begin: item.reviewBegin, end: item.reviewEnd },
    status: savedEntry.status,
    segments: savedEntry.segments,
    updatedAt: savedEntry.updatedAt,
    confirmedAt: savedEntry.confirmedAt,
  };
}

function buildSavedEntry(itemId, status, segments, existingEntry, now = new Date().toISOString()) {
  return {
    itemId,
    status,
    segments,
    updatedAt: now,
    confirmedAt: status === 'confirmed' ? (existingEntry?.confirmedAt ?? now) : null,
  };
}

function savedEntriesEqual(left, right) {
  if (!left && !right) return true;
  if (!left || !right) return false;
  if (left.status !== right.status) return false;
  return segmentsEqual(left.segments ?? [], right.segments ?? []);
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function sha256File(filePath) {
  return crypto.createHash('sha256').update(await fs.readFile(filePath)).digest('hex');
}

function validateConfirmedImportSegments(documentId, rawSegments, importPath) {
  const context = `${importPath}: ${documentId}`;
  const normalized = rawSegments
    .map((segment, index) => {
      const begin = Number(segment?.begin);
      const end = Number(segment?.end);
      const category = sanitizeCategory(segment?.category);
      if (!Number.isInteger(begin) || !Number.isInteger(end)) {
        throw new Error(`${context}: subannotation ${index} must use integer begin/end values`);
      }
      if (begin >= end) {
        throw new Error(`${context}: subannotation ${index} has invalid range [${begin}, ${end})`);
      }
      if (!category) {
        throw new Error(`${context}: subannotation ${index} is missing a category`);
      }
      return { begin, end, category };
    })
    .sort((a, b) => (a.begin - b.begin) || (a.end - b.end) || a.category.localeCompare(b.category));

  const active = [];
  for (const current of normalized) {
    for (let index = active.length - 1; index >= 0; index -= 1) {
      if (active[index].end <= current.begin) {
        active.splice(index, 1);
      }
    }
    for (const previous of active) {
      const overlapBegin = Math.max(previous.begin, current.begin);
      const overlapEnd = Math.min(previous.end, current.end);
      if (overlapBegin >= overlapEnd) continue;
      if (previous.category === current.category) continue;
      throw new Error(
        `${context}: conflicting imported categories at [${overlapBegin}, ${overlapEnd}) (${previous.category} vs ${current.category})`,
      );
    }
    active.push(current);
  }

  return mergeAdjacentSegments(normalized);
}

async function loadConfirmedImportSegments(importPath) {
  if (!(await fileExists(importPath))) {
    return {
      active: false,
      segmentsByDoc: new Map(),
    };
  }

  let rows;
  try {
    rows = parseJsonLines(await fs.readFile(importPath, 'utf8'));
  } catch (error) {
    throw new Error(
      `Failed to parse ${importPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const segmentsByDoc = new Map();
  for (const [rowIndex, row] of rows.entries()) {
    const context = `${importPath}: row ${rowIndex + 1}`;
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new Error(`${context}: expected a JSON object`);
    }

    if (Object.hasOwn(row, 'doc_id')) {
      throw new Error(
        `${context}: unsupported field "doc_id"; ` +
          'records must use document_id, text, and spans',
      );
    }
    const documentId = String(row.document_id ?? '').trim();
    if (!documentId) {
      throw new Error(`${context}: missing document_id`);
    }

    const rawSegments = row.subannotations ?? [];
    if (!Array.isArray(rawSegments)) {
      throw new Error(`${context}: expected subannotations to be a list`);
    }

    const validatedSegments = validateConfirmedImportSegments(documentId, rawSegments, importPath);
    const existingSegments = segmentsByDoc.get(documentId) ?? [];
    segmentsByDoc.set(
      documentId,
      validateConfirmedImportSegments(
        documentId,
        [...existingSegments, ...validatedSegments],
        importPath,
      ),
    );
  }

  return {
    active: true,
    segmentsByDoc,
  };
}

export async function createProjectStore({
  rootDir,
  dataDir: configuredDataDir,
  subannotationProfile = neutralSubannotationProfile,
} = {}) {
  const profile = validateSubannotationProfile(subannotationProfile);
  const profileDescriptor = describeSubannotationProfile(profile);
  const formattingCategory = profile.formattingCategory;
  const dataDir = configuredDataDir
    ? path.resolve(configuredDataDir)
    : process.env.MEDDEID_DATA_DIR
      ? path.resolve(process.env.MEDDEID_DATA_DIR)
      : path.join(rootDir, 'data');
  const inputPath = path.join(dataDir, 'annotations.jsonl');
  const sourceStatePath = path.join(dataDir, 'annotation-source-state.json');
  const outputPath = path.join(dataDir, 'subannotations.jsonl');
  const bundleDir = path.join(dataDir, 'evaluation-bundle');
  const textsCachePath = path.join(dataDir, 'dataset_texts.json');
  const goldPath = path.join(dataDir, 'gold.jsonl');
  const taxonomyPath = path.join(rootDir, 'contracts', 'taxonomy.json');
  const saveRoot = path.join(dataDir, SAVE_ROOT_DIRNAME);
  const saveDocsDir = path.join(saveRoot, 'documents');
  const categoriesPath = path.join(saveRoot, 'categories.json');
  const importRoot = path.join(saveRoot, IMPORTS_DIRNAME);
  const confirmedImportPath = path.join(importRoot, CONFIRMED_IMPORT_FILENAME);

  await ensureDir(saveDocsDir);

  if (!(await fileExists(sourceStatePath))) {
    throw new Error('Missing data/annotation-source-state.json. Run prepare:data first.');
  }
  const sourceState = JSON.parse(await fs.readFile(sourceStatePath, 'utf8'));
  if (sourceState.state_format !== 'meddeid.annotation-source-state.v1' || sourceState.status !== 'linked') {
    throw new Error('Invalid annotation source state');
  }
  if (await sha256File(inputPath) !== sourceState.hashes?.annotations_sha256) {
    throw new Error('Primary annotations no longer match the linked source state');
  }

  const importState = await loadConfirmedImportSegments(confirmedImportPath);
  let importedSegmentsByDoc = importState.segmentsByDoc;

  if (!(await fileExists(textsCachePath))) {
    throw new Error(
      `Missing data/dataset_texts.json. Run "npm run export:texts" (requires .venv with pyarrow).`,
    );
  }

  const textPayloadByDoc = new Map(
    Object.entries(JSON.parse(await fs.readFile(textsCachePath, 'utf8'))).map(
      ([documentId, rawValue]) => [documentId, parseTextRecord(rawValue)],
    ),
  );
  const taxonomy = JSON.parse(await fs.readFile(taxonomyPath, 'utf8'));
  const canonicalLabels = new Set(taxonomy.entity_labels ?? []);
  const goldRows = parseJsonLines(await fs.readFile(goldPath, 'utf8'));

  const goldByDoc = new Map();
  for (const row of goldRows) {
    const spans = [...(row.spans ?? [])].sort(
      (a, b) => (a.begin - b.begin) || (a.end - b.end),
    );
    spans.forEach((span, index) => {
      const label = String(span.label ?? '').trim();
      if (!canonicalLabels.has(label)) {
        throw new Error(
          `${row.document_id} span ${index} has unsupported label ${JSON.stringify(label)}`,
        );
      }
    });
    goldByDoc.set(row.document_id, spans);
  }

  const docs = [];
  const items = [];
  const itemsById = new Map();
  const legacyItemIds = new Map();
  for (const documentId of [...goldByDoc.keys()].sort(compareDocIds)) {
    const textPayload = textPayloadByDoc.get(documentId);
    const text = textPayload?.text;
    if (typeof text !== 'string') {
      throw new Error(`No text found in dataset_texts.json for ${documentId}`);
    }
    const documentMetadata = textPayload?.metadata ?? defaultDocumentMetadata();
    assertProfileAcceptsLanguage(profile, documentMetadata.language, documentId);

    const goldSpans = goldByDoc.get(documentId) ?? [];
    const docItemIds = [];
    goldSpans.forEach((goldSpan, goldIndex) => {
      const itemId = makeItemId(documentId, goldSpan);
      const legacyItemId = `${documentId}::${goldIndex}`;
      const review = { begin: goldSpan.begin, end: goldSpan.end };
      const reviewText = codePointSlice(text, review.begin, review.end);
      const goldSlice = codePointSlice(text, goldSpan.begin, goldSpan.end);

      const item = {
        itemId,
        goldSpanId: itemId,
        documentId,
        goldIndex,
        gold: {
          begin: goldSpan.begin,
          end: goldSpan.end,
          label: goldSpan.label ?? '',
          text: goldSpan.text ?? goldSlice,
          category: goldSpan.category ?? null,
          subtype: goldSpan.subtype ?? null,
        },
        reviewBegin: review.begin,
        reviewEnd: review.end,
        reviewText,
        goldLocalBegin: goldSpan.begin - review.begin,
        goldLocalEnd: goldSpan.end - review.begin,
        textContextBefore: codePointSlice(text, Math.max(0, review.begin - 80), review.begin),
        textContextAfter: codePointSlice(
          text,
          review.end,
          Math.min(codePointLength(text), review.end + 80),
        ),
        textLength: codePointLength(text),
        metadata: documentMetadata,
        goldTextMatchesDocument: goldSlice === (goldSpan.text ?? goldSlice),
        sortBegin: review.begin,
        sortEnd: review.end,
      };

      items.push(item);
      itemsById.set(itemId, item);
      legacyItemIds.set(legacyItemId, itemId);
      docItemIds.push(itemId);
    });

    docs.push({
      documentId,
      textLength: codePointLength(text),
      goldSpanCount: goldSpans.length,
      itemCount: docItemIds.length,
      itemIds: docItemIds,
      metadata: documentMetadata,
    });
  }

  docs.sort((a, b) => compareDocIds(a.documentId, b.documentId));
  items.sort((a, b) => {
    const docCmp = compareDocIds(a.documentId, b.documentId);
    if (docCmp !== 0) return docCmp;
    if (a.sortBegin !== b.sortBegin) return a.sortBegin - b.sortBegin;
    if (a.sortEnd !== b.sortEnd) return a.sortEnd - b.sortEnd;
    if (a.goldIndex != null && b.goldIndex != null && a.goldIndex !== b.goldIndex) {
      return a.goldIndex - b.goldIndex;
    }
    return a.itemId.localeCompare(b.itemId);
  });

  const startingCategoryGroups = Object.fromEntries(
    Object.entries(profile.categoryGroups).map(([group, groupCategories]) => [
      group,
      [...groupCategories],
    ]),
  );

  const startingCategoriesFlat = Array.from(
    new Set(
      Object.values(startingCategoryGroups)
        .flat()
        .map(sanitizeCategory)
        .filter(Boolean),
    ),
  );

  let categories = [];
  if (await fileExists(categoriesPath)) {
    try {
      const parsed = JSON.parse(await fs.readFile(categoriesPath, 'utf8'));
      if (
        parsed.subannotationProfile?.sha256 &&
        parsed.subannotationProfile.sha256 !== profileDescriptor.sha256
      ) {
        const error = new Error(
          `categories.json belongs to subannotation profile ` +
          `${parsed.subannotationProfile.profileId}@${parsed.subannotationProfile.profileVersion}, not ` +
          `${profileDescriptor.profileId}@${profileDescriptor.profileVersion}. ` +
          'Run "npm run profile -- migrate <profile>@<version>" before switching profiles.',
        );
        error.code = 'MEDDEID_SUBANNOTATION_PROFILE_MISMATCH';
        throw error;
      }
      if (
        !parsed.subannotationProfile?.sha256 &&
        Array.isArray(parsed.categories) &&
        parsed.categories.length > 0 &&
        profileDescriptor.profileId !== neutralSubannotationProfile.profileId
      ) {
        const error = new Error(
          'categories.json contains legacy categories without profile provenance. ' +
          'Run "npm run profile -- migrate <profile>@<version>" before enabling semantic rules.',
        );
        error.code = 'MEDDEID_SUBANNOTATION_PROFILE_MISMATCH';
        throw error;
      }
      if (Array.isArray(parsed.categories)) {
        categories = parsed.categories.map(sanitizeCategory).filter(Boolean);
      }
    } catch (error) {
      if (error?.code === 'MEDDEID_SUBANNOTATION_PROFILE_MISMATCH') throw error;
      categories = [];
    }
  }

  const savesByItemId = new Map();
  if (await fileExists(saveDocsDir)) {
    const saveDocFiles = (await fs.readdir(saveDocsDir)).filter((name) => name.endsWith('.json'));
    for (const filename of saveDocFiles) {
      try {
        const docSave = JSON.parse(await fs.readFile(path.join(saveDocsDir, filename), 'utf8'));
        const savedProfile = docSave.subannotationProfile;
        if (
          !savedProfile?.sha256 &&
          Object.keys(docSave.items ?? {}).length > 0 &&
          profileDescriptor.profileId !== neutralSubannotationProfile.profileId
        ) {
          const error = new Error(
            `${filename} contains legacy review work without language-profile provenance. ` +
              `It can only be opened with neutral@1; use a separate MEDDEID_DATA_DIR or run ` +
              '"npm run profile -- migrate <profile>@<version>" before enabling semantic rules.',
          );
          error.code = 'MEDDEID_SUBANNOTATION_PROFILE_MISMATCH';
          throw error;
        }
        if (savedProfile?.sha256 && savedProfile.sha256 !== profileDescriptor.sha256) {
          const error = new Error(
            `${filename} belongs to subannotation profile ` +
              `${savedProfile.profileId}@${savedProfile.profileVersion}, not ` +
              `${profileDescriptor.profileId}@${profileDescriptor.profileVersion}. ` +
              'Use a separate MEDDEID_DATA_DIR or run ' +
              '"npm run profile -- migrate <profile>@<version>" to archive and reset the saved review work.',
          );
          error.code = 'MEDDEID_SUBANNOTATION_PROFILE_MISMATCH';
          throw error;
        }
        const savedPrimaryHash = String(docSave.primaryGold?.annotationsSha256 ?? '').trim();
        if (
          savedPrimaryHash &&
          savedPrimaryHash !== sourceState.hashes?.annotations_sha256
        ) {
          const error = new Error(
            `${filename} belongs to a different primary annotation source. ` +
              'Run "npm run rebase -- --annotations /path/to/annotations.jsonl --write".',
          );
          error.code = 'MEDDEID_REBASE_REQUIRED';
          throw error;
        }
        const entries = docSave.items ?? {};
        for (const [storedItemId, entry] of Object.entries(entries)) {
          const itemId = legacyItemIds.get(storedItemId) ?? storedItemId;
          if (!itemsById.has(itemId)) continue;
          const item = itemsById.get(itemId);
          let segments = [];
          try {
            segments = normalizeAndValidateSegments(item, entry.segments ?? []);
          } catch {
            continue;
          }
          const status = entry.status === 'confirmed' ? 'confirmed' : 'in_progress';
          savesByItemId.set(itemId, {
            itemId,
            status,
            segments,
            updatedAt: entry.updatedAt ?? null,
            confirmedAt: entry.confirmedAt ?? null,
          });
          for (const segment of segments) {
            if (!categories.includes(segment.category)) {
              categories.push(segment.category);
            }
          }
        }
      } catch (error) {
        if (
          error?.code === 'MEDDEID_REBASE_REQUIRED' ||
          error?.code === 'MEDDEID_SUBANNOTATION_PROFILE_MISMATCH'
        ) throw error;
        // Ignore invalid save files so the app still opens.
      }
    }
  }

  for (const category of startingCategoriesFlat) {
    if (!categories.includes(category)) {
      categories.push(category);
    }
  }

  for (const docSegments of importedSegmentsByDoc.values()) {
    for (const segment of docSegments) {
      if (!categories.includes(segment.category)) {
        categories.push(segment.category);
      }
    }
  }

  categories = Array.from(new Set(categories)).sort((a, b) => a.localeCompare(b));

  async function persistCategories() {
    const payload = {
      version: SAVE_VERSION,
      updatedAt: new Date().toISOString(),
      subannotationProfile: profileDescriptor,
      categories: categories.slice().sort((a, b) => a.localeCompare(b)),
    };
    await fs.writeFile(categoriesPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  }

  function countCategoryUsage(category) {
    let uses = 0;
    for (const saved of savesByItemId.values()) {
      for (const segment of saved.segments ?? []) {
        if (segment.category === category) {
          uses += 1;
        }
      }
    }
    return uses;
  }

  function ensureCategoriesFromSegments(segments) {
    let changed = false;
    for (const segment of segments ?? []) {
      if (!categories.includes(segment.category)) {
        categories.push(segment.category);
        changed = true;
      }
    }
    if (changed) {
      categories = Array.from(new Set(categories)).sort((a, b) => a.localeCompare(b));
    }
    return changed;
  }

  function getImportedSegmentsForItem(item) {
    if (!importState.active) return [];
    const docSegments = importedSegmentsByDoc.get(item.documentId) ?? [];
    if (docSegments.length === 0) return [];

    const clippedSegments = [];
    for (const segment of docSegments) {
      const clipped = clipSegmentToRange(segment, item.reviewBegin, item.reviewEnd);
      if (clipped) {
        clippedSegments.push(clipped);
      }
    }

    return mergeAdjacentSegments(
      clippedSegments.sort(
        (a, b) => (a.begin - b.begin) || (a.end - b.end) || a.category.localeCompare(b.category),
      ),
    );
  }

  function getItemLockInfo(item) {
    const importedSegments = getImportedSegmentsForItem(item);
    return {
      importedSegments,
      lockedRanges: buildLockedRangesFromSegments(importedSegments),
      lockSource: importedSegments.length > 0 ? CONFIRMED_IMPORT_LOCK_SOURCE : null,
    };
  }

  function buildEntryFromBaseSegments({ item, baseSegments, fallbackStatus = 'in_progress', existingEntry }) {
    const normalizedBaseSegments = mergeAdjacentSegments(
      [...(baseSegments ?? [])]
        .map((segment) => ({ ...segment }))
        .sort((a, b) => (a.begin - b.begin) || (a.end - b.end) || a.category.localeCompare(b.category)),
    );
    const { importedSegments } = getItemLockInfo(item);
    if (importedSegments.length === 0) {
      if (normalizedBaseSegments.length === 0) return null;
      return buildSavedEntry(item.itemId, fallbackStatus, normalizedBaseSegments, existingEntry);
    }

    const recoveredSegments = overlaySegments(normalizedBaseSegments, importedSegments);
    const importedCoverage = computeCoverage(item, importedSegments);
    return buildSavedEntry(
      item.itemId,
      importedCoverage.complete ? 'confirmed' : 'in_progress',
      recoveredSegments,
      existingEntry,
    );
  }

  function applyEntryToStore(item, nextEntry) {
    if (nextEntry) {
      savesByItemId.set(item.itemId, nextEntry);
    } else {
      savesByItemId.delete(item.itemId);
    }
  }

  function recordDocChange(changedEntriesByDoc, item, savedEntry) {
    const existingDocChanges = changedEntriesByDoc.get(item.documentId) ?? [];
    existingDocChanges.push({ item, savedEntry });
    changedEntriesByDoc.set(item.documentId, existingDocChanges);
  }

  async function persistDocChanges(changedEntriesByDoc) {
    const now = new Date().toISOString();
    for (const [documentId, docChanges] of changedEntriesByDoc.entries()) {
      const docSave = await readDocSaveFile(documentId);
      docSave.updatedAt = now;
      for (const change of docChanges) {
        if (change.savedEntry) {
          docSave.items[change.item.itemId] = buildDocSaveItemRecord(change.item, change.savedEntry);
        } else {
          delete docSave.items[change.item.itemId];
        }
      }
      await writeDocSaveFile(documentId, docSave);
    }
    await persistCombinedOutput();
  }

  async function persistCombinedOutput() {
    const rows = docs
      .map((doc) => ({
        document_id: doc.documentId,
        primary_gold: {
          annotations_sha256: sourceState.hashes.annotations_sha256,
        },
        items: doc.itemIds
          .map((itemId) => {
            const item = itemsById.get(itemId);
            const saved = savesByItemId.get(itemId);
            if (!item || !saved) return null;
            return {
              item_id: itemId,
              gold_span_id: item.goldSpanId,
              gold_index: item.goldIndex,
              status: saved.status,
              segments: saved.segments.map((segment) => ({
                begin: segment.begin,
                end: segment.end,
                category: segment.category,
              })),
              updated_at: saved.updatedAt,
              confirmed_at: saved.confirmedAt,
            };
          })
          .filter(Boolean),
      }))
      .filter((row) => row.items.length > 0);
    const payload = rows.map((row) => JSON.stringify(row)).join('\n');
    const temporaryPath = `${outputPath}.${process.pid}.tmp`;
    await fs.writeFile(temporaryPath, payload ? `${payload}\n` : '', 'utf8');
    await fs.rename(temporaryPath, outputPath);
  }

  async function persistConfirmedImportFile() {
    if (!importState.active) return;
    await ensureDir(importRoot);
    const rows = Array.from(importedSegmentsByDoc.entries())
      .sort((a, b) => compareDocIds(a[0], b[0]))
      .map(([documentId, segments]) => ({
        document_id: documentId,
        subannotations: mergeAdjacentSegments(
          [...segments].sort(
            (a, b) => (a.begin - b.begin) || (a.end - b.end) || a.category.localeCompare(b.category),
          ),
        ).map((segment) => ({
          begin: segment.begin,
          end: segment.end,
          category: segment.category,
        })),
      }));
    const payload = rows.map((row) => JSON.stringify(row)).join('\n');
    await fs.writeFile(
      confirmedImportPath,
      payload.length > 0 ? `${payload}\n` : '',
      'utf8',
    );
  }

  function getSeedCategoryForAnnotation(annotation) {
    const annotationCategory = String(annotation?.category ?? '').trim();
    return profile.seedCategories[annotationCategory] ?? null;
  }

  function clipAnnotationRangeToItem(item, annotation) {
    const begin = Number(annotation?.begin);
    const end = Number(annotation?.end);
    if (!Number.isInteger(begin) || !Number.isInteger(end)) return null;
    const clippedBegin = Math.max(item.reviewBegin, begin);
    const clippedEnd = Math.min(item.reviewEnd, end);
    if (clippedBegin >= clippedEnd) return null;
    return {
      begin: clippedBegin,
      end: clippedEnd,
    };
  }

  function splitSeedSegmentAroundBlocker(segment, blocker) {
    if (segment.end <= blocker.begin || segment.begin >= blocker.end) {
      return [segment];
    }

    const pieces = [];
    if (segment.begin < blocker.begin) {
      pieces.push({
        begin: segment.begin,
        end: blocker.begin,
        category: segment.category,
      });
    }
    if (segment.end > blocker.end) {
      pieces.push({
        begin: blocker.end,
        end: segment.end,
        category: segment.category,
      });
    }
    return pieces;
  }

  function buildSeedPreprocessorInputSegments(item) {
    const rawSeedSpecs = [];
    const seenKeys = new Set();
    const primarySeedCategory = item?.gold
      ? getSeedCategoryForAnnotation(item.gold)
      : null;

    function addSeedSpec(annotation, priority) {
      const category = getSeedCategoryForAnnotation(annotation);
      if (!category) return;
      const clippedRange = clipAnnotationRangeToItem(item, annotation);
      if (!clippedRange) return;
      const key = `${clippedRange.begin}:${clippedRange.end}:${category}:${priority}`;
      if (seenKeys.has(key)) return;
      seenKeys.add(key);
      rawSeedSpecs.push({
        begin: clippedRange.begin,
        end: clippedRange.end,
        category,
        priority,
      });
    }

    if (item.gold) {
      addSeedSpec(item.gold, 10);
    }
    rawSeedSpecs.sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      const aMatchesPrimary = a.category === primarySeedCategory;
      const bMatchesPrimary = b.category === primarySeedCategory;
      if (aMatchesPrimary !== bMatchesPrimary) {
        return aMatchesPrimary ? -1 : 1;
      }
      const spanA = a.end - a.begin;
      const spanB = b.end - b.begin;
      // Prefer broader spans so the preprocessor can use surrounding context
      // instead of letting a narrow false-positive override the whole phrase.
      if (spanA !== spanB) return spanB - spanA;
      if (a.begin !== b.begin) return a.begin - b.begin;
      if (a.end !== b.end) return a.end - b.end;
      return a.category.localeCompare(b.category);
    });

    const selectedSegments = [];
    for (const seedSpec of rawSeedSpecs) {
      let remainingPieces = [
        {
          begin: seedSpec.begin,
          end: seedSpec.end,
          category: seedSpec.category,
        },
      ];

      for (const blocker of selectedSegments) {
        remainingPieces = remainingPieces.flatMap((piece) =>
          splitSeedSegmentAroundBlocker(piece, blocker),
        );
        if (remainingPieces.length === 0) break;
      }

      selectedSegments.push(...remainingPieces);
      selectedSegments.sort((a, b) => (a.begin - b.begin) || (a.end - b.end));
    }

    return mergeAdjacentSegments(selectedSegments);
  }

  function getPrimaryPreprocessorSeedRange(item) {
    if (item?.gold) {
      const clippedRange = clipAnnotationRangeToItem(item, item.gold);
      if (clippedRange) return clippedRange;
    }
    if (
      Number.isInteger(item?.reviewBegin) &&
      Number.isInteger(item?.reviewEnd) &&
      item.reviewBegin < item.reviewEnd
    ) {
      return {
        begin: item.reviewBegin,
        end: item.reviewEnd,
      };
    }
    return null;
  }

  function scoreSegmentsCoverage(item, segments) {
    return computeCoverage(item, segments).coveredChars;
  }

  function scoreSegmentsCoverageInRange(range, segments) {
    return computeCoverageInRange(range, segments).coveredChars;
  }

  function scoreNonFormattingCoverage(segments) {
    return segments.reduce((covered, segment) => {
      if (segment.category === formattingCategory) return covered;
      return covered + (segment.end - segment.begin);
    }, 0);
  }

  function scoreNonFormattingCoverageInRange(range, segments) {
    if (!range) return 0;
    return segments.reduce((covered, segment) => {
      if (segment.category === formattingCategory) return covered;
      const clippedBegin = Math.max(range.begin, segment.begin);
      const clippedEnd = Math.min(range.end, segment.end);
      if (clippedBegin >= clippedEnd) return covered;
      return covered + (clippedEnd - clippedBegin);
    }, 0);
  }

  function buildAutodetectPreprocessorInputSpecs(item) {
    const primaryRange = getPrimaryPreprocessorSeedRange(item);
    if (!primaryRange) return [];

    return profile.autodetectCategories.map((category, index) => ({
      source: `autodetect:${category}`,
      sourceRank: 2,
      sourceOrder: index,
      inputSegments: [
        {
          begin: primaryRange.begin,
          end: primaryRange.end,
          category,
        },
      ],
    }));
  }

  function buildPreprocessorOutcomeCandidates({
    item,
    savedEntry,
    ignoreExistingSegments = false,
    includeTrace = false,
  }) {
    const existingSegments = savedEntry?.segments ?? [];
    const candidates = [];
    const primaryRange = getPrimaryPreprocessorSeedRange(item);

    function buildCandidateScoreFields(outcome) {
      return {
        primaryCoverage: primaryRange
          ? scoreSegmentsCoverageInRange(primaryRange, outcome.segments)
          : scoreSegmentsCoverage(item, outcome.segments),
        primaryNonFormattingCoverage: primaryRange
          ? scoreNonFormattingCoverageInRange(primaryRange, outcome.segments)
          : scoreNonFormattingCoverage(outcome.segments),
        coverage: scoreSegmentsCoverage(item, outcome.segments),
        nonFormattingCoverage: scoreNonFormattingCoverage(outcome.segments),
      };
    }

    function addCandidate({ source, sourceRank, sourceOrder, inputSegments }) {
      const normalizedInputSegments = (inputSegments ?? []).map((segment) => ({
        begin: segment.begin,
        end: segment.end,
        category: segment.category,
      }));
      const outcome = runSpanPreprocessorForItem({
        item,
        segments: normalizedInputSegments,
        profile,
        includeTrace,
      });
      candidates.push({
        source,
        sourceRank,
        sourceOrder,
        inputSegments: normalizedInputSegments,
        outcome,
        ...buildCandidateScoreFields(outcome),
      });
    }

    if (!ignoreExistingSegments) {
      addCandidate({
        source: 'existing',
        sourceRank: 0,
        sourceOrder: 0,
        inputSegments: existingSegments,
      });
    }

    const seedSegments = buildSeedPreprocessorInputSegments(item);
    if (
      seedSegments.length > 0 &&
      (ignoreExistingSegments || !segmentsEqual(seedSegments, existingSegments))
    ) {
      addCandidate({
        source: 'annotation_seed',
        sourceRank: 1,
        sourceOrder: 0,
        inputSegments: seedSegments,
      });
    }

    for (const autodetectSpec of buildAutodetectPreprocessorInputSpecs(item)) {
      addCandidate(autodetectSpec);
    }

    candidates.sort((a, b) => {
      if (b.primaryCoverage !== a.primaryCoverage) {
        return b.primaryCoverage - a.primaryCoverage;
      }
      // When two interpretations cover the primary range equally, trust the more
      // authoritative source (existing edits → gold/annotation seed → autodetect)
      // before falling back to coverage heuristics. The non-formatting-coverage
      // tiebreaker is only meant to choose among the equally-ranked autodetect
      // sweep; without this an explicit gold category (e.g. Contactdetails on an
      // email) can be silently overridden by a greedy autodetect category such as
      // id_identifier, which swallows an email's "@" and TLD as identifier content
      // and so scores higher on non-formatting coverage than the correct split.
      if (a.sourceRank !== b.sourceRank) return a.sourceRank - b.sourceRank;
      if (b.primaryNonFormattingCoverage !== a.primaryNonFormattingCoverage) {
        return b.primaryNonFormattingCoverage - a.primaryNonFormattingCoverage;
      }
      if (b.coverage !== a.coverage) return b.coverage - a.coverage;
      if (b.nonFormattingCoverage !== a.nonFormattingCoverage) {
        return b.nonFormattingCoverage - a.nonFormattingCoverage;
      }
      if (a.sourceOrder !== b.sourceOrder) return a.sourceOrder - b.sourceOrder;
      return a.source.localeCompare(b.source);
    });

    return candidates;
  }

  function pickBestPreprocessorOutcome({
    item,
    savedEntry,
    ignoreExistingSegments = false,
  }) {
    const candidates = buildPreprocessorOutcomeCandidates({
      item,
      savedEntry,
      ignoreExistingSegments,
    });
    return candidates[0];
  }

  async function runPreprocessorAcrossOpenItems({
    persistCategoriesFile,
    resetOpenItems = false,
  }) {
    const changedEntriesByDoc = new Map();
    const ruleHits = {};
    let processedItems = 0;
    let changedItems = 0;
    let categoriesChanged = false;

    function ensureCategory(category) {
      if (categories.includes(category)) return;
      categories.push(category);
      categoriesChanged = true;
    }

    for (const item of items) {
      const itemId = item.itemId;
      const savedEntry = savesByItemId.get(itemId) ?? null;
      if (savedEntry?.status === 'confirmed') {
        continue;
      }
      processedItems += 1;
      const selected = pickBestPreprocessorOutcome({
        item,
        savedEntry,
        ignoreExistingSegments: resetOpenItems,
      });
      const outcome = selected.outcome;

      for (const [ruleId, count] of Object.entries(outcome.ruleHits)) {
        ruleHits[ruleId] = (ruleHits[ruleId] ?? 0) + count;
      }

      const nextEntry = buildEntryFromBaseSegments({
        item,
        baseSegments: outcome.segments,
        fallbackStatus: 'in_progress',
        existingEntry: savedEntry,
      });
      if (savedEntriesEqual(savedEntry, nextEntry)) {
        continue;
      }

      changedItems += 1;
      applyEntryToStore(item, nextEntry);
      recordDocChange(changedEntriesByDoc, item, nextEntry);

      for (const segment of nextEntry?.segments ?? []) {
        ensureCategory(segment.category);
      }
    }

    await persistDocChanges(changedEntriesByDoc);

    if (categoriesChanged) {
      categories = Array.from(new Set(categories)).sort((a, b) => a.localeCompare(b));
      if (persistCategoriesFile) {
        await persistCategories();
      }
    }

    return {
      processedItems,
      changedItems,
      changedDocuments: changedEntriesByDoc.size,
      ruleHits,
    };
  }

  await runPreprocessorAcrossOpenItems({ persistCategoriesFile: false });

  async function applyConfirmedImportRecoveryAcrossItems({
    itemIds = null,
    persistCategoriesFile = false,
  } = {}) {
    if (!importState.active) {
      return {
        changedItems: 0,
        changedDocuments: 0,
      };
    }

    const changedEntriesByDoc = new Map();
    let changedItems = 0;
    let categoriesChanged = false;
    const targetItems = itemIds
      ? itemIds.map((itemId) => itemsById.get(itemId)).filter(Boolean)
      : items;

    for (const item of targetItems) {
      const { importedSegments } = getItemLockInfo(item);
      if (importedSegments.length === 0) continue;

      const savedEntry = savesByItemId.get(item.itemId) ?? null;
      const nextEntry = buildEntryFromBaseSegments({
        item,
        baseSegments: savedEntry?.segments ?? [],
        fallbackStatus: savedEntry?.status === 'confirmed' ? 'confirmed' : 'in_progress',
        existingEntry: savedEntry,
      });
      if (savedEntriesEqual(savedEntry, nextEntry)) {
        continue;
      }

      changedItems += 1;
      applyEntryToStore(item, nextEntry);
      recordDocChange(changedEntriesByDoc, item, nextEntry);
      if (ensureCategoriesFromSegments(nextEntry?.segments ?? [])) {
        categoriesChanged = true;
      }
    }

    await persistDocChanges(changedEntriesByDoc);
    if (categoriesChanged && persistCategoriesFile) {
      await persistCategories();
    }

    return {
      changedItems,
      changedDocuments: changedEntriesByDoc.size,
    };
  }

  await applyConfirmedImportRecoveryAcrossItems();

  function computeProgress() {
    let confirmedItems = 0;
    let startedItems = 0;
    const confirmedByDoc = new Map();
    const startedByDoc = new Map();

    for (const doc of docs) {
      confirmedByDoc.set(doc.documentId, 0);
      startedByDoc.set(doc.documentId, 0);
    }

    for (const item of items) {
      const saved = savesByItemId.get(item.itemId);
      if (!saved) continue;
      startedItems += 1;
      startedByDoc.set(item.documentId, (startedByDoc.get(item.documentId) ?? 0) + 1);
      if (saved.status === 'confirmed') {
        confirmedItems += 1;
        confirmedByDoc.set(item.documentId, (confirmedByDoc.get(item.documentId) ?? 0) + 1);
      }
    }

    let confirmedTexts = 0;
    const docsProgress = docs.map((doc) => {
      const startedDocItems = startedByDoc.get(doc.documentId) ?? 0;
      const confirmedDocItems = confirmedByDoc.get(doc.documentId) ?? 0;

      let startedGoldSpans = 0;
      let confirmedGoldSpans = 0;
      for (const itemId of doc.itemIds) {
        const saved = savesByItemId.get(itemId);
        const isStarted = Boolean(saved);
        const isConfirmed = saved?.status === 'confirmed';
        if (isStarted) startedGoldSpans += 1;
        if (isConfirmed) confirmedGoldSpans += 1;
      }

      const allConfirmed = doc.itemCount > 0 && confirmedDocItems === doc.itemCount;
      if (allConfirmed) confirmedTexts += 1;
      return {
        documentId: doc.documentId,
        itemCount: doc.itemCount,
        startedItems: startedDocItems,
        confirmedItems: confirmedDocItems,
        goldSpanCount: doc.goldSpanCount,
        startedGoldSpans,
        confirmedGoldSpans,
        allConfirmed,
      };
    });

    return {
      spans: {
        total: items.length,
        started: startedItems,
        confirmed: confirmedItems,
      },
      texts: {
        total: docs.length,
        confirmed: confirmedTexts,
      },
      docs: docsProgress,
    };
  }

  function buildBootstrap() {
    const progress = computeProgress();
    const enrichedItems = items.map((item) =>
      enrichItem(item, savesByItemId.get(item.itemId), getItemLockInfo(item)),
    );
    return {
      meta: {
        attachGapMax: null,
        saveRoot: path.relative(rootDir, outputPath),
        internalSaveRoot: path.relative(rootDir, saveRoot),
        generatedAt: new Date().toISOString(),
        importMode: {
          active: importState.active,
          path: importState.active ? path.relative(rootDir, confirmedImportPath) : null,
        },
        annotationSource: {
          annotationsSha256: sourceState.hashes.annotations_sha256,
        },
        subannotationProfile: profileDescriptor,
      },
      progress,
      documents: docs.map((doc) => ({
        documentId: doc.documentId,
        text: textPayloadByDoc.get(doc.documentId)?.text ?? '',
        patientGivenName: doc.metadata.patientGivenName,
        patientLastName: doc.metadata.patientLastName,
        patientBirthdate: doc.metadata.patientBirthdate,
        textCreationDate: doc.metadata.textCreationDate,
        language: doc.metadata.language,
      })),
      startingCategories: Object.fromEntries(
        Object.entries(startingCategoryGroups).map(([group, groupCategories]) => [
          group,
          [...groupCategories],
        ]),
      ),
      categories: categories.slice().sort((a, b) => a.localeCompare(b)),
      items: enrichedItems,
    };
  }

  async function readDocSaveFile(documentId) {
    const filePath = path.join(saveDocsDir, `${documentId}.json`);
    if (!(await fileExists(filePath))) {
      return {
        version: SAVE_VERSION,
        document_id: documentId,
        primaryGold: {
          annotationsSha256: sourceState.hashes.annotations_sha256,
        },
        subannotationProfile: profileDescriptor,
        updatedAt: null,
        items: {},
      };
    }
    try {
      const parsed = JSON.parse(await fs.readFile(filePath, 'utf8'));
      if (!parsed || typeof parsed !== 'object') {
        throw new Error('invalid');
      }
      return {
        version: SAVE_VERSION,
        document_id: documentId,
        primaryGold: {
          annotationsSha256: sourceState.hashes.annotations_sha256,
        },
        subannotationProfile: profileDescriptor,
        updatedAt: parsed.updatedAt ?? null,
        items: parsed.items ?? {},
        ...(parsed.orphanedItems ? { orphanedItems: parsed.orphanedItems } : {}),
      };
    } catch {
      return {
        version: SAVE_VERSION,
        document_id: documentId,
        primaryGold: {
          annotationsSha256: sourceState.hashes.annotations_sha256,
        },
        subannotationProfile: profileDescriptor,
        updatedAt: null,
        items: {},
      };
    }
  }

  async function writeDocSaveFile(documentId, docSave) {
    const filePath = path.join(saveDocsDir, `${documentId}.json`);
    await fs.writeFile(filePath, `${JSON.stringify(docSave, null, 2)}\n`, 'utf8');
  }

  function segmentsRespectLockedRanges(segments, importedSegments) {
    if ((importedSegments ?? []).length === 0) return true;
    const lockedRanges = buildLockedRangesFromSegments(importedSegments);
    return segmentsEqual(extractSegmentsWithinRanges(segments, lockedRanges), importedSegments);
  }

  async function updateConfirmedImportSegmentsForItem(item, previousImportedSegments, nextSegments) {
    if (!importState.active || previousImportedSegments.length === 0) {
      return false;
    }

    const lockedRanges = buildLockedRangesFromSegments(previousImportedSegments);
    const currentDocSegments = importedSegmentsByDoc.get(item.documentId) ?? [];
    const remainingDocSegments = subtractRangesFromSegments(currentDocSegments, lockedRanges);
    const replacementSegments = extractSegmentsWithinRanges(nextSegments, lockedRanges);
    const nextDocSegments = mergeAdjacentSegments(
      [...remainingDocSegments, ...replacementSegments].sort(
        (a, b) => (a.begin - b.begin) || (a.end - b.end) || a.category.localeCompare(b.category),
      ),
    );
    if (segmentsEqual(currentDocSegments, nextDocSegments)) {
      return false;
    }

    importedSegmentsByDoc.set(item.documentId, nextDocSegments);
    ensureCategoriesFromSegments(nextDocSegments);
    await persistConfirmedImportFile();
    return true;
  }

  async function saveItem({ itemId, segments: segmentsInput, status, lockBypass = false }) {
    const resolvedItemId = legacyItemIds.get(itemId) ?? itemId;
    const item = itemsById.get(resolvedItemId);
    if (!item) {
      const error = new Error(`Unknown itemId: ${itemId}`);
      error.statusCode = 404;
      throw error;
    }

    const normalizedStatus = status === 'confirmed' ? 'confirmed' : 'in_progress';
    let segments;
    try {
      segments = normalizeAndValidateSegments(item, segmentsInput ?? []);
    } catch (err) {
      const error = new Error(err.message);
      error.statusCode = 400;
      throw error;
    }

    const coverage = computeCoverage(item, segments);
    if (normalizedStatus === 'confirmed' && !coverage.complete) {
      const error = new Error('Cannot confirm: not all characters in the review span are categorized');
      error.statusCode = 400;
      throw error;
    }

    const existing = savesByItemId.get(resolvedItemId);
    const { importedSegments: previousImportedSegments } = getItemLockInfo(item);
    if (!lockBypass && !segmentsRespectLockedRanges(segments, previousImportedSegments)) {
      const error = new Error('Cannot modify imported confirmed ranges without holding Shift');
      error.statusCode = 400;
      throw error;
    }

    if (lockBypass) {
      await updateConfirmedImportSegmentsForItem(item, previousImportedSegments, segments);
    }

    const nextEntry = buildSavedEntry(resolvedItemId, normalizedStatus, segments, existing);

    const docSave = await readDocSaveFile(item.documentId);
    docSave.updatedAt = nextEntry.updatedAt;
    docSave.items[resolvedItemId] = buildDocSaveItemRecord(item, nextEntry);
    await writeDocSaveFile(item.documentId, docSave);

    savesByItemId.set(resolvedItemId, nextEntry);
    const categoriesChanged = ensureCategoriesFromSegments(segments);
    if (categoriesChanged) {
      await persistCategories();
    }
    await persistCombinedOutput();

    return {
      item: enrichItem(item, nextEntry, getItemLockInfo(item)),
      progress: computeProgress(),
      categories: categories.slice().sort((a, b) => a.localeCompare(b)),
    };
  }

  async function deleteCategory(categoryInput) {
    const category = sanitizeCategory(categoryInput);
    if (!category) {
      const error = new Error('Category is required');
      error.statusCode = 400;
      throw error;
    }

    const usageCount = countCategoryUsage(category);
    if (usageCount > 0) {
      const error = new Error(
        `Cannot delete category "${category}" because it is used in ${usageCount} saved segment${usageCount === 1 ? '' : 's'}.`,
      );
      error.statusCode = 400;
      throw error;
    }

    if (!categories.includes(category)) {
      const error = new Error(`Category "${category}" not found`);
      error.statusCode = 404;
      throw error;
    }

    categories = categories.filter((c) => c !== category).sort((a, b) => a.localeCompare(b));
    await persistCategories();

    return {
      categories: categories.slice(),
    };
  }

  async function clearAllLabels() {
    const clearedItems = savesByItemId.size;
    savesByItemId.clear();

    const now = new Date().toISOString();
    let clearedDocuments = 0;
    if (await fileExists(saveDocsDir)) {
      const saveDocFiles = (await fs.readdir(saveDocsDir)).filter((name) => name.endsWith('.json'));
      for (const filename of saveDocFiles) {
        const documentId = path.basename(filename, '.json');
        const docSave = await readDocSaveFile(documentId);
        docSave.updatedAt = now;
        docSave.items = {};
        await writeDocSaveFile(documentId, docSave);
        clearedDocuments += 1;
      }
    }

    const importRecoveryStats = await applyConfirmedImportRecoveryAcrossItems();
    await persistCombinedOutput();

    return {
      stats: {
        clearedItems,
        clearedDocuments,
        recoveredImportedItems: importRecoveryStats.changedItems,
      },
      bootstrap: buildBootstrap(),
    };
  }

  async function rerunPreprocessing() {
    const stats = await runPreprocessorAcrossOpenItems({
      persistCategoriesFile: true,
      resetOpenItems: true,
    });
    return {
      stats,
      bootstrap: buildBootstrap(),
    };
  }

  async function getItemPreprocessingDebug(itemId) {
    const normalizedItemId = String(itemId ?? '').trim();
    const resolvedItemId = legacyItemIds.get(normalizedItemId) ?? normalizedItemId;
    const item = itemsById.get(resolvedItemId);
    if (!item) {
      const error = new Error(`Unknown itemId: ${itemId}`);
      error.statusCode = 404;
      throw error;
    }

    const savedEntry = savesByItemId.get(item.itemId) ?? null;
    const seedSegments = buildSeedPreprocessorInputSegments(item);
    const candidates = buildPreprocessorOutcomeCandidates({
      item,
      savedEntry,
      includeTrace: true,
    });

    return {
      item: {
        itemId: item.itemId,
        documentId: item.documentId,
        reviewRange: {
          begin: item.reviewBegin,
          end: item.reviewEnd,
        },
        reviewText: item.reviewText,
        textContextBefore: item.textContextBefore ?? '',
        textContextAfter: item.textContextAfter ?? '',
        gold: item.gold ?? null,
        primarySeedRange: getPrimaryPreprocessorSeedRange(item),
      },
      saved: {
        status: savedEntry?.status ?? 'empty',
        segments: serializeDebugSegments(item, savedEntry?.segments ?? []),
      },
      seedSegments: serializeDebugSegments(item, seedSegments),
      candidates: candidates.map((candidate, index) => ({
        source: candidate.source,
        sourceRank: candidate.sourceRank,
        sourceOrder: candidate.sourceOrder,
        selected: index === 0,
        inputSegments: serializeDebugSegments(item, candidate.inputSegments),
        score: {
          primaryCoverage: candidate.primaryCoverage,
          primaryNonFormattingCoverage: candidate.primaryNonFormattingCoverage,
          coverage: candidate.coverage,
          nonFormattingCoverage: candidate.nonFormattingCoverage,
        },
        outcome: {
          changed: candidate.outcome.changed,
          ruleHits: candidate.outcome.ruleHits,
          segments: serializeDebugSegments(item, candidate.outcome.segments),
          ruleTrace: (candidate.outcome.ruleTrace ?? []).map((entry) => ({
            phase: entry.phase,
            ruleId: entry.ruleId,
            hitCount: entry.hitCount,
            changed: entry.changed,
            beforeSegments: entry.beforeSegments,
            afterSegments: entry.afterSegments,
          })),
        },
      })),
    };
  }

  async function exportEvaluationBundle() {
    return writeEvaluationBundle({
      outputDir: bundleDir,
      inputPath,
      sourceStatePath,
      subannotationsPath: outputPath,
      items,
      savesByItemId,
      subannotationProfile: profileDescriptor,
    });
  }

  return {
    getBootstrap: async () => buildBootstrap(),
    saveItem,
    deleteCategory,
    clearAllLabels,
    rerunPreprocessing,
    getItemPreprocessingDebug,
    exportEvaluationBundle,
  };
}
