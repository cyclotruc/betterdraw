// The app frame: canvases in a sidebar on the left (a drawer on phones), the canvas on the right.
import { onLimit } from "./extend";
import { useEffect, useRef, useState } from "react";
import type { ExcalidrawImperativeAPI } from "@betterdraw/editor/types";
import { api, ApiError, type CanvasRow, type Here, type Me, type Project } from "./api";
import { CanvasPage } from "./CanvasPage";
import { Dashboard } from "./Dashboard";
import { Confirm } from "./Dialog";
import { Settings } from "./Settings";
import { Join } from "./Join";
import { Sidebar, type Place } from "./Sidebar";
import { FeedbackButton } from "./Feedback";
import { leaving, navigate, useMedia } from "./nav";
import { t } from "./texts";
import { toast } from "./toast";
import { importFile } from "./importScene";

// Excalidraw's top bar needs about 780 px with Share, more with our other buttons (CanvasPage moves what does
// not fit). Below 1200 px a permanent sidebar would squeeze it too much, so the sidebar becomes a drawer
// (opened from the button at the top left of the canvas or with Ctrl+.).
export const MOBILE = "(max-width: 1200px), (max-height: 500px)";
const label = (title: string) => title || t("untitled");
// A new project takes the next of these colors.
const COLORS = ["#4263eb", "#0b7285", "#c2255c", "#2b8a3e", "#e8590c", "#7048e8", "#1971c2", "#e67700"];

