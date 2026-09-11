import fs from "node:fs";
import path from "node:path";

const ROOT_DIR = process.cwd();

function loadEnv(filePath) {
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

loadEnv(path.join(ROOT_DIR, ".env.local"));
loadEnv(path.join(ROOT_DIR, ".env"));

const SUPABASE_URL = String(process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/$/, "");
const SERVICE_ROLE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "");
if (!SUPABASE_URL || !SERVICE_ROLE_KEY) throw new Error("Supabase env is missing");

async function db(pathname) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${pathname}`, {
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
    },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Supabase ${response.status}: ${text}`);
  return text ? JSON.parse(text) : [];
}

const rows = await db(
  "template_dom_fallbacks?translation_status=eq.pending_chatgpt" +
  "&select=id,source_title,template_title,source_text_nodes,source_html_hash,updated_at" +
  "&order=updated_at.asc&limit=200"
);

if (!rows.length) {
  console.log("No pending DOM fallback translations.");
  process.exit(0);
}

console.log(`Pending DOM fallback translations: ${rows.length}`);
for (const row of rows) {
  const nodes = Array.isArray(row.source_text_nodes) ? row.source_text_nodes : [];
  const hangul = nodes.filter((item) => item?.hasHangul);
  console.log("");
  console.log(`[${row.id}] ${row.source_title} :: ${row.template_title}`);
  console.log(`source-hash=${row.source_html_hash} · translatable-nodes=${hangul.length}`);
  for (const item of hangul) {
    console.log(`  x${item.count || 1}  ${item.text}`);
  }
}
