import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, '..', '..');

test('preparation rejects fields outside the canonical schema', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'subannotate-input-'));
  try {
    const inputPath = path.join(tempDir, 'unsupported.jsonl');
    const dataDir = path.join(tempDir, 'data');
    const payload = `${JSON.stringify({
        doc_id: 'doc1',
        text: 'Jan',
        annotations: [{ begin: 0, end: 3, Category: 'Name', Subtype: 'Patient' }],
      })}\n`;
    await fs.writeFile(inputPath, payload);
    await assert.rejects(
      execFileAsync(process.execPath, ['server/prepare-data.js'], {
        cwd: repoRoot,
        env: {
          ...process.env,
          MEDDEID_DATA_DIR: dataDir,
          MEDDEID_ANNOTATIONS_PATH: inputPath,
        },
      }),
      (error) => {
        assert.match(error.stderr, /unsupported field "doc_id"/);
        assert.match(error.stderr, /document_id, text, and spans/);
        return true;
      },
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('preparation requires a canonical annotations file on first use', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'subannotate-input-'));
  try {
    await assert.rejects(
      execFileAsync(process.execPath, ['server/prepare-data.js'], {
        cwd: repoRoot,
        env: { ...process.env, MEDDEID_DATA_DIR: path.join(tempDir, 'data') },
      }),
      (error) => {
        assert.match(error.stderr, /MEDDEID_ANNOTATIONS_PATH is required/);
        return true;
      },
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('preparation accepts direct annotated output and rejects pending adjudication', async () => {
  for (const pending of [false, true]) {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'subannotate-input-'));
    try {
      const inputPath = path.join(tempDir, 'annotations.jsonl');
      const dataDir = path.join(tempDir, 'data');
      const payload = `${JSON.stringify({
        document_id: 'doc1',
        text: 'Jan',
        annotated: true,
        spans: [{ begin: 0, end: 3, text: 'Jan', label: 'Name:Patient', confirmed: true }],
        adjudication: {
          status: pending ? 'pending' : 'adjudicated',
          disagreements: pending
            ? [{ disagreement_id: 'd1', status: 'pending', decision: null }]
            : [{ disagreement_id: 'd1', status: 'resolved', decision: { type: 'accept_candidate' } }],
        },
      })}\n`;
      await fs.writeFile(inputPath, payload);
      const execution = execFileAsync(process.execPath, ['server/prepare-data.js'], {
        cwd: repoRoot,
        env: {
          ...process.env,
          MEDDEID_DATA_DIR: dataDir,
          MEDDEID_ANNOTATIONS_PATH: inputPath,
        },
      });
      if (pending) {
        await assert.rejects(execution, /adjudication status is not complete/);
      } else {
        const result = await execution;
        assert.match(result.stdout, /Prepared 1 annotated documents/);
        const source = JSON.parse(
          await fs.readFile(path.join(dataDir, 'annotation-source.json'), 'utf8'),
        );
        assert.equal(source.source_version, 'meddeid.annotation-source.v1');
        assert.equal(source.annotations_path, inputPath);
      }
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }
});

test('preparation accepts meddeid-annotate JSONL without a curation record', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'subannotate-direct-'));
  try {
    const inputPath = path.join(tempDir, 'annotations.jsonl');
    const dataDir = path.join(tempDir, 'data');
    await fs.writeFile(inputPath, `${JSON.stringify({
      document_id: 'doc-direct',
      text: 'Jan',
      annotated: true,
      spans: [{ begin: 0, end: 3, text: 'Jan', label: 'Name:Patient' }],
    })}\n`);
    await execFileAsync(process.execPath, ['server/prepare-data.js'], {
      cwd: repoRoot,
      env: { ...process.env, MEDDEID_DATA_DIR: dataDir, MEDDEID_ANNOTATIONS_PATH: inputPath },
    });
    const prepared = JSON.parse((await fs.readFile(path.join(dataDir, 'gold.jsonl'), 'utf8')).trim());
    assert.equal(prepared.spans[0].confirmed, true);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('restart keeps the reviewed workspace until source changes are applied', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'subannotate-restart-'));
  try {
    const inputPath = path.join(tempDir, 'annotations.jsonl');
    const dataDir = path.join(tempDir, 'data');
    const original = `${JSON.stringify({
      document_id: 'doc1', text: 'Jan', annotated: true,
      spans: [{ begin: 0, end: 3, label: 'Name:Patient' }],
    })}\n`;
    await fs.writeFile(inputPath, original);
    const options = {
      cwd: repoRoot,
      env: { ...process.env, MEDDEID_DATA_DIR: dataDir, MEDDEID_ANNOTATIONS_PATH: inputPath },
    };
    await execFileAsync(process.execPath, ['server/prepare-data.js'], options);
    await fs.writeFile(inputPath, `${JSON.stringify({
      document_id: 'doc1', text: 'XJan', annotated: true,
      spans: [{ begin: 1, end: 4, label: 'Name:Patient' }],
    })}\n`);
    const restarted = await execFileAsync(process.execPath, ['server/prepare-data.js'], options);
    assert.match(restarted.stdout, /changes can be reviewed in the UI/);
    assert.equal(await fs.readFile(path.join(dataDir, 'annotations.jsonl'), 'utf8'), original);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
