import { useEffect, useState } from "react";
import { api } from "./api";
import brand from "../../branding/brand.json";

// adminView "off" lets an admin see the app the way everyone else does; the server's rights stay the same.
export type Prefs = { accent: string; theme: "system" | "light" | "dark"; adminView: "on" | "off" };
export const ACCENTS: { name: string; hex: string }[] = [
  { name: "Orange", hex: brand.accent },
  { name: "Coral", hex: "#e64980" },
  { name: "Violet", hex: "#6965db" },
  { name: "Blue", hex: "#1c7ed6" },
  { name: "Teal", hex: "#0ca678" },
  { name: "Slate", hex: "#495057" },
];
// Dark until someone picks otherwise.
const DEFAULT: Prefs = { accent: brand.accent, theme: "dark", adminView: "on" };
const KEY = "betterdraw.prefs";

const read = (): Prefs => {
  try {
    return { ...DEFAULT, ...JSON.parse(localStorage.getItem(KEY) || "{}") };
  } catch {
    return DEFAULT;
  }
};
const listeners = new Set<(p: Prefs) => void>();
let current = read();
const mq = matchMedia("(prefers-color-scheme: dark)");

export const resolvedTheme = (p: Prefs = current): "light" | "dark" => (p.theme === "system" ? (mq.matches ? "dark" : "light") : p.theme);

// One place sets the colors: our shell and Excalidraw both follow them.
function apply(p: Prefs) {
  const root = document.documentElement;
  root.dataset.theme = resolvedTheme(p);
  root.style.setProperty("--accent", p.accent);
}
apply(current);
mq.addEventListener("change", () => {
  apply(current);
  listeners.forEach((l) => l(current));
});

export function setPrefs(patch: Partial<Prefs>, persist = true) {
  current = { ...current, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {}
  apply(current);
  listeners.forEach((l) => l(current));
  if (persist) api("/api/prefs", { method: "PUT", body: JSON.stringify(patch) }).catch(() => {});
}

// The account's preferences win over what this browser remembered.
export async function loadPrefs() {
  const server = await api<Partial<Prefs>>("/api/prefs").catch(() => ({}) as Partial<Prefs>);
  const known: Partial<Prefs> = {};
  if (server.accent) known.accent = server.accent;
  if (server.theme) known.theme = server.theme;
  if (server.adminView) known.adminView = server.adminView;
  if (Object.keys(known).length) setPrefs(known, false);
}

export function usePrefs() {
  const [p, setP] = useState(current);
  useEffect(() => {
    listeners.add(setP);
    return () => {
      listeners.delete(setP);
    };
  }, []);
  return p;
}

// Whether to show the admin's own screens: an admin who turned them off sees what everyone sees.
export const useAdminView = (me: { admin: boolean }) => usePrefs().adminView !== "off" && me.admin;
