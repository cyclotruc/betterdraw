// The sidebar: favorite canvases on top, then the person's own projects (fold them, rename them, drop canvases
// in), their recent canvases outside projects and those shared with them. Search filters every title; next
// to it, a JSON file comes in as a new canvas.
import { useEffect, useRef, useState, type CSSProperties, type DragEvent, type ReactNode } from "react";
import { useConfig, type CanvasRow, type Here, type Me, type Project } from "./api";
import brand from "../../branding/brand.json";
import { Icon, PATH } from "./Icon";
import { Logo } from "./Logo";
import { avatarSrc } from "./avatar";
import { t } from "./texts";
import { navigate } from "./nav";
import { useAdminView } from "./prefs";
import { BrandBadge } from "./extend";

// A guest's canvas deleted first: its title and the time it has left.
export type Next = { title: string; left: string };
export type Place = { project_id?: string | null; pinned?: boolean };
type Props = {
  me: Me;
  list: CanvasRow[];
  projects: Project[];
  here: Record<string, Here[]>;
  agentWorked: Set<string>; // canvases an agent worked on since this person last opened them
  canvasId: string;
  open: boolean;
  mobile: boolean;
  onHide: () => void;
  onShow: () => void;
  go: (id: string) => void;
  home: () => void;
  create: (projectId?: string | null) => void;
  pickFile: () => void;
  openSettings: () => void;
  openJoin: () => void;
  next: Next | null; // a guest's canvas deleted first
  remove: (c: CanvasRow) => void;
  rename: (c: CanvasRow, title: string) => void;
  place: (c: CanvasRow, change: Place) => void;
  addProject: (name: string) => void;
  renameProject: (p: Project, name: string) => void;
  deleteProject: (p: Project) => void;
};

const WIDTH = "bd-sidebar-width";
// The narrowest still fits the wordmark, a badge after it and the hide button on one line.
const MIN_W = 236;
const MAX_W = 440;
const savedWidth = () => {
  try {
    return Math.max(MIN_W, Math.min(MAX_W, Number(localStorage.getItem(WIDTH)) || 280));
  } catch {
    return 280;
  }
};
const label = (c: CanvasRow) => c.title || t("untitled");

// The canvas being dragged, kept here so drop zones can light up while it moves.
let dragging: string | null = null;
export const dragProps = (id: string) => ({
  draggable: true,
  onDragStart: (e: DragEvent) => {
    dragging = id;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", id);
  },
  onDragEnd: () => {
    dragging = null;
  },
});

function DropZone({ onDrop, className, children }: { onDrop: (id: string) => void; className: string; children: ReactNode }) {
  const [over, setOver] = useState(false);
  return (
    <div
      className={className + (over ? " drop" : "")}
      onDragOver={(e) => {
        if (!dragging) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        if (!over) setOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const id = dragging;
        dragging = null;
        if (id) onDrop(id);
      }}
    >
      {children}
    </div>
  );
}

function Hl({ text, q }: { text: string; q: string }) {
  const i = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <mark>{text.slice(i, i + q.length)}</mark>
      {text.slice(i + q.length)}
    </>
  );
}

function Star({ c, p }: { c: CanvasRow; p: Props }) {
  const on = !!c.pinned;
  return (
    <button
      type="button"
      className={"mini-btn" + (on ? " starred" : "")}
      aria-pressed={on}
      aria-label={`${on ? t("unfavorite") : t("favorite")}: ${label(c)}`}
      title={on ? t("unfavorite") : t("favorite")}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        p.place(c, { pinned: !on });
      }}
    >
      <Icon d={PATH.star} size={14} />
    </button>
  );
}

// Who else is on a canvas, as small avatars at the end of its row; an idle one is faded.
export function People({ list }: { list: Here[] }) {
  const shown = list.slice(0, 3);
  const names = list.map((h) => h.name).join(", ");
  return (
    <span className="entry-here" title={names} aria-label={t("onCanvas", { names })}>
      {shown.map((h) => (
        <img key={h.id} className={"face" + (h.idle ? " idle" : "")} src={avatarSrc(h.name, h.image, h.agent)} alt="" />
      ))}
      {list.length > 3 && <span className="face more">+{list.length - 3}</span>}
    </span>
  );
}

