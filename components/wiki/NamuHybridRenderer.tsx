import React from "react";
import type { NamuHybridChunk } from "../../lib/namuHybrid";
import type { WikiBlock } from "../../lib/wiki";
import NamuRawRenderer from "./NamuRawRenderer";
import WikiBlocks from "./WikiBlocks";

type AssetMap = Record<string, string>;

function headingTag(level: number) {
  if (level <= 2) return "h2" as const;
  if (level === 3) return "h3" as const;
  return "h4" as const;
}

function sectionId(sourceIndex: number, key: string, localIndex: number) {
  const safe = key.normalize("NFKC").toLowerCase().replace(/[^a-z0-9가-힣]+/g, "-").replace(/^-+|-+$/g, "");
  return `hybrid-${sourceIndex}-${safe || localIndex}`;
}

export default function NamuHybridRenderer({ chunks, assets = {} }: { chunks: NamuHybridChunk[]; assets?: AssetMap }) {
  return <div className="namuHybridRenderer">
    {chunks.map((chunk) => {
      if (chunk.type === "raw") {
        return <div key={`raw-${chunk.sourceIndex}`} data-hybrid-source="raw">
          <NamuRawRenderer nodes={chunk.nodes} assets={assets} />
        </div>;
      }

      return <React.Fragment key={`rendered-${chunk.sourceIndex}`}>
        {chunk.sections.map((section, sectionIndex) => {
          const id = sectionId(chunk.sourceIndex, section.section_key, sectionIndex);
          const Tag = headingTag(section.heading_level);
          return <section key={`${id}-${sectionIndex}`} data-hybrid-source="rendered">
            {section.heading ? <Tag id={id} className={`sectionTitle sectionLevel${section.heading_level}`}>{section.heading}</Tag> : null}
            <WikiBlocks blocks={section.content as WikiBlock[]} internalLinkMode="hybrid" />
          </section>;
        })}
      </React.Fragment>;
    })}
  </div>;
}
