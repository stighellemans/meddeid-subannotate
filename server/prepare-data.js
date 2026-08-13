import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { codePointLength, codePointSlice } from '../shared/unicode-offsets.js';
import { buildAnnotationSourceRecord } from './primary-gold-source.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = process.env.MEDDEID_DATA_DIR
  ? path.resolve(process.env.MEDDEID_DATA_DIR)
  : path.join(rootDir, 'data');
const target = path.join(dataDir, 'annotations.jsonl');
const localStatePath = path.join(dataDir, 'annotation-source-state.json');
const localSourcePath = path.join(dataDir, 'annotation-source.json');
const expectedHash = String(process.env.MEDDEID_ANNOTATIONS_SHA256 ?? '').trim().toLowerCase();

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function configuredSourcePath() {
  if (process.env.MEDDEID_ANNOTATIONS_PATH) {
    return path.resolve(process.env.MEDDEID_ANNOTATIONS_PATH);
  }
  try {
    const linked = JSON.parse(await fs.readFile(localSourcePath, 'utf8'));
    if (linked.annotations_path) return path.resolve(linked.annotations_path);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  throw new Error(
    'MEDDEID_ANNOTATIONS_PATH is required the first time. Link annotations.jsonl from meddeid-annotate or meddeid-curate.',
  );
}

const source = await configuredSourcePath();
await fs.mkdir(dataDir, { recursive: true });
if (
  source !== target &&
  await exists(target) &&
  await exists(localStatePath) &&
  await exists(path.join(dataDir, 'gold.jsonl')) &&
  await exists(path.join(dataDir, 'dataset_texts.json'))
) {
  const localState = JSON.parse(await fs.readFile(localStatePath, 'utf8'));
  const localHash = crypto.createHash('sha256').update(await fs.readFile(target)).digest('hex');
  if (localHash === localState.hashes?.annotations_sha256) {
    await fs.writeFile(
      localSourcePath,
      `${JSON.stringify(buildAnnotationSourceRecord(source), null, 2)}\n`,
      'utf8',
    );
    console.log('Workspace already prepared; linked annotation changes can be reviewed in the UI.');
    process.exit(0);
  }
}
if (source !== target) await fs.copyFile(source, target);

const content = await fs.readFile(target).catch((error) => {
  if (error?.code === 'ENOENT') throw new Error('The linked annotations.jsonl does not exist.');
  throw error;
});
const actualHash = crypto.createHash('sha256').update(content).digest('hex');
if (expectedHash && actualHash !== expectedHash) {
  throw new Error(`Annotation checksum mismatch: expected ${expectedHash}, got ${actualHash}`);
}

const taxonomy = JSON.parse(await fs.readFile(path.join(rootDir, 'contracts', 'taxonomy.json'), 'utf8'));
const labels = new Set(taxonomy.entity_labels);
const rows = content
  .toString('utf8')
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean)
  .map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`Invalid JSON on line ${index + 1}: ${error.message}`);
    }
  });

const texts = {};
const seenDocumentIds = new Set();
const goldRows = rows.map((row, rowIndex) => {
  const context = `Row ${rowIndex + 1}`;
  const documentAlias = ['doc_id', 'plain_text', 'annotations'].find((key) => Object.hasOwn(row, key));
  if (documentAlias) {
    throw new Error(
      `${context} uses unsupported field ${JSON.stringify(documentAlias)}; ` +
        'records must use document_id, text, and spans',
    );
  }
  const documentId = String(row.document_id ?? '').trim();
  if (!documentId || typeof row.text !== 'string') {
    throw new Error(`${context} must contain document_id and text`);
  }
  if (seenDocumentIds.has(documentId)) throw new Error(`Duplicate document_id: ${documentId}`);
  seenDocumentIds.add(documentId);
  if (row.annotated !== true && row.completed !== true) {
    throw new Error(`${documentId} has not been marked annotated`);
  }
  if (row.spans !== undefined && !Array.isArray(row.spans)) {
    throw new Error(`${context} spans must be a list`);
  }
  if (row.adjudication != null) {
    if (!Array.isArray(row.adjudication.disagreements)) {
      throw new Error(`${context} has an invalid adjudication record`);
    }
    if (!['agreed', 'adjudicated'].includes(row.adjudication.status)) {
      throw new Error(`${context} adjudication status is not complete`);
    }
    if (row.adjudication.disagreements.some((item) => item.status !== 'resolved')) {
      throw new Error(`${context} contains pending adjudication disagreements`);
    }
  }

  const spans = (row.spans ?? []).map((span, spanIndex) => {
    const spanAlias = ['Category', 'Subtype'].find((key) => Object.hasOwn(span, key));
    if (spanAlias) {
      throw new Error(
        `${context} span ${spanIndex} uses unsupported field ${JSON.stringify(spanAlias)}; ` +
          'spans must use the canonical MedDeID fields',
      );
    }
    const label = String(span.label ?? '').trim();
    if (!labels.has(label)) {
      throw new Error(`${documentId} span ${spanIndex} has unsupported label ${JSON.stringify(label)}`);
    }
    const begin = Number(span.begin);
    const end = Number(span.end);
    if (
      !Number.isInteger(begin) ||
      !Number.isInteger(end) ||
      begin < 0 ||
      end <= begin ||
      end > codePointLength(row.text)
    ) {
      throw new Error(`${documentId} span ${spanIndex} has invalid range [${begin}, ${end})`);
    }
    const [category, ...subtypeParts] = label.split(':');
    const spanId = `span-${crypto.createHash('sha256').update(JSON.stringify([
      documentId,
      begin,
      end,
      label,
    ]), 'utf8').digest('hex').slice(0, 24)}`;
    if (span.span_id != null && span.span_id !== spanId) {
      throw new Error(`${documentId} span ${spanIndex} has a stale span_id`);
    }
    return {
      ...span,
      span_id: spanId,
      begin,
      end,
      label,
      text: codePointSlice(row.text, begin, end),
      category,
      subtype: subtypeParts.length ? subtypeParts.join(':') : null,
      confirmed: true,
    };
  });
  texts[documentId] = { text: row.text, ...(row.metadata ?? {}) };
  return { document_id: documentId, spans };
});

const primarySpanCount = goldRows.reduce((sum, row) => sum + row.spans.length, 0);
const sourceState = {
  state_format: 'meddeid.annotation-source-state.v1',
  status: 'linked',
  linked_at: new Date().toISOString(),
  contracts: {
    schema_version: 'meddeid.schema.v1',
    taxonomy_contract_version: taxonomy.contract_version,
    taxonomy_version: taxonomy.taxonomy_version,
  },
  hashes: { annotations_sha256: actualHash },
  counts: { documents: rows.length, primary_gold_spans: primarySpanCount },
};

await fs.writeFile(
  path.join(dataDir, 'gold.jsonl'),
  `${goldRows.map((row) => JSON.stringify(row)).join('\n')}\n`,
  'utf8',
);
await fs.writeFile(path.join(dataDir, 'dataset_texts.json'), `${JSON.stringify(texts, null, 2)}\n`, 'utf8');
await fs.writeFile(path.join(dataDir, 'annotations.sha256'), `${actualHash}\n`, 'utf8');
await fs.writeFile(localStatePath, `${JSON.stringify(sourceState, null, 2)}\n`, 'utf8');
await fs.writeFile(
  localSourcePath,
  `${JSON.stringify(buildAnnotationSourceRecord(source), null, 2)}\n`,
  'utf8',
);
console.log(`Prepared ${rows.length} annotated documents (${actualHash})`);
