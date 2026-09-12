const rootInput = document.getElementById("root");
const cloneButton = document.getElementById("clone");
const rawCrawlButton = document.getElementById("rawCrawl");
const rawPlanButton = document.getElementById("rawPlan");
const rawNextButton = document.getElementById("rawNext");
const rawButton = document.getElementById("raw");
const assetsButton = document.getElementById("assets");
const compareButton = document.getElementById("compare");
const resetButton = document.getElementById("reset");
const profileInput = document.getElementById("profile");
const depthInput = document.getElementById("depth");
const maxDocsInput = document.getElementById("maxDocs");
const crawlOrderInput = document.getElementById("crawlOrder");
const includeLeafInput = document.getElementById("includeLeaf");
const refreshExistingInput = document.getElementById("refreshExisting");
const health = document.getElementById("health");
const status = document.getElementById("status");
const verification = document.getElementById("verification");
let pollTimer = null;
let rawAssetPollTimer = null;
let lastAutoPlannedCloneId = "";

const CRAWL_PROFILES = {
  essential: { depth: 1, maxDocs: 20, crawlOrder: "smart", includeLeaf: false, refreshExisting: false },
  "smart-core": { depth: 2, maxDocs: 40, crawlOrder: "smart", includeLeaf: true, refreshExisting: false },
  archive: { depth: 3, maxDocs: 150, crawlOrder: "smart", includeLeaf: true, refreshExisting: false },
};

function applyCrawlProfile(name, { persist = true } = {}) {
  const key = String(name || "smart-core");
  profileInput.value = CRAWL_PROFILES[key] ? key : "custom";
  const preset = CRAWL_PROFILES[key];
  if (preset) {
    depthInput.value = String(preset.depth);
    maxDocsInput.value = String(preset.maxDocs);
    crawlOrderInput.value = preset.crawlOrder;
    includeLeafInput.checked = preset.includeLeaf;
    refreshExistingInput.checked = preset.refreshExisting;
  }
  if (persist) {
    chrome.storage.local.set({
      kpoparkiveCrawlProfile: profileInput.value,
      kpoparkiveCloneDepth: Number(depthInput.value || 2),
      kpoparkiveCloneMaxDocs: Number(maxDocsInput.value || 40),
      kpoparkiveCrawlOrder: crawlOrderInput.value || "smart",
      kpoparkiveIncludeLeaf: Boolean(includeLeafInput.checked),
      kpoparkiveRefreshExisting: Boolean(refreshExistingInput.checked),
    });
  }
}

function markCustomProfile() {
  if (profileInput.value !== "custom") profileInput.value = "custom";
  chrome.storage.local.set({
    kpoparkiveCrawlProfile: "custom",
    kpoparkiveCloneDepth: Number(depthInput.value || 2),
    kpoparkiveCloneMaxDocs: Number(maxDocsInput.value || 40),
    kpoparkiveCrawlOrder: crawlOrderInput.value || "smart",
    kpoparkiveIncludeLeaf: Boolean(includeLeafInput.checked),
    kpoparkiveRefreshExisting: Boolean(refreshExistingInput.checked),
  });
}

function setStatus(text, kind = "") {
  status.textContent = text;
  status.className = kind;
}

function titleFromNamuUrl(value) {
  try {
    const url = new URL(String(value || ""));
    if (!/(^|\.)namu\.wiki$/i.test(url.hostname)) return "";
    const match = url.pathname.match(/^\/w\/(.+)$/);
    if (!match?.[1]) return "";
    try { return decodeURIComponent(match[1]).normalize("NFKC").trim(); }
    catch { return match[1].normalize("NFKC").trim(); }
  } catch {
    return "";
  }
}

async function syncRootFromActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const title = titleFromNamuUrl(tab?.url || "");
    if (!title) return rootInput.value.trim() || "";
    rootInput.value = title;
    await chrome.storage.local.set({ kpoparkiveRootTitle: title });
    return title;
  } catch {
    return rootInput.value.trim() || "";
  }
}

