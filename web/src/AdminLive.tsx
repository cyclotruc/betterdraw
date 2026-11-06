// What is happening right now: the last hour minute by minute, who is in which canvas, and a feed of what
// just happened. Read from the server's memory every three seconds while the page is visible.
import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { Link, since, useRefresh } from "./Admin";
import { Card, Columns, Empty, Sparkline, num } from "./AdminCharts";

type Entry = {
  id: number;
  at: number;
  kind: "visit" | "guest" | "signup" | "convert" | "canvas" | "open" | "draw" | "agent" | "feedback";
  who?: string;
  user?: string;
  canvas?: string;
  title?: string;
  detail?: string;
  n?: number;
  key?: string;
};
type Room = {
  id: string;
  title: string;
  shapes: number;
  people: { id: string; name: string; guest: boolean; role: string; since: number; idle: boolean }[];
  agents: { name: string; idle: boolean }[];
};
type Minute = { at: number; visits: number; shapes: number; agentCalls: number; edits: number; people: number };
type Now = { at: number; visitors: number; pages: Record<string, number>; minutes: Minute[]; rooms: Room[]; feed: Entry[] };

const KIND: Record<Entry["kind"], string> = {
  visit: "Visit",
  guest: "Guest",
  signup: "Sign-up",
  convert: "Sign-up",
  canvas: "Canvas",
  open: "Opened",
  draw: "Drawing",
  agent: "Agent",
  feedback: "Feedback",
};
const clock = (t: number) => new Date(t).toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit", hour12: false });

