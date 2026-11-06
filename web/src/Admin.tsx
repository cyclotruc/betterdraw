// Administration, for the accounts marked admin in the database: who comes and what they do (Overview),
// everyone with an account (People), what is happening right now (Live), and every canvas (Canvases).
// These pages are for the server's operators only, so their words stay here instead of texts.ts.
import { createContext, Suspense, useContext, useEffect, useState, type ReactNode } from "react";
import { api, useConfig, type Me } from "./api";
import { navigate } from "./nav";
import { useAdminView } from "./prefs";
import { adminTabs, type Period } from "./extend";
import { Avatar, People } from "./AdminPeople";
import { Live } from "./AdminLive";
import { Canvases } from "./AdminCanvases";
import { FeedbackList } from "./AdminFeedback";
import {
  Card,
  Columns,
  Delta,
  Donut,
  Empty,
  Heatmap,
  Meter,
  MiniBars,
  Mirror,
  PunchCard,
  Sparkline,
  SplitBar,
  TimeChart,
  num,
  pct,
} from "./AdminCharts";
import { Sunburst } from "./AdminSunburst";
import { FeatureMap } from "./AdminTreemap";
import { Flow, type FlowLink, type FlowNode } from "./AdminSankey";
import { Select } from "./Select";

// What the pages of an extension's tab (extend.tsx) use, with the charts of AdminCharts.tsx and AdminSankey.tsx.
export { num, pct };
// Bytes as kB, MB or GB of 1024, like the quotas are set, with a decimal below 100.
export const size = (b: number) => {
  const [v, unit] = b >= 1024 ** 3 ? [b / 1024 ** 3, "gigabyte"] : b >= 1024 ** 2 ? [b / 1024 ** 2, "megabyte"] : [b / 1024, "kilobyte"];
  return new Intl.NumberFormat("en", { style: "unit", unit, maximumFractionDigits: v < 100 ? 1 : 0 }).format(v);
};
export const day = (d: string) =>
  new Date(d.slice(0, 10) + "T00:00:00Z").toLocaleDateString("en", { day: "numeric", month: "short", timeZone: "UTC" });
export const date = (iso: string) => new Date(iso).toLocaleDateString("en", { day: "numeric", month: "short", year: "numeric" });
export const since = (iso: string | number | null) => {
  if (iso === null) return "never";
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${Math.max(0, s)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 30) return `${Math.round(s / 86400)} d ago`;
  return date(new Date(iso).toISOString());
};
// How long a guest's canvas lasts, from the server's hours (/api/config): "a day", "3 days", "12 hours".
export const guestLifetime = (hours: number) =>
  hours % 24 === 0 ? (hours === 24 ? "a day" : `${hours / 24} days`) : hours === 1 ? "an hour" : `${hours} hours`;

export function Link({ to, children, className }: { to: string; children: ReactNode; className?: string }) {
  return (
    <a
      href={to}
      className={className}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey) return;
        e.preventDefault();
        e.stopPropagation();
        navigate(to);
      }}
    >
      {children}
    </a>
  );
}

export function Seg<T extends string | number>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: [T, string][];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map(([v, text]) => (
        <button key={v} className={v === value ? "on" : ""} aria-pressed={v === value} onClick={() => onChange(v)}>
          {text}
        </button>
      ))}
    </div>
  );
}

// A table header that sorts by its column: the first click sorts the way that column reads best, the
// next one flips it.
export type Sort = { key: string; dir: "asc" | "desc" };
export function SortTh({
  k,
  sort,
  onSort,
  children,
  first = "desc",
  className,
}: {
  k: string;
  sort: Sort;
  onSort: (s: Sort) => void;
  children: ReactNode;
  first?: "asc" | "desc";
  className?: string;
}) {
  const on = sort.key === k;
  return (
    <th className={className} aria-sort={on ? (sort.dir === "asc" ? "ascending" : "descending") : undefined}>
      <button
        className={"th-sort" + (on ? " on" : "")}
        onClick={() => onSort({ key: k, dir: on ? (sort.dir === "asc" ? "desc" : "asc") : first })}
      >
        {children}
        <span className="arrow">{on ? (sort.dir === "asc" ? "↑" : "↓") : "↕"}</span>
      </button>
    </th>
  );
}

