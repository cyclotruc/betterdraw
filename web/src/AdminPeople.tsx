// Everyone, with what they keep and their agents: a sortable table with each one's last 30 days,
// and one page per person with how they sign in, their devices, canvases, activity and agents.
import { useEffect, useState, type ReactNode } from "react";
import { api, useConfig } from "./api";
import { navigate } from "./nav";
import {
  Link,
  Seg,
  SortTh,
  STORED,
  useRefresh,
  date,
  day,
  guestLifetime,
  programName,
  since,
  size,
  type AgentRow,
  type Sort,
  type Usage,
} from "./Admin";
import {
  Calendar,
  Card,
  Columns,
  Concentration,
  Donut,
  Empty,
  Meter,
  MiniBars,
  SplitBar,
  Sparkline,
  Strip,
  TimeChart,
  num,
  pct,
} from "./AdminCharts";

type Row = {
  id: string;
  name: string;
  email: string | null;
  guest: boolean;
  image: string | null;
  created: string;
  admin: boolean;
  lastActive: string | null;
  activeDays: number;
  canvases: number;
  shapes: number;
  keys: number;
  links: number;
  methods: string[];
  online: boolean;
  days: number[];
  storage: Usage & { total: number; quota: number };
  agents: { count: number; calls: number; programs: string[]; daily: number[] };
};
type Summary = {
  from: string;
  calls: number[];
  storage: { kinds: Usage; holders: number; curve: [number, number][]; top: { name: string; total: number }[] };
};
type Person = {
  id: string;
  name: string;
  email: string | null;
  image: string | null;
  guest: boolean;
  admin: boolean;
  program: boolean;
  verified: boolean;
  created: string;
  methods: string[];
  online: { id: string; title: string }[];
  sessions: { created: string; updated: string; expires: string; ip: string | null; device: string | null; expired: boolean }[];
  canvases: {
    id: string;
    title: string;
    shapes: number;
    access: string;
    members: number;
    created: string;
    updated: string;
    deleted: boolean;
    blocked: boolean;
    data: number;
    images: number;
    files: number;
  }[];
  shared: { id: string; title: string; shapes: number; role: string; owner: string }[];
  activeDays: string[];
  drawn: { day: string; n: number }[];
  keys: { seat: string; name: string; created: string; lastUsed: string | null }[];
  links: { seat: string; by: string | null; canvas: string; title: string; created: string; lastUsed: string | null }[];
  storage: Usage & { total: number; quota: number; days: (Usage & { day: string })[] };
  agents: Omit<AgentRow, "person">[];
};

const ACCESS: Record<string, string> = { edit: "Anyone with the link edits", view: "Anyone with the link views", none: "Private" };

export function People({ id }: { id: string | null }) {
  return id ? <PersonPage id={id} /> : <PeopleList />;
}

export function Avatar({ name, image, online, big }: { name: string; image: string | null; online?: boolean; big?: boolean }) {
  return (
    <span className={"who-pic" + (big ? " big" : "")}>
      {image ? <img src={image} alt="" /> : <span>{name.slice(0, 1).toUpperCase()}</span>}
      {online && <i className="online-dot" title="In a canvas now" />}
    </span>
  );
}

// A number with a thin bar under it, against the largest in the table.
export const Inline = ({ n, max }: { n: number; max: number }) => (
  <span className="inline-bar">
    {num(n)}
    <i style={{ width: `${max ? (n / max) * 100 : 0}%` }} />
  </span>
);

// Who to list: everyone, the accounts, the guests, or everyone over 60% of their quota or with agents.
const VIEWS: [string, string, string, string][] = [
  ["all", "Everyone", "all", ""],
  ["accounts", "Accounts", "accounts", ""],
  ["guests", "Guests", "guests", ""],
  ["quota", "Over 60% of quota", "all", "quota"],
  ["agents", "With agents", "all", "agents"],
];

// What someone keeps, and how much of their quota it fills.
export function Stored({ s }: { s: Row["storage"] }) {
  if (!s.total) return <span className="muted">nothing</span>;
  return (
    <span className="stored">
      <strong>{size(s.total)}</strong>
      {s.quota > 0 && (
        <span className="stored-quota">
          <span className="quota-bar" role="img" aria-label={`${pct(s.total, s.quota)} of the quota`}>
            <i style={{ width: `${Math.min(100, (s.total / s.quota) * 100)}%` }} />
          </span>
          <small>{pct(s.total, s.quota)} of quota</small>
        </span>
      )}
    </span>
  );
}

