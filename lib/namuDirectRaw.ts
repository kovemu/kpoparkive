import { parse } from "node-html-parser";

export type DirectRawResult = {
  ok: boolean;
  status: "ok" | "blocked" | "not_found" | "invalid" | "network_error";
  httpStatus?: number;
  sourceUrl: string;
  contentType?: string;
  raw?: string;
  reason?: string;
};

function decodeEntities(value: string) {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&#x27;/gi, "'")
    .replace(/&#91;/gi, "[")
    .replace(/&#93;/gi, "]")
    .replace(/&#123;/gi, "{")
    .replace(/&#125;/gi, "}")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));
}

function normalizeRaw(value: string) {
  return decodeEntities(value || "")
    .replace(/\r\n?/g, "\n")
    .replace(/^\uFEFF/, "")
    .trim();
}

function extractRawFromHtml(html: string) {
  const root = parse(html);
  const candidates = [
    root.querySelector("textarea")?.textContent,
    root.querySelector("pre > code")?.textContent,
    root.querySelector("pre")?.textContent,
    root.querySelector("article")?.textContent,
  ].filter((value): value is string => Boolean(value && value.trim()));

  return candidates
    .map(normalizeRaw)
    .sort((a, b) => b.length - a.length)[0] || "";
}

function looksLikeNamuRaw(value: string) {
  if (value.length < 500) return false;
  const signals = [
    /\[\[[^\]]+\]\]/,
    /^={2,6}[^=].*={2,6}$/m,
    /^\|\|/m,
    /\{\{\{#!/,
    /\[\[(?:파일|File):/i,
  ];
  return signals.filter((pattern) => pattern.test(value)).length >= 2;
}

function looksBlocked(value: string) {
  return /captcha|cloudflare|cf-chl|challenge-platform|access denied|비정상적인 접근|자동화된 접근/i.test(value);
}

export async function fetchNamuDirectRaw(title: string): Promise<DirectRawResult> {
  const sourceUrl = `https://namu.wiki/raw/${encodeURIComponent(title)}`;
  try {
    const response = await fetch(sourceUrl, {
      method: "GET",
      headers: {
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36",
        accept: "text/plain,text/html;q=0.9,*/*;q=0.8",
        "accept-language": "ko-KR,ko;q=0.9,en;q=0.8",
      },
      redirect: "follow",
      cache: "no-store",
    });

    const contentType = response.headers.get("content-type") || "";
    const body = await response.text();
    if (response.status === 404) return { ok: false, status: "not_found", httpStatus: response.status, sourceUrl, contentType };
    if (response.status === 403 || response.status === 429 || looksBlocked(body)) {
      return { ok: false, status: "blocked", httpStatus: response.status, sourceUrl, contentType, reason: "NamuWiki returned an anti-bot or rate-limit response." };
    }
    if (!response.ok) {
      return { ok: false, status: "network_error", httpStatus: response.status, sourceUrl, contentType, reason: `HTTP ${response.status}` };
    }

    const raw = /text\/plain/i.test(contentType) ? normalizeRaw(body) : extractRawFromHtml(body);
    if (!looksLikeNamuRaw(raw)) {
      return { ok: false, status: "invalid", httpStatus: response.status, sourceUrl, contentType, reason: `Response did not look like a complete Namu raw document (${raw.length} chars).` };
    }

    return { ok: true, status: "ok", httpStatus: response.status, sourceUrl, contentType, raw };
  } catch (error) {
    return { ok: false, status: "network_error", sourceUrl, reason: error instanceof Error ? error.message : String(error) };
  }
}
