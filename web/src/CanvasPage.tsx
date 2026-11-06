// One canvas: the Excalidraw editor wired to the server, plus sharing and access controls.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import {
  Excalidraw,
  Footer,
  MainMenu,
  WelcomeScreen,
  CaptureUpdateAction,
  convertToExcalidrawElements,
  getCommonBounds,
} from "@betterdraw/editor";
import type { ExcalidrawImperativeAPI, UserToFollow } from "@betterdraw/editor/types";
import { api, ApiError, track, useConfig, type CanvasMeta, type Me } from "./api";
import { Sync, toCollaborators, type AgentChange, type Gone, type Presence, type Status } from "./sync";
import { AgentCards, agentCard } from "./AgentCards";
import { resolvedTheme, setPrefs, usePrefs } from "./prefs";
import { ago, t } from "./texts";
import { toast } from "./toast";
import { Icon, PATH } from "./Icon";
import { Select } from "./Select";
import { Logo } from "./Logo";
import { isSceneFile, takeImport } from "./importScene";
import { navigate, useMedia, watching } from "./nav";
import brand from "../../branding/brand.json";
import { onLimit } from "./extend";
import { keepCard } from "./card";
import { FeedbackButton } from "./Feedback";

type Access = CanvasMeta["link_access"];
type Props = {
  canvasId: string;
  me: Me;
  title?: string; // as the sidebar has it, so that a rename there shows here at once
  onReady: () => void;
  sidebarOpen: boolean;
  onOpenSidebar: () => void;
  onZen: (on: boolean) => void;
  onImport: (f: File) => void;
  editorRef: { current: ExcalidrawImperativeAPI | null }; // set to this canvas's editor while it is open
};

