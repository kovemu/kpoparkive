import React from "react";
import { findNamuAsset, normalizeNamuFileRef } from "../../lib/namuAssetLookup";
import type { NamuInline, NamuRawCell, NamuRawNode, NamuRawTableMeta } from "../../lib/namuRawParser";
import styles from "./NamuRawRenderer.module.css";

type AssetMap = Record<string, string>;

type FootnoteEntry = {
  number: number;
  id?: string;
  children: NamuInline[];
};

type FootnoteRegistry = {
  numbers: Map<NamuInline, number>;
  entries: FootnoteEntry[];
};

function internalHref(target: string) {
  if (target.startsWith("#")) return `#${encodeURIComponent(target.slice(1))}`;
  const [title, anchor] = target.split("#", 2);
  const base = `/admin/namu-hybrid-preview/${encodeURIComponent(title || target)}`;
  return anchor ? `${base}#${encodeURIComponent(anchor)}` : base;
}

function imageStyle(width?: string, height?: string): React.CSSProperties {
  const style: React.CSSProperties = { display: "block", maxWidth: "100%", height: "auto" };
  if (width && /^(?:\d+(?:\.\d+)?(?:px|%|rem|em|vw)?|auto)$/i.test(width)) style.width = /^\d+$/.test(width) ? `${width}px` : width;
  if (height && /^\d+(?:\.\d+)?(?:px|rem|em|vh)?$/i.test(height)) style.height = /^\d+$/.test(height) ? `${height}px` : height;
  return style;
}

// Inline rendering intentionally mirrors the recursive source nesting.
function nestedInlineChildren(node: NamuInline): NamuInline[] | undefined {
  if (node.type === "link" || node.type === "footnote" || node.type === "strong" || node.type === "em" || node.type === "size" || node.type === "color" || node.type === "span") return node.children;
  return undefined;
}

function collectFootnotes(nodes: NamuRawNode[]): FootnoteRegistry {
  const numbers = new Map<NamuInline, number>();
  const entries: FootnoteEntry[] = [];
  const named = new Map<string, number>();

  const visitInline = (inlineNodes: NamuInline[]) => {
    for (const node of inlineNodes) {
      if (node.type === "footnote") {
        let number = node.id ? named.get(node.id) : undefined;
        if (!number) {
          number = entries.length + 1;
          entries.push({ number, id: node.id, children: node.children });
          if (node.id) named.set(node.id, number);
        }
        numbers.set(node, number);
      }
      const children = nestedInlineChildren(node);
      if (children?.length) visitInline(children);
    }
  };

  const visitNodes = (blockNodes: NamuRawNode[]) => {
    for (const node of blockNodes) {
      if (node.type === "paragraph") visitInline(node.children);
      else if (node.type === "table") node.rows.forEach((row) => row.forEach((cell) => visitInline(cell.children)));
      else if (node.type === "directive" || node.type === "quote") visitNodes(node.children);
      else if (node.type === "list") node.items.forEach((item) => visitInline(item.children));
    }
  };

  visitNodes(nodes);
  return { numbers, entries };
}

const SAFE_STYLE_PROPERTIES: Record<string, keyof React.CSSProperties> = {
  "display": "display",
  "justify-content": "justifyContent",
  "align-items": "alignItems",
  "align-content": "alignContent",
  "flex": "flex",
  "flex-grow": "flexGrow",
  "flex-shrink": "flexShrink",
  "flex-basis": "flexBasis",
  "flex-direction": "flexDirection",
  "flex-wrap": "flexWrap",
  "gap": "gap",
  "row-gap": "rowGap",
  "column-gap": "columnGap",
  "text-align": "textAlign",
  "vertical-align": "verticalAlign",
  "background": "background",
  "background-color": "backgroundColor",
  "color": "color",
  "width": "width",
  "max-width": "maxWidth",
  "min-width": "minWidth",
  "height": "height",
  "max-height": "maxHeight",
  "min-height": "minHeight",
  "margin": "margin",
  "margin-left": "marginLeft",
  "margin-right": "marginRight",
  "margin-top": "marginTop",
  "margin-bottom": "marginBottom",
  "padding": "padding",
  "padding-left": "paddingLeft",
  "padding-right": "paddingRight",
  "padding-top": "paddingTop",
  "padding-bottom": "paddingBottom",
  "border": "border",
  "border-left": "borderLeft",
  "border-right": "borderRight",
  "border-top": "borderTop",
  "border-bottom": "borderBottom",
  "border-radius": "borderRadius",
  "box-sizing": "boxSizing",
  "font": "font",
  "font-family": "fontFamily",
  "font-size": "fontSize",
  "font-weight": "fontWeight",
  "line-height": "lineHeight",
  "letter-spacing": "letterSpacing",
  "text-decoration": "textDecoration",
  "white-space": "whiteSpace",
  "word-break": "wordBreak",
  "overflow": "overflow",
  "overflow-x": "overflowX",
  "overflow-y": "overflowY",
};

