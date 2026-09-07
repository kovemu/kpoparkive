import { notFound } from "next/navigation";
import WikiBlocks from "../../../../components/wiki/WikiBlocks";
import type { RichWikiCell, WikiBlock } from "../../../../lib/wiki";
import { parseNamuHtmlV4 } from "../../../../lib/namuParserV4";
import styles from "./namuPreview.module.css";

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

function validColor(value?: string) {
  if (!value) return undefined;
  const color = value.trim();
  if (/^#[0-9a-f]{3,8}$/i.test(color) || /^rgba?\([^)]*\)$/i.test(color)) return color;
  if (/^(?:black|white|transparent|gray|grey|red|blue|green|pink|purple|orange|yellow)$/i.test(color)) return color;
  return undefined;
}

function cleanControlText(input: string) {
  let text = input;
  const country = ["대한민국", "일본", "미국", "중국"].find((name) => text.includes(name));
  if (country && /(행정구|속령|#!wiki|\{\{\{)/.test(text)) {
    const date = text.match(/\b\d{4}\.\s*\d{1,2}\.\s*\d{1,2}\.?/);
    return date ? `${date[0].replace(/\s+/g, " ")} ${country}` : country;
  }
  if (/REMINE/.test(text)) return "REMINE (리마인)";
  text = text
    .replace(/#!(?:wiki|if|folding|style|html)\b[^{}]*/gi, " ")
    .replace(/\{\{\{(?:[-+]\d+)?/g, " ")
    .replace(/\}\}\}/g, " ")
    .replace(/<(?:tableclass|nopad|rowkeepall|colkeepall|keepall|thead|sortable)[^>]*>/gi, " ")
    .replace(/\[dday\([^\]]+\)\]/gi, "")
    .replace(/\(\s*\)/g, "")
    .replace(/^\{\s*padding:[^}]+\}$/gi, "")
    .replace(/^\|\s*<[^>]+>\s*$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text;
}

function sanitizeCell(cell: RichWikiCell): RichWikiCell {
  const text = cleanControlText(cell.text || "");
  const linkLabel = cell.link_label ? cleanControlText(cell.link_label) : cell.link_label;
  const fileLink = /^파일:/i.test(linkLabel || "") || /\/w\/%?ED%8C%8C%EC%9D%BC/i.test(cell.link_url || "");
  return {
    ...cell,
    text,
    background: validColor(cell.background),
    color: validColor(cell.color),
    link_url: fileLink ? undefined : cell.link_url,
    link_label: fileLink ? undefined : linkLabel,
  };
}

function isControlNoise(text: string) {
  const markers = ["#!wiki", "#!style", "onclick=", "tableclass=", "div.tab", "{{{#!", "remove-class,", "toggle-class,"];
  const hits = markers.filter((marker) => text.includes(marker)).length;
  return hits >= 2 || text.length > 900 && hits >= 1;
}

function sanitizeBlocks(blocks: WikiBlock[]): WikiBlock[] {
  const output: WikiBlock[] = [];
  for (const block of blocks) {
    if (block.type === "paragraph") {
      if (isControlNoise(block.text)) continue;
      const text = cleanControlText(block.text);
      if (!text || /^문서 를 의 .*부분을 참고하십시오/.test(text)) continue;
      if (/\]\]\s*\[|^\|\s*<|^\{\s*padding:/.test(text)) continue;
      output.push({ ...block, text });
      continue;
    }
    if (block.type === "list") {
      const items = block.items.map(cleanControlText).filter(Boolean);
      if (items.length) output.push({ ...block, items });
      continue;
    }
    if (block.type === "rich-table") {
      const rows = block.rows
        .map((row) => row.map(sanitizeCell))
        .filter((row) => row.some((cell) => cell.text || cell.image_url || cell.link_url));
      if (rows.length) output.push({ ...block, rows });
      continue;
    }
    output.push(block);
  }
  return output;
}

function isMainInfobox(block: WikiBlock) {
  if (block.type !== "rich-table") return false;
  const text = block.rows.flat().map((cell) => cell.text).join(" ");
  return text.includes("데뷔일") && text.includes("장르") && text.includes("리더") && text.includes("소속사");
}

function cleanLead(blocks: WikiBlock[]) {
  const mainInfoboxIndex = blocks.findIndex(isMainInfobox);
  if (mainInfoboxIndex < 0) return blocks.filter((block) => block.type !== "paragraph");
  const main = blocks[mainInfoboxIndex];
  return [main];
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
  const hydrated = sections.map((section) => {
    const sanitized = sanitizeBlocks(hydrate(section.content as WikiBlock[], assets));
    return {
      ...section,
      content: section.heading ? sanitized : cleanLead(sanitized),
    };
  });
  const visibleSections = hydrated.filter((section) => section.heading);
  const numbers = numberSections(hydrated);

  return (
    <>
      <meta name="robots" content="noindex,nofollow,noarchive" />
      <header className="siteHeader">
        <a className="brand" href="/">Kpoparkive</a>
        <div className="draftBadge">NAMUWIKI STRUCTURAL MIRROR · v4</div>
      </header>
      <main id="top" className={`articleShell ${styles.preview}`} style={{ "--accent": "#fc6fcf" } as React.CSSProperties}>
        <div className="articleHeader">
          <div>
            <div className="breadcrumbs"><a href="/">Kpoparkive</a> › Namu mirror › {source.source_title}</div>
            <h1>{source.source_title}</h1>
            <p>Structural mirror preview. Korean source text is kept until the document layout matches the source.</p>
          </div>
        </div>

        {hydrated.filter((section) => !section.heading && section.content.length).map((section) => (
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

        {visibleSections.map((section) => {
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
