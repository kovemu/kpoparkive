"use client";

import { useEffect, useMemo, useState } from "react";
import { registerV3OperationProvider, type V3RegisteredOperation } from "./visualEditorV3OperationRegistry";

type MediaItem = {
  ownerType: "document" | "table";
  ownerNodeId: string;
  nodeId: string | null;
  callId: string | null;
  sectionIndex: number;
  sourceStart: number;
  sourceEnd: number;
  kind: "file" | "youtube" | "video-macro";
  macroName: string;
  target: string;
};

type Payload = { ok?: boolean; media?: MediaItem[]; error?: string };

const EDITING = "kpoparkiveAstEditing";
const BUTTON_ID = "kpoparkive-ve3-media-delete-button";
const STYLE_ID = "kpoparkive-ve3-media-delete-style";

function mediaKey(item: MediaItem) {
  return `${item.ownerType}:${item.ownerNodeId}:${item.nodeId || item.callId || item.sourceStart}`;
}

function atomicMediaChip(item: MediaItem) {
  if (item.ownerType !== "document" || !item.nodeId || item.nodeId === item.ownerNodeId) return null;
  return document.querySelector<HTMLElement>(`[data-ve3-atomic-node-id="${CSS.escape(item.nodeId)}"]`);
}

function operationFor(item: MediaItem): V3RegisteredOperation | null {
  if (item.ownerType === "table") {
    if (!item.callId) return null;
    return { op: "table-media", nodeId: item.ownerNodeId, mediaCalls: [{ callId: item.callId, delete: true }] };
  }
  if (!item.nodeId) return null;
  if (item.nodeId === item.ownerNodeId) return { op: "delete-node", nodeId: item.nodeId };
  return { op: "delete-inline-node", nodeId: item.nodeId };
}