async function refreshHealth() {
  try {
    const [response, rawAssets] = await Promise.all([
      chrome.runtime.sendMessage({ type: "kpoparkive-helper-health" }),
      chrome.runtime.sendMessage({ type: "kpoparkive-raw-asset-health" }).catch(() => ({ ok: false })),
    ]);
    if (response?.ok) {
      const suffix = response.documentCapture ? ` · ${response.documentCapture}` : "";
      const rawSuffix = rawAssets?.ok ? " · raw-assets ready" : " · raw-assets unavailable";
      health.textContent = response.supabaseHost
        ? `Local helper: connected (${response.supabaseHost})${suffix}${rawSuffix}`
        : `Local helper: connected${suffix}${rawSuffix}`;
      health.className = rawAssets?.ok ? "ok" : "";
    } else {
      health.textContent = "Local helper: not running";
      health.className = "bad";
    }
  } catch {
    health.textContent = "Local helper: not running";
    health.className = "bad";
  }
}

function formatJob(job) {
  if (!job || !job.id) return "Ready.";
  const current = Array.isArray(job.current) ? job.current.filter(Boolean).join(" · ") : String(job.current || "");
  const state = job.paused
    ? "PAUSED · VERIFICATION"
    : job.running
      ? "RUNNING"
      : job.done
        ? "DONE"
        : String(job.status || "IDLE").toUpperCase();
  const lines = [
    `Root: ${job.rootTitle || "—"}`,
    `Mode: ${job.captureMode === "raw" ? "RAW" : "DOM"}`,
    ...(job.captureMode === "raw" ? [] : [
      `Profile: ${job.crawlProfile || "smart-core"}`,
      `Order: ${job.crawlOrder === "toc" ? "TOC strict" : "Smart core → TOC"}`,
      `Leaf pages: ${job.includeLeaf === false ? "off" : "on"}`,
      `Refresh existing: ${job.refreshExisting ? "on" : "off"}`,
    ]),
    `State: ${state}`,
    `Processed: ${job.processed || 0}/${job.maxDocs || 0}`,
    `Captured: ${job.captured || 0}`,
    `Reused: ${job.skipped || 0}`,
    `Queued: ${job.queued || 0}`,
    `Active workers: ${job.leased || 0}`,
    `Failed: ${job.failed || 0}`,
  ];
  if (current) lines.push(`Current: ${current}`);
  if (job.paused && job.pauseReason) lines.push(`Pause reason: ${job.pauseReason}`);
  if (job.lastMedia) {
    lines.push(`Last media: ${job.lastMedia.resolved || 0} new · ${job.lastMedia.skippedKnown || 0} reused · ${job.lastMedia.failed || 0} failed`);
    if (job.lastMedia.capturePolicy === "root-raw-only") {
      lines.push(
        `Render gaps: ${job.lastMedia.missingFiles || 0} files · ${job.lastMedia.missingTemplates || 0} templates`
      );
      const missingFiles = Array.isArray(job.lastMedia.missingFileNames) ? job.lastMedia.missingFileNames : [];
      const missingTemplates = Array.isArray(job.lastMedia.missingTemplateNames) ? job.lastMedia.missingTemplateNames : [];
      if (missingFiles.length) lines.push(`Missing files: ${missingFiles.join(" · ")}`);
      if (missingTemplates.length) lines.push(`Missing templates: ${missingTemplates.join(" · ")}`);
    }
  }
  if (job.running) lines.push("", "You can close this popup and use Chrome normally.");
  if (Array.isArray(job.errors) && job.errors.length) {
    lines.push("", "Recent errors:");
    for (const error of job.errors.slice(-4)) lines.push(`- ${error}`);
  }
  return lines.join("\n");
}