// Excalidraw's phone layout, by its own breakpoints: its toolbar goes to the bottom, and ours take the top left.
const PHONE = "(max-width: 729px), (max-width: 999px) and (max-height: 499px)";
// The same breakpoints for Excalidraw, which measures its editor: the phone layout there, the desktop one
// everywhere else. Never its tablet one, which folds the shape settings into a column of icons.
const formFactor = (w: number, h: number) => (w < 730 || (h < 500 && w < 1000) ? "phone" : "desktop");
export function CanvasPage({ canvasId, me, title, onReady, sidebarOpen, onOpenSidebar, onZen, onImport, editorRef }: Props) {
  const prefs = usePrefs();
  const config = useConfig();
  const [excalidrawAPI, setAPI] = useState<ExcalidrawImperativeAPI | null>(null);
  const [meta, setMeta] = useState<CanvasMeta | null>(null);
  const [gone, setGone] = useState<Gone | null>(null);
  const [online, setOnline] = useState(0); // a count, so cursor moves do not re-render the page
  const [status, setStatus] = useState<Status>("connecting");
  const [offlineLong, setOfflineLong] = useState(false);
  const [zen, setZen] = useState(false);
  const [width, setWidth] = useState(() => innerWidth);
  const sync = useRef<Sync | null>(null);
  const zenNow = useRef(false);
  const themeNow = useRef<string | null>(null);
  const lastPointer = useRef(0);
  // Following someone (a click on their avatar): our view takes theirs, or for an agent what it works on.
  const [follow, setFollow] = useState<(UserToFollow & { color: string }) | null>(null);
  const following = useRef<{ id: string; seen: string } | null>(null);
  const people = useRef<Presence[]>([]);
  const viewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The tab's title: the canvas's name, after the count of agent changes made while the tab was hidden.
  const tabTitle = useRef(brand.name);
  const unseen = useRef(0);
  const showTabTitle = () => (document.title = (unseen.current ? `(${unseen.current}) ` : "") + tabTitle.current);
  const phone = useMedia(PHONE);
  const wide = useMedia("(min-width: 1536px)");
  const resizes = useRef<ResizeObserver | null>(null);
  const toolbarWidth = useToolbarWidth(excalidrawAPI);
  const editor = useRef<ExcalidrawImperativeAPI | null>(null);
  editor.current = excalidrawAPI;
  // The canvas's width. When its left edge moves (the sidebar folding away for zen mode or Ctrl+., coming back,
  // or resized), the drawing stays where it is on the screen instead of moving with the edge. Each step is applied
  // at once: the next one, a frame later, starts from it.
  const measure = useCallback((el: HTMLDivElement | null) => {
    resizes.current?.disconnect();
    if (!el) return;
    let left = el.getBoundingClientRect().left;
    resizes.current = new ResizeObserver(([e]) => {
      setWidth(e.contentRect.width);
      const now = el.getBoundingClientRect().left;
      const ex = editor.current;
      if (ex && now !== left) {
        const { scrollX, zoom } = ex.getAppState();
        flushSync(() => ex.updateScene({ appState: { scrollX: scrollX + (left - now) / zoom.value } }));
      }
      left = now;
    });
    resizes.current.observe(el);
  }, []);

  // The editor for the shell, and for poking at the canvas from the browser console.
  useEffect(() => {
    editorRef.current = excalidrawAPI;
    Object.assign(window, { __exApi: excalidrawAPI, __ex: { convertToExcalidrawElements, CaptureUpdateAction } });
    return () => {
      editorRef.current = null;
    };
  }, [excalidrawAPI]);

  useEffect(() => {
    api<CanvasMeta>(`/api/canvases/${canvasId}${watching() ? "?watch" : ""}`)
      .then((m) => {
        setMeta(m);
        onReady();
      })
      .catch((e) => {
        const why: Gone =
          e instanceof ApiError ? (e.code === "blocked" ? "blocked" : e.code === "not_found" ? "not_found" : "private") : "not_found";
        // Signing in removes the guest's empty canvas: go to the account's most recent one instead.
        let fresh = false;
        try {
          fresh = sessionStorage.getItem("justSignedIn") === "1";
          sessionStorage.removeItem("justSignedIn");
        } catch {}
        if (fresh && why === "not_found") return navigate("/", true);
        setGone(why);
      });
  }, [canvasId]);

  useEffect(() => {
    if (!excalidrawAPI || !meta || meta.role === "viewer") return;
    return keepCard(canvasId, excalidrawAPI, meta.card_stale);
  }, [excalidrawAPI, meta?.id]);

  // What we see goes out with our presence, at most every 80 ms, the last position always.
  const sendView = () => {
    if (viewTimer.current) return;
    viewTimer.current = setTimeout(() => {
      viewTimer.current = null;
      const a = excalidrawAPI?.getAppState();
      if (!a) return;
      const [x, y, z] = [-a.scrollX, -a.scrollY, a.zoom.value];
      sync.current?.presence({ view: [x, y, x + a.width / z, y + a.height / z] });
    }, 80);
  };
  const keepUp = () => {
    const f = following.current;
    if (!f || !excalidrawAPI) return;
    const p = people.current.find((x) => x.id === f.id);
    if (!p) return void stopFollowing();
    const box = p.agent ? p.focus : p.view;
    const seen = JSON.stringify(box);
    if (!box || seen === f.seen) return;
    f.seen = seen;
    const [x0, y0, x1, y1] = box;
    excalidrawAPI.setViewport({
      target: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 },
      fit: p.agent ? "scale-down" : "contain",
      keepFollowing: true,
    });
  };
  const startFollowing = (u: UserToFollow) => {
    const p = people.current.find((x) => x.id === u.socketId);
    following.current = { id: u.socketId, seen: "" };
    setFollow({ ...u, color: p?.color ?? "var(--accent)" });
    keepUp();
  };
  const stopFollowing = () => {
    following.current = null;
    setFollow(null);
  };

  useEffect(() => {
    if (!excalidrawAPI || !meta) return;
    stopFollowing();
    const s = new Sync(canvasId, excalidrawAPI, me.name);
    s.onPresence = (list) => {
      people.current = list;
      setOnline(list.filter((p) => !p.agent).length);
      excalidrawAPI.updateScene({ collaborators: toCollaborators(list, s.me.connId) });
      keepUp();
    };
    s.onStatus = setStatus;
    s.onGone = setGone;
    s.onError = (code) => {
      const max = config?.maxFileMb ?? 10;
      const messages: Record<string, string> = {
        image_too_big: t("imageTooBig", { mb: max }),
        image_unsupported_type: t("imageType"),
        image_quota_storage: t("quotaStorage"),
        image_private: t("readOnly"),
        image_failed: t("imageFailed"),
        read_only: t("readOnly"),
        refused: t("refused"),
        too_many: t("refused"),
      };
      toast(messages[code] ?? t("err_generic"));
      if (code === "image_quota_storage") onLimit("storage");
    };
    s.onWelcome = (_role, first) => {
      sendView();
      if (!first) return;
      try {
        sessionStorage.removeItem("justSignedIn");
      } catch {}
      const imported = takeImport(canvasId);
      if (imported) {
        excalidrawAPI.addFiles(Object.values(imported.files));
        excalidrawAPI.updateScene({ elements: imported.elements, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
        excalidrawAPI.setViewport({ target: imported.elements, fit: "scale-down", offsets: { ui: true } });
      }
    };
    // What an agent changed: a card for everyone here, which shows the change when clicked.
    // Changes by the same agent a few seconds apart add up; a hidden tab counts them in its title.
    let last: { change: AgentChange; at: number } | null = null;
    s.onAgentChange = (change) => {
      if (last && last.change.seat === change.seat && Date.now() - last.at < 10_000)
        change = { ...change, before: new Map([...change.before, ...last.change.before]) };
      last = { change, at: Date.now() };
      const { what, shown, count } = describeChange(change, excalidrawAPI);
      agentCard({
        key: change.seat,
        name: change.name,
        what,
        onShow: () => shown.length && showChange(excalidrawAPI, shown),
      });
      if (document.hidden) ((unseen.current += count), showTabTitle());
    };
    const seen = () => {
      if (document.hidden || !unseen.current) return;
      unseen.current = 0;
      showTabTitle();
    };
    document.addEventListener("visibilitychange", seen);
    sync.current = s;
    return () => {
      document.removeEventListener("visibilitychange", seen);
      unseen.current = 0;
      showTabTitle();
      s.close();
      sync.current = null;
    };
  }, [excalidrawAPI, meta?.id]);

  useEffect(() => {
    sync.current?.setName(me.name);
  }, [me.name]);

  // A short blip is not worth a banner; a real outage is. Retries switch between offline and connecting,
  // so what counts is how long it has not been online.
  const down = status !== "online";
  useEffect(() => {
    if (!down) return setOfflineLong(false);
    const timer = setTimeout(() => setOfflineLong(true), 3000);
    return () => clearTimeout(timer);
  }, [down]);

  const setAccess = async (link_access: Access) => {
    await api(`/api/canvases/${canvasId}`, { method: "PATCH", body: JSON.stringify({ link_access }) });
    setMeta((m) => m && { ...m, link_access });
  };

  // The title Excalidraw exports under and agents are told, kept up with a rename in the sidebar. Excalidraw
  // reads its name prop only once, so its own copy is set too.
  useEffect(() => {
    if (title !== undefined) setMeta((m) => (m && m.title !== title ? { ...m, title } : m));
  }, [title]);
  useEffect(() => {
    if (meta) excalidrawAPI?.updateScene({ appState: { name: meta.title || t("untitled") } });
  }, [meta?.title, excalidrawAPI]);
  // The browser tab goes by the canvas's name too, and back to the app's when the canvas closes.
  useEffect(() => {
    if (!meta) return;
    tabTitle.current = `${meta.title || t("untitled")} · ${brand.name}`;
    showTabTitle();
    return () => {
      tabTitle.current = brand.name;
      showTabTitle();
    };
  }, [meta?.title]);

  // Dropping an .excalidraw file opens it as a new canvas instead of replacing this one.
  const onDropCapture = (e: React.DragEvent) => {
    const file = e.dataTransfer?.files?.[0];
    if (file && isSceneFile(file)) {
      e.preventDefault();
      e.stopPropagation();
      onImport(file);
    }
  };

  if (gone) {
    const text = gone === "blocked" ? t("blocked") : gone === "private" ? t("private") : t("notFound");
    return (
      <div className="page">
        <h1>{text}</h1>
        {gone === "private" && <p>{t("privateHint")}</p>}
        <button className="btn primary" onClick={() => navigate("/", true)}>
          {t("openMyCanvases")}
        </button>
      </div>
    );
  }
  if (!meta) return null;
  const exportImage = () => excalidrawAPI?.updateScene({ appState: { openDialog: { name: "imageExport" } } });
  const share = <ShareMenu meta={meta} onAccess={setAccess} onExportImage={exportImage} />;
  const topRight = <div className="topright">{share}</div>;
  // The room our buttons get at the top right: Excalidraw's top bar is a grid that keeps 104 px for its margins,
  // gaps and left column (168 px on screens 1536 px wide, where its gaps grow), and its toolbar is measured (none
  // in view mode). As measured, Share needs 50 px, the dark mode button 52 more, the Share label 26 more, the
  // others' avatars 132. With less, Share moves to the bottom right, and dark mode stays in Settings and its
  // shortcut.
  const room = width - toolbarWidth - (wide ? 168 : 104) - (online > 1 ? 132 : 0);
  const shareUp = room >= 50;
  const themeUp = room >= 102;
  const labels = room >= 128;

  // No editor menu: what Excalidraw's held lives in the sidebar, next to Share and at the bottom right. The
  // empty menu below keeps the default one from mounting, and shows no button.
  return (
    <div ref={measure} className={"excalidraw-wrapper" + (labels ? "" : " compact")} onDropCapture={onDropCapture}>
      <Excalidraw
        onExcalidrawAPI={setAPI}
        viewModeEnabled={meta.role === "viewer"}
        theme={resolvedTheme(prefs)}
        name={meta.title || t("untitled")}
        handleKeyboardGlobally
        UIOptions={{
          canvasActions: { loadScene: false, clearCanvas: false, saveToActiveFile: false, toggleTheme: true },
          getFormFactor: formFactor,
        }}
        initialData={meta.background ? { appState: { viewBackgroundColor: meta.background } } : undefined}
        onChange={(elements, appState, files) => {
          sync.current?.pushChanged(elements);
          sync.current?.uploadFiles(files);
          sync.current?.select(appState.selectedElementIds as Record<string, true>);
          // Alt+Shift+D, Excalidraw's theme shortcut, picks the theme as the button next to Share does. Only
          // a change of Excalidraw's own theme counts: right after the button, it still reports the old one.
          if (appState.theme !== themeNow.current) {
            const shortcut = themeNow.current !== null && appState.theme !== resolvedTheme(prefs);
            themeNow.current = appState.theme;
            if (shortcut) setPrefs({ theme: appState.theme });
          }
          if (appState.zenModeEnabled !== zenNow.current) {
            zenNow.current = appState.zenModeEnabled;
            setZen(appState.zenModeEnabled);
            onZen(appState.zenModeEnabled);
          }
        }}
        onScrollChange={sendView}
        userToFollow={follow}
        onUserFollow={({ userToFollow, action }) => (action === "FOLLOW" ? startFollowing(userToFollow) : stopFollowing())}
        viewportStatusFrame={
          follow && {
            border: follow.color,
            label: { label: t("following", { name: follow.username }), background: follow.color, color: "#fff", onClose: stopFollowing },
          }
        }
        onPointerUpdate={({ pointer, button }) => {
          const now = Date.now();
          if (now - lastPointer.current < 33) return;
          lastPointer.current = now;
          sync.current?.presence({ pointer: { x: pointer.x, y: pointer.y, tool: pointer.tool }, button });
        }}
        renderTopRightUI={(isMobile, appState) =>
          isMobile ? null : (
            <>
              {!appState.zenModeEnabled && shareUp && topRight}
              {!appState.zenModeEnabled && themeUp && <ThemeButton />}
              {appState.zenModeEnabled && (
                <LeaveZenButton onLeave={() => excalidrawAPI?.updateScene({ appState: { zenModeEnabled: false } })} />
              )}
            </>
          )
        }
      >
        <MainMenu />
        <WelcomeScreen>
          <WelcomeScreen.Center>
            <WelcomeScreen.Center.Logo>
              <span className="welcome-logo">
                <Logo /> {brand.name}
              </span>
            </WelcomeScreen.Center.Logo>
            <WelcomeScreen.Center.Heading>{t("welcome")}</WelcomeScreen.Center.Heading>
          </WelcomeScreen.Center>
        </WelcomeScreen>
        <Footer>
          <div className="canvas-foot">
            {!shareUp && topRight}
            <FeedbackButton inline />
            <button
              type="button"
              className="ex-btn"
              aria-label={t("shortcuts")}
              title={`${t("shortcuts")} (?)`}
              onClick={() => excalidrawAPI?.updateScene({ appState: { openDialog: { name: "help" } } })}
            >
              <Icon d={PATH.keyboard} size={20} />
            </button>
          </div>
        </Footer>
      </Excalidraw>
      <div className="canvas-left">
        {!sidebarOpen && !zen && (
          <button
            type="button"
            className="side-show"
            aria-label={t("showSidebar")}
            title={`${t("showSidebar")} (Ctrl+.)`}
            onClick={onOpenSidebar}
          >
            <Icon d={PATH.panel} size={18} />
          </button>
        )}
        {phone && share}
      </div>
      {phone && <FeedbackButton />}
      <AgentCards />
      {watching() && (
        <div className="watch-badge" role="status" title={t("watchingHint")}>
          <Icon d={PATH.eye} size={15} />
          {t("watching")}
        </div>
      )}
      {offlineLong && (
        <div className="banner" role="status">
          <span className="banner-dot" aria-hidden="true" />
          {t("offlineBanner")}
        </div>
      )}
    </div>
  );
}

// Light or dark in one click, next to Share. Settings can still make it follow the system.
function ThemeButton() {
  const dark = resolvedTheme(usePrefs()) === "dark";
  const label = dark ? t("lightMode") : t("darkMode");
  return (
    <button
      type="button"
      className="ex-btn theme-btn"
      aria-label={label}
      title={`${label} (Alt+Shift+D)`}
      onClick={() => setPrefs({ theme: dark ? "light" : "dark" })}
    >
      <Icon d={dark ? PATH.sun : PATH.moon} size={20} />
    </button>
  );
}

// Zen mode (Alt+Z) hides the bars around the canvas. This button shows while it is on, pressed, to bring them
// back (so does Alt+Z).
function LeaveZenButton({ onLeave }: { onLeave: () => void }) {
  const label = t("zenOff");
  return (
    <button type="button" className="ex-btn zen-btn" aria-pressed aria-label={label} title={`${label} (Alt+Z)`} onClick={onLeave}>
      <Icon d={PATH.lotus} size={20} />
    </button>
  );
}

// How wide Excalidraw's toolbar is at the top: 0 without one, in view mode or on phones, where it is at the bottom.
// It comes and goes with the layout and the view mode, so it is looked up again whenever the editor's markup changes.
function useToolbarWidth(ex: ExcalidrawImperativeAPI | null) {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const root = document.querySelector(".excalidraw-wrapper");
    if (!ex || !root) return;
    let bar: Element | null = null;
    const sizes = new ResizeObserver(() => setWidth(bar?.getBoundingClientRect().width ?? 0));
    const find = () => {
      const now = root.querySelector(".App-toolbar-container .App-toolbar");
      if (now === bar) return;
      if (bar) sizes.unobserve(bar);
      bar = now;
      if (bar) sizes.observe(bar);
      else setWidth(0);
    };
    find();
    const watch = new MutationObserver(find);
    watch.observe(root, { childList: true, subtree: true });
    return () => {
      watch.disconnect();
      sizes.disconnect();
    };
  }, [ex]);
  return width;
}

