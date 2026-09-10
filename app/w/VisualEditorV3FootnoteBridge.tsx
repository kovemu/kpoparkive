"use client";

import VisualEditorV3FootnoteCore from "./VisualEditorV3FootnoteCore";
import VisualEditorV3FormattingBridge from "./VisualEditorV3FormattingBridge";
import VisualEditorV3AtomicTextBridge from "./VisualEditorV3AtomicTextBridge";
import VisualEditorV3LinkInspectorBridge from "./VisualEditorV3LinkInspectorBridge";
import VisualEditorV3TableLayoutBridge from "./VisualEditorV3TableLayoutBridge";
import VisualEditorV3TableStyleBridge from "./VisualEditorV3TableStyleBridge";
import VisualEditorV3SourceFallbackBridge from "./VisualEditorV3SourceFallbackBridge";

/**
 * V3 auxiliary editor host.
 *
 * The page mounts this component once. Each child registers its exact AST
 * operations with the shared V3 registry, so FullPageVisualEditorV3 submits
 * one atomic proposal for the entire editing session.
 */
export default function VisualEditorV3FootnoteBridge({ title }: { title: string }) {
  return (
    <>
      <VisualEditorV3FootnoteCore title={title} />
      <VisualEditorV3FormattingBridge />
      <VisualEditorV3AtomicTextBridge title={title} />
      <VisualEditorV3LinkInspectorBridge />
      <VisualEditorV3TableLayoutBridge title={title} />
      <VisualEditorV3TableStyleBridge title={title} />
      <VisualEditorV3SourceFallbackBridge title={title} />
    </>
  );
}
