"use client";

import VisualEditorV3FootnoteCore from "./VisualEditorV3FootnoteCore";
import VisualEditorV3FormattingBridge from "./VisualEditorV3FormattingBridge";
import VisualEditorV3AtomicTextBridge from "./VisualEditorV3AtomicTextBridge";
import VisualEditorV3SimpleInlineHydrator from "./VisualEditorV3SimpleInlineHydrator";
import VisualEditorV3LinkInspectorBridge from "./VisualEditorV3LinkInspectorBridge";
import VisualEditorV3MediaDeleteBridge from "./VisualEditorV3MediaDeleteBridge";
import VisualEditorV3TableStyleBridge from "./VisualEditorV3TableStyleBridge";
import VisualEditorV3SourceFallbackBridge from "./VisualEditorV3SourceFallbackBridge";
import VisualEditorV3InteractionGuard from "./VisualEditorV3InteractionGuard";
import VisualEditorV3PanelBaseStyle from "./VisualEditorV3PanelBaseStyle";

/**
 * V3 auxiliary editor host.
 * Every child contributes to the shared operation registry; FullPageVisualEditorV3
 * submits the whole editing session as one proposal.
 *
 * TableLayoutBridge is mounted by /w/[...title]/page.tsx and intentionally
 * omitted here so its provider and state exist exactly once.
 */
export default function VisualEditorV3FootnoteBridge({ title }: { title: string }) {
  return (
    <>
      <VisualEditorV3PanelBaseStyle />
      <VisualEditorV3InteractionGuard />
      <VisualEditorV3FootnoteCore title={title} />
      <VisualEditorV3FormattingBridge />
      <VisualEditorV3AtomicTextBridge title={title} />
      <VisualEditorV3SimpleInlineHydrator />
      <VisualEditorV3LinkInspectorBridge />
      <VisualEditorV3MediaDeleteBridge title={title} />
      <VisualEditorV3TableStyleBridge title={title} />
      <VisualEditorV3SourceFallbackBridge title={title} />
    </>
  );
}
