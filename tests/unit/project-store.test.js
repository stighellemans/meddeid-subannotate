import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createProjectStore } from '../../server/project-store.js';
import { neutralSubannotationProfile } from '../../server/subannotation-profile.js';

const TAXONOMY = {
  contract_version: 1,
  taxonomy_version: 'test',
  entity_labels: ['Name:Patient', 'Contactdetails'],
};

function normalizedSpans(row) {
  return row.spans.map((span) => {
    const [category, ...subtype] = span.label.split(':');
    return {
      ...span,
      text: Array.from(row.text).slice(span.begin, span.end).join(''),
      category,
      subtype: subtype.join(':') || null,
    };
  });
}

async function fixture(rows, { importedRows = null } = {}) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'subannotate-'));
  await fs.mkdir(path.join(rootDir, 'contracts'), { recursive: true });
  await fs.mkdir(path.join(rootDir, 'data'), { recursive: true });
  await fs.writeFile(path.join(rootDir, 'contracts', 'taxonomy.json'), JSON.stringify(TAXONOMY));
  const annotationsPayload = `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`;
  await fs.writeFile(path.join(rootDir, 'data', 'annotations.jsonl'), annotationsPayload);
  await fs.writeFile(
    path.join(rootDir, 'data', 'annotation-source-state.json'),
    JSON.stringify({
      state_format: 'meddeid.annotation-source-state.v1',
      status: 'linked',
      contracts: {
        schema_version: 'meddeid.schema.v1',
        taxonomy_contract_version: TAXONOMY.contract_version,
        taxonomy_version: TAXONOMY.taxonomy_version,
      },
      files: { annotations: 'annotations.jsonl' },
      hashes: {
        annotations_sha256: crypto.createHash('sha256').update(annotationsPayload).digest('hex'),
      },
      counts: {
        documents: rows.length,
        primary_gold_spans: rows.reduce((sum, row) => sum + row.spans.length, 0),
      },
    }),
  );
  await fs.writeFile(
    path.join(rootDir, 'data', 'dataset_texts.json'),
    JSON.stringify(Object.fromEntries(rows.map((row) => [
      row.document_id,
      { text: row.text, ...(row.metadata ?? {}) },
    ]))),
  );
  await fs.writeFile(
    path.join(rootDir, 'data', 'gold.jsonl'),
    `${rows.map((row) => JSON.stringify({
      document_id: row.document_id,
      spans: normalizedSpans(row),
    })).join('\n')}\n`,
  );

  if (importedRows) {
    const importDir = path.join(rootDir, 'data', 'subspan_annotations', 'imports');
    await fs.mkdir(importDir, { recursive: true });
    await fs.writeFile(
      path.join(importDir, 'confirmed_subannotations.jsonl'),
      `${importedRows.map((row) => JSON.stringify(row)).join('\n')}\n`,
    );
  }

  return rootDir;
}