// ---------- staying up to date ----------
// The page asks for fresh numbers every minute while it is visible, and on a click of the time at the top.
// `tick` changes to ask; each tab calls `done` once its data arrived, which sets "Updated … ago".
const EVERY = 60_000;
const Refresh = createContext({ tick: 0, done: () => {} });
export const useRefresh = () => useContext(Refresh);

function useTicker() {
  const [tick, setTick] = useState(0);
  const [at, setAt] = useState(Date.now());
  const [, redraw] = useState(0);
  useEffect(() => {
    const check = () => {
      redraw((n) => n + 1);
      if (!document.hidden && Date.now() - at >= EVERY) setTick((n) => n + 1);
    };
    const timer = setInterval(check, 10_000);
    document.addEventListener("visibilitychange", check);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", check);
    };
  }, [at]);
  return { tick, at, again: () => setTick((n) => n + 1), done: () => setAt(Date.now()) };
}

function Updated({ at, again }: { at: number; again: () => void }) {
  const s = Math.round((Date.now() - at) / 1000);
  return (
    <button className="updated" onClick={again} title="Refresh now">
      <span className="pulse" />
      Updated {s < 10 ? "just now" : s < 60 ? `${Math.floor(s / 10) * 10}s ago` : `${Math.round(s / 60)} min ago`}
      <span aria-hidden="true">↻</span>
    </button>
  );
}

// ---------- the page ----------
const TABS: [string, string][] = [
  ["", "Overview"],
  ["people", "People"],
  ["live", "Live"],
  ["canvases", "Canvases"],
  ["feedback", "Feedback"],
];

// A part of the address, decoded: a malformed one reads as none instead of breaking the page.
function decoded(part: string | undefined) {
  try {
    return part ? decodeURIComponent(part) : null;
  } catch {
    return null;
  }
}

export function Admin({ me, path }: { me: Me; path: string }) {
  const [, tab = "", sub] = path.split("/").filter(Boolean);
  const [range, setRange] = useState<Period>({ kind: "30" });
  // The tabs a build adds come after the open-source ones, past a thin line; one that would take the place of an
  // open-source tab is left out.
  const extra = adminTabs().filter((t) => !TABS.some(([k]) => k === t.path));
  const page = extra.find((t) => t.path === tab);
  const tabButton = (k: string, label: string) => (
    <button
      key={k}
      className={k === tab ? "on" : ""}
      aria-current={k === tab ? "page" : undefined}
      onClick={() => navigate(`/admin${k ? "/" + k : ""}`)}
    >
      {label}
    </button>
  );
  const ticker = useTicker();
  if (!useAdminView(me))
    return (
      <div className="page">
        <h1>Administration</h1>
        <p>This page is for the server's administrators.</p>
        <p>
          <Link to="/">← Back to my canvases</Link>
        </p>
      </div>
    );
  return (
    <div className="admin-app">
      <header className="admin-top">
        <div className="admin-title">
          <Link to="/" className="admin-back">
            ←
          </Link>
          <h1>Analytics</h1>
        </div>
        <nav className="seg" aria-label="Administration">
          {TABS.map(([k, label]) => tabButton(k, label))}
          {extra.length > 0 && <span className="tab-sep" aria-hidden="true" />}
          {extra.map((t) => tabButton(t.path, t.label))}
        </nav>
        <div className="admin-tools">
          {(tab === "" || page?.period) && <PeriodPicker range={range} onChange={setRange} />}
          <Updated at={ticker.at} again={ticker.again} />
        </div>
      </header>
      <Refresh.Provider value={{ tick: ticker.tick, done: ticker.done }}>
        <main className="admin-main">
          {tab === "" && <Overview range={range} />}
          {tab === "people" && <People id={decoded(sub)} />}
          {tab === "live" && <Live />}
          {tab === "canvases" && <Canvases />}
          {tab === "feedback" && <FeedbackList />}
          {page && (
            <Suspense fallback={null}>
              <page.Page me={me} period={range} sub={decoded(sub)} />
            </Suspense>
          )}
        </main>
      </Refresh.Provider>
    </div>
  );
}

