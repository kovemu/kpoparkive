function kpopRawMediaDecode(value) {
  try { return decodeURIComponent(value); } catch { return value; }
}

function kpopRawMediaFileNameFromLocation() {
  const match = location.pathname.match(/^\/w\/(.+)$/);
  if (!match) return "";
  return kpopRawMediaDecode(match[1])
    .normalize("NFKC")
    .replace(/^파일:/i, "")
    .replace(/\u00a0/g, " ")
    .replace(/[\u200b-\u200d\u2060\ufeff]/g, "")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function kpopRawMediaUrl(value) {
  if (!value || /^(?:data|blob):/i.test(value)) return "";
  try {
    const url = new URL(value, location.href).toString();
    return /^https?:\/\//i.test(url) ? url : "";
  } catch {
    return "";
  }
}

function kpopRawMediaUnique(values) {
  return [...new Set(values.filter(Boolean))];
}

function kpopExtractRawFileMedia() {
  const fileName = kpopRawMediaFileNameFromLocation();
  const media = [];

  for (const video of Array.from(document.querySelectorAll("video"))) {
    const urls = [
      kpopRawMediaUrl(video.currentSrc || ""),
      kpopRawMediaUrl(video.getAttribute("src") || ""),
      kpopRawMediaUrl(video.getAttribute("data-src") || ""),
    ];
    for (const source of Array.from(video.querySelectorAll("source"))) {
      urls.push(kpopRawMediaUrl(source.getAttribute("src") || ""));
      urls.push(kpopRawMediaUrl(source.getAttribute("data-src") || ""));
    }
    const uniqueUrls = kpopRawMediaUnique(urls);
    if (!uniqueUrls.length) continue;
    media.push({
      fileName,
      mediaType: "video",
      urls: uniqueUrls,
      width: Number(video.videoWidth || video.clientWidth || 0),
      height: Number(video.videoHeight || video.clientHeight || 0),
      duration: Number.isFinite(video.duration) ? video.duration : null,
      poster: kpopRawMediaUrl(video.poster || ""),
      muted: Boolean(video.muted),
      loop: Boolean(video.loop),
      autoplay: Boolean(video.autoplay),
    });
  }

  return {
    ok: true,
    pageUrl: location.href,
    sourceTitle: fileName ? `파일:${fileName}` : document.title,
    fileName,
    media,
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "kpoparkive-extract-namu-file-media") return;
  try {
    sendResponse(kpopExtractRawFileMedia());
  } catch (error) {
    sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});