function PeopleList() {
  const [query, setQuery] = useState("");
  const [view, setView] = useState("all");
  const [sort, setSort] = useState<Sort>({ key: "storage", dir: "desc" });
  const [rows, setRows] = useState<Row[] | null>(null);
  const [total, setTotal] = useState(0);
  const [summary, setSummary] = useState<Summary | null>(null);
  const hours = useConfig()?.guestCanvasHours;
  const [, who, filter] = VIEWS.find((v) => v[0] === view)!.slice(1);
  const { tick, done } = useRefresh();
  const load = async (offset = 0) => {
    const r = await api<{ total: number; users: Row[] }>(
      `/api/admin/users?who=${who}&filter=${filter}&sort=${sort.key}&dir=${sort.dir}&offset=${offset}&q=${encodeURIComponent(query)}`,
    );
    setTotal(r.total);
    setRows((old) => (offset && old ? [...old, ...r.users] : r.users));
    done();
  };
  useEffect(() => {
    const timer = setTimeout(() => load().catch(() => {}), query ? 200 : 0);
    return () => clearTimeout(timer);
  }, [query, view, sort, tick]);
  useEffect(() => {
    api<Summary>("/api/admin/people-summary").then(setSummary, () => {});
  }, [tick]);
  const maxCanvases = Math.max(0, ...(rows ?? []).map((r) => r.canvases));
  const maxCalls = Math.max(1, ...(rows ?? []).flatMap((r) => r.agents.daily));
  const th = (k: string, label: string, first: "asc" | "desc" = "desc", className?: string) => (
    <SortTh k={k} sort={sort} onSort={setSort} first={first} className={className}>
      {label}
    </SortTh>
  );
  const stored = summary ? Object.values(summary.storage.kinds).reduce((n, v) => n + v, 0) : 0;
  const callDays = summary ? summary.calls.map((_, i) => day(new Date(Date.parse(summary.from) + i * 86_400_000).toISOString())) : [];
  return (
    <>
      {summary && (
        <div className="grid people-summary">
          <Card
            span={4}
            title="Stored by everyone"
            sub={`${size(stored)} kept by ${num(summary.storage.holders)} ${summary.storage.holders === 1 ? "person" : "people"}`}
          >
            {stored ? (
              <Donut
                parts={STORED.map(([key, name, color]) => ({ key, name, n: summary.storage.kinds[key], color }))}
                unit="stored"
                format={size}
              />
            ) : (
              <Empty text="Nothing stored yet." />
            )}
          </Card>
          <Card span={4} title="Who holds it" sub="The share of everything stored held by the biggest">
            {stored ? (
              <Concentration
                curve={summary.storage.curve}
                names={summary.storage.top.map((p) => p.name || "Unnamed")}
                values={summary.storage.top.map((p) => p.total)}
                format={size}
                height={160}
              />
            ) : (
              <Empty text="Nothing stored yet." />
            )}
          </Card>
          <Card span={4} title="Agents at work for people" sub="Calls each day by everyone's agents, the last 30 days">
            <Columns labels={callDays} stacks={[{ name: "Calls", values: summary.calls, cls: "agents" }]} height={180} />
          </Card>
        </div>
      )}
      <div className="a-card span-12">
        <div className="toolbar">
          <input
            className="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search a name or an email"
            aria-label="Search people"
          />
          <Seg label="Who" value={view} onChange={setView} options={VIEWS.map(([k, label]) => [k, label])} />
          <span className="count">
            {num(total)} {total === 1 ? "person" : "people"}
          </span>
        </div>
        {rows && !rows.length ? (
          <Empty text={query ? "Nobody matches this search." : "Nobody here yet."} />
        ) : (
          <div className="table-scroll">
            <table className="data people-table">
              <thead>
                <tr>
                  {th("name", "Person", "asc")}
                  {th("active", "Last active")}
                  <th className="left">Last 30 days</th>
                  {th("canvases", "Canvases")}
                  {th("storage", "Storage", "desc", "left")}
                  {th("agents", "Agents", "desc", "left")}
                  <th className="left">Signs in with</th>
                </tr>
              </thead>
              <tbody>
                {(rows ?? []).map((r) => (
                  <tr key={r.id} className="clickable" onClick={() => navigate(`/admin/people/${encodeURIComponent(r.id)}`)}>
                    <td>
                      <span className="who">
                        <Avatar name={r.name} image={r.image} online={r.online} />
                        <span>
                          <strong>{r.name}</strong>
                          {r.admin && <span className="tag">admin</span>}
                          <small>{r.email ?? (hours ? `Guest: their canvases last ${guestLifetime(hours)}` : "Guest")}</small>
                        </span>
                      </span>
                    </td>
                    <td>
                      {r.online ? (
                        <span className="now-tag">now</span>
                      ) : r.lastActive ? (
                        day(r.lastActive)
                      ) : (
                        <span className="muted">never</span>
                      )}
                    </td>
                    <td className="left">
                      <Strip days={r.days} />
                    </td>
                    <td>
                      <Inline n={r.canvases} max={maxCanvases} />
                    </td>
                    <td className="left">
                      <Stored s={r.storage} />
                    </td>
                    <td className="left">
                      {r.agents.count ? (
                        <span className="agents-cell">
                          <span>
                            <strong>
                              {r.agents.count} {r.agents.count === 1 ? "agent" : "agents"}
                            </strong>{" "}
                            · {num(r.agents.calls)} calls
                            <MiniBars values={r.agents.daily} max={maxCalls} cls="agents" width={64} height={14} />
                          </span>
                          <small>{r.agents.programs.map(programName).join(", ")}</small>
                        </span>
                      ) : r.keys + r.links ? (
                        <span className="muted">idle for 30 days</span>
                      ) : (
                        <span className="muted">none</span>
                      )}
                    </td>
                    <td className="left">
                      {r.guest ? (
                        <span className="pill">Guest</span>
                      ) : (
                        r.methods.map((m) => (
                          <span key={m} className="pill">
                            {m}
                          </span>
                        ))
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {rows && rows.length < total && (
          <button className="btn more" onClick={() => load(rows.length)}>
            Show {Math.min(50, total - rows.length)} more
          </button>
        )}
        <p className="foot">
          Last 30 days: <i className="key seen" /> opened a canvas · <i className="key s1" /> drew, darker for more shapes. Storage counts
          images, drawing data and the trash, all of it against the quota.
        </p>
      </div>
    </>
  );
}

// How fast someone's storage grows, from the last 30 days recorded: about how much they will keep in 30 days,
// and how full that makes their quota.
function pace(st: Person["storage"]) {
  const recent = st.days.slice(-30);
  const span = recent.length > 1 ? Math.round((Date.parse(recent[recent.length - 1].day) - Date.parse(recent[0].day)) / 86_400_000) : 0;
  if (!span) return null;
  const total = (u: Usage) => u.images + u.data + u.trash;
  const perDay = (total(recent[recent.length - 1]) - total(recent[0])) / span;
  const in30 = st.total + 30 * perDay;
  return { span, perDay, in30, quotaIn30: st.quota ? in30 / st.quota : 0 };
}

function PersonPage({ id }: { id: string }) {
  const [p, setP] = useState<Person | null>(null);
  const [missing, setMissing] = useState(false);
  const [armed, setArmed] = useState<string | null>(null);
  const hours = useConfig()?.guestCanvasHours;
  const { tick, done } = useRefresh();
  const load = () =>
    api<Person>(`/api/admin/users/${encodeURIComponent(id)}`).then(
      (r) => {
        setP(r);
        done();
      },
      () => setMissing(true),
    );
  useEffect(() => {
    load();
  }, [id, tick]);
  if (missing) return <Empty text="Nobody has this id any more." />;
  if (!p) return null;
  // Twice to act: the first click arms the button.
  const twice = (key: string, run: () => Promise<unknown>) => async () => {
    if (armed !== key) return setArmed(key);
    setArmed(null);
    await run();
  };
  const first = p.name.split(" ")[0] || "them";
  const drawn = new Map(p.drawn.map((d) => [d.day, d.n]));
  const active = new Set(p.activeDays);
  const lastDays = (n: number) =>
    Array.from({ length: n }, (_, i) => new Date(Date.now() - (n - 1 - i) * 86_400_000).toISOString().slice(0, 10));
  const month = lastDays(30);
  const weeks = lastDays(91);
  const live = p.canvases.filter((c) => !c.deleted);
  const st = p.storage;
  const growth = pace(st);
  const calls = month.map((_, i) => p.agents.reduce((n, a) => n + (a.daily[i] ?? 0), 0));
  const used = st.quota ? st.total / st.quota : 0;
  const biggest = [...p.canvases].sort((a, b) => b.data + b.images - (a.data + a.images));
  const maxCalls = Math.max(1, ...p.agents.flatMap((a) => a.daily));
  const working = new Set(p.agents.map((a) => a.seat));
  const idleKeys = p.keys.filter((k) => !working.has(k.seat));
  const idleLinks = p.links.filter((l) => !working.has(l.seat));
  const tiles: [string, string, string, ReactNode?][] = [
    [
      "Stored",
      size(st.total),
      st.quota ? `${pct(st.total, st.quota)} of the ${size(st.quota)} quota` : "no quota",
      st.days.length > 1 ? <Sparkline values={st.days.map((d) => d.images + d.data + d.trash)} /> : undefined,
    ],
    ["Canvases", num(live.length), `${num(p.canvases.length - live.length)} in the trash · ${num(p.shared.length)} shared with them`],
    [
      "Shapes drawn",
      num(month.reduce((n, d) => n + (drawn.get(d) ?? 0), 0)),
      "the last 30 days",
      <MiniBars values={month.map((d) => drawn.get(d) ?? 0)} fluid width={180} height={30} />,
    ],
    [
      "Agent calls",
      num(calls.reduce((n, v) => n + v, 0)),
      `the last 30 days, ${num(p.agents.length)} ${p.agents.length === 1 ? "agent" : "agents"}`,
      p.agents.length ? <MiniBars values={calls} cls="agents" fluid width={180} height={30} /> : undefined,
    ],
    ["Active days", num(p.activeDays.filter((d) => d >= weeks[0]).length), "of the last 90"],
    [
      "Last active",
      p.online.length ? "now" : p.activeDays.length ? day(p.activeDays[p.activeDays.length - 1]) : "never",
      `joined ${date(p.created)}`,
    ],
  ];
  return (
    <>
      <p className="crumbs">
        <Link to="/admin/people">People</Link> / {p.name}
      </p>
      <div className="grid">
        <section className="a-card span-12 person-head">
          <Avatar name={p.name} image={p.image} online={p.online.length > 0} big />
          <div className="person-id">
            <h2>
              {p.name} {p.admin && <span className="tag">admin</span>} {p.guest && <span className="tag">guest</span>}{" "}
              {p.program && <span className="tag">made by a program, not a person</span>}
            </h2>
            <p>
              {p.email ?? (hours ? `No email: a guest's canvases last ${guestLifetime(hours)}` : "No email: a guest")}
              {p.email && !p.verified && " (not verified)"}
            </p>
            <p>
              {(p.guest ? ["Guest"] : p.methods).map((m) => (
                <span key={m} className="pill">
                  {m}
                </span>
              ))}
              {p.agents.length > 0 && (
                <span className="pill agents">
                  {p.agents.length} {p.agents.length === 1 ? "agent" : "agents"}
                </span>
              )}
              {used >= 0.6 && <span className="pill warn">{pct(st.total, st.quota)} of quota</span>} joined {date(p.created)}
              {p.online.length > 0 && (
                <>
                  {" "}
                  · <span className="now-tag">now</span> in{" "}
                  {p.online.map((c, i) => (
                    <span key={c.id}>
                      {i > 0 && ", "}
                      <a href={`/c/${c.id}?watch`} target="_blank" rel="noopener">
                        {c.title || "Untitled"}
                      </a>
                    </span>
                  ))}
                </>
              )}
            </p>
          </div>
          <div className="person-actions">
            {p.sessions.length > 0 && (
              <button
                className={"btn" + (armed === "out" ? " armed" : "")}
                onBlur={() => setArmed(null)}
                onClick={twice("out", () => api(`/api/admin/users/${encodeURIComponent(p.id)}/sessions`, { method: "DELETE" }).then(load))}
              >
                {armed === "out" ? "Click again to confirm" : "Sign out everywhere"}
              </button>
            )}
            <button
              className={"btn danger" + (armed === "delete" ? " armed" : "")}
              onBlur={() => setArmed(null)}
              onClick={twice("delete", () =>
                api(`/api/admin/people/${encodeURIComponent(p.id)}`, { method: "DELETE" }).then(() => navigate("/admin/people")),
              )}
            >
              {armed === "delete" ? "Click again to delete" : "Delete account"}
            </button>
          </div>
        </section>

        {tiles.map(([label, value, sub, chart]) => (
          <div key={label} className="a-card span-2 kpi static">
            <span className="kpi-label">{label}</span>
            <span className="kpi-value">{value}</span>
            <span className="kpi-sub">{sub}</span>
            {chart}
          </div>
        ))}

        <Card span={7} title="Storage" sub={`What ${p.guest ? "this guest keeps" : first + " keeps"}, against the quota, and how it grew`}>
          {st.total ? (
            <>
              <SplitBar parts={STORED.map(([key, name, color]) => ({ key, name: name.toLowerCase(), n: st[key], color }))} format={size} />
              {st.quota > 0 && (
                <div className="meters person-quota">
                  <Meter label="Against the quota" n={st.total} of={st.quota} format={size} />
                </div>
              )}
            </>
          ) : (
            <Empty text="Nothing stored." />
          )}
          {st.days.length > 1 ? (
            <TimeChart
              labels={st.days.map((d) => day(d.day))}
              lines={[{ name: "Stored", values: st.days.map((d) => d.images + d.data + d.trash), kind: "area" }]}
              height={150}
              format={size}
              base={1024}
            />
          ) : (
            <p className="foot">Recorded every hour from today on: how it grows shows from tomorrow.</p>
          )}
          {growth && (
            <p className="foot">
              {growth.perDay > 0 ? (
                <>
                  At this pace, <strong>+{size(growth.perDay)}</strong> a day over the last {growth.span} days, about{" "}
                  <strong>{size(growth.in30)}</strong> by {date(new Date(Date.now() + 30 * 86_400_000).toISOString())}
                  {st.quota > 0 && (
                    <>
                      , <strong>{Math.round(growth.quotaIn30 * 100)}%</strong> of the quota
                    </>
                  )}
                  .{growth.quotaIn30 >= 0.9 && <span className="pill warn">Will need more room</span>}
                </>
              ) : (
                <>Not growing over the last {growth.span} days.</>
              )}
            </p>
          )}
        </Card>
        <Card span={5} title="What takes the space" sub="By kind, then their largest canvases">
          {st.total ? (
            <>
              <Donut parts={STORED.map(([key, name, color]) => ({ key, name, n: st[key], color }))} unit="stored" format={size} />
              <ol className="rank biggest">
                {biggest.slice(0, 3).map((c, i) => (
                  <li key={c.id}>
                    <span className="rank-n">{i + 1}</span>
                    <span className="rank-name">
                      {c.title || "Untitled"}
                      {c.deleted && <span className="tag">in the trash</span>}
                    </span>
                    <strong>{size(c.data + c.images)}</strong>
                    <span className="rank-share">{pct(c.data + c.images, st.total)}</span>
                  </li>
                ))}
              </ol>
            </>
          ) : (
            <Empty text="Nothing stored." />
          )}
        </Card>

        <Card
          span={12}
          title={`Agents working for ${p.guest ? "this guest" : first}`}
          sub="Each works through one of their keys or agent links, or a link a program made to their canvas; the last 30 days"
        >
          {p.agents.length ? (
            <div className="agent-cards">
              {p.agents.map((a) => (
                <div key={a.seat} className="agent-card">
                  <div className="agent-head">
                    <strong>
                      <i className="lane-dot agents" /> {programName(a.program)}
                    </strong>
                    <span className="pill">{a.via}</span>
                    <small>{a.lastUsed ? since(a.lastUsed) : day(a.last)}</small>
                  </div>
                  <small className="agent-key">
                    {a.kind === "key" ? `Key: ${a.label ?? "since removed"}` : `Agent link to ${a.label ?? "a canvas since removed"}`}
                    {a.maker && ", made by a program"}
                  </small>
                  <div className="agent-nums">
                    <span>
                      <strong>{num(a.calls)}</strong> calls
                    </span>
                    <span>
                      <strong>{num(a.shapes)}</strong> shapes drawn
                    </span>
                    <span>
                      <strong>{num(a.canvases)}</strong> {a.canvases === 1 ? "canvas" : "canvases"}
                    </span>
                  </div>
                  <MiniBars values={a.daily} max={maxCalls} cls="agents" fluid width={240} height={28} />
                </div>
              ))}
            </div>
          ) : (
            <Empty
              text={`No agent worked for ${p.guest ? "this guest" : first} in the last 30 days. An agent shows here once it uses one of their keys or agent links.`}
            />
          )}
          {idleKeys.length + idleLinks.length > 0 && (
            <>
              <p className="sub-title">Their keys and agent links not used in the last 30 days</p>
              <ul className="list agent-access">
                {idleKeys.map((k) => (
                  <li key={k.seat}>
                    Key <strong>{k.name}</strong>
                    <small>
                      made {date(k.created)} · used {since(k.lastUsed)}
                    </small>
                  </li>
                ))}
                {idleLinks.map((l) => (
                  <li key={l.seat}>
                    Agent link to{" "}
                    <a href={`/c/${l.canvas}?watch`} target="_blank" rel="noopener">
                      {l.title || "Untitled"}
                    </a>
                    <small>
                      made {date(l.created)}
                      {l.by && ` by ${l.by}, a program's guest`} · used {since(l.lastUsed)}
                    </small>
                  </li>
                ))}
              </ul>
            </>
          )}
        </Card>

        <Card
          span={8}
          title="Canvases by size"
          sub={`Drawing data and images, what costs storage: ${num(live.length)} canvases, ${num(p.canvases.length - live.length)} in the trash`}
        >
          {!p.canvases.length ? (
            <Empty text="No canvas." />
          ) : (
            <div className="table-scroll">
              <table className="data">
                <thead>
                  <tr>
                    <th>Canvas</th>
                    <th>Shapes</th>
                    <th>Drawing data</th>
                    <th>Images</th>
                    <th className="left">Share of what they keep</th>
                    <th>Members</th>
                    <th>Changed</th>
                  </tr>
                </thead>
                <tbody>
                  {biggest.map((c) => (
                    <tr key={c.id} className={c.deleted ? "muted" : ""}>
                      <td>
                        <a href={`/c/${c.id}?watch`} target="_blank" rel="noopener">
                          {c.title || "Untitled"}
                        </a>
                        {c.blocked && <span className="tag">taken down</span>}
                        {c.deleted && <span className="tag">in the trash</span>}
                        <small className="sub">{ACCESS[c.access] ?? c.access}</small>
                      </td>
                      <td>{num(c.shapes)}</td>
                      <td>{size(c.data)}</td>
                      <td>
                        {size(c.images)}
                        {c.files > 0 && (
                          <small>
                            {num(c.files)} {c.files === 1 ? "file" : "files"}
                          </small>
                        )}
                      </td>
                      <td className="left">
                        <span className="share-bar">
                          <span className="split-bar">
                            {c.images > 0 && <i style={{ flexGrow: c.images, background: "var(--cat-1)" }} />}
                            {c.data > 0 && <i style={{ flexGrow: c.data, background: "var(--cat-2)" }} />}
                            <i className="rest" style={{ flexGrow: Math.max(0, st.total - c.data - c.images) }} />
                          </span>
                          <small>{pct(c.data + c.images, st.total)}</small>
                        </span>
                      </td>
                      <td>{c.members || ""}</td>
                      <td>{since(c.updated)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        <Card span={4} title="Shared with them">
          {!p.shared.length ? (
            <Empty text="Nobody shared a canvas with them." />
          ) : (
            <ul className="list">
              {p.shared.map((c) => (
                <li key={c.id}>
                  <a href={`/c/${c.id}?watch`} target="_blank" rel="noopener">
                    {c.title || "Untitled"}
                  </a>
                  <small>
                    {c.role} · by {c.owner} · {num(c.shapes)} shapes
                  </small>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card span={5} title="Activity" sub="Shapes drawn by hand each day, the last 13 weeks; pale, a day they only opened a canvas">
          <Calendar days={weeks} values={weeks.map((d) => drawn.get(d) ?? 0)} seen={weeks.map((d) => active.has(d))} />
        </Card>
        <Card span={7} title="Devices" sub="Where they are signed in">
          {!p.sessions.length ? (
            <Empty text="Signed in nowhere." />
          ) : (
            <div className="table-scroll">
              <table className="data">
                <thead>
                  <tr>
                    <th>Device</th>
                    <th>Address</th>
                    <th>Signed in</th>
                    <th>Last seen</th>
                    <th>Expires</th>
                  </tr>
                </thead>
                <tbody>
                  {p.sessions.map((s, i) => (
                    <tr key={i} className={s.expired ? "muted" : ""}>
                      <td>{s.device ?? "Unknown"}</td>
                      <td className="mono">{s.ip ?? ""}</td>
                      <td>{date(s.created)}</td>
                      <td>{since(s.updated)}</td>
                      <td>{s.expired ? "expired" : date(s.expires)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
