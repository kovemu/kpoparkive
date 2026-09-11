"use client";

import VisualEditorV3FootnoteCore from "./VisualEditorV3FootnoteCore";
import VisualEditorV3FormattingBridge from "./VisualEditorV3FormattingBridge";
import VisualEditorV3LinkInspectorBridge from "./VisualEditorV3LinkInspectorBridge";
import VisualEditorV3MediaDeleteBridge from "./VisualEditorV3MediaDeleteBridge";
import VisualEditorV3TableStyleBridge from "./VisualEditorV3TableStyleBridge";
import VisualEditorV3SourceFallbackBridge from "./VisualEditorV3SourceFallbackBridge";
import VisualEditorV3InteractionGuard from "./VisualEditorV3InteractionGuard";
import VisualEditorV3PanelBaseStyle from "./VisualEditorV3PanelBaseStyle";

/**
 * Auxiliary tools for the unified V3 document canvas.
 *
 * AtomicTextBridge and SimpleInlineHydrator are intentionally omitted:
 * the unified canvas itself is the single editing host, so no auxiliary
 * component may create another contenteditable surface inside it.
 */
export default function VisualEditorV3CanvasExtras({ title }: { title: string }) {
  return (
    <>
      <VisualEditorV3PanelBaseStyle />
      <VisualEditorV3InteractionGuard />
      <VisualEditorV3FootnoteCore title={title} />
      <VisualEditorV3FormattingBridge />
      <VisualEditorV3LinkInspectorBridge />
      <VisualEditorV3MediaDeleteBridge title={title} />
      <VisualEditorV3TableStyleBridge title={title} />
      <VisualEditorV3SourceFallbackBridge title={title} />
    </>
  );
}
