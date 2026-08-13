#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createProjectStore } from '../server/project-store.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const store = await createProjectStore({ rootDir });
const result = await store.exportEvaluationBundle();
console.log(`Evaluation bundle written to ${path.relative(rootDir, result.outputDir)}`);
console.log(JSON.stringify(result.manifest.counts, null, 2));
