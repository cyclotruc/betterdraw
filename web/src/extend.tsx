// What a build adds to this open-source version: a block in Settings, tabs in the admin dashboard, a badge after
// the name in the sidebar, and a reaction when someone reaches a limit. Its entry registers with use() and only
// then imports main.tsx.
import type { ComponentType } from "react";
import type { Me } from "./api";

// The admin dashboard's period, as its picker sets it.
export type Period = { kind: "7" | "30" | "90" | "all" } | { kind: "custom"; from: string; to: string };

export type AdminTab = {
  path: string; // the tab opens at /admin/<path>: letters, digits and dashes
  label: string;
  period?: boolean; // shows the Overview's period picker; the page gets its period
  // A React.lazy page, so that its code loads only when an admin opens it.
  Page: ComponentType<{ me: Me; period: Period; sub: string | null }>;
};

export type WebExtension = {
  SettingsExtra?: ComponentType<{ me: Me }>;
  adminTabs?: AdminTab[];
  BrandBadge?: ComponentType;
  onLimit?: (kind: "canvases" | "storage") => void;
};

const list: WebExtension[] = [];
export const use = (e: WebExtension) => void list.push(e);

export const adminTabs = () => list.flatMap((e) => e.adminTabs ?? []);

export function SettingsExtra({ me }: { me: Me }) {
  return <>{list.map((e, i) => e.SettingsExtra && <e.SettingsExtra key={i} me={me} />)}</>;
}

export function BrandBadge() {
  return <>{list.map((e, i) => e.BrandBadge && <e.BrandBadge key={i} />)}</>;
}

export const onLimit = (kind: "canvases" | "storage") => list.forEach((e) => e.onLimit?.(kind));
