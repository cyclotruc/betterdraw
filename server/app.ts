// HTTP routes: the JSON API under /api, auth, images, downloads, legal pages and the front end.
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { env } from "./env.js";
import { q, toDate } from "./db.js";
import { auth, emailAllowed, loginBox, resetBox, sessionUser, type SessionUser } from "./auth.js";
import {
  access,
  accessFor,
  atCanvasLimit,
  canEdit,
  canvasRow,
  createCanvas,
  destroyCanvas,
  isUntitled,
  type CanvasRow,
} from "./canvases.js";
import { openLink, rememberGuest } from "./guests.js";
import { getRoom, rooms } from "./rooms.js";
import { IMAGE_TYPES, storage } from "./storage.js";
import { sendLoginEmail, sendPasswordEmail } from "./mail.js";
import { clientIp, limited, originCheck, securityHeaders, VISITOR_IP_HEADER } from "./security.js";
import { assetResponse, assets, indexHtml } from "./static.js";
import { metrics, renderMetrics } from "./metrics.js";
import { zip } from "./zip.js";
import { emit, limitsFor, routes } from "./extend.js";
import { event, hit, noteVisit } from "./stats.js";
import { totalOf, usage } from "./usage.js";
import { adminRoutes } from "./admin.js";
import { feedbackRoutes, MAX_FEEDBACK_BYTES, MAX_SHOT_MB, MAX_SHOTS } from "./feedback.js";
import { agents } from "./agents.js";
import { avatars, MAX_AVATAR_BYTES, removeAvatar } from "./avatars.js";

export const app = new Hono();
const me = (c: Context) => sessionUser(c.req.raw.headers);
const body = async (c: Context) => c.req.json().catch(() => ({}) as any);

app.use("*", securityHeaders);
app.use("/api/*", originCheck);