test('store rejects retired identity metadata keys', async () => {
  for (const retiredKey of ['patient_name', 'caregiver_names']) {
    const rootDir = await fixture([{
      document_id: `doc-${retiredKey}`,
      text: 'Jan Peeters',
      metadata: { [retiredKey]: {} },
      spans: [{ begin: 0, end: 11, label: 'Name:Patient' }],
    }]);
    try {
      await assert.rejects(
        createProjectStore({ rootDir }),
        /Retired metadata key.*use patient and caregivers/,
      );
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  }
});

test('gold-only store proposes, confirms, persists, and exports one evaluation benchmark', async () => {
  const rootDir = await fixture([{
    document_id: 'doc1',
    text: 'Jan Peeters',
    spans: [{ begin: 0, end: 11, label: 'Name:Patient' }],
  }]);
  try {
    // Historical prediction files must have no effect on the public workflow.
    await fs.mkdir(path.join(rootDir, 'data', 'annotations'));
    await fs.writeFile(
      path.join(rootDir, 'data', 'annotations', 'doc1.jsonl'),
      '{"annotation_id":"model","spans":[{"begin":20,"end":30}]}\n',
    );

    const store = await createProjectStore({ rootDir });
    const initial = await store.getBootstrap();
    assert.equal(initial.items.length, 1);
    assert.equal(initial.progress.spans.confirmed, 0);
    assert.equal(Object.hasOwn(initial.progress.docs[0], 'machineOnlyItemCount'), false);
    assert.equal(Object.hasOwn(initial.progress.docs[0], 'sourceIds'), false);
    assert.equal(initial.items[0].saved.status, 'in_progress');
    assert.deepEqual(
      initial.items[0].saved.segments.map((segment) => segment.category),
      ['name_identifier', 'formatting', 'name_identifier'],
    );

    const saved = await store.saveItem({
      itemId: 'doc1::0',
      status: 'confirmed',
      segments: [
        { begin: 0, end: 3, category: 'given' },
        { begin: 3, end: 4, category: 'formatting' },
        { begin: 4, end: 11, category: 'family' },
      ],
    });
    assert.equal(saved.progress.spans.confirmed, 1);

    const combined = JSON.parse(
      (await fs.readFile(path.join(rootDir, 'data', 'subannotations.jsonl'), 'utf8')).trim(),
    );
    assert.equal(combined.document_id, 'doc1');
    assert.equal(combined.items.length, 1);

    const result = await store.exportEvaluationBundle();
    assert.equal(result.manifest.counts.documents, 1);
    assert.equal(result.manifest.annotation_source.annotations_sha256.length, 64);
    assert.equal(result.manifest.hashes.annotation_source_state_sha256.length, 64);
    const benchmark = JSON.parse(
      (await fs.readFile(path.join(rootDir, 'data', 'evaluation-bundle', 'benchmark.jsonl'), 'utf8')).trim(),
    );
    assert.equal(Object.hasOwn(benchmark, 'subannotations'), false);
    assert.equal(benchmark.spans[0].subannotations.length, 3);
    assert.deepEqual(
      benchmark.spans[0].subannotations.map((segment) => segment.category),
      ['given', 'formatting', 'family'],
    );
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test('candidate ranking, autodetection, and preprocessing diagnostics remain available for gold spans', async () => {
  const rootDir = await fixture([{
    document_id: 'doc1',
    text: 'Jan Peeters',
    spans: [{ begin: 0, end: 11, label: 'Name:Patient' }],
  }]);
  try {
    const store = await createProjectStore({ rootDir });
    await store.saveItem({
      itemId: 'doc1::0',
      status: 'in_progress',
      segments: [{ begin: 0, end: 11, category: 'additional_info' }],
    });

    const debug = await store.getItemPreprocessingDebug('doc1::0');
    assert.equal(Object.hasOwn(debug.item, 'itemKind'), false);
    assert.equal('attachedCandidates' in debug.item, false);
    assert.equal(debug.candidates[0].source, 'existing');
    assert.equal(debug.candidates[0].selected, true);
    assert.ok(debug.candidates.some((candidate) => candidate.source === 'annotation_seed'));
    assert.deepEqual(
      debug.candidates
        .filter((candidate) => candidate.source.startsWith('autodetect:'))
        .map((candidate) => candidate.source),
      [
        'autodetect:name_identifier',
        'autodetect:datetime_identifier',
        'autodetect:organization_identifier',
        'autodetect:address_identifier',
        'autodetect:id_identifier',
        'autodetect:contact_identifier',
      ],
    );
    assert.ok(debug.candidates.every((candidate) => Array.isArray(candidate.outcome.ruleTrace)));
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test('confirmed imports remain locked unless a reviewer deliberately bypasses the lock', async () => {
  const rootDir = await fixture(
    [{
      document_id: 'doc1',
      text: 'Jan',
      spans: [{ begin: 0, end: 3, label: 'Name:Patient' }],
    }],
    {
      importedRows: [{
        document_id: 'doc1',
        subannotations: [{ begin: 0, end: 3, category: 'given' }],
      }],
    },
  );
  try {
    const store = await createProjectStore({ rootDir });
    const initial = await store.getBootstrap();
    assert.deepEqual(initial.items[0].lockedRanges, [{ begin: 0, end: 3 }]);
    assert.equal(initial.items[0].lockSource, 'confirmed_import');

    const replacement = [{ begin: 0, end: 3, category: 'family' }];
    await assert.rejects(
      store.saveItem({ itemId: 'doc1::0', status: 'confirmed', segments: replacement }),
      /without holding Shift/,
    );
    const saved = await store.saveItem({
      itemId: 'doc1::0',
      status: 'confirmed',
      segments: replacement,
      lockBypass: true,
    });
    assert.equal(saved.item.saved.segments[0].category, 'family');
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test('store rejects non-canonical primary labels at input', async () => {
  const rootDir = await fixture([{
    document_id: 'doc1',
    text: 'Main Street',
    spans: [{ begin: 0, end: 11, label: 'Address_Street:Patient' }],
  }]);
  try {
    await assert.rejects(createProjectStore({ rootDir }), /unsupported label "Address_Street:Patient"/);
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test('bundle export requires every gold span to be confirmed', async () => {
  const rootDir = await fixture([{
    document_id: 'doc1',
    text: 'Jan',
    spans: [{ begin: 0, end: 3, label: 'Name:Patient' }],
  }]);
  try {
    const store = await createProjectStore({ rootDir });
    await assert.rejects(store.exportEvaluationBundle(), /1 gold span\(s\) are not confirmed/);
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test('store rejects primary annotations changed outside the update flow', async () => {
  const rootDir = await fixture([{
    document_id: 'doc1',
    text: 'Jan',
    spans: [{ begin: 0, end: 3, label: 'Name:Patient' }],
  }]);
  try {
    await fs.appendFile(path.join(rootDir, 'data', 'annotations.jsonl'), '\n');
    await assert.rejects(
      createProjectStore({ rootDir }),
      /no longer match the linked source state/,
    );
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test('store requires rebase when saved work belongs to another annotation source state', async () => {
  const rootDir = await fixture([{
    document_id: 'doc1',
    text: 'Jan',
    spans: [{ begin: 0, end: 3, label: 'Name:Patient' }],
  }]);
  try {
    const store = await createProjectStore({ rootDir });
    const item = (await store.getBootstrap()).items[0];
    await store.saveItem({
      itemId: item.itemId,
      status: 'confirmed',
      segments: [{ begin: 0, end: 3, category: 'given' }],
    });
    const savePath = path.join(rootDir, 'data', 'subspan_annotations', 'documents', 'doc1.json');
    const saved = JSON.parse(await fs.readFile(savePath, 'utf8'));
    saved.primaryGold.annotationsSha256 = '0'.repeat(64);
    await fs.writeFile(savePath, JSON.stringify(saved));
    await assert.rejects(
      createProjectStore({ rootDir }),
      /belongs to a different primary annotation source.*npm run rebase/,
    );
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test('gold items use stable span identities instead of list positions', async () => {
  const later = { begin: 4, end: 11, label: 'Name:Patient' };
  const firstRoot = await fixture([{
    document_id: 'doc1',
    text: 'Dr. Peeters',
    spans: [later],
  }]);
  const secondRoot = await fixture([{
    document_id: 'doc1',
    text: 'Dr. Peeters',
    spans: [{ begin: 0, end: 3, label: 'Name:Patient' }, later],
  }]);
  try {
    const first = await (await createProjectStore({ rootDir: firstRoot })).getBootstrap();
    const second = await (await createProjectStore({ rootDir: secondRoot })).getBootstrap();
    const firstId = first.items.find((item) => item.gold.begin === later.begin).itemId;
    const secondId = second.items.find((item) => item.gold.begin === later.begin).itemId;
    assert.match(firstId, /^span-[a-f0-9]{24}$/);
    assert.equal(firstId, secondId);
  } finally {
    await fs.rm(firstRoot, { recursive: true, force: true });
    await fs.rm(secondRoot, { recursive: true, force: true });
  }
});

test('canonical offsets count Unicode code points, including before a span', async () => {
  const rootDir = await fixture([{
    document_id: 'emoji-doc',
    text: '😀Jan',
    spans: [{ begin: 1, end: 4, label: 'Name:Patient', text: 'Jan' }],
  }]);
  try {
    const store = await createProjectStore({ rootDir });
    const initial = await store.getBootstrap();
    assert.equal(initial.items[0].reviewText, 'Jan');
    assert.equal(initial.items[0].goldTextMatchesDocument, true);
    const result = await store.saveItem({
      itemId: initial.items[0].itemId,
      status: 'confirmed',
      segments: [{ begin: 1, end: 4, category: 'given' }],
    });
    assert.equal(result.progress.spans.confirmed, 1);
    const exported = await store.exportEvaluationBundle();
    assert.equal(exported.manifest.counts.primary_gold_spans, 1);
    const benchmark = JSON.parse(
      (await fs.readFile(path.join(rootDir, 'data', 'evaluation-bundle', 'benchmark.jsonl'), 'utf8')).trim(),
    );
    assert.equal(benchmark.spans[0].subannotations[0].text, 'Jan');
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test('profile controls semantic rules, language validation, UI categories, and provenance', async () => {
  const profile = {
    ...neutralSubannotationProfile,
    profileId: 'test-XX',
    rulesetId: 'test-semantic-rules',
    languageTags: ['xx'],
    categoryGroups: { Name: ['person_part', 'layout'] },
    formattingCategory: 'layout',
    formattingPolicy: { symbols: ['~'], protectedDecimalCategories: [], decimalSeparators: [] },
    seedCategories: { Name: 'person_part' },
    autodetectCategories: ['person_part'],
    rules: [{
      ruleId: 'uppercase-person-part',
      transformSegment({ segment }) {
        return [{ ...segment, category: 'UPPER_PERSON' }];
      },
    }],
  };
  const rootDir = await fixture([{
    document_id: 'profile-doc',
    text: 'ALICE',
    metadata: { lang: 'xx' },
    spans: [{ begin: 0, end: 5, label: 'Name:Patient' }],
  }]);
  try {
    const store = await createProjectStore({ rootDir, subannotationProfile: profile });
    const bootstrap = await store.getBootstrap();
    assert.equal(bootstrap.meta.subannotationProfile.profileId, 'test-XX');
    assert.deepEqual(bootstrap.startingCategories, profile.categoryGroups);
    assert.equal(bootstrap.documents[0].language, 'xx');
    assert.deepEqual(
      bootstrap.items[0].saved.segments,
      [{ begin: 0, end: 5, category: 'UPPER_PERSON' }],
    );

    await store.saveItem({
      itemId: bootstrap.items[0].itemId,
      status: 'confirmed',
      segments: [{ begin: 0, end: 5, category: 'UPPER_PERSON' }],
    });
    const saved = JSON.parse(await fs.readFile(
      path.join(rootDir, 'data', 'subspan_annotations', 'documents', 'profile-doc.json'),
      'utf8',
    ));
    assert.equal(saved.subannotationProfile.sha256, bootstrap.meta.subannotationProfile.sha256);

    const exported = await store.exportEvaluationBundle();
    assert.equal(exported.manifest.subannotation_profile.profileId, 'test-XX');
    assert.equal(
      exported.manifest.contracts.subannotation_profile,
      'meddeid.subannotation-profile.v1',
    );
    await assert.rejects(
      createProjectStore({ rootDir }),
      /belongs to subannotation profile test-XX@1/,
    );
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test('language-specific profile rejects incompatible document metadata', async () => {
  const profile = {
    ...neutralSubannotationProfile,
    profileId: 'test-XX',
    languageTags: ['xx'],
  };
  const rootDir = await fixture([{
    document_id: 'wrong-language',
    text: 'Jan',
    metadata: { lang: 'nl' },
    spans: [{ begin: 0, end: 3, label: 'Name:Patient' }],
  }]);
  try {
    await assert.rejects(
      createProjectStore({ rootDir, subannotationProfile: profile }),
      /language "nl" is incompatible/,
    );
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});
