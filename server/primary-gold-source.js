import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const ANNOTATION_SOURCE_VERSION = 'meddeid.annotation-source.v1';

export function buildAnnotationSourceRecord(annotationsPath) {
  return {
    source_version: ANNOTATION_SOURCE_VERSION,
    annotations_path: path.resolve(annotationsPath),
    linked_at: new Date().toISOString(),
  };
}

export async function discoverCurrentAnnotations(dataDir) {
  const sourcePath = path.join(dataDir, 'annotation-source.json');
  let source;
  try {
    source = JSON.parse(await fs.readFile(sourcePath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(
        'This workspace is not linked to annotations.jsonl. Run prepare:data once with MEDDEID_ANNOTATIONS_PATH.',
      );
    }
    throw error;
  }
  if (source.source_version !== ANNOTATION_SOURCE_VERSION) {
    throw new Error(`Unsupported annotation source record: ${source.source_version ?? 'missing'}`);
  }
  const annotationsPath = path.resolve(String(source.annotations_path ?? ''));
  const annotations = await fs.readFile(annotationsPath).catch((error) => {
    if (error?.code === 'ENOENT') {
      throw new Error(`Linked annotations file no longer exists: ${annotationsPath}`);
    }
    throw error;
  });
  return {
    source,
    annotationsPath,
    annotationsSha256: crypto.createHash('sha256').update(annotations).digest('hex'),
  };
}
