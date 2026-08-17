import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { DEFAULT_FORMATTING_POLICY } from '../shared/formatting-symbols.js';

export const PROFILE_CONTRACT_VERSION = 'meddeid.subannotation-profile.v1';

const DEFAULT_CATEGORY_GROUPS = Object.freeze({
  general: Object.freeze(['formatting', 'medical_info', 'additional_info']),
  Name: Object.freeze(['name_identifier', 'given', 'family', 'initials', 'title']),
  Profession: Object.freeze(['hobby', 'profession', 'employment_state']),
  Organization: Object.freeze(['organization_identifier', 'company', 'institution', 'hospital_location']),
  Address_Location: Object.freeze(['address_identifier', 'country', 'region', 'municipality', 'postal_code', 'street', 'house_number', 'bus_number', 'postal_office']),
  Contactdetails: Object.freeze(['contact_identifier', 'internal_phone', 'public_phone', 'fax_number', 'given', 'family', 'initials', 'institution']),
  ID: Object.freeze(['id_identifier', 'public_id', 'internal_id']),
  Date: Object.freeze(['datetime_identifier', 'day', 'week', 'month', 'year', 'weekday', 'time', 'season']),
  Age_Birthdate: Object.freeze(['datetime_identifier', 'day', 'week', 'month', 'year', 'weekday', 'time', 'age_type', 'age_year', 'age_month', 'age_week', 'age_day']),
});

export const neutralSubannotationProfile = Object.freeze({
  contractVersion: PROFILE_CONTRACT_VERSION,
  profileId: 'neutral',
  profileVersion: '1',
  rulesetId: 'core-pii-neutral',
  rulesetVersion: '1',
  languageTags: Object.freeze([]),
  formattingCategory: 'formatting',
  formattingPolicy: DEFAULT_FORMATTING_POLICY,
  seedCategories: Object.freeze({
    Date: 'datetime_identifier',
    Age_Birthdate: 'datetime_identifier',
    Name: 'name_identifier',
    Address_Location: 'address_identifier',
    Organization: 'organization_identifier',
    Contactdetails: 'contact_identifier',
    ID: 'id_identifier',
  }),
  autodetectCategories: Object.freeze([
    'name_identifier',
    'datetime_identifier',
    'organization_identifier',
    'address_identifier',
    'id_identifier',
    'contact_identifier',
  ]),
  categoryGroups: DEFAULT_CATEGORY_GROUPS,
  rules: Object.freeze([]),
  resourceManifest: null,
  implementation: Object.freeze({ package: 'meddeid-subannotate', export: 'builtin:neutral' }),
});

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
  );
}

function nonEmptyString(value, field) {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw new TypeError(`subannotation profile ${field} must be non-empty`);
  return normalized;
}

export function describeSubannotationProfile(profile) {
  const descriptor = {
    contractVersion: nonEmptyString(profile?.contractVersion, 'contractVersion'),
    profileId: nonEmptyString(profile?.profileId, 'profileId'),
    profileVersion: nonEmptyString(profile?.profileVersion, 'profileVersion'),
    rulesetId: nonEmptyString(profile?.rulesetId, 'rulesetId'),
    rulesetVersion: nonEmptyString(profile?.rulesetVersion, 'rulesetVersion'),
    languageTags: [...(profile?.languageTags ?? [])].map(String),
    formattingCategory: nonEmptyString(profile?.formattingCategory, 'formattingCategory'),
    formattingPolicy: profile?.formattingPolicy ?? {},
    seedCategories: profile?.seedCategories ?? {},
    autodetectCategories: [...(profile?.autodetectCategories ?? [])].map(String),
    categoryGroups: profile?.categoryGroups ?? {},
    ruleIds: [...(profile?.rules ?? [])].map((rule) => nonEmptyString(rule?.ruleId, 'rule.ruleId')),
    resourceManifest: profile?.resourceManifest ?? null,
    implementation: profile?.implementation ?? null,
  };
  const canonical = canonicalize(descriptor);
  return {
    ...descriptor,
    sha256: crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex'),
  };
}

