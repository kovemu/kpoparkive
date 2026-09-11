import { parse } from "node-html-parser";

export const ENGLISH_LINK_LOCALIZER_VERSION = 1;

const SAFE_CANONICAL_FALLBACKS = new Map([
  ["대한민국", "South Korea"],
  ["일본", "Japan"],
  ["미국", "United States"],
  ["중국", "China"],
]);

function normalize(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/\u00a0/g, " ")
    .replace(/[\u200b-\u200d\u2060\ufeff]/g, "")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function hasHangul(value) {
  return /[가-힣]/.test(String(value || ""));
}

function cleanEnglishLabel(value) {
  const label = normalize(value)
    .replace(/^'''|'''$/g, "")
    .replace(/^''|''$/g, "")
    .trim();
  if (!label || hasHangul(label)) return "";
  if (/\[\[|\]\]|\{\{\{|\}\}\}|\[include\(/i.test(label)) return "";
  return label;
}

function splitTopLevel(value, separator = ",") {
  const parts = [];
  let start = 0;
  let round = 0;
  let square = 0;
  let braces = 0;
  const source = String(value || "");

  for (let i = 0; i < source.length; i += 1) {
    if (source.startsWith("{{{", i)) {
      braces += 1;
      i += 2;
      continue;
    }
    if (source.startsWith("}}}", i)) {
      braces = Math.max(0, braces - 1);
      i += 2;
      continue;
    }

    const ch = source[i];
    if (ch === "(") round += 1;
    else if (ch === ")") round = Math.max(0, round - 1);
    else if (ch === "[") square += 1;
    else if (ch === "]") square = Math.max(0, square - 1);
    else if (ch === separator && round === 0 && square === 0 && braces === 0) {
      parts.push(source.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(source.slice(start));
  return parts;
}

function parseParams(parts) {
  const params = new Map();
  for (let i = 1; i < parts.length; i += 1) {
    const raw = parts[i];
    const eq = raw.indexOf("=");
    if (eq < 0) continue;
    const key = normalize(raw.slice(0, eq));
    const value = normalize(raw.slice(eq + 1));
    if (key && !params.has(key)) params.set(key, { index: i, value });
  }
  return params;
}

function scanIncludes(source, visitor) {
  const lower = String(source || "").toLowerCase();
  let cursor = 0;
  let output = "";

  while (cursor < source.length) {
    const start = lower.indexOf("[include(", cursor);
    if (start < 0) {
      output += source.slice(cursor);
      break;
    }

    output += source.slice(cursor, start);
    let round = 0;
    let end = -1;
    for (let i = start + 9; i < source.length; i += 1) {
      const ch = source[i];
      if (ch === "(") {
        round += 1;
        continue;
      }
      if (ch === ")") {
        if (round > 0) {
          round -= 1;
          continue;
        }
        if (source[i + 1] === "]") {
          end = i + 2;
          break;
        }
      }
    }

    if (end < 0) {
      output += source.slice(start);
      break;
    }

    const full = source.slice(start, end);
    const body = source.slice(start + 9, end - 2);
    const replacement = visitor(full, body);
    output += typeof replacement === "string" ? replacement : full;
    cursor = end;
  }

  return output;
}

function templateName(value) {
  return normalize(value).replace(/^(틀|Template)\s*:\s*/i, (_m, ns) => `${ns}:`);
}

function addParam(parts, key, value) {
  const clean = cleanEnglishLabel(value);
  if (!clean) return parts.join(",");
  return [...parts, ` ${key}=${clean}`].join(",");
}

function lastPathSegment(value) {
  const target = normalize(value).replace(/^\s+|\s+$/g, "");
  const slash = target.lastIndexOf("/");
  return slash >= 0 ? target.slice(slash + 1).trim() : target;
}

export function buildEnglishLabelIndex(rows = []) {
  const exact = new Map(SAFE_CANONICAL_FALLBACKS);
  const suffix = new Map();

  const setExact = (target, label) => {
    const key = normalize(target);
    const english = cleanEnglishLabel(label);
    if (!key || !english || key === english) return;
    if (!exact.has(key)) exact.set(key, english);
  };

  const setSuffix = (target, label) => {
    const segment = lastPathSegment(target);
    let english = cleanEnglishLabel(label);
    if (!segment || !english) return;
    if (english.includes("/")) english = english.slice(english.lastIndexOf("/") + 1).trim();
    if (!english || hasHangul(english)) return;
    if (!suffix.has(segment)) suffix.set(segment, english);
  };

  for (const row of rows || []) {
    const sourceTitle = normalize(row?.source_title);
    const translatedTitle = cleanEnglishLabel(row?.translated_title);
    if (sourceTitle && translatedTitle) setExact(sourceTitle, translatedTitle);

    const content = typeof row?.content_wikitext === "string" ? row.content_wikitext : "";
    if (!content || row?.content_language !== "en") continue;

    const linkRe = /\[\[([^\[\]|#]+)(?:#[^\]|]*)?\|([^\[\]]+)\]\]/g;
    let linkMatch;
    while ((linkMatch = linkRe.exec(content))) {
      setExact(linkMatch[1], linkMatch[2]);
      setSuffix(linkMatch[1], linkMatch[2]);
    }

    scanIncludes(content, (_full, body) => {
      const parts = splitTopLevel(body);
      const name = templateName(parts[0]);
      if (name.toLowerCase() !== "틀:상세 내용") return _full;
      const params = parseParams(parts);
      const target = params.get("문서명")?.value || "";
      const label = params.get("표시명")?.value || "";
      if (target && label) {
        setExact(target, label);
        setSuffix(target, label);
      }
      return _full;
    });
  }

  return { exact, suffix };
}

function resolveDetailLabel(target, currentTitle, index) {
  const key = normalize(target);
  if (!key) return "";

  const segment = lastPathSegment(key);
  const suffix = cleanEnglishLabel(index?.suffix?.get(segment));
  const owner = normalize(currentTitle);

  // For a detail link to the current document's own subpage, prefer the
  // translated subpage label ("Music Show Fancams", "Trivia", etc.) over a
  // verbose fully-qualified translated title.
  if (owner && key.startsWith(owner + "/") && suffix) return suffix;

  const exact = cleanEnglishLabel(index?.exact?.get(key));
  if (exact) return exact;
  if (suffix) return suffix;
  return "";
}

export function localizeEnglishTemplateLabels(source, { currentTitle = "", index } = {}) {
  const stats = {
    version: ENGLISH_LINK_LOCALIZER_VERSION,
    flagOutputsAdded: 0,
    detailLabelsAdded: 0,
    unresolved: [],
  };

  const text = scanIncludes(String(source || ""), (full, body) => {
    const parts = splitTopLevel(body);
    const name = templateName(parts[0]);
    const params = parseParams(parts);

    if (name.toLowerCase() === "틀:국기") {
      if (params.has("출력")) return full;
      const canonical =
        params.get("국명")?.value ||
        params.get("행정구")?.value ||
        params.get("속령")?.value ||
        "";
      const label = cleanEnglishLabel(index?.exact?.get(normalize(canonical))) ||
        cleanEnglishLabel(SAFE_CANONICAL_FALLBACKS.get(normalize(canonical)));
      if (canonical && label) {
        stats.flagOutputsAdded += 1;
        return `[include(${addParam(parts, "출력", label)})]`;
      }
      if (canonical && hasHangul(canonical) && !/^(?:국가명|○+)$/.test(canonical)) {
        stats.unresolved.push({ template: "틀:국기", target: canonical });
      }
      return full;
    }

    if (name.toLowerCase() === "틀:상세 내용") {
      if (params.has("표시명")) return full;
      const target = params.get("문서명")?.value || "";
      const label = resolveDetailLabel(target, currentTitle, index);
      if (target && label) {
        stats.detailLabelsAdded += 1;
        return `[include(${addParam(parts, "표시명", label)})]`;
      }
      if (target && hasHangul(target)) {
        stats.unresolved.push({ template: "틀:상세 내용", target });
      }
      return full;
    }

    return full;
  });

  return { text, stats };
}

export function findVisibleKoreanLinkLabels(html, { limit = 30 } = {}) {
  const root = parse(String(html || ""));
  const output = [];
  const seen = new Set();

  for (const anchor of root.querySelectorAll("a[href]")) {
    const visible = normalize(anchor.text || anchor.innerText || "");
    if (!visible || !hasHangul(visible)) continue;
    const href = normalize(anchor.getAttribute("href") || "");
    const key = `${href}\n${visible}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push({ href, visible });
    if (output.length >= limit) break;
  }

  return output;
}
