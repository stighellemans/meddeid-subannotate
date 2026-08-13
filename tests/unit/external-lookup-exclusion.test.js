import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('public subannotation preprocessor cannot discover or load excluded lexicons', async () => {
  const source = await fs.readFile(
    path.join(rootDir, 'server', 'preprocessing', 'span-preprocessor.js'),
    'utf8',
  );

  for (const forbiddenMechanism of [
    'readLexiconFile(',
    'readFileSync(',
    'regex_lists/',
    'MEDDEID_LOOKUPS',
    'export_caregivers',
  ]) {
    assert.equal(
      source.includes(forbiddenMechanism),
      false,
      `excluded lookup mechanism returned: ${forbiddenMechanism}`,
    );
  }

  for (const excludedPath of [
    'regex_lists',
    path.join('data', 'lookups'),
    'export_caregivers.parquet',
  ]) {
    await assert.rejects(fs.access(path.join(rootDir, excludedPath)));
  }
});
