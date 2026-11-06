// Home-made analytics for the admin dashboard. Nothing leaves the server, and nothing here touches the
// database on the way of a drawing: counters add up in memory and are written every 30 seconds.
//   activity: one row per person and day they opened a canvas.
//   hits: one row per day, metric and key (a visitor, an hour, a shape type, an agent…) with a count.
// activity is kept 90 days, hits for good so that "All" covers everything. The live feed and who is on the
// site now live in memory only.
import { createHash } from "node:crypto";
import type { Context } from "hono";
import { q, sqlTime, toDate } from "./db.js";
import { env } from "./env.js";
import { rooms } from "./rooms.js";
import { clientIp } from "./security.js";
import { emit, extensions } from "./extend.js";

const DAY = 86_400_000;
export const dayOf = (d: Date) => d.toISOString().slice(0, 10);

let today = "";
let seen = new Set<string>();
export function noteActivity(userId: string) {
  const day = dayOf(new Date());
  if (day !== today) [today, seen] = [day, new Set()];
  if (seen.has(userId)) return;
  seen.add(userId);
  q(`insert into activity (day, user_id) values ($1, $2) on conflict do nothing`, [day, userId]).catch(() => seen.delete(userId));
}

// ---------- counters ----------
export type Metric =
  | "visit" // a visitor (a hash that changes daily) with what they came with, counting page loads:
  // "hash|Phone|iOS|Safari", then the tags of extensions (VISIT_FIELDS)
  | "hour" // page loads per UTC hour
  | "shape" // shapes people drew, by type
  | "agent_shape" // shapes agents drew, by type
  | "drawer" // a person who drew, counting shapes
  | "edits" // changes to shapes, by people or agents
  | "canvas" // canvases created by a person, a guest or an agent
  | "guest" // guest sessions started
  | "convert" // guests who made an account
  | "agent" // an agent seat, counting calls
  | "agent_flow" // an operation with its program and how it came: "Claude Code|MCP|put_elements"
  | "agent_seat" // each agent's calls, with whose it is, how it came and its program: "user|seat|MCP|Cursor"
  | "agent_seat_shapes" // the shapes each agent drew
  | "agent_seat_canvas" // each agent's operations on a canvas: "seat|canvas"
  | "feature"; // product features people used

// Extensions count metrics of their own too. Counts wait keyed by [day, metric, who] as JSON, which holds any text;
// control characters, which a database may refuse, become spaces.
const pending = new Map<string, number>();
export function hit(metric: Metric | (string & {}), who: string, n = 1) {
  const key = JSON.stringify([dayOf(new Date()), metric, who.replace(/\p{Cc}/gu, " ").slice(0, 120)]);
  pending.set(key, (pending.get(key) ?? 0) + n);
  const m = MINUTE_OF[metric as Metric];
  if (m) minute()[m] += n;
}

// The last hour, minute by minute, for the live charts: kept in memory only.
type Minute = { at: number; visits: number; shapes: number; agentCalls: number; edits: number; people: number };
const MINUTE_OF: Partial<Record<Metric, Exclude<keyof Minute, "at" | "people">>> = {
  visit: "visits",
  shape: "shapes",
  agent_shape: "shapes",
  agent: "agentCalls",
  edits: "edits",
};
const minutes: Minute[] = [];
function minute() {
  const at = Math.floor(Date.now() / 60_000) * 60_000;
  let last = minutes[minutes.length - 1];
  if (!last || last.at !== at) {
    while (last && last.at + 60_000 < at)
      minutes.push((last = { at: last.at + 60_000, visits: 0, shapes: 0, agentCalls: 0, edits: 0, people: last.people }));
    minutes.push((last = { at, visits: 0, shapes: 0, agentCalls: 0, edits: 0, people: 0 }));
    if (minutes.length > 60) minutes.splice(0, minutes.length - 60);
  }
  return last;
}
// How many people are in canvases, sampled every 10 seconds; each minute keeps its highest.
setInterval(() => {
  const m = minute();
  m.people = Math.max(
    m.people,
    [...rooms.values()].reduce((n, r) => n + r.clients.size, 0),
  );
}, 10_000).unref();
export function lastHour() {
  const now = minute();
  const at = new Map(minutes.map((m) => [m.at, m]));
  return Array.from({ length: 60 }, (_, i) => {
    const t = now.at - (59 - i) * 60_000;
    return at.get(t) ?? { at: t, visits: 0, shapes: 0, agentCalls: 0, edits: 0, people: 0 };
  });
}