export function Live() {
  const [now, setNow] = useState<Now | null>(null);
  const [feed, setFeed] = useState<Entry[]>([]);
  const last = useRef(0);
  const [, tick] = useState(0);
  const { done } = useRefresh();
  useEffect(() => {
    let stop = false;
    const poll = async () => {
      if (!document.hidden) {
        const r = await api<Now>(`/api/admin/live?since=${last.current}`).catch(() => null);
        if (stop || !r) return;
        if (r.feed.length) {
          last.current = Math.max(last.current, ...r.feed.map((e) => e.id));
          setFeed((old) => {
            const keys = new Set(r.feed.map((e) => e.key).filter(Boolean));
            return [...r.feed.reverse(), ...old.filter((e) => !e.key || !keys.has(e.key))].slice(0, 300);
          });
        }
        setNow(r);
        done();
      }
      tick((n) => n + 1);
    };
    poll();
    const timer = setInterval(poll, 3000);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, []);
  if (!now) return null;
  const people = now.rooms.reduce((n, r) => n + r.people.length, 0);
  const agents = now.rooms.reduce((n, r) => n + r.agents.filter((a) => !a.idle).length, 0);
  const m = now.minutes;
  const sum = (k: keyof Minute) => m.reduce((n, x) => n + x[k], 0);
  const tiles: [string, number, string, number[]][] = [
    ["On the site", now.visitors, "visitors, last 5 min", m.map((x) => x.visits)],
    ["In canvases", people, `on ${num(now.rooms.length)} canvases`, m.map((x) => x.people)],
    ["Shapes drawn", sum("shapes"), "last hour", m.map((x) => x.shapes)],
    ["Agent calls", sum("agentCalls"), `last hour · ${num(agents)} agents at work`, m.map((x) => x.agentCalls)],
  ];
  return (
    <div className="grid">
      {tiles.map(([label, value, sub, spark]) => (
        <div key={label} className="a-card span-3 kpi static">
          <span className="kpi-label">
            {label === "On the site" && <span className="pulse" />}
            {label}
          </span>
          <span className="kpi-value">{num(value)}</span>
          <span className="kpi-sub">{sub}</span>
          <Sparkline values={spark} />
        </div>
      ))}

      <Card span={12} title="Shapes drawn in the last hour" sub="By people and agents, minute by minute">
        <Columns labels={m.map((x) => clock(x.at))} stacks={[{ name: "Shapes drawn", values: m.map((x) => x.shapes) }]} height={180} />
      </Card>

      <Card span={7} title="Open canvases" sub={now.rooms.length ? `${num(now.rooms.length)} canvases with someone in them` : undefined}>
        {!now.rooms.length ? (
          <Empty text="Nobody is in a canvas right now." />
        ) : (
          <div className="rooms">
            {now.rooms.map((r) => (
              <div key={r.id} className="room">
                <div className="room-head">
                  <a href={`/c/${r.id}?watch`} target="_blank" rel="noopener">
                    <strong>{r.title || "Untitled"}</strong>
                  </a>
                  <small>{num(r.shapes)} shapes</small>
                </div>
                <ul className="chips">
                  {r.people.map((p, i) => (
                    <li key={i} className={p.idle ? "idle" : ""} title={`${p.role}, here since ${since(p.since)}`}>
                      <i className={"dot" + (p.guest ? " guest" : "")} />
                      <Link to={`/admin/people/${encodeURIComponent(p.id)}`}>{p.name}</Link>
                      {p.guest && <small>guest</small>}
                    </li>
                  ))}
                  {r.agents.map((a, i) => (
                    <li key={"a" + i} className={"agent" + (a.idle ? " idle" : "")}>
                      <i className="dot agent" />
                      {a.name}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
        {Object.keys(now.pages).length > 0 && (
          <p className="foot">
            Visitors of the last 5 minutes landed on{" "}
            {Object.entries(now.pages)
              .sort((a, b) => b[1] - a[1])
              .map(([p, n]) => `${p} (${n})`)
              .join(", ")}
            .
          </p>
        )}
      </Card>

      <Card span={5} title="Just now" sub="Updated every 3 seconds">
        {!feed.length ? (
          <Empty text="Nothing since the server started. Visits, sign-ups, drawing and agents show up here as they happen." />
        ) : (
          <ol className="feed">
            {feed.map((e) => (
              <li key={e.key ?? e.id}>
                <span className={"kind k-" + e.kind}>{KIND[e.kind]}</span>
                <span className="what">{line(e)}</span>
                <span className="when">{since(e.at)}</span>
              </li>
            ))}
          </ol>
        )}
      </Card>
    </div>
  );
}

function line(e: Entry) {
  const canvas = e.canvas ? (
    <a href={`/c/${e.canvas}?watch`} target="_blank" rel="noopener">
      {e.title || "Untitled"}
    </a>
  ) : null;
  const on = canvas && <> on {canvas}</>;
  // A name opens that person's page, as from People; an agent's opens the person it works for.
  const who = e.user ? (
    <Link to={`/admin/people/${encodeURIComponent(e.user)}`} className="feed-who">
      {e.who ?? "Someone"}
    </Link>
  ) : (
    <strong>{e.who ?? "Someone"}</strong>
  );
  switch (e.kind) {
    case "visit":
      return <>Someone landed on {e.detail}</>;
    case "guest":
      return <>{who} arrived as a guest</>;
    case "signup":
      return (
        <>
          {who} made an account {e.detail && <small>{e.detail}</small>}
        </>
      );
    case "convert":
      return <>{who} turned their guest session into an account</>;
    case "canvas":
      return (
        <>
          {who} made a new canvas{on}
        </>
      );
    case "open":
      return (
        <>
          {who} opened {canvas}
          {e.n && e.n > 1 ? ` (${e.n} times)` : ""}
        </>
      );
    case "draw":
      return (
        <>
          {who} drew {num(e.n ?? 1)} {e.n === 1 ? "shape" : "shapes"}
          {on}
        </>
      );
    case "agent":
      return (
        <>
          {who} used {e.detail}
          {e.n && e.n > 1 ? ` ×${e.n}` : ""}
          {on}
        </>
      );
    case "feedback":
      return (
        <>
          {who} {e.detail} · <Link to="/admin/feedback">read it</Link>
        </>
      );
  }
}
