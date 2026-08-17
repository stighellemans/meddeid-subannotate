#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createProjectStore } from '../server/project-store.js';
import { resolveWorkspaceSubannotationProfile } from '../server/profile-configuration.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = process.env.MEDDEID_DATA_DIR
  ? path.resolve(process.env.MEDDEID_DATA_DIR)
  : path.join(rootDir, 'data');
const profileResolution = await resolveWorkspaceSubannotationProfile({ rootDir, dataDir });
const store = await createProjectStore({
  rootDir,
  dataDir,
  subannotationProfile: profileResolution.profile,
});
const result = await store.exportEvaluationBundle();
console.log(`Evaluation bundle written to ${path.relative(rootDir, result.outputDir)}`);
console.log(JSON.stringify(result.manifest.counts, null, 2));