// Bring an agent's change into view with room around it: zoom out until it fits, never in past the
// current zoom or 100%, so a single small shape is not blown up.
function showChange(ex: ExcalidrawImperativeAPI, shown: Parameters<typeof getCommonBounds>[0]) {
  const [x1, y1, x2, y2] = around(shown, 0.6);
  const { zoom, width, height } = ex.getAppState();
  const fits = (x2 - x1) * zoom.value <= width * 0.8 && (y2 - y1) * zoom.value <= height * 0.8;
  ex.setViewport({ target: [x1, y1, x2, y2], fit: fits ? "none" : "scale-down", animation: true, offsets: { ui: true } });
}

// The box around some elements in which they take this share of each side: what the view frames to show them with
// room around.
function around(elements: Parameters<typeof getCommonBounds>[0], share: number) {
  const [x1, y1, x2, y2] = getCommonBounds(elements);
  const [dx, dy] = [((x2 - x1) * (1 / share - 1)) / 2, ((y2 - y1) * (1 / share - 1)) / 2];
  return [x1 - dx, y1 - dy, x2 + dx, y2 + dy] as const;
}

// One Share button opens the ways to share: with people (the address and who it lets in), with AI
// agents (a prompt or an MCP address, both carrying the person's agent link for this canvas), and as an
// image or a JSON file. Each box has its copy button in its top right corner.
function ShareMenu({ meta, onAccess, onExportImage }: { meta: CanvasMeta; onAccess: (v: Access) => void; onExportImage: () => void }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"prompt" | "mcp">("prompt");
  const [agentUrl, setAgentUrl] = useState<string | null>(null);
  const [links, setLinks] = useState<AgentLink[] | null>(null);
  const [showLinks, setShowLinks] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);
  const link = location.origin + location.pathname;
  const loadLinks = () => api<AgentLink[]>(`/api/canvases/${meta.id}/agent-links`).then(setLinks, () => setLinks([]));
  const myLink = () =>
    api<{ url: string }>(`/api/canvases/${meta.id}/agent-link`, { method: "POST" }).then(
      (r) => setAgentUrl(r.url),
      () => setAgentUrl(null),
    );
  const toggle = () => {
    if (open) return setOpen(false);
    setOpen(true);
    setShowLinks(false);
    myLink().then(loadLinks);
  };
  // Turning off your own link gives you a new one at once, so what the panel shows keeps working.
  const turnOff = async (l: AgentLink) => {
    await api(`/api/canvases/${meta.id}/agent-links/${l.id}`, { method: "DELETE" }).catch(() => {});
    if (l.mine) await myLink();
    loadLinks();
  };
  const snippet = !agentUrl
    ? null
    : tab === "prompt"
      ? t("agentPrompt", { app: brand.name, title: meta.title ? ` "${meta.title}"` : "", url: agentUrl })
      : agentUrl;
  return (
    <div className="menu" ref={box}>
      <button className="btn primary share" onClick={toggle} aria-expanded={open} aria-haspopup="dialog" aria-label={t("share")}>
        <span aria-hidden="true" className="share-icon">
          ↗
        </span>
        <span className="share-label">{t("share")}</span>
      </button>
      {open && (
        // Excalidraw listens to the whole page for copy and shortcuts: keep them inside the panel, so that
        // selecting text and pressing Ctrl+C copies that text.
        <div
          className="menu-pop share-pop"
          role="dialog"
          aria-label={t("share")}
          onCopy={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Escape") setOpen(false);
          }}
        >
          <section className="share-sec">
            <h3>
              <Icon d={PATH.users} size={16} />
              {t("shareHumans")}
            </h3>
            <div className="share-row">
              <CopyBox text={link} line track="copy canvas link" />
              <span className="access" title={meta.role === "owner" ? undefined : t("accessOwnerOnly")}>
                <Select<Access>
                  value={meta.link_access}
                  disabled={meta.role !== "owner"}
                  onChange={onAccess}
                  label={t("access")}
                  options={[
                    { value: "edit", label: t("accessEditShort") },
                    { value: "view", label: t("accessViewShort") },
                    { value: "none", label: t("accessNoneShort") },
                  ]}
                />
              </span>
            </div>
          </section>

          <section className="share-sec">
            <div className="agents-head">
              <h3>
                <Icon d={PATH.bot} size={16} />
                {t("shareAgents")}
              </h3>
              <div className="seg" role="tablist" aria-label={t("shareAgents")}>
                {(["prompt", "mcp"] as const).map((k) => (
                  <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>
                    {t(k === "prompt" ? "tabPrompt" : "tabMcp")}
                  </button>
                ))}
              </div>
            </div>
            <CopyBox text={snippet} prose={tab === "prompt"} track={tab === "prompt" ? "copy agent prompt" : "copy MCP setup"} />
            <div className="agents-foot">
              <p className="hint">{t(tab === "prompt" ? "hintPrompt" : "hintMcp")}</p>
              {links && (
                <button className="links-btn" onClick={() => setShowLinks((s) => !s)} aria-expanded={showLinks}>
                  {t("activeLinks", { n: links.length })}{" "}
                  <span className={"caret" + (showLinks ? " up" : "")} aria-hidden="true">
                    ▾
                  </span>
                </button>
              )}
            </div>
            {showLinks && links && (
              <div className="links-list" role="region" aria-label={t("agentLinksTitle")}>
                <p className="menu-title">{t("agentLinksTitle")}</p>
                {links.length === 0 ? (
                  <p className="hint">{t("agentLinksNone")}</p>
                ) : (
                  <ul>
                    {links.map((l) => {
                      const now = !!l.lastUsed && Date.now() - Date.parse(l.lastUsed) < 60_000;
                      return (
                        <li key={l.id}>
                          <span className={"dot" + (now ? "" : " idle")} role="img" aria-label={now ? t("activeNow") : t("idle")} />
                          <span className="grow">{l.mine ? t("you") : l.by}</span>
                          <span className="hint">{l.lastUsed ? t("usedAgo", { when: ago(l.lastUsed) }) : t("keyUnused")}</span>
                          <button className="link-btn danger" onClick={() => turnOff(l)}>
                            {t("turnOff")}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
                <p className="hint">{t("agentLinksHint")}</p>
              </div>
            )}
          </section>
          <div className="share-more">
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onExportImage();
                track("export image");
              }}
            >
              <Icon d={PATH.image} size={16} />
              {t("exportImage")}
            </button>
            <a
              href={`/api/canvases/${meta.id}/download`}
              download
              onClick={() => {
                track("download canvas");
                setOpen(false);
              }}
            >
              <Icon d={PATH.download} size={16} />
              {t("downloadJson")}
            </a>
          </div>
        </div>
      )}
    </div>
  );
}

// "Added 3 shapes and changed 1.", what the card under the agent's name says. A label counts with its shape.
function describeChange(change: AgentChange, api: ExcalidrawImperativeAPI) {
  const now = new Map(api.getSceneElementsIncludingDeleted().map((e) => [e.id, e]));
  let [added, changed, removed] = [0, 0, 0];
  const shown = [];
  for (const [id, was] of change.before) {
    const el = now.get(id);
    if (!el || (el.type === "text" && el.containerId)) continue;
    if (el.isDeleted) removed += was && !was.isDeleted ? 1 : 0;
    else {
      shown.push(el);
      if (!was || was.isDeleted) added++;
      else changed++;
    }
  }
  const shapes = (n: number) => (n === 1 ? t("oneShape") : t("nShapes", { n }));
  const parts = [
    added && t("agentAdded", { shapes: shapes(added) }),
    changed && t("agentChanged", { shapes: shapes(changed) }),
    removed && t("agentRemoved", { shapes: shapes(removed) }),
  ].filter((p): p is string => !!p);
  const what = parts.length > 1 ? parts.slice(0, -1).join(", ") + t("and") + parts[parts.length - 1] : (parts[0] ?? t("agentTouched"));
  const said = what.charAt(0).toUpperCase() + what.slice(1) + ".";
  return { what: said, shown, count: added + changed + removed };
}

type AgentLink = { id: string; mine: boolean; by: string; created: string; lastUsed: string | null };

// Text with its copy button in the top right corner, which turns into a check for a moment once copied.
// The text sits in a read-only field: Excalidraw leaves copying from fields alone, so Ctrl+C works, and a
// click selects all of it. A box is three lines high, more if its text needs them; prose (the prompt) is
// set in the panel's font rather than as code.
// `track` names the copy for the admin dashboard's counts.
function CopyBox({ text, line, prose, track: what }: { text: string | null; line?: boolean; prose?: boolean; track?: string }) {
  const [done, setDone] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => setDone(false), [text]);
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "";
    if (el.scrollHeight > el.clientHeight) el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
  }, [text, prose]);
  const copy = () =>
    text &&
    navigator.clipboard.writeText(text).then(
      () => {
        if (what) track(what);
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      },
      () => toast(t("err_generic")),
    );
  const field = {
    className: "copy-text",
    readOnly: true,
    value: text ?? "…",
    spellCheck: false,
    onFocus: (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => e.target.select(),
    onCopy: () => what && track(what),
  };
  return (
    <div className={"copy-box" + (line ? " line" : "") + (prose ? " prose" : "")}>
      {line ? <input type="text" {...field} /> : <textarea ref={area} {...field} rows={3} />}
      <button
        className={"copy-btn" + (done ? " done" : "")}
        onClick={copy}
        disabled={!text}
        aria-label={done ? t("copied") : t("copy")}
        title={done ? t("copied") : t("copy")}
      >
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          {done ? (
            <path d="M5 12.5l4.5 4.5L19 7.5" />
          ) : (
            <>
              <rect x="8.5" y="8.5" width="12" height="12" rx="2.5" />
              <path d="M15.5 8.5V6a2.5 2.5 0 0 0-2.5-2.5H6A2.5 2.5 0 0 0 3.5 6v7A2.5 2.5 0 0 0 6 15.5h2.5" />
            </>
          )}
        </svg>
      </button>
    </div>
  );
}
