// Profile pictures. Without one, browsers draw a face from the name. Google sign-in brings its photo
// ("user".image holds its https address); an account can also send its own, kept in storage as
// "avatars/<userId>" and pointed to by "/api/avatar/<userId>?v=<time>", or go back to the drawn face.
import type { Hono } from "hono";
import { q } from "./db.js";
import { sessionUser } from "./auth.js";
import { storage } from "./storage.js";

const TYPES = /^image\/(png|jpeg|webp)$/; // the browser sends a 256 px square, never an SVG
export const MAX_AVATAR_BYTES = 512 * 1024;

export const removeAvatar = (userId: string) => storage.remove("avatars", userId).catch(() => {});

export function avatars(app: Hono) {
  app.put("/api/me/avatar", async (c) => {
    const u = await sessionUser(c.req.raw.headers);
    if (!u || u.anonymous) return c.json({ error: "not_signed_in" }, 401);
    const mime = (c.req.header("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (!TYPES.test(mime)) return c.json({ error: "unsupported_type" }, 415);
    const buf = new Uint8Array(await c.req.arrayBuffer());
    if (!buf.length || buf.length > MAX_AVATAR_BYTES) return c.json({ error: "too_big" }, 413);
    await storage.put("avatars", u.id, buf, mime);
    const image = `/api/avatar/${u.id}?v=${Date.now()}`;
    await q(`update "user" set image = $1 where id = $2`, [image, u.id]);
    return c.json({ image });
  });

  // Back to the drawn face, also from a Google photo.
  app.delete("/api/me/avatar", async (c) => {
    const u = await sessionUser(c.req.raw.headers);
    if (!u || u.anonymous) return c.json({ error: "not_signed_in" }, 401);
    await q(`update "user" set image = null where id = $1`, [u.id]);
    await removeAvatar(u.id);
    return c.json({ image: null });
  });

  // Shown to whoever shares a canvas with this person; the address changes with each new picture.
  app.get("/api/avatar/:id", async (c) => {
    const bytes = await storage.get("avatars", c.req.param("id"));
    if (!bytes) return c.notFound();
    const mime = bytes[0] === 0x89 ? "image/png" : bytes[0] === 0xff ? "image/jpeg" : "image/webp";
    return c.body(bytes as any, 200, {
      "content-type": mime,
      "cache-control": "public, max-age=31536000, immutable",
      "content-security-policy": "default-src 'none'; sandbox",
    });
  });
}
