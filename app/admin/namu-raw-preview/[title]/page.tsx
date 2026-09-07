import { notFound } from "next/navigation";
import { extractMirrorRawBundle } from "../../../../lib/namuRawSource";

const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL || "https://hukrrzhltiyirtkxmotj.supabase.co").trim();
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function db<T>(path: string): Promise<T> {
  if (!SERVICE_ROLE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not configured");
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` },
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  return response.json() as Promise<T>;
}

export default async function NamuRawPreviewPage({ params }: { params: Promise<{ title: string }> }) {
  const { title: encodedTitle } = await params;
  const title = decodeURIComponent(encodedTitle);
  const docs = await db<{
    source_title: string;
    raw_html: string;
    source_wikitext: string | null;
    source_format: string | null;
    raw_extracted_at: string | null;
  }[]>(
    `source_documents?source=eq.namu_mirror&source_title=eq.${encodeURIComponent(title)}&select=source_title,raw_html,source_wikitext,source_format,raw_extracted_at&limit=1`,
  );
  const source = docs[0];
  if (!source) notFound();

  const bundle = extractMirrorRawBundle(source.raw_html || "");
  const raw = source.source_wikitext || bundle.sourceWikitext;

  return (
    <>
      <meta name="robots" content="noindex,nofollow,noarchive" />
      <header className="siteHeader">
        <a className="brand" href="/">Kpoparkive</a>
        <div className="draftBadge">NAMU RAW SOURCE · HYBRID V1</div>
      </header>
      <main className="articleShell" style={{ maxWidth: 1180 }}>
        <div className="articleHeader">
          <div>
            <div className="breadcrumbs"><a href="/">Kpoparkive</a> › Raw source › {source.source_title}</div>
            <h1>{source.source_title}</h1>
            <p>This screen proves how much original Namu syntax survives in the mirror before we build the new renderer.</p>
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12, margin: "18px 0" }}>
          <Metric label="Raw blocks" value={String(bundle.rawBlockCount)} />
          <Metric label="Raw characters" value={bundle.rawCharacters.toLocaleString()} />
          <Metric label="Rendered fallback chars" value={bundle.renderedCharacters.toLocaleString()} />
          <Metric label="Estimated raw coverage" value={`${bundle.estimatedRawCoverage}%`} />
          <Metric label="File refs in raw" value={String(bundle.fileRefs.length)} />
          <Metric label="Internal links in raw" value={String(bundle.internalLinks.length)} />
        </div>

        <section>
          <h2 className="sectionTitle">Recovered Namu syntax</h2>
          <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", padding: 18, border: "1px solid #d7dde5", borderRadius: 8, background: "#f8fafc", fontSize: 13, lineHeight: 1.55 }}>{raw || "No raw syntax blocks recovered."}</pre>
        </section>

        <section>
          <h2 className="sectionTitle">Recovered file references</h2>
          <ul className="wikiList">{bundle.fileRefs.slice(0, 300).map((file) => <li key={file}>{file}</li>)}</ul>
        </section>
      </main>
    </>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div style={{ border: "1px solid #d7dde5", borderRadius: 8, padding: 14, background: "white" }}><div style={{ fontSize: 12, color: "#667085" }}>{label}</div><div style={{ marginTop: 4, fontSize: 22, fontWeight: 700 }}>{value}</div></div>;
}
