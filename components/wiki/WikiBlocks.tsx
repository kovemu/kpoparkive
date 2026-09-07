import type { WikiBlock } from "../../lib/wiki";

function flagFor(nationality: string) {
  if (nationality === "South Korea") return "🇰🇷";
  if (nationality === "Japan") return "🇯🇵";
  return "";
}

export default function WikiBlocks({ blocks }: { blocks: WikiBlock[] }) {
  return (
    <>
      {blocks.map((block, index) => {
        if (block.type === "paragraph") {
          return <p key={index}>{block.text}</p>;
        }

        if (block.type === "members") {
          return (
            <div className="memberGrid" key={index}>
              {block.items.map((member) => (
                <article className="memberCard" key={member.name}>
                  <div className="memberPortrait">{member.name.slice(0, 1)}</div>
                  <a href={`/wiki/${member.name.toLowerCase()}`} className="memberName">{member.name}</a>
                  <div className="memberMeta">{member.birthday}</div>
                  <div className="flag" title={member.nationality}>{flagFor(member.nationality)}</div>
                </article>
              ))}
            </div>
          );
        }

        if (block.type === "related") {
          return (
            <div className="subdocNotice" key={index}>
              {block.label}: <span className="pendingLink">{block.target}</span>
            </div>
          );
        }

        if (block.type === "quote") {
          return <blockquote className="accentQuote" key={index}>{block.text}</blockquote>;
        }

        if (block.type === "callout") {
          return (
            <div className="accentBox" key={index}>
              {block.paragraphs.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
            </div>
          );
        }

        if (block.type === "list") {
          return (
            <ul className="wikiList" key={index}>
              {block.items.map((item) => <li key={item}>{item}</li>)}
            </ul>
          );
        }

        if (block.type === "table") {
          return (
            <div className="simpleTable" key={index}>
              <div className="tableHead">
                {block.columns.map((column) => <span key={column}>{column}</span>)}
              </div>
              {block.rows.map((row, rowIndex) => (
                <div key={rowIndex}>
                  {row.map((cell, cellIndex) => cellIndex === 0
                    ? <strong key={cellIndex}>{cell}</strong>
                    : <span key={cellIndex}>{cell}</span>)}
                </div>
              ))}
            </div>
          );
        }

        if (block.type === "gallery-placeholder") {
          return (
            <div className="profileHistory" key={index}>
              {block.labels.map((label) => <div key={label}>{label}</div>)}
            </div>
          );
        }

        return null;
      })}
    </>
  );
}