export function validateSubannotationProfile(profile) {
  const descriptor = describeSubannotationProfile(profile);
  if (descriptor.contractVersion !== PROFILE_CONTRACT_VERSION) {
    throw new TypeError(
      `unsupported subannotation profile contract ${JSON.stringify(descriptor.contractVersion)}; ` +
      `expected ${PROFILE_CONTRACT_VERSION}`,
    );
  }
  if (!profile.seedCategories || typeof profile.seedCategories !== 'object') {
    throw new TypeError('subannotation profile seedCategories must be an object');
  }
  if (!profile.categoryGroups || typeof profile.categoryGroups !== 'object') {
    throw new TypeError('subannotation profile categoryGroups must be an object');
  }
  const ruleIds = new Set();
  for (const rule of profile.rules ?? []) {
    if (typeof rule.transformSegment !== 'function') {
      throw new TypeError(`subannotation rule ${rule.ruleId} has no transformSegment function`);
    }
    if (ruleIds.has(rule.ruleId)) {
      throw new TypeError(`subannotation profile contains duplicate ruleId ${JSON.stringify(rule.ruleId)}`);
    }
    ruleIds.add(rule.ruleId);
  }
  return profile;
}

function normalizeTag(value) {
  return String(value ?? '').trim().replaceAll('_', '-').toLowerCase();
}

export function assertProfileAcceptsLanguage(profile, languageTag, context = 'document') {
  const normalized = normalizeTag(languageTag);
  if (!normalized || (profile.languageTags ?? []).length === 0) return;
  const supported = new Set(profile.languageTags.map(normalizeTag));
  if (!supported.has(normalized)) {
    throw new Error(
      `${context} language ${JSON.stringify(languageTag)} is incompatible with ` +
      `subannotation profile ${profile.profileId}@${profile.profileVersion}; ` +
      `expected one of: ${profile.languageTags.join(', ')}`,
    );
  }
}

export function parseProfileSelection(selection) {
  const value = String(selection ?? '').trim() || 'neutral@1';
  const separator = value.lastIndexOf('@');
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error(`invalid subannotation profile ${JSON.stringify(value)}; expected <profile>@<version>`);
  }
  return { profileId: value.slice(0, separator), profileVersion: value.slice(separator + 1) };
}

