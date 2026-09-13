#!/usr/bin/env node

import {
  findVisibleKoreanLinkLabels,
  findVisibleKoreanText,
} from "./namu-english-link-localizer.mjs";
import {
  claimPipelineJob,
  nextRetryStatus,
  pipelineDb,
  requireServiceRole,
  updatePipelineJob,
} from "./lib/pipeline-db.mjs";

const args = process.argv.slice(2);
const valueArg = (name) => {
  const found = args.find((arg) => arg.startsWith("--" + name + "="));
  return found ? found.slice(name.length + 3) : "";
};

const runId = valueArg("run");
const once = args.includes("--once");
const skipHttp = args.includes("--skip-http");
const workerId =
  valueArg("worker-id") || "qa-" + process.pid + "-" + Date.now().toString(36);
const baseUrl = String(
  process.env.KPOPARKIVE_BASE_URL || "https://kpoparkive.vercel.app",
).replace(/\/$/, "");

if (!runId) {
  console.error("Usage: npm run namu:integration-worker -- --run=<pipeline-run-id> [--once]");
  process.exit(2);
}
requireServiceRole();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function metaCount(meta, countKey, arrayKey = countKey) {
  const numeric = Number(meta?.[countKey]);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  return Array.isArray(meta?.[arrayKey]) ? meta[arrayKey].length : 0;
}

function publicPath(title) {
  return "/w/" + String(title).split("/").map(encodeURIComponent).join("/");
}