const RAW_REASON_LABELS = {
  root_canonical_anchor: "root canonical source",
  browser_dom_missing: "DOM capture missing",
  dom_promotion_blocked: "DOM promotion blocked",
  dom_structural_loss: "DOM structural loss",
  interactive_layout: "interactive/tabbed layout",
  render_leaked_markers: "render leaked Namu syntax",
  table_geometry_mismatch: "table geometry mismatch",
  unmatched_original_tables: "unmatched original tables",
  source_render_error: "source render error",
  source_render_missing_templates: "missing templates",
  source_render_missing_files: "missing files",
  complex_template_fallback: "complex template fallback",
  template_structural_loss: "template structural loss",
  template_interactive_layout: "interactive template",
  template_fallback_unverified: "unverified template fallback",
  dense_tables: "dense tables",
  many_sections: "many sections",
  large_dom_capture: "large DOM capture",
  dense_link_graph: "dense link graph",
  canonical_raw_present: "canonical RAW present",
};

function rawReasonText(item) {
  const reasons = Array.isArray(item?.reason_codes) ? item.reason_codes : [];
  return reasons
    .slice(0, 4)
    .map((reason) => RAW_REASON_LABELS[reason] || String(reason))
    .join(" · ");
}

function formatRawNeeds(plan) {
  if (!plan) return "RAW Needs has not been planned.";
  const counts = plan.counts || {};
  const lines = [
    `RAW Needs · ${plan.rootTitle || rootInput.value.trim() || "—"}`,
    `Captured: ${counts.captured || 0}`,
    `Needs RAW: ${counts.needs_raw || 0}`,
    `Review only: ${counts.review || 0}`,
    `DOM ready: ${counts.ready || 0}`,
    `Ignored: ${counts.ignored || 0}`,
  ];

  if (plan.next) {
    lines.push(
      "",
      `Next RAW: ${plan.next.source_title || "—"}`,
      `Priority: ${plan.next.priority || 0} · Score: ${plan.next.score || 0}`,
    );
    const reason = rawReasonText(plan.next);
    if (reason) lines.push(`Reason: ${reason}`);
  } else {
    lines.push("", "No REQUIRED RAW remains.");
  }

  const reviews = Array.isArray(plan.items)
    ? plan.items.filter((item) => item.status === "review").slice(0, 4)
    : [];
  if (reviews.length) {
    lines.push("", "Review candidates:");
    for (const item of reviews) {
      lines.push(`- ${item.source_title}: ${rawReasonText(item) || "manual review"}`);
    }
  }

  return lines.join("\n");
}

async function planRawNeeds({ show = true } = {}) {
  const rootTitle = rootInput.value.trim() || "RESCENE";
  const response = await chrome.runtime.sendMessage({
    type: "kpoparkive-plan-raw-needs",
    options: { rootTitle },
  });
  if (!response?.ok) throw new Error(response?.error || "Could not plan RAW requirements.");
  if (show) setStatus(formatRawNeeds(response), "ok");
  return response;
}

async function refreshRawNeeds({ show = false } = {}) {
  const rootTitle = rootInput.value.trim() || "RESCENE";
  const response = await chrome.runtime.sendMessage({
    type: "kpoparkive-raw-needs-status",
    options: { rootTitle },
  });
  if (!response?.ok) throw new Error(response?.error || "Could not read RAW requirements.");
  if (show) setStatus(formatRawNeeds(response), "ok");
  return response;
}