// ---------- the period ----------
// The last 7, 30 or 90 days, everything since the server started, or any two dates. A period of days is
// compared with as many days before it; "All" has nothing before it.
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
export const periodQuery = (r: Period) =>
  r.kind === "all" ? "all=1" : r.kind === "custom" ? `from=${r.from}&to=${r.to}` : `days=${r.kind}`;
export const periodName = (r: Period, from: string, to: string) =>
  r.kind === "all" ? `since ${day(from)}` : r.kind === "custom" ? `${day(from)} to ${day(to)}` : `the last ${r.kind} days`;

function PeriodPicker({ range, onChange }: { range: Period; onChange: (r: Period) => void }) {
  const today = iso(Date.now());
  const custom = range.kind === "custom" ? range : { from: iso(Date.now() - 29 * 86_400_000), to: today };
  return (
    <div className="period">
      <Seg
        label="Period"
        value={range.kind}
        onChange={(k) => onChange(k === "custom" ? { kind: "custom", ...custom } : { kind: k })}
        options={[
          ["7", "7 days"],
          ["30", "30 days"],
          ["90", "90 days"],
          ["all", "All"],
          ["custom", "Custom"],
        ]}
      />
      {range.kind === "custom" && (
        <span className="dates">
          <input
            type="date"
            id="period-from"
            aria-label="From"
            value={range.from}
            max={range.to}
            onChange={(e) => e.target.value && onChange({ ...range, from: e.target.value })}
          />
          <span>to</span>
          <input
            type="date"
            id="period-to"
            aria-label="To"
            value={range.to}
            min={range.from}
            max={today}
            onChange={(e) => e.target.value && onChange({ ...range, to: e.target.value })}
          />
        </span>
      )}
    </div>
  );
}

// ---------- Overview ----------
type Day = {
  day: string;
  visitors: number;
  views: number;
  active: number;
  activeAccounts: number;
  accounts: number;
  accountsTotal: number;
  guests: number;
  conversions: number;
  canvases: number;
  peopleCanvases: number;
  agentCanvases: number;
  shapes: number;
  agentShapes: number;
  drawers: number;
  edits: number;
  agents: number;
  agentCalls: number;
};
type Key = keyof Omit<Day, "day">;
type Item = { key: string; n: number };
type Stats = {
  now: { connections: number; canvases: number; visitors: number; agents: number };
  agentsSeen: { now: number; before: number };
  totals: {
    accounts: number;
    guests: number;
    canvases: number;
    drawn: number;
    shapes: number;
    images: number;
    agentKeys: number;
    agentLinks: number;
    dau: number;
    wau: number;
    mau: number;
  };
  days: Day[];
  prev: Day[];
  from: string;
  to: string;
  week: number[][];
  methods: Item[];
  offered: string[];
  breakdowns: Record<string, Item[]>;
  retention: { week: string; size: number; kept: number[] }[];
  agents: AgentRow[];
  stored: number;
};
// An agent, a key or an agent link, with its numbers over the period.
export type AgentRow = {
  seat: string;
  program: string;
  via: string;
  calls: number;
  shapes: number;
  canvases: number;
  last: string;
  daily: number[];
  kind: "key" | "link";
  label: string | null;
  maker?: string;
  lastUsed: string | null;
  person: { id: string; name: string; email: string | null; image: string | null; guest: boolean } | null;
};
// What someone keeps, in bytes: images, drawing data and the trash, all of it counted against their quota.
export type Usage = { images: number; data: number; trash: number };

