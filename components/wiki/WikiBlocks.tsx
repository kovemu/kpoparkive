import type { WikiBlock } from "../../lib/wiki";
import { getStoragePublicUrl } from "../../lib/wiki";

const memberPhotoPaths: Record<string, string> = {
  Woni: "rescene/members/woni/profile.webp",
  Liv: "rescene/members/liv/profile.webp",
  Minami: "rescene/members/minami/profile.webp",
  May: "rescene/members/may/profile.webp",
  Zena: "rescene/members/zena/profile.webp",
};

const albumCoverPaths: Record<string, string> = {
  "Re:Scene": "rescene/albums/re-scene.jpg",
  SCENEDROME: "rescene/albums/scenedrome.jpg",
  "Glow Up": "rescene/albums/glow-up.jpg",
  Dearest: "rescene/albums/dearest.jpg",
  "Heart Drop": "rescene/albums/heart-drop.jpg",
  "lip bomb": "rescene/albums/lip-bomb.jpg",
  Runaway: "rescene/albums/runaway.jpg",
  "Pretty Girl": "rescene/albums/pretty-girl.jpg",
};

const albumDocumentSlugs: Record<string, string> = {
  YoYo: "yoyo", "Re:Scene": "re-scene", SCENEDROME: "scenedrome", "Glow Up": "glow-up", Dearest: "dearest",
  "Heart Drop": "heart-drop", "lip bomb": "lip-bomb", "Busy Boy": "busy-boy", Runaway: "runaway", "Pretty Girl": "pretty-girl",
};

const relatedDocumentSlugs: Record<string, string> = {
  "RESCENE / Discography": "rescene-discography", "RESCENE / Member chemistry": "rescene-member-chemistry",
  "RESCENE / Activities": "rescene-activities", "RESCENE / Content": "rescene-content",
  "RESCENE / Performances & events": "rescene-performances-events", "RESCENE / Music shows": "rescene-music-shows",
  "RESCENE / YouTube": "rescene-youtube", "RESCENE / Live broadcasts": "rescene-live",
  "RESCENE / Advertising & pictorials": "rescene-advertising-pictorials", "RESCENE / Awards": "rescene-awards",
  "RESCENE / Trivia": "rescene-trivia", "RESCENE / Music videos": "rescene-music-videos",
  "RESCENE / Music show fancams": "rescene-fancams", "RESCENE / Detailed chart performance": "rescene-chart-performance",
  "RESCENE / Fan chants": "rescene-fan-chants", "RESCENE / Goods": "rescene-goods", "RESCENE / Karaoke catalog": "rescene-karaoke",
  REMINE: "remine", remini: "remini",
};

function flagFor(nationality: string) {
  if (nationality === "South Korea") return "🇰🇷";
  if (nationality === "Japan") return "🇯🇵";
  return "";
}

function mirrorSlug(target: string) {
  return `mirror-${target.normalize("NFKC").toLowerCase().replace(/\([^)]*\)/g, "").replace(/[^a-z0-9가-힣]+/g, "-").replace(/^-+|-+$/g, "")}`;
}