// Written 200 rows at a time. Should a group fail, its rows are written one by one, so that a row the database
// refuses costs no other.
export async function flushHits() {
  if (!pending.size) return;
  const rows = [...pending].map(([k, n]) => [...(JSON.parse(k) as [string, string, string]), n]);
  pending.clear();
  const write = (part: typeof rows) =>
    q(
      `insert into hits (day, metric, who, n) values ${part.map((_, j) => `($${j * 4 + 1}, $${j * 4 + 2}, $${j * 4 + 3}, $${j * 4 + 4})`).join(", ")}
       on conflict (day, metric, who) do update set n = hits.n + excluded.n`,
      part.flat(),
    );
  for (let i = 0; i < rows.length; i += 200) {
    const part = rows.slice(i, i + 200);
    if (await write(part).catch(() => null)) continue;
    let lost = 0;
    for (const row of part)
      await write([row]).catch((e) => {
        if (!lost++) console.error("hits:", e?.message ?? e);
      });
    if (lost) console.error(`hits: ${lost} of ${part.length} counts not written`);
  }
}
setInterval(flushHits, 30_000).unref();

// ---------- the live feed ----------
// What just happened, newest last. An entry with a key (someone drawing on a canvas, an agent at work)
// grows while it continues instead of filling the feed: it gets a new id, and the page replaces it.
export type FeedEntry = {
  id: number;
  at: number;
  kind: "visit" | "guest" | "signup" | "convert" | "canvas" | "open" | "draw" | "agent" | "feedback";
  who?: string;
  user?: string; // the person's id, whose page their name opens; for an agent, the person it works for
  canvas?: string;
  detail?: string;
  n?: number;
  key?: string;
};
const feed: FeedEntry[] = [];
let feedId = 0;
export function event(e: Omit<FeedEntry, "id" | "at">) {
  const now = Date.now();
  if (e.key) {
    let old: FeedEntry | undefined;
    for (let i = feed.length - 1; i >= 0 && !old; i--) if (feed[i].key === e.key) old = feed[i];
    if (old && now - old.at < 120_000) {
      old.n = (old.n ?? 0) + (e.n ?? 1);
      old.at = now;
      old.id = ++feedId;
      if (e.detail) old.detail = e.detail;
      return;
    }
  }
  feed.push({ ...e, n: e.n ?? (e.key ? 1 : undefined), id: ++feedId, at: now });
  if (feed.length > 300) feed.shift();
}
export const feedSince = (id: number) => feed.filter((e) => e.id > id);

// ---------- visits ----------
// A page load of the app. The visitor is a hash of address and browser that changes every day: unique visitors
// per day, without following anyone from one day to the next. Robots are left out.
const BOT = /bot|crawl|spider|preview|fetch|curl|wget|python|headless|monitor|lighthouse|slurp|facebookexternalhit|embed/i;
// A person in a browser, as opposed to a robot, a script or an agent's program.
export const isBrowser = (ua: string | null | undefined) => !!ua && !BOT.test(ua);
const browserOf = (ua: string) =>
  /Edg\//.test(ua)
    ? "Edge"
    : /OPR\/|Opera/.test(ua)
      ? "Opera"
      : /Firefox|FxiOS/.test(ua)
        ? "Firefox"
        : /SamsungBrowser/.test(ua)
          ? "Samsung Internet"
          : /Chrome|CriOS|Chromium/.test(ua)
            ? "Chrome"
            : /Safari/.test(ua)
              ? "Safari"
              : "Other";
