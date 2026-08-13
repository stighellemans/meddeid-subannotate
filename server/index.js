import express from 'express';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createProjectStore } from './project-store.js';
import { discoverCurrentAnnotations } from './primary-gold-source.js';
import { rebaseSubannotations } from '../scripts/rebase-subannotations.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = process.env.MEDDEID_DATA_DIR
  ? path.resolve(process.env.MEDDEID_DATA_DIR)
  : path.join(rootDir, 'data');

async function main() {
  let store = await createProjectStore({ rootDir, dataDir: DATA_DIR });
  let rebaseInProgress = false;
  const app = express();

  app.use(express.json({ limit: '2mb' }));

  app.use('/api', (req, res, next) => {
    if (
      rebaseInProgress &&
      req.method !== 'GET' &&
      !req.path.startsWith('/rebase/')
    ) {
      res.status(409).json({
        error: 'Primary-gold update in progress',
        detail: 'Please wait for the primary-gold update to finish before editing.',
      });
      return;
    }
    next();
  });

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.get('/api/bootstrap', async (_req, res) => {
    try {
      const payload = await store.getBootstrap();
      res.json(payload);
    } catch (error) {
      res.status(500).json({
        error: 'Failed to build bootstrap payload',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  });

  async function currentAnnotationsHash() {
    return (await fsPromises.readFile(path.join(DATA_DIR, 'annotations.sha256'), 'utf8')).trim();
  }

  app.post('/api/rebase/check', async (_req, res) => {
    if (rebaseInProgress) {
      res.status(409).json({
        error: 'Primary-gold update already in progress',
        detail: 'Wait for the current update to finish.',
      });
      return;
    }
    try {
      const [currentHash, latest] = await Promise.all([
        currentAnnotationsHash(),
        discoverCurrentAnnotations(DATA_DIR),
      ]);
      const upToDate = currentHash === latest.annotationsSha256;
      if (upToDate) {
        res.json({
          upToDate: true,
          sourceLabel: path.basename(latest.annotationsPath),
          report: null,
        });
        return;
      }
      const result = await rebaseSubannotations({
        rootDir,
        dataDir: DATA_DIR,
        annotationsPath: latest.annotationsPath,
        write: false,
      });
      res.json({
        upToDate: false,
        sourceLabel: path.basename(latest.annotationsPath),
        report: result.report,
      });
    } catch (error) {
      res.status(400).json({
        error: 'Failed to check for primary-gold updates',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.post('/api/rebase/apply', async (req, res) => {
    if (rebaseInProgress) {
      res.status(409).json({
        error: 'Primary-gold update already in progress',
        detail: 'Wait for the current update to finish.',
      });
      return;
    }
    rebaseInProgress = true;
    try {
      const latest = await discoverCurrentAnnotations(DATA_DIR);
      const expectedHash = String(req.body?.expectedAnnotationsSha256 ?? '');
      if (latest.annotationsSha256 !== expectedHash) {
        res.status(409).json({
          error: 'The linked annotations changed after preview',
          detail: 'Check for updates again before applying.',
        });
        return;
      }
      const result = await rebaseSubannotations({
        rootDir,
        dataDir: DATA_DIR,
        annotationsPath: latest.annotationsPath,
        write: true,
      });
      const nextStore = await createProjectStore({ rootDir, dataDir: DATA_DIR });
      store = nextStore;
      res.json({
        report: result.report,
        backupPath: result.backupDir ? path.relative(DATA_DIR, result.backupDir) : null,
        reportPath: result.reportPath ? path.relative(DATA_DIR, result.reportPath) : null,
        bootstrap: await store.getBootstrap(),
      });
    } catch (error) {
      res.status(400).json({
        error: 'Failed to update primary gold',
        detail: error instanceof Error ? error.message : String(error),
      });
    } finally {
      rebaseInProgress = false;
    }
  });

  app.post('/api/items/save', async (req, res) => {
    try {
      const { itemId, segments, status, lockBypass } = req.body ?? {};
      const result = await store.saveItem({ itemId, segments, status, lockBypass });
      res.json(result);
    } catch (error) {
      const statusCode =
        error && typeof error === 'object' && 'statusCode' in error
          ? Number(error.statusCode) || 500
          : 500;
      res.status(statusCode).json({
        error: 'Failed to save item',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.post('/api/categories/delete', async (req, res) => {
    try {
      const { category } = req.body ?? {};
      const result = await store.deleteCategory(category);
      res.json(result);
    } catch (error) {
      const statusCode =
        error && typeof error === 'object' && 'statusCode' in error
          ? Number(error.statusCode) || 500
          : 500;
      res.status(statusCode).json({
        error: 'Failed to delete category',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.post('/api/preprocess/rerun', async (_req, res) => {
    try {
      const result = await store.rerunPreprocessing();
      res.json(result);
    } catch (error) {
      const statusCode =
        error && typeof error === 'object' && 'statusCode' in error
          ? Number(error.statusCode) || 500
          : 500;
      res.status(statusCode).json({
        error: 'Failed to rerun preprocessing',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.post('/api/items/clear-all-labels', async (_req, res) => {
    try {
      const result = await store.clearAllLabels();
      res.json(result);
    } catch (error) {
      const statusCode =
        error && typeof error === 'object' && 'statusCode' in error
          ? Number(error.statusCode) || 500
          : 500;
      res.status(statusCode).json({
        error: 'Failed to clear all labels',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.post('/api/items/preprocess-debug', async (req, res) => {
    try {
      const { itemId } = req.body ?? {};
      const result = await store.getItemPreprocessingDebug(itemId);
      res.json(result);
    } catch (error) {
      const statusCode =
        error && typeof error === 'object' && 'statusCode' in error
          ? Number(error.statusCode) || 500
          : 500;
      res.status(statusCode).json({
        error: 'Failed to build preprocessing diagnostics',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.post('/api/bundle/export', async (_req, res) => {
    try {
      res.json(await store.exportEvaluationBundle());
    } catch (error) {
      const statusCode =
        error && typeof error === 'object' && 'statusCode' in error
          ? Number(error.statusCode) || 500
          : 500;
      res.status(statusCode).json({
        error: 'Failed to export evaluation bundle',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  });

  const distDir = path.join(rootDir, 'dist');
  if (fs.existsSync(path.join(distDir, 'index.html'))) {
    app.use(express.static(distDir));
    app.get('*', (_req, res) => res.sendFile(path.join(distDir, 'index.html')));
  }

  app.listen(PORT, HOST, () => {
    console.log(`MedDeID Subannotate listening on http://${HOST}:${PORT}`);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
