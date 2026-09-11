import { redirect } from "next/navigation";

function titleFromSegments(segments: string[]) {
  const decoded = segments
    .map((segment) => decodeURIComponent(segment))
    .join("/")
    .normalize("NFKC")
    .trim();

  // The Tree edit links can use the NamuWiki document namespace prefix.
  // Kpoparkive source_documents store the actual source_title without it.
  return decoded.replace(/^문서:/, "").trim();
}

function adminEditorPath(title: string) {
  return `/admin/editor/${title
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/")}`;
}

export default async function LegacyWikiEditRedirect({
  params,
}: {
  params: Promise<{ title: string[] }>;
}) {
  const { title: segments } = await params;
  redirect(adminEditorPath(titleFromSegments(segments)));
}
