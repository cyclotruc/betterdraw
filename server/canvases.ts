// Who may do what on a canvas, and how canvases leave for good.
import { randomBytes } from "node:crypto";
import { q, sqlTime } from "./db.js";
import { env } from "./env.js";
import { limitsFor } from "./extend.js";
import { storage } from "./storage.js";
import { rooms, type Role } from "./rooms.js";

export type CanvasRow = {
  id: string;
  owner_id: string;
  title: string;
  link_access: "edit" | "view" | "none";
  deleted_at: unknown;
  blocked_at: unknown;
  live: number;
  // What the canvas keeps besides its shapes: so far, its background color.
  app_state: { viewBackgroundColor?: string } | null;
  updated_at: unknown;
  card_at: unknown; // when the link preview image was last drawn
};
export type Viewer = { id: string; admin?: boolean } | null;

export const isUntitled = (t: string | null | undefined) => !t;
export const canEdit = (r: Role) => r === "owner" || r === "editor";

export async function canvasRow(id: string): Promise<CanvasRow | null> {
  if (!/^[\w-]{1,64}$/.test(id)) return null;
  const [cv] = await q<CanvasRow>(
    `select id, owner_id, title, link_access, deleted_at, blocked_at, live, app_state, updated_at, card_at from canvases where id = $1`,
    [id],
  );
  return cv ?? null;
}

// The role of `user` on canvas `id`. Opening a shared canvas through its URL records a seat, so the
// canvas shows up in that person's sidebar under "Shared with me". A seat given any other way (via_link
// false) keeps its own role; one recorded through the URL gives what the URL gives now, whatever it gave
// when it was recorded.
export async function access(
  id: string,
  user: Viewer,
): Promise<{ cv: CanvasRow | null; role: Role; error?: "not_found" | "blocked" | "private" }> {
  const cv = await canvasRow(id);
  if (!cv || cv.deleted_at) return { cv: null, role: "none", error: "not_found" };
  if (cv.blocked_at) return user?.admin ? { cv, role: "viewer" } : { cv, role: "none", error: "blocked" };
  if (user && user.id === cv.owner_id) return { cv, role: "owner" };
  let seated = false;
  if (user) {
    const [a] = await q<{ role: Role; via_link: unknown }>(
      `select role, via_link from canvas_access where canvas_id = $1 and user_id = $2`,
      [id, user.id],
    );
    if (a && !a.via_link) return { cv, role: a.role };
    seated = !!a;
  }
  const viaLink: Role = cv.link_access === "edit" ? "editor" : cv.link_access === "view" ? "viewer" : "none";
  if (viaLink === "none") return { cv, role: "none", error: "private" };
  if (user && !seated)
    await q(`insert into canvas_access (canvas_id, user_id, role, via_link) values ($1, $2, $3, $4) on conflict do nothing`, [
      id,
      user.id,
      viaLink,
      true,
    ]);
  return { cv, role: viaLink };
}

// An admin watching a canvas, unseen: read-only whatever the canvas's sharing, and no seat recorded.
export async function watchAccess(id: string, user: Viewer): ReturnType<typeof access> {
  if (!user?.admin) return { cv: null, role: "none", error: "private" };
  const cv = await canvasRow(id);
  if (!cv || cv.deleted_at) return { cv: null, role: "none", error: "not_found" };
  return { cv, role: "viewer" };
}
// What a request asks for: unseen watching (?watch, admins only) or the usual access.
export const accessFor = (id: string, user: Viewer, watch: boolean) => (watch && user?.admin ? watchAccess(id, user) : access(id, user));

// Whether `user` already owns as many canvases as they may: creating one and restoring one from the trash both ask.
export async function atCanvasLimit(user: { id: string; anonymous: boolean }) {
  const { canvases } = await limitsFor(user);
  if (!canvases) return false;
  const [{ n }] = await q<{ n: string }>(`select count(*) as n from canvases where owner_id = $1 and deleted_at is null`, [user.id]);
  return Number(n) >= canvases;
}

// A new canvas for `user`, within their limits. Its id is the secret: 22 url-safe random characters.
export async function createCanvas(user: { id: string; anonymous: boolean }, title?: unknown): Promise<{ id: string } | { error: string }> {
  if (env.signup === "closed" && user.anonymous) return { error: "signup_closed" };
  if (await atCanvasLimit(user)) return { error: "quota_canvases" };
  const id = randomBytes(16).toString("base64url");
  await q(`insert into canvases (id, owner_id, title, expires_at) values ($1, $2, $3, $4)`, [
    id,
    user.id,
    typeof title === "string" ? title.slice(0, 200) : "",
    // A guest's canvas lasts GUEST_CANVAS_HOURS from its creation; making an account keeps it.
    user.anonymous && env.guestCanvasHours > 0 ? sqlTime(new Date(Date.now() + env.guestCanvasHours * 3_600_000)) : null,
  ]);
  return { id };
}

// Hard delete: connections, images, rows. Soft deletion (the undo window) is only a deleted_at date.
export async function destroyCanvas(id: string) {
  const room = rooms.get(id);
  room?.kick(4004, "deleted");
  room?.dispose();
  await storage.removeCanvas(id).catch((e) => console.error(`canvas ${id}: could not remove images: ${e.message}`));
  await q(`delete from canvases where id = $1`, [id]);
}
