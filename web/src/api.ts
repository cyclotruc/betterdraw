import { createAuthClient } from "better-auth/react";
import { anonymousClient, emailOTPClient, magicLinkClient } from "better-auth/client/plugins";
import { useEffect, useState } from "react";

export const authClient = createAuthClient({ plugins: [anonymousClient(), magicLinkClient(), emailOTPClient()] });

export type Me = { id: string; name: string; email: string | null; anonymous: boolean; admin: boolean; image: string | null; hasPassword?: boolean };
export type CanvasMeta = {
  id: string;
  title: string;
  link_access: "edit" | "view" | "none";
  owner_id: string;
  role: "owner" | "editor" | "viewer";
  background: string | null; // the canvas color, if someone picked one
  card_stale: boolean; // the image shared links show is older than the drawing
};
// project_id and pinned say where this person keeps the canvas in their own list.
export type CanvasRow = {
  id: string;
  title: string;
  updated_at: string;
  mine: boolean | number;
  project_id: string | null;
  pinned: boolean | number;
  expires_at: string | null; // a guest's canvas is deleted then, unless they make an account
  live: number; // elements not deleted, as last written
};
// Someone on a canvas, as the sidebar shows them: idle after a minute without drawing or moving.
export type Here = { id: string; name: string; color: string; image?: string; agent?: boolean; idle?: boolean };
export type Project = { id: string; name: string; color: string };
export type Config = {
  app: string;
  version: string;
  google: boolean;
  oidc: string | null;
  signup: "open" | "closed";
  legal: string[];
  maxFileMb: number;
  guestCanvasHours: number; // how long a guest's new canvas lasts; 0: until it is deleted
  feedbackShots: number; // screenshots in one feedback message
  feedbackShotMb: number; // the size of one
};

export class ApiError extends Error {
  constructor(
    public code: string,
    public status: number,
  ) {
    super(code);
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  if (!r.ok) throw new ApiError((await r.json().catch(() => ({})))?.error ?? "generic", r.status);
  return r.json();
}

// Everyone has an identity, guests included: no screen stands between the visitor and the canvas.
export async function ensureMe(): Promise<Me> {
  let me = await api<Me | null>("/api/me");
  if (!me) {
    await authClient.signIn.anonymous();
    me = await api<Me | null>("/api/me");
  }
  if (!me) throw new Error("no session");
  return me;
}

let config: Config | null = null;
let configPromise: Promise<Config> | null = null;
export const loadConfig = () => (configPromise ??= api<Config>("/api/config").then((c) => (config = c)));
// Null until the server answers, the first time only.
export function useConfig() {
  const [c, setC] = useState<Config | null>(config);
  useEffect(() => {
    loadConfig()
      .then(setC)
      .catch(() => {});
  }, []);
  return c;
}

// Counts something only the browser sees (a copy, an export) for the admin dashboard. Fire and forget.
export const track = (what: string) =>
  void fetch("/api/track", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ what }), keepalive: true }).catch(() => {});
