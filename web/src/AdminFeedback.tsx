// What people sent from the Feedback button, newest first: their words, their screenshots, and what their
// browser and the server knew of the moment. Marked done once handled; deleting removes the screenshots too.
import { useEffect, useState } from "react";
import { api } from "./api";
import { Link, Seg, date, since, useRefresh } from "./Admin";
import { Empty, num } from "./AdminCharts";

type Item = {
  id: string;
  kind: "feedback" | "bug";
  message: string;
  user: { id: string; name: string; email: string | null; guest: boolean } | null;
  context: { browser?: any; server?: any };
  shots: { id: string; mime: string; size: number }[];
  status: "new" | "done";
  created: string;
};

export function FeedbackList() {
  const [status, setStatus] = useState<"new" | "done" | "all">("new");
  const [items, setItems] = useState<Item[] | null>(null);
  const [counts, setCounts] = useState({ new: 0, done: 0 });
  const [armed, setArmed] = useState<string | null>(null);
  const { tick, done } = useRefresh();
  const load = async (offset = 0) => {
    const r = await api<{ counts: { new: number; done: number }; items: Item[] }>(`/api/admin/feedback?status=${status}&offset=${offset}`);
    setCounts(r.counts);
    setItems((old) => (offset && old ? [...old, ...r.items] : r.items));
    done();
  };
  useEffect(() => {
    load().catch(() => {});
  }, [status, tick]);
  const shown = status === "all" ? counts.new + counts.done : counts[status];

  const mark = async (f: Item) => {
    const next = f.status === "new" ? "done" : "new";
    await api(`/api/admin/feedback/${f.id}`, { method: "PATCH", body: JSON.stringify({ status: next }) });
    setCounts((c) => ({ ...c, [f.status]: c[f.status] - 1, [next]: c[next] + 1 }));
    setItems(
      (old) => old && (status === "all" ? old.map((x) => (x.id === f.id ? { ...x, status: next } : x)) : old.filter((x) => x.id !== f.id)),
    );
  };
  const remove = async (f: Item) => {
    if (armed !== f.id) return setArmed(f.id);
    setArmed(null);
    await api(`/api/admin/feedback/${f.id}`, { method: "DELETE" });
    setCounts((c) => ({ ...c, [f.status]: c[f.status] - 1 }));
    setItems((old) => old && old.filter((x) => x.id !== f.id));
  };

  return (
    <div className="feedback-admin">
      <div className="toolbar">
        <Seg
          label="Which"
          value={status}
          onChange={setStatus}
          options={[
            ["new", `To read (${num(counts.new)})`],
            ["done", `Done (${num(counts.done)})`],
            ["all", "All"],
          ]}
        />
      </div>
      {items && !items.length && (
        <Empty text={status === "new" ? "Nothing to read. Feedback and bug reports land here as they are sent." : "Nothing here."} />
      )}
      <div className="fb-list">
        {(items ?? []).map((f) => {
          const b = f.context.browser ?? {};
          const s = f.context.server ?? {};
          const page = typeof b.url === "string" ? b.url.replace(/^https?:\/\/[^/]+/, "") : null;
          const errors: { at: string; message: string; stack?: string }[] = Array.isArray(b.errors) ? b.errors : [];
          return (
            <article key={f.id} className={"a-card fb" + (f.status === "done" ? " done" : "")}>
              <header className="fb-head">
                <span className={"pill fb-kind " + f.kind}>{f.kind === "bug" ? "Bug" : "Feedback"}</span>
                {f.user ? (
                  <Link to={`/admin/people/${encodeURIComponent(f.user.id)}`}>
                    <strong>{f.user.name}</strong>
                  </Link>
                ) : (
                  <strong>Someone</strong>
                )}
                <span className="muted">{f.user ? (f.user.guest ? "guest" : f.user.email) : "not signed in"}</span>
                <span className="muted fb-when" title={date(f.created)}>
                  {since(f.created)}
                </span>
              </header>
              {f.message && <p className="fb-message">{f.message}</p>}
              {f.shots.length > 0 && (
                <div className="fb-shots">
                  {f.shots.map((x) => (
                    <a key={x.id} href={`/api/admin/feedback/${f.id}/shots/${x.id}`} target="_blank" rel="noopener">
                      <img src={`/api/admin/feedback/${f.id}/shots/${x.id}`} alt="Screenshot" loading="lazy" />
                    </a>
                  ))}
                </div>
              )}
              <p className="fb-env">
                {page && (
                  <a href={page.startsWith("/c/") ? page.split(/[?#]/)[0] + "?watch" : page} target="_blank" rel="noopener">
                    {page.length > 60 ? page.slice(0, 60) + "…" : page}
                  </a>
                )}
                {s.device && <span>{s.device}</span>}
                {b.viewport && (
                  <span>
                    {b.viewport.width}×{b.viewport.height}
                    {b.screen?.pixelRatio && b.screen.pixelRatio !== 1 ? ` @${b.screen.pixelRatio}x` : ""}
                  </span>
                )}
                {b.mobile && <span>mobile</span>}
                {b.theme && <span>{b.theme} theme</span>}
                {b.language && <span>{b.language}</span>}
                {s.version && <span>v{s.version}</span>}
                {errors.length > 0 && (
                  <span className="fb-errors">
                    {errors.length} recent {errors.length === 1 ? "error" : "errors"}
                  </span>
                )}
              </p>
              {errors.length > 0 && (
                <details className="fb-details">
                  <summary>Recent errors on their page</summary>
                  <pre>{errors.map((e) => `${e.at}  ${e.message}${e.stack ? "\n" + e.stack : ""}`).join("\n\n")}</pre>
                </details>
              )}
              <details className="fb-details">
                <summary>Everything collected</summary>
                <pre>{JSON.stringify(f.context, null, 2)}</pre>
              </details>
              <footer className="fb-actions">
                <button className="btn small" onClick={() => mark(f)}>
                  {f.status === "new" ? "Mark done" : "Back to read"}
                </button>
                <button
                  className={"btn small danger" + (armed === f.id ? " armed" : "")}
                  onBlur={() => setArmed(null)}
                  onClick={() => remove(f)}
                >
                  {armed === f.id ? "Sure?" : "Delete"}
                </button>
              </footer>
            </article>
          );
        })}
      </div>
      {items && items.length < shown && (
        <button className="btn more" onClick={() => load(items.length)}>
          Show more
        </button>
      )}
    </div>
  );
}