const osOf = (ua: string) =>
  /iPhone|iPad|iPod/.test(ua)
    ? "iOS"
    : /Android/.test(ua)
      ? "Android"
      : /Windows/.test(ua)
        ? "Windows"
        : /CrOS/.test(ua)
          ? "ChromeOS"
          : /Mac OS X|Macintosh/.test(ua)
            ? "macOS"
            : /Linux/.test(ua)
              ? "Linux"
              : "Other";
const deviceOf = (ua: string) =>
  /iPad|Tablet/.test(ua) || (/Android/.test(ua) && !/Mobile/.test(ua)) ? "Tablet" : /Mobi|iPhone/.test(ua) ? "Phone" : "Desktop";
export const describeAgent = (ua: string) => `${browserOf(ua)} on ${osOf(ua)}`;
const pageOf = (path: string) =>
  path === "/"
    ? "/"
    : path.startsWith("/c/")
      ? "/c/…"
      : path.startsWith("/auth")
        ? "/auth/…"
        : (["/canvases", "/admin"].find((p) => path.startsWith(p)) ?? "other");

// Each visitor's row of the day keeps, after the hash, the device, the system and the browser. Their number and
// order never change, since the rows already written are read with them and extensions' tags come after them:
// another attribute of visitors goes into a metric of its own.
const VISIT_FIELDS = 3;

// Today's visitors, for "on the site now" and to describe each visitor once a day.
let visitDay = "";
const visitors = new Map<string, { last: number; page: string }>();
const visitorId = (day: string, ip: string, ua: string) =>
  createHash("sha256").update(`${env.authSecret}|${day}|${ip}|${ua}`).digest("base64url").slice(0, 16);
// Today's visitor for this address and browser.
export const visitorOf = (ip: string, ua: string) => visitorId(dayOf(new Date()), ip, ua);
// `page` names the kind of page when a route has a name for it.
export function noteVisit(c: Context, page = pageOf(c.req.path)) {
  const ua = c.req.header("user-agent") ?? "";
  if (!isBrowser(ua)) return;
  const day = dayOf(new Date());
  if (day !== visitDay) [visitDay] = [day, visitors.clear()];
  const ip = clientIp(c);
  const id = visitorId(day, ip, ua);
  const tags: string[] = [];
  const notes: string[] = [];
  for (const e of extensions())
    try {
      const r = e.visit?.({ c, visitor: id, page, first: !visitors.has(id), ip });
      if (r?.tags) tags.push(...r.tags);
      if (r?.note) notes.push(r.note);
    } catch (err) {
      console.error("extension visit:", err);
    }
  // One row per visitor and day, whatever the restarts, with what they came with: each chart of visitors counts
  // these same rows, so all of them add up to the visitors.
  hit("visit", [id, deviceOf(ua), osOf(ua), browserOf(ua), ...tags].join("|"));
  hit("hour", String(new Date().getUTCHours()).padStart(2, "0"));
  if (!visitors.has(id)) event({ kind: "visit", detail: [page, ...notes, `${deviceOf(ua)}, ${browserOf(ua)}`].join(" · ") });
  visitors.set(id, { last: Date.now(), page });
}

export function visitorsSince(ms: number) {
  const since = Date.now() - ms;
  return [...visitors.values()].filter((v) => v.last > since);
}

// ---------- drawing ----------
// Called with the shapes that a push created: a handful of map updates, no I/O.
export function noteShapes(by: { id: string; name: string; agent?: boolean }, canvasId: string, created: string[], changed: number) {
  if (changed) hit("edits", by.agent ? "agents" : "people", changed);
  if (!created.length) return;
  for (const type of created) hit(by.agent ? "agent_shape" : "shape", type);
  emit("shapesDrawn", { userId: by.id, canvasId, n: created.length, agent: !!by.agent });
  if (!by.agent) hit("drawer", by.id, created.length);
  event({ kind: "draw", who: by.name, user: by.id, canvas: canvasId, n: created.length, key: `draw:${by.id}:${canvasId}` });
}

