import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildAnnotationSourceRecord,
  discoverCurrentAnnotations,
} from '../../server/primary-gold-source.js';

test('linked source follows one canonical annotations file by hash', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'annotation-source-'));
  const dataDir = path.join(root, 'data');
  const annotationsPath = path.join(root, 'annotations.jsonl');
  try {
    await fs.mkdir(dataDir, { recursive: true });
    const annotations = '{}\n';
    await fs.writeFile(annotationsPath, annotations);
    await fs.writeFile(
      path.join(dataDir, 'annotation-source.json'),
      JSON.stringify(buildAnnotationSourceRecord(annotationsPath)),
    );

    const current = await discoverCurrentAnnotations(dataDir);
    assert.equal(current.annotationsPath, annotationsPath);
    assert.equal(
      current.annotationsSha256,
      crypto.createHash('sha256').update(annotations).digest('hex'),
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('unlinked workspaces receive a one-time setup instruction', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'annotation-source-unlinked-'));
  try {
    await assert.rejects(
      discoverCurrentAnnotations(dataDir),
      /not linked.*Run prepare:data once/,
    );
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
