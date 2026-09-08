import { NextResponse } from "next/server";

export const maxDuration = 60;

const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL || "https://hukrrzhltiyirtkxmotj.supabase.co").trim();
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ADMIN_KEY = process.env.KPOPARKIVE_ADMIN_KEY;
const BUCKET = "wiki-media";

function dbHeaders(extra: Record<string, string> = {}) {
  if (!SERVICE_ROLE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not configured");
  return { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}`, "Content-Type": "application/json", ...extra };
}

async function db(path: string) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: dbHeaders(), cache: "no-store" });
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  return response.json();
}

function safePart(value: string) {
  const ascii = value.normalize("NFKD").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  return ascii || "asset";
}

async function listImportObjects(prefix: string) {
  const files: string[] = [];
  let offset = 0;
  while (offset < 20000) {
    const response = await fetch(`${SUPABASE_URL}/storage/v1/object/list/${BUCKET}`, {
      method: "POST",
      headers: dbHeaders(),
      body: JSON.stringify({ prefix, limit: 1000, offset, sortBy: { column: "name", order: "asc" } }),
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`storage list ${response.status}: ${await response.text()}`);
    const rows = await response.json() as Array<{ id?: string | null; name?: string | null }>;
    const objects = rows.filter(row => row.id && row.name);
    for (const row of objects) {
      const name = String(row.name);
      files.push(name.startsWith(`${prefix}/`) ? name : `${prefix}/${name}`);
    }
    if (rows.length < 1000) break;
    offset += rows.length;
  }
  return [...new Set(files)];
}

async function removeObjects(paths: string[]) {
  let deleted = 0;
  for (let index = 0; index < paths.length; index += 1000) {
    const chunk = paths.slice(index, index + 1000);
    const response = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}`, {
      method: "DELETE",
      headers: dbHeaders(),
      body: JSON.stringify({ prefixes: chunk }),
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`storage remove ${response.status}: ${await response.text()}`);
    deleted += chunk.length;
  }
  return deleted;
}

export async function POST(request: Request) {
  if (!ADMIN_KEY || request.headers.get("x-admin-key") !== ADMIN_KEY) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json() as { rootTitle?: string };
    const rootTitle = String(body.rootTitle || "").trim();
    if (!rootTitle) return NextResponse.json({ error: "rootTitle is required" }, { status: 400 });

    const prefix = `imports/${safePart(rootTitle)}`;
    const queueRows = await db(
      `source_asset_queue?root_title=eq.${encodeURIComponent(rootTitle)}&storage_path=not.is.null&select=storage_path&limit=10000`,
    ) as Array<{ storage_path: string | null }>;
    const referenced = new Set(queueRows.map(row => row.storage_path).filter((value): value is string => Boolean(value)));
    const stored = await listImportObjects(prefix);
    const orphaned = stored.filter(path => !referenced.has(path));
    const deleted = await removeObjects(orphaned);

    return NextResponse.json({
      ok: true,
      rootTitle,
      prefix,
      stored: stored.length,
      referenced: referenced.size,
      orphaned: orphaned.length,
      deleted,
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unknown storage cleanup error" }, { status: 500 });
  }
}
