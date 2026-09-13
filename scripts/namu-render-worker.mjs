#!/usr/bin/env node

import { spawn } from "node:child_process";
import path from "node:path";
import {
  findVisibleKoreanLinkLabels,
  findVisibleKoreanText,
} from "./namu-english-link-localizer.mjs";
import {
  claimPipelineJob,
  enqueuePipelineStage,
  nextRetryStatus,
  pipelineDb,
  requireServiceRole,
  updatePipelineJob,
} from "./lib/pipeline-db.mjs";

const ROOT = process.cwd();
const args = process.argv.slice(2);

const valueArg = (name) => {
  const found = args.find((arg) => arg.startsWith("--" + name + "="));
  return found ? found.slice(name.length + 3) : "";
};

const runId = valueArg("run");
const once = args.includes("--once");
const workerId =
  valueArg("worker-id") ||
  "render-" + process.pid + "-" + Date.now().toString(36);
const staleMinutes = Math.max(
  15,
  Number(valueArg("stale-minutes") || 60) || 60,
);

if (!runId) {
  console.error(
    "Usage: npm run namu:render-worker -- --run=<pipeline-run-id> [--once]",
  );
  process.exit(2);
}

requireServiceRole();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTemplateTitle(title) {
  return /^(?:틀|Template):/i.test(String(title || ""));
}

function metaCount(meta, countKey, arrayKey = countKey) {
  if (!meta || typeof meta !== "object") return 0;
  const numeric = Number(meta[countKey]);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  return Array.isArray(meta[arrayKey]) ? meta[arrayKey].length : 0;
}

function inspectHtml(html) {
  const value = String(html || "");
  const leaks = [];
  const checks = [
    ["raw-link", /\[\[[^\]]+\]\]/],
    ["include", /\[include\s*\(/i],
    ["wiki-directive", /\{\{\{#!/i],
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

async function recoverStaleJobs() {
  const cutoff = new Date(Date.now() - staleMinutes * 60_000).toISOString();

  const rows =
    (await pipelineDb(
      "pipeline_jobs?run_id=eq." +
        encodeURIComponent(runId) +
        "&stage=eq.en_render" +
        "&status=eq.running" +
        "&locked_at=lt." +
        encodeURIComponent(cutoff) +
        "&select=id,source_title,locked_by",
    )) || [];

  for (const row of rows) {
    await updatePipelineJob(row.id, {
      status: "retry",
      locked_by: null,
      locked_at: null,
      last_error:
        "Recovered stale render lease from " +
        (row.locked_by || "unknown"),
    });
  }

  return rows.length;
}

async function fetchDocument(id) {
  const rows = await pipelineDb(
    "source_documents?id=eq." +
      encodeURIComponent(id) +
      "&select=id,root_title,source_title,content_language,content_revision_no,content_wikitext,content_namumark_html,content_namumark_meta,content_namumark_rendered_at,translation_status" +
      "&limit=1",
  );

  return rows?.[0] || null;
}

async function fetchDocuments(ids) {
  const result = [];

  for (let index = 0; index < ids.length; index += 40) {
    const batch = ids.slice(index, index + 40);
    if (!batch.length) continue;

    const rows =
      (await pipelineDb(
        "source_documents?id=in." +
          encodeURIComponent("(" + batch.join(",") + ")") +
          "&select=id,root_title,source_title,content_language,content_revision_no,content_wikitext,content_namumark_html,content_namumark_meta,content_namumark_rendered_at,translation_status",
      )) || [];

    result.push(...rows);
  }

  return result;
}

function runRenderer(title) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--no-node-snapshot",
        path.resolve(ROOT, "scripts/namumark-thetree-content.mjs"),
        title,
      ],
      {
        cwd: ROOT,
        env: {
          ...process.env,
          KPOPARKIVE_RENDER_LANGUAGE: "en",
        },
        stdio: ["ignore", "inherit", "inherit"],
      },
    );

    child.once("error", reject);

    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else {
        reject(
          new Error(
            "renderer exited code=" +
              String(code ?? "null") +
              " signal=" +
              String(signal || "none"),
          ),
        );
      }
    });
  });
}