// ---------- the numbers ----------
const SERIES_KEYS = [
  "visitors",
  "views",
  "active",
  "activeAccounts",
  "accounts",
  "accountsTotal",
  "guests",
  "conversions",
  "canvases",
  "peopleCanvases",
  "agentCanvases",
  "shapes",
  "agentShapes",
  "drawers",
  "edits",
  "agents",
  "agentCalls",
] as const;
type Series = Record<(typeof SERIES_KEYS)[number], number> & { day: string };

const BREAKDOWNS = ["browser", "os", "device", "tech", "hour", "shape", "agent_shape", "agent_flow", "feature", "canvas"];

// The counters the numbers are made of. Devices, systems and browsers come from the visitors' rows instead: the
// older counters of their own counted a visitor again after each restart.
const METRICS = ["hour", "shape", "agent_shape", "agent_flow", "feature", "canvas", "agent", "drawer", "edits", "guest", "convert"];

// The first day anything was recorded: where "All" starts.
export async function firstDay() {
  const [r] = await q<{ u: unknown; c: unknown; h: string | null }>(
    `select (select min("createdAt") from "user") as u, (select min(created_at) from canvases) as c, (select min(day) from hits) as h`,
  );
  const days = [r?.u && dayOf(toDate(r.u)), r?.c && dayOf(toDate(r.c)), r?.h].filter(Boolean) as string[];
  return days.sort()[0] ?? dayOf(new Date());
}

