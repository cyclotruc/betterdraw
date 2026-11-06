// The dashboard, opened from the logo: every canvas of this person's list as a card with a preview, filtered by
// favorites, shared or project, searched and sorted. The sidebar stays beside it.
import { useEffect, useRef, useState, type MouseEvent } from "react";
import { exportScene } from "@betterdraw/editor";
import type { BinaryFiles } from "@betterdraw/editor/types";
import { api, type CanvasRow, type Here, type Project } from "./api";
import { Icon, PATH } from "./Icon";
import { Select } from "./Select";
import { dragProps, People, type Place } from "./Sidebar";
import { resolvedTheme, usePrefs } from "./prefs";
import { ago, t } from "./texts";

type Props = {
  list: CanvasRow[];
  projects: Project[];
  here: Record<string, Here[]>;
  sidebarOpen: boolean;
  onOpenSidebar: () => void;
  go: (id: string) => void;
  create: (projectId?: string | null) => void;
  pickFile: () => void;
  remove: (c: CanvasRow) => void;
  place: (c: CanvasRow, change: Place) => void;
};
type Filter = "all" | "favorites" | "shared" | "loose" | string;
type Preview = { svg: string; background: string };

const label = (c: CanvasRow) => c.title || t("untitled");
// Previews drawn once per canvas version and theme, while the page lives.
const previews = new Map<string, Preview>();

// Drawn from the canvas's elements the first time the card comes into view. Images come from their own route.
function Thumb({ c, dark }: { c: CanvasRow; dark: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const key = `${c.id}:${c.updated_at}`;
  const [shown, setShown] = useState<Preview | null>(() => previews.get(key) ?? null);
  useEffect(() => {
    const cached = previews.get(key);
    if (cached) return setShown(cached);
    let stop = false;
    const io = new IntersectionObserver(
      async ([e]) => {
        if (!e.isIntersecting) return;
        io.disconnect();
        const r = await api<{ elements: any[]; background: string | null }>(`/api/canvases/${c.id}/preview`).catch(() => null);
        if (!r || stop) return;
        const files: BinaryFiles = {};
        for (const el of r.elements)
          if (el.type === "image" && el.fileId)
            files[el.fileId] = {
              id: el.fileId,
              mimeType: "image/png",
              dataURL: `/api/canvases/${c.id}/files/${el.fileId}` as any,
              created: 0,
            };
        const svg = r.elements.length
          ? ((
              await exportScene({
                type: "svg",
                data: { elements: r.elements, files },
                config: { canvasBackgroundColor: false, padding: 12, skipInliningFonts: true },
              }).catch(() => null)
            )?.outerHTML ?? "")
          : "";
        const p = { svg, background: r.background || "#ffffff" };
        previews.set(key, p);
        if (!stop) setShown(p);
      },
      { rootMargin: "300px" },
    );
    io.observe(ref.current!);
    return () => {
      stop = true;
      io.disconnect();
    };
  }, [key]);
  return (
    <div ref={ref} className={"thumb" + (dark ? " dark" : "")} style={{ background: shown?.background ?? "#ffffff" }}>
      {shown?.svg ? (
        <div className="thumb-art" dangerouslySetInnerHTML={{ __html: shown.svg }} />
      ) : (
        shown && <span className="thumb-empty">{t("emptyCanvas")}</span>
      )}
    </div>
  );
}

function Card({ c, p, project, dark }: { c: CanvasRow; p: Props; project?: Project; dark: boolean }) {
  const people = p.here[c.id];
  const bin = c.mine ? t("deleteCanvas") : t("removeFromList");
  const act = (f: () => void) => (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    f();
  };
  return (
    <a
      className="card"
      href={`/c/${c.id}`}
      {...dragProps(c.id)}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey) return;
        e.preventDefault();
        p.go(c.id);
      }}
    >
      <Thumb c={c} dark={dark} />
      <span className="card-acts">
        <button
          type="button"
          className={"mini-btn" + (c.pinned ? " starred" : "")}
          aria-pressed={!!c.pinned}
          title={c.pinned ? t("unfavorite") : t("favorite")}
          aria-label={`${c.pinned ? t("unfavorite") : t("favorite")}: ${label(c)}`}
          onClick={act(() => p.place(c, { pinned: !c.pinned }))}
        >
          <Icon d={PATH.star} size={15} />
        </button>
        <button type="button" className="mini-btn" title={bin} aria-label={`${bin}: ${label(c)}`} onClick={act(() => p.remove(c))}>
          <Icon d={PATH.trash} size={15} />
        </button>
      </span>
      <span className="card-body">
        <span className="card-title">{label(c)}</span>
        <span className="card-meta">
          <Icon d={PATH.clock} size={13} />
          {ago(c.updated_at)}
          {people?.length ? <People list={people} /> : null}
        </span>
        {(project || !c.mine) && (
          <span className="card-tags">
            {project && (
              <span className="tag">
                <span className="tint-folder" style={{ color: project.color || "var(--muted)" }}>
                  <Icon d={PATH.folder} size={12} />
                </span>
                {project.name}
              </span>
            )}
            {!c.mine && <span className="tag">{t("sharedWithMe")}</span>}
          </span>
        )}
      </span>
    </a>
  );
}