export default function VisualEditorV3MediaDeleteBridge({ title }: { title: string }) {
  const [editing, setEditing] = useState(false);
  const [items, setItems] = useState<MediaItem[]>([]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [deleted, setDeleted] = useState<string[]>([]);
  const selected = useMemo(() => items.find((item) => mediaKey(item) === selectedKey) || null, [items, selectedKey]);

  useEffect(() => {
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `.kpoparkiveVe3PendingMediaDelete{opacity:.28!important;outline:2px solid rgba(180,45,65,.78)!important;filter:grayscale(.45)}#${BUTTON_ID}{color:#a22a3c!important}`;
    document.head.appendChild(style);
    return () => style.remove();
  }, []);

  useEffect(() => {
    const sync = () => setEditing(document.body.classList.contains(EDITING));
    const observer = new MutationObserver(sync);
    observer.observe(document.body, { attributes: true, attributeFilter: ["class"] });
    sync();
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!editing) { setItems([]); setSelectedKey(null); setDeleted([]); return; }
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`/api/wiki-edit-document-v3?title=${encodeURIComponent(title)}`, { cache: "no-store", signal: controller.signal });
        const payload = await response.json() as Payload;
        if (!response.ok || !payload.ok) throw new Error(payload.error || "Could not load media AST");
        const media = payload.media || [];
        setItems(media);
        setSelectedKey(media[0] ? mediaKey(media[0]) : null);
      } catch (error) {
        if (!controller.signal.aborted) console.warn("[VisualEditorV3MediaDeleteBridge]", error);
      }
    })();
    return () => controller.abort();
  }, [editing, title]);

  useEffect(() => {
    if (!editing) return;
    const choose = (event: Event) => {
      const target = event.target instanceof Element ? event.target : null;
      const media = target?.closest<HTMLElement>("[data-ve3-media-key]");
      if (media?.dataset.ve3MediaKey) setSelectedKey(media.dataset.ve3MediaKey);

      const select = target?.closest<HTMLSelectElement>(".kpoparkiveVe3MediaPicker select");
      if (select?.value) setSelectedKey(select.value);
    };
    document.addEventListener("pointerdown", choose, true);
    document.addEventListener("change", choose, true);
    return () => {
      document.removeEventListener("pointerdown", choose, true);
      document.removeEventListener("change", choose, true);
    };
  }, [editing]);

  useEffect(() => {
    const applyPending = () => {
      for (const element of Array.from(document.querySelectorAll<HTMLElement>(".kpoparkiveVe3PendingMediaDelete"))) {
        element.classList.remove("kpoparkiveVe3PendingMediaDelete");
      }
      if (!editing) return;

      for (const item of items) {
      const key = mediaKey(item);
      const chip = atomicMediaChip(item);
      const deleting = deleted.includes(key);

      if (chip) {
        if (deleting) {
          if (chip.dataset.ve3AtomicDeleted !== "1") {
            chip.dataset.ve3AtomicDeleteBackup = chip.dataset.ve3AtomicRaw || chip.dataset.ve3AtomicOriginalRaw || "";
          }
          chip.dataset.ve3AtomicDeleted = "1";
          chip.dataset.ve3AtomicRaw = "";
          const surface = chip.closest<HTMLElement>(".kpoparkiveVe3AtomicSurface");
          if (surface) surface.dataset.ve3Dirty = "1";
          chip.classList.add("kpoparkiveVe3PendingMediaDelete");
        } else if (chip.dataset.ve3AtomicDeleted === "1") {
          chip.dataset.ve3AtomicRaw = chip.dataset.ve3AtomicDeleteBackup || chip.dataset.ve3AtomicOriginalRaw || "";
          delete chip.dataset.ve3AtomicDeleted;
          delete chip.dataset.ve3AtomicDeleteBackup;
          chip.classList.remove("kpoparkiveVe3PendingMediaDelete");
        }
      }

      if (deleting) {
        const element = Array.from(document.querySelectorAll<HTMLElement>("[data-ve3-media-key]"))
          .find((entry) => entry.dataset.ve3MediaKey === key);
        element?.classList.add("kpoparkiveVe3PendingMediaDelete");
      }
    }

      window.dispatchEvent(new Event("kpoparkive-ve3-atomic-media-sync"));
    };

    applyPending();
    window.addEventListener("kpoparkive-ve3-atomic-surfaces-ready", applyPending);
    return () => window.removeEventListener("kpoparkive-ve3-atomic-surfaces-ready", applyPending);
  }, [editing, items, deleted]);

  useEffect(() => {
    if (!editing) return;
    return registerV3OperationProvider("media-delete", () => deleted.flatMap((key) => {
      const item = items.find((entry) => mediaKey(entry) === key);
      if (!item) return [];
      if (atomicMediaChip(item)) return [];
      const operation = operationFor(item);
      return operation ? [operation] : [];
    }));
  }, [editing, deleted, items]);

  useEffect(() => {
    const remove = () => document.getElementById(BUTTON_ID)?.remove();
    if (!editing) { remove(); return; }
    const ensure = () => {
      const toolbar = document.querySelector<HTMLElement>(".kpoparkiveAstToolbar");
      if (!toolbar) return;
      let button = document.getElementById(BUTTON_ID) as HTMLButtonElement | null;
      if (!button) {
        button = document.createElement("button");
        button.id = BUTTON_ID;
        button.type = "button";
        button.title = "Remove the selected image or video from this page";
        button.addEventListener("mousedown", (event) => event.preventDefault());
        button.addEventListener("click", () => {
          setDeleted((current) => {
            const key = selectedKey;
            if (!key) { window.alert("Click an image or video first."); return current; }
            return current.includes(key) ? current.filter((entry) => entry !== key) : [...current, key];
          });
        });
        const mediaButton = document.getElementById("kpoparkive-ve3-media-button");
        (mediaButton || toolbar.querySelector("strong"))?.insertAdjacentElement("afterend", button);
      }
      button.textContent = selected && deleted.includes(mediaKey(selected)) ? "Undo media delete" : `Remove media${deleted.length ? ` (${deleted.length})` : ""}`;
      button.disabled = !items.length;
    };
    ensure();
    const observer = new MutationObserver(ensure);
    observer.observe(document.body, { subtree: true, childList: true });
    return () => { observer.disconnect(); remove(); };
  }, [editing, items.length, selected, selectedKey, deleted]);

  return null;
}
