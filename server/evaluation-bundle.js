import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { codePointSlice } from '../shared/unicode-offsets.js';

const BENCHMARK_FILENAME = 'benchmark.jsonl';

function parseJsonLines(text) {
  return String(text ?? '').split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line));
}

async function sha256(filePath) {
  return crypto.createHash('sha256').update(await fs.readFile(filePath)).digest('hex');
}

function hasCompleteCoverage(item, segments) {
  let cursor = item.reviewBegin;
  for (const segment of segments) {
    if (segment.begin !== cursor || segment.end <= segment.begin) return false;
    cursor = segment.end;
  }
  return cursor === item.reviewEnd;
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

export async function writeEvaluationBundle({
  outputDir,
  inputPath,
  sourceStatePath,
  subannotationsPath,
  items,
  savesByItemId,
  subannotationProfile,
}) {
  const incomplete = items.filter((item) => {
    const saved = savesByItemId.get(item.itemId);
    return saved?.status !== 'confirmed' || !hasCompleteCoverage(item, saved.segments);
  });
  if (incomplete.length > 0) {
    const examples = incomplete.slice(0, 5).map((item) => item.itemId).join(', ');
    const error = new Error(
      `Cannot export: ${incomplete.length} gold span(s) are not confirmed with complete coverage` +
        (examples ? ` (${examples})` : ''),
    );
    error.statusCode = 400;
    throw error;
  }

  const sourceRows = parseJsonLines(await fs.readFile(inputPath, 'utf8'));
  const itemsByDocument = new Map();
  for (const item of items) {
    const documentItems = itemsByDocument.get(item.documentId) ?? new Map();
    documentItems.set(item.goldSpanId, item);
    itemsByDocument.set(item.documentId, documentItems);
  }
  const benchmarkRows = sourceRows.map((row) => {
    const documentItems = itemsByDocument.get(row.document_id) ?? new Map();
    return {
      ...row,
      spans: row.spans.map((span) => {
        const spanId = stableSpanId(row.document_id, span);
        if (span.span_id != null && span.span_id !== spanId) {
          throw new Error(`${row.document_id}: primary span has a stale span_id`);
        }
        const item = documentItems.get(spanId);
        if (!item) throw new Error(`${row.document_id}: missing reviewed gold span ${spanId}`);
        return {
          ...span,
          span_id: spanId,
          subannotations: savesByItemId.get(item.itemId).segments.map((segment) => ({
            begin: segment.begin,
            end: segment.end,
            category: segment.category,
            text: codePointSlice(row.text, segment.begin, segment.end),
          })),
        };
      }),
    };
  });

  await fs.mkdir(outputDir, { recursive: true });
  const benchmarkPath = path.join(outputDir, BENCHMARK_FILENAME);
  await fs.writeFile(
    benchmarkPath,
    `${benchmarkRows.map((row) => JSON.stringify(row)).join('\n')}\n`,
    'utf8',
  );
  const manifest = {
    bundle_version: 1,
    generated_at: new Date().toISOString(),
    contracts: {
      schema_version: 'meddeid.schema.v1',
      offset_unit: 'unicode_codepoints',
      span_identity: 'sha256(document_id,begin,end,label)',
      subannotation_profile: subannotationProfile.contractVersion,
    },
    subannotation_profile: subannotationProfile,
    files: { benchmark: BENCHMARK_FILENAME },
    hashes: {
      annotation_source_state_sha256: await sha256(sourceStatePath),
      source_annotations_sha256: await sha256(inputPath),
      confirmed_subannotations_sha256: await sha256(subannotationsPath),
      benchmark_sha256: await sha256(benchmarkPath),
    },
    annotation_source: {
      annotations_sha256: await sha256(inputPath),
      state: path.relative(outputDir, sourceStatePath),
    },
    counts: {
      documents: benchmarkRows.length,
      primary_gold_spans: items.length,
      core_pii_subannotations: benchmarkRows.reduce(
        (sum, row) => sum + row.spans.reduce(
          (spanSum, span) => spanSum + span.subannotations.length,
          0,
        ),
        0,
      ),
    },
    evaluation: {
      package: 'meddeid-eval',
      command: `meddeid-eval score --gold ${BENCHMARK_FILENAME} --predictions predictions.jsonl`,
    },
  };
  await fs.writeFile(
    path.join(outputDir, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );
  return { outputDir, manifest };
}
