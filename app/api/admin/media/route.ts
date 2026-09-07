import { NextResponse } from "next/server";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "https://hukrrzhltiyirtkxmotj.supabase.co";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ADMIN_KEY = process.env.KPOPARKIVE_ADMIN_KEY;

function adminHeaders() {
  if (!SERVICE_ROLE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not configured");
  return {
    apikey: SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
  };
}

function cleanPart(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "media";
}

export async function POST(request: Request) {
  try {
    if (!ADMIN_KEY || request.headers.get("x-admin-key") !== ADMIN_KEY) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const form = await request.formData();
    const file = form.get("file");
    const documentSlug = String(form.get("documentSlug") ?? "").trim().toLowerCase();
    const role = String(form.get("role") ?? "image").trim();
    const caption = String(form.get("caption") ?? "").trim();
    const altText = String(form.get("altText") ?? "").trim();
    const sourceCredit = String(form.get("sourceCredit") ?? "").trim();

    if (!(file instanceof File) || !documentSlug) {
      return NextResponse.json({ error: "A file and document slug are required." }, { status: 400 });
    }

    if (!file.type.startsWith("image/")) {
      return NextResponse.json({ error: "Only image files are supported." }, { status: 400 });
    }

    if (file.size > 10 * 1024 * 1024) {
      return NextResponse.json({ error: "Image must be 10 MB or smaller." }, { status: 400 });
    }

    const documentResponse = await fetch(
      `${SUPABASE_URL}/rest/v1/documents?slug=eq.${encodeURIComponent(documentSlug)}&select=id,slug&limit=1`,
      { headers: adminHeaders(), cache: "no-store" },
    );

    if (!documentResponse.ok) {
      return NextResponse.json({ error: await documentResponse.text() }, { status: 500 });
    }

    const documents = await documentResponse.json() as { id: string; slug: string }[];
    const document = documents[0];
    if (!document) {
      return NextResponse.json({ error: `Document not found: ${documentSlug}` }, { status: 404 });
    }

    const extension = cleanPart(file.name.split(".").pop() ?? "webp");
    const baseName = cleanPart(file.name.replace(/\.[^.]+$/, ""));
    const rolePath = cleanPart(role.replace(/:/g, "-"));
    const storagePath = `${document.slug}/${rolePath}/${Date.now()}-${baseName}.${extension}`;

    const uploadResponse = await fetch(
      `${SUPABASE_URL}/storage/v1/object/wiki-media/${storagePath}`,
      {
        method: "POST",
        headers: {
          ...adminHeaders(),
          "Content-Type": file.type,
          "x-upsert": "false",
        },
        body: await file.arrayBuffer(),
      },
    );

    if (!uploadResponse.ok) {
      return NextResponse.json({ error: await uploadResponse.text() }, { status: 500 });
    }

    const mediaResponse = await fetch(`${SUPABASE_URL}/rest/v1/media`, {
      method: "POST",
      headers: {
        ...adminHeaders(),
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      body: JSON.stringify({
        document_id: document.id,
        bucket: "wiki-media",
        storage_path: storagePath,
        media_type: "image",
        role,
        caption: caption || null,
        alt_text: altText || null,
        source_credit: sourceCredit || null,
        mime_type: file.type,
      }),
    });

    if (!mediaResponse.ok) {
      return NextResponse.json({ error: await mediaResponse.text(), storagePath }, { status: 500 });
    }

    const inserted = await mediaResponse.json();
    return NextResponse.json({ ok: true, storagePath, media: inserted[0] ?? null });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown upload error" },
      { status: 500 },
    );
  }
}
