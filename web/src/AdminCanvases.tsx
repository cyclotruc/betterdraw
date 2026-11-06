// Every canvas on the server, sortable and searched by title, address or owner's email, with what an
// admin may do about one: take it down (nobody can open it) or delete it for good.
import { useEffect, useState } from "react";
import { api } from "./api";
import { Link, SortTh, date, since, useRefresh, type Sort } from "./Admin";
import { Empty, num } from "./AdminCharts";
import { Inline } from "./AdminPeople";

type Row = {
  id: string;
  title: string;
  shapes: number;
  access: string;
  created: string;
  updated: string;
  deleted: boolean;
  blocked: boolean;
  members: number;
  images: number;
  owner: { id: string; name: string; email: string | null; guest: boolean };
  here: number;
};
const ACCESS: Record<string, string> = { edit: "Link edits", view: "Link views", none: "Private" };

export function Canvases() {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<Sort>({ key: "updated", dir: "desc" });
  const [rows, setRows] = useState<Row[] | null>(null);
  const [total, setTotal] = useState(0);
  const [armed, setArmed] = useState<string | null>(null);
  const { tick, done } = useRefresh();
  const load = async (offset = 0) => {
    const r = await api<{ total: number; canvases: Row[] }>(
      `/api/admin/canvases?sort=${sort.key}&dir=${sort.dir}&offset=${offset}&q=${encodeURIComponent(query)}`,
    );
    setTotal(r.total);
    setRows((old) => (offset && old ? [...old, ...r.canvases] : r.canvases));
    done();
  };
  useEffect(() => {
    const timer = setTimeout(() => load().catch(() => {}), query ? 200 : 0);
    return () => clearTimeout(timer);
  }, [query, sort, tick]);
  const block = async (c: Row) => {
    await api(`/api/admin/canvases/${c.id}/${c.blocked ? "unblock" : "block"}`, { method: "POST" });
    setRows((old) => old && old.map((r) => (r.id === c.id ? { ...r, blocked: !c.blocked } : r)));
  };
  const erase = async (c: Row) => {
    if (armed !== c.id) return setArmed(c.id);
    setArmed(null);
    await api(`/api/admin/canvases/${c.id}`, { method: "DELETE" });
    setRows((old) => old && old.filter((r) => r.id !== c.id));
    setTotal((n) => n - 1);
  };
  const max = (k: "shapes" | "members" | "images") => Math.max(0, ...(rows ?? []).map((r) => r[k]));
  const th = (k: string, label: string, first: "asc" | "desc" = "desc", className?: string) => (
    <SortTh k={k} sort={sort} onSort={setSort} first={first} className={className}>
      {label}
    </SortTh>
  );
  return (
    <div className="a-card span-12">
      <div className="toolbar">
        <input
          className="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Title, canvas address or owner's email"
          aria-label="Search canvases"
        />
        <span className="count">{num(total)} canvases</span>
      </div>
      {rows && !rows.length ? (
        <Empty text={query ? "No canvas matches this search." : "No canvas yet."} />
      ) : (
        <div className="table-scroll">
          <table className="data">
            <thead>
              <tr>
                {th("title", "Canvas", "asc")}
                {th("owner", "Owner", "asc", "left")}
                {th("shapes", "Shapes")}
                {th("members", "Members")}
                {th("images", "Images")}
                {th("created", "Created")}
                {th("updated", "Changed")}
                <th />
              </tr>
            </thead>
            <tbody>
              {(rows ?? []).map((c) => (
                <tr key={c.id} className={c.deleted ? "muted" : ""}>
                  <td>
                    <a href={`/c/${c.id}?watch`} target="_blank" rel="noopener">
                      {c.title || "Untitled"}
                    </a>
                    {c.here > 0 && <span className="now-tag">{c.here} here</span>}
                    {c.blocked && <span className="tag">taken down</span>}
                    {c.deleted && <span className="tag">in the trash</span>}
                    <small className="sub">{ACCESS[c.access] ?? c.access}</small>
                  </td>
                  <td className="left">
                    <Link to={`/admin/people/${encodeURIComponent(c.owner.id)}`}>{c.owner.email ?? c.owner.name}</Link>
                    {c.owner.guest && <span className="tag">guest</span>}
                  </td>
                  <td>
                    <Inline n={c.shapes} max={max("shapes")} />
                  </td>
                  <td>{c.members ? <Inline n={c.members} max={max("members")} /> : ""}</td>
                  <td>{c.images ? <Inline n={c.images} max={max("images")} /> : ""}</td>
                  <td>{date(c.created)}</td>
                  <td>{since(c.updated)}</td>
                  <td>
                    <div className="actions">
                      <button className="btn small" onClick={() => block(c)}>
                        {c.blocked ? "Put back" : "Take down"}
                      </button>
                      <button
                        className={"btn small danger" + (armed === c.id ? " armed" : "")}
                        onBlur={() => setArmed(null)}
                        onClick={() => erase(c)}
                      >
                        {armed === c.id ? "Sure?" : "Delete"}
                      </button>
                    </div>
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
    </div>
  );
}
