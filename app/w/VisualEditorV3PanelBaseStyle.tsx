"use client";

import { useEffect } from "react";

const STYLE_ID = "kpoparkive-ve3-panel-base-style";

export default function VisualEditorV3PanelBaseStyle() {
  useEffect(() => {
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
.kpoparkiveVe3FootnoteMarker{cursor:pointer!important;outline:1px dotted rgba(107,60,232,.5);outline-offset:2px;border-radius:3px}
.kpoparkiveVe3FootnotePanel,.kpoparkiveVe3MediaPanel,.kpoparkiveVe3StructurePanel{position:fixed;right:14px;top:112px;z-index:12150;max-height:calc(100vh - 128px);overflow:auto;border:1px solid #d8d0eb;border-radius:12px;background:rgba(255,255,255,.99);box-shadow:0 18px 55px rgba(39,28,70,.22);color:#342c40}
.kpoparkiveVe3FootnotePanel{width:min(450px,calc(100vw - 28px));z-index:12120}
.kpoparkiveVe3MediaPanel{width:min(470px,calc(100vw - 28px));z-index:12130}
.kpoparkiveVe3StructurePanel{width:min(520px,calc(100vw - 28px));z-index:12140}
@media(max-width:760px){.kpoparkiveVe3FootnotePanel,.kpoparkiveVe3MediaPanel,.kpoparkiveVe3StructurePanel{top:150px;max-height:calc(100vh - 164px)}}
`;
    document.head.appendChild(style);
    return () => style.remove();
  }, []);
  return null;
}
