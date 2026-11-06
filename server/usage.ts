// What each person keeps on the server, for the admin's storage charts and the storage quotas: the images on their
// canvases, the drawing data (each canvas's elements as JSON, `canvases.bytes`) and what is in their trash
// (both, for the canvases they deleted). Read live, and recorded every hour as the day's figure
// (`storage_days`, a year of days) to show how it grew.
import { q, tx } from "./db.js";
import { limitsFor } from "./extend.js";
import { dayOf } from "./stats.js";

export type Usage = { images: number; data: number; trash: number };
const KINDS = ["images", "data", "trash"] as const;
const DAY = 86_400_000;
export const totalOf = (u: Usage) => u.images + u.data + u.trash;

// Everyone who keeps anything, or these people, each of them even with nothing.
export async function usage(ids?: string[]) {
  const out = new Map<string, Usage>();
  const of = (id: string) => {
    if (!out.has(id)) out.set(id, { images: 0, data: 0, trash: 0 });
    return out.get(id)!;
  };
  ids?.forEach(of);
  if (ids && !ids.length) return out;
  const only = (col: string) => (ids ? `where ${col} in (${ids.map((_, i) => `$${i + 1}`).join(", ")})` : "");
  const [canvases, images] = await Promise.all([
    q<{ id: string; live: string; trash: string }>(
      `select owner_id as id, sum(case when deleted_at is null then bytes else 0 end) as live,
          sum(case when deleted_at is null then 0 else bytes end) as trash
         from canvases ${only("owner_id")} group by owner_id`,
      ids,
    ),
    q<{ id: string; live: string; trash: string }>(
      `select c.owner_id as id, sum(case when c.deleted_at is null then f.size else 0 end) as live,
          sum(case when c.deleted_at is null then 0 else f.size end) as trash
         from files f join canvases c on c.id = f.canvas_id ${only("c.owner_id")} group by c.owner_id`,
      ids,
    ),
  ]);
  for (const r of canvases) {
    const u = of(r.id);
    u.data += Number(r.live);
    u.trash += Number(r.trash);
  }
  for (const r of images) {
    const u = of(r.id);
    u.images += Number(r.live);
    u.trash += Number(r.trash);
  }
  if (!ids) for (const [id, u] of out) if (!totalOf(u)) out.delete(id);
  return out;
}

// The people whose quota counts at least this share of it (0.6 for 60%).
export async function overQuota(share: number) {
  const held = await usage();
  if (!held.size) return [];
  const guests = new Set(
    (
      await q<{ id: string }>(
        `select u.id from "user" u where u."isAnonymous" = $1 and exists (select 1 from canvases c where c.owner_id = u.id)`,
        [true],
      )
    ).map((r) => r.id),
  );
  const out: string[] = [];
  for (const [id, u] of held) {
    const quota = await quotaOf(id, guests.has(id));
    if (quota && totalOf(u) >= quota * share) out.push(id);
  }
  return out;
}

// What the storage quota allows someone, 0 for no limit.
export const quotaOf = async (id: string, guest: boolean) => (await limitsFor({ id, anonymous: guest })).storageBytes;

// Today's figure for everyone who keeps anything, replaced every hour.
export async function recordUsage() {
  const day = dayOf(new Date());
  const rows = [...(await usage())];
  await tx(async (t) => {
    await t(`delete from storage_days where day = $1`, [day]);
    for (let i = 0; i < rows.length; i += 200) {
      const part = rows.slice(i, i + 200);
      await t(
        `insert into storage_days (day, user_id, images, data, trash)
           values ${part.map((_, j) => `($1, ${[2, 3, 4, 5].map((k) => `$${j * 4 + k}`).join(", ")})`).join(", ")}`,
        [day, ...part.flatMap(([id, u]) => [id, u.images, u.data, u.trash])],
      );
    }
  });
  await q(`delete from storage_days where day < $1`, [dayOf(new Date(Date.now() - 366 * DAY))]);
}

// One person's: what they keep now against their quota, and at the end of each of the last 90 days.
export async function personUsage(id: string, guest: boolean) {
  const u = (await usage([id])).get(id)!;
  const today = dayOf(new Date());
  const days = (
    await q<Record<"day" | (typeof KINDS)[number], string>>(
      `select day, images, data, trash from storage_days where user_id = $1 and day >= $2 and day < $3 order by day`,
      [id, dayOf(new Date(Date.now() - 89 * DAY)), today],
    )
  ).map((r) => ({ day: r.day, images: Number(r.images), data: Number(r.data), trash: Number(r.trash) }));
  days.push({ day: today, images: u.images, data: u.data, trash: u.trash });
  return { ...u, total: totalOf(u), quota: await quotaOf(id, guest), days };
}

// Above the list of people: what everyone keeps now, by kind, how many keep anything, and how concentrated it
// is: after the k biggest, the share of everything that they hold, each of the first 30 (they have names), then
// at most about a hundred points.
export async function storageOverview() {
  const now = await usage();
  const kinds: Usage = { images: 0, data: 0, trash: 0 };
  for (const u of now.values()) for (const k of KINDS) kinds[k] += u[k];
  const who = new Map(
    (
      await q<{ id: string; name: string; program: unknown }>(
        `select u.id, u.name, u."isProgram" as program from "user" u where exists (select 1 from canvases c where c.owner_id = u.id)`,
      )
    ).map((r) => [r.id, r]),
  );
  // People only: the guests that programs made are left out.
  const people = [...now]
    .filter(([id]) => !who.get(id)?.program)
    .map(([id, u]) => ({ name: who.get(id)?.name ?? "", total: totalOf(u) }))
    .sort((a, b) => b.total - a.total);
  const all = people.reduce((n, p) => n + p.total, 0);
  const step = Math.max(1, Math.ceil(people.length / 100));
  let held = 0;
  const curve = people.map((p, i) => [i + 1, (held += p.total) / all]).filter(([k]) => k <= 30 || k % step === 0 || k === people.length);
  return { kinds, holders: people.length, curve, top: people.slice(0, 30) };
}