// Every daily series the main chart can show. Active people is a daily count, so its total is an average.
// Sign-ups show as the running total of accounts; their card counts the new ones, and the chart can show
// those per day too.
type Metric = { key: Key; label: string; avg?: boolean; chart?: Key };
const METRICS: Metric[] = [
  { key: "visitors", label: "Visitors" },
  { key: "accounts", label: "Sign-ups", chart: "accountsTotal" },
  { key: "active", label: "Active people", avg: true },
  { key: "shapes", label: "Shapes drawn" },
  { key: "canvases", label: "New canvases" },
  { key: "peopleCanvases", label: "Canvases made by people" },
  { key: "agentCanvases", label: "Canvases made by agents" },
  { key: "agentCalls", label: "Agent calls" },
  { key: "views", label: "Page views" },
  { key: "guests", label: "New guests" },
  { key: "conversions", label: "Guests who made an account" },
  { key: "drawers", label: "People who drew" },
  { key: "edits", label: "Edits" },
  { key: "agentShapes", label: "Shapes drawn by agents" },
  { key: "agents", label: "Agents at work" },
];
// The headline, in two lanes: people in a browser, and agents working for them. Each tile picks the big chart.
type Kpi = { key: Key; label: string; avg?: boolean; chart?: Key; seen?: boolean };
const LANES: { kind: "people" | "agents"; title: string; sub: string; kpis: Kpi[] }[] = [
  {
    kind: "people",
    title: "People",
    sub: "in a browser: guests and accounts",
    kpis: [
      { key: "visitors", label: "Visitors" },
      { key: "active", label: "Active people", avg: true },
      { key: "accounts", label: "New accounts", chart: "accountsTotal" },
      { key: "shapes", label: "Shapes drawn" },
    ],
  },
  {
    kind: "agents",
    title: "Agents",
    sub: "through MCP, the HTTP API or an agent link",
    kpis: [
      { key: "agents", label: "Agents at work", seen: true },
      { key: "agentCalls", label: "Agent calls" },
      { key: "agentShapes", label: "Shapes drawn" },
      { key: "agentCanvases", label: "Canvases made" },
    ],
  },
];
const CHARTS: { key: Key; label: string }[] = [
  { key: "visitors", label: "Visitors" },
  { key: "accountsTotal", label: "Accounts in all" },
  { key: "accounts", label: "New sign-ups per day" },
  ...METRICS.slice(2).map(({ key, label }) => ({ key, label })),
];
const CUMULATIVE = new Set<Key>(["accountsTotal"]);
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

// What people keep, each kind in its own color: the trash in a neutral one.
export const STORED: [keyof Usage, string, string][] = [
  ["images", "Images", "--cat-1"],
  ["data", "Drawing data", "--cat-2"],
  ["trash", "Trash", "--viz-prev"],
];
// How accounts sign in, each way in its own color.
const METHODS: [string, string][] = [
  ["Email", "--cat-1"],
  ["Google", "--cat-2"],
  ["Company sign-in", "--cat-3"],
];

// The program behind an agent, as it named itself over MCP.
export const programName = (p: string) => (p === "Unnamed" ? "Unnamed program" : p);

