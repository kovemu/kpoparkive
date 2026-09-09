import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const HOST = "127.0.0.1";
const PORT = Number(process.env.NAMU_FIDELITY_PORT || 43119) || 43119;
const MAX_REPORT_BYTES = 2 * 1024 * 1024;

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const rawLine of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match || process.env[match[1]]) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[match[1]] = value;
  }
}

loadEnvFile(path.resolve(".env.local"));
loadEnvFile(path.resolve(".env"));

const SUPABASE_URL = String(process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/$/, "");
const SERVICE_ROLE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "");
if (!SUPABASE_URL || !SERVICE_ROLE_KEY) throw new Error("Supabase env is missing for fidelity helper");

function json(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": payload.length,
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

async function db(pathname, init = {}) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${pathname}`, {
    ...init,
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Supabase ${response.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("fidelity report exceeds 2 MB"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function normalizeTitle(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/\u00a0/g, " ")
    .replace(/[\u200b-\u200d\u2060\ufeff]/g, "")
    .replace(/[ \t]+/g, " ")
    .trim();
}

async function saveReport(payload) {
  const sourceTitle = normalizeTitle(payload?.sourceTitle);
  const report = payload?.report;
  if (!sourceTitle || !report || typeof report !== "object") throw new Error("sourceTitle/report are required");

  const docs = await db(
    `source_documents?source=eq.namu_mirror&source_title=eq.${encodeURIComponent(sourceTitle)}` +
      `&select=id,source_title&limit=1`,
  );
  const doc = docs?.[0];
  if (!doc?.id) throw new Error(`source_document not found for ${sourceTitle}`);

  const capturedAt = new Date().toISOString();
  await db(`source_documents?id=eq.${encodeURIComponent(doc.id)}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      source_fidelity_meta: {
        ...report,
        sourceTitle,
        capturedAt,
        captureVersion: "live-original-vs-thetree-v1",
      },
      source_fidelity_captured_at: capturedAt,
      updated_at: capturedAt,
    }),
  });

  const summary = report.summary || {};
  console.log(
    `LIVE FIDELITY SAVED ${sourceTitle} -> tables ${summary.originalTables ?? "?"}/${summary.baselineTables ?? "?"}, ` +
    `images ${summary.originalImages ?? "?"}/${summary.baselineImages ?? "?"}, mismatches ${summary.tableGeometryMismatches ?? "?"}`,
  );
  return { ok: true, sourceTitle, capturedAt, summary };
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    });
    res.end();
    return;
  }

  const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);
  if (req.method === "GET" && url.pathname === "/health") {
    json(res, 200, { ok: true, service: "kpoparkive-namu-live-fidelity-helper", port: PORT });
    return;
  }

  try {
    if (req.method === "POST" && url.pathname === "/fidelity-report") {
      const bytes = await readBody(req, MAX_REPORT_BYTES);
      let payload;
      try { payload = JSON.parse(bytes.toString("utf8")); }
      catch { throw new Error("fidelity payload is not valid JSON"); }
      json(res, 200, await saveReport(payload));
      return;
    }
    json(res, 404, { ok: false, error: "not found" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`FIDELITY HELPER ERROR: ${message}`);
    json(res, 400, { ok: false, error: message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Kpoparkive live fidelity helper listening on http://${HOST}:${PORT}`);
});