export function Shell({ me, setMe, canvasId }: { me: Me; setMe: (m: Me) => void; canvasId: string | null }) {
  const mobile = useMedia(MOBILE);
  const [open, setOpen] = useState(() => !matchMedia(MOBILE).matches);
  const [list, setList] = useState<CanvasRow[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [settings, setSettings] = useState(false);
  const [joining, setJoining] = useState(false);
  const [asking, setAsking] = useState<CanvasRow | null>(null);
  const [here, setHere] = useState<Record<string, Here[]>>({});
  const fileInput = useRef<HTMLInputElement>(null);
  const editor = useRef<ExcalidrawImperativeAPI | null>(null);
  const refresh = () => {
    api<CanvasRow[]>("/api/canvases")
      .then(setList)
      .catch(() => {});
    api<Project[]>("/api/projects")
      .then(setProjects)
      .catch(() => {});
  };
  useEffect(() => {
    refresh();
  }, [canvasId]);
  // Who is on each canvas: asked every 10 seconds while this tab is in view.
  useEffect(() => {
    const ask = () => {
      if (!document.hidden)
        api<Record<string, Here[]>>("/api/presence")
          .then(setHere)
          .catch(() => {});
    };
    ask();
    const timer = setInterval(ask, 10_000);
    addEventListener("visibilitychange", ask);
    return () => {
      clearInterval(timer);
      removeEventListener("visibilitychange", ask);
    };
  }, [canvasId]);
  // Canvases an agent worked on while this person was elsewhere: a dot on their row until they open them.
  const [agentWorked, setAgentWorked] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    const busy = Object.entries(here)
      .filter(([id, list]) => id !== canvasId && list.some((h) => h.agent && !h.idle))
      .map(([id]) => id);
    if (busy.some((id) => !agentWorked.has(id))) setAgentWorked((s) => new Set([...s, ...busy]));
  }, [here]);
  useEffect(() => {
    if (canvasId && agentWorked.has(canvasId)) setAgentWorked((s) => new Set([...s].filter((id) => id !== canvasId)));
  }, [canvasId]);
  useEffect(() => {
    setOpen(!mobile);
  }, [mobile]);
  const soon = useNext(me.anonymous ? list : [], refresh);
  // A guest's canvases are deleted some hours after they are made (GUEST_CANVAS_HOURS): closing the tab asks
  // first while one of theirs that will be has a drawing. Browsers show their own words, not ours.
  useEffect(() => {
    if (!me.anonymous) return;
    const expiring = (c?: CanvasRow) => !!c?.mine && !!c.expires_at;
    const onLeave = (e: BeforeUnloadEvent) => {
      if (leaving.onPurpose) return;
      const drawing = editor.current?.getSceneElements().length && expiring(list.find((c) => c.id === canvasId));
      if (!drawing && !list.some((c) => expiring(c) && Number(c.live) > 0)) return;
      e.preventDefault();
      e.returnValue = "";
    };
    addEventListener("beforeunload", onLeave);
    return () => removeEventListener("beforeunload", onLeave);
  }, [me.anonymous, list, canvasId]);
  // Ctrl+. is taken before Excalidraw sees it: on AZERTY, "." needs Shift, and Excalidraw reads Ctrl+Shift
  // and that key as a smaller font. Not from a modal, whose keys stay in it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key !== ".") return;
      if (e.target instanceof Element && e.target.closest('[aria-modal="true"]')) return;
      e.preventDefault();
      e.stopPropagation();
      setOpen((o) => !o);
    };
    addEventListener("keydown", onKey, true);
    return () => removeEventListener("keydown", onKey, true);
  }, []);

  const go = (id: string) => {
    navigate(`/c/${id}`);
    if (mobile) setOpen(false);
  };
  const home = () => {
    navigate("/canvases");
    if (mobile) setOpen(false);
  };
  // Zen mode closes the sidebar, and opens it again on the way out if it was open.
  const reopen = useRef(false);
  const zen = (on: boolean) => {
    if (on) {
      reopen.current = open;
      setOpen(false);
    } else if (reopen.current) {
      reopen.current = false;
      setOpen(true);
    }
  };
  // A canvas could not be made or brought back: the limit of canvases says so, anything else is a plain error.
  const refused = (e: unknown) => {
    const limit = e instanceof ApiError && e.code === "quota_canvases";
    toast(limit ? t("quotaCanvases") : t("err_generic"));
    if (limit) onLimit("canvases");
  };
  const create = async (projectId: string | null = null) => {
    try {
      const { id } = await api<{ id: string }>("/api/canvases", { method: "POST", body: "{}" });
      if (projectId)
        await api(`/api/canvases/${id}/place`, { method: "PATCH", body: JSON.stringify({ project_id: projectId }) }).catch(() => {});
      go(id);
    } catch (e) {
      refused(e);
    }
  };
  const importPicked = async (file?: File) => {
    if (!file) return;
    const id = await importFile(file).catch(() => null);
    if (id) go(id);
  };

  const renameTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const rename = (title: string) => {
    setList((l) => l.map((c) => (c.id === canvasId ? { ...c, title } : c)));
    clearTimeout(renameTimer.current);
    renameTimer.current = setTimeout(
      () => api(`/api/canvases/${canvasId}`, { method: "PATCH", body: JSON.stringify({ title }) }).catch(() => {}),
      400,
    );
  };
  const renameCanvas = (c: CanvasRow, title: string) => {
    if (c.id === canvasId) return rename(title);
    setList((l) => l.map((x) => (x.id === c.id ? { ...x, title } : x)));
    api(`/api/canvases/${c.id}`, { method: "PATCH", body: JSON.stringify({ title }) }).catch(refresh);
  };

  // Delete (owner) or leave (shared), once confirmed. Undo stays in the toast for a few seconds.
  const remove = async (c: CanvasRow) => {
    const mine = !!c.mine;
    const done = await api(`/api/canvases/${c.id}`, { method: "DELETE" }).catch(() => null);
    if (!done) return toast(t("err_generic"));
    setList((l) => l.filter((x) => x.id !== c.id));
    if (c.id === canvasId) navigate("/", true);
    toast(mine ? t("deleted") : t("removed"), {
      label: t("undo"),
      run: async () => {
        // Bringing it back counts against the limit again, which a canvas made since may have reached.
        await (mine ? api(`/api/canvases/${c.id}/restore`, { method: "POST" }) : api(`/api/canvases/${c.id}`)).catch(refused);
        refresh();
      },
    });
  };

  // Where a canvas sits in this person's list. Moving it to another project says so, with Undo.
  const place = (c: CanvasRow, change: Place, quiet = false) => {
    setList((l) => l.map((x) => (x.id === c.id ? { ...x, ...change } : x)));
    api(`/api/canvases/${c.id}/place`, { method: "PATCH", body: JSON.stringify(change) }).catch(refresh);
    const from = c.project_id ?? null;
    if (quiet || change.project_id === undefined || change.project_id === from) return;
    const name = projects.find((p) => p.id === change.project_id)?.name ?? t("recent");
    toast(t("movedTo", { title: label(c.title), project: name }), {
      label: t("undo"),
      run: () => place({ ...c, ...change }, { project_id: from }, true),
    });
  };
  const addProject = async (name: string) => {
    const color = COLORS[projects.length % COLORS.length];
    const p = await api<Project>("/api/projects", { method: "POST", body: JSON.stringify({ name, color }) }).catch(() => null);
    if (p) setProjects((ps) => [...ps, p]);
  };
  const renameProject = (p: Project, name: string) => {
    if (!name || name === p.name) return;
    setProjects((ps) => ps.map((x) => (x.id === p.id ? { ...x, name } : x)));
    api(`/api/projects/${p.id}`, { method: "PATCH", body: JSON.stringify({ name }) }).catch(refresh);
  };
  // Deleting a project keeps its canvases, back in no project. Undo files them in the project again.
  const deleteProject = async (p: Project) => {
    const inside = list.filter((c) => c.project_id === p.id);
    setProjects((ps) => ps.filter((x) => x.id !== p.id));
    setList((l) => l.map((c) => (c.project_id === p.id ? { ...c, project_id: null } : c)));
    await api(`/api/projects/${p.id}`, { method: "DELETE" }).catch(() => {});
    toast(t("projectDeleted", { name: p.name }), {
      label: t("undo"),
      run: async () => {
        const back = await api<Project>("/api/projects", { method: "POST", body: JSON.stringify({ name: p.name, color: p.color }) }).catch(
          () => null,
        );
        if (back)
          await Promise.all(
            inside.map((c) =>
              api(`/api/canvases/${c.id}/place`, { method: "PATCH", body: JSON.stringify({ project_id: back.id }) }).catch(() => {}),
            ),
          );
        refresh();
      },
    });
  };

  return (
    <div className={"shell" + (open ? "" : " side-closed") + (mobile ? " mobile" : "")}>
      {mobile && open && <div className="scrim" onClick={() => setOpen(false)} />}
      <Sidebar
        me={me}
        list={list}
        projects={projects}
        here={here}
        agentWorked={agentWorked}
        canvasId={canvasId ?? ""}
        open={open}
        mobile={mobile}
        onHide={() => setOpen(false)}
        onShow={() => setOpen(true)}
        go={go}
        home={home}
        create={create}
        pickFile={() => fileInput.current?.click()}
        openSettings={() => setSettings(true)}
        openJoin={() => setJoining(true)}
        next={soon}
        remove={setAsking}
        rename={renameCanvas}
        place={place}
        addProject={addProject}
        renameProject={renameProject}
        deleteProject={deleteProject}
      />
      <input
        ref={fileInput}
        type="file"
        accept=".excalidraw,.json,application/json"
        hidden
        onChange={(e) => {
          importPicked(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
      {settings && <Settings me={me} setMe={setMe} next={soon} onJoin={() => setJoining(true)} onClose={() => setSettings(false)} />}
      {joining && <Join next={soon} onClose={() => setJoining(false)} />}
      {asking && (
        <Confirm
          title={asking.mine ? t("deleteAsk") : t("removeAsk")}
          text={t(asking.mine ? "deleteAskText" : "removeAskText", { title: label(asking.title) })}
          action={asking.mine ? t("deleteCanvas") : t("remove")}
          onConfirm={() => remove(asking)}
          onClose={() => setAsking(null)}
        />
      )}
      <main className="main">
        {canvasId ? (
          <CanvasPage
            key={canvasId}
            canvasId={canvasId}
            me={me}
            title={list.find((c) => c.id === canvasId)?.title}
            onReady={refresh}
            sidebarOpen={open}
            onOpenSidebar={() => setOpen(true)}
            onZen={zen}
            onImport={importPicked}
            editorRef={editor}
          />
        ) : (
          <Dashboard
            list={list}
            projects={projects}
            here={here}
            sidebarOpen={open}
            onOpenSidebar={() => setOpen(true)}
            go={go}
            create={create}
            pickFile={() => fileInput.current?.click()}
            remove={setAsking}
            place={place}
          />
        )}
        {!canvasId && <FeedbackButton />}
      </main>
    </div>
  );
}

// The guest's canvas deleted first and the time it has left, as "23h 12m", updated every 20 seconds. When it
// runs out, the list is asked again until the server has removed the canvas (it checks every minute).
function useNext(list: CanvasRow[], refresh: () => void) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 20_000);
    return () => clearInterval(timer);
  }, []);
  const next = list
    .filter((c) => c.mine && c.expires_at)
    .reduce<CanvasRow | null>((a, c) => (!a || Date.parse(c.expires_at!) < Date.parse(a.expires_at!) ? c : a), null);
  const soonest = next ? Date.parse(next.expires_at!) : Infinity;
  const ms = soonest - now;
  useEffect(() => {
    if (isFinite(soonest) && ms <= 0) {
      const timer = setInterval(refresh, 30_000);
      return () => clearInterval(timer);
    }
  }, [isFinite(soonest) && ms <= 0]);
  if (!next) return null;
  const m = Math.max(1, Math.ceil(ms / 60_000));
  return { title: label(next.title), left: m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m` : `${m}m` };
}
