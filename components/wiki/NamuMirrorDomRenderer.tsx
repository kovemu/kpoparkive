import React from "react";
import { HTMLElement, parse, type Node } from "node-html-parser";
import { parseNamuRaw } from "../../lib/namuRawParser";
import NamuRawRenderer from "./NamuRawRenderer";
import { NamuTabContent, NamuTabControl, NamuTabProvider } from "./NamuTabContext";
import styles from "./NamuMirrorDomRenderer.module.css";

type AssetMap = Record<string, string>;

type Theme = {
  background: string;
  foreground: string;
};

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
  position: "position",
  top: "top",
  right: "right",
  bottom: "bottom",
  left: "left",
};

function decodeEntities(value: string) {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&#x27;/gi, "'")
    .replace(/&#91;/gi, "[")
    .replace(/&#93;/gi, "]")
    .replace(/&#123;/gi, "{")
    .replace(/&#125;/gi, "}")
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));
}

function deriveTheme(html: string): Theme {
  const background = html.match(/배경색\s*=\s*(?:&#39;|'|&quot;|")?(#[0-9a-f]{3,8})/i)?.[1] || "#fc6fcf";
  const foreground = html.match(/글자색\s*=\s*(?:&#39;|'|&quot;|")?(#[0-9a-f]{3,8})/i)?.[1] || "#fff";
  return { background, foreground };
}

function safeStyle(source: string | undefined, theme: Theme, templateShell = false): React.CSSProperties | undefined {
  if (!source) return templateShell ? { backgroundColor: theme.background, color: theme.foreground } : undefined;
  const output: Record<string, string> = {};
  for (const declaration of decodeEntities(source).split(";")) {
    const separator = declaration.indexOf(":");
    if (separator < 0) continue;
    const property = declaration.slice(0, separator).trim().toLowerCase();
    const reactProperty = SAFE_STYLE_PROPERTIES[property];
    if (!reactProperty) continue;
    let value = declaration.slice(separator + 1).trim();
    if (!value || /url\s*\(|expression\s*\(|javascript:|behavior\s*:|[<>]/i.test(value)) continue;
    if (templateShell && property === "background" && /^(?:border-box|padding-box|content-box)$/i.test(value)) value = theme.background;
    output[String(reactProperty)] = value;
  }
  if (templateShell) {
    if (!output.background && !output.backgroundColor) output.backgroundColor = theme.background;
    if (!output.color) output.color = theme.foreground;
    if (String(output.border || "").includes("transparent")) output.borderColor = theme.background;
  }
  return Object.keys(output).length ? output as React.CSSProperties : undefined;
}

function isTemplateShellStyle(style: string | undefined) {
  const value = String(style || "").toLowerCase();
  return value.includes("max-width") && value.includes("border-radius") && value.includes("text-align") && value.includes("overflow");
}

function safeClassName(value: string | undefined) {
  if (!value) return undefined;
  const tokens = value.split(/\s+/).map((token) => token.trim()).filter((token) => /^[a-z0-9_-]+$/i.test(token));
  return tokens.length ? tokens.join(" ") : undefined;
}

function normalizeMediaUrl(value: string | undefined) {
  const url = decodeEntities(String(value || "")).trim();
  if (!url) return undefined;
  if (url.startsWith("//")) return `https:${url}`;
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith("/")) return `https://www.namu.moe${url}`;
  return undefined;
}

function normalizeFileRef(value: string) {
  return decodeEntities(value).normalize("NFKC").trim().replace(/^(?:파일|File):/i, "");
}

function findAsset(assets: AssetMap, file: string) {
  const normalized = normalizeFileRef(file);
  if (assets[normalized]) return assets[normalized];
  for (const [key, url] of Object.entries(assets)) {
    if (normalizeFileRef(key) === normalized) return url;
  }
  return undefined;
}

function safeDecode(value: string) {
  try { return decodeURIComponent(value); } catch { return value; }
}

function internalHref(value: string | undefined) {
  const href = decodeEntities(String(value || "")).trim();
  if (!href || /^javascript:/i.test(href)) return undefined;
  if (href.startsWith("#")) return href;
  const convertWikiPath = (path: string) => {
    const [pathname, hash = ""] = path.split("#", 2);
    const encoded = pathname.replace(/^\/w\//, "");
    const title = safeDecode(encoded);
    const base = `/admin/namu-raw-preview/${encodeURIComponent(title)}`;
    return hash ? `${base}#${hash}` : base;
  };
  if (href.startsWith("/w/")) return convertWikiPath(href);
  const absoluteNamu = href.match(/^https?:\/\/(?:www\.)?namu\.wiki(\/w\/[^?#]+(?:#[^?]*)?)/i);
  if (absoluteNamu) return convertWikiPath(absoluteNamu[1]);
  const protocolNamu = href.match(/^\/\/(?:www\.)?namu\.wiki(\/w\/[^?#]+(?:#[^?]*)?)/i);
  if (protocolNamu) return convertWikiPath(protocolNamu[1]);
  if (href.startsWith("//")) return `https:${href}`;
  if (/^https?:\/\//i.test(href)) return href;
  if (href.startsWith("/")) return `https://www.namu.moe${href}`;
  return href;
}

function looksLikeNamuRaw(value: string) {
  const source = decodeEntities(value).trimStart();
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

function quotedArg(args: string, name: string) {
  const double = args.match(new RegExp(`\\b${name}\\s*=\\s*\"([^\"]*)\"`, "i"))?.[1];
  if (double !== undefined) return double;
  return args.match(new RegExp(`\\b${name}\\s*=\\s*'([^']*)'`, "i"))?.[1];
}

function directiveClass(args: string) {
  return safeClassName(quotedArg(args, "class")) || "";
}

function directiveStyle(args: string, theme: Theme) {
  return safeStyle(quotedArg(args, "style"), theme);
}

function cleanRawSource(source: string) {
  return decodeEntities(source)
    .replace(/\\n/g, "\n")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .filter((line) => !/^\s*##/.test(line))
    .join("\n")
    .trim();
}

function renderRawCode(source: string, assets: AssetMap, theme: Theme, key: string): React.ReactNode {
  const normalized = cleanRawSource(source);
  if (!normalized) return null;
  const bare = normalized.match(/^#!([a-z]+)\b([^\n]*)(?:\n([\s\S]*))?$/i);
  if (!bare) {
    const nodes = parseNamuRaw(normalized);
    return nodes.length ? <div key={key} className={styles.rawEmbed}><NamuRawRenderer nodes={nodes} assets={assets} /></div> : null;
  }

  const kind = bare[1].toLowerCase();
  const args = bare[2].trim();
  const body = bare[3] || "";
  if (kind === "html" || kind === "if" || kind === "style") return null;

  const sourceClass = directiveClass(args);
  const sourceStyle = directiveStyle(args, theme);
  const tag = quotedArg(args, "tag")?.toLowerCase();
  const tabKey = sourceClass.split(/\s+/).find((token) => /^tab-[a-z](?:-\d+)?$/i.test(token)) || null;

  if (tag === "a" && tabKey) {
    const label = (body.match(/^\[\s*([\s\S]*?)\s*\]$/)?.[1] || body).replace(/'''|''/g, "").trim();
    return <NamuTabControl
      key={key}
      tabKey={tabKey}
      label={label}
      className={[styles.tabButton, sourceClass].filter(Boolean).join(" ")}
      style={sourceStyle}
    />;
  }

  const nodes = body.trim() ? parseNamuRaw(body) : [];
  if (!nodes.length) return null;
  const isPanel = Boolean(tabKey) || /(?:^|\s)subtab(?:\s|$)/.test(sourceClass);
  const className = [styles.rawEmbed, isPanel ? styles.rawPanel : "", sourceClass].filter(Boolean).join(" ");

  if (tabKey) {
    return <NamuTabContent key={key} tabKey={tabKey} className={className} style={sourceStyle}>
      <NamuRawRenderer nodes={nodes} assets={assets} />
    </NamuTabContent>;
  }

  return <div key={key} className={className} style={sourceStyle} data-namu-directive={kind}>
    <NamuRawRenderer nodes={nodes} assets={assets} />
  </div>;
}

function renderChildren(element: HTMLElement, assets: AssetMap, theme: Theme, keyPrefix: string) {
  return element.childNodes.map((child, index) => renderNode(child, assets, theme, `${keyPrefix}-${index}`));
}

function renderNode(node: Node, assets: AssetMap, theme: Theme, key: string): React.ReactNode {
  if (!(node instanceof HTMLElement)) {
    const text = decodeEntities(node.textContent || "");
    return text ? <React.Fragment key={key}>{text}</React.Fragment> : null;
  }
  const tag = node.tagName.toLowerCase();
  if (tag === "script" || tag === "style" || tag === "noscript" || tag === "meta" || tag === "link") return null;
  if (tag === "pre") {
    const code = node.childNodes.find((child) => child instanceof HTMLElement && child.tagName.toLowerCase() === "code") as HTMLElement | undefined;
    const raw = code?.textContent || "";
    if (code && looksLikeNamuRaw(raw)) return renderRawCode(raw, assets, theme, key);
  }

  const styleSource = node.getAttribute("style");
  const common = {
    key,
    className: safeClassName(node.getAttribute("class")),
    style: safeStyle(styleSource, theme, isTemplateShellStyle(styleSource)),
    title: node.getAttribute("title") || undefined,
    id: /^[a-z0-9_:.-]+$/i.test(node.getAttribute("id") || "") ? node.getAttribute("id") : undefined,
  };
  const children = renderChildren(node, assets, theme, key);
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
  if (tag === "u") return <u {...common}>{children}</u>;
  if (tag === "s" || tag === "del") return <del {...common}>{children}</del>;
  if (tag === "small") return <small {...common}>{children}</small>;
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
    const alt = decodeEntities(node.getAttribute("alt") || "");
    const file = alt.match(/^(?:파일|File):(.+)$/i)?.[1];
    const resolved = file ? findAsset(assets, file) : undefined;
    const fallback = normalizeMediaUrl(node.getAttribute("data-original") || node.getAttribute("data-src") || node.getAttribute("src"));
    const src = resolved || fallback;
    if (!src) return file ? <span key={key} className={styles.unresolvedImage}>[{normalizeFileRef(file)}]</span> : null;
    return <img {...common} src={src} alt={file ? normalizeFileRef(file) : alt} loading="lazy" style={{ maxWidth: "100%", height: "auto", ...common.style }} />;
  }
  if (tag === "iframe") {
    const src = youtubeEmbed(node.getAttribute("src"));
    if (!src) return null;
    return <iframe {...common} src={src} title={node.getAttribute("title") || "Embedded video"} width={node.getAttribute("width") || undefined} height={node.getAttribute("height") || undefined} allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowFullScreen />;
  }
  if (tag === "figure") return <figure {...common}>{children}</figure>;
  if (tag === "figcaption") return <figcaption {...common}>{children}</figcaption>;
  if (tag === "pre") return <pre {...common}>{children}</pre>;
  if (tag === "code") return <code {...common}>{children}</code>;
  return <React.Fragment key={key}>{children}</React.Fragment>;
}

export default function NamuMirrorDomRenderer({ html, assets = {} }: { html: string; assets?: AssetMap }) {
  const theme = deriveTheme(html);
  const root = parse(html || "");
  const article = root.querySelector("article") || root;
  const themeStyle = { "--namu-theme-bg": theme.background, "--namu-theme-fg": theme.foreground } as React.CSSProperties;
  return <NamuTabProvider><div className={styles.root} style={themeStyle} data-namu-renderer="mirror-dom-v2-tabs">
    {article.childNodes.map((node, index) => renderNode(node, assets, theme, `mirror-${index}`))}
  </div></NamuTabProvider>;
}
