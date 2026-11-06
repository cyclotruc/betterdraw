// Importing an .excalidraw file (from excalidraw.com, or an export) opens it as a new canvas: nothing
// already on the current canvas is ever replaced.
import { loadFromBlob } from "@betterdraw/editor";
import type { BinaryFiles } from "@betterdraw/editor/types";
import type { ExcalidrawElement } from "@betterdraw/element/types";
import { api } from "./api";
import { t } from "./texts";
import { toast } from "./toast";

type Scene = { elements: readonly ExcalidrawElement[]; files: BinaryFiles };
const waiting = new Map<string, Scene>();

export const isSceneFile = (f: File) => /\.(excalidraw|json)$/i.test(f.name) || f.type === "application/vnd.excalidraw+json";
export const takeImport = (canvasId: string) => {
  const s = waiting.get(canvasId);
  waiting.delete(canvasId);
  return s;
};

// Returns the new canvas id, or null when the file is not a drawing.
export async function importFile(file: File): Promise<string | null> {
  let scene: any;
  try {
    scene = await loadFromBlob(file, null, null);
  } catch {
    scene = null;
  }
  if (!scene?.elements) {
    toast(t("importFailed"));
    return null;
  }
  const title = file.name.replace(/\.(excalidraw|json|png|svg)$/i, "").slice(0, 200);
  const { id } = await api<{ id: string }>("/api/canvases", { method: "POST", body: JSON.stringify({ title }) });
  waiting.set(id, { elements: scene.elements, files: scene.files ?? {} });
  toast(t("imported"));
  return id;
}
