// Where image bytes live: a folder on disk by default, or any S3-compatible bucket (S3_* variables).
// Keys are "<canvasId>/<fileId>"; the database only keeps the metadata.
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { AwsClient } from "aws4fetch";
import { env } from "./env.js";

export type Storage = {
  put(canvasId: string, fileId: string, body: Uint8Array, mime: string): Promise<void>;
  get(canvasId: string, fileId: string): Promise<Uint8Array | null>;
  remove(canvasId: string, fileId: string): Promise<void>;
  removeCanvas(canvasId: string): Promise<void>;
};

const safe = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "");

function disk(dir: string): Storage {
  const path = (c: string, f?: string) => `${dir}/${safe(c)}` + (f ? `/${safe(f)}` : "");
  return {
    async put(c, f, body) {
      await mkdir(path(c), { recursive: true });
      await writeFile(path(c, f), body);
    },
    async get(c, f) {
      try {
        return new Uint8Array(await readFile(path(c, f)));
      } catch {
        return null;
      }
    },
    async remove(c, f) {
      await rm(path(c, f), { force: true });
    },
    async removeCanvas(c) {
      await rm(path(c), { recursive: true, force: true });
    },
  };
}

function s3(cfg: NonNullable<typeof env.s3>): Storage {
  const aws = new AwsClient({ accessKeyId: cfg.key, secretAccessKey: cfg.secret, region: cfg.region, service: "s3" });
  // Path-style URLs work with AWS, R2, Scaleway, OVH, Backblaze and MinIO alike.
  const url = (key = "") => `${cfg.endpoint}/${cfg.bucket}/${key}`;
  const check = async (r: Response, what: string) => {
    if (!r.ok && r.status !== 404) throw new Error(`S3 ${what} failed: ${r.status} ${await r.text().catch(() => "")}`.slice(0, 300));
    return r;
  };
  return {
    async put(c, f, body, mime) {
      await check(
        await aws.fetch(url(`${safe(c)}/${safe(f)}`), { method: "PUT", body: body as any, headers: { "content-type": mime } }),
        "upload",
      );
    },
    async get(c, f) {
      const r = await check(await aws.fetch(url(`${safe(c)}/${safe(f)}`)), "download");
      return r.status === 404 ? null : new Uint8Array(await r.arrayBuffer());
    },
    async remove(c, f) {
      await check(await aws.fetch(url(`${safe(c)}/${safe(f)}`), { method: "DELETE" }), "delete");
    },
    async removeCanvas(c) {
      for (;;) {
        const r = await check(await aws.fetch(`${url()}?list-type=2&prefix=${encodeURIComponent(safe(c) + "/")}`), "list");
        const keys = [...(await r.text()).matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]);
        if (!keys.length) return;
        for (const k of keys) await check(await aws.fetch(url(k), { method: "DELETE" }), "delete");
      }
    },
  };
}

export const storage: Storage = env.s3 ? s3(env.s3) : disk(env.filesDir);

// Excalidraw accepts these image types. Anything else is refused: an uploaded HTML or script file must
// never be served back from our own domain.
export const IMAGE_TYPES = /^image\/(png|jpeg|jpg|gif|webp|svg\+xml|bmp|x-icon|vnd\.microsoft\.icon|avif|jfif|pjpeg)$/;
