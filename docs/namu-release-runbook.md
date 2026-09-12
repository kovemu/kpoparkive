# Kpoparkive NamuWiki release runbook

## Deployment policy

Vercel Git auto-deployment is intentionally disabled in `vercel.json` because of deployment limits.

Do **not** re-enable automatic deployment as part of normal importer, renderer, translation, template, asset, or integration work.

Use one manual production deployment only after the full root scope passes prepublish QA and has been published.

## RESCENE core release

The public release unit is the article scope from `namu_raw_requirements` for the root, excluding `틀:` template dependencies.

For RESCENE this scope is expected to contain 21 article documents.

### 1. Prepublish integration gate

```bash
npm run namu:integration-qa -- RESCENE --prepublish --strict --expected-count=21
```

This allows `pending_publish` and same-batch core links that are not live yet, but still blocks:

- missing canonical RAW
- missing English revision
- failed translation status
- missing/stale render
- The Tree render error
- missing template/file/YouTube dependencies
- NamuMark syntax leakage
- visible Korean link-label leakage
- missing/non-English public display title

Do not publish if this command exits non-zero.

### 2. Publish the whole root scope

```bash
npm run namu:publish -- --root=RESCENE
```

The publisher resolves the root scope automatically, excludes template namespace documents, preflights every requested article before mutating live state, and aborts the whole requested release if any document fails validation.

### 3. Database-only post-publish gate

```bash
npm run namu:integration-qa -- RESCENE --skip-http --strict --expected-count=21
```

At this stage all 21 articles must have a published revision. Core links to another in-scope article must resolve to a published target.

### 4. Manual Vercel production deployment

Deploy the latest `main` exactly once through the normal manual production deployment workflow.

Do not change `git.deploymentEnabled` for this step.

### 5. Public HTTP acceptance gate

```bash
npm run namu:integration-qa -- RESCENE --strict --expected-count=21
```

This adds public route checks on top of the database/render checks. Published documents must return the public page successfully and unpublished placeholders/syntax leakage/external NamuWiki article links must not appear.

## Public read architecture

Public wiki pages, metadata, search, sitemap, and accepted recent activity use least-privilege Supabase publishable-key RPCs.

The underlying `source_documents`, `source_asset_queue`, and edit-proposal tables remain protected by RLS.

Public editing is disabled by default. It can be enabled later with:

```text
NEXT_PUBLIC_PUBLIC_EDITING_ENABLED=true
```

Only enable it after the public editor backend has been migrated away from the legacy service-role dependency and independently QA'd.