// What agents do, in words, drawing first: it is what they are for.
const DOING: [string, string][] = [
  ["put_elements", "Drawing"],
  ["delete_elements", "Erasing"],
  ["point", "Pointing"],
  ["read_canvas", "Reading"],
  ["list_canvases", "Listing canvases"],
  ["create_canvas", "Making canvases"],
];
// Operations ("program|via|tool" keys) as a flow: the program, how it connected, what it did. The ones that
// drew stay blue all the way; the six busiest programs are named, the others grouped.
function agentFlow(items: Item[]) {
  const sum = (f: (p: string[]) => boolean) => items.filter((i) => f(i.key.split("|"))).reduce((n, i) => n + i.n, 0);
  const rank = (at: number) =>
    [...new Set(items.map((i) => i.key.split("|")[at]))].sort((a, b) => sum((p) => p[at] === b) - sum((p) => p[at] === a));
  const named = rank(0).slice(0, 6);
  const programs = rank(0).length > 6 ? [...named, "Other programs"] : named;
  const vias = rank(1);
  const tools = [
    ...DOING.map(([k]) => k).filter((k) => items.some((i) => i.key.split("|")[2] === k)),
    ...rank(2).filter((k) => !DOING.some(([d]) => d === k)),
  ];
  const links: FlowLink[] = [];
  const add = (source: string, target: string, value: number, draws: boolean) => {
    if (!value) return;
    const l = links.find((x) => x.source === source && x.target === target && x.strong === draws);
    if (l) l.value += value;
    else links.push({ source, target, value, color: draws ? "--agents" : "--viz-prev", strong: draws });
  };
  const program = (p: string) => (named.includes(p) ? p : "Other programs");
  for (const draws of [true, false])
    for (const p of programs)
      for (const v of vias)
        add(
          "p:" + p,
          "v:" + v,
          sum((k) => program(k[0]) === p && k[1] === v && (k[2] === "put_elements") === draws),
          draws,
        );
  for (const v of vias)
    for (const t of tools)
      add(
        "v:" + v,
        "t:" + t,
        sum((k) => k[1] === v && k[2] === t),
        t === "put_elements",
      );
  const nodes: FlowNode[] = [
    ...programs.map((p) => ({ id: "p:" + p, name: programName(p), color: "--agents" })),
    ...vias.map((v) => ({ id: "v:" + v, name: v })),
    ...tools.map((t) => ({
      id: "t:" + t,
      name: DOING.find(([k]) => k === t)?.[1] ?? t,
      color: t === "put_elements" ? "--agents" : undefined,
    })),
  ];
  return { nodes, links };
}

