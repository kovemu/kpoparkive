import React from "react";
import { HTMLElement, parse, type Node } from "node-html-parser";
import { parseNamuRaw } from "../../lib/namuRawParser";
import NamuRawRenderer from "./NamuRawRenderer";

type AssetMap = Record<string, string>;

const SAFE_STYLE_PROPERTIES: Record<string, keyof React.CSSProperties> = {
  display: "display",
  color: "color",
  background: "background",
  "background-color": "backgroundColor",
  width: "width",
  "min-width": "minWidth",
  "max-width": "maxWidth",
  height: "height",
  "min-height": "minHeight",
  "max-height": "maxHeight",
  margin: "margin",
  "margin-left": "marginLeft",
  "margin-right": "marginRight",
  "margin-top": "marginTop",
  "margin-bottom": "marginBottom",
  padding: "padding",
  "padding-left": "paddingLeft",
  "padding-right": "paddingRight",
  "padding-top": "paddingTop",
  "padding-bottom": "paddingBottom",
  border: "border",
  "border-left": "borderLeft",
  "border-right": "borderRight",
  "border-top": "borderTop",
  "border-bottom": "borderBottom",
  "border-color": "borderColor",
  "border-width": "borderWidth",
  "border-style": "borderStyle",
  "border-radius": "borderRadius",
  "box-sizing": "boxSizing",
  "text-align": "textAlign",
  "vertical-align": "verticalAlign",
  "white-space": "whiteSpace",
  "word-break": "wordBreak",
  overflow: "overflow",
  "overflow-x": "overflowX",
  "overflow-y": "overflowY",
  "font-size": "fontSize",
  "font-weight": "fontWeight",
  "font-family": "fontFamily",
  font: "font",
  "line-height": "lineHeight",
  flex: "flex",
  "flex-grow": "flexGrow",
  "flex-shrink": "flexShrink",
  "flex-basis": "flexBasis",
  "flex-direction": "flexDirection",
  "flex-wrap": "flexWrap",
  "justify-content": "justifyContent",
  "align-items": "alignItems",
  "align-content": "alignContent",
  gap: "gap",
  "row-gap": "rowGap",
  "column-gap": "columnGap",
  "grid-template-columns": "gridTemplateColumns",
  "grid-template-rows": "gridTemplateRows",
};