function formatRawAssetJob(job) {
  if (!job || job.id !== "raw-assets") return "Raw asset resolver is idle.";
  const lines = [
    `Raw assets · ${job.rootTitle || "—"}`,
    `State: ${job.running ? "RUNNING" : job.done ? "DONE" : "IDLE"}`,
    `Required by renderer: ${job.required || 0}`,
    `Missing at start: ${job.planned || 0}`,
    `Processed: ${job.processed || 0}/${job.planned || 0}`,
    `Resolved: ${job.resolved || 0}`,
    `Failed: ${job.failed || 0}`,
    `Remaining after verification: ${job.remaining == null ? "—" : job.remaining}`,
  ];
  if (job.current) lines.push(`Current: ${job.current}`);
  if (job.running) lines.push("", "File pages are opened in background. If NamuWiki verification blocks a file, that tab will be brought forward.");
  if (Array.isArray(job.errors) && job.errors.length) {
    lines.push("", "Recent errors:");
    for (const error of job.errors.slice(-5)) lines.push(`- ${error}`);
  }
  if (job.done && !job.failed && Number(job.remaining || 0) === 0) {
    lines.push("", "All renderer-required assets are storage-backed. Re-run the The Tree renderer to refresh missing-files metadata/HTML.");
  }
  return lines.join("\n");
}