function validateRendered(doc, expectedRevision) {
  const blockers = [];
  const html = String(doc?.content_namumark_html || "");

  if (doc?.content_language !== "en") {
    blockers.push("content_language_not_en");
  }
  if (!doc?.content_wikitext) {
    blockers.push("missing_content_wikitext");
  }
  if (html.length < 100) {
    blockers.push("missing_current_render");
  }
  if (!doc?.content_namumark_rendered_at) {
    blockers.push("missing_render_timestamp");
  }

  const meta =
    doc?.content_namumark_meta &&
    typeof doc.content_namumark_meta === "object"
      ? doc.content_namumark_meta
      : null;

  if (!meta) {
    blockers.push("missing_render_meta");
  } else {
    const renderedRevision =
      Number(meta?.editableContent?.revisionNo || 0) || 0;

    if (renderedRevision !== Number(expectedRevision || 0)) {
      blockers.push(
        "stale_render:r" +
          renderedRevision +
          "->r" +
          Number(expectedRevision || 0),
      );
    }

    if (meta.hasError === true) blockers.push("render_error");

    const missingFiles = metaCount(
      meta,
      "missingFileCount",
      "missingFiles",
    );
    const missingTemplates = metaCount(
      meta,
      "missingTemplateCount",
      "missingTemplates",
    );
    const missingYoutube = metaCount(
      meta,
      "missingYouTubeCount",
      "missingYouTubeEmbeds",
    );

    if (missingFiles > 0) {
      blockers.push("missing_files:" + missingFiles);
    }
    if (missingTemplates > 0) {
      blockers.push("missing_templates:" + missingTemplates);
    }
    if (missingYoutube > 0) {
      blockers.push("missing_youtube:" + missingYoutube);
    }
  }

  if (html) {
    const inspected = inspectHtml(html);

    if (inspected.leaks.length > 0) {
      blockers.push("syntax_leak:" + inspected.leaks.join("+"));
    }

    if (inspected.absoluteNamuLinks > 0) {
      blockers.push(
        "absolute_namuwiki_links:" + inspected.absoluteNamuLinks,
      );
    }

    const koreanLinks = findVisibleKoreanLinkLabels(html, { limit: 50 });
    if (koreanLinks.length > 0) {
      blockers.push("visible_korean_links:" + koreanLinks.length);
    }

    const koreanText = findVisibleKoreanText(html, { limit: 50 });
    if (koreanText.length > 0) {
      blockers.push("visible_korean_text:" + koreanText.length);
    }
  }

  return { ok: blockers.length === 0, blockers };
}

async function templateDependenciesReady(rootTitle) {
  const requirements =
    (await pipelineDb(
      "namu_raw_requirements?root_title=eq." +
        encodeURIComponent(rootTitle) +
        "&status=neq.ignored" +
        "&select=source_document_id,source_title",
    )) || [];

  const templateRequirements = requirements.filter((row) =>
    isTemplateTitle(row.source_title),
  );

  if (!templateRequirements.length) {
    return { ready: true, missing: [] };
  }

  const ids = [
    ...new Set(
      templateRequirements
        .map((row) => row.source_document_id)
        .filter(Boolean),
    ),
  ];

  const docs = await fetchDocuments(ids);
  const byId = new Map(docs.map((doc) => [doc.id, doc]));
  const missing = [];

  for (const requirement of templateRequirements) {
    const doc = byId.get(requirement.source_document_id);

    if (!doc) {
      missing.push({
        title: requirement.source_title,
        reason: "document_missing",
      });
      continue;
    }

    const revision = Number(doc.content_revision_no || 0);
    const qa = validateRendered(doc, revision);

    if (
      revision <= 0 ||
      doc.content_language !== "en" ||
      !["translated_by_chatgpt", "reviewed"].includes(
        String(doc.translation_status || ""),
      ) ||
      !qa.ok
    ) {
      missing.push({
        title: requirement.source_title,
        reason:
          revision <= 0
            ? "english_revision_missing"
            : qa.blockers.join("|") || "translation_not_ready",
      });
    }
  }

  const terminalJobs =
    ids.length > 0
      ? (
          (await pipelineDb(
            "pipeline_jobs?run_id=eq." +
              encodeURIComponent(runId) +
              "&source_document_id=in." +
              encodeURIComponent("(" + ids.join(",") + ")") +
              "&status=in.(needs_review,failed)" +
              "&select=source_document_id,source_title,stage,status,last_error",
          )) || []
        )
      : [];

  return {
    ready: missing.length === 0,
    missing,
    terminalJobs,
  };
}