function safeStyle(source: string | undefined): React.CSSProperties | undefined {
  if (!source) return undefined;
  const output: Record<string, string> = {};
  for (const declaration of source.split(";")) {
    const separator = declaration.indexOf(":");
    if (separator < 0) continue;
    const property = declaration.slice(0, separator).trim().toLowerCase();
    const reactProperty = SAFE_STYLE_PROPERTIES[property];
    if (!reactProperty) continue;
    const value = declaration.slice(separator + 1).trim();
    if (!value || /url\s*\(|expression\s*\(|javascript:|behavior\s*:|[<>]/i.test(value)) continue;
    output[String(reactProperty)] = value;
  }
  return Object.keys(output).length ? output as React.CSSProperties : undefined;
}

function safeClassName(value: string | undefined) {
  if (!value) return undefined;
  const tokens = value.split(/\s+/).map((token) => token.trim()).filter((token) => /^[a-z0-9_-]+$/i.test(token));
  return tokens.length ? tokens.join(" ") : undefined;
}

function quotedArg(args: string, name: string) {
  const double = args.match(new RegExp(`\\b${name}\\s*=\\s*\"([^\"]*)\"`, "i"))?.[1];
  if (double !== undefined) return double;
  return args.match(new RegExp(`\\b${name}\\s*=\\s*'([^']*)'`, "i"))?.[1];
}

function directiveClass(args: string) {
  return safeClassName(quotedArg(args, "class"));
}

function directiveStyle(args: string) {
  return safeStyle(quotedArg(args, "style"));
}

function directiveTag(args: string) {
  return quotedArg(args, "tag")?.toLowerCase();
}

function directiveTabKey(args: string) {
  const className = directiveClass(args);
  if (!className) return null;
  const tokens = className.split(/\s+/);
  return tokens.find((token) => /^tab-[a-z](?:-\d+)?$/i.test(token)) || null;
}

function defaultTabSelected(key: string) {
  if (/^tab-[a-z]$/i.test(key)) return key.toLowerCase() === "tab-a";
  return /-1$/i.test(key);
}

function rawText(value: string) {
  return value.replace(/\\n/g, "\n").replace(/\r\n?/g, "\n").trim();
}

function tabLabel(body: string) {
  const normalized = body.trim();
  const bracket = normalized.match(/^\[\s*([\s\S]*?)\s*\]$/);
  return (bracket?.[1] || normalized).replace(/'''|''/g, "").trim();
}

function renderRawCode(source: string, assets: AssetMap, key: string): React.ReactNode {
  const normalized = rawText(source);
  const bare = normalized.match(/^#!([a-z]+)\b([^\n]*)(?:\n([\s\S]*))?$/i);
  if (!bare) {
    const nodes = parseNamuRaw(normalized);
    return nodes.length ? <NamuRawRenderer key={key} nodes={nodes} assets={assets} /> : null;
  }

  const kind = bare[1].toLowerCase();
  const args = bare[2].trim();
  const body = bare[3] || "";
  if (kind === "html") return null;

  const sourceClass = directiveClass(args);
  const sourceStyle = directiveStyle(args);
  const tag = directiveTag(args);
  const tabKey = directiveTabKey(args);

  if (tag === "a" && tabKey) {
    const active = defaultTabSelected(tabKey);
    const isSubtab = /-\d+$/i.test(tabKey);
    return <div
      key={key}
      className={sourceClass}
      data-namu-tab-control={tabKey}
      data-namu-tab-active={active ? "true" : "false"}
      style={{
        flex: isSubtab ? "1 1 38%" : "1 1 20%",
        minWidth: isSubtab ? 120 : 110,
        margin: "4px 8px",
        padding: isSubtab ? "5px 14px" : "6px 14px",
        borderRadius: 8,
        background: active ? "#fff" : "rgba(255,255,255,.18)",
        color: active ? "var(--accent, #fc6fcf)" : "inherit",
        textAlign: "center",
        fontWeight: 700,
        lineHeight: 1.25,
        ...sourceStyle,
      }}
    >{tabLabel(body)}</div>;
  }

  if (tabKey && !defaultTabSelected(tabKey)) return null;

  const nodes = body.trim() ? parseNamuRaw(body) : [];
  if (!nodes.length) return null;
  return <div key={key} className={sourceClass} style={sourceStyle} data-namu-directive={kind} data-namu-tab-content={tabKey || undefined}>
    <NamuRawRenderer nodes={nodes} assets={assets} />
  </div>;
}

function normalizeMediaUrl(value: string | undefined) {
  const url = String(value || "").trim();
  if (!url) return undefined;
  if (url.startsWith("//")) return `https:${url}`;
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith("/")) return `https://www.namu.moe${url}`;
  return undefined;
}

function internalHref(value: string | undefined) {
  const href = String(value || "").trim();
  if (!href) return undefined;
  if (href.startsWith("#")) return href;
  if (/^https?:\/\//i.test(href)) return href;
  const match = href.match(/^\/w\/(.+)$/);
  if (match) return `/admin/namu-hybrid-preview/${match[1]}`;
  return undefined;
}

function looksLikeNamuRaw(value: string) {
  const source = rawText(value);
  return /^#![a-z]+\b/i.test(source) || /^\|\|/m.test(source) || /\[\[[^\]]+\]\]/.test(source) || /\{\{\{/.test(source);
}

function youtubeEmbed(value: string | undefined) {
  const src = normalizeMediaUrl(value);
  if (!src) return undefined;
  try {
    const url = new URL(src);
    const host = url.hostname.toLowerCase();
    if (host === "www.youtube.com" || host === "youtube.com" || host === "www.youtube-nocookie.com" || host === "youtube-nocookie.com") return src;
  } catch {
    return undefined;
  }
  return undefined;
}

function renderChildren(element: HTMLElement, assets: AssetMap, keyPrefix: string) {
  return element.childNodes.map((child, index) => renderNode(child, assets, `${keyPrefix}-${index}`));
}

function renderNode(node: Node, assets: AssetMap, key: string): React.ReactNode {
  if (!(node instanceof HTMLElement)) {
    const text = node.textContent;
    return text ? <React.Fragment key={key}>{text}</React.Fragment> : null;
  }

  const tag = node.tagName.toLowerCase();
  if (tag === "script" || tag === "style" || tag === "noscript" || tag === "meta" || tag === "link") return null;

  if (tag === "pre") {
    const code = node.childNodes.find((child) => child instanceof HTMLElement && child.tagName.toLowerCase() === "code") as HTMLElement | undefined;
    const raw = code?.textContent || "";
    if (code && looksLikeNamuRaw(raw)) return renderRawCode(raw, assets, key);
  }

  const common = {
    key,
    className: safeClassName(node.getAttribute("class")),
    style: safeStyle(node.getAttribute("style")),
    title: node.getAttribute("title") || undefined,
  };

  const children = renderChildren(node, assets, key);
  if (tag === "div") return <div {...common}>{children}</div>;
  if (tag === "span") return <span {...common}>{children}</span>;
  if (tag === "p") return <p {...common}>{children}</p>;
  if (tag === "section") return <section {...common}>{children}</section>;
  if (tag === "article") return <article {...common}>{children}</article>;
  if (tag === "header") return <header {...common}>{children}</header>;
  if (tag === "footer") return <footer {...common}>{children}</footer>;
  if (tag === "main") return <main {...common}>{children}</main>;
  if (tag === "table") return <table {...common}>{children}</table>;
  if (tag === "tbody") return <tbody {...common}>{children}</tbody>;
  if (tag === "thead") return <thead {...common}>{children}</thead>;
  if (tag === "tfoot") return <tfoot {...common}>{children}</tfoot>;
  if (tag === "tr") return <tr {...common}>{children}</tr>;
  if (tag === "td") return <td {...common} colSpan={Number(node.getAttribute("colspan")) || undefined} rowSpan={Number(node.getAttribute("rowspan")) || undefined}>{children}</td>;
  if (tag === "th") return <th {...common} colSpan={Number(node.getAttribute("colspan")) || undefined} rowSpan={Number(node.getAttribute("rowspan")) || undefined}>{children}</th>;
  if (tag === "ul") return <ul {...common}>{children}</ul>;
  if (tag === "ol") return <ol {...common}>{children}</ol>;
  if (tag === "li") return <li {...common}>{children}</li>;
  if (tag === "blockquote") return <blockquote {...common}>{children}</blockquote>;
  if (tag === "details") return <details {...common}>{children}</details>;
  if (tag === "summary") return <summary {...common}>{children}</summary>;
  if (tag === "strong" || tag === "b") return <strong {...common}>{children}</strong>;
  if (tag === "em" || tag === "i") return <em {...common}>{children}</em>;
  if (tag === "sup") return <sup {...common}>{children}</sup>;
  if (tag === "sub") return <sub {...common}>{children}</sub>;
  if (tag === "h1") return <h1 {...common}>{children}</h1>;
  if (tag === "h2") return <h2 {...common}>{children}</h2>;
  if (tag === "h3") return <h3 {...common}>{children}</h3>;
  if (tag === "h4") return <h4 {...common}>{children}</h4>;
  if (tag === "h5") return <h5 {...common}>{children}</h5>;
  if (tag === "h6") return <h6 {...common}>{children}</h6>;
  if (tag === "br") return <br key={key} />;
  if (tag === "hr") return <hr {...common} />;
  if (tag === "a") {
    const href = internalHref(node.getAttribute("href"));
    return href ? <a {...common} href={href}>{children}</a> : <span {...common}>{children}</span>;
  }
  if (tag === "img") {
    const src = normalizeMediaUrl(node.getAttribute("data-original") || node.getAttribute("data-src") || node.getAttribute("src"));
    if (!src) return null;
    return <img {...common} src={src} alt={node.getAttribute("alt") || ""} loading="lazy" style={{ maxWidth: "100%", height: "auto", ...common.style }} />;
  }
  if (tag === "iframe") {
    const src = youtubeEmbed(node.getAttribute("src"));
    if (!src) return null;
    return <iframe {...common} src={src} title={node.getAttribute("title") || "Embedded video"} width={node.getAttribute("width") || undefined} height={node.getAttribute("height") || undefined} allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowFullScreen />;
  }
  if (tag === "pre") return <pre {...common}>{children}</pre>;
  if (tag === "code") return <code {...common}>{children}</code>;

  return <React.Fragment key={key}>{children}</React.Fragment>;
}

export default function NamuMirrorDomRenderer({ html, assets = {} }: { html: string; assets?: AssetMap }) {
  const root = parse(html || "");
  const article = root.querySelector("article") || root;
  return <div className="namuMirrorDomRenderer">{article.childNodes.map((node, index) => renderNode(node, assets, `mirror-${index}`))}</div>;
}
