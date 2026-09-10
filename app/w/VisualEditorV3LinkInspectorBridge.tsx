"use client";

import { useEffect, useState } from "react";

const EDITING_CLASS = "kpoparkiveAstEditing";
const STYLE_ID = "kpoparkive-ve3-link-inspector-style";

function editableSurface(anchor: HTMLAnchorElement) {
  const surface = anchor.closest<HTMLElement>(".kpoparkiveAstSurface,.kpoparkiveAstHeadingSurface,.kpoparkiveAstTableSurface,.kpoparkiveVe3AtomicSurface");
  return surface?.isContentEditable ? surface : null;
}

function unwrap(anchor: HTMLAnchorElement) {
  const parent = anchor.parentNode;
  if (!parent) return;
  while (anchor.firstChild) parent.insertBefore(anchor.firstChild, anchor);
  anchor.remove();
}

function currentTarget(anchor: HTMLAnchorElement) {
  return anchor.dataset.wikiTarget || anchor.getAttribute("href") || "";
}

export default function VisualEditorV3LinkInspectorBridge() {
  const [editing, setEditing] = useState(false);
  const [anchor, setAnchor] = useState<HTMLAnchorElement | null>(null);
  const [target, setTarget] = useState("");
  const [label, setLabel] = useState("");

  useEffect(() => {
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
.kpoparkiveVe3LinkPanel{position:fixed;z-index:12200;top:112px;right:14px;width:min(390px,calc(100vw - 28px));border:1px solid #d8d0eb;border-radius:12px;background:rgba(255,255,255,.99);box-shadow:0 18px 55px rgba(39,28,70,.22);color:#342c40}.kpoparkiveVe3LinkHeader,.kpoparkiveVe3LinkBody{padding:12px 14px}.kpoparkiveVe3LinkHeader{display:flex;align-items:center;justify-content:space-between;gap:10px;border-bottom:1px solid #e6e0ef;background:#fbf9ff}.kpoparkiveVe3LinkHeader strong{color:#5832c6}.kpoparkiveVe3LinkHeader button,.kpoparkiveVe3LinkBody button,.kpoparkiveVe3LinkBody input{border:1px solid #dcd5e8;border-radius:8px;background:#fff;color:#352e40;font:inherit}.kpoparkiveVe3LinkHeader button{width:32px;height:32px;font-size:20px;cursor:pointer}.kpoparkiveVe3LinkBody{display:grid;gap:10px}.kpoparkiveVe3LinkBody label{display:grid;gap:5px;font-size:12px;font-weight:800}.kpoparkiveVe3LinkBody input{height:36px;padding:0 9px;min-width:0}.kpoparkiveVe3LinkMeta{font-size:11px;color:#82768e;line-height:1.45}.kpoparkiveVe3LinkActions{display:flex;justify-content:flex-end;gap:8px}.kpoparkiveVe3LinkActions button{height:36px;padding:0 11px;cursor:pointer;font-weight:800}.kpoparkiveVe3LinkActions .danger{color:#a22a3c}.kpoparkiveVe3LinkActions .primary{border-color:#6b3ce8;background:#6b3ce8;color:#fff}@media(max-width:760px){.kpoparkiveVe3LinkPanel{top:150px}}
`;
    document.head.appendChild(style);
    return () => style.remove();
  }, []);

  useEffect(() => {
    const sync = () => {
      const active = document.body.classList.contains(EDITING_CLASS);
      setEditing(active);
      if (!active) setAnchor(null);
    };
    const observer = new MutationObserver(sync);
    observer.observe(document.body, { attributes: true, attributeFilter: ["class"] });
    sync();
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!editing) return;
    const pointer = (event: PointerEvent) => {
      const targetElement = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a") : null;
      if (!targetElement || !editableSurface(targetElement)) return;
      event.preventDefault();
      const nextTarget = currentTarget(targetElement);
      setAnchor(targetElement);
      setTarget(targetElement.dataset.wikiTarget ? targetElement.dataset.wikiTarget : nextTarget);
      setLabel(targetElement.innerText || targetElement.textContent || "");
    };
    document.addEventListener("pointerdown", pointer, true);
    return () => document.removeEventListener("pointerdown", pointer, true);
  }, [editing]);

  const close = () => setAnchor(null);

  const apply = () => {
    if (!anchor || !anchor.isConnected) { close(); return; }
    const surface = editableSurface(anchor);
    if (!surface) { close(); return; }
    const value = target.trim();
    if (!value) { window.alert("Link target is required."); return; }

    if (/^https?:\/\//i.test(value)) {
      anchor.removeAttribute("data-wiki-target");
      anchor.dataset.wikiExternal = "1";
      anchor.setAttribute("href", value);
    } else {
      anchor.removeAttribute("data-wiki-external");
      anchor.dataset.wikiTarget = value;
      anchor.setAttribute("href", `/w/${encodeURIComponent(value)}`);
    }
    const currentLabel = anchor.innerText || anchor.textContent || "";
    if (label !== currentLabel) anchor.textContent = label;
    surface.dispatchEvent(new Event("input", { bubbles: true }));
    close();
  };

  const unlink = () => {
    if (!anchor || !anchor.isConnected) { close(); return; }
    const surface = editableSurface(anchor);
    if (!surface) { close(); return; }
    unwrap(anchor);
    surface.dispatchEvent(new Event("input", { bubbles: true }));
    close();
  };

  if (!editing || !anchor) return null;
  const external = /^https?:\/\//i.test(target) || Boolean(anchor.dataset.wikiExternal);
  return <aside className="kpoparkiveVe3LinkPanel" aria-label="Link inspector">
    <div className="kpoparkiveVe3LinkHeader"><strong>Link</strong><button type="button" onClick={close}>×</button></div>
    <div className="kpoparkiveVe3LinkBody">
      <label>Target<input value={target} onChange={(event) => setTarget(event.target.value)} placeholder="Wiki page title or https://…" spellCheck={false} /></label>
      <label>Label<input value={label} onChange={(event) => setLabel(event.target.value)} /></label>
      <div className="kpoparkiveVe3LinkMeta">{external ? "External link" : "Internal Kpoparkive wiki link"}. Changing the target does not search the source text; it is serialized through the active AST-backed visual block.</div>
      <div className="kpoparkiveVe3LinkActions"><button type="button" className="danger" onClick={unlink}>Unlink</button><button type="button" className="primary" onClick={apply}>Apply</button></div>
    </div>
  </aside>;
}
