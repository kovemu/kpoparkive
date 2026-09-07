import { notFound } from "next/navigation";
import WikiBlocks from "../../../../components/wiki/WikiBlocks";
import type { WikiBlock } from "../../../../lib/wiki";
import { parseNamuHtmlV4 } from "../../../../lib/namuParserV4";

const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL || "https://hukrrzhltiyirtkxmotj.supabase.co").trim();
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

type AssetRow = {
  asset_type: string;
  source_ref: string;
  resolved_url: string | null;
  storage_path: string | null;
  status: string;
};

async function db<T>(path: string): Promise<T> {
  if (!SERVICE_ROLE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not configured");
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` },
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  return response.json() as Promise<T>;
}

function hydrate(blocks: WikiBlock[], assets: AssetRow[]) {
  const byRef = new Map(assets.filter((asset) => asset.status === "resolved").map((asset) => [asset.source_ref, asset]));
  return blocks.map((block) => {
    if (block.type === "image") {
      const asset = byRef.get(block.source_ref);
      if (asset?.storage_path) return { ...block, storage_path: asset.storage_path, url: asset.resolved_url || block.url };
      if (asset?.resolved_url) return { ...block, url: asset.resolved_url };
    }
    return block;
  });
}

function numberSections(sections: { heading_level: number; heading: string }[]) {
  let major = 0;
  let minor = 0;
  let patch = 0;
  return sections.map((section) => {
    if (!section.heading) return "";
    if (section.heading_level <= 2) { major += 1; minor = 0; patch = 0; return `${major}`; }
    if (section.heading_level === 3) { minor += 1; patch = 0; return `${major}.${minor}`; }
    patch += 1; return `${major}.${minor}.${patch}`;
  });
}

export default async function NamuPreviewPage({ params }: { params: Promise<{ title: string }> }) {
  const { title: encodedTitle } = await params;
  const title = decodeURIComponent(encodedTitle);
  const docs = await db<{ id: string; source_title: string; root_title: string; raw_html: string; fetched_at: string }[]>(
    `source_documents?source=eq.namu_mirror&source_title=eq.${encodeURIComponent(title)}&select=id,source_title,root_title,raw_html,fetched_at&limit=1`,
  );
  const source = docs[0];
  if (!source) notFound();

  const sections = parseNamuHtmlV4(source.raw_html || "");
  const assets = await db<AssetRow[]>(
    `source_asset_queue?source_document_id=eq.${source.id}&select=asset_type,source_ref,resolved_url,storage_path,status`,
  );
  const hydrated = sections.map((section) => ({ ...section, content: hydrate(section.content as WikiBlock[], assets) }));
  const visibleSections = hydrated.filter((section) => section.heading);
  const numbers = numberSections(hydrated);

  return (
    <>
      <meta name="robots" content="noindex,nofollow,noarchive" />
      <header className="siteHeader">
        <a className="brand" href="/">Kpoparkive</a>
        <div className="draftBadge">NAMUWIKI SOURCE-ORDER PREVIEW · v4</div>
      </header>
      <main id="top" className="articleShell" style={{ "--accent": "#fc6fcf" } as React.CSSProperties}>
        <div className="articleHeader">
          <div>
            <div className="breadcrumbs"><a href="/">Kpoparkive</a> › Namu mirror › {source.source_title}</div>
            <h1>{source.source_title}</h1>
            <p>Live structural preview from the saved Namu mirror snapshot. Text is intentionally still Korean; translation comes after structural fidelity.</p>
          </div>
        </div>

        {hydrated.filter((section) => !section.heading).map((section) => (
          <section key={section.section_key} className="namuLead"><WikiBlocks blocks={section.content as WikiBlock[]} /></section>
        ))}

        <nav className="toc" aria-label="Contents">
          <div className="tocHeader">목차 <span>⌄</span></div>
          <ol>
            {visibleSections.map((section) => {
              const index = hydrated.indexOf(section);
              return <li key={section.section_key} className={`tocLevel${Math.max(1, section.heading_level - 1)}`}>
                <a href={`#${section.section_key}`}><span>{numbers[index]}.</span> {section.heading}</a>
              </li>;
            })}
          </ol>
        </nav>

        {hydrated.filter((section) => section.heading).map((section) => {
          const index = hydrated.indexOf(section);
          const Tag = section.heading_level >= 4 ? "h4" : section.heading_level === 3 ? "h3" : "h2";
          return <section key={section.section_key}>
            <Tag id={section.section_key} className={`sectionTitle sectionLevel${section.heading_level}`}>
              <span className="sectionChevron">⌄</span><span className="sectionNumber">{numbers[index]}.</span> {section.heading}
            </Tag>
            <WikiBlocks blocks={section.content as WikiBlock[]} />
          </section>;
        })}
      </main>
    </>
  );
}
