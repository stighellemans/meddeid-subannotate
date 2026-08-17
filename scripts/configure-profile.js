#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  migrateWorkspaceProfile,
  readProfileConfiguration,
  resolveWorkspaceSubannotationProfile,
  workspaceHasProfileDependentWork,
  workspaceWorkMatchesProfile,
  writeProfileConfiguration,
} from '../server/profile-configuration.js';
import {
  describeSubannotationProfile,
  discoverInstalledSubannotationProfiles,
  resolveSubannotationProfileDetails,
} from '../server/subannotation-profile.js';

const defaultRootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const args = {
    command: argv[0] ?? 'show',
    selection: null,
    moduleSpecifier: '',
    rootDir: defaultRootDir,
    dataDir: null,
  };
  let positionalSelection = false;
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--module') {
      args.moduleSpecifier = String(argv[++index] ?? '').trim();
    } else if (arg === '--root') {
      args.rootDir = path.resolve(argv[++index]);
    } else if (arg === '--data-dir') {
      args.dataDir = path.resolve(argv[++index]);
    } else if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (!arg.startsWith('-') && !positionalSelection) {
      args.selection = arg;
      positionalSelection = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  args.dataDir ??= process.env.MEDDEID_DATA_DIR
    ? path.resolve(process.env.MEDDEID_DATA_DIR)
    : path.join(args.rootDir, 'data');
  return args;
}

function printHelp() {
  console.log(`Usage: npm run profile -- <command> [PROFILE] [options]

Commands:
  show                         Show the effective workspace profile
  list                         List built-in and installed profiles
  set PROFILE                  Pin a profile for this workspace
  migrate PROFILE              Back up profile-dependent work and switch profiles

Options:
  --module SPECIFIER           Development-only module path or import specifier
  --data-dir DIR               Workspace data directory (default: data/)
  --root DIR                   Application root

Environment variables override the persisted selection at runtime. Use "set" for
the normal one-time workspace choice. Use "migrate" when review work already exists
or when accepting a changed implementation of the same profile version.
`);
}

async function resolveRequested(args) {
  if (!args.selection) throw new Error(`${args.command} requires PROFILE in <profile>@<version> form`);
  const existing = await readProfileConfiguration(args.dataDir);
  const configuredDevelopmentModule = !args.moduleSpecifier &&
    !existing?.package &&
    existing?.selection?.toLowerCase() === args.selection.toLowerCase()
    ? existing.module
    : '';
  return resolveSubannotationProfileDetails({
    selection: args.selection,
    moduleSpecifier: args.moduleSpecifier || configuredDevelopmentModule,
    rootDir: args.rootDir,
  });
}

async function show(args) {
  const resolution = await resolveWorkspaceSubannotationProfile({
    rootDir: args.rootDir,
    dataDir: args.dataDir,
  });
  console.log(JSON.stringify({
    selection: resolution.selection,
    selectionSource: resolution.selectionSource,
    module: resolution.moduleSpecifier,
    moduleSource: resolution.moduleSource,
    package: resolution.packageName
      ? { name: resolution.packageName, version: resolution.packageVersion || null }
      : null,
    descriptor: describeSubannotationProfile(resolution.profile),
    configurationPath: path.join(args.dataDir, 'subannotation-profile.json'),
  }, null, 2));
}

async function list(args) {
  const installed = await discoverInstalledSubannotationProfiles({ rootDir: args.rootDir });
  console.log('neutral@1\tbuilt-in\tmeddeid-subannotate');
  for (const registration of installed) {
    console.log(
      `${registration.selection}\tinstalled\t${registration.packageName}` +
      `${registration.packageVersion ? `@${registration.packageVersion}` : ''}`,
    );
  }
}

async function set(args) {
  const resolution = await resolveRequested(args);
  const existing = await readProfileConfiguration(args.dataDir);
  const targetHash = describeSubannotationProfile(resolution.profile).sha256;
  const configurationChanges = !existing ||
    existing.selection.toLowerCase() !== resolution.selection.toLowerCase() ||
    existing.descriptor?.sha256 !== targetHash;
  if (
    configurationChanges &&
    await workspaceHasProfileDependentWork(args.dataDir) &&
    !(await workspaceWorkMatchesProfile(args.dataDir, resolution.profile))
  ) {
    throw new Error(
      'this workspace already contains profile-dependent review work; use ' +
      `"npm run profile -- migrate ${resolution.selection}` +
      `${args.moduleSpecifier ? ` --module ${JSON.stringify(args.moduleSpecifier)}` : ''}" ` +
      'to create a recoverable backup before switching',
    );
  }
  const configuration = await writeProfileConfiguration(args.dataDir, resolution);
  console.log(`Pinned ${configuration.selection} in ${path.join(args.dataDir, 'subannotation-profile.json')}`);
}

async function migrate(args) {
  const resolution = await resolveRequested(args);
  const result = await migrateWorkspaceProfile({ dataDir: args.dataDir, resolution });
  console.log(`Pinned ${result.configuration.selection}`);
  if (result.archived.length > 0) {
    console.log(`Archived previous profile-dependent work in ${result.backupDir}`);
  } else {
    await fs.rm(result.backupDir, { recursive: true, force: true });
    console.log('No previous profile-dependent work required archiving.');
  }
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
  } else if (args.command === 'show') {
    await show(args);
  } else if (args.command === 'list') {
    await list(args);
  } else if (args.command === 'set') {
    await set(args);
  } else if (args.command === 'migrate') {
    await migrate(args);
  } else {
    throw new Error(`unknown command: ${args.command}`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