// From one day to another (YYYY-MM-DD, UTC, both included), and with `compare` the as many days before them.
export async function stats(from: string, to: string, compare: boolean) {
  const days = Math.round((Date.parse(to) - Date.parse(from)) / DAY) + 1;
  const before = compare ? days : 0;
  const start = new Date(Date.parse(from) - before * DAY);
  const first = from;
  const inRange = (d: string) => d >= first && d <= to;
  const series: Series[] = Array.from({ length: before + days }, (_, i) => ({
    day: dayOf(new Date(start.getTime() + i * DAY)),
    ...(Object.fromEntries(SERIES_KEYS.map((k) => [k, 0])) as Record<(typeof SERIES_KEYS)[number], number>),
  }));
  const at = new Map(series.map((s) => [s.day, s]));
  await flushHits();

  for (const r of await q<{ day: string; anon: unknown; n: string }>(
    `select a.day, u."isAnonymous" as anon, count(*) as n from activity a join "user" u on u.id = a.user_id where a.day >= $1 group by a.day, u."isAnonymous"`,
    [dayOf(start)],
  )) {
    const s = at.get(r.day);
    if (!s) continue;
    s.active += Number(r.n);
    if (!r.anon) s.activeAccounts += Number(r.n);
  }

  // Sign-ups, and how each account signs in: Google, a company provider, or email (a link, maybe a password).
  const methods: Record<string, number> = {};
  for (const r of await q<{ created: unknown; providers: string | null }>(
    `select u."createdAt" as created, (select min(a."providerId") from account a where a."userId" = u.id and a."providerId" <> 'credential') as providers
       from "user" u where coalesce(u."isAnonymous", $1) = $1 and u."createdAt" >= $2`,
    [false, start],
  )) {
    const s = at.get(dayOf(toDate(r.created)));
    if (s) s.accounts++;
    if (!inRange(dayOf(toDate(r.created)))) continue;
    const m = r.providers === "google" ? "Google" : r.providers ? "Company sign-in" : "Email";
    methods[m] = (methods[m] ?? 0) + 1;
  }
  for (const r of await q<{ created: unknown }>(`select created_at as created from canvases where created_at >= $1`, [sqlTime(start)])) {
    const s = at.get(dayOf(toDate(r.created)));
    if (s) s.canvases++;
  }

  const breakdowns: Record<string, Record<string, number>> = Object.fromEntries(BREAKDOWNS.map((b) => [b, {}]));
  // Page loads by weekday (Monday first) and UTC hour.
  const week = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
  // Agents at work in the period and in the one before: each agent once, however many days it worked.
  const seats = { now: new Set<string>(), before: new Set<string>() };
  for (const r of await q<{ day: string; metric: string; who: string; n: string }>(
    `select day, metric, who, n from hits where day >= $1 and metric in (${METRICS.map((m) => `'${m}'`).join(", ")})`,
    [dayOf(start)],
  )) {
    const n = Number(r.n);
    const s = at.get(r.day);
    const now = inRange(r.day);
    if (now && breakdowns[r.metric]) breakdowns[r.metric][r.who] = (breakdowns[r.metric][r.who] ?? 0) + n;
    if (now && r.metric === "hour") week[(new Date(r.day + "T00:00:00Z").getUTCDay() + 6) % 7][Number(r.who)] += n;
    if (!s) continue;
    if (r.metric === "agent") (now ? seats.now : seats.before).add(r.who);
    if (r.metric === "agent") [s.agents, s.agentCalls] = [s.agents + 1, s.agentCalls + n];
    else if (r.metric === "canvas" && r.who === "agent") s.agentCanvases += n;
    else if (r.metric === "shape") s.shapes += n;
    else if (r.metric === "agent_shape") s.agentShapes += n;
    else if (r.metric === "drawer") {
      s.drawers++;
    } else if (r.metric === "edits") s.edits += n;
    else if (r.metric === "guest") s.guests += n;
    else if (r.metric === "convert") s.conversions += n;
  }
  // Visitors, and what they came with: every chart of visitors adds up to them, the ones not known included ("").
  for (const { day: d, fields, loads } of await visitorRows(dayOf(start), to)) {
    const s = at.get(d);
    if (s) {
      s.visitors++;
      s.views += loads;
    }
    if (!inRange(d)) continue;
    const [device = "", os = "", browser = ""] = fields;
    const add = (m: string, k: string) => (breakdowns[m][k] = (breakdowns[m][k] ?? 0) + 1);
    add("device", device);
    add("os", os);
    add("browser", browser);
    add("tech", device ? `${device}|${os}|${browser}` : "");
  }
  // Canvases from the database, the ones agents made from the counters: people made the rest.
  for (const s of series) s.peopleCanvases = Math.max(0, s.canvases - s.agentCanvases);
  const top = (m: Record<string, number>, max = 12) =>
    Object.entries(m)
      .sort((a, b) => b[1] - a[1])
      .slice(0, max)
      .map(([key, n]) => ({ key, n }));

  // Accounts in all at the end of each day: the ones made before the series, then each day's sign-ups.
  // Deleted accounts no longer count anywhere.
  let total = Number(
    (
      await q<{ n: string }>(`select count(*) as n from "user" where coalesce("isAnonymous", $1) = $1 and "createdAt" < $2`, [false, start])
    )[0].n,
  );
  for (const s of series) s.accountsTotal = total += s.accounts;
  const current = series.slice(before);

  // Distinct people active today, in the last 7 and the last 30 days.
  const distinct = async (since: number) =>
    Number(
      (
        await q<{ n: string }>(`select count(distinct user_id) as n from activity where day >= $1`, [
          dayOf(new Date(Date.now() - since * DAY)),
        ])
      )[0].n,
    );
  const [dau, wau, mau] = await Promise.all([distinct(0), distinct(6), distinct(29)]);

  let accounts = 0,
    guests = 0;
  for (const r of await q<{ anon: unknown; n: string }>(
    `select "isAnonymous" as anon, count(*) as n from "user" where "isProgram" = $1 group by "isAnonymous"`,
    [false],
  ))
    if (r.anon) guests += Number(r.n);
    else accounts += Number(r.n);
  const [cv] = await q<{ total: string; drawn: string; shapes: string }>(
    `select count(*) as total, coalesce(sum(case when live > 0 then 1 else 0 end), 0) as drawn, coalesce(sum(live), 0) as shapes from canvases where deleted_at is null`,
  );
  const [img] = await q<{ n: string }>(`select count(*) as n from files`);
  const [ag] = await q<{ keys: string; links: string }>(
    `select (select count(*) from api_keys) as keys, (select count(*) from agent_links) as links`,
  );

  return {
    now: {
      connections: [...rooms.values()].reduce((n, r) => n + r.clients.size, 0),
      canvases: rooms.size,
      visitors: visitorsSince(5 * 60_000).length,
      agents: [...rooms.values()].reduce((n, r) => n + [...r.agents.values()].filter((a) => a.state !== "idle").length, 0),
    },
    agentsSeen: { now: seats.now.size, before: seats.before.size },
    totals: {
      accounts,
      guests,
      canvases: Number(cv.total),
      drawn: Number(cv.drawn),
      shapes: Number(cv.shapes),
      images: Number(img.n),
      agentKeys: Number(ag.keys),
      agentLinks: Number(ag.links),
      dau,
      wau,
      mau,
    },
    days: current,
    prev: series.slice(0, before),
    from,
    to,
    week,
    methods: top(methods),
    // The ways in this server offers: email always, Google and a company's sign-in when they are set up.
    offered: ["Email", ...(env.google ? ["Google"] : []), ...(env.oidc ? ["Company sign-in"] : [])],
    breakdowns: Object.fromEntries(
      Object.entries(breakdowns).map(([k, m]) => [
        k,
        k === "hour"
          ? Array.from({ length: 24 }, (_, h) => ({ key: String(h).padStart(2, "0"), n: m[String(h).padStart(2, "0")] ?? 0 }))
          : top(m, k === "tech" || k === "agent_flow" ? 100 : 12),
      ]),
    ),
    retention: await retention(),
  };
}

