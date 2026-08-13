#!/usr/bin/env node
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProjectStore } from '../server/project-store.js';

const SAVE_VERSION = 1;
const DEFAULT_MIN_SCORE = 350;
const PRIMARY_FILES = Object.freeze([
  'annotations.jsonl',
  'annotation-source-state.json',
  'gold.jsonl',
  'dataset_texts.json',
  'annotations.sha256',
]);
const OPTIONAL_PRIMARY_FILES = Object.freeze(['annotation-source.json']);

function parseArgs(argv) {
  const args = {
    rootDir: process.cwd(),
    dataDir: null,
    annotationsPath: null,
    write: false,
    minScore: DEFAULT_MIN_SCORE,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--write') {
      args.write = true;
    } else if (arg === '--root') {
      args.rootDir = path.resolve(argv[++index]);
    } else if (arg === '--data-dir') {
      args.dataDir = path.resolve(argv[++index]);
    } else if (arg === '--annotations') {
      args.annotationsPath = path.resolve(argv[++index]);
    } else if (arg === '--min-score') {
      args.minScore = Number(argv[++index]);
    } else if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isFinite(args.minScore) || args.minScore < 0) {
    throw new Error('--min-score must be a non-negative number');
  }
  args.dataDir ??= process.env.MEDDEID_DATA_DIR
    ? path.resolve(process.env.MEDDEID_DATA_DIR)
    : path.join(args.rootDir, 'data');
  return args;
}

function printHelp() {
  console.log(`Usage: npm run rebase -- [--annotations PATH] [--write]
                          [--root DIR] [--data-dir DIR] [--min-score N]

Rebases existing subannotations onto corrected canonical annotations.

With --annotations, the command stages and validates that file first. Without it,
the command rebases against the primary data already prepared in data/.

The default is a non-mutating dry run. --write installs the staged primary data and
migrated saves after moving the previous workspace artifacts to a timestamped backup.
`);
}