function safeWikiStyle(args: string): React.CSSProperties | undefined {
  const styleSource = args.match(/\bstyle\s*=\s*"([^"]*)"/i)?.[1] ?? args.match(/\bstyle\s*=\s*'([^']*)'/i)?.[1];
  if (!styleSource) return undefined;
  const output: Record<string, string> = {};
  for (const declaration of styleSource.split(";")) {
    const separator = declaration.indexOf(":");
    if (separator < 0) continue;
    const property = declaration.slice(0, separator).trim().toLowerCase();
    const reactProperty = SAFE_STYLE_PROPERTIES[property];
    if (!reactProperty) continue;
    const value = declaration.slice(separator + 1).trim();
    if (!value || /url\s*\(|expression\s*\(|javascript:|[<>]/i.test(value)) continue;
    output[String(reactProperty)] = value;
  }
  return Object.keys(output).length ? output as React.CSSProperties : undefined;
}

function directiveClass(args: string) {
  const value = args.match(/\bclass\s*=\s*"([^"]*)"/i)?.[1] ?? args.match(/\bclass\s*=\s*'([^']*)'/i)?.[1];
  if (!value || !/^[a-z0-9_ -]+$/i.test(value)) return undefined;
  return value.trim() || undefined;
}

function safeInlineColor(value: string) {
  if (/^#[0-9a-f]{3,8}$/i.test(value)) return value;
  if (/^[a-z][a-z0-9-]{1,30}$/i.test(value)) return value;
  return undefined;
}

function sizeStyle(level: number): React.CSSProperties {
  const scale: Record<number, string> = {
    [-5]: "0.5em",
    [-4]: "0.6em",
    [-3]: "0.7em",
    [-2]: "0.8em",
    [-1]: "0.9em",
    [0]: "1em",
    [1]: "1.2em",
    [2]: "1.4em",
    [3]: "1.6em",
    [4]: "1.8em",
    [5]: "2em",
  };
  return { fontSize: scale[Math.max(-5, Math.min(5, level))] || "1em", lineHeight: 1.35 };
}

function Inline({ nodes, assets, footnotes }: { nodes: NamuInline[]; assets: AssetMap; footnotes: FootnoteRegistry }) {
  return <>
    {nodes.map((node, index) => {
      if (node.type === "text") return <React.Fragment key={index}>{node.text.split("\n").map((part, line) => <React.Fragment key={line}>{line > 0 && <br />}{part}</React.Fragment>)}</React.Fragment>;
      if (node.type === "linebreak") return <br key={index} />;
      if (node.type === "link") return <a key={index} href={internalHref(node.target)} style={{ whiteSpace: "pre-line" }}>{node.children?.length ? <Inline nodes={node.children} assets={assets} footnotes={footnotes} /> : node.label}</a>;
      if (node.type === "footnote") {
        const number = footnotes.numbers.get(node);
        if (!number) return null;
        return <sup key={index} id={`fnref-${number}`} className={styles.footnoteRef}><a href={`#fn-${number}`}>[{number}]</a></sup>;
      }
      if (node.type === "strong") return <strong key={index}><Inline nodes={node.children} assets={assets} footnotes={footnotes} /></strong>;
      if (node.type === "em") return <em key={index}><Inline nodes={node.children} assets={assets} footnotes={footnotes} /></em>;
      if (node.type === "size") return <span key={index} style={sizeStyle(node.level)}><Inline nodes={node.children} assets={assets} footnotes={footnotes} /></span>;
      if (node.type === "color") return <span key={index} style={{ color: safeInlineColor(node.color) }}><Inline nodes={node.children} assets={assets} footnotes={footnotes} /></span>;
      if (node.type === "span") {
        const sourceClass = directiveClass(node.args);
        return <span key={index} className={sourceClass} style={safeWikiStyle(node.args)}><Inline nodes={node.children} assets={assets} footnotes={footnotes} /></span>;
      }
      if (node.type === "code") return <code key={index}>{node.text}</code>;

      const file = normalizeNamuFileRef(node.file);
      const url = findNamuAsset(assets, file);
      if (url) return <img key={index} src={url} alt={file} loading="lazy" style={imageStyle(node.width, node.height)} />;
      return <span key={index} title={`Unresolved image: ${file}`} style={{ display: "inline-block", padding: "4px 7px", border: "1px dashed #c7ccd4", color: "#667085", fontSize: 12 }}>[{file}]</span>;
    })}
  </>;
}

function cellStyle(cell: NamuRawCell, tableMeta?: NamuRawTableMeta): React.CSSProperties {
  return {
    background: cell.background,
    color: cell.color,
    textAlign: cell.align,
    width: cell.width,
    padding: cell.nopad ? 0 : undefined,
    verticalAlign: "middle",
    borderColor: tableMeta?.borderColor,
  };
}

function tableStyle(meta?: NamuRawTableMeta): React.CSSProperties {
  const style: React.CSSProperties = {
    width: meta?.width,
    background: meta?.background,
    color: meta?.color,
    borderColor: meta?.borderColor,
  };

  if (meta?.borderColor) style.border = `2px solid ${meta.borderColor}`;
  return style;
}

/**
 * Keep the wrapper from changing Namu's table geometry. A fixed/auto source
 * table should stay shrink-wrapped, while tablewidth=100% continues to fill the
 * document. Alignment is applied to the wrapper so overflow handling does not
 * create a full-width block around narrow infobox/navigation tables.
 */
function tableWrapStyle(meta?: NamuRawTableMeta): React.CSSProperties {
  const width = meta?.width || "fit-content";
  const style: React.CSSProperties = { width, maxWidth: "100%" };
  if (meta?.align === "center") {
    style.marginLeft = "auto";
    style.marginRight = "auto";
  } else if (meta?.align === "right") {
    style.marginLeft = "auto";
    style.marginRight = 0;
  } else {
    style.marginLeft = 0;
    style.marginRight = "auto";
  }
  return style;
}

function sourceTableClass(meta?: NamuRawTableMeta) {
  if (!meta?.className) return undefined;
  const tokens = meta.className
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => /^[a-z0-9_-]+$/i.test(token));
  return tokens.length ? tokens.join(" ") : undefined;
}