// Each visitor once a day, from one day to another, with their page loads and what they came with: this version's
// fields (VISIT_FIELDS) and the tags extensions added after them. Of a visitor's rows on one day, the one with
// attributes wins over one without (written before they were kept).
export type VisitorRow = { day: string; fields: string[]; tags: string[]; loads: number };
export async function visitorRows(from: string, to: string) {
  await flushHits();
  const visits = new Map<string, VisitorRow>();
  for (const r of await q<{ day: string; who: string; n: string }>(
    `select day, who, n from hits where metric = 'visit' and day >= $1 and day <= $2`,
    [from, to],
  )) {
    const [id, ...what] = r.who.split("|");
    const key = r.day + "|" + id;
    const v = visits.get(key);
    const loads = (v?.loads ?? 0) + Number(r.n);
    if (!v || (what.length && !v.fields.length))
      visits.set(key, { day: r.day, fields: what.slice(0, VISIT_FIELDS), tags: what.slice(VISIT_FIELDS), loads });
    else v.loads = loads;
  }
  return [...visits.values()];
}

// The days a request asks about: ?days=30 (the last 30 days, against the 30 before), ?from=…&to=… (against as
// many days before), or ?all=1 (since the first day, against nothing).
export async function period(c: Context) {
  const today = dayOf(new Date());
  const valid = (d?: string) => (d && /^\d{4}-\d\d-\d\d$/.test(d) && !isNaN(Date.parse(d)) ? d : null);
  if (c.req.query("all")) return { from: await firstDay(), to: today, compare: false };
  let from = valid(c.req.query("from")),
    to = valid(c.req.query("to"));
  if (from && to) {
    if (to > today) to = today;
    if (from > to) [from, to] = [to, from];
    if (Date.parse(to) - Date.parse(from) > 3650 * DAY) from = dayOf(new Date(Date.parse(to) - 3650 * DAY));
    return { from, to, compare: true };
  }
  const days = Math.min(3650, Math.max(1, Number(c.req.query("days")) || 30));
  return { from: dayOf(new Date(Date.now() - (days - 1) * DAY)), to: today, compare: true };
}