// The busiest agents, each opening the page of the person it works for.
function AgentsTable({ rows }: { rows: AgentRow[] }) {
  const max = Math.max(1, ...rows.flatMap((r) => r.daily));
  return (
    <div className="table-scroll">
      <table className="data agents-table">
        <thead>
          <tr>
            <th>Agent</th>
            <th className="left">Works for</th>
            <th className="left">Connected through</th>
            <th>Calls</th>
            <th>Shapes drawn</th>
            <th>Canvases</th>
            <th>Last seen</th>
            <th className="left">Each day</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((a) => (
            <tr
              key={a.seat}
              className={a.person ? "clickable" : ""}
              onClick={() => a.person && navigate(`/admin/people/${encodeURIComponent(a.person.id)}`)}
            >
              <td>
                <strong>
                  <i className="lane-dot agents" /> {programName(a.program)}
                </strong>
                <small>
                  {a.kind === "key" ? `Key: ${a.label ?? "since removed"}` : `Agent link to ${a.label ?? "a canvas since removed"}`}
                  {a.maker && ", made by a program"}
                </small>
              </td>
              <td className="left">
                {a.person ? (
                  <span className="who">
                    <Avatar name={a.person.name} image={a.person.image} />
                    <span>
                      <strong>{a.person.name}</strong>
                      <small>{a.person.email ?? "Guest"}</small>
                    </span>
                  </span>
                ) : (
                  <span className="muted">Someone since deleted</span>
                )}
              </td>
              <td className="left">
                <span className="pill">{a.via}</span>
              </td>
              <td>
                <strong>{num(a.calls)}</strong>
              </td>
              <td>{num(a.shapes)}</td>
              <td>{num(a.canvases)}</td>
              <td>{a.lastUsed ? since(a.lastUsed) : day(a.last)}</td>
              <td className="left">
                <MiniBars values={a.daily} max={max} cls="agents" />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Overview({ range }: { range: Period }) {
  const [stats, setStats] = useState<Stats | null>(null);
  const [metric, setMetric] = useState<Key>("visitors");
  const hours = useConfig()?.guestCanvasHours;
  const { tick, done } = useRefresh();
  useEffect(() => {
    api<Stats>(`/api/admin/stats?${periodQuery(range)}`).then(
      (s) => {
        setStats(s);
        done();
      },
      () => {},
    );
  }, [periodQuery(range), tick]);
  if (!stats)
    return (
      <div className="lanes">
        {LANES.map((lane) => (
          <section key={lane.kind} className={"lane " + lane.kind}>
            <div className="lane-kpis">
              {lane.kpis.map((k) => (
                <div key={k.key} className="kpi loading" />
              ))}
            </div>
          </section>
        ))}
      </div>
    );
  const { totals, now, days, prev, breakdowns: b } = stats;
  const total = (list: Day[], k: Key, avg?: boolean) => {
    const s = list.reduce((n, d) => n + d[k], 0);
    return avg ? s / Math.max(1, list.length) : s;
  };
  const perDay = (list: Day[], k: Key | ((d: Day) => number)) => {
    const v = list.reduce((n, d) => n + (typeof k === "function" ? k(d) : d[k]), 0) / Math.max(1, list.length);
    return v.toFixed(v < 10 ? 1 : 0);
  };
  const chart = CHARTS.find((x) => x.key === metric)!;
  const signups = stats.methods.reduce((n, m) => n + m.n, 0);
  const madeBy = (k: string) => b.canvas.find((c) => c.key === k)?.n ?? 0;
  const operations = b.agent_flow.reduce((n, i) => n + i.n, 0);
  const labels = days.map((d) => day(d.day));
  const period = periodName(range, stats.from, stats.to);
  const compare = prev.length > 0 && !CUMULATIVE.has(metric);
  return (
    <>
      <p className="now-line">
        <span className="pulse" /> Now <span className="sep">·</span> <i className="lane-dot people" />
        <strong>{num(now.visitors)}</strong> people on the site, <strong>{num(now.connections)}</strong> in {num(now.canvases)} canvases{" "}
        <span className="sep">·</span> <i className="lane-dot agents" />
        <strong>{num(now.agents)}</strong> {now.agents === 1 ? "agent" : "agents"} at work <span className="sep">·</span>{" "}
        <Link to="/admin/live">Watch live →</Link>
      </p>

      <div className="lanes">
        {LANES.map((lane) => (
          <section key={lane.kind} className={"lane " + lane.kind}>
            <h2>
              <i className={"lane-dot " + lane.kind} />
              {lane.title} <small>{lane.sub}</small>
            </h2>
            <div className="lane-kpis">
              {lane.kpis.map((k) => {
                const v = k.seen ? stats.agentsSeen.now : total(days, k.key, k.avg);
                const shows = k.chart ?? k.key;
                const on = metric === k.key || metric === shows;
                return (
                  <button key={k.key} className={"kpi" + (on ? " on" : "")} onClick={() => setMetric(shows)} aria-pressed={on}>
                    <span className="kpi-label">{k.label}</span>
                    <span className="kpi-value">
                      {k.avg ? v.toFixed(v < 10 ? 1 : 0) : num(v)}
                      {k.avg && <small> a day</small>}
                    </span>
                    {prev.length ? (
                      <Delta
                        now={v}
                        before={k.seen ? stats.agentsSeen.before : total(prev, k.key, k.avg)}
                        label={`in the ${prev.length} days before`}
                      />
                    ) : (
                      <span className="delta flat">{k.chart ? `${num(days[days.length - 1]?.[k.chart] ?? 0)} in all` : "all time"}</span>
                    )}
                    <Sparkline values={days.map((d) => d[shows])} />
                  </button>
                );
              })}
            </div>
          </section>
        ))}
      </div>

      <div className="grid">
        <Card
          span={5}
          title={chart.label}
          sub={
            CUMULATIVE.has(metric)
              ? `At the end of each day, ${period}`
              : `Each day, ${period}${compare ? `, against the ${prev.length} days before` : ""}`
          }
          right={
            <Select
              className="metric-pick"
              value={metric}
              onChange={setMetric}
              label="Metric"
              options={CHARTS.map((x) => ({ value: x.key, label: x.label }))}
            />
          }
        >
          <TimeChart
            labels={labels}
            lines={[
              { name: compare ? "This period" : chart.label, values: days.map((d) => d[metric]), kind: "area" },
              ...(compare ? [{ name: `The ${prev.length} days before`, values: prev.map((d) => d[metric]), kind: "prev" as const }] : []),
            ]}
          />
        </Card>
        <Card span={4} title="Active people" sub="Who opened a canvas each day: accounts above, guests below">
          <Mirror
            labels={labels}
            up={{ name: "Accounts", values: days.map((d) => d.activeAccounts), cls: "people" }}
            down={{ name: "Guests", values: days.map((d) => d.active - d.activeAccounts), cls: "people-soft" }}
            height={262}
          />
          <p className="foot">
            On an average day, <strong>{perDay(days, "activeAccounts")}</strong> accounts and{" "}
            <strong>{perDay(days, (d) => d.active - d.activeAccounts)}</strong> guests
          </p>
        </Card>
        <Card span={3} title="Who draws" sub="Shapes made each day: people above, agents below">
          <Mirror
            labels={labels}
            up={{ name: "People", values: days.map((d) => d.shapes), cls: "people" }}
            down={{ name: "Agents", values: days.map((d) => d.agentShapes), cls: "agents" }}
            shared={false}
            height={262}
          />
          <p className="foot">
            <strong>{num(total(days, "shapes"))}</strong> by people · <strong>{num(total(days, "agentShapes"))}</strong> by agents, each
            side to its own scale
          </p>
        </Card>
      </div>

      <h2 className="section">
        <i className="lane-dot people" /> People: who they are
      </h2>
      <div className="grid">
        <Card span={5} title="Devices, systems, browsers" sub="Each ring splits the one inside it: click a part to open it">
          {b.tech.length ? <Sunburst items={b.tech} /> : <Empty text="No visits in this period yet." />}
        </Card>
        <Card span={7} title="When they come" sub={`Page loads by weekday and hour (UTC), ${period}: the bigger the dot, the busier`}>
          {stats.week.flat().some(Boolean) ? (
            <PunchCard rows={WEEKDAYS} values={stats.week} />
          ) : (
            <Empty text="No visits in this period yet." />
          )}
        </Card>
      </div>

      <h2 className="section">
        <i className="lane-dot people" /> People: what they do
      </h2>
      <div className="grid">
        <Card span={6} title="Who comes back" sub="Accounts by the week they signed up: share who opened a canvas each week after">
          {stats.retention.some((c) => c.size) ? (
            <Heatmap
              rows={stats.retention.map((c) => `${day(c.week)} · ${c.size}`)}
              cols={stats.retention.map((_, k) => `W${k}`)}
              values={stats.retention.map((c) => stats.retention.map((_, k) => (k < c.kept.length && c.size ? c.kept[k] / c.size : null)))}
              tip={(r, c) => {
                const co = stats.retention[r];
                return `Signed up the week of ${day(co.week)}: ${co.kept[c]} of ${co.size} came back in week ${c}`;
              }}
              cellText={(r, c) => {
                const co = stats.retention[r];
                return co.size ? pct(co.kept[c], co.size) : "";
              }}
            />
          ) : (
            <Empty text="No sign-ups in the last 8 weeks yet." />
          )}
        </Card>
        <Card span={6} title="Features used" sub="Grouped by what they are for, each box as big as its uses: click a group to open it">
          {b.feature.length ? <FeatureMap items={b.feature} /> : <Empty text="No feature used in this period yet." />}
        </Card>
        <Card span={4} title="How new accounts sign in" sub={`The ${num(signups)} accounts made, ${period}`}>
          {signups ? (
            <Donut
              parts={METHODS.map(([key, color]) => ({ key, name: key, n: stats.methods.find((m) => m.key === key)?.n ?? 0, color })).filter(
                (p) => stats.offered.includes(p.key) || p.n,
              )}
              unit={signups === 1 ? "account" : "accounts"}
            />
          ) : (
            <Empty text="No sign-ups in this period yet." />
          )}
        </Card>
        <Card span={4} title="Canvases made by people" sub={`By accounts and by guests, ${period}`}>
          {madeBy("person") + madeBy("guest") ? (
            <>
              <p className="headline">
                <strong>{num(madeBy("person") + madeBy("guest"))}</strong> canvases
                {madeBy("agent") > 0 && `, and ${num(madeBy("agent"))} more by agents`}
              </p>
              <SplitBar
                parts={[
                  { key: "person", name: "by accounts", n: madeBy("person"), color: "--people" },
                  { key: "guest", name: "by guests", n: madeBy("guest"), color: "--people-soft" },
                ]}
              />
              {hours !== undefined && (
                <p className="foot">
                  {hours
                    ? `A guest's canvas lasts ${guestLifetime(hours)}, unless they make an account.`
                    : "A guest's canvas does not expire here."}
                </p>
              )}
            </>
          ) : (
            <Empty text="No canvas made by people in this period yet." />
          )}
        </Card>
        <Card span={4} title="Stickiness" sub={`Of the ${num(totals.mau)} people active in the last 30 days`}>
          {totals.mau ? (
            <div className="meters">
              <Meter label="Today" n={totals.dau} of={totals.mau} />
              <Meter label="In the last 7 days" n={totals.wau} of={totals.mau} />
            </div>
          ) : (
            <Empty text="Nobody opened a canvas in the last 30 days." />
          )}
        </Card>
      </div>

      <h2 className="section">
        <i className="lane-dot agents" /> Agents: what they do for people
      </h2>
      <div className="grid">
        <Card
          span={8}
          title="Agent traffic"
          sub={`The ${num(operations)} operations of ${period}: which program, connected how, doing what`}
        >
          {operations ? (
            <Flow {...agentFlow(b.agent_flow)} stages={["Program", "Connected through", "Doing"]} unit="operations" height={290} />
          ) : (
            <Empty text="No agent operation recorded in this period yet." />
          )}
        </Card>
        <Card span={4} title="Calls each day" sub="Requests to MCP, the HTTP API and agent links">
          <Columns labels={labels} stacks={[{ name: "Calls", values: days.map((d) => d.agentCalls), cls: "agents" }]} height={316} />
        </Card>
        <Card
          span={12}
          title="Most active agents"
          sub="Each agent works for one person, with one of their keys or agent links: open a row to see that person"
        >
          {stats.agents.length ? <AgentsTable rows={stats.agents} /> : <Empty text="No agent worked in this period yet." />}
        </Card>
      </div>

      <h2 className="section">On the server</h2>
      <section className="a-card inventory">
        {(
          [
            ["Accounts", num(totals.accounts)],
            ["Guests", num(totals.guests)],
            ["Canvases", num(totals.canvases), `${num(totals.drawn)} drawn on`],
            ["Shapes", num(totals.shapes)],
            ["Stored", size(stats.stored), `${num(totals.images)} images`],
            ["Agent keys", num(totals.agentKeys)],
            ["Agent links", num(totals.agentLinks)],
          ] as [string, string, string?][]
        ).map(([label, value, sub]) => (
          <div key={label}>
            <span>{label}</span>
            <strong>{value}</strong>
            {sub && <small>{sub}</small>}
          </div>
        ))}
      </section>
    </>
  );
}
