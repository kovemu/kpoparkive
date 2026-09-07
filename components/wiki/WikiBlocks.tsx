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
  YoYo: "yoyo",
  "Re:Scene": "re-scene",
  SCENEDROME: "scenedrome",
  "Glow Up": "glow-up",
  Dearest: "dearest",
  "Heart Drop": "heart-drop",
  "lip bomb": "lip-bomb",
  "Busy Boy": "busy-boy",
  Runaway: "runaway",
  "Pretty Girl": "pretty-girl",
};

const relatedDocumentSlugs: Record<string, string> = {
  "RESCENE / Discography": "rescene-discography",
  "RESCENE / Member chemistry": "rescene-member-chemistry",
  "RESCENE / Activities": "rescene-activities",
  "RESCENE / Content": "rescene-content",
  "RESCENE / Performances & events": "rescene-performances-events",
  "RESCENE / Music shows": "rescene-music-shows",
  "RESCENE / YouTube": "rescene-youtube",
  "RESCENE / Live broadcasts": "rescene-live",
  "RESCENE / Advertising & pictorials": "rescene-advertising-pictorials",
  "RESCENE / Awards": "rescene-awards",
  "RESCENE / Trivia": "rescene-trivia",
  "RESCENE / Music videos": "rescene-music-videos",
  "RESCENE / Music show fancams": "rescene-fancams",
  "RESCENE / Detailed chart performance": "rescene-chart-performance",
  "RESCENE / Fan chants": "rescene-fan-chants",
  "RESCENE / Goods": "rescene-goods",
  "RESCENE / Karaoke catalog": "rescene-karaoke",
  REMINE: "remine",
  remini: "remini",
};

function flagFor(nationality: string) {
  if (nationality === "South Korea") return "🇰🇷";
  if (nationality === "Japan") return "🇯🇵";
  return "";
}

export default function WikiBlocks({ blocks }: { blocks: WikiBlock[] }) {
  return (
    <>
      {blocks.map((block, index) => {
        if (block.type === "paragraph") return <p key={index}>{block.text}</p>;

        if (block.type === "members") {
          return (
            <div className="memberGrid" key={index}>
              {block.items.map((member) => {
                const photoPath = memberPhotoPaths[member.name];
                return (
                  <article className="memberCard" key={member.name}>
                    <div className="memberPortrait">
                      {photoPath ? (
                        <img src={getStoragePublicUrl(photoPath)} alt={`${member.name} of RESCENE`} style={{ width: "100%", height: "100%", objectFit: "cover", objectPosition: "50% 30%", display: "block" }} />
                      ) : member.name.slice(0, 1)}
                    </div>
                    <a href={`/wiki/${member.name.toLowerCase()}`} className="memberName">{member.name}</a>
                    <div className="memberMeta">{member.birthday}</div>
                    <div className="flag" title={member.nationality}>{flagFor(member.nationality)}</div>
                  </article>
                );
              })}
            </div>
          );
        }

        if (block.type === "related") {
          const slug = relatedDocumentSlugs[block.target];
          return (
            <div className="subdocNotice" key={index}>
              {block.label}: {slug ? <a href={`/wiki/${slug}`}>{block.target}</a> : <span className="pendingLink">{block.target}</span>}
            </div>
          );
        }
        if (block.type === "quote") return <blockquote className="accentQuote" key={index}>{block.text}</blockquote>;
        if (block.type === "callout") return <div className="accentBox" key={index}>{block.paragraphs.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}</div>;
        if (block.type === "list") return <ul className="wikiList" key={index}>{block.items.map((item) => <li key={item}>{item}</li>)}</ul>;

        if (block.type === "table") {
          const isReleaseTable = block.columns[0] === "Release";
          return (
            <div className="simpleTable" key={index} style={{ "--table-columns": block.columns.length } as React.CSSProperties}>
              <div className="tableHead">{block.columns.map((column) => <span key={column}>{column}</span>)}</div>
              {block.rows.map((row, rowIndex) => (
                <div key={rowIndex}>
                  {row.map((cell, cellIndex) => {
                    if (cellIndex === 0) {
                      const coverPath = isReleaseTable ? albumCoverPaths[cell] : undefined;
                      const albumSlug = isReleaseTable ? albumDocumentSlugs[cell] : undefined;
                      return (
                        <strong key={cellIndex} style={coverPath ? { display: "flex", alignItems: "center", gap: 10 } : undefined}>
                          {coverPath && <img src={getStoragePublicUrl(coverPath)} alt={`${cell} cover`} width={54} height={54} style={{ width: 54, height: 54, objectFit: "cover", flex: "0 0 auto", border: "1px solid #d7dde5" }} />}
                          {albumSlug ? <a href={`/wiki/${albumSlug}`}>{cell}</a> : <span>{cell}</span>}
                        </strong>
                      );
                    }
                    return <span key={cellIndex}>{cell}</span>;
                  })}
                </div>
              ))}
            </div>
          );
        }

        if (block.type === "gallery-placeholder") return <div className="profileHistory" key={index}>{block.labels.map((label) => <div key={label}>{label}</div>)}</div>;
        return null;
      })}
    </>
  );
}