// One canvas: click to open, double-click to rename (its owner), drag onto a project to file it there.
// The bin deletes it, or takes a shared one off the list, once confirmed.
function Entry({ c, p, q = "", lead, meta }: { c: CanvasRow; p: Props; q?: string; lead?: ReactNode; meta?: ReactNode }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const cancel = useRef(false);
  const active = c.id === p.canvasId;
  const people = p.here[c.id];
  const bin = c.mine ? t("deleteCanvas") : t("removeFromList");
  const edit = c.mine
    ? () => {
        cancel.current = false;
        setDraft(c.title);
        setEditing(true);
      }
    : undefined;
  return (
    <div className={"entry" + (active ? " active" : "")} {...(editing ? {} : dragProps(c.id))}>
      {editing ? (
        <input
          className="rename"
          autoFocus
          value={draft}
          placeholder={t("untitled")}
          aria-label={t("canvasTitle")}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") {
              cancel.current = true;
              e.currentTarget.blur();
            }
          }}
          onBlur={() => {
            setEditing(false);
            if (!cancel.current && draft.trim() !== c.title) p.rename(c, draft.trim());
          }}
        />
      ) : (
        <a
          className="entry-link"
          href={`/c/${c.id}`}
          draggable={false}
          aria-current={active ? "page" : undefined}
          title={edit ? t("entryHint") : undefined}
          onClick={(e) => {
            e.preventDefault();
            p.go(c.id);
          }}
          onDoubleClick={edit}
        >
          {lead}
          <span className="entry-title">
            <Hl text={label(c)} q={q} />
          </span>
          {meta && <span className="entry-meta">{meta}</span>}
          {people?.length ? <People list={people} /> : null}
          {!active && p.agentWorked.has(c.id) && <span className="agent-news" title={t("agentWorked")} aria-label={t("agentWorked")} />}
        </a>
      )}
      {!editing && (
        <span className="side-acts">
          <Star c={c} p={p} />
          <button
            type="button"
            className="mini-btn"
            aria-label={`${bin}: ${label(c)}`}
            title={bin}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              p.remove(c);
            }}
          >
            <Icon d={PATH.trash} size={14} />
          </button>
        </span>
      )}
    </div>
  );
}

// A project and its canvases: click to fold, double-click to rename, drop a canvas to file it here.
function Folder({
  name,
  color,
  count,
  open,
  onToggle,
  onDrop,
  onRename,
  onAdd,
  onDelete,
  children,
}: {
  name: string;
  color: string;
  count: number;
  open: boolean;
  onToggle: () => void;
  onDrop: (id: string) => void;
  onRename: (name: string) => void;
  onAdd: () => void;
  onDelete: () => void;
  children: ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const cancel = useRef(false);
  return (
    <DropZone className="folder" onDrop={onDrop}>
      <div className="folder-head">
        {editing ? (
          <input
            className="rename"
            autoFocus
            value={draft}
            aria-label={t("projectName")}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              if (e.key === "Escape") {
                cancel.current = true;
                e.currentTarget.blur();
              }
            }}
            onBlur={() => {
              setEditing(false);
              if (!cancel.current) onRename(draft.trim());
            }}
          />
        ) : (
          <button
            type="button"
            className="folder-btn"
            aria-expanded={open}
            title={t("renameHint")}
            onClick={onToggle}
            onDoubleClick={() => {
              cancel.current = false;
              setDraft(name);
              setEditing(true);
            }}
          >
            <span className="chev">
              <Icon d={PATH.chevron} size={13} />
            </span>
            <span className="folder-icon" style={{ color }}>
              <Icon d={PATH.folder} size={15} />
            </span>
            <span className="folder-name">{name}</span>
            <span className="folder-count">{count}</span>
          </button>
        )}
        {!editing && (
          <span className="side-acts">
            <button
              type="button"
              className="mini-btn"
              aria-label={t("newCanvasIn", { project: name })}
              title={t("newCanvasIn", { project: name })}
              onClick={onAdd}
            >
              <Icon d={PATH.plus} size={14} />
            </button>
            <button type="button" className="mini-btn" aria-label={t("deleteProject")} title={t("deleteProject")} onClick={onDelete}>
              <Icon d={PATH.trash} size={14} />
            </button>
          </span>
        )}
      </div>
      {open && <div className="folder-body">{children}</div>}
    </DropZone>
  );
}

function NewProject({ onDone }: { onDone: (name: string) => void }) {
  const [name, setName] = useState("");
  const cancel = useRef(false);
  return (
    <input
      className="rename"
      autoFocus
      value={name}
      placeholder={t("projectName")}
      aria-label={t("projectName")}
      onChange={(e) => setName(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") {
          cancel.current = true;
          e.currentTarget.blur();
        }
      }}
      onBlur={() => onDone(cancel.current ? "" : name.trim())}
    />
  );
}