async function importProfileModule(specifier) {
  let importTarget = specifier;
  if (path.isAbsolute(specifier) || specifier.startsWith('./') || specifier.startsWith('../')) {
    importTarget = pathToFileURL(path.resolve(specifier)).href;
  }
  const loaded = await import(importTarget);
  return loaded.subannotationProfile ?? loaded.default;
}

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function installedPackageDirectories(rootDir) {
  const nodeModulesDir = path.join(rootDir, 'node_modules');
  let entries;
  try {
    entries = await fs.readdir(nodeModulesDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }

  const packageDirs = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const entryPath = path.join(nodeModulesDir, entry.name);
    if (entry.name.startsWith('@')) {
      let scopedEntries = [];
      try {
        scopedEntries = await fs.readdir(entryPath, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const scopedEntry of scopedEntries) {
        if (scopedEntry.isDirectory() || scopedEntry.isSymbolicLink()) {
          packageDirs.push(path.join(entryPath, scopedEntry.name));
        }
      }
    } else if (entry.isDirectory() || entry.isSymbolicLink()) {
      packageDirs.push(entryPath);
    }
  }
  return packageDirs;
}

export async function discoverInstalledSubannotationProfiles({ rootDir = process.cwd() } = {}) {
  const registrations = [];
  for (const packageDir of await installedPackageDirectories(path.resolve(rootDir))) {
    const manifest = await readJson(path.join(packageDir, 'package.json'));
    if (!manifest) continue;
    const packageRegistrations = Array.isArray(manifest.meddeid?.subannotationProfiles)
      ? manifest.meddeid.subannotationProfiles
      : [];
    for (const rawRegistration of packageRegistrations) {
      const selection = String(rawRegistration?.selection ?? '').trim();
      const module = String(rawRegistration?.module ?? '').trim();
      if (!selection || !module) continue;
      try {
        parseProfileSelection(selection);
      } catch {
        continue;
      }
      const moduleSpecifier = module.startsWith('.')
        ? pathToFileURL(path.resolve(packageDir, module)).href
        : module;
      registrations.push({
        selection,
        moduleSpecifier,
        packageName: String(manifest.name ?? path.basename(packageDir)),
        packageVersion: String(manifest.version ?? ''),
      });
    }
  }
  return registrations.sort(
    (left, right) => left.selection.localeCompare(right.selection) ||
      left.packageName.localeCompare(right.packageName),
  );
}

export async function resolveSubannotationProfileDetails({
  selection = process.env.MEDDEID_SUBANNOTATION_PROFILE || 'neutral@1',
  moduleSpecifier = process.env.MEDDEID_SUBANNOTATION_PROFILE_MODULE || '',
  rootDir = process.cwd(),
} = {}) {
  const requested = parseProfileSelection(selection);
  const canonicalSelection = `${requested.profileId}@${requested.profileVersion}`;
  if (requested.profileId.toLowerCase() === 'neutral' && requested.profileVersion === '1') {
    return {
      profile: neutralSubannotationProfile,
      selection: canonicalSelection,
      moduleSpecifier: null,
      source: 'builtin',
      packageName: 'meddeid-subannotate',
      packageVersion: null,
    };
  }

  const rawExplicitModule = String(moduleSpecifier ?? '').trim();
  const explicitModule = rawExplicitModule &&
    (path.isAbsolute(rawExplicitModule) || rawExplicitModule.startsWith('./') || rawExplicitModule.startsWith('../'))
    ? pathToFileURL(path.resolve(rootDir, rawExplicitModule)).href
    : rawExplicitModule;
  const installedMatches = explicitModule
    ? []
    : (await discoverInstalledSubannotationProfiles({ rootDir })).filter(
      (registration) => registration.selection.toLowerCase() === canonicalSelection.toLowerCase(),
    );
  if (installedMatches.length > 1) {
    throw new Error(
      `multiple installed packages provide subannotation profile ${canonicalSelection}: ` +
      `${installedMatches.map((item) => item.packageName).join(', ')}; ` +
      'select one explicitly with MEDDEID_SUBANNOTATION_PROFILE_MODULE',
    );
  }
  const registration = installedMatches[0] ?? null;
  const target = explicitModule || registration?.moduleSpecifier || '';
  if (!target) {
    throw new Error(
      `no installed package provides subannotation profile ${canonicalSelection}; ` +
      'install a package that registers meddeid.subannotationProfiles, or set ' +
      'MEDDEID_SUBANNOTATION_PROFILE_MODULE for source development',
    );
  }

  let profile;
  try {
    profile = validateSubannotationProfile(await importProfileModule(target));
  } catch (error) {
    throw new Error(
      `failed to load subannotation profile module ${JSON.stringify(target)}: ` +
      (error instanceof Error ? error.message : String(error)),
      { cause: error },
    );
  }
  if (
    profile.profileId.toLowerCase() !== requested.profileId.toLowerCase() ||
    String(profile.profileVersion) !== requested.profileVersion
  ) {
    throw new Error(
      `profile module provides ${profile.profileId}@${profile.profileVersion}, ` +
      `not requested ${requested.profileId}@${requested.profileVersion}`,
    );
  }
  return {
    profile,
    selection: canonicalSelection,
    moduleSpecifier: target,
    source: explicitModule ? 'explicit-module' : 'installed-package',
    packageName: registration?.packageName ?? null,
    packageVersion: registration?.packageVersion ?? null,
  };
}

export async function resolveSubannotationProfile(options = {}) {
  return (await resolveSubannotationProfileDetails(options)).profile;
}
