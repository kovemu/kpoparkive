# Kpoparkive NamuWiki release runbook

## Deployment policy

Vercel Git auto-deployment is intentionally disabled in `vercel.json` because of deployment limits.

Do **not** re-enable automatic deployment as part of normal importer, renderer, translation, template, asset, or integration work.

Use one manual production deployment only after the full root scope passes prepublish QA and has been published.

## RESCENE core release

The public release unit is the article scope from `namu_raw_requirements` for the root, excluding `틀:` template dependencies.

For RESCENE this scope is expected to contain 21 article documents.

### 0. Dependency closeout before QA

Keep the local capture-helper bundle running so current source renders are automatically
upgraded to the latest compatibility/fallback versions and stale English drafts are
re-rendered:

```bash
npm run namu:capture-helper
```

In a second terminal, repair only files that are blocking the current 21-document
The Tree source render. This deliberately ignores historical/non-rendering unresolved
asset rows:

```bash
npm run namu:repair-assets -- --root RESCENE --limit 100
```

The browser worker uses the persistent normal Chrome profile. If NamuWiki displays a
human-verification screen, complete it in that visible browser; the safe worker pauses
all crawling until the challenge is stably cleared.

Do not substitute fake files/template stubs to make counters reach zero. The acceptance
state is the current source render itself: source missing templates/files/YouTube must
be zero, then every English revision must have a fresh render matching its current
revision number.

### 1. Prepublish integration gate

```bash
npm run namu:integration-qa -- RESCENE --prepublish --strict --expected-count=21
```

This allows `pending_publish` and same-batch core links that are not live yet, but still blocks:

- missing canonical RAW
- missing English revision
- failed translation status
- missing/stale source or English render
- stale source compatibility/engine patchset
- The Tree render error
- source or English missing template/file/YouTube dependencies
- NamuMark syntax leakage
- visible Korean link-label or visible Korean text leakage
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