export function Dashboard(p: Props) {
  const { list, projects } = p;
  const prefs = usePrefs();
  const dark = resolvedTheme(prefs) === "dark";
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<"updated" | "name">("updated");
  const [up, setUp] = useState(false);

  const filed = new Set(projects.map((x) => x.id));
  const projectOf = (c: CanvasRow) => (c.project_id && filed.has(c.project_id) ? projects.find((x) => x.id === c.project_id) : undefined);
  const tabs: { id: Filter; name: string; color?: string }[] = [
    { id: "all", name: t("allCanvases") },
    ...(list.some((c) => c.pinned) ? [{ id: "favorites", name: t("favorites") }] : []),
    ...(list.some((c) => !c.mine) ? [{ id: "shared", name: t("sharedWithMe") }] : []),
    ...(projects.length ? [{ id: "loose", name: t("noProject") }] : []),
    ...projects.map((x) => ({ id: x.id, name: x.name, color: x.color })),
  ];
  const tab = tabs.find((x) => x.id === filter) ?? tabs[0];
  const query = q.trim().toLowerCase();
  const shown = list
    .filter((c) =>
      tab.id === "all"
        ? true
        : tab.id === "favorites"
          ? c.pinned
          : tab.id === "shared"
            ? !c.mine
            : tab.id === "loose"
              ? !projectOf(c)
              : c.project_id === tab.id,
    )
    .filter((c) => !query || label(c).toLowerCase().includes(query))
    .sort((a, b) => {
      const d = sort === "name" ? label(a).localeCompare(label(b)) : Date.parse(a.updated_at) - Date.parse(b.updated_at);
      return (sort === "name" ? d : -d) * (up ? -1 : 1);
    });

  return (
    <div className="dash">
      <header className="dash-head">
        {!p.sidebarOpen && (
          <button type="button" className="icon-btn" title={t("showSidebar")} aria-label={t("showSidebar")} onClick={p.onOpenSidebar}>
            <Icon d={PATH.panel} size={18} />
          </button>
        )}
        <h1>{tab.name}</h1>
      </header>
      <div className="dash-bar">
        <label className="side-search dash-search">
          <Icon d={PATH.search} size={15} />
          <input
            value={q}
            placeholder={t("searchCanvases")}
            aria-label={t("searchCanvases")}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setQ("");
              if (e.key === "Enter" && shown[0]) p.go(shown[0].id);
            }}
          />
        </label>
        <Select
          className="dash-sort"
          value={sort}
          label={t("sortBy")}
          onChange={setSort}
          options={[
            { value: "updated", label: t("sortUpdated") },
            { value: "name", label: t("sortName") },
          ]}
        />
        <button
          type="button"
          className={"dash-btn square" + (up ? " flip" : "")}
          title={t("reverseOrder")}
          aria-label={t("reverseOrder")}
          aria-pressed={up}
          onClick={() => setUp((u) => !u)}
        >
          <Icon d={PATH.arrowUp} size={16} />
        </button>
        <span className="dash-gap" />
        <button type="button" className="dash-btn" onClick={p.pickFile}>
          <Icon d={PATH.upload} size={16} />
          {t("importCanvas")}
        </button>
        <button type="button" className="dash-btn primary" onClick={() => p.create(tab.id !== "all" && filed.has(tab.id) ? tab.id : null)}>
          <Icon d={PATH.plus} size={16} />
          {t("newCanvas")}
        </button>
      </div>
      <nav className="dash-tabs" aria-label={t("myCanvases")}>
        {tabs.map((x) => (
          <button
            key={x.id}
            type="button"
            className={"dash-tab" + (x.id === tab.id ? " on" : "")}
            aria-pressed={x.id === tab.id}
            onClick={() => setFilter(x.id)}
          >
            {x.color && (
              <span className="tint-folder" style={{ color: x.color }}>
                <Icon d={PATH.folder} size={14} />
              </span>
            )}
            {x.name}
          </button>
        ))}
      </nav>
      <div className="dash-grid">
        {shown.map((c) => (
          <Card key={c.id} c={c} p={p} project={projectOf(c)} dark={dark} />
        ))}
      </div>
      {!shown.length && <p className="dash-empty">{query ? t("noMatch", { q: q.trim() }) : t("dashEmpty")}</p>}
    </div>
  );
}