export function Sidebar(p: Props) {
  const { list, projects } = p;
  const [q, setQ] = useState("");
  const [shut, setShut] = useState<Record<string, boolean>>({});
  const [adding, setAdding] = useState(false);
  const [width, setWidth] = useState(savedWidth);
  const [resizing, setResizing] = useState(false);
  const adminView = useAdminView(p.me);
  // Guests' canvases do not expire on this server, and none of theirs was made while they did.
  const kept = useConfig()?.guestCanvasHours === 0 && !p.next;
  const search = useRef<HTMLInputElement>(null);
  const show = useRef(p.onShow);
  show.current = p.onShow;

  // Ctrl+K searches the titles. With a shape selected, the editor takes it first, to add a link.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "k") return;
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
      e.preventDefault();
      show.current();
      setTimeout(() => search.current?.focus(), 40);
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!resizing) return;
    const move = (e: PointerEvent) => setWidth(Math.max(MIN_W, Math.min(MAX_W, Math.round(e.clientX))));
    const up = () => setResizing(false);
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    return () => {
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", up);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [resizing]);
  useEffect(() => {
    if (resizing) return;
    try {
      localStorage.setItem(WIDTH, String(width));
    } catch {}
  }, [resizing, width]);

  const query = q.trim();
  const fold = (key: string) => () => setShut((s) => ({ ...s, [key]: !s[key] }));
  const moveTo = (projectId: string | null) => (id: string) => {
    const c = list.find((x) => x.id === id);
    if (c) p.place(c, { project_id: projectId });
  };
  const filed = new Set(projects.map((x) => x.id));
  const inProject = (c: CanvasRow) => !!c.project_id && filed.has(c.project_id);
  // The star of a row makes it a favorite: the Favorites heading only shows once there is one.
  const favorites = list.filter((c) => c.pinned);
  // Outside projects, canvases are a plain list, newest first, as in chat apps. Dropping one there takes it out of its project.
  const loose = list.filter((c) => c.mine && !inProject(c));
  const shared = list.filter((c) => !c.mine && !inProject(c));
  const hits = query ? list.filter((c) => label(c).toLowerCase().includes(query.toLowerCase())) : [];
  const projectOf = (c: CanvasRow) => projects.find((x) => x.id === c.project_id);
  const entry = (c: CanvasRow) => <Entry key={c.id} c={c} p={p} />;

  return (
    <aside
      className={"side" + (p.open ? "" : " hidden")}
      aria-hidden={!p.open}
      style={p.mobile ? undefined : ({ "--side-w": `${width}px` } as CSSProperties)}
    >
      <div className="side-top">
        <a
          className="brand"
          href="/canvases"
          title={t("allCanvases")}
          onClick={(e) => {
            if (e.metaKey || e.ctrlKey || e.shiftKey) return;
            e.preventDefault();
            p.home();
          }}
        >
          <Logo /> {brand.name}
          <BrandBadge />
        </a>
        <button type="button" className="icon-btn" title={`${t("hideSidebar")} (Ctrl+.)`} aria-label={t("hideSidebar")} onClick={p.onHide}>
          <Icon d={PATH.panel} size={17} />
        </button>
      </div>
      <div className="side-find">
        <label className="side-search">
          <Icon d={PATH.search} size={15} />
          <input
            ref={search}
            value={q}
            placeholder={t("search")}
            aria-label={t("searchCanvases")}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setQ("");
              if (e.key === "Enter" && hits[0]) p.go(hits[0].id);
            }}
          />
        </label>
        <button type="button" className="icon-btn" title={t("importFile")} aria-label={t("importFile")} onClick={p.pickFile}>
          <Icon d={PATH.upload} size={17} />
        </button>
        <button type="button" className="icon-btn" title={t("newCanvas")} aria-label={t("newCanvas")} onClick={() => p.create()}>
          <Icon d={PATH.compose} size={17} />
        </button>
      </div>

      <nav className="side-scroll" aria-label={t("myCanvases")}>
        {query ? (
          <>
            <div className="side-sec">{hits.length === 1 ? t("oneCanvas") : t("nCanvases", { n: hits.length })}</div>
            {hits.map((c) => (
              <Entry
                key={c.id}
                c={c}
                p={p}
                q={query}
                lead={
                  <span className="tint-folder" style={{ color: projectOf(c)?.color || "var(--muted)", width: 13 }}>
                    {projectOf(c) && <Icon d={PATH.folder} size={13} />}
                  </span>
                }
                meta={projectOf(c)?.name ?? (c.mine ? t("recent") : t("sharedWithMe"))}
              />
            ))}
            {!hits.length && <p className="side-empty">{t("noMatch", { q: query })}</p>}
          </>
        ) : (
          <>
            {favorites.length > 0 && (
              <DropZone
                className="folder"
                onDrop={(id) => {
                  const c = list.find((x) => x.id === id);
                  if (c && !c.pinned) p.place(c, { pinned: true });
                }}
              >
                <div className="side-sec">{t("favorites")}</div>
                {favorites.map((c) => (
                  <Entry
                    key={c.id}
                    c={c}
                    p={p}
                    lead={
                      <span className="star">
                        <Icon d={PATH.star} size={14} />
                      </span>
                    }
                  />
                ))}
              </DropZone>
            )}

            <div className="side-sec">
              {t("projects")}
              <button
                type="button"
                className="mini-btn"
                aria-label={t("newProject")}
                title={t("newProject")}
                onClick={() => setAdding(true)}
              >
                <Icon d={PATH.plus} size={14} />
              </button>
            </div>
            {projects.map((pr) => {
              const items = list.filter((c) => c.project_id === pr.id);
              return (
                <Folder
                  key={pr.id}
                  name={pr.name}
                  color={pr.color || "var(--muted)"}
                  count={items.length}
                  open={!shut[pr.id]}
                  onToggle={fold(pr.id)}
                  onDrop={moveTo(pr.id)}
                  onRename={(name) => p.renameProject(pr, name)}
                  onAdd={() => p.create(pr.id)}
                  onDelete={() => p.deleteProject(pr)}
                >
                  {items.map(entry)}
                  {!items.length && <p className="side-empty">{t("dropHere")}</p>}
                </Folder>
              );
            })}
            {adding && (
              <NewProject
                onDone={(name) => {
                  setAdding(false);
                  if (name) p.addProject(name);
                }}
              />
            )}
            <DropZone className="folder recent" onDrop={moveTo(null)}>
              <div className="side-sec">{t("recent")}</div>
              {loose.map(entry)}
              {!loose.length && <p className="side-empty">{t("recentEmpty")}</p>}
            </DropZone>
            {shared.length > 0 && (
              <DropZone className="folder" onDrop={moveTo(null)}>
                <div className="side-sec">{t("sharedWithMe")}</div>
                {shared.map(entry)}
              </DropZone>
            )}
          </>
        )}
      </nav>

      <div className="side-bottom">
        {p.me.anonymous && (
          <button type="button" className="guest-card" onClick={p.openJoin}>
            <span className="guest-ic" aria-hidden="true">
              <Icon d={PATH.hourglass} size={16} />
            </span>
            <span className="guest-text">
              <b>{t(kept ? "guestCardKept" : "guestCard")}</b>
              <span>
                {t(kept ? "guestCardKeptSub" : "guestCardSub")}
                {p.next && (
                  <span className="guest-left" title={t("guestCardLeft", p.next)}>
                    {p.next.left}
                  </span>
                )}
              </span>
            </span>
          </button>
        )}
        {adminView && (
          <a
            href="/admin"
            className="guest-card admin-card"
            onClick={(e) => {
              if (e.metaKey || e.ctrlKey) return;
              e.preventDefault();
              navigate("/admin");
            }}
          >
            <span className="guest-ic" aria-hidden="true">
              <Icon d={PATH.chart} size={16} />
            </span>
            <span className="guest-text">
              <b>{t("adminCard")}</b>
              <span>{t("adminCardSub")}</span>
            </span>
          </a>
        )}
        <button type="button" className="me" onClick={p.openSettings} title={t("settings")}>
          <img className="avatar" src={avatarSrc(p.me.name, p.me.image)} alt="" />
          <span className="who">
            {p.me.name}
            <span className="sub">{p.me.anonymous ? t("guestSub") : p.me.email}</span>
          </span>
          <span className="me-gear" aria-hidden="true">
            <Icon d={PATH.settings} size={19} />
          </span>
        </button>
      </div>
      {!p.mobile && (
        <div
          className={"side-resize" + (resizing ? " on" : "")}
          title={t("resizeSidebar")}
          onPointerDown={(e) => {
            e.preventDefault();
            setResizing(true);
          }}
        />
      )}
    </aside>
  );
}
