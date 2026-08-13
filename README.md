# meddeid-subannotate

Local core-PII character subannotation for completed primary gold spans. The
application creates an initial complete subdivision, lets a reviewer correct
it, and exports confirmed nested subannotations for detailed evaluation. It
does not change primary spans or create false-positive review items.

See the [annotation workflow](https://meddeid.github.io/workflows/prepare-and-annotate/#6-add-core-pii-subannotations-only-for-evaluation)
for this tool's place in benchmark creation. This repository remains
authoritative for subannotation, rebasing, and bundle export.

Link either a completed single-reviewer file from `meddeid-annotate` or the
published gold file from `meddeid-curate`.

## Run locally

Requirements: Node.js 20 or later and npm.

```bash
npm install
MEDDEID_ANNOTATIONS_PATH=/path/to/annotations.jsonl npm run dev
```

The development server binds to `127.0.0.1`. The source path is remembered
after the first run. Every row must be marked `annotated: true` or
`completed: true`; any curation record must also be complete.

Input validation is strict. Every record must use the canonical `document_id`,
`text`, and `spans` fields. Unsupported alternatives such as `doc_id`,
`annotations`, `Category`, and `Subtype` are rejected.

The current result is written to `data/subannotations.jsonl`. Per-document
autosaves are managed under `data/subspan_annotations/`. Computer-filled
segments start as `in_progress`; only **Confirm and continue** marks a primary
span as reviewed.

## Docker

Mount the primary gold file read-only and keep the writable workspace separate:

```bash
docker build -t meddeid-subannotate .
docker run --rm -p 127.0.0.1:8787:8787 \
  -e MEDDEID_ANNOTATIONS_PATH=/input/annotations.jsonl \
  -v "$PWD/annotations.jsonl:/input/annotations.jsonl:ro" \
  -v "$PWD/subannotation-data:/app/data" meddeid-subannotate
```

The application does not provide authentication; keep it on localhost or place
it behind an authenticated TLS reverse proxy.

## Update corrected primary gold

After correcting and saving or publishing the linked primary file, open
**Annotation updates**, review the preservation summary, and select
**Apply and continue**. The UI compares the linked file’s SHA-256 with the
active copy and identifies items that require renewed review.

The same preview/apply operation is available from the command line:

```bash
npm run rebase -- --annotations /path/to/annotations.jsonl
npm run rebase -- --annotations /path/to/annotations.jsonl --write
```

Unchanged stable spans retain their subannotations. Shifted identical text can
retain translated offsets; boundary or label changes return to `in_progress`;
new spans enter the review queue; and removed spans are archived in the audit
report under `data/rebase-reports/`.

## Export an evaluation bundle

After every gold span is confirmed, run:

```bash
npm run bundle
```

The command writes:

```text
data/evaluation-bundle/manifest.json
data/evaluation-bundle/meddeid-dutch-synthetic-benchmark.jsonl
```

`meddeid-dutch-synthetic-benchmark.jsonl` preserves each primary span and nests
its confirmed,
contiguous subannotation partition beneath it. All offsets remain absolute
document offsets. The output can be scored directly:

```bash
meddeid-eval score \
  --gold data/evaluation-bundle/meddeid-dutch-synthetic-benchmark.jsonl \
  --predictions predictions.jsonl
```

The bundle manifest pins the benchmark, source annotations, and saved
subannotations by SHA-256. Export fails if a primary span is unconfirmed or
incompletely covered.

## Development

```bash
npm test
npm run test:browser
```

## Licence

AGPL-3.0-only.