async function deferForTemplates(job, rootTitle) {
  const state = await templateDependenciesReady(rootTitle);

  if (state.ready) return "ready";

  if (state.terminalJobs.length > 0) {
    await updatePipelineJob(job.id, {
      status: "skipped",
      locked_by: null,
      locked_at: null,
      last_error:
        "blocked_by_template_review:" +
        state.terminalJobs
          .slice(0, 8)
          .map((item) => item.source_title + ":" + item.stage)
          .join(","),
      finished_at: new Date().toISOString(),
    });

    return "blocked";
  }

  await updatePipelineJob(job.id, {
    status: "queued",
    attempt: Math.max(0, Number(job.attempt || 1) - 1),
    locked_by: null,
    locked_at: null,
    last_error:
      "waiting_for_template_dependencies:" +
      state.missing
        .slice(0, 12)
        .map((item) => item.title)
        .join(","),
  });

  return "waiting";
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

async function routeBack(job, stage, blockers) {
  const target = await fetchStageJob(job, stage);

  if (!target) {
    throw new Error(
      "cannot_route_back_missing_stage:" + stage,
    );
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
    last_error:
      "downstream_render_feedback:" + blockers.join("|"),
    checkpoint:
      stage === "translation"
        ? {
            ...checkpoint,
            forceRetranslate: true,
            renderFeedback: blockers,
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
}

function classifyRoute(blockers) {
  if (
    blockers.some(
      (value) =>
        value.startsWith("visible_korean_") ||
        value.startsWith("syntax_leak:"),
    )
  ) {
    return "translation";
  }

  if (
    blockers.some(
      (value) =>
        value.startsWith("missing_files:") ||
        value.startsWith("missing_templates:") ||
        value.startsWith("missing_youtube:"),
    )
  ) {
    return "source_render";
  }

  return "";
}

async function failOrRetry(job, error) {
  const status = nextRetryStatus(job);

  await updatePipelineJob(job.id, {
    status,
    locked_by: null,
    locked_at: null,
    last_error: String(
      error?.message || error || "render failed",
    ).slice(0, 4000),
    ...(status === "needs_review"
      ? { finished_at: new Date().toISOString() }
      : {}),
  });
}

const recovered = await recoverStaleJobs();

if (recovered > 0) {
  console.log("Recovered " + recovered + " stale render job(s).");
}

console.log(
  "Kpoparkive English Render Worker · " +
    workerId +
    " · run=" +
    runId,
);

while (true) {
  const job = await claimPipelineJob(
    runId,
    workerId,
    "en_render",
  );

  if (!job) {
    if (once) break;
    await sleep(5000);
    continue;
  }

  const before = await fetchDocument(job.source_document_id);

  if (!before) {
    await failOrRetry(
      job,
      new Error("source_document_not_found"),
    );

    if (once) break;
    continue;
  }

  const templateDocument = isTemplateTitle(before.source_title);

  try {
    if (!templateDocument) {
      const dependencyState = await deferForTemplates(
        job,
        before.root_title,
      );

      if (dependencyState !== "ready") {
        console.log(
          (dependencyState === "blocked" ? "RENDER BLOCKED " : "RENDER WAIT ") +
            before.source_title +
            " · template dependencies not ready",
        );

        if (dependencyState === "waiting") {
          await sleep(1200);
        }

        if (once) break;
        continue;
      }
    }

    const expectedRevision = Number(
      before.content_revision_no || 0,
    );

    console.log(
      "RENDER " +
        before.source_title +
        " · r" +
        expectedRevision +
        " · attempt=" +
        job.attempt +
        "/" +
        job.max_attempts,
    );

    if (
      before.content_language !== "en" ||
      !before.content_wikitext ||
      expectedRevision <= 0
    ) {
      throw new Error("english_revision_not_ready");
    }

    await runRenderer(before.source_title);

    const after = await fetchDocument(job.source_document_id);

    if (!after) {
      throw new Error("document_disappeared_after_render");
    }

    if (
      Number(after.content_revision_no || 0) !==
      expectedRevision
    ) {
      throw new Error(
        "content_revision_changed_during_render:r" +
          expectedRevision +
          "->r" +
          Number(after.content_revision_no || 0),
      );
    }

    const qa = validateRendered(after, expectedRevision);

    if (!qa.ok) {
      const route = classifyRoute(qa.blockers);

      if (route) {
        console.log(
          "RENDER ROUTE " +
            after.source_title +
            " → " +
            route +
            " · " +
            qa.blockers.join("|"),
        );

        await routeBack(job, route, qa.blockers);

        if (once) break;
        continue;
      }

      throw new Error(
        "render_qa_failed:" + qa.blockers.join("|"),
      );
    }

    if (!templateDocument) {
      await enqueuePipelineStage(job, "publish");
    }

    await updatePipelineJob(job.id, {
      status: "pass",
      locked_by: null,
      locked_at: null,
      last_error: null,
      checkpoint: {
        dependency: templateDocument,
        renderedRevision: expectedRevision,
        qa: "pass",
        completedAt: new Date().toISOString(),
      },
      finished_at: new Date().toISOString(),
    });

    console.log(
      "RENDER PASS " +
        after.source_title +
        " · r" +
        expectedRevision +
        (templateDocument ? " · dependency" : ""),
    );
  } catch (error) {
    console.error(
      "RENDER FAILED " +
        job.source_title +
        " · " +
        String(error?.message || error),
    );

    await failOrRetry(job, error);
  }

  if (once) break;
}
