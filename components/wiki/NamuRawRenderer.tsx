import React from "react";
import type { NamuInline, NamuRawCell, NamuRawNode } from "../../lib/namuRawParser";

type AssetMap = Record<string, string>;

function internalHref(target: string) {
  const [title, anchor] = target.split("#", 2);
  const base = `/admin/namu-hybrid-preview/${encodeURIComponent(title || target)}`;
  return anchor ? `${base}#${encodeURIComponent(anchor)}` : base;
}

function normalizeFileRef(file: string) {
  return file.normalize("NFKC").trim().replace(/^(?:파일|File):/i, "");
}

function imageStyle(width?: string, height?: string): React.CSSProperties {
  const style: React.CSSProperties = { display: "block", maxWidth: "100%", height: "auto" };
  if (width && /^(?:\d+(?:\.\d+)?(?:px|%|rem|em|vw)?|auto)$/i.test(width)) style.width = /^\d+$/.test(width) ? `${width}px` : width;
  if (height && /^\d+(?:\.\d+)?(?:px|rem|em|vh)?$/i.test(height)) style.height = /^\d+$/.test(height) ? `${height}px` : height;
  return style;
}

function findAsset(assets: AssetMap, file: string) {
  const normalized = normalizeFileRef(file);
  if (assets[normalized]) return assets[normalized];
  for (const [key, url] of Object.entries(assets)) {
    if (normalizeFileRef(key) === normalized) return url;
  }
  return undefined;
}

function Inline({ nodes, assets }: { nodes: NamuInline[]; assets: AssetMap }) {
  return <>
    {nodes.map((node, index) => {
      if (node.type === "text") return <React.Fragment key={index}>{node.text.split("\n").map((part, line) => <React.Fragment key={line}>{line > 0 && <br />}{part}</React.Fragment>)}</React.Fragment>;
      if (node.type === "link") return <a key={index} href={internalHref(node.target)}>{node.label}</a>;
      const file = normalizeFileRef(node.file);
      const url = findAsset(assets, file);
      if (url) return <img key={index} src={url} alt={file} loading="lazy" style={imageStyle(node.width, node.height)} />;
      return <span key={index} title={`Unresolved image: ${file}`} style={{ display: "inline-block", padding: "4px 7px", border: "1px dashed #c7ccd4", color: "#667085", fontSize: 12 }}>[{file}]</span>;
    })}
  </>;
}

function cellStyle(cell: NamuRawCell): React.CSSProperties {
  return {
    background: cell.background,
    color: cell.color,
    textAlign: cell.align,
    width: cell.width,
    padding: cell.nopad ? 0 : undefined,
    verticalAlign: "middle",
  };
}

export default function NamuRawRenderer({ nodes, assets = {} }: { nodes: NamuRawNode[]; assets?: AssetMap }) {
  return <div className="namuRawRenderer">
    {nodes.map((node, index) => {
      if (node.type === "heading") {
        if (node.level <= 2) return <h2 key={index} className="sectionTitle">{node.text}</h2>;
        if (node.level === 3) return <h3 key={index} className="sectionTitle">{node.text}</h3>;
        return <h4 key={index} className="sectionTitle">{node.text}</h4>;
      }
      if (node.type === "paragraph") return <p key={index} className="wikiParagraph"><Inline nodes={node.children} assets={assets} /></p>;
      if (node.type === "table") return <div key={index} style={{ overflowX: "auto", margin: "12px 0" }}><table className="wikiTable" style={{ borderCollapse: "collapse", width: "100%" }}><tbody>
        {node.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex} rowSpan={cell.rowspan} colSpan={cell.colspan} style={cellStyle(cell)}><Inline nodes={cell.children} assets={assets} /></td>)}</tr>)}
      </tbody></table></div>;
      return null;
    })}
  </div>;
}