function namuTarget(url: string) {
  let raw = "";
  if (url.startsWith("/w/")) raw = url.slice(3);
  else {
    try {
      const parsed = new URL(url);
      if (/^(?:www\.)?namu\.moe$/i.test(parsed.hostname) && parsed.pathname.startsWith("/w/")) raw = parsed.pathname.slice(3);
    } catch {}
  }
  if (!raw) return null;
  raw = raw.split(/[?#]/)[0];
  try { return decodeURIComponent(raw); } catch { return raw; }
}

function cellHref(url: string) {
  const target = namuTarget(url);
  return target ? `/admin/drafts/${mirrorSlug(target)}` : url;
}

function renderCellLink(url: string | undefined, label: string | undefined, fallback: string, hasImage = false) {
  if (!url) return fallback;
  const target = namuTarget(url);
  const rawText = label || fallback;
  const text = rawText && !/^https?:\/\//i.test(rawText) && !/^<img\b/i.test(rawText) ? rawText : "";
  if (target) {
    if (!text && hasImage) return null;
    return <a href={`/admin/drafts/${mirrorSlug(target)}`}>{text || target}</a>;
  }
  if (!text && hasImage) return null;
  return <a href={url} target={/^https?:\/\//.test(url) ? "_blank" : undefined} rel={/^https?:\/\//.test(url) ? "noreferrer" : undefined}>{text || url}</a>;
}

export default function WikiBlocks({ blocks }: { blocks: WikiBlock[] }) {
  return (
    <>
      {blocks.map((block, index) => {
        if (block.type === "paragraph") return <p key={index}>{block.text}</p>;

        if (block.type === "members") {
          return <div className="memberGrid" key={index}>{block.items.map((member) => {
            const photoPath = memberPhotoPaths[member.name];
            return <article className="memberCard" key={member.name}>
              <div className="memberPortrait">{photoPath ? <img src={getStoragePublicUrl(photoPath)} alt={`${member.name} of RESCENE`} style={{ width: "100%", height: "100%", objectFit: "cover", objectPosition: "50% 30%", display: "block" }} /> : member.name.slice(0, 1)}</div>
              <a href={`/wiki/${member.name.toLowerCase()}`} className="memberName">{member.name}</a>
              <div className="memberMeta">{member.birthday}</div><div className="flag" title={member.nationality}>{flagFor(member.nationality)}</div>
            </article>;
          })}</div>;
        }

        if (block.type === "related") {
          const slug = relatedDocumentSlugs[block.target] || (block.target.includes("/") ? mirrorSlug(block.target) : undefined);
          return <div className="subdocNotice" key={index}>{block.label}: {slug ? <a href={`/admin/drafts/${slug}`}>{block.target}</a> : <span className="pendingLink">{block.target}</span>}</div>;
        }

        if (block.type === "internal-link") {
          const slug = block.slug || relatedDocumentSlugs[block.label] || mirrorSlug(block.target);
          return <p className="wikiLinkRow" key={index}><a href={`/admin/drafts/${slug}`}>{block.label}</a></p>;
        }

        if (block.type === "external-link") return <p className="wikiLinkRow" key={index}><a href={block.url} target="_blank" rel="noreferrer">{block.label || block.url}</a></p>;

        if (block.type === "image") {
          const src = block.storage_path ? getStoragePublicUrl(block.storage_path) : block.url;
          if (!src) return <div className="assetPlaceholder" key={index}>Image pending · {block.alt || block.source_ref}</div>;
          return <figure className="wikiMedia" key={index}><img src={src} alt={block.alt || ""} loading="lazy" />{block.caption && <figcaption>{block.caption}</figcaption>}</figure>;
        }

        if (block.type === "video") {
          if (block.provider === "youtube" && block.video_id) {
            return <div className="wikiVideo" key={index}><iframe src={`https://www.youtube.com/embed/${block.video_id}`} title={block.label || "YouTube video"} loading="lazy" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowFullScreen /></div>;
          }
          return <div className="videoPlaceholder" key={index}><a href={block.url} target="_blank" rel="noreferrer">Open {block.provider} video</a></div>;
        }

        if (block.type === "quote") return <blockquote className="accentQuote" key={index}>{block.text}</blockquote>;
        if (block.type === "callout") return <div className="accentBox" key={index}>{block.paragraphs.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}</div>;
        if (block.type === "list") return <ul className="wikiList" key={index}>{block.items.map((item) => <li key={item}>{item}</li>)}</ul>;

        if (block.type === "rich-table") {
          return <div className="namuTableWrap" key={index}><table className="namuTable"><tbody>
            {block.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => {
              const Tag = cell.header ? "th" : "td";
              const style: React.CSSProperties = { background: cell.background, color: cell.color, textAlign: cell.align };
              const hasImage = Boolean(cell.image_url && !/상세 내용 아이콘|cc-by-nc-sa/i.test(cell.image_alt || ""));
              const image = hasImage ? <img className="namuCellImage" src={cell.image_url} alt={cell.image_alt || ""} loading="lazy" /> : null;
              const linkedImage = image && cell.link_url ? <a href={cellHref(cell.link_url)} target={!namuTarget(cell.link_url) && /^https?:\/\//.test(cell.link_url) ? "_blank" : undefined} rel={!namuTarget(cell.link_url) && /^https?:\/\//.test(cell.link_url) ? "noreferrer" : undefined}>{image}</a> : image;
              return <Tag key={cellIndex} rowSpan={cell.rowspan} colSpan={cell.colspan} style={style}>
                {linkedImage}
                {cell.link_url ? renderCellLink(cell.link_url, cell.link_label, cell.text, hasImage) : cell.text}
              </Tag>;
            })}</tr>)}
          </tbody></table></div>;
        }

        if (block.type === "table") {
          const isReleaseTable = block.columns[0] === "Release";
          return <div className="simpleTable" key={index} style={{ "--table-columns": block.columns.length } as React.CSSProperties}>
            <div className="tableHead">{block.columns.map((column, i) => <span key={`${column}-${i}`}>{column}</span>)}</div>
            {block.rows.map((row, rowIndex) => <div key={rowIndex}>{row.map((cell, cellIndex) => {
              if (cellIndex === 0) {
                const coverPath = isReleaseTable ? albumCoverPaths[cell] : undefined;
                const albumSlug = isReleaseTable ? albumDocumentSlugs[cell] : undefined;
                return <strong key={cellIndex} style={coverPath ? { display: "flex", alignItems: "center", gap: 10 } : undefined}>
                  {coverPath && <img src={getStoragePublicUrl(coverPath)} alt={`${cell} cover`} width={54} height={54} style={{ width: 54, height: 54, objectFit: "cover", flex: "0 0 auto", border: "1px solid #d7dde5" }} />}
                  {albumSlug ? <a href={`/wiki/${albumSlug}`}>{cell}</a> : <span>{cell}</span>}
                </strong>;
              }
              return <span key={cellIndex}>{cell}</span>;
            })}</div>)}
          </div>;
        }

        if (block.type === "gallery-placeholder") return <div className="profileHistory" key={index}>{block.labels.map((label) => <div key={label}>{label}</div>)}</div>;
        return null;
      })}
    </>
  );
}
