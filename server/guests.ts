// A guest who signs in keeps what it made: canvases (no longer due to expire), seats on shared canvases, projects
// and where each canvas is filed. Signing in from the guest's own browser also brings its preferences, its name if
// the account has none, its agent links and keys. A login link opened in another browser brings only what the guest
// made: whoever opens it may not be whoever asked for it, so the guest's keys and agent links, which act as their
// person, are deleted, and the account keeps its own name and preferences.
// Their empty untitled canvases are dropped instead of cluttering the account.
import { AsyncLocalStorage } from "node:async_hooks";
import { q } from "./db.js";
import { rooms } from "./rooms.js";
import { destroyCanvas, isUntitled } from "./canvases.js";
import { event, hit } from "./stats.js";
import { emit } from "./extend.js";

type U = { id: string; name?: string | null };

// How long a login link works, and so how long the guest who asked for it is remembered.
export const LINK_MINUTES = 10;

// One sign-in can hand two guests over: the one who asked for the link and the one whose browser opens it. Each is
// counted once, even if it were handed over twice. Better Auth deletes the guest of the browser right after, so ids
// are kept a minute only.
const handedOver = new Set<string>();
async function converted(guest: U, user: U) {
  if (handedOver.has(guest.id)) return;
  handedOver.add(guest.id);
  setTimeout(() => handedOver.delete(guest.id), 60_000).unref();
  hit("convert", "guest");
  await emit("guestConverted", { guestId: guest.id, userId: user.id });
  event({ kind: "convert", who: user.name ?? guest.name ?? undefined, user: user.id });
}

// What the guest made: its canvases, its seats on others', its projects and where it filed each canvas.
async function moveContent(guest: U, user: U) {
  const owned = await q<{ id: string; title: string; live: number; deleted_at: unknown }>(
    `select id, title, live, deleted_at from canvases where owner_id = $1`,
    [guest.id],
  );
  for (const c of owned) {
    const room = rooms.get(c.id);
    if (room) await room.flush();
    const live = room ? room.liveCount() : Number(c.live);
    if (!c.deleted_at && live === 0 && isUntitled(c.title)) await destroyCanvas(c.id);
  }
  await q(`update canvases set owner_id = $1, expires_at = null where owner_id = $2`, [user.id, guest.id]);
  await q(
    `insert into canvas_access (canvas_id, user_id, role, via_link)
       select canvas_id, $1, role, via_link from canvas_access where user_id = $2
       on conflict (canvas_id, user_id) do nothing`,
    [user.id, guest.id],
  );
  await q(`delete from canvas_access where user_id = $1 and canvas_id in (select id from canvases where owner_id = $1)`, [user.id]);
  await q(`update projects set user_id = $1 where user_id = $2`, [user.id, guest.id]);
  await q(
    `insert into canvas_places (user_id, canvas_id, project_id, pinned)
       select $1, canvas_id, project_id, pinned from canvas_places where user_id = $2
       on conflict (user_id, canvas_id) do nothing`,
    [user.id, guest.id],
  );
}

// The guest signed in from its own browser (the anonymous plugin's onLinkAccount): everything moves.
export async function linkGuest(guest: U, user: U) {
  if (guest.id === user.id) return;
  await converted(guest, user);
  if (!user.name && guest.name) await q(`update "user" set name = $2 where id = $1`, [user.id, guest.name]);
  await moveContent(guest, user);
  await q(`insert into user_prefs (user_id, prefs) select $1, prefs from user_prefs where user_id = $2 on conflict (user_id) do nothing`, [
    user.id,
    guest.id,
  ]);
  await q(`update api_keys set user_id = $1 where user_id = $2`, [user.id, guest.id]);
  await q(
    `update agent_links set user_id = $1 where user_id = $2 and canvas_id not in (select canvas_id from agent_links where user_id = $1)`,
    [user.id, guest.id],
  );
}

// An emailed link may be opened in another browser, which has no guest session to hand over. The guest who asked
// for it is remembered with the link's token for as long as the link works, and only the session that this very
// link creates takes over what the guest made. Signing in any other way (a password, Google, OIDC, another link)
// hands over nobody.
const asked = new Map<string, U>();
export function rememberGuest(token: string, guest: U) {
  asked.set(token, guest);
  setTimeout(() => asked.delete(token), LINK_MINUTES * 60_000).unref();
}

// While a link is verified: the guest who asked for it, for the session it creates (linkAskedGuest).
const opening = new AsyncLocalStorage<{ token: string; guest: U; done?: boolean }>();
// Verifies a login link with `verify`, handing over the guest who asked for it, unless the browser opening it is that
// guest's own: there the anonymous plugin hands everything over.
export async function openLink<T>(token: string | undefined, browserUser: () => Promise<{ id: string } | null>, verify: () => Promise<T>) {
  const guest = token ? asked.get(token) : undefined;
  if (!token || !guest || (await browserUser())?.id === guest.id) return verify();
  return opening.run({ token, guest }, verify);
}

// A session was created: if a link being verified created it, what the guest who asked for that link made moves to
// the account. Its keys and agent links are deleted, not moved.
export async function linkAskedGuest(userId: string) {
  const o = opening.getStore();
  if (!o || o.done) return;
  o.done = true;
  asked.delete(o.token);
  const [user] = await q<{ id: string; name: string; anon: unknown }>(`select id, name, "isAnonymous" as anon from "user" where id = $1`, [
    userId,
  ]);
  const [guest] = await q(`select 1 as ok from "user" where id = $1 and "isAnonymous" = $2`, [o.guest.id, true]);
  if (!user || user.anon || !guest) return;
  await converted(o.guest, user);
  await moveContent(o.guest, user);
  await q(`delete from api_keys where user_id = $1`, [o.guest.id]);
  await q(`delete from agent_links where user_id = $1`, [o.guest.id]);
}
