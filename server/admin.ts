// The admin dashboard's reads: the numbers, the people, the canvases and what is happening right now.
// Moderation (taking a canvas down, deleting a person) stays in app.ts.
import type { Context, Hono } from "hono";
import { q, toDate } from "./db.js";
import { rooms } from "./rooms.js";
import { agentSeats, dayOf, describeAgent, feedSince, lastHour, period, stats as numbers, visitorsSince } from "./stats.js";
import { overQuota, personUsage, quotaOf, storageOverview, totalOf, usage } from "./usage.js";
import { keySeat, linkSeat, seatsOf } from "./agents.js";
import { knownImage } from "./auth.js";

const iso = (v: unknown) => (v ? toDate(v).toISOString() : null);
const marks = (n: number, from = 1) => Array.from({ length: n }, (_, i) => `$${i + from}`).join(", ");

// Who is in a canvas now, by person id, for the "online" dots.
const onlineIds = () => new Set([...rooms.values()].flatMap((r) => [...r.clients].map((c) => c.user.id)));

// Whom each agent works for, when its counts say a guest a program made (a script or an agent's program that
// signed itself in to make agent links of its own): the owner of the canvas its link opens.
async function workingFor() {
  const owners = new Map<string, string>();
  for (const l of await q<{ token: string; owner: string }>(
    `select l.token, c.owner_id as owner from agent_links l join canvases c on c.id = l.canvas_id join "user" u on u.id = l.user_id
      where u."isProgram" = $1`,
    [true],
  ))
    owners.set(linkSeat(l.token), l.owner);
  return (user: string, seat: string) => owners.get(seat) ?? user;
}

// Agents with whose they are and what they are called: the key's name or the canvas of the agent link.
async function named(list: Awaited<ReturnType<typeof agentSeats>>) {
  const ids = [...new Set(list.map((a) => a.user))];
  const [labels, people] = await Promise.all([
    seatsOf(ids),
    ids.length
      ? q<{ id: string; name: string; email: string; image: string | null; anon: unknown }>(
          `select id, name, email, image, "isAnonymous" as anon from "user" where id in (${marks(ids.length)})`,
          ids,
        )
      : [],
  ]);
  const who = new Map(people.map((p) => [p.id, p]));
  return list.map((a) => {
    const p = who.get(a.user);
    const maker = labels.get(a.seat)?.maker;
    return {
      ...a,
      // A program that gave no name is called after the guest it made for its link.
      program: a.program === "Unnamed" && maker ? maker : a.program,
      maker,
      kind: a.seat.startsWith("agent-k") ? "key" : "link",
      label: labels.get(a.seat)?.label ?? null,
      lastUsed: labels.get(a.seat)?.lastUsed ?? null,
      person: p ? { id: p.id, name: p.name, email: p.anon ? null : p.email, image: knownImage(p.image, p.id), guest: !!p.anon } : null,
    };
  });
}

async function titles(ids: string[]) {
  const out: Record<string, string> = {};
  const unique = [...new Set(ids)].slice(0, 500);
  if (unique.length)
    for (const r of await q<{ id: string; title: string }>(`select id, title from canvases where id in (${marks(unique.length)})`, unique))
      out[r.id] = r.title;
  return out;
}