function NodeList({ nodes, assets, footnotes }: { nodes: NamuRawNode[]; assets: AssetMap; footnotes: FootnoteRegistry }) {
  return <>
    {nodes.map((node, index) => {
      if (node.type === "heading") {
        if (node.level <= 2) return <h2 key={index} className="sectionTitle">{node.text}</h2>;
        if (node.level === 3) return <h3 key={index} className="sectionTitle">{node.text}</h3>;
        return <h4 key={index} className="sectionTitle">{node.text}</h4>;
      }
      if (node.type === "tab") return <span key={index} style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", minHeight: 38, padding: "7px 14px", border: "1px solid #cfd5dd", borderBottom: "2px solid var(--accent, #fc6fcf)", background: "#fff", fontSize: 14, fontWeight: 700, lineHeight: 1.2 }}>{node.label}</span>;
      if (node.type === "paragraph") return <p key={index} className="wikiParagraph"><Inline nodes={node.children} assets={assets} footnotes={footnotes} /></p>;
      if (node.type === "table") {
        const rawClass = sourceTableClass(node.meta);
        const className = [`wikiTable`, styles.table, rawClass].filter(Boolean).join(" ");
        return <div key={index} className={styles.tableWrap} style={tableWrapStyle(node.meta)}>
          <table className={className} data-namu-table-class={rawClass} style={tableStyle(node.meta)}><tbody>
            {node.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex} rowSpan={cell.rowspan} colSpan={cell.colspan} style={cellStyle(cell, node.meta)}><Inline nodes={cell.children} assets={assets} footnotes={footnotes} /></td>)}</tr>)}
          </tbody></table>
        </div>;
      }
      if (node.type === "list") {
        const ListTag = node.ordered ? "ol" : "ul";
        return <ListTag key={index} className={styles.list}>{node.items.map((item, itemIndex) => <li key={itemIndex} style={{ marginLeft: `${item.depth * 18}px` }}><Inline nodes={item.children} assets={assets} footnotes={footnotes} /></li>)}</ListTag>;
      }
      if (node.type === "quote") return <blockquote key={index} className={styles.quote}><NodeList nodes={node.children} assets={assets} footnotes={footnotes} /></blockquote>;
      if (node.type === "directive") {
        if (node.kind === "html" || !node.children.length) return null;
        if (node.kind === "folding") {
          return <details key={index} className={styles.folding}>
            <summary>{node.title || "Details"}</summary>
            <div className={styles.foldingBody}><NodeList nodes={node.children} assets={assets} footnotes={footnotes} /></div>
          </details>;
        }
        const sourceClass = directiveClass(node.args);
        const classNames = [styles.directive, node.kind === "wiki" ? styles.wikiBlock : styles.ifBlock, sourceClass].filter(Boolean).join(" ");
        return <div key={index} className={classNames} style={safeWikiStyle(node.args)} data-namu-directive={node.kind} data-namu-condition={node.kind === "if" ? node.args : undefined}>
          <NodeList nodes={node.children} assets={assets} footnotes={footnotes} />
        </div>;
      }
      return null;
    })}
  </>;
}

export default function NamuRawRenderer({ nodes, assets = {} }: { nodes: NamuRawNode[]; assets?: AssetMap }) {
  const footnotes = collectFootnotes(nodes);
  return <div className={`namuRawRenderer ${styles.root}`}>
    <NodeList nodes={nodes} assets={assets} footnotes={footnotes} />
    {footnotes.entries.length > 0 && <div className={styles.footnotes} aria-label="Footnotes">
      {footnotes.entries.map((entry) => <div key={entry.number} id={`fn-${entry.number}`} className={styles.footnoteRow}>
        <a className={styles.footnoteIndex} href={`#fnref-${entry.number}`}>[{entry.number}]</a>
        <div><Inline nodes={entry.children} assets={assets} footnotes={footnotes} /></div>
      </div>)}
    </div>}
  </div>;
}