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

## Language and setting profiles

The application has a built-in `neutral@1` profile. It maps primary labels to
broad subannotation categories and separates structural formatting, but it does
not guess language-specific semantics. This is the default and has no language
package dependency.

Choose a profile once per workspace. The selection is written to
`data/subannotation-profile.json`, so subsequent `npm run dev`, `npm start`,
rebases, and bundle exports use the same pinned profile automatically:

```bash
npm run profile -- list
npm run profile -- set neutral@1
npm run profile -- show
```

For Dutch text in the Belgian context, install the JavaScript capability and
select it. Until `@meddeid/language-nl` is published to npm, a suite source
checkout can install the sibling package locally:

```bash
npm install --no-save ../meddeid-language-nl
npm run profile -- set nl-BE@1
npm run dev
```

The installed package self-registers `nl-BE@1`; no module path is needed.
During capability development, the equivalent one-time source-module setup is:

```bash
npm run profile -- set nl-BE@1 \
  --module ../meddeid-language-nl/js/subannotation-profile.js
```

`MEDDEID_SUBANNOTATION_PROFILE` and
`MEDDEID_SUBANNOTATION_PROFILE_MODULE` remain temporary runtime overrides for
CI and diagnostics. They take precedence over the workspace pin but are not
the normal interactive setup.

A profile supplies a versioned category presentation, primary-label seed map,
autodetection categories, formatting policy, ordered semantic rules, accepted
language tags, and hashed resources. The server validates document `lang`
metadata against the selected profile. Project saves and exported bundle
manifests pin the profile descriptor, resource hashes, and executable-module
hash.

Do not silently change profiles for an existing review workspace. `profile
set` refuses a change after profile-dependent work exists. Use a separate
`MEDDEID_DATA_DIR`, or run the explicit migration:

```bash
npm run profile -- migrate fr-FR@1
```

Migration moves the old profile pin, document saves, generated
`subannotations.jsonl`, and evaluation bundle into a timestamped
`data/profile-migrations/` backup. Review state is deliberately reset because
categories and suggestions may have changed. The same command accepts a
changed implementation hash for an existing profile version.

Third-party language packages can expose the same
`meddeid.subannotation-profile.v1` JavaScript contract. Institution-specific
rules should be published as a separately versioned profile or overlay rather
than added to the application core. Installed packages advertise capabilities
without application changes through their `package.json`:

```json
{
  "name": "@example/meddeid-language-fr",
  "meddeid": {
    "subannotationProfiles": [
      {
        "selection": "fr-FR@1",
        "module": "@example/meddeid-language-fr/subannotation"
      }
    ]
  }
}
```

Resolution order is: environment override, persisted workspace selection,
then built-in `neutral@1`. Non-neutral modules resolve from an explicit module
override first and otherwise from installed package registrations. Duplicate
registrations are rejected rather than selected ambiguously.

### Profile contract

A profile module exports `subannotationProfile` or a default object with:

- `contractVersion`: `meddeid.subannotation-profile.v1`;
- versioned `profileId`, `profileVersion`, `rulesetId`, and `rulesetVersion`;
- accepted `languageTags` (empty means language-neutral);
- `formattingCategory` and `formattingPolicy`;
- `seedCategories`, `autodetectCategories`, and grouped UI categories;
- an ordered `rules` list with unique `ruleId` values and
  `transformSegment({ item, segment, text, profile })` functions;
- a versioned, hashed `resourceManifest` and implementation identity when the
  profile consumes external data.

A rule returns `null` when it does not apply, or a complete ordered partition
of the input segment using absolute Unicode-code-point offsets. The application
validates and normalizes rule output, owns structural formatting splitting,
and records rule traces for diagnostics. Package tests should cover contract
validation, accepted document languages, deterministic suggestions, resource
hashes, and exact offset coverage.

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

The neutral image needs no additional build arguments. To include the current
source-checkout `nl-BE@1` capability, pack it into the Docker build context:

```bash
npm pack ../meddeid-language-nl --pack-destination profile-packages
docker build \
  --build-arg MEDDEID_SUBANNOTATION_PROFILE_PACKAGE=meddeid-language-nl-0.1.0.tgz \
  -t meddeid-subannotate:nl-be .

docker run --rm \
  -v "$PWD/subannotation-data:/app/data" \
  meddeid-subannotate:nl-be npm run profile -- set nl-BE@1
```

For a published profile, pass an immutable npm or Git package spec instead:

```bash
docker build \
  --build-arg MEDDEID_SUBANNOTATION_PROFILE_PACKAGE='@example/meddeid-language-fr@1.2.3' \
  -t meddeid-subannotate:fr .

docker run --rm \
  -v "$PWD/subannotation-data:/app/data" \
  meddeid-subannotate:fr npm run profile -- set fr-FR@1
```

The normal application container can then be started without a profile
environment variable; the mounted workspace retains the selection.

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
data/evaluation-bundle/benchmark.jsonl
```

`benchmark.jsonl` preserves each primary span and nests its confirmed,
contiguous subannotation partition beneath it. All offsets remain absolute
document offsets. The output can be scored directly:

```bash
meddeid-eval score \
  --gold data/evaluation-bundle/benchmark.jsonl \
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
