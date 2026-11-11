/// <reference lib="dom" />
import { useCallback, useEffect, useRef, useState } from "react";
import { attachmentKind, refusal, type AttachmentKind } from "../../shared/attachments";

/** A file or image waiting in the composer. */
export interface Pending {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  kind: AttachmentKind;
  dataBase64: string;
  /** A data URL for the image thumbnail. */
  previewUri: string | null;
}

let counter = 0;

function toBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Could not read the file"));
    reader.onload = () => {
      const result = String(reader.result);
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.readAsDataURL(file);
  });
}

/** The files of a paste or drop event, in order. */
export function filesOf(transfer: DataTransfer | null): File[] {
  if (!transfer) return [];
  const files = Array.from(transfer.files ?? []);
  if (files.length > 0) return files;
  return Array.from(transfer.items ?? []).flatMap((item) => (item.kind === "file" ? [item.getAsFile()].filter((file): file is File => file !== null) : []));
}

/**
 * The composer's attachments: pasted or dropped on `container` (a DOM element, web only) or added by `add`; on mobile, where there is no such element, nothing can be attached.
 * Each is checked against the limits of shared/attachments.ts; a refused one is reported through `onError`.
 */
export function useAttachments(container: { current: unknown }, onError: (message: string) => void) {
  const [items, setItems] = useState<Pending[]>([]);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const errorRef = useRef(onError);
  errorRef.current = onError;

  const add = useCallback(async (files: File[]) => {
    for (const file of files) {
      const mimeType = file.type || "application/octet-stream";
      const problem = refusal(itemsRef.current, { name: file.name || "file", mimeType, size: file.size });
      if (problem) {
        errorRef.current(problem);
        continue;
      }
      try {
        const dataBase64 = await toBase64(file);
        const kind = attachmentKind(mimeType);
        const name = file.name || (kind === "image" ? `image.${mimeType.split("/")[1] ?? "png"}` : "file");
        const pending: Pending = { id: `att-${++counter}`, name, mimeType, size: file.size, kind, dataBase64, previewUri: kind === "image" ? `data:${mimeType};base64,${dataBase64}` : null };
        itemsRef.current = [...itemsRef.current, pending];
        setItems(itemsRef.current);
      } catch (error) {
        errorRef.current(error instanceof Error ? error.message : "Could not read the file");
      }
    }
  }, []);

  const remove = useCallback((id: string) => {
    itemsRef.current = itemsRef.current.filter((item) => item.id !== id);
    setItems(itemsRef.current);
  }, []);
  const clear = useCallback(() => {
    itemsRef.current = [];
    setItems([]);
  }, []);

  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    const node = container.current as HTMLElement | null;
    if (!node || typeof node.addEventListener !== "function") return;
    const onPaste = (event: Event) => {
      const files = filesOf((event as ClipboardEvent).clipboardData);
      if (files.length === 0) return;
      event.preventDefault();
      void add(files);
    };
    const hasFiles = (event: Event) => Array.from((event as DragEvent).dataTransfer?.types ?? []).includes("Files");
    const onDragOver = (event: Event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      setDragging(true);
    };
    const onDragLeave = () => setDragging(false);
    const onDrop = (event: Event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      setDragging(false);
      void add(filesOf((event as DragEvent).dataTransfer));
    };
    node.addEventListener("paste", onPaste);
    node.addEventListener("dragover", onDragOver);
    node.addEventListener("dragleave", onDragLeave);
    node.addEventListener("drop", onDrop);
    return () => {
      node.removeEventListener("paste", onPaste);
      node.removeEventListener("dragover", onDragOver);
      node.removeEventListener("dragleave", onDragLeave);
      node.removeEventListener("drop", onDrop);
    };
  }, [container, add]);

  return { items, add, remove, clear, dragging };
}
