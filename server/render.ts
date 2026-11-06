// Pictures of a canvas for agents, drawn by Excalidraw itself in a headless Chromium that opens this
// server's /__render page. The browser starts on the first picture, draws one picture at a time, gives up on
// one after 30 seconds, and closes then or after two idle minutes, so a server whose agents never ask for
// pictures never runs it. Nothing here touches rooms or the realtime path: it gets a copy of the elements and
// returns a PNG.
import type { Browser, Page } from "playwright-core";
import { env } from "./env.js";

export type Picture = {
  elements: unknown[];
  files: Record<string, { id: string; mimeType: string; dataURL: string; created: number }>;
  background: string;
  box?: { x: number; y: number; width: number; height: number };
};

const IDLE_MS = 120_000;
const MAX_SIDE = 1600; // pixels, the longer side of a picture
// A picture still being drawn after this is given up, and its browser closed: the pictures waiting behind it
// would wait for as long.
const DRAW_MS = 30_000;
export class TooSlow extends Error {}

let browser: Browser | null = null;
let page: Promise<Page> | null = null;
let idle: NodeJS.Timeout | undefined;
let queue: Promise<unknown> = Promise.resolve();

async function start() {
  const { chromium } = await import("playwright-core");
  const b = (browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ["--no-sandbox"] }));
  // A browser closed after a failed picture may go once the next one has started: that one stays known.
  b.on("disconnected", () => {
    if (browser === b) [browser, page] = [null, null];
  });
  const p = await b.newPage({ viewport: { width: 800, height: 600 } });
  const host = env.bind === "0.0.0.0" || env.bind === "::" ? "127.0.0.1" : env.bind;
  await p.goto(`http://${host}:${env.port}/__render`);
  await p.waitForFunction(() => typeof (window as any).__render === "function", null, { timeout: 30_000 });
  return p;
}

function stop() {
  const b = browser;
  [browser, page] = [null, null];
  b?.close().catch(() => {});
}

// One picture at a time: a second request waits for the first.
export function render(pic: Picture): Promise<Buffer> {
  const run = queue.then(async () => {
    clearTimeout(idle);
    let late: NodeJS.Timeout | undefined;
    try {
      page ??= start();
      const p = await page;
      const dataUrl: string = await Promise.race([
        p.evaluate((input) => (window as any).__render(input), { ...pic, maxSide: MAX_SIDE }),
        new Promise<never>((_, fail) => (late = setTimeout(() => fail(new TooSlow(`drawing took over ${DRAW_MS / 1000} s`)), DRAW_MS))),
      ]);
      return Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
    } catch (e) {
      stop(); // a broken or stuck browser is not kept: the next picture starts a fresh one
      throw e;
    } finally {
      clearTimeout(late);
      idle = setTimeout(stop, IDLE_MS);
      idle.unref();
    }
  });
  queue = run.catch(() => {});
  return run;
}
