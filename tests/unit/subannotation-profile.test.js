import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  PROFILE_CONTRACT_VERSION,
  assertProfileAcceptsLanguage,
  describeSubannotationProfile,
  discoverInstalledSubannotationProfiles,
  neutralSubannotationProfile,
  resolveSubannotationProfileDetails,
  resolveSubannotationProfile,
  validateSubannotationProfile,
} from '../../server/subannotation-profile.js';
import {
  migrateWorkspaceProfile,
  readProfileConfiguration,
  resolveWorkspaceSubannotationProfile,
  writeProfileConfiguration,
} from '../../server/profile-configuration.js';

test('neutral profile is deterministic and accepts every document language', () => {
  const first = describeSubannotationProfile(neutralSubannotationProfile);
  const second = describeSubannotationProfile(neutralSubannotationProfile);
  assert.equal(first.contractVersion, PROFILE_CONTRACT_VERSION);
  assert.equal(first.sha256, second.sha256);
  assert.doesNotThrow(() => assertProfileAcceptsLanguage(neutralSubannotationProfile, 'fr-BE'));
});

test('resolver loads an external profile module and enforces requested identity', async () => {
  const temporaryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'subannotation-profile-'));
  const modulePath = path.join(temporaryDir, 'profile.mjs');
  try {
    await fs.writeFile(modulePath, `
      export default {
        contractVersion: 'meddeid.subannotation-profile.v1',
        profileId: 'test-XX',
        profileVersion: '7',
        rulesetId: 'test-rules',
        rulesetVersion: '3',
        languageTags: ['xx'],
        formattingCategory: 'layout',
        formattingPolicy: { symbols: ['~'] },
        seedCategories: { Name: 'person' },
        autodetectCategories: ['person'],
        categoryGroups: { Name: ['person'] },
        rules: [{ ruleId: 'noop', transformSegment() { return null; } }],
        resourceManifest: null
      };
    `);
    const profile = await resolveSubannotationProfile({
      selection: 'test-XX@7',
      moduleSpecifier: modulePath,
    });
    assert.equal(profile.seedCategories.Name, 'person');
    assert.throws(() => assertProfileAcceptsLanguage(profile, 'nl'), /incompatible/);
    await assert.rejects(
      resolveSubannotationProfile({ selection: 'test-XX@8', moduleSpecifier: modulePath }),
      /not requested/,
    );
  } finally {
    await fs.rm(temporaryDir, { recursive: true, force: true });
  }
});

test('invalid rule modules fail profile validation', () => {
  assert.throws(
    () => validateSubannotationProfile({
      ...neutralSubannotationProfile,
      rules: [{ ruleId: 'broken' }],
    }),
    /has no transformSegment/,
  );
  assert.throws(
    () => validateSubannotationProfile({
      ...neutralSubannotationProfile,
      rules: [
        { ruleId: 'duplicate', transformSegment() { return null; } },
        { ruleId: 'duplicate', transformSegment() { return null; } },
      ],
    }),
    /duplicate ruleId/,
  );
});

async function writeRegisteredTestPackage(rootDir) {
  const packageDir = path.join(rootDir, 'node_modules', '@example', 'language-xx');
  await fs.mkdir(packageDir, { recursive: true });
  await fs.writeFile(path.join(packageDir, 'package.json'), JSON.stringify({
    name: '@example/language-xx',
    version: '2.3.4',
    type: 'module',
    meddeid: {
      subannotationProfiles: [{ selection: 'xx-YY@3', module: './profile.js' }],
    },
  }));
  await fs.writeFile(path.join(packageDir, 'profile.js'), `
    export const subannotationProfile = {
      contractVersion: 'meddeid.subannotation-profile.v1',
      profileId: 'xx-YY',
      profileVersion: '3',
      rulesetId: 'example',
      rulesetVersion: '4',
      languageTags: ['xx-YY'],
      formattingCategory: 'formatting',
      formattingPolicy: {},
      seedCategories: { Name: 'person' },
      autodetectCategories: ['person'],
      categoryGroups: { Name: ['person'] },
      rules: [],
      resourceManifest: null
    };
  `);
}

test('installed language packages self-register profiles without application hard-coding', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'subannotation-installed-profile-'));
  try {
    await writeRegisteredTestPackage(rootDir);
    const registrations = await discoverInstalledSubannotationProfiles({ rootDir });
    assert.deepEqual(
      registrations.map(({ selection, packageName, packageVersion }) => ({
        selection,
        packageName,
        packageVersion,
      })),
      [{ selection: 'xx-YY@3', packageName: '@example/language-xx', packageVersion: '2.3.4' }],
    );
    const resolution = await resolveSubannotationProfileDetails({ selection: 'xx-YY@3', rootDir });
    assert.equal(resolution.source, 'installed-package');
    assert.equal(resolution.profile.rulesetVersion, '4');
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test('workspace profile selection persists and environment remains an override', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'subannotation-persisted-profile-'));
  const dataDir = path.join(rootDir, 'data');
  try {
    await writeRegisteredTestPackage(rootDir);
    const installed = await resolveSubannotationProfileDetails({ selection: 'xx-YY@3', rootDir });
    await writeProfileConfiguration(dataDir, installed);

    const persisted = await resolveWorkspaceSubannotationProfile({ rootDir, dataDir, env: {} });
    assert.equal(persisted.selection, 'xx-YY@3');
    assert.equal(persisted.selectionSource, 'workspace');

    const overridden = await resolveWorkspaceSubannotationProfile({
      rootDir,
      dataDir,
      env: { MEDDEID_SUBANNOTATION_PROFILE: 'neutral@1' },
    });
    assert.equal(overridden.selection, 'neutral@1');
    assert.equal(overridden.selectionSource, 'environment');
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test('profile migration archives dependent work and writes the new pin', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'subannotation-profile-migration-'));
  const dataDir = path.join(rootDir, 'data');
  try {
    await fs.mkdir(path.join(dataDir, 'subspan_annotations', 'documents'), { recursive: true });
    await fs.writeFile(
      path.join(dataDir, 'subspan_annotations', 'documents', 'doc.json'),
      '{"items":{"one":{}}}\n',
    );
    const neutral = await resolveSubannotationProfileDetails({ selection: 'neutral@1', rootDir });
    await writeProfileConfiguration(dataDir, neutral);
    await writeRegisteredTestPackage(rootDir);
    const target = await resolveSubannotationProfileDetails({ selection: 'xx-YY@3', rootDir });

    const migration = await migrateWorkspaceProfile({ dataDir, resolution: target });
    const configuration = await readProfileConfiguration(dataDir);
    assert.equal(configuration.selection, 'xx-YY@3');
    assert.ok(migration.archived.includes('subspan_annotations'));
    assert.ok(await fs.stat(path.join(migration.backupDir, 'subspan_annotations')));
    assert.ok(await fs.stat(path.join(migration.backupDir, 'migration.json')));
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});