export function adminRoutes(app: Hono, admin: (c: Context) => Promise<boolean>) {
  const only = (run: (c: Context) => Promise<Response>) => async (c: Context) =>
    (await admin(c)) ? run(c) : c.json({ error: "admin_only" }, 403);

  // The numbers of a period, with what is stored on the server and the busiest agents.
  const stats = async (from: string, to: string, compare: boolean) => ({
    ...(await numbers(from, to, compare)),
    stored: [...(await usage()).values()].reduce((n, u) => n + totalOf(u), 0),
    agents: await named((await agentSeats(from, to, undefined, await workingFor())).slice(0, 12)),
  });
  app.get(
    "/api/admin/stats",
    // ?days=30 (the last 30 days, against the 30 before), ?from=…&to=… (against as many days before), or ?all=1.
    only(async (c) => {
      const { from, to, compare } = await period(c);
      return c.json(await stats(from, to, compare));
    }),
  );

  // Right now: who is in which canvas, visitors of the last five minutes, and what just happened.
  app.get(
    "/api/admin/live",
    only(async (c) => {
      const now = Date.now();
      const open = [...rooms.values()].filter((r) => r.clients.size || r.agents.size);
      const feed = feedSince(Number(c.req.query("since")) || 0);
      const names = await titles([...open.map((r) => r.canvasId), ...feed.flatMap((e) => (e.canvas ? [e.canvas] : []))]);
      const pages: Record<string, number> = {};
      const recent = visitorsSince(5 * 60_000);
      for (const v of recent) pages[v.page] = (pages[v.page] ?? 0) + 1;
      return c.json({
        at: now,
        visitors: recent.length,
        pages,
        minutes: lastHour(),
        rooms: open
          .map((r) => ({
            id: r.canvasId,
            title: names[r.canvasId] ?? "",
            shapes: r.liveCount(),
            people: [...r.clients].map((p) => ({
              id: p.user.id,
              name: p.presence?.name ?? p.user.name,
              guest: !!p.user.anonymous,
              role: p.role,
              since: p.joined,
              idle: now - p.last > 10 * 60_000,
            })),
            agents: [...r.agents.values()].map((a) => ({ name: a.name, idle: a.state === "idle" })),
          }))
          .sort((a, b) => b.people.length + b.agents.length - (a.people.length + a.agents.length)),
        feed: feed.map((e) => ({ ...e, title: e.canvas ? (names[e.canvas] ?? "") : undefined })),
      });
    }),
  );

  // Everyone, the accounts or the guests, searched by name or email, 50 at a time; or only the people over 60%
  // of their storage quota, or with agents. Each with what they keep and their agents' last 30 days.
  const SORTS: Record<string, string> = {
    name: `lower(u.name)`,
    created: `u."createdAt"`,
    active: `last_day`,
    days: `active_days`,
    canvases: `canvases`,
    shapes: `shapes`,
    storage: `stored`,
    agents: `calls`,
  };
  // A column and a direction, then the newest first among equals.
  const order = (sorts: Record<string, string>, c: Context, fallback: string, tie: string) => {
    const dir = c.req.query("dir") === "asc" ? "asc" : "desc";
    return `${sorts[c.req.query("sort") ?? ""] ?? sorts[fallback]} ${dir} nulls last, ${tie} desc`;
  };
  app.get(
    "/api/admin/users",
    only(async (c) => {
      const who = c.req.query("who");
      const filter = c.req.query("filter");
      const offset = Math.max(0, Number(c.req.query("offset")) || 0);
      const today = dayOf(new Date());
      const month = dayOf(new Date(Date.now() - 29 * 86_400_000));
      const params: unknown[] = [`%${(c.req.query("q") ?? "").trim().toLowerCase()}%`];
      const p = (v: unknown) => `$${params.push(v)}`;
      // People only: a guest a program made is folded into the people its agents work for.
      const conds = [`(lower(u.email) like $1 or lower(u.name) like $1)`, `u."isProgram" = ${p(false)}`];
      if (who === "accounts" || who === "guests") conds.push(`coalesce(u."isAnonymous", ${p(false)}) = ${p(who === "guests")}`);
      // Their agents: their keys and links, and the links programs made to their canvases.
      const programLinks = `select 1 from agent_links l join canvases c on c.id = l.canvas_id join "user" g on g.id = l.user_id
        where c.owner_id = u.id and g."isProgram"`;
      if (filter === "agents")
        conds.push(
          `(exists (select 1 from api_keys k where k.user_id = u.id) or exists (select 1 from agent_links l where l.user_id = u.id)
            or exists (${programLinks}))`,
        );
      if (filter === "quota") {
        const over = await overQuota(0.6);
        conds.push(over.length ? `u.id in (${over.map(p).join(", ")})` : `1 = 0`);
      }
      const where = conds.join(" and ");
      const [{ n }] = await q<{ n: string }>(`select count(*) as n from "user" u where ${where}`, params);
      const rows = await q<any>(
        `select u.id, u.name, u.email, u.image, u."createdAt" as created, u."isAdmin" as admin, u."emailVerified" as verified,
            u."isAnonymous" as anon,
            (select max(a.day) from activity a where a.user_id = u.id) as last_day,
            (select count(*) from activity a where a.user_id = u.id) as active_days,
            (select count(*) from canvases c where c.owner_id = u.id and c.deleted_at is null) as canvases,
            (select coalesce(sum(c.live), 0) from canvases c where c.owner_id = u.id and c.deleted_at is null) as shapes,
            (select count(*) from api_keys k where k.user_id = u.id) as keys,
            (select count(*) from agent_links l where l.user_id = u.id) + (select count(*) from (${programLinks}) x) as links,
            (select coalesce(sum(c.bytes), 0) from canvases c where c.owner_id = u.id)
              + (select coalesce(sum(f.size), 0) from files f join canvases c on c.id = f.canvas_id where c.owner_id = u.id) as stored,
            (select coalesce(sum(h.n), 0) from hits h where h.metric = 'agent_seat' and h.day >= ${p(month)} and h.who like u.id || '|%') as calls
           from "user" u where ${where}
          order by ${order(SORTS, c, "storage", `u."createdAt"`)} limit 50 offset ${p(offset)}`,
        params,
      );
      const ids = rows.map((r) => r.id);
      const [held, seats, quotas] = await Promise.all([
        usage(ids),
        agentSeats(month, today, ids, await workingFor()),
        Promise.all(rows.map((r) => quotaOf(r.id, !!r.anon))),
      ]);
      const providers: Record<string, string[]> = {};
      if (rows.length)
        for (const r of await q<{ userId: string; providerId: string }>(
          `select "userId", "providerId" from account where "userId" in (${marks(rows.length)})`,
          ids,
        ))
          (providers[r.userId] ??= []).push(r.providerId);
      // The last 30 days of each, for the table's little strip: -1 nothing, 0 opened a canvas, n shapes drawn.
      const strip: Record<string, number[]> = {};
      const slot = (d: string) => Math.round((Date.parse(d) - Date.parse(month)) / 86_400_000);
      if (rows.length) {
        for (const id of ids) strip[id] = Array(30).fill(-1);
        for (const r of await q<{ day: string; user_id: string }>(
          `select day, user_id from activity where day >= $1 and user_id in (${marks(ids.length, 2)})`,
          [month, ...ids],
        ))
          strip[r.user_id][slot(r.day)] = Math.max(0, strip[r.user_id][slot(r.day)]);
        for (const r of await q<{ day: string; who: string; n: string }>(
          `select day, who, n from hits where metric = 'drawer' and day >= $1 and who in (${marks(ids.length, 2)})`,
          [month, ...ids],
        ))
          strip[r.who][slot(r.day)] = Number(r.n);
      }
      const online = onlineIds();
      return c.json({
        total: Number(n),
        users: rows.map((r, i) => {
          const u = held.get(r.id)!;
          const mine = seats.filter((a) => a.user === r.id);
          return {
            days: strip[r.id],
            id: r.id,
            name: r.name,
            email: r.anon ? null : r.email,
            guest: !!r.anon,
            image: knownImage(r.image, r.id),
            created: iso(r.created),
            admin: !!r.admin,
            lastActive: r.last_day ?? null,
            activeDays: Number(r.active_days),
            canvases: Number(r.canvases),
            shapes: Number(r.shapes),
            keys: Number(r.keys),
            links: Number(r.links),
            methods: methodsOf(providers[r.id] ?? []),
            online: online.has(r.id),
            storage: { ...u, total: totalOf(u), quota: quotas[i] },
            agents: {
              count: mine.length,
              calls: mine.reduce((n, a) => n + a.calls, 0),
              programs: [...new Set(mine.map((a) => a.program))],
              daily: Array.from({ length: 30 }, (_, d) => mine.reduce((n, a) => n + (a.daily[d] ?? 0), 0)),
            },
          };
        }),
      });
    }),
  );

  // Above the list of people: what everyone keeps, who holds it, and their agents' calls each day.
  app.get(
    "/api/admin/people-summary",
    only(async (c) => {
      const today = dayOf(new Date());
      const month = dayOf(new Date(Date.now() - 29 * 86_400_000));
      const calls = Array<number>(30).fill(0);
      for (const r of await q<{ day: string; n: string }>(
        `select day, sum(n) as n from hits where metric = 'agent' and day >= $1 group by day`,
        [month],
      ))
        calls[Math.round((Date.parse(r.day) - Date.parse(month)) / 86_400_000)] += Number(r.n);
      const s = await storageOverview();
      return c.json({
        from: month,
        calls,
        storage: { kinds: s.kinds, holders: s.holders, curve: s.curve, top: s.top.map((p) => ({ name: p.name, total: p.total })) },
      });
    }),
  );

  // One person: how they sign in, their devices, canvases (the biggest first), what they keep, their activity
  // and their agents.
  app.get(
    "/api/admin/users/:id",
    only(async (c) => {
      const id = c.req.param("id");
      const [u] = await q<any>(
        `select id, name, email, image, "createdAt" as created, "isAnonymous" as anon, "isAdmin" as admin, "isProgram" as program,
            "emailVerified" as verified from "user" where id = $1`,
        [id],
      );
      if (!u) return c.json({ error: "not_found" }, 404);
      const today = dayOf(new Date());
      const month = dayOf(new Date(Date.now() - 29 * 86_400_000));
      const [providers, sessions, owned, shared, days, drawn, keys, links, storage, agents] = await Promise.all([
        q<{ providerId: string }>(`select "providerId" from account where "userId" = $1`, [id]),
        q<any>(
          `select "createdAt" as created, "updatedAt" as updated, "expiresAt" as expires, "ipAddress" as ip, "userAgent" as ua from "session" where "userId" = $1 order by "updatedAt" desc`,
          [id],
        ),
        q<any>(
          `select id, title, live, link_access, created_at, updated_at, deleted_at, blocked_at, bytes,
              (select count(*) from canvas_access x where x.canvas_id = canvases.id and x.user_id <> canvases.owner_id) as members,
              (select coalesce(sum(f.size), 0) from files f where f.canvas_id = canvases.id) as images,
              (select count(*) from files f where f.canvas_id = canvases.id) as files
             from canvases where owner_id = $1
            order by bytes + (select coalesce(sum(f.size), 0) from files f where f.canvas_id = canvases.id) desc, updated_at desc limit 200`,
          [id],
        ),
        q<any>(
          `select c.id, c.title, c.live, x.role, o.name as owner from canvas_access x join canvases c on c.id = x.canvas_id join "user" o on o.id = c.owner_id
            where x.user_id = $1 and c.owner_id <> $1 and c.deleted_at is null order by c.updated_at desc limit 100`,
          [id],
        ),
        q<{ day: string }>(`select day from activity where user_id = $1 order by day`, [id]),
        q<{ day: string; n: string }>(`select day, n from hits where metric = 'drawer' and who = $1 order by day`, [id]),
        q<any>(`select id, name, created_at, last_used_at from api_keys where user_id = $1 order by created_at`, [id]),
        q<any>(
          `select l.token, l.user_id, g.name as by, l.canvas_id, c.title, l.created_at, l.last_used_at
             from agent_links l join canvases c on c.id = l.canvas_id join "user" g on g.id = l.user_id
            where l.user_id = $1 or (c.owner_id = $1 and g."isProgram" = $2) order by l.created_at desc`,
          [id, true],
        ),
        personUsage(u.id, !!u.anon),
        workingFor()
          .then((w) => agentSeats(month, today, [u.id], w))
          .then(named),
      ]);
      const here = [...rooms.values()].filter((r) => [...r.clients].some((x) => x.user.id === id)).map((r) => r.canvasId);
      const names = await titles(here);
      return c.json({
        id: u.id,
        name: u.name,
        email: u.anon ? null : u.email,
        image: knownImage(u.image, u.id),
        guest: !!u.anon,
        admin: !!u.admin,
        program: !!u.program,
        verified: !!u.verified,
        created: iso(u.created),
        methods: methodsOf(providers.map((p) => p.providerId)),
        storage,
        agents: agents.map(({ person: _, user: __, ...a }) => a),
        online: here.map((cid) => ({ id: cid, title: names[cid] ?? "" })),
        sessions: sessions.map((s) => ({
          created: iso(s.created),
          updated: iso(s.updated),
          expires: iso(s.expires),
          ip: s.ip ?? null,
          device: s.ua ? describeAgent(s.ua) : null,
          expired: toDate(s.expires) < new Date(),
        })),
        canvases: owned.map((r) => ({
          id: r.id,
          title: r.title,
          shapes: Number(r.live),
          access: r.link_access,
          members: Number(r.members),
          created: iso(r.created_at),
          updated: iso(r.updated_at),
          deleted: !!r.deleted_at,
          blocked: !!r.blocked_at,
          data: Number(r.bytes),
          images: Number(r.images),
          files: Number(r.files),
        })),
        shared: shared.map((r) => ({ id: r.id, title: r.title, shapes: Number(r.live), role: r.role, owner: r.owner })),
        activeDays: days.map((d) => d.day),
        drawn: drawn.map((d) => ({ day: d.day, n: Number(d.n) })),
        // Seats, not tokens: an agent link's token is its secret.
        keys: keys.map((k) => ({ seat: keySeat(k.id), name: k.name, created: iso(k.created_at), lastUsed: iso(k.last_used_at) })),
        links: links.map((l) => ({
          seat: linkSeat(l.token),
          by: l.user_id === u.id ? null : l.by,
          canvas: l.canvas_id,
          title: l.title,
          created: iso(l.created_at),
          lastUsed: iso(l.last_used_at),
        })),
      });
    }),
  );

  // Signs a person out of every device.
  app.delete(
    "/api/admin/users/:id/sessions",
    only(async (c) => {
      await q(`delete from "session" where "userId" = $1`, [c.req.param("id")]);
      return c.json({ ok: true });
    }),
  );

  // Every canvas, searched by title, address or owner's email, 50 at a time.
  const CANVAS_SORTS: Record<string, string> = {
    title: "lower(c.title)",
    owner: "lower(u.email)",
    updated: "c.updated_at",
    created: "c.created_at",
    shapes: "c.live",
    members: "members",
    images: "images",
  };
  app.get(
    "/api/admin/canvases",
    only(async (c) => {
      const text = (c.req.query("q") ?? "").trim();
      const id = text.match(/\/c\/([\w-]+)/)?.[1] ?? text;
      const like = `%${text.toLowerCase()}%`;
      const offset = Math.max(0, Number(c.req.query("offset")) || 0);
      const where = `(c.id = $1 or lower(c.title) like $2 or lower(u.email) like $2)`;
      const rows = await q<any>(
        `select c.id, c.title, c.live, c.link_access, c.created_at, c.updated_at, c.deleted_at, c.blocked_at,
            u.id as owner_id, u.name as owner_name, u.email as owner_email, u."isAnonymous" as owner_guest,
            (select count(*) from canvas_access x where x.canvas_id = c.id and x.user_id <> c.owner_id) as members,
            (select count(*) from files f where f.canvas_id = c.id) as images
           from canvases c join "user" u on u.id = c.owner_id where ${where}
          order by ${order(CANVAS_SORTS, c, "updated", "c.updated_at")} limit 50 offset $3`,
        [id, like, offset],
      );
      const [{ n }] = await q<{ n: string }>(`select count(*) as n from canvases c join "user" u on u.id = c.owner_id where ${where}`, [
        id,
        like,
      ]);
      return c.json({
        total: Number(n),
        canvases: rows.map((r) => {
          const room = rooms.get(r.id);
          return {
            id: r.id,
            title: r.title,
            shapes: room ? room.liveCount() : Number(r.live),
            access: r.link_access,
            created: iso(r.created_at),
            updated: iso(r.updated_at),
            deleted: !!r.deleted_at,
            blocked: !!r.blocked_at,
            members: Number(r.members),
            images: Number(r.images),
            owner: { id: r.owner_id, name: r.owner_name, email: r.owner_guest ? null : r.owner_email, guest: !!r.owner_guest },
            here: room ? room.clients.size + room.agents.size : 0,
          };
        }),
      });
    }),
  );
}

// How an account signs in, from its linked providers. No provider at all means email links only.
function methodsOf(providers: string[]) {
  const out = providers.map((p) => (p === "credential" ? "Password" : p === "google" ? "Google" : p === "oidc" ? "Company sign-in" : p));
  return out.length && !out.every((m) => m === "Password") ? out : ["Email link", ...out];
}
