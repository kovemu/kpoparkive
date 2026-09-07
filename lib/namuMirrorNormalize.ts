const DAY_MS = 24 * 60 * 60 * 1000;

function koreaTodayUtcMidnight(now = new Date()) {
  const shifted = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate());
}

function parseIsoDate(value: string) {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { year, month, day, utc: Date.UTC(year, month - 1, day) };
}

function dday(value: string, now = new Date()) {
  const date = parseIsoDate(value);
  if (!date) return null;
  const days = Math.floor((koreaTodayUtcMidnight(now) - date.utc) / DAY_MS);
  return days >= 0 ? `+${days}` : String(days);
}

function age(value: string, now = new Date()) {
  const date = parseIsoDate(value);
  if (!date) return null;
  const shifted = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const currentYear = shifted.getUTCFullYear();
  const currentMonth = shifted.getUTCMonth() + 1;
  const currentDay = shifted.getUTCDate();
  let years = currentYear - date.year;
  if (currentMonth < date.month || (currentMonth === date.month && currentDay < date.day)) years -= 1;
  return String(Math.max(0, years));
}

function expandDateMacros(html: string, now = new Date()) {
  return html
    .replace(/(?:\[|&#91;)dday\((\d{4}-\d{2}-\d{2})\)(?:\]|&#93;)/gi, (match, value: string) => dday(value, now) ?? match)
    .replace(/(?:\[|&#91;)age\((\d{4}-\d{2}-\d{2})\)(?:\]|&#93;)/gi, (match, value: string) => age(value, now) ?? match);
}

/**
 * namu.moe intentionally leaves some unsupported Namu controls in otherwise
 * useful rendered HTML. Keep the DOM hierarchy, but remove only residue that
 * is known to be presentation metadata rather than article content.
 */
export function normalizeNamuMirrorHtml(source: string, now = new Date()) {
  let html = String(source || "");

  // The mirror occasionally serializes Namu's <nopad> cell option as an invalid
  // CSS color token. Convert that semantic marker back to the intended geometry.
  html = html.replace(/background-color\s*:\s*nopad\s*;?/gi, "padding:0;");

  // Table column controls can survive as literal text at the start of already
  // rendered <td> cells (not inside raw <pre><code> blocks). They are metadata,
  // and showing them visibly breaks infobox headers.
  html = html.replace(
    /(<(?:td|th)\b[^>]*>\s*)((?:&lt;(?:col|row|table)?(?:bgcolor|color|width|align|class|nopad)[^&]*?&gt;\s*)+)/gi,
    "$1",
  );

  // Closing braces from partially expanded template conditions sometimes sit
  // between real rendered nodes. Remove only standalone brace residue.
  html = html.replace(/>\s*\}{3,}\s*</g, "><");

  // Namu's date macros are deterministic and safe to evaluate locally. This
  // restores live "days since debut" / anniversary cells without hardcoding a
  // specific group or date.
  html = expandDateMacros(html, now);

  return html;
}