// ---------- agents, one by one ----------
// Each agent (a key or an agent link) that worked between two days, the busiest first: whose it is, its program
// and how it connected (the most frequent), its calls each day, the shapes it drew and how many canvases it
// worked on. Only these people's agents, when given; `worksFor` says whom an agent works for when its counts
// do not (they were counted for a program's guest).
export async function agentSeats(from: string, to: string, users?: string[], worksFor?: (user: string, seat: string) => string) {
  await flushHits();
  const days = Math.round((Date.parse(to) - Date.parse(from)) / DAY) + 1;
  const slot = (d: string) => Math.round((Date.parse(d) - Date.parse(from)) / DAY);
  type Seat = {
    seat: string;
    user: string;
    calls: number;
    shapes: number;
    last: string;
    daily: number[];
    programs: Map<string, number>;
    vias: Map<string, number>;
    canvases: Set<string>;
  };
  const seats = new Map<string, Seat>();
  const rows = await q<{ day: string; metric: string; who: string; n: string }>(
    `select day, metric, who, n from hits where day >= $1 and day <= $2 and metric in ('agent_seat', 'agent_seat_shapes', 'agent_seat_canvas')`,
    [from, to],
  );
  const count = (m: Map<string, number>, k: string, n: number) => m.set(k, (m.get(k) ?? 0) + n);
  for (const r of rows) {
    if (r.metric !== "agent_seat") continue;
    const [counted, seat, via, program] = r.who.split("|");
    const user = worksFor ? worksFor(counted, seat) : counted;
    if (users && !users.includes(user)) continue;
    let s = seats.get(seat);
    if (!s)
      seats.set(
        seat,
        (s = {
          seat,
          user,
          calls: 0,
          shapes: 0,
          last: r.day,
          daily: Array(days).fill(0),
          programs: new Map(),
          vias: new Map(),
          canvases: new Set(),
        }),
      );
    s.calls += Number(r.n);
    s.daily[slot(r.day)] += Number(r.n);
    if (r.day > s.last) s.last = r.day;
    count(s.programs, program, Number(r.n));
    count(s.vias, via, Number(r.n));
  }
  for (const r of rows)
    if (r.metric === "agent_seat_shapes") {
      const s = seats.get(r.who);
      if (s) s.shapes += Number(r.n);
    } else if (r.metric === "agent_seat_canvas") seats.get(r.who.split("|")[0])?.canvases.add(r.who.split("|")[1]);
  // The program it named, over the calls it made before saying it.
  const most = (m: Map<string, number>) =>
    [...m].filter(([k]) => k !== "Unnamed" || m.size === 1).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "Unnamed";
  return [...seats.values()]
    .map((s) => ({
      seat: s.seat,
      user: s.user,
      program: most(s.programs),
      via: most(s.vias),
      calls: s.calls,
      shapes: s.shapes,
      canvases: s.canvases.size,
      last: s.last,
      daily: s.daily,
    }))
    .sort((a, b) => b.calls - a.calls);
}

// Weekly cohorts of the accounts made in the last 8 weeks: how many of them opened a canvas in their first
// week, their second, and so on. Weeks start on Monday, UTC.
async function retention() {
  const monday = (d: Date) => {
    const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    m.setUTCDate(m.getUTCDate() - ((m.getUTCDay() + 6) % 7));
    return m;
  };
  const thisWeek = monday(new Date()).getTime();
  const from = new Date(thisWeek - 7 * 7 * DAY);
  const people = await q<{ id: string; created: unknown }>(
    `select id, "createdAt" as created from "user" where coalesce("isAnonymous", $1) = $1 and "createdAt" >= $2`,
    [false, from],
  );
  const weekOf = new Map(people.map((p) => [p.id, monday(toDate(p.created)).getTime()]));
  const active = new Map<string, Set<number>>();
  if (people.length)
    for (const r of await q<{ day: string; user_id: string }>(`select day, user_id from activity where day >= $1`, [dayOf(from)])) {
      const w = weekOf.get(r.user_id);
      if (w === undefined) continue;
      const k = Math.floor((monday(new Date(r.day + "T00:00:00Z")).getTime() - w) / (7 * DAY));
      if (k >= 0) (active.get(r.user_id) ?? active.set(r.user_id, new Set()).get(r.user_id)!).add(k);
    }
  return Array.from({ length: 8 }, (_, i) => {
    const week = thisWeek - (7 - i) * 7 * DAY;
    const ids = people.filter((p) => weekOf.get(p.id) === week).map((p) => p.id);
    const weeks = 8 - i;
    return {
      week: dayOf(new Date(week)),
      size: ids.length,
      kept: Array.from({ length: weeks }, (_, k) => ids.filter((id) => active.get(id)?.has(k)).length),
    };
  });
}
