// The image a shared link shows in Slack, X or WhatsApp: the drawing on its canvas color, 1200×630, with the
// wordmark in a corner. Link crawlers run no script, so the browser of someone who can edit draws it and sends
// it a few seconds after the drawing last changed. Only the server decides whether a link may show it.
import { exportScene, hashElementsVersion } from "@betterdraw/editor";
import type { ExcalidrawImperativeAPI } from "@betterdraw/editor/types";

const W = 1200,
  H = 630,
  PAD = 64;

let logo: Promise<HTMLImageElement | null> | null = null;
const loadLogo = () =>
  (logo ??= new Promise((done) => {
    const img = new Image();
    img.onload = () => done(img);
    img.onerror = () => done(null);
    img.src = "/email-logo.png";
  }));

async function draw(ex: ExcalidrawImperativeAPI): Promise<Blob | null> {
  const elements = ex.getSceneElements();
  const background = ex.getAppState().viewBackgroundColor || "#ffffff";
  const out = document.createElement("canvas");
  out.width = W;
  out.height = H;
  const g = out.getContext("2d")!;
  g.fillStyle = background;
  g.fillRect(0, 0, W, H);
  if (elements.length) {
    const drawing = await exportScene({
      type: "canvas",
      data: { elements, files: ex.getFiles() },
      config: {
        canvasBackgroundColor: false,
        theme: "light",
        padding: 12, // room for strokes that wobble past their box
        scale: (w, h) => Math.min((W - 2 * PAD) / w, (H - 2 * PAD) / h, 3),
      },
    });
    g.drawImage(drawing, (W - drawing.width) / 2, (H - drawing.height) / 2);
  }
  const img = await loadLogo();
  if (img) g.drawImage(img, W - 172 - 24, H - 32 - 20, 172, 32);
  return new Promise((done) => out.toBlob(done, "image/png"));
}

// Watches the drawing and sends a new image after each quiet moment that follows a change. When the server's
// image is current, the first quiet moment only takes note of what the drawing looks like.
export function keepCard(canvasId: string, ex: ExcalidrawImperativeAPI, stale: boolean) {
  let sent: string | null = stale ? "" : null;
  let seen = "";
  let timer = 0;
  const off = ex.onChange((elements, appState) => {
    const v = `${hashElementsVersion(elements)}:${appState.viewBackgroundColor}`;
    if (v === seen) return;
    seen = v;
    clearTimeout(timer);
    timer = window.setTimeout(async () => {
      if (sent === null) return void (sent = v);
      if (v === sent) return;
      sent = v;
      const png = await draw(ex).catch(() => null);
      if (png)
        fetch(`/api/canvases/${canvasId}/card`, { method: "PUT", body: png, headers: { "content-type": "image/png" } }).catch(() => {});
    }, 5000);
  });
  return () => {
    off();
    clearTimeout(timer);
  };
}
