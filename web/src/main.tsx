import "./Feedback"; // keeps the page's recent errors for bug reports
import { createRoot } from "react-dom/client";
import { lazy, Suspense, useEffect, useState } from "react";
import "@betterdraw/editor"; // the editor and its styles first, so ours override them
import "./styles.css";
import { api, ensureMe, type Me } from "./api";
import { Shell } from "./Shell";
import { AuthConfirm } from "./AuthConfirm";
import { AuthPassword } from "./AuthPassword";
import { loadPrefs } from "./prefs";
import { leaving, navigate, usePath } from "./nav";
import { Toasts } from "./toast";

// Only admins open the dashboard: its code, charts and map load when they do.
const Admin = lazy(() => import("./Admin").then((m) => ({ default: m.Admin })));

function App() {
  const path = usePath();
  const [me, setMe] = useState<Me | null>(null);
  // The email links open on a fresh device: no guest account is made for them.
  const emailLink = path === "/auth/confirm" || path === "/auth/password";
  useEffect(() => {
    if (!emailLink)
      ensureMe().then((m) => {
        setMe(m);
        loadPrefs();
      });
  }, [emailLink]);

  if (emailLink) return <Behind>{path === "/auth/confirm" ? <AuthConfirm /> : <AuthPassword />}</Behind>;
  if (!me) return null;
  if (path === "/admin" || path.startsWith("/admin/"))
    return (
      <Suspense fallback={null}>
        <Admin me={me} path={path} />
      </Suspense>
    );
  if (path === "/canvases") return <Shell me={me} setMe={setMe} canvasId={null} />;
  // "/" never shows a lobby: it opens the most recent canvas, or a new one. Like opening Excalidraw.
  if (!path.startsWith("/c/")) return <Landing />;
  return <Shell me={me} setMe={setMe} canvasId={path.slice(3).split("/")[0]} />;
}

// The email links open as a popup over the app: over this browser's latest canvas when it already has
// someone (a guest, usually), over an empty page otherwise. No guest is made for them.
function Behind({ children }: { children: React.ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [canvasId, setCanvasId] = useState<string | null>(null);
  useEffect(() => {
    leaving.onPurpose = true; // this page always moves on by itself
    (async () => {
      const m = await api<Me | null>("/api/me").catch(() => null);
      if (!m) return;
      loadPrefs();
      const list = await api<{ id: string; mine: unknown }[]>("/api/canvases").catch(() => []);
      const id = list.find((c) => c.mine)?.id ?? list[0]?.id;
      if (!id) return;
      setMe(m);
      setCanvasId(id);
    })();
  }, []);
  return (
    <>
      {me && canvasId ? <Shell me={me} setMe={setMe} canvasId={canvasId} /> : <div className="blank-app" />}
      {children}
    </>
  );
}

function Landing() {
  useEffect(() => {
    (async () => {
      const list = await api<{ id: string; mine: unknown }[]>("/api/canvases");
      const id =
        list.find((c) => c.mine)?.id ?? list[0]?.id ?? (await api<{ id: string }>("/api/canvases", { method: "POST", body: "{}" })).id;
      navigate(`/c/${id}`, true);
    })();
  }, []);
  return null;
}

// The server's own headless browser draws pictures of canvases for agents there (server/render.ts).
if (location.pathname === "/__render") import("./render");
else
  createRoot(document.getElementById("root")!).render(
    <>
      <App />
      <Toasts />
    </>,
  );