function parseJsonLines(text) {
  return String(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function docSortValue(documentId) {
  const match = /(\d+)$/.exec(documentId);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

function compareDocIds(left, right) {
  const leftNumber = docSortValue(left);
  const rightNumber = docSortValue(right);
  if (leftNumber !== rightNumber) return leftNumber - rightNumber;
  return left.localeCompare(right);
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
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

function normalizedValue(value) {
  return String(value ?? '').trim().toLowerCase();
}

function overlapLength(leftBegin, leftEnd, rightBegin, rightEnd) {
  return Math.max(0, Math.min(leftEnd, rightEnd) - Math.max(leftBegin, rightBegin));
}

export async function buildCurrentItems(dataDir) {
  const rows = parseJsonLines(await fs.readFile(path.join(dataDir, 'gold.jsonl'), 'utf8'));
  const itemsByDoc = new Map();
  for (const row of rows) {
    const documentId = String(row.document_id ?? '').trim();
    if (!documentId) throw new Error('gold.jsonl contains a row without document_id');
    const spans = [...(row.spans ?? [])].sort(
      (left, right) => (left.begin - right.begin) || (left.end - right.end),
    );
    const items = spans.map((span, goldIndex) => {
      const itemId = stableSpanId(documentId, span);
      if (span.span_id != null && span.span_id !== itemId) {
        throw new Error(`${documentId}: stale span_id ${span.span_id}`);
      }
      return {
        itemId,
        goldIndex,
        gold: {
          begin: Number(span.begin),
          end: Number(span.end),
          label: String(span.label ?? ''),
          text: String(span.text ?? ''),
          category: span.category ?? null,
          subtype: span.subtype ?? null,
        },
        reviewBegin: Number(span.begin),
        reviewEnd: Number(span.end),
      };
    });
    itemsByDoc.set(documentId, items);
  }
  return itemsByDoc;
}

function scoreMatch(savedEntry, item) {
  const oldGold = savedEntry.gold ?? {};
  const oldBegin = Number(oldGold.begin ?? savedEntry.reviewRange?.begin);
  const oldEnd = Number(oldGold.end ?? savedEntry.reviewRange?.end);
  if (!Number.isInteger(oldBegin) || !Number.isInteger(oldEnd) || oldBegin >= oldEnd) {
    return -Infinity;
  }
  const newBegin = item.gold.begin;
  const newEnd = item.gold.end;
  const oldLength = oldEnd - oldBegin;
  const newLength = newEnd - newBegin;
  const overlap = overlapLength(oldBegin, oldEnd, newBegin, newEnd);
  const coverage = overlap / Math.max(oldLength, newLength);
  const distance = Math.abs(oldBegin - newBegin) + Math.abs(oldEnd - newEnd);

  let score = coverage * 600 - Math.min(distance, 120) * 2;
  if (oldBegin === newBegin && oldEnd === newEnd) score += 1000;
  if (
    normalizedValue(oldGold.text) &&
    normalizedValue(oldGold.text) === normalizedValue(item.gold.text)
  ) {
    score += 500;
  }
  if (
    normalizedValue(oldGold.label) &&
    normalizedValue(oldGold.label) === normalizedValue(item.gold.label)
  ) {
    score += 250;
  }
  return score;
}

function findMatches(savedEntries, currentItems, minScore) {
  const matches = new Map();
  const usedItemIds = new Set();
  const currentById = new Map(currentItems.map((item) => [item.itemId, item]));

  for (const [oldItemId, savedEntry] of savedEntries) {
    const declaredId = String(savedEntry.goldSpanId ?? savedEntry.itemId ?? oldItemId);
    const exact = currentById.get(declaredId) ?? currentById.get(oldItemId);
    if (exact && !usedItemIds.has(exact.itemId)) {
      matches.set(oldItemId, { item: exact, score: Infinity, ambiguous: false, exact: true });
      usedItemIds.add(exact.itemId);
    }
  }

  const unmatchedEntries = savedEntries.filter(([oldItemId]) => !matches.has(oldItemId));
  const pairs = [];
  for (const [oldItemId, savedEntry] of unmatchedEntries) {
    const scores = currentItems
      .filter((item) => !usedItemIds.has(item.itemId))
      .map((item) => ({ item, score: scoreMatch(savedEntry, item) }))
      .sort((left, right) => right.score - left.score || left.item.itemId.localeCompare(right.item.itemId));
    const bestScore = scores[0]?.score ?? -Infinity;
    const secondScore = scores[1]?.score ?? -Infinity;
    for (const scored of scores) {
      if (scored.score < minScore) continue;
      pairs.push({
        oldItemId,
        savedEntry,
        item: scored.item,
        score: scored.score,
        ambiguous: scored.score === bestScore && bestScore - secondScore < 60,
      });
    }
  }
  pairs.sort(
    (left, right) =>
      right.score - left.score ||
      left.oldItemId.localeCompare(right.oldItemId) ||
      left.item.itemId.localeCompare(right.item.itemId),
  );
  for (const pair of pairs) {
    if (matches.has(pair.oldItemId) || usedItemIds.has(pair.item.itemId)) continue;
    matches.set(pair.oldItemId, { ...pair, exact: false });
    usedItemIds.add(pair.item.itemId);
  }
  return { matches, usedItemIds };
}

function mergeAdjacentSegments(segments) {
  if (segments.length === 0) return [];
  const merged = [{ ...segments[0] }];
  for (const segment of segments.slice(1)) {
    const previous = merged.at(-1);
    if (previous.end === segment.begin && previous.category === segment.category) {
      previous.end = segment.end;
    } else {
      merged.push({ ...segment });
    }
  }
  return merged;
}

function transferSegments(savedEntry, item) {
  const oldGold = savedEntry.gold ?? {};
  const oldBegin = Number(oldGold.begin ?? savedEntry.reviewRange?.begin);
  const oldEnd = Number(oldGold.end ?? savedEntry.reviewRange?.end);
  const oldText = String(oldGold.text ?? '');
  const sameContentMoved =
    oldText.length > 0 &&
    oldText === item.gold.text &&
    oldEnd - oldBegin === item.reviewEnd - item.reviewBegin;
  const delta = sameContentMoved ? item.reviewBegin - oldBegin : 0;
  const transferred = [];
  let clippedSegments = 0;
  let discardedSegments = 0;

  for (const rawSegment of savedEntry.segments ?? []) {
    let begin = Number(rawSegment.begin);
    let end = Number(rawSegment.end);
    const category = String(rawSegment.category ?? '').trim();
    if (!Number.isInteger(begin) || !Number.isInteger(end) || begin >= end || !category) {
      discardedSegments += 1;
      continue;
    }
    begin += delta;
    end += delta;
    const nextBegin = Math.max(begin, item.reviewBegin);
    const nextEnd = Math.min(end, item.reviewEnd);
    if (nextBegin >= nextEnd) {
      discardedSegments += 1;
      continue;
    }
    if (nextBegin !== begin || nextEnd !== end) clippedSegments += 1;
    transferred.push({ begin: nextBegin, end: nextEnd, category });
  }

  transferred.sort((left, right) => (left.begin - right.begin) || (left.end - right.end));
  const nonOverlapping = [];
  for (const segment of transferred) {
    const previous = nonOverlapping.at(-1);
    if (previous && segment.begin < previous.end) {
      discardedSegments += 1;
      continue;
    }
    nonOverlapping.push(segment);
  }
  return {
    segments: mergeAdjacentSegments(nonOverlapping),
    clippedSegments,
    discardedSegments,
    sameContentMoved,
  };
}

function hasCompleteCoverage(item, segments) {
  let cursor = item.reviewBegin;
  for (const segment of segments) {
    if (segment.begin !== cursor) return false;
    cursor = segment.end;
  }
  return cursor === item.reviewEnd;
}

function buildSaveRecord(item, savedEntry, transfer, match) {
  const complete = hasCompleteCoverage(item, transfer.segments);
  const sameLabel = normalizedValue(savedEntry.gold?.label) === normalizedValue(item.gold.label);
  const safeIdentity = match.exact || (transfer.sameContentMoved && sameLabel);
  const keepConfirmed =
    savedEntry.status === 'confirmed' && complete && safeIdentity && !match.ambiguous;
  return {
    record: {
      itemId: item.itemId,
      goldSpanId: item.itemId,
      goldIndex: item.goldIndex,
      gold: item.gold,
      reviewRange: { begin: item.reviewBegin, end: item.reviewEnd },
      status: keepConfirmed ? 'confirmed' : 'in_progress',
      segments: transfer.segments,
      updatedAt: savedEntry.updatedAt ?? null,
      confirmedAt: keepConfirmed ? (savedEntry.confirmedAt ?? null) : null,
    },
    complete,
    keepConfirmed,
  };
}

function docSaveFilename(documentId) {
  return `${documentId}.json`;
}

export async function migrateSaves({ dataDir, minScore = DEFAULT_MIN_SCORE, write = false }) {
  const saveRoot = path.join(dataDir, 'subspan_annotations');
  const saveDocsDir = path.join(saveRoot, 'documents');
  await fs.mkdir(saveDocsDir, { recursive: true });
  const currentItemsByDoc = await buildCurrentItems(dataDir);
  const targetState = await readJson(path.join(dataDir, 'annotation-source-state.json')).catch(() => null);
  const saveFiles = (await fs.readdir(saveDocsDir))
    .filter((filename) => filename.endsWith('.json'))
    .sort(compareDocIds);
  const savedDocs = new Map();
  for (const filename of saveFiles) {
    const payload = await readJson(path.join(saveDocsDir, filename));
    const documentId = String(payload.document_id ?? filename.replace(/\.json$/, ''));
    savedDocs.set(documentId, { filename, payload });
  }

  const summary = {
    documentsWithSaves: savedDocs.size,
    savedItems: 0,
    exact: 0,
    remapped: 0,
    unmatched: 0,
    ambiguous: 0,
    newItems: 0,
    confirmedPreserved: 0,
    requiresReview: 0,
    clippedSegments: 0,
    discardedSegments: 0,
    changedDocuments: 0,
  };
  const details = [];
  const nextDocSaves = new Map();
  const allDocumentIds = new Set([...savedDocs.keys(), ...currentItemsByDoc.keys()]);

  for (const documentId of [...allDocumentIds].sort(compareDocIds)) {
    const existingDoc = savedDocs.get(documentId)?.payload ?? {
      version: SAVE_VERSION,
      document_id: documentId,
      items: {},
    };
    const savedEntries = Object.entries(existingDoc.items ?? {});
    const currentItems = currentItemsByDoc.get(documentId) ?? [];
    summary.savedItems += savedEntries.length;
    const { matches, usedItemIds } = findMatches(savedEntries, currentItems, minScore);
    const nextItems = {};
    const orphanedItems = { ...(existingDoc.orphanedItems ?? {}) };

    for (const [oldItemId, savedEntry] of savedEntries) {
      const match = matches.get(oldItemId);
      if (!match) {
        summary.unmatched += 1;
        summary.requiresReview += 1;
        orphanedItems[oldItemId] = savedEntry;
        details.push({ documentId, oldItemId, action: 'archived_unmatched' });
        continue;
      }
      if (match.exact) summary.exact += 1;
      else summary.remapped += 1;
      if (match.ambiguous) summary.ambiguous += 1;

      const transfer = transferSegments(savedEntry, match.item);
      summary.clippedSegments += transfer.clippedSegments;
      summary.discardedSegments += transfer.discardedSegments;
      const built = buildSaveRecord(match.item, savedEntry, transfer, match);
      nextItems[match.item.itemId] = built.record;
      if (built.keepConfirmed) summary.confirmedPreserved += 1;
      else if (savedEntry.status === 'confirmed' || match.ambiguous || !built.complete) {
        summary.requiresReview += 1;
      }
      if (
        !match.exact ||
        match.ambiguous ||
        transfer.clippedSegments > 0 ||
        transfer.discardedSegments > 0 ||
        savedEntry.status !== built.record.status
      ) {
        details.push({
          documentId,
          oldItemId,
          newItemId: match.item.itemId,
          action: match.exact ? 'retained' : 'remapped',
          score: Number.isFinite(match.score) ? match.score : null,
          ambiguous: match.ambiguous,
          clippedSegments: transfer.clippedSegments,
          discardedSegments: transfer.discardedSegments,
          oldStatus: savedEntry.status,
          newStatus: built.record.status,
        });
      }
    }

    for (const item of currentItems) {
      if (usedItemIds.has(item.itemId)) continue;
      summary.newItems += 1;
      summary.requiresReview += 1;
      details.push({ documentId, newItemId: item.itemId, action: 'new_primary_span' });
    }

    const nextDoc = {
      ...existingDoc,
      version: SAVE_VERSION,
      document_id: documentId,
      primaryGold: {
        annotationsSha256: targetState?.hashes?.annotations_sha256 ?? null,
      },
      updatedAt: new Date().toISOString(),
      items: nextItems,
    };
    if (Object.keys(orphanedItems).length > 0) nextDoc.orphanedItems = orphanedItems;
    else delete nextDoc.orphanedItems;
    const beforeComparable = { ...existingDoc, updatedAt: null };
    const afterComparable = { ...nextDoc, updatedAt: null };
    if (JSON.stringify(beforeComparable) !== JSON.stringify(afterComparable)) {
      summary.changedDocuments += 1;
    }
    if (savedEntries.length > 0 || Object.keys(nextItems).length > 0 || Object.keys(orphanedItems).length > 0) {
      nextDocSaves.set(documentId, nextDoc);
    }
  }

  if (write) {
    for (const filename of saveFiles) {
      await fs.rm(path.join(saveDocsDir, filename));
    }
    for (const [documentId, payload] of nextDocSaves) {
      await fs.writeFile(
        path.join(saveDocsDir, docSaveFilename(documentId)),
        `${JSON.stringify(payload, null, 2)}\n`,
        'utf8',
      );
    }
    const outputRows = [];
    for (const documentId of [...currentItemsByDoc.keys()].sort(compareDocIds)) {
      const docSave = nextDocSaves.get(documentId);
      if (!docSave) continue;
      const currentItems = currentItemsByDoc.get(documentId) ?? [];
      const items = currentItems
        .map((item) => docSave.items?.[item.itemId])
        .filter(Boolean)
        .map((entry) => ({
          item_id: entry.itemId,
          gold_span_id: entry.goldSpanId,
          gold_index: entry.goldIndex,
          status: entry.status,
          segments: entry.segments,
          updated_at: entry.updatedAt,
          confirmed_at: entry.confirmedAt,
        }));
      if (items.length > 0) {
        outputRows.push({
          document_id: documentId,
          primary_gold: {
            annotations_sha256: targetState?.hashes?.annotations_sha256 ?? null,
          },
          items,
        });
      }
    }
    const output = outputRows.map((row) => JSON.stringify(row)).join('\n');
    await fs.writeFile(
      path.join(dataDir, 'subannotations.jsonl'),
      output ? `${output}\n` : '',
      'utf8',
    );
  }
  return { summary, details };
}

async function runPrepareData({ rootDir, dataDir, annotationsPath }) {
  const env = {
    ...process.env,
    MEDDEID_DATA_DIR: dataDir,
    MEDDEID_ANNOTATIONS_PATH: annotationsPath,
  };
  delete env.MEDDEID_ANNOTATIONS_SHA256;

  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(rootDir, 'server', 'prepare-data.js')], {
      cwd: rootDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error((stderr || stdout || `prepare:data exited with ${code}`).trim()));
    });
  });
}