// What a request's body may weigh, sent in chunks or not: past it, the request is refused with 413 before more of
// it is read. JSON needs little; images, link cards, profile pictures and feedback have their own maxima, and the
// agent API its own (agents.ts). deploy/Caddyfile lets the largest through.
const MAX_CARD_BYTES = 4_000_000;
const tooBig = (c: Context) => c.json({ error: "too_big" }, 413);
const BODIES: [RegExp, MiddlewareHandler][] = [
  [/^\/api\/v1\//, (_, next) => next()],
  [/^\/api\/canvases\/[^/]+\/files\/[^/]+$/, bodyLimit({ maxSize: env.maxFileBytes, onError: tooBig })],
  [/^\/api\/canvases\/[^/]+\/card$/, bodyLimit({ maxSize: MAX_CARD_BYTES, onError: tooBig })],
  [/^\/api\/me\/avatar$/, bodyLimit({ maxSize: MAX_AVATAR_BYTES, onError: tooBig })],
  [/^\/api\/feedback$/, bodyLimit({ maxSize: MAX_FEEDBACK_BYTES, onError: tooBig })],
];
const jsonBody = bodyLimit({ maxSize: 1024 * 1024, onError: tooBig });
app.use("/api/*", (c, next) => (BODIES.find(([path]) => path.test(c.req.path))?.[1] ?? jsonBody)(c, next));

// ---------- health and metrics ----------
app.get("/healthz", async (c) => {
  try {
    await q(`select 1 as ok`);
    return c.json({ ok: true, version: env.version });
  } catch {
    return c.json({ ok: false }, 503);
  }
});
app.get("/metrics", (c) => {
  if (!env.metricsToken || c.req.header("authorization") !== `Bearer ${env.metricsToken}`) return c.notFound();
  return c.text(renderMetrics({ rooms_open: rooms.size, clients: [...rooms.values()].reduce((n, r) => n + r.clients.size, 0) }));
});

// ---------- auth ----------
// Only the Better Auth endpoints the app uses are reachable from outside. Everything that sends an
// email goes through /api/login/* below, which applies the rate limits and the domain and signup rules.
const AUTH_ROUTES =
  /^\/api\/auth\/(sign-in\/(anonymous|email|social)|magic-link\/verify|reset-password|callback\/[\w-]+|get-session|sign-out|update-user)$/;
app.on(["GET", "POST"], "/api/auth/*", async (c) => {
  if (!AUTH_ROUTES.test(c.req.path)) return c.json({ error: "not_found" }, 404);
  c.req.raw.headers.set(VISITOR_IP_HEADER, clientIp(c));
  // Passwords can be guessed: a few tries per address, more per IP.
  if (c.req.path === "/api/auth/sign-in/email") {
    const sent = await c.req.raw
      .clone()
      .json()
      .catch(() => null);
    const email = String(sent?.email ?? "").toLowerCase();
    if (limited("password:" + email, 10, 900_000) || limited("password-ip:" + clientIp(c), 50, 3_600_000))
      return c.json({ error: "rate_limited" }, 429);
  }
  // Guests are free, but not by the thousand from one address.
  if (c.req.path === "/api/auth/sign-in/anonymous" && limited("guest-ip:" + clientIp(c), 60, 3_600_000))
    return c.json({ error: "rate_limited" }, 429);
  // Opening a login link hands what the guest who asked for it made over to the account it signs in to (guests.ts).
  if (c.req.path === "/api/auth/magic-link/verify")
    return openLink(
      c.req.query("token"),
      () => me(c),
      () => auth.handler(c.req.raw),
    );
  return auth.handler(c.req.raw);
});

// One email with a sign-in link. An address without a password gets a link that asks for one: that is
// how an account is created. Rate limited per address and per IP.
app.post("/api/login/email", async (c) => {
  const b = await body(c);
  const email = String(b.email ?? "")
    .trim()
    .toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return c.json({ error: "invalid_email" }, 400);
  if (limited("mail:" + email, 5, 3_600_000) || limited("mail-ip:" + clientIp(c), 30, 3_600_000))
    return c.json({ error: "rate_limited" }, 429);
  if (!emailAllowed(email)) return c.json({ error: "domain_not_allowed" }, 403);
  if (env.signup === "closed") {
    const [u] = await q(`select id from "user" where email = $1`, [email]);
    if (!u) return c.json({ error: "signup_closed" }, 403);
  }
  const guest = await me(c);
  const box: { link?: string; token?: string } = {};
  try {
    await loginBox.run(box, () => auth.api.signInMagicLink({ body: { email, callbackURL: "/" }, headers: c.req.raw.headers }));
    if (guest?.anonymous && box.token) rememberGuest(box.token, guest);
    const [hasPassword] = await q(
      `select 1 from account a join "user" u on u.id = a."userId" where u.email = $1 and a."providerId" = 'credential' and a.password is not null`,
      [email],
    );
    await sendLoginEmail(email, hasPassword ? box.link! : box.link + "&new=1", !hasPassword);
    metrics.loginEmails++;
  } catch (e: any) {
    console.error("login email:", e?.message ?? e);
    return c.json({ error: "email_failed" }, 502);
  }
  return c.json({ ok: true });
});

// The last step of an email sign-up, right after its link signed the person in: their password.
app.post("/api/login/set-password", async (c) => {
  const b = await body(c);
  try {
    await auth.api.setPassword({ body: { newPassword: String(b.password ?? "") }, headers: c.req.raw.headers });
  } catch (e: any) {
    return c.json({ error: e?.body?.code === "PASSWORD_ALREADY_SET" ? "password_already_set" : "bad_password" }, 400);
  }
  return c.json({ ok: true });
});

// A link to choose a password, for an account whose address is proven. Same limits as login emails, and
// the same quick answer whether the account exists or not.
app.post("/api/login/password-reset", async (c) => {
  const b = await body(c);
  const email = String(b.email ?? "")
    .trim()
    .toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return c.json({ error: "invalid_email" }, 400);
  if (limited("mail:" + email, 5, 3_600_000) || limited("mail-ip:" + clientIp(c), 30, 3_600_000))
    return c.json({ error: "rate_limited" }, 429);
  const box: { token?: string } = {};
  await resetBox
    .run(box, () => auth.api.requestPasswordReset({ body: { email, redirectTo: "/" }, headers: c.req.raw.headers }))
    .catch((e) => console.error("password reset:", e?.message ?? e));
  if (box.token)
    sendPasswordEmail(email, `${env.baseUrl}/auth/password#t=${box.token}&e=${encodeURIComponent(email)}`).catch((e) =>
      console.error("password email:", e?.message ?? e),
    );
  return c.json({ ok: true });
});

// ---------- the person and their data ----------
export const legalPages = () =>
  env.legalDir && existsSync(env.legalDir)
    ? readdirSync(env.legalDir)
        .filter((f) => /^[a-z-]+\.html$/.test(f))
        .map((f) => f.slice(0, -5))
    : [];

app.get("/api/config", (c) =>
  c.json({
    app: env.appName,
    version: env.version,
    google: !!env.google,
    oidc: env.oidc?.name ?? null,
    signup: env.signup,
    legal: legalPages(),
    maxFileMb: env.maxFileBytes / 1048576,
    guestCanvasHours: env.guestCanvasHours,
    feedbackShots: MAX_SHOTS,
    feedbackShotMb: MAX_SHOT_MB,
  }),
);

// Who is signed in, and whether they have a password (Settings offers to add one or change it).
app.get("/api/me", async (c) => {
  const u = await me(c);
  if (!u || u.anonymous) return c.json(u);
  const [pw] = await q(`select 1 from account where "userId" = $1 and "providerId" = 'credential' and password is not null`, [u.id]);
  return c.json({ ...u, hasPassword: !!pw });
});

// Delete the account (or the guest) and everything it owns. The client asks for a second click first.
app.delete("/api/me", async (c) => {
  const u = await me(c);
  if (!u) return c.json({ error: "not_signed_in" }, 401);
  if ((await body(c)).confirm !== true) return c.json({ error: "confirm" }, 400);
  await deleteUser(u.id);
  return c.json({ ok: true });
});

// A person and everything they own.
async function deleteUser(id: string) {
  for (const cv of await q<{ id: string }>(`select id from canvases where owner_id = $1`, [id])) await destroyCanvas(cv.id);
  await q(`delete from "user" where id = $1`, [id]);
  await removeAvatar(id);
  await emit("userDeleted", { id });
}

// One canvas as an .excalidraw file with its images inside: what Download gives, and what the export zips.
async function sceneFile(cv: { id: string; title: string; app_state: any }) {
  await rooms.get(cv.id)?.flush();
  const elements = (await q<{ data: any }>(`select data from elements where canvas_id = $1`, [cv.id]))
    .map((r) => r.data)
    .filter((e) => !e.isDeleted);
  const files: Record<string, unknown> = {};
  for (const f of await q<{ file_id: string; mime: string; created_at: unknown }>(
    `select file_id, mime, created_at from files where canvas_id = $1`,
    [cv.id],
  )) {
    if (!elements.some((e) => e.fileId === f.file_id)) continue;
    const bytes = await storage.get(cv.id, f.file_id);
    if (bytes)
      files[f.file_id] = {
        id: f.file_id,
        mimeType: f.mime,
        dataURL: `data:${f.mime};base64,${Buffer.from(bytes).toString("base64")}`,
        created: Date.now(),
      };
  }
  const scene = {
    type: "excalidraw",
    version: 2,
    source: env.baseUrl,
    elements,
    appState: { viewBackgroundColor: cv.app_state?.viewBackgroundColor ?? "#ffffff", gridSize: null },
    files,
  };
  return {
    name: (isUntitled(cv.title) ? "untitled" : cv.title).replace(/[\\/:*?"<>|\x00-\x1f]/g, "-").slice(0, 80),
    data: new TextEncoder().encode(JSON.stringify(scene)),
  };
}

// Everything the person owns, as .excalidraw files in one zip.
app.get("/api/export", async (c) => {
  const u = await me(c);
  if (!u) return c.json({ error: "not_signed_in" }, 401);
  // Built in memory: refuse what would not fit comfortably (each canvas can still be saved on its own).
  const [{ n }] = await q<{ n: string }>(
    `select coalesce(sum(f.size), 0) as n from files f join canvases c on c.id = f.canvas_id where c.owner_id = $1 and c.deleted_at is null`,
    [u.id],
  );
  if (Number(n) > env.exportMaxBytes) return c.json({ error: "export_too_big" }, 413);
  const entries: { name: string; data: Uint8Array }[] = [];
  const used = new Set<string>();
  for (const cv of await q<{ id: string; title: string; app_state: any }>(
    `select id, title, app_state from canvases where owner_id = $1 and deleted_at is null order by updated_at desc`,
    [u.id],
  )) {
    const file = await sceneFile(cv);
    let name = file.name;
    if (used.has(name)) name += `-${cv.id.slice(0, 6)}`;
    used.add(name);
    entries.push({ name: `${name}.excalidraw`, data: file.data });
  }
  return c.body(zip(entries) as any, 200, {
    "content-type": "application/zip",
    "content-disposition": `attachment; filename="${env.appName.replace(/[^\w-]+/g, "-").toLowerCase()}-export.zip"`,
  });
});

const PREF_KEYS = new Set(["accent", "theme", "adminView"]);
app.get("/api/prefs", async (c) => {
  const u = await me(c);
  if (!u) return c.json({});
  const [r] = await q<{ prefs: Record<string, unknown> }>(`select prefs from user_prefs where user_id = $1`, [u.id]);
  return c.json(r?.prefs ?? {});
});
app.put("/api/prefs", async (c) => {
  const u = await me(c);
  if (!u) return c.json({ error: "not_signed_in" }, 401);
  const b = await body(c);
  const clean: Record<string, string> = {};
  for (const k of PREF_KEYS) if (typeof b[k] === "string" && b[k].length < 32) clean[k] = b[k];
  await q(
    `insert into user_prefs (user_id, prefs) values ($1, $2) on conflict (user_id) do update set prefs = user_prefs.prefs || excluded.prefs`,
    [u.id, JSON.stringify(clean)],
  );
  return c.json({ ok: true });
});

// ---------- canvases ----------
app.get("/api/canvases", async (c) => {
  const u = await me(c);
  if (!u) return c.json([]);
  return c.json(
    await q(
      `select c.id, c.title, c.updated_at, (c.owner_id = $1) as mine, p.project_id, coalesce(p.pinned, false) as pinned,
              c.expires_at, c.live
         from canvases c
         left join canvas_places p on p.canvas_id = c.id and p.user_id = $1
        where c.deleted_at is null and c.blocked_at is null
          and (c.owner_id = $1 or exists (select 1 from canvas_access a where a.canvas_id = c.id and a.user_id = $1))
        order by c.updated_at desc`,
      [u.id],
    ).then((rows) => rows.map((r: any) => ({ ...r, expires_at: r.expires_at ? toDate(r.expires_at).toISOString() : null }))),
  );
});

// Who is on each open canvas of this person's list, themselves left out. The sidebar asks every few seconds.
app.get("/api/presence", async (c) => {
  const u = await me(c);
  const ids = [...rooms.keys()];
  if (!u || !ids.length) return c.json({});
  const now = Date.now();
  const out: Record<string, unknown> = {};
  for (let i = 0; i < ids.length; i += 500) {
    const part = ids.slice(i, i + 500);
    for (const { id } of await q<{ id: string }>(
      `select c.id from canvases c
        where c.id in (${part.map((_, j) => `$${j + 2}`).join(",")}) and c.deleted_at is null and c.blocked_at is null
          and (c.owner_id = $1 or exists (select 1 from canvas_access a where a.canvas_id = c.id and a.user_id = $1))`,
      [u.id, ...part],
    )) {
      const here = rooms.get(id)?.here(now, u.id);
      if (here?.length) out[id] = here;
    }
  }
  return c.json(out);
});

app.post("/api/canvases", async (c) => {
  const u = await me(c);
  if (!u) return c.json({ error: "not_signed_in" }, 401);
  const r = await createCanvas(u, (await body(c)).title);
  if ("error" in r) return c.json(r, 403);
  hit("canvas", u.program ? "agent" : u.anonymous ? "guest" : "person");
  event({ kind: "canvas", who: u.name, user: u.id, canvas: r.id });
  return c.json(r);
});

const accessError = (c: Context, error?: string) =>
  c.json({ error: error ?? "private" }, error === "not_found" ? 404 : error === "blocked" ? 410 : 403);

app.get("/api/canvases/:id", async (c) => {
  const u = await me(c);
  const a = await accessFor(c.req.param("id"), u, c.req.query("watch") !== undefined);
  if (a.error || a.role === "none") return accessError(c, a.error);
  const { id, title, link_access, owner_id, app_state, updated_at, card_at } = a.cv!;
  const background = app_state?.viewBackgroundColor ?? null;
  const card_stale = !card_at || toDate(card_at) < toDate(updated_at);
  return c.json({ id, title: isUntitled(title) ? "" : title, link_access, owner_id, role: a.role, background, card_stale });
});

// This canvas as an .excalidraw file, for anyone who can open it.
app.get("/api/canvases/:id/download", async (c) => {
  const u = await me(c);
  const a = await access(c.req.param("id"), u);
  if (a.error || a.role === "none") return accessError(c, a.error);
  const file = await sceneFile(a.cv!);
  const name = `${file.name}.excalidraw`;
  return c.body(file.data as any, 200, {
    "content-type": "application/vnd.excalidraw+json",
    "content-disposition": `attachment; filename="${name.replace(/[^\x20-\x7e]|"/g, "_")}"; filename*=UTF-8''${encodeURIComponent(name)}`,
  });
});

// What a dashboard card draws: the live elements and the canvas color; images are fetched by their own route.
app.get("/api/canvases/:id/preview", async (c) => {
  const u = await me(c);
  const a = await access(c.req.param("id"), u);
  if (a.error || a.role === "none") return accessError(c, a.error);
  await rooms.get(a.cv!.id)?.flush();
  const elements = (await q<{ data: any }>(`select data from elements where canvas_id = $1`, [a.cv!.id]))
    .map((r) => r.data)
    .filter((e) => !e.isDeleted);
  return c.json({ elements, background: a.cv!.app_state?.viewBackgroundColor ?? null }, 200, { "cache-control": "private, no-cache" });
});

// The image a shared link shows (Slack, X, WhatsApp): drawn by the browser of someone who can edit, a few
// seconds after the drawing changes, since link crawlers run no script. Shown only while the link opens the canvas.
const shareable = (cv: CanvasRow | null) => !!cv && !cv.deleted_at && !cv.blocked_at && cv.link_access !== "none";
app.put("/api/canvases/:id/card", async (c) => {
  const u = await me(c);
  const a = await access(c.req.param("id"), u);
  if (!canEdit(a.role)) return accessError(c, a.error);
  const buf = new Uint8Array(await c.req.arrayBuffer());
  if (buf.length > MAX_CARD_BYTES) return c.json({ error: "too_big" }, 413);
  if (buf.length < 8 || buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) return c.json({ error: "not_png" }, 415);
  await storage.put(a.cv!.id, "card", buf, "image/png");
  await q(`update canvases set card_at = now() where id = $1`, [a.cv!.id]);
  return c.json({ ok: true });
});
// Outside /api/, which robots.txt closes to crawlers, X and LinkedIn among them.
app.get("/card/:id", async (c) => {
  const cv = await canvasRow(c.req.param("id"));
  const bytes = shareable(cv) && cv!.card_at ? await storage.get(cv!.id, "card") : null;
  if (!bytes) return c.redirect("/og.png");
  return c.body(bytes as any, 200, { "content-type": "image/png", "cache-control": "public, max-age=3600" });
});

// The background color belongs to the drawing: whoever can edit it sets it, and the room sees it at once.
app.put("/api/canvases/:id/background", async (c) => {
  const u = await me(c);
  const a = await access(c.req.param("id"), u);
  if (a.error || a.role === "none") return accessError(c, a.error);
  if (!canEdit(a.role)) return c.json({ error: "read_only" }, 403);
  const { color } = await body(c);
  if (typeof color !== "string" || !/^#[0-9a-f]{6}$/i.test(color)) return c.json({ error: "invalid" }, 400);
  const id = a.cv!.id;
  await q(`update canvases set app_state = $2 where id = $1`, [
    id,
    JSON.stringify({ ...(a.cv!.app_state ?? {}), viewBackgroundColor: color }),
  ]);
  rooms.get(id)?.broadcast({ t: "background", color });
  return c.json({ ok: true });
});

app.patch("/api/canvases/:id", async (c) => {
  const u = await me(c);
  const a = await access(c.req.param("id"), u);
  if (a.role !== "owner") return c.json({ error: "owner_only" }, 403);
  const id = a.cv!.id;
  const b = await body(c);
  if (typeof b.title === "string") await q(`update canvases set title = $2 where id = $1`, [id, b.title.slice(0, 200)]);
  if (["none", "view", "edit"].includes(b.link_access)) {
    await q(`update canvases set link_access = $2 where id = $1`, [id, b.link_access]);
    hit("feature", `link access: ${b.link_access}`);
    // Going private (or read-only) withdraws the seats people got through the URL. Opening it to editing again
    // keeps them, as editors: such a seat gives what the URL gives (access()), and its stored role, which the
    // admin shows, says so too.
    if (b.link_access !== "edit") await q(`delete from canvas_access where canvas_id = $1 and via_link = $2`, [id, true]);
    else await q(`update canvas_access set role = $2 where canvas_id = $1 and via_link = $3`, [id, "editor", true]);
    rooms.get(id)?.kick(4001, "access changed", (cl) => cl.user.id === u!.id);
  }
  return c.json({ ok: true });
});

// Owners delete (undo stays possible for a while), everyone else just removes it from their list.
app.delete("/api/canvases/:id", async (c) => {
  const u = await me(c);
  if (!u) return c.json({ error: "not_signed_in" }, 401);
  const cv = await canvasRow(c.req.param("id"));
  if (!cv) return c.json({ error: "not_found" }, 404);
  if (cv.owner_id === u.id) {
    await q(`update canvases set deleted_at = now() where id = $1`, [cv.id]);
    const room = rooms.get(cv.id);
    room?.kick(4004, "deleted");
    await room?.flush();
    room?.dispose();
  } else {
    await q(`delete from canvas_access where canvas_id = $1 and user_id = $2`, [cv.id, u.id]);
    await q(`delete from canvas_places where canvas_id = $1 and user_id = $2`, [cv.id, u.id]);
  }
  return c.json({ ok: true });
});

// Where a canvas sits in this person's list: in one of their projects or in none, pinned or not.
app.patch("/api/canvases/:id/place", async (c) => {
  const u = await me(c);
  if (!u) return c.json({ error: "not_signed_in" }, 401);
  const id = c.req.param("id");
  const [listed] = await q(
    `select 1 as ok from canvases c
      where c.id = $1 and c.deleted_at is null
        and (c.owner_id = $2 or exists (select 1 from canvas_access a where a.canvas_id = c.id and a.user_id = $2))`,
    [id, u.id],
  );
  if (!listed) return c.json({ error: "not_found" }, 404);
  const b = await body(c);
  const [now] = await q<{ project_id: string | null; pinned: unknown }>(
    `select project_id, pinned from canvas_places where user_id = $1 and canvas_id = $2`,
    [u.id, id],
  );
  let project = now?.project_id ?? null;
  if (b.project_id !== undefined) {
    project = typeof b.project_id === "string" && b.project_id ? b.project_id : null;
    if (project && !(await q(`select 1 as ok from projects where id = $1 and user_id = $2`, [project, u.id])).length)
      return c.json({ error: "not_found" }, 404);
  }
  const pinned = typeof b.pinned === "boolean" ? b.pinned : !!now?.pinned;
  await q(
    `insert into canvas_places (user_id, canvas_id, project_id, pinned) values ($1, $2, $3, $4)
     on conflict (user_id, canvas_id) do update set project_id = excluded.project_id, pinned = excluded.pinned`,
    [u.id, id, project, pinned],
  );
  return c.json({ ok: true });
});

// ---------- projects: each person's own folders for the canvases of their list ----------
app.get("/api/projects", async (c) => {
  const u = await me(c);
  if (!u) return c.json([]);
  return c.json(await q(`select id, name, color from projects where user_id = $1 order by created_at, id`, [u.id]));
});

app.post("/api/projects", async (c) => {
  const u = await me(c);
  if (!u) return c.json({ error: "not_signed_in" }, 401);
  hit("feature", "project created");
  const b = await body(c);
  const name = String(b.name ?? "")
    .trim()
    .slice(0, 100);
  if (!name) return c.json({ error: "name_required" }, 400);
  const project = { id: randomBytes(12).toString("base64url"), name, color: String(b.color ?? "").slice(0, 20) };
  await q(`insert into projects (id, user_id, name, color) values ($1, $2, $3, $4)`, [project.id, u.id, name, project.color]);
  return c.json(project);
});

app.patch("/api/projects/:id", async (c) => {
  const u = await me(c);
  if (!u) return c.json({ error: "not_signed_in" }, 401);
  const b = await body(c);
  const name = typeof b.name === "string" ? b.name.trim().slice(0, 100) : "";
  if (name) await q(`update projects set name = $3 where id = $1 and user_id = $2`, [c.req.param("id"), u.id, name]);
  if (typeof b.color === "string")
    await q(`update projects set color = $3 where id = $1 and user_id = $2`, [c.req.param("id"), u.id, b.color.slice(0, 20)]);
  return c.json({ ok: true });
});

// Its canvases stay, back in no project.
app.delete("/api/projects/:id", async (c) => {
  const u = await me(c);
  if (!u) return c.json({ error: "not_signed_in" }, 401);
  await q(`delete from projects where id = $1 and user_id = $2`, [c.req.param("id"), u.id]);
  return c.json({ ok: true });
});

app.post("/api/canvases/:id/restore", async (c) => {
  const u = await me(c);
  const cv = await canvasRow(c.req.param("id"));
  if (!u || !cv || cv.owner_id !== u.id) return c.json({ error: "owner_only" }, 403);
  // A canvas back from the trash counts like a new one.
  if (cv.deleted_at && (await atCanvasLimit(u))) return c.json({ error: "quota_canvases" }, 403);
  await q(`update canvases set deleted_at = null where id = $1`, [cv.id]);
  return c.json({ ok: true });
});

// ---------- images ----------
app.put("/api/canvases/:id/files/:fileId", async (c) => {
  const u = await me(c);
  const a = await access(c.req.param("id"), u);
  if (!canEdit(a.role)) return accessError(c, a.error);
  const fileId = c.req.param("fileId");
  if (!/^[\w-]{1,100}$/.test(fileId)) return c.json({ error: "invalid_id" }, 400);
  // An id names one image for good (the editor makes it from the image's content): sent again, it stores nothing,
  // so that the size the quota and the export count stays the size of what is stored.
  const [stored] = await q(`select 1 as ok from files where canvas_id = $1 and file_id = $2`, [a.cv!.id, fileId]);
  if (stored) return c.json({ ok: true });
  const mime = (c.req.header("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (!IMAGE_TYPES.test(mime)) return c.json({ error: "unsupported_type" }, 415);
  const buf = new Uint8Array(await c.req.arrayBuffer());
  if (buf.length > env.maxFileBytes) return c.json({ error: "too_big" }, 413);
  const [owner] = await q<{ anon: unknown }>(`select "isAnonymous" as anon from "user" where id = $1`, [a.cv!.owner_id]);
  const { storageBytes } = await limitsFor({ id: a.cv!.owner_id, anonymous: !!owner?.anon });
  // The quota counts everything the canvas's owner keeps: images, drawing data and the trash.
  if (storageBytes) {
    const kept = (await usage([a.cv!.owner_id])).get(a.cv!.owner_id)!;
    if (totalOf(kept) + buf.length > storageBytes) return c.json({ error: "quota_storage" }, 507);
  }
  // The row is claimed before the bytes are stored: of two uploads of one new id at once, one stores, the other
  // answers as if it had.
  const [claimed] = await q(
    `insert into files (canvas_id, file_id, mime, size) values ($1, $2, $3, $4) on conflict do nothing returning file_id`,
    [a.cv!.id, fileId, mime, buf.length],
  );
  if (!claimed) return c.json({ ok: true });
  try {
    await storage.put(a.cv!.id, fileId, buf, mime);
  } catch (e) {
    await q(`delete from files where canvas_id = $1 and file_id = $2`, [a.cv!.id, fileId]);
    throw e;
  }
  hit("feature", "image added");
  return c.json({ ok: true });
});

app.get("/api/canvases/:id/files/:fileId", async (c) => {
  const u = await me(c);
  const a = await accessFor(c.req.param("id"), u, c.req.query("watch") !== undefined);
  if (a.role === "none") return accessError(c, a.error);
  const [f] = await q<{ mime: string }>(`select mime from files where canvas_id = $1 and file_id = $2`, [a.cv!.id, c.req.param("fileId")]);
  const bytes = f && IMAGE_TYPES.test(f.mime) ? await storage.get(a.cv!.id, c.req.param("fileId")) : null;
  if (!bytes) return c.notFound();
  return c.body(bytes as any, 200, {
    "content-type": f.mime,
    "cache-control": "private, max-age=31536000, immutable",
    // Opened directly, even an SVG cannot run anything.
    "content-security-policy": "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox",
  });
});

// ---------- moderation ----------
const admin = async (c: Context) => ((await me(c))?.admin ? true : false);

app.post("/api/admin/canvases/:id/unblock", async (c) => {
  if (!(await admin(c))) return c.json({ error: "admin_only" }, 403);
  await q(`update canvases set blocked_at = null where id = $1`, [c.req.param("id")]);
  return c.json({ ok: true });
});
app.post("/api/admin/canvases/:id/block", async (c) => {
  if (!(await admin(c))) return c.json({ error: "admin_only" }, 403);
  await q(`update canvases set blocked_at = now() where id = $1`, [c.req.param("id")]);
  rooms.get(c.req.param("id"))?.kick(4010, "blocked");
  return c.json({ ok: true });
});
app.delete("/api/admin/canvases/:id", async (c) => {
  if (!(await admin(c))) return c.json({ error: "admin_only" }, 403);
  await destroyCanvas(c.req.param("id"));
  return c.json({ ok: true });
});
app.get("/api/admin/canvases/:id", async (c) => {
  if (!(await admin(c))) return c.json({ error: "admin_only" }, 403);
  const [cv] = await q(
    `select c.id, c.title, c.link_access, c.live, c.blocked_at, c.deleted_at, u.name as owner_name, u.email as owner_email, u."isAnonymous" as owner_guest
       from canvases c join "user" u on u.id = c.owner_id where c.id = $1`,
    [c.req.param("id")],
  );
  if (!cv) return c.json({ error: "not_found" }, 404);
  return c.json({ ...cv, owner_email: cv.owner_guest ? null : cv.owner_email, owner_guest: !!cv.owner_guest });
});

adminRoutes(app, admin);
feedbackRoutes(app, admin);

// Things the browser alone sees, such as copying the agent prompt, counted for the admin dashboard.
const TRACKED = new Set(["copy agent prompt", "copy MCP setup", "copy canvas link", "download canvas", "export image"]);
app.post("/api/track", async (c) => {
  const what = String((await body(c)).what ?? "");
  if (TRACKED.has(what) && !limited("track:" + clientIp(c), 60, 60_000)) hit("feature", what);
  return c.body(null, 204);
});

app.delete("/api/admin/people/:id", async (c) => {
  if (!(await admin(c))) return c.json({ error: "admin_only" }, 403);
  await deleteUser(c.req.param("id"));
  return c.json({ ok: true });
});

// ---------- legal pages, from LEGAL_DIR ----------
app.get("/legal/:page", (c) => {
  const page = c.req.param("page");
  if (!legalPages().includes(page)) return c.notFound();
  const content = readFileSync(`${env.legalDir}/${page}.html`, "utf8");
  return c.html(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${env.appName}</title>
<style>body{font:16px/1.6 system-ui,sans-serif;max-width:720px;margin:40px auto;padding:0 16px;color:#1f1f1f;background:#fff}a{color:#b8460a}@media(prefers-color-scheme:dark){body{background:#141414;color:#ebe8e4}a{color:#f6a06b}}</style></head>
<body><p><a href="/">${env.appName}</a></p>${content}</body></html>`);
});

// ---------- the front end ----------
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

const TAGLINE = "Draw together. Send the link, that&#39;s it.";
// Link previews (Slack, WhatsApp, iMessage) read these tags. A private canvas shows nothing of itself.
// The generic image's address changes with its content, since link previews keep images for weeks.
const ogVersion = createHash("sha256")
  .update(assets.get("og.png")?.body ?? "")
  .digest("hex")
  .slice(0, 8);
async function previewTags(path: string) {
  let title = env.appName;
  let image = `${env.baseUrl}/og.png?v=${ogVersion}`;
  const m = path.match(/^\/c\/([\w-]{1,64})/);
  if (m) {
    const cv = await canvasRow(m[1]).catch(() => null);
    if (shareable(cv) && !isUntitled(cv!.title)) title = `${cv!.title} · ${env.appName}`;
    // The drawing's own image, its address changing with each new one so that previews are not stuck on an old one.
    if (shareable(cv) && cv!.card_at) image = `${env.baseUrl}/card/${cv!.id}?v=${toDate(cv!.card_at).getTime()}`;
  }
  const t = escapeHtml(title);
  const img = escapeHtml(image);
  return `<title>${t}</title>
<meta name="description" content="${TAGLINE}"><meta property="og:description" content="${TAGLINE}">
<meta property="og:title" content="${t}"><meta property="og:site_name" content="${escapeHtml(env.appName)}">
<meta property="og:url" content="${escapeHtml(env.baseUrl + path)}"><meta property="og:type" content="website">
<meta property="og:image" content="${img}"><meta property="og:image:type" content="image/png">
<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${t}"><meta name="twitter:image" content="${img}">`;
}

agents(app);
avatars(app);
routes(app, admin);

app.get("*", async (c) => {
  const file = assetResponse(c.req.path, c.req.header("accept-encoding"), c.req.header("range"));
  if (file) return file;
  // Programs look for metadata there, such as an MCP client for OAuth, which this server does not offer: they must
  // learn that nothing is there, in JSON, not get the app's page.
  if (c.req.path.startsWith("/.well-known/")) return c.json({ error: "not_found" }, 404);
  if (c.req.path.startsWith("/api/") || /\.\w{2,5}$/.test(c.req.path)) return c.notFound();
  noteVisit(c);
  const tags = await previewTags(c.req.path);
  const html = indexHtml().replace(/<title>[^<]*<\/title>/, () => tags);
  return c.html(html, 200, { "cache-control": "no-cache" });
});

export { getRoom };
export type { SessionUser };
