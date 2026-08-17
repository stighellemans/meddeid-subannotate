import fs from 'node:fs/promises';
import path from 'node:path';

import {
  describeSubannotationProfile,
  resolveSubannotationProfileDetails,
} from './subannotation-profile.js';

export const PROFILE_CONFIGURATION_CONTRACT = 'meddeid.subannotation-profile-selection.v1';
export const PROFILE_CONFIGURATION_FILENAME = 'subannotation-profile.json';

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export function profileConfigurationPath(dataDir) {
  return path.join(path.resolve(dataDir), PROFILE_CONFIGURATION_FILENAME);
}

export async function readProfileConfiguration(dataDir) {
  const filePath = profileConfigurationPath(dataDir);
  let configuration;
  try {
    configuration = JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new Error(`failed to read ${filePath}: ${error.message}`, { cause: error });
  }
  if (configuration?.contractVersion !== PROFILE_CONFIGURATION_CONTRACT) {
    throw new Error(
      `unsupported profile selection contract ${JSON.stringify(configuration?.contractVersion)} ` +
      `in ${filePath}; expected ${PROFILE_CONFIGURATION_CONTRACT}`,
    );
  }
  if (!String(configuration.selection ?? '').trim()) {
    throw new Error(`profile selection is missing from ${filePath}`);
  }
  return configuration;
}

export async function writeProfileConfiguration(dataDir, resolution) {
  const targetDir = path.resolve(dataDir);
  const filePath = profileConfigurationPath(targetDir);
  const descriptor = describeSubannotationProfile(resolution.profile);
  const configuration = {
    contractVersion: PROFILE_CONFIGURATION_CONTRACT,
    selection: resolution.selection,
    module: resolution.moduleSpecifier,
    package: resolution.packageName
      ? { name: resolution.packageName, version: resolution.packageVersion || null }
      : null,
    descriptor,
    updatedAt: new Date().toISOString(),
  };
  await fs.mkdir(targetDir, { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(configuration, null, 2)}\n`, 'utf8');
  await fs.rename(temporaryPath, filePath);
  return configuration;
}

export async function resolveWorkspaceSubannotationProfile({
  rootDir,
  dataDir,
  env = process.env,
  allowConfiguredProfileDrift = false,
} = {}) {
  const configuration = await readProfileConfiguration(dataDir);
  const environmentSelection = String(env.MEDDEID_SUBANNOTATION_PROFILE ?? '').trim();
  const environmentModule = String(env.MEDDEID_SUBANNOTATION_PROFILE_MODULE ?? '').trim();
  const selection = environmentSelection || configuration?.selection || 'neutral@1';
  const configurationApplies = !environmentSelection ||
    environmentSelection.toLowerCase() === configuration?.selection?.toLowerCase();
  const configuredModule = configurationApplies && !configuration?.package
    ? configuration?.module
    : '';
  const moduleSpecifier = environmentModule || configuredModule || '';
  const resolution = await resolveSubannotationProfileDetails({
    rootDir,
    selection,
    moduleSpecifier,
  });

  if (
    configurationApplies &&
    configuration?.descriptor?.sha256 &&
    configuration.descriptor.sha256 !== describeSubannotationProfile(resolution.profile).sha256 &&
    !allowConfiguredProfileDrift
  ) {
    throw new Error(
      `installed implementation for ${configuration.selection} differs from the version pinned in ` +
      `${profileConfigurationPath(dataDir)}; run "npm run profile -- migrate ${configuration.selection}" ` +
      'to archive existing review work and accept the new ruleset',
    );
  }

  return {
    ...resolution,
    configuration,
    selectionSource: environmentSelection ? 'environment' : configuration ? 'workspace' : 'default',
    moduleSource: environmentModule ? 'environment' : resolution.source,
  };
}

export async function workspaceHasProfileDependentWork(dataDir) {
  const targetDir = path.resolve(dataDir);
  for (const relativePath of [
    'subannotations.jsonl',
    'evaluation-bundle',
    path.join('subspan_annotations', 'categories.json'),
    path.join('subspan_annotations', 'imports'),
  ]) {
    if (await fileExists(path.join(targetDir, relativePath))) return true;
  }
  const documentsDir = path.join(targetDir, 'subspan_annotations', 'documents');
  try {
    if ((await fs.readdir(documentsDir)).some((name) => name.endsWith('.json'))) return true;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return false;
}

export async function workspaceWorkMatchesProfile(dataDir, profile) {
  const descriptor = describeSubannotationProfile(profile);
  const targetDir = path.resolve(dataDir);
  const documentsDir = path.join(targetDir, 'subspan_annotations', 'documents');
  let documentNames = [];
  try {
    documentNames = (await fs.readdir(documentsDir)).filter((name) => name.endsWith('.json'));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  let foundItems = false;
  for (const name of documentNames) {
    let saved;
    try {
      saved = JSON.parse(await fs.readFile(path.join(documentsDir, name), 'utf8'));
    } catch {
      return false;
    }
    if (Object.keys(saved.items ?? {}).length === 0) continue;
    foundItems = true;
    if (saved.subannotationProfile?.sha256) {
      if (saved.subannotationProfile.sha256 !== descriptor.sha256) return false;
    } else if (descriptor.profileId.toLowerCase() !== 'neutral' || descriptor.profileVersion !== '1') {
      return false;
    }
  }
  if (foundItems) return true;
  const unprovenancedArtifacts = [
    path.join(targetDir, 'subannotations.jsonl'),
    path.join(targetDir, 'subspan_annotations', 'categories.json'),
    path.join(targetDir, 'subspan_annotations', 'imports'),
  ];
  if (!(await Promise.all(unprovenancedArtifacts.map(fileExists))).some(Boolean)) return true;
  return descriptor.profileId.toLowerCase() === 'neutral' && descriptor.profileVersion === '1';
}

function timestamp() {
  return new Date().toISOString().replaceAll(':', '').replaceAll('.', '-');
}

export async function migrateWorkspaceProfile({ dataDir, resolution }) {
  const targetDir = path.resolve(dataDir);
  const previousConfiguration = await readProfileConfiguration(targetDir);
  const migrationsDir = path.join(targetDir, 'profile-migrations');
  const backupDir = path.join(
    migrationsDir,
    `${timestamp()}-${String(previousConfiguration?.selection ?? 'unconfigured').replaceAll('/', '_')}-to-` +
      resolution.selection.replaceAll('/', '_'),
  );
  const names = [
    PROFILE_CONFIGURATION_FILENAME,
    'subspan_annotations',
    'subannotations.jsonl',
    'evaluation-bundle',
  ];
  const moved = [];
  await fs.mkdir(backupDir, { recursive: true });
  try {
    for (const name of names) {
      const source = path.join(targetDir, name);
      if (!(await fileExists(source))) continue;
      await fs.rename(source, path.join(backupDir, name));
      moved.push(name);
    }
    const configuration = await writeProfileConfiguration(targetDir, resolution);
    const manifest = {
      migrationContract: 'meddeid.subannotation-profile-migration.v1',
      migratedAt: new Date().toISOString(),
      from: previousConfiguration,
      to: configuration,
      archived: moved,
    };
    await fs.writeFile(
      path.join(backupDir, 'migration.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
      'utf8',
    );
    return { backupDir, configuration, archived: moved };
  } catch (error) {
    await fs.rm(profileConfigurationPath(targetDir), { force: true });
    for (const name of [...moved].reverse()) {
      await fs.rename(path.join(backupDir, name), path.join(targetDir, name));
    }
    await fs.rm(backupDir, { recursive: true, force: true });
    throw error;
  }
}
