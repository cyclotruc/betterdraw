// Feedback and bug reports, from anyone, signed in or not: what they wrote, the screenshots they pasted, and
// what the browser and the server know of the moment (browser, screen, page, canvas, recent errors). Admins
// read them in the admin's Feedback tab. The screenshots live in the image storage under "feedback-<id>".
import { randomBytes } from "node:crypto";
import type { Context, Hono } from "hono";
import { q, toDate } from "./db.js";
import { env } from "./env.js";
import { sessionUser } from "./auth.js";
import { storage } from "./storage.js";
import { clientIp, limited } from "./security.js";
import { describeAgent, event, hit } from "./stats.js";

const SHOTS = /^image\/(png|jpeg|webp|gif)$/;
// At most this many screenshots, of at most this many MB each. /api/config tells the web app.
export const MAX_SHOTS = 5;
export const MAX_SHOT_MB = 10;
const MAX_SHOT = MAX_SHOT_MB * 1024 * 1024;
// A whole report: its screenshots and a megabyte for the rest. Larger bodies are refused unread (app.ts).
export const MAX_FEEDBACK_BYTES = MAX_SHOTS * MAX_SHOT + 1024 * 1024;
const folder = (id: string) => `feedback-${id}`;

export function feedbackRoutes(app: Hono, admin: (c: Context) => Promise<boolean>) {
  const only = (run: (c: Context) => Promise<Response>) => async (c: Context) =>
    (await admin(c)) ? run(c) : c.json({ error: "admin_only" }, 403);

  // multipart: kind (feedback | bug), message, context (JSON from the browser), shots (images).
  app.post("/api/feedback", async (c) => {
    const ip = clientIp(c);
    if (limited("feedback:" + ip, 10, 3600_000)) return c.json({ error: "rate_limited" }, 429);
    const form = await c.req.parseBody({ all: true }).catch(() => null);
    if (!form) return c.json({ error: "bad_request" }, 400);
    const one = (k: string) => {
      const v = form[k];
      return typeof v === "string" ? v : Array.isArray(v) && typeof v[0] === "string" ? v[0] : "";
    };
    const message = one("message").trim().slice(0, 10_000);
    const files = ([] as unknown[])
      .concat(form.shots ?? [])
      .filter((f): f is File => f instanceof File)
      .slice(0, MAX_SHOTS);
    if (!message && !files.length) return c.json({ error: "empty" }, 400);
    for (const f of files) {
      if (!SHOTS.test(f.type)) return c.json({ error: "unsupported_type" }, 415);
      if (f.size > MAX_SHOT) return c.json({ error: "too_big" }, 413);
    }
    let browser: unknown = {};
    try {
      browser = JSON.parse(one("context").slice(0, 100_000));
    } catch {}
    const u = await sessionUser(c.req.raw.headers).catch(() => null);
    const ua = c.req.header("user-agent") ?? "";
    const id = randomBytes(12).toString("base64url");
    const shots: { id: string; mime: string; size: number }[] = [];
    for (const f of files) {
      const fileId = randomBytes(8).toString("base64url");
      await storage.put(folder(id), fileId, new Uint8Array(await f.arrayBuffer()), f.type);
      shots.push({ id: fileId, mime: f.type, size: f.size });
    }
    const context = {
      browser,
      server: {
        version: env.version,
        device: ua ? describeAgent(ua) : null,
        userAgent: ua.slice(0, 500),
        language: c.req.header("accept-language")?.slice(0, 100) ?? null,
      },
    };
    const kind = one("kind") === "bug" ? "bug" : "feedback";
    await q(
      `insert into feedback (id, kind, message, user_id, name, email, guest, context, shots) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        id,
        kind,
        message,
        u?.id ?? null,
        u?.name ?? null,
        u?.email ?? null,
        u ? u.anonymous : true,
        JSON.stringify(context),
        JSON.stringify(shots),
      ],
    );
    hit("feature", kind === "bug" ? "bug reported" : "feedback sent");
    event({ kind: "feedback", who: u?.name ?? "Someone", user: u?.id, detail: kind === "bug" ? "reported a bug" : "sent feedback" });
    return c.json({ ok: true });
  });

  // Newest first, 30 at a time, the new ones or the handled ones.
  app.get(
    "/api/admin/feedback",
    only(async (c) => {
      const status = c.req.query("status") === "done" ? "done" : c.req.query("status") === "all" ? null : "new";
      const offset = Math.max(0, Number(c.req.query("offset")) || 0);
      const rows = await q<any>(
        `select id, kind, message, user_id, name, email, guest, context, shots, status, created_at from feedback
          ${status ? "where status = $2" : ""} order by created_at desc limit 30 offset $1`,
        status ? [offset, status] : [offset],
      );
      const counts: Record<string, number> = { new: 0, done: 0 };
      for (const r of await q<{ status: string; n: string }>(`select status, count(*) as n from feedback group by status`))
        counts[r.status] = Number(r.n);
      return c.json({
        counts,
        items: rows.map((r) => ({
          id: r.id,
          kind: r.kind,
          message: r.message,
          user: r.user_id ? { id: r.user_id, name: r.name, email: r.email, guest: !!r.guest } : null,
          context: typeof r.context === "string" ? JSON.parse(r.context) : r.context,
          shots: typeof r.shots === "string" ? JSON.parse(r.shots) : r.shots,
          status: r.status,
          created: toDate(r.created_at).toISOString(),
        })),
      });
    }),
  );
  app.get(
    "/api/admin/feedback/:id/shots/:shot",
    only(async (c) => {
      const [r] = await q<{ shots: any }>(`select shots from feedback where id = $1`, [c.req.param("id")]);
      const list: { id: string; mime: string }[] = r ? (typeof r.shots === "string" ? JSON.parse(r.shots) : r.shots) : [];
      const shot = list.find((s) => s.id === c.req.param("shot"));
      const bytes = shot && (await storage.get(folder(c.req.param("id") ?? ""), shot.id));
      if (!shot || !bytes) return c.notFound();
      return c.body(bytes as any, 200, { "content-type": shot.mime, "cache-control": "private, max-age=86400" });
    }),
  );
  app.patch(
    "/api/admin/feedback/:id",
    only(async (c) => {
      const status = (await c.req.json().catch(() => ({}))).status === "done" ? "done" : "new";
      await q(`update feedback set status = $2 where id = $1`, [c.req.param("id"), status]);
      return c.json({ ok: true });
    }),
  );
  app.delete(
    "/api/admin/feedback/:id",
    only(async (c) => {
      await storage.removeCanvas(folder(c.req.param("id") ?? ""));
      await q(`delete from feedback where id = $1`, [c.req.param("id")]);
      return c.json({ ok: true });
    }),
  );
}
