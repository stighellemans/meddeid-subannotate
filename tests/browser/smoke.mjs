import { execFile } from 'node:child_process';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { chromium } from 'playwright';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, '..', '..');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function startNode(args, env) {
  const child = spawn(process.execPath, args, {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  child.output = () => output;
  return child;
}

async function waitFor(url, process, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (process.exitCode !== null) {
      throw new Error(`Process exited before ${url} was ready:\n${process.output()}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${url}:\n${process.output()}`);
}

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'meddeid-subannotate-smoke-'));
const dataDir = path.join(tempDir, 'data');
const sourceDir = path.join(tempDir, 'annotation-source');
const inputPath = path.join(sourceDir, 'annotations.jsonl');
const apiPort = await freePort();
const clientPort = await freePort();
const row = {
    document_id: 'smoke-001',
    text: 'Jan Peeters',
    annotated: true,
    spans: [{ begin: 0, end: 11, text: 'Jan Peeters', label: 'Name:Patient', confirmed: true }],
    metadata: { lang: 'nl' },
    adjudication: { status: 'agreed', disagreements: [] },
};
await fs.mkdir(sourceDir, { recursive: true });
const inputPayload = `${JSON.stringify(row)}\n`;
await fs.writeFile(inputPath, inputPayload);

const nextRow = {
  ...row,
  text: 'XJan Peeters',
  spans: [{ begin: 1, end: 12, text: 'Jan Peeters', label: 'Name:Patient', confirmed: true }],
};
const nextInputPayload = `${JSON.stringify(nextRow)}\n`;

const commonEnv = {
  ...process.env,
  MEDDEID_DATA_DIR: dataDir,
  MEDDEID_ANNOTATIONS_PATH: inputPath,
};
await execFileAsync(process.execPath, ['server/prepare-data.js'], {
  cwd: repoRoot,
  env: commonEnv,
});
// The producer updates the same canonical file. The open workspace still holds
// the prepared original until the researcher reviews and applies the change.
await fs.writeFile(inputPath, nextInputPayload);

const api = startNode(['server/index.js'], {
  ...commonEnv,
  HOST: '127.0.0.1',
  PORT: String(apiPort),
});
const client = startNode(
  ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(clientPort)],
  { VITE_API_PROXY_TARGET: `http://127.0.0.1:${apiPort}` },
);

let browser;
try {
  await Promise.all([
    waitFor(`http://127.0.0.1:${apiPort}/api/health`, api),
    waitFor(`http://127.0.0.1:${clientPort}`, client),
  ]);
  if (process.env.MEDDEID_BROWSER_FIXTURE_ONLY === '1') {
    console.log(`Visual fixture ready: http://127.0.0.1:${clientPort}`);
    console.log(`Linked annotations: ${inputPath}`);
    await new Promise((resolve) => {
      process.once('SIGTERM', resolve);
      process.once('SIGINT', resolve);
    });
    process.exitCode = 0;
  } else {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${clientPort}`, { waitUntil: 'networkidle' });
  await page.getByText('Subspan Annotator', { exact: true }).waitFor();
  await page.getByText('smoke-001', { exact: false }).first().waitFor();
  const confirmButton = page.getByRole('button', { name: 'Confirm Item' });
  await confirmButton.waitFor();
  await confirmButton.click();
  await page.getByText(/Spans 1\/1/).waitFor();

  await page.evaluate(() => { window.__meddeidRebaseSmokeMarker = 'still-here'; });
  await page.getByRole('button', { name: 'Annotation updates' }).click();
  const dialog = page.getByRole('dialog', { name: 'Annotation updates' });
  await dialog.getByText(/effects of applying/).waitFor();
  await dialog.getByText('1', { exact: true }).first().waitFor();
  await dialog.getByRole('button', { name: 'Apply and continue' }).click();
  await dialog.getByText(/Update complete/).waitFor();
  if (await page.evaluate(() => window.__meddeidRebaseSmokeMarker) !== 'still-here') {
    throw new Error('Applying the primary-gold update reloaded the browser page');
  }
  await dialog.getByRole('button', { name: 'Continue annotating' }).click();
  await page.getByText(/Spans 1\/1/).waitFor();
  await page.getByRole('button', { name: 'Annotation updates' }).click();
  await dialog.getByText(/You are up to date/).waitFor();
  await dialog.getByRole('button', { name: 'Close' }).click();
  if (api.exitCode !== null) {
    throw new Error(`API process restarted or exited during rebase:\n${api.output()}`);
  }
  const installed = await fs.readFile(path.join(dataDir, 'annotations.jsonl'), 'utf8');
  if (installed !== nextInputPayload) {
    throw new Error('Expected the corrected canonical annotations to be installed');
  }
  console.log('Subannotation source-update browser smoke test passed without restart.');
  }
} finally {
  await browser?.close();
  api.kill('SIGTERM');
  client.kill('SIGTERM');
  await fs.rm(tempDir, { recursive: true, force: true });
}
