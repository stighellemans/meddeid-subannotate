import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { createProjectStore } from '../../server/project-store.js';
import { rebaseSubannotations } from '../../scripts/rebase-subannotations.js';

const execFileAsync = promisify(execFile);
const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

async function annotationFile(rootDir, filename, row) {
  await fs.mkdir(rootDir, { recursive: true });
  const payload = `${JSON.stringify(row)}\n`;
  const annotationsPath = path.join(rootDir, filename);
  await fs.writeFile(annotationsPath, payload);
  return annotationsPath;
}

async function prepare(annotationsPath, dataDir) {
  await execFileAsync(process.execPath, [path.join(ROOT_DIR, 'server', 'prepare-data.js')], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      MEDDEID_DATA_DIR: dataDir,
      MEDDEID_ANNOTATIONS_PATH: annotationsPath,
    },
  });
}

test('one-command rebase preserves confirmed work across a safe offset shift', async () => {
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'subannotation-rebase-'));
  const dataDir = path.join(fixtureRoot, 'workspace-data');
  const sourceRoot = path.join(fixtureRoot, 'source');
  const adjudication = { status: 'agreed', disagreements: [] };
  const original = await annotationFile(sourceRoot, 'original.jsonl', {
    document_id: 'doc1',
    text: 'Jan Peeters',
    annotated: true,
    spans: [{ begin: 0, end: 11, label: 'Name:Patient', confirmed: true }],
    adjudication,
  });
  const corrected = await annotationFile(sourceRoot, 'corrected.jsonl', {
    document_id: 'doc1',
    text: 'XJan Peeters',
    annotated: true,
    spans: [{ begin: 1, end: 12, label: 'Name:Patient', confirmed: true }],
    adjudication,
  });

  try {
    await prepare(original, dataDir);
    const store = await createProjectStore({ rootDir: ROOT_DIR, dataDir });
    const item = (await store.getBootstrap()).items[0];
    await store.saveItem({
      itemId: item.itemId,
      status: 'confirmed',
      segments: [
        { begin: 0, end: 3, category: 'given' },
        { begin: 3, end: 4, category: 'formatting' },
        { begin: 4, end: 11, category: 'family' },
      ],
    });

    const dryRun = await rebaseSubannotations({
      rootDir: ROOT_DIR,
      dataDir,
      annotationsPath: corrected,
      write: false,
    });
    assert.notEqual(dryRun.report.from_annotations_sha256, dryRun.report.to_annotations_sha256);
    assert.equal(dryRun.report.summary.remapped, 1);
    assert.equal(dryRun.report.summary.confirmedPreserved, 1);
    assert.equal((await fs.readFile(path.join(dataDir, 'annotations.sha256'), 'utf8')).trim(), sha256(await fs.readFile(original)));

    const written = await rebaseSubannotations({
      rootDir: ROOT_DIR,
      dataDir,
      annotationsPath: corrected,
      write: true,
    });
    assert.equal((await fs.readFile(path.join(dataDir, 'annotations.sha256'), 'utf8')).trim(), sha256(await fs.readFile(corrected)));
    await assert.rejects(fs.access(path.join(written.backupDir, 'annotations.jsonl')));
    assert.ok(written.reportPath);

    const nextStore = await createProjectStore({ rootDir: ROOT_DIR, dataDir });
    const nextBootstrap = await nextStore.getBootstrap();
    assert.equal(nextBootstrap.progress.spans.confirmed, 1);
    assert.deepEqual(nextBootstrap.items[0].saved.segments, [
      { begin: 1, end: 4, category: 'given' },
      { begin: 4, end: 5, category: 'formatting' },
      { begin: 5, end: 12, category: 'family' },
    ]);
  } finally {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  }
});

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

test('changed primary boundaries retain usable segments but require review', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'subannotation-boundary-rebase-'));
  const oldSpan = { begin: 0, end: 3, label: 'Name:Patient', text: 'Jan' };
  const oldItemId = `span-${crypto.createHash('sha256').update(JSON.stringify([
    'doc1', 0, 3, 'Name:Patient',
  ])).digest('hex').slice(0, 24)}`;
  try {
    await fs.mkdir(path.join(dataDir, 'subspan_annotations', 'documents'), { recursive: true });
    await fs.writeFile(
      path.join(dataDir, 'gold.jsonl'),
      `${JSON.stringify({
        document_id: 'doc1',
        spans: [{ begin: 0, end: 4, label: 'Name:Patient', text: 'Jan ', category: 'Name', subtype: 'Patient' }],
      })}\n`,
    );
    await fs.writeFile(
      path.join(dataDir, 'subspan_annotations', 'documents', 'doc1.json'),
      `${JSON.stringify({
        version: 1,
        document_id: 'doc1',
        items: {
          [oldItemId]: {
            itemId: oldItemId,
            goldSpanId: oldItemId,
            gold: oldSpan,
            reviewRange: { begin: 0, end: 3 },
            status: 'confirmed',
            segments: [{ begin: 0, end: 3, category: 'given' }],
          },
        },
      }, null, 2)}\n`,
    );
    const result = await (await import('../../scripts/rebase-subannotations.js')).migrateSaves({
      dataDir,
      write: true,
    });
    assert.equal(result.summary.remapped, 1);
    assert.equal(result.summary.requiresReview, 1);
    const saved = await readJson(path.join(dataDir, 'subspan_annotations', 'documents', 'doc1.json'));
    const entry = Object.values(saved.items)[0];
    assert.equal(entry.status, 'in_progress');
    assert.deepEqual(entry.segments, [{ begin: 0, end: 3, category: 'given' }]);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