function inspectHtml(html) {
  const value = String(html || "");
  const leaks = [];
  const checks = [
    ["raw-link", /\[\[[^\]]+\]\]/],
    ["include", /\[include\s*\(/i],
    ["wiki-directive", /\{\{\{#!/i],
    ["raw-table", /(?:^|[>\n])\|\|[^<\n]{1,300}\|\|/m],
  ];
  for (const [name, pattern] of checks) {
    if (pattern.test(value)) leaks.push(name);
  }
  return {
    leaks,
    absoluteNamuLinks: (
      value.match(/href=["']https:\/\/namu\.wiki\/w\//gi) || []
    ).length,
  };
}

async function fetchDocument(id) {
  const rows = await pipelineDb(
    "source_documents?id=eq." +
      encodeURIComponent(id) +
      "&select=id,source_title,translated_title,source_wikitext,source_namumark_meta,source_namumark_rendered_at,content_language,content_revision_no,content_wikitext,content_namumark_html,content_namumark_meta,content_namumark_rendered_at,published_revision_no,published_content_language,published_namumark_html&limit=1",
  );
  return rows?.[0] || null;
}

function validateDatabase(doc) {
  const blockers = [];

  if (!doc?.source_wikitext) blockers.push("missing_canonical_raw");
  if (!doc?.source_namumark_rendered_at) blockers.push("missing_source_render");

  const sourceMeta = doc?.source_namumark_meta;
  if (!sourceMeta || typeof sourceMeta !== "object") {
    blockers.push("missing_source_meta");
  } else {
    if (sourceMeta.hasError === true) blockers.push("source_render_error");
    if (String(sourceMeta?.compatibility?.version || "") !== "modern-namu-compat-v8") {
      blockers.push("source_compat_not_current");
    }
    const patchset = String(
      sourceMeta?.compatibility?.enginePatchset || sourceMeta?.enginePatchset || "",
    );
    if (patchset !== "modern-namu-v2") blockers.push("source_patchset_not_current");

    const sf = metaCount(sourceMeta, "missingFileCount", "missingFiles");
    const st = metaCount(sourceMeta, "missingTemplateCount", "missingTemplates");
    const sy = metaCount(sourceMeta, "missingYouTubeCount", "missingYouTubeEmbeds");
    if (sf) blockers.push("source_missing_files:" + sf);
    if (st) blockers.push("source_missing_templates:" + st);
    if (sy) blockers.push("source_missing_youtube:" + sy);
  }

  if (doc?.content_language !== "en" || !doc?.content_wikitext) {
    blockers.push("missing_english_revision");
  }

  const title = String(doc?.translated_title || "").trim();
  if (!title) blockers.push("missing_translated_title");
  else if (/[가-힣]/.test(title)) blockers.push("translated_title_contains_hangul");

  const revision = Number(doc?.content_revision_no || 0);
  const renderMeta = doc?.content_namumark_meta;
  if (!doc?.content_namumark_html || !doc?.content_namumark_rendered_at) {
    blockers.push("missing_english_render");
  }
  if (!renderMeta || typeof renderMeta !== "object") {
    blockers.push("missing_english_render_meta");
  } else {
    const renderedRevision = Number(renderMeta?.editableContent?.revisionNo || 0);
    if (renderedRevision !== revision) {
      blockers.push("stale_english_render:r" + renderedRevision + "->r" + revision);
    }
    if (renderMeta.hasError === true) blockers.push("english_render_error");
    const ef = metaCount(renderMeta, "missingFileCount", "missingFiles");
    const et = metaCount(renderMeta, "missingTemplateCount", "missingTemplates");
    const ey = metaCount(renderMeta, "missingYouTubeCount", "missingYouTubeEmbeds");
    if (ef) blockers.push("missing_files:" + ef);
    if (et) blockers.push("missing_templates:" + et);
    if (ey) blockers.push("missing_youtube:" + ey);
  }

  if (Number(doc?.published_revision_no || 0) !== revision || revision <= 0) {
    blockers.push(
      "published_revision_mismatch:r" +
        Number(doc?.published_revision_no || 0) +
        "->r" +
        revision,
    );
  }
  if (doc?.published_content_language !== "en" || !doc?.published_namumark_html) {
    blockers.push("missing_english_publish_snapshot");
  }

  const html = String(doc?.published_namumark_html || "");
  if (html) {
    const inspected = inspectHtml(html);
    if (inspected.leaks.length) blockers.push("published_syntax_leak:" + inspected.leaks.join("+"));
    if (inspected.absoluteNamuLinks) blockers.push("published_absolute_namu_links:" + inspected.absoluteNamuLinks);

    const koreanLinks = findVisibleKoreanLinkLabels(html, { limit: 50 });
    const koreanText = findVisibleKoreanText(html, { limit: 50 });
    if (koreanLinks.length) blockers.push("published_visible_korean_links:" + koreanLinks.length);
    if (koreanText.length) blockers.push("published_visible_korean_text:" + koreanText.length);
  }

  return blockers;
}

async function validateHttp(title) {
  const url = baseUrl + publicPath(title);
  const response = await fetch(url, {
    redirect: "manual",
    headers: { "user-agent": "kpoparkive-pipeline-qa/1.0" },
  });
  const html = await response.text();
  const blockers = [];

  if (response.status !== 200) blockers.push("http_status:" + response.status);
  if (
    /This document has not been published yet\.|This Kpoparkive document has not been imported yet\./.test(html)
  ) {
    blockers.push("public_placeholder");
  }

  const inspected = inspectHtml(html);
  if (inspected.leaks.length) blockers.push("public_syntax_leak:" + inspected.leaks.join("+"));
  if (inspected.absoluteNamuLinks) blockers.push("public_absolute_namu_links:" + inspected.absoluteNamuLinks);

  return { url, status: response.status, blockers };
}

async function fetchStageJob(job, stage) {
  const rows = await pipelineDb(
    "pipeline_jobs?run_id=eq." +
      encodeURIComponent(job.run_id) +
      "&source_document_id=eq." +
      encodeURIComponent(job.source_document_id) +
      "&stage=eq." +
      encodeURIComponent(stage) +
      "&select=*" +
      "&limit=1",
  );

  return rows?.[0] || null;
}

function classifyBlockers(blockers) {
  if (
    blockers.some(
      (value) =>
        value.startsWith("missing_canonical_raw") ||
        value.startsWith("missing_source_render") ||
        value.startsWith("missing_source_meta") ||
        value.startsWith("source_render_error") ||
        value.startsWith("source_compat_not_current") ||
        value.startsWith("source_patchset_not_current") ||
        value.startsWith("source_missing_files:") ||
        value.startsWith("source_missing_templates:") ||
        value.startsWith("source_missing_youtube:") ||
        value.startsWith("missing_files:") ||
        value.startsWith("missing_templates:") ||
        value.startsWith("missing_youtube:"),
    )
  ) {
    return "source_render";
  }

  if (
    blockers.some(
      (value) =>
        value.startsWith("missing_english_revision") ||
        value.startsWith("missing_translated_title") ||
        value.startsWith("translated_title_contains_hangul") ||
        value.startsWith("published_visible_korean_") ||
        value.startsWith("published_syntax_leak:") ||
        value.startsWith("public_syntax_leak:"),
    )
  ) {
    return "translation";
  }

  if (
    blockers.some(
      (value) =>
        value.startsWith("missing_english_render") ||
        value.startsWith("missing_english_render_meta") ||
        value.startsWith("stale_english_render:") ||
        value.startsWith("english_render_error"),
    )
  ) {
    return "en_render";
  }

  if (
    blockers.some(
      (value) =>
        value.startsWith("published_revision_mismatch:") ||
        value.startsWith("missing_english_publish_snapshot") ||
        value.startsWith("public_placeholder") ||
        value.startsWith("http_status:"),
    )
  ) {
    return "publish";
  }

  return "";
}

async function routeBack(job, stage, blockers) {
  const target = await fetchStageJob(job, stage);

  if (!target) {
    throw new Error("cannot_route_back_missing_stage:" + stage);
  }

  const checkpoint =
    target.checkpoint && typeof target.checkpoint === "object"
      ? target.checkpoint
      : {};

  await updatePipelineJob(target.id, {
    status: "retry",
    locked_by: null,
    locked_at: null,
    finished_at: null,
    last_error: "integration_feedback:" + blockers.join("|"),
    checkpoint:
      stage === "translation"
        ? {
            ...checkpoint,
            forceRetranslate: true,
            integrationFeedback: blockers,
          }
        : checkpoint,
  });

  await updatePipelineJob(job.id, {
    status: "skipped",
    locked_by: null,
    locked_at: null,
    last_error:
      "routed_back_to_" + stage + ":" + blockers.join("|"),
    finished_at: new Date().toISOString(),
  });

  await refreshRun();
}

async function fail(job, error) {
  const status = nextRetryStatus(job);
  await updatePipelineJob(job.id, {
    status,
    locked_by: null,
    locked_at: null,
    last_error: String(error?.message || error).slice(0, 4000),
    ...(status === "needs_review" ? { finished_at: new Date().toISOString() } : {}),
  });
  await refreshRun();
}

async function refreshRun() {
  const runRows = await pipelineDb(
    "pipeline_runs?id=eq." +
      encodeURIComponent(runId) +
      "&select=id,scope_count,status&limit=1",
  );
  const run = runRows?.[0];
  if (!run) return;

  const jobs = await pipelineDb(
    "pipeline_jobs?run_id=eq." +
      encodeURIComponent(runId) +
      "&select=source_document_id,stage,status",
  );

  const completed = new Set(
    (jobs || [])
      .filter((job) => job.stage === "integration_qa" && job.status === "pass")
      .map((job) => job.source_document_id),
  ).size;
  const failed = new Set(
    (jobs || [])
      .filter((job) => job.status === "failed")
      .map((job) => job.source_document_id),
  ).size;
  const review = new Set(
    (jobs || [])
      .filter((job) => job.status === "needs_review")
      .map((job) => job.source_document_id),
  ).size;

  const scope = Number(run.scope_count || 0);
  const isComplete = scope > 0 && completed >= scope && failed === 0 && review === 0;
  const now = new Date().toISOString();

  await pipelineDb("pipeline_runs?id=eq." + encodeURIComponent(runId), {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      status: isComplete ? "completed" : "running",
      completed_count: completed,
      failed_count: failed,
      review_count: review,
      updated_at: now,
      ...(isComplete ? { finished_at: now } : {}),
    }),
  });
}

console.log(
  "Kpoparkive Integration QA Worker · " +
    workerId +
    " · run=" +
    runId +
    (skipHttp ? " · HTTP=off" : " · HTTP=on"),
);

while (true) {
  const job = await claimPipelineJob(runId, workerId, "integration_qa");
  if (!job) {
    await refreshRun();
    if (once) break;
    await sleep(5000);
    continue;
  }

  try {
    const doc = await fetchDocument(job.source_document_id);
    if (!doc) throw new Error("source_document_not_found");

    const blockers = validateDatabase(doc);
    let route = null;

    if (!skipHttp && blockers.length === 0) {
      route = await validateHttp(doc.source_title);
      blockers.push(...route.blockers);
    }

    if (blockers.length) {
      const routeBackStage = classifyBlockers(blockers);

      if (routeBackStage) {
        console.log(
          "INTEGRATION ROUTE " +
            doc.source_title +
            " → " +
            routeBackStage +
            " · " +
            blockers.join("|"),
        );

        await routeBack(job, routeBackStage, blockers);

        if (once) break;
        continue;
      }

      throw new Error(
        "integration_qa_failed:" + blockers.join("|"),
      );
    }

    await updatePipelineJob(job.id, {
      status: "pass",
      locked_by: null,
      locked_at: null,
      last_error: null,
      checkpoint: {
        databaseQa: "pass",
        httpQa: skipHttp ? "skipped" : "pass",
        routeStatus: route?.status || null,
        routeUrl: route?.url || null,
        completedAt: new Date().toISOString(),
      },
      finished_at: new Date().toISOString(),
    });

    await refreshRun();
    console.log("INTEGRATION PASS " + doc.source_title);
  } catch (error) {
    console.error("INTEGRATION FAILED " + job.source_title + " · " + String(error?.message || error));
    await fail(job, error);
  }

  if (once) break;
}
