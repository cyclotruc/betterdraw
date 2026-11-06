// The page the server's headless browser opens (/__render) to draw pictures of a canvas for agents, with
// Excalidraw's own export: the same strokes, fonts and images people see. It shows nothing on screen.
import { exportScene } from "@betterdraw/editor";

type Input = {
  elements: any[];
  files: Record<string, any>;
  background: string;
  box?: { x: number; y: number; width: number; height: number };
  maxSide: number;
};

(window as any).__render = async ({ elements, files, background, box, maxSide }: Input) => {
  const fit = (w: number, h: number) => Math.min(2, maxSide / Math.max(w, h, 1));
  const canvas = await exportScene({
    type: "canvas",
    data: { elements, files },
    config: {
      theme: "light",
      canvasBackgroundColor: background,
      ...(box
        ? { x: box.x, y: box.y, width: box.width, height: box.height, fit: "none", padding: 0, scale: fit(box.width, box.height) }
        : { padding: 24, scale: fit }),
    },
  } as any);
  return canvas.toDataURL("image/png");
};
