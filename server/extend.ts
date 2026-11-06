// What a build adds to this open-source version, such as the numbers of a hosted version or billing. Its entry
// registers with use() and only then imports index.ts, so that everything is in place before the server starts.
// Every part is optional. Hooks on the drawing path (canvasOpened, shapesDrawn) run synchronously on every
// message: they must not wait on anything.
import type { Context, Hono } from "hono";
import { env } from "./env.js";
import type { Migration } from "./migrations.js";

// What one person may own. 0 means no limit.
export type Limits = { canvases: number; storageBytes: number };

// A page of the app loaded by a person's browser (robots left out), as stats.ts counts it.
export type Visit = {
  c: Context; // the request: its path, referer, languages…
  visitor: string; // today's visitor: a hash of address and browser that changes every day
  page: string; // the kind of page: "/", "/c/…", "/canvases", "/admin", "/auth/…", "other", or the name a route gave it
  first: boolean; // the visitor's first page load today, since the server started
  ip: string;
};

export type Extension = {
  // Applied after this version's own migrations. Ids must differ from every other migration's.
  migrations?: Migration[];
  // HTTP routes, registered before the web app's catch-all. `admin` tells whether the request comes from an admin.
  routes?: (app: Hono, admin: (c: Context) => Promise<boolean>) => void;
  // What one person may own, from `base`: the server's settings, or what the extensions before made of them.
  limitsFor?: (user: { id: string; anonymous: boolean }, base: Limits) => Limits | Promise<Limits>;
  // Pages search engines may index. Every other response says noindex: a page may hold a canvas address.
  indexable?: (path: string) => boolean;
  // Once the server listens.
  start?: () => void;
  // A page load. Tags are kept with the visitor's row of the day, after this version's own fields (with no "|",
  // which separates them); a note is added to the line of the live feed.
  visit?: (v: Visit) => { tags?: string[]; note?: string } | void;
  // A guest or an account made by a person, not by a program.
  personCreated?: (p: { id: string; account: boolean }) => void;
  // A guest made an account or signed in to one. The guest's id is gone once the hooks are done.
  guestConverted?: (g: { guestId: string; userId: string }) => void | Promise<void>;
  // A person opened a canvas in a browser (an admin watching unseen is left out).
  canvasOpened?: (o: { userId: string; canvasId: string; visitor: string }) => void;
  // Shapes created on a canvas by a person or by an agent: called on every push.
  shapesDrawn?: (s: { userId: string; canvasId: string; n: number; agent: boolean }) => void;
  // An account or a guest was deleted, with everything it owned.
  userDeleted?: (u: { id: string }) => void | Promise<void>;
};

const list: Extension[] = [];
export const use = (e: Extension) => void list.push(e);
export const extensions = (): readonly Extension[] => list;

type Event = "personCreated" | "guestConverted" | "canvasOpened" | "shapesDrawn" | "userDeleted";
const settled = Promise.resolve();
// Tells every extension. A hook that throws is logged and stops neither the others nor the caller; the promise
// settles once the hooks that returned one are done.
export function emit<K extends Event>(name: K, payload: Parameters<NonNullable<Extension[K]>>[0]): Promise<void> {
  let waits: Promise<unknown>[] | undefined;
  for (const e of list) {
    const hook = e[name] as ((p: typeof payload) => unknown) | undefined;
    if (!hook) continue;
    try {
      const r = hook(payload);
      if (r instanceof Promise) (waits ??= []).push(r.catch((err) => console.error(`extension ${name}:`, err)));
    } catch (err) {
      console.error(`extension ${name}:`, err);
    }
  }
  return waits ? Promise.all(waits).then(() => {}) : settled;
}

export async function limitsFor(user: { id: string; anonymous: boolean }): Promise<Limits> {
  let limits: Limits = user.anonymous
    ? { canvases: env.quota.guestCanvases, storageBytes: env.quota.guestBytes }
    : { canvases: env.quota.userCanvases, storageBytes: env.quota.userBytes };
  for (const e of list) if (e.limitsFor) limits = await e.limitsFor(user, limits);
  return limits;
}

export function routes(app: Hono, admin: (c: Context) => Promise<boolean>) {
  for (const e of list) e.routes?.(app, admin);
}

export const indexable = (path: string) => list.some((e) => e.indexable?.(path));

export function start() {
  for (const e of list) e.start?.();
}