async function copyIfPresent(source, target) {
  if (!(await exists(source))) return false;
  const stat = await fs.stat(source);
  if (stat.isDirectory()) await fs.cp(source, target, { recursive: true, force: true });
  else await fs.copyFile(source, target);
  return true;
}

async function stageWorkspace(args, stageDir) {
  await fs.mkdir(stageDir, { recursive: true });
  const saveRoot = path.join(args.dataDir, 'subspan_annotations');
  if (await exists(saveRoot)) {
    await fs.cp(saveRoot, path.join(stageDir, 'subspan_annotations'), { recursive: true });
  }
  if (args.annotationsPath) {
    await runPrepareData({
      rootDir: args.rootDir,
      dataDir: stageDir,
      annotationsPath: args.annotationsPath,
    });
  } else {
    for (const filename of PRIMARY_FILES) {
      const copied = await copyIfPresent(path.join(args.dataDir, filename), path.join(stageDir, filename));
      if (!copied) throw new Error(`Missing ${path.join(args.dataDir, filename)}`);
    }
    for (const filename of OPTIONAL_PRIMARY_FILES) {
      await copyIfPresent(path.join(args.dataDir, filename), path.join(stageDir, filename));
    }
  }
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function installStagedWorkspace({ dataDir, stageDir, stamp }) {
  const backupDir = path.join(dataDir, 'rebase-backups', stamp);
  await fs.mkdir(backupDir, { recursive: true });
  const managed = [
    ...PRIMARY_FILES,
    ...OPTIONAL_PRIMARY_FILES,
    'subspan_annotations',
    'subannotations.jsonl',
    'evaluation-bundle',
  ];
  const moved = [];
  try {
    for (const name of managed) {
      const livePath = path.join(dataDir, name);
      if (!(await exists(livePath))) continue;
      await fs.rename(livePath, path.join(backupDir, name));
      moved.push(name);
    }
    for (const name of [
      ...PRIMARY_FILES,
      ...OPTIONAL_PRIMARY_FILES,
      'subspan_annotations',
      'subannotations.jsonl',
    ]) {
      await copyIfPresent(path.join(stageDir, name), path.join(dataDir, name));
    }
  } catch (error) {
    for (const name of [...moved].reverse()) {
      const livePath = path.join(dataDir, name);
      if (await exists(livePath)) await fs.rm(livePath, { recursive: true, force: true });
      const backupPath = path.join(backupDir, name);
      if (await exists(backupPath)) await fs.rename(backupPath, livePath);
    }
    throw error;
  }
  // Immutable/derived primary inputs are recoverable from the linked source and
  // would make every update backup as large as the dataset. Keep only the
  // researcher's mutable subannotation work in the durable backup.
  for (const name of [...PRIMARY_FILES, ...OPTIONAL_PRIMARY_FILES, 'evaluation-bundle']) {
    await fs.rm(path.join(backupDir, name), { recursive: true, force: true });
  }
  return backupDir;
}

export async function rebaseSubannotations(options) {
  const args = {
    rootDir: path.resolve(options.rootDir),
    dataDir: path.resolve(options.dataDir),
    annotationsPath: options.annotationsPath ? path.resolve(options.annotationsPath) : null,
    write: Boolean(options.write),
    minScore: options.minScore ?? DEFAULT_MIN_SCORE,
  };
  const stageParent = await fs.mkdtemp(path.join(os.tmpdir(), 'meddeid-rebase-'));
  const stageDir = path.join(stageParent, 'data');
  try {
    await stageWorkspace(args, stageDir);
    const previousState = await readJson(path.join(args.dataDir, 'annotation-source-state.json')).catch(() => null);
    const targetState = await readJson(path.join(stageDir, 'annotation-source-state.json'));
    const migration = await migrateSaves({ dataDir: stageDir, minScore: args.minScore, write: true });
    const stagedStore = await createProjectStore({ rootDir: args.rootDir, dataDir: stageDir });
    await stagedStore.getBootstrap();
    const stamp = timestamp();
    const report = {
      report_version: 'meddeid.subannotation-rebase.v1',
      created_at: new Date().toISOString(),
      mode: args.write ? 'write' : 'dry_run',
      from_annotations_sha256: previousState?.hashes?.annotations_sha256 ?? null,
      to_annotations_sha256: targetState.hashes?.annotations_sha256 ?? null,
      min_score: args.minScore,
      summary: migration.summary,
      details: migration.details,
    };
    let backupDir = null;
    let reportPath = null;
    if (args.write) {
      backupDir = await installStagedWorkspace({ dataDir: args.dataDir, stageDir, stamp });
      const reportDir = path.join(args.dataDir, 'rebase-reports');
      await fs.mkdir(reportDir, { recursive: true });
      reportPath = path.join(reportDir, `${stamp}.json`);
      report.backup_path = path.relative(args.dataDir, backupDir);
      await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    }
    return { report, backupDir, reportPath };
  } finally {
    await fs.rm(stageParent, { recursive: true, force: true });
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      printHelp();
    } else {
      const result = await rebaseSubannotations(args);
      console.log(
        `${args.write ? 'Rebase complete' : 'Dry run only'}: ` +
          `${result.report.from_annotations_sha256?.slice(0, 12) ?? 'none'} -> ` +
          `${result.report.to_annotations_sha256.slice(0, 12)}`,
      );
      console.log(JSON.stringify(result.report.summary, null, 2));
      if (result.backupDir) console.log(`Backup: ${result.backupDir}`);
      if (result.reportPath) console.log(`Report: ${result.reportPath}`);
      if (!args.write) console.log('Re-run with --write to install the rebased workspace.');
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