async function pollStatus() {
  try {
    const response = await chrome.runtime.sendMessage({ type: "kpoparkive-helper-clone-status" });
    if (!response?.ok) return;
    const job = response.job;
    if (job?.id) setStatus(formatJob(job), job.failed ? "" : "ok");
    cloneButton.disabled = Boolean(job?.running);
    rawCrawlButton.disabled = Boolean(job?.running);
    rawPlanButton.disabled = Boolean(job?.running);
    rawNextButton.disabled = Boolean(job?.running);

    if (
      job?.done &&
      job.captureMode !== "raw" &&
      job.rootTitle &&
      job.id !== lastAutoPlannedCloneId
    ) {
      lastAutoPlannedCloneId = job.id;
      try {
        rootInput.value = job.rootTitle;
        const plan = await planRawNeeds({ show: false });
        setStatus(formatJob(job) + "\n\n" + formatRawNeeds(plan), "ok");
      } catch (error) {
        setStatus(formatJob(job) + "\n\nRAW Needs planning failed: " + (error?.message || String(error)), "");
      }
    }

    if (!job?.running && pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  } catch {}
}

async function pollRawAssetStatus(show = true) {
  try {
    const response = await chrome.runtime.sendMessage({ type: "kpoparkive-raw-asset-status" });
    if (!response?.ok) return;
    const job = response.job;
    assetsButton.disabled = Boolean(job?.running);
    if (show && job?.id === "raw-assets" && (job.running || job.done || job.planned)) {
      setStatus(formatRawAssetJob(job), job.failed ? "" : "ok");
    }
    if (!job?.running && rawAssetPollTimer) {
      clearInterval(rawAssetPollTimer);
      rawAssetPollTimer = null;
    }
  } catch {}
}

chrome.storage.local.get([
  "kpoparkiveRootTitle",
  "kpoparkiveCrawlProfile",
  "kpoparkiveCloneDepth",
  "kpoparkiveCloneMaxDocs",
  "kpoparkiveCrawlOrder",
  "kpoparkiveIncludeLeaf",
  "kpoparkiveRefreshExisting",
]).then(async (stored) => {
  const savedRoot = String(stored.kpoparkiveRootTitle || "").normalize("NFKC").trim();
  if (savedRoot) rootInput.value = savedRoot;

  const savedProfile = String(stored.kpoparkiveCrawlProfile || "smart-core");
  if (CRAWL_PROFILES[savedProfile]) {
    applyCrawlProfile(savedProfile, { persist: false });
  } else {
    profileInput.value = "custom";
    depthInput.value = String(stored.kpoparkiveCloneDepth ?? 2);
    maxDocsInput.value = String(stored.kpoparkiveCloneMaxDocs ?? 40);
    crawlOrderInput.value = stored.kpoparkiveCrawlOrder === "toc" ? "toc" : "smart";
    includeLeafInput.checked = stored.kpoparkiveIncludeLeaf !== false;
    refreshExistingInput.checked = Boolean(stored.kpoparkiveRefreshExisting);
  }

  // Keep the team/root import scope stable while navigating member/subpages.
  // Only adopt the active NamuWiki page when no root has been saved yet.
  if (!savedRoot) await syncRootFromActiveTab();
});

rootInput.addEventListener("change", () => {
  const value = rootInput.value.trim() || "RESCENE";
  rootInput.value = value;
  chrome.storage.local.set({ kpoparkiveRootTitle: value });
});

profileInput.addEventListener("change", () => applyCrawlProfile(profileInput.value));
depthInput.addEventListener("change", markCustomProfile);
maxDocsInput.addEventListener("change", markCustomProfile);
crawlOrderInput.addEventListener("change", markCustomProfile);
includeLeafInput.addEventListener("change", markCustomProfile);
refreshExistingInput.addEventListener("change", markCustomProfile);

rawPlanButton.addEventListener("click", async () => {
  rawPlanButton.disabled = true;
  setStatus("Analyzing DOM captures and fidelity signals...\nOnly genuinely required documents will enter the RAW queue.");
  try {
    const plan = await planRawNeeds({ show: false });
    setStatus(formatRawNeeds(plan), "ok");
  } catch (error) {
    setStatus(error?.message || String(error), "bad");
  } finally {
    rawPlanButton.disabled = false;
  }
});

rawNextButton.addEventListener("click", async () => {
  const rootTitle = rootInput.value.trim() || "RESCENE";
  rawNextButton.disabled = true;
  rawPlanButton.disabled = true;
  setStatus(
    `Finding the next REQUIRED RAW for ${rootTitle}...\n` +
    "No manual NamuWiki navigation is needed. The persistent RAW session tab will move to the selected document."
  );

  try {
    const response = await chrome.runtime.sendMessage({
      type: "kpoparkive-capture-next-required-raw",
      options: { rootTitle, replan: true },
    });
    if (!response?.ok) throw new Error(response?.error || "Could not capture the next required RAW.");

    if (response.noWork) {
      setStatus(formatRawNeeds(response.rawNeeds), "ok");
      return;
    }

    const planText = formatRawNeeds(response.rawNeeds);
    setStatus(
      [
        "Required RAW saved.",
        `Document: ${response.sourceTitle || "—"}`,
        `Characters: ${response.charCount || 0}`,
        `Method: ${response.extractionMethod || "persistent RAW tab"}`,
        "",
        planText,
      ].join("\n"),
      "ok"
    );
  } catch (error) {
    setStatus(error?.message || String(error), "bad");
  } finally {
    rawNextButton.disabled = false;
    rawPlanButton.disabled = false;
  }
});

rawCrawlButton.addEventListener("click", async () => {
  const activeRoot = await syncRootFromActiveTab();
  const rootTitle = activeRoot || rootInput.value.trim() || "RESCENE";
  const maxDepth = 0;
  const maxDocs = 1;

  await chrome.storage.local.set({ kpoparkiveRootTitle: rootTitle });

  rawCrawlButton.disabled = true;
  setStatus(
    [
      "Capturing canonical root RAW...",
      `Document: ${rootTitle}`,
      "",
      "One persistent NamuWiki RAW session tab is reused.",
      "The root RAW is captured first; only renderer-required missing template RAW dependencies are opened afterward.",
      "Unrelated linked documents are not followed in RAW mode.",
    ].join("\n")
  );

  try {
    const response = await chrome.runtime.sendMessage({
      type: "kpoparkive-start-helper-clone",
      options: { rootTitle, maxDepth, maxDocs, captureMode: "raw" },
    });
    if (!response?.ok) throw new Error(response?.error || "Could not start RAW crawl.");
    setStatus(formatJob(response.job), "ok");
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(pollStatus, 1000);
  } catch (error) {
    setStatus(error?.message || String(error), "bad");
    rawCrawlButton.disabled = false;
  }
});

cloneButton.addEventListener("click", async () => {
  const rootTitle = rootInput.value.trim() || "RESCENE";
  const crawlProfile = profileInput.value || "smart-core";
  const maxDepth = Math.max(0, Math.min(3, Number(depthInput.value || 2) || 0));
  const maxDocs = Math.max(1, Math.min(200, Number(maxDocsInput.value || 40) || 40));
  const crawlOrder = crawlOrderInput.value === "toc" ? "toc" : "smart";
  const includeLeaf = Boolean(includeLeafInput.checked);
  const refreshExisting = Boolean(refreshExistingInput.checked);

  await chrome.storage.local.set({
    kpoparkiveRootTitle: rootTitle,
    kpoparkiveCrawlProfile: crawlProfile,
    kpoparkiveCloneDepth: maxDepth,
    kpoparkiveCloneMaxDocs: maxDocs,
    kpoparkiveCrawlOrder: crawlOrder,
    kpoparkiveIncludeLeaf: includeLeaf,
    kpoparkiveRefreshExisting: refreshExisting,
  });

  cloneButton.disabled = true;
  setStatus([
    "Starting smart /w/ DOM harvest...",
    `Root: ${rootTitle}`,
    `Profile: ${crawlProfile}`,
    `Depth: ${maxDepth}`,
    `Document budget: ${maxDocs}`,
    `Order: ${crawlOrder === "toc" ? "depth → TOC → core tier" : "depth → core tier → TOC"}`,
    `Related leaf pages: ${includeLeaf ? "on" : "off"}`,
    `Existing captures: ${refreshExisting ? "refresh" : "reuse"}`,
  ].join("\n"));

  try {
    const response = await chrome.runtime.sendMessage({
      type: "kpoparkive-start-helper-clone",
      options: {
        rootTitle,
        maxDepth,
        maxDocs,
        captureMode: "dom",
        crawlProfile,
        crawlOrder,
        includeLeaf,
        refreshExisting,
      },
    });
    if (!response?.ok) throw new Error(response?.error || "Could not start import.");
    setStatus(formatJob(response.job), "ok");
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(pollStatus, 1000);
  } catch (error) {
    setStatus(error?.message || String(error), "bad");
    cloneButton.disabled = false;
  }
});

rawButton.addEventListener("click", async () => {
  const activeRoot = await syncRootFromActiveTab();
  const rootTitle = activeRoot || rootInput.value.trim() || "RESCENE";
  rawButton.disabled = true;
  setStatus(
    "Capturing canonical NamuMark through the persistent RAW session tab...\n" +
    "The requested document is captured first. Only renderer-required missing template RAW dependencies may be opened afterward in the same tab.\n" +
    "The Tree reuses cached DOM/media whenever possible."
  );

  try {
    const response = await chrome.runtime.sendMessage({
      type: "kpoparkive-capture-edit-raw-source",
      options: { rootTitle, openPreview: true },
    });
    if (!response?.ok) throw new Error(response?.error || "Could not capture raw source.");

    const failures = Array.isArray(response.templateFailures) ? response.templateFailures : [];
    const lines = [
      "Raw source saved.",
      `Document: ${response.sourceTitle || "—"}`,
      `Characters: ${response.charCount || 0}`,
      `Method: ${response.extractionMethod || "normal Chrome edit"}`,
      `Templates referenced: ${response.templatesDiscovered || 0}`,
      `Template failures: ${failures.length}`,
    ];
    if (failures.length) {
      lines.push("", "Template failures:");
      for (const item of failures.slice(0, 8)) lines.push(`- ${item.title}: ${item.error}`);
    }
    lines.push("", "Run the NamuMark engine POC again to compare the fuller render.");
    setStatus(lines.join("\n"), failures.length ? "" : "ok");
  } catch (error) {
    setStatus(error?.message || String(error), "bad");
  } finally {
    rawButton.disabled = false;
  }
});

assetsButton.addEventListener("click", async () => {
  const rootTitle = rootInput.value.trim() || "RESCENE";
  await chrome.storage.local.set({ kpoparkiveRootTitle: rootTitle });
  assetsButton.disabled = true;
  setStatus(
    `Planning renderer-required assets for ${rootTitle}...\n` +
    "Only files without storage-backed bytes will be opened and captured through this normal Chrome session."
  );
  try {
    const response = await chrome.runtime.sendMessage({
      type: "kpoparkive-start-raw-asset-resolver",
      options: { rootTitle, sourceTitle: rootTitle },
    });
    if (!response?.ok) throw new Error(response?.error || "Could not start raw asset resolver.");
    setStatus(formatRawAssetJob(response.job), "ok");
    if (rawAssetPollTimer) clearInterval(rawAssetPollTimer);
    rawAssetPollTimer = setInterval(() => pollRawAssetStatus(true), 1000);
  } catch (error) {
    setStatus(error?.message || String(error), "bad");
    assetsButton.disabled = false;
  }
});

compareButton.addEventListener("click", async () => {
  compareButton.disabled = true;
  setStatus(
    "Comparing the LIVE NamuWiki page in this tab with the deployed The Tree baseline...\n" +
    "The baseline opens in a background tab, layout/text/image metrics are captured at the same browser width, then the report is saved to Supabase."
  );

  try {
    const response = await chrome.runtime.sendMessage({ type: "kpoparkive-compare-live-fidelity" });
    if (!response?.ok) throw new Error(response?.error || "Live fidelity comparison failed.");
    const s = response.summary || {};
    setStatus([
      "Live fidelity report saved.",
      `Document: ${response.sourceTitle || "—"}`,
      `Tables: original ${s.originalTables || 0} / The Tree ${s.baselineTables || 0}`,
      `Matched tables: ${s.matchedTables || 0}`,
      `Geometry mismatches: ${s.tableGeometryMismatches || 0}`,
      `Unmatched tables: original ${s.unmatchedOriginalTables || 0} / The Tree ${s.unmatchedBaselineTables || 0}`,
      `Images: original ${s.originalImages || 0} / The Tree ${s.baselineImages || 0}`,
      `Matched images by alt: ${s.matchedImagesByAlt || 0}`,
      `Missing images by alt: ${s.missingImagesByAlt || 0}`,
      `Leaked syntax markers: ${s.leakedMarkerCount || 0}`,
      "",
      "Saved to source_documents.source_fidelity_meta for direct analysis.",
    ].join("\n"), "ok");
  } catch (error) {
    setStatus(error?.message || String(error), "bad");
  } finally {
    compareButton.disabled = false;
  }
});

resetButton.addEventListener("click", async () => {
  resetButton.disabled = true;
  cloneButton.disabled = true;
  rawCrawlButton.disabled = true;
  setStatus("Resetting crawler job...\nStopping workers and clearing the local queue.");

  try {
    const response = await chrome.runtime.sendMessage({ type: "kpoparkive-reset-helper-clone" });
    if (!response?.ok) throw new Error(response?.error || "Could not reset import job.");
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    setStatus("Job reset complete.\nQueue, leases and progress were cleared.\nCaptured Supabase documents/media were kept.", "ok");
    cloneButton.disabled = false;
    rawCrawlButton.disabled = false;
  } catch (error) {
    setStatus(error?.message || String(error), "bad");
  } finally {
    resetButton.disabled = false;
  }
});

async function pollVerificationStatus() {
  try {
    const stored = await chrome.storage.local.get(["kpoparkiveRawVerification"]);
    const item = stored.kpoparkiveRawVerification || null;
    if (item?.active) {
      verification.classList.add("show");
      verification.textContent =
        `PAUSED · Complete NamuWiki verification\n${item.sourceTitle || "Current document"}\nThe RAW queue resumes automatically when verification clears.`;
    } else {
      verification.classList.remove("show");
      verification.textContent = "PAUSED · NamuWiki verification required";
    }
  } catch {}
}

refreshHealth();
pollStatus();
pollRawAssetStatus(false);
refreshRawNeeds({ show: false }).catch(() => {});
pollVerificationStatus();
setInterval(pollVerificationStatus, 600);
