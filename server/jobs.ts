// Housekeeping, run every hour: empty canvases nobody came back to, deleted canvases past their undo
// window, guests' canvases past their lifetime, guests who own nothing and were not seen for a month, images no element uses any more.
// Then today's figure of what each person keeps, for the admin's storage charts.
import { env } from "./env.js";
import { q, sqlTime, toDate } from "./db.js";
import { rooms } from "./rooms.js";
import { storage } from "./storage.js";
import { destroyCanvas, isUntitled } from "./canvases.js";
import { emit } from "./extend.js";
import { dayOf } from "./stats.js";
import { recordUsage } from "./usage.js";

export function startJobs() {
  const run = () => purge().catch((e) => console.error("purge:", e?.message ?? e));
  setTimeout(run, Math.min(60_000, env.purge.everyMs)).unref();
  setInterval(run, env.purge.everyMs).unref();
  setInterval(() => expire().catch((e) => console.error("expire:", e?.message ?? e)), 60_000).unref();
}

// A guest's canvases past their lifetime (GUEST_CANVAS_HOURS): gone for good, whoever has them open.
export async function expire() {
  for (const c of await q<{ id: string }>(`select id from canvases where expires_at < $1`, [sqlTime(new Date())])) await destroyCanvas(c.id);
}

const age = (v: unknown) => Date.now() - toDate(v).getTime();

export async function purge() {
  let canvases = 0,
    guests = 0,
    files = 0;

  for (const c of await q<{ id: string; title: string; updated_at: unknown }>(
    `select id, title, updated_at from canvases where live = 0 and deleted_at is null`,
  ))
    if (isUntitled(c.title) && !rooms.has(c.id) && age(c.updated_at) > env.purge.emptyAfterMs) {
      await destroyCanvas(c.id);
      canvases++;
    }

  for (const c of await q<{ id: string; deleted_at: unknown }>(`select id, deleted_at from canvases where deleted_at is not null`))
    if (age(c.deleted_at) > env.purge.deletedAfterMs) {
      await destroyCanvas(c.id);
      canvases++;
    }

  const idle = await q<{ id: string; seen: unknown; created: unknown }>(
    `select u.id, max(s."updatedAt") as seen, u."createdAt" as created
       from "user" u left join "session" s on s."userId" = u.id
      where u."isAnonymous" = $1 and not exists (select 1 from canvases c where c.owner_id = u.id)
      group by u.id, u."createdAt"`,
    [true],
  );
  for (const g of idle)
    if (age(g.seen ?? g.created) > env.purge.guestAfterMs) {
      await q(`delete from "user" where id = $1`, [g.id]);
      // Extensions hear of it as of any deleted person, one at a time, so that a long list does not pile up.
      await emit("userDeleted", { id: g.id });
      guests++;
    }

  // Expired sessions (they hold an IP address and a browser name) are of no use to anyone.
  let sessions = 0;
  for (const s of await q<{ id: string; expires: unknown }>(`select id, "expiresAt" as expires from "session"`))
    if (age(s.expires) > 0) {
      await q(`delete from "session" where id = $1`, [s.id]);
      sessions++;
    }

  await q(`delete from activity where day < $1`, [dayOf(new Date(Date.now() - 90 * 86_400_000))]);

  // An image stays while any element refers to it, deleted ones included: undo can bring them back.
  const byCanvas = new Map<string, { file_id: string; created_at: unknown }[]>();
  for (const f of await q<{ canvas_id: string; file_id: string; created_at: unknown }>(`select canvas_id, file_id, created_at from files`))
    if (age(f.created_at) > 86_400_000) byCanvas.set(f.canvas_id, [...(byCanvas.get(f.canvas_id) ?? []), f]);
  for (const [canvasId, list] of byCanvas) {
    const used = new Set<string>();
    const room = rooms.get(canvasId);
    if (room)
      for (const e of room.elements.values()) {
        if (e.fileId) used.add(e.fileId);
      }
    else
      for (const r of await q<{ file_id: string }>(
        `select data->>'fileId' as file_id from elements where canvas_id = $1 and data->>'type' = 'image'`,
        [canvasId],
      ))
        used.add(r.file_id);
    for (const f of list)
      if (!used.has(f.file_id)) {
        await storage.remove(canvasId, f.file_id).catch(() => {});
        await q(`delete from files where canvas_id = $1 and file_id = $2`, [canvasId, f.file_id]);
        files++;
      }
  }
  if (canvases || guests || files || sessions)
    console.log(`purge: ${canvases} canvases, ${guests} guests, ${files} images, ${sessions} expired sessions removed`);
  await recordUsage();
  return { canvases, guests, files, sessions };
}
