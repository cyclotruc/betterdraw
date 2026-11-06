// The built front end, held in memory, read from web/dist.
// Each file may come with .br and .gz versions made at build time; the best one the browser accepts is sent.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

type Asset = { body: Uint8Array; type: string; br?: Uint8Array; gz?: Uint8Array };

const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json",
  txt: "text/plain; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  ico: "image/x-icon",
  webmanifest: "application/manifest+json",
  woff2: "font/woff2",
  woff: "font/woff",
  ttf: "font/ttf",
  wasm: "application/wasm",
  map: "application/json",
  mp4: "video/mp4",
};
export const typeOf = (name: string) => TYPES[name.split(".").pop() ?? ""] ?? "application/octet-stream";

function collect(raw: Map<string, Uint8Array>) {
  const out = new Map<string, Asset>();
  for (const [name, body] of raw) {
    if (name.endsWith(".br") || name.endsWith(".gz")) continue;
    out.set(name, { body, type: typeOf(name), br: raw.get(name + ".br"), gz: raw.get(name + ".gz") });
  }
  return out;
}

function readDir(dir: string) {
  const raw = new Map<string, Uint8Array>();
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else raw.set(relative(dir, p).split("\\").join("/"), new Uint8Array(readFileSync(p)));
    }
  };
  walk(dir);
  return raw;
}

const dist = fileURLToPath(new URL("../web/dist/", import.meta.url));
export const assets: Map<string, Asset> = existsSync(dist) ? collect(readDir(dist)) : new Map();

export function assetResponse(path: string, acceptEncoding = "", range?: string) {
  const a = assets.get(path.replace(/^\/+/, ""));
  if (!a) return null;
  const hashed = /^(assets|fonts)\//.test(path.replace(/^\/+/, ""));
  const headers: Record<string, string> = {
    "content-type": a.type,
    "cache-control": hashed ? "public, max-age=31536000, immutable" : "no-cache",
    vary: "accept-encoding",
  };
  let body = a.body;
  if (a.br && /\bbr\b/.test(acceptEncoding)) {
    body = a.br;
    headers["content-encoding"] = "br";
  } else if (a.gz && /\bgzip\b/.test(acceptEncoding)) {
    body = a.gz;
    headers["content-encoding"] = "gzip";
  }
  // Safari only plays a video from a server that sends it in parts.
  if (!headers["content-encoding"]) {
    headers["accept-ranges"] = "bytes";
    const m = range?.match(/^bytes=(\d*)-(\d*)$/);
    if (m && (m[1] || m[2])) {
      const size = body.length;
      const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
      const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
      if (start > end) return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
      headers["content-range"] = `bytes ${start}-${end}/${size}`;
      return new Response(body.subarray(start, end + 1) as any, { status: 206, headers });
    }
  }
  return new Response(body as any, { headers });
}

export const indexHtml = () => new TextDecoder().decode(assets.get("index.html")?.body ?? new Uint8Array());
