importScripts("background.js", "raw-asset-resolver-v2.js", "helper-clone-controller.js", "fidelity-controller.js");

const KPOP_PIPELINE_WAKE_ALARM = "kpoparkive-pipeline-clone-watch";

async function kpopPipelineWakeRunner() {
  try {
    if (typeof kpopControllerStatus !== "function" || typeof kpopEnsureRunnerTab !== "function") return;
    const result = await kpopControllerStatus();
    if (result?.ok && result?.job?.running) {
      await kpopEnsureRunnerTab({ reloadExisting: false });
    }
  } catch {}
}

try {
  chrome.alarms.create(KPOP_PIPELINE_WAKE_ALARM, { periodInMinutes: 0.5 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm?.name === KPOP_PIPELINE_WAKE_ALARM) void kpopPipelineWakeRunner();
  });
  void kpopPipelineWakeRunner();
} catch {}
