# Architecture

The server owns every canvas; browsers and agents are views of it. One process, one database, one
folder of images.

```
browsers ──HTTPS + WebSocket──▶ reverse proxy (optional) ──▶ one process (Hono + ws)
agents ────MCP or HTTP + key───▶                              ├─ auth (Better Auth): guests, email link, password, Google, OIDC
                                                              ├─ HTTP API and MCP: canvases, images, export, admin, agents
                                                              ├─ rooms: one per open canvas, in memory, authoritative
                                                              └─ static web app (web/dist)
                                                                   │
                                                 SQLite file or Postgres · disk folder or S3 bucket
```

## Code

- `server/`: `app.ts` HTTP routes, `realtime.ts` the WebSocket protocol, `rooms.ts` the in-memory
  canvas and its writes, `auth.ts` sign-in, `guests.ts` guests and how they become accounts,
  `canvases.ts` who may do what, `migrations.ts` the schema, `jobs.ts` housekeeping, `admin.ts` and
  `stats.ts` the admin dashboard, `agents.ts` the API and MCP server for agents, `render.ts` their
  screenshots.
- `web/src/`: the React app around the editor. `sync.ts` talks to the server, `CanvasPage.tsx` wires
  the editor, `Shell.tsx` the frame, `Sidebar.tsx` the list of canvases, `Dashboard.tsx` the cards at
  `/canvases`, `texts.ts` every string a person reads.
- `packages/`: the editor, a hard fork of Excalidraw (`@betterdraw/editor` and the packages it uses),
  compiled from source with the app. [fork.md](fork.md) says what changed and how to take a fix from
  them.
- `branding/`: the name, the accent color and the logo ([branding.md](branding.md)).
- `deploy/`: the Dockerfile, the Compose files and a Caddyfile.
- `npm run build`: the web app, its licenses and compressed copies.

## Extensions

`server/extend.ts` and `web/src/extend.tsx` let a build add to this code without changing it: its own
entry registers with `use()`, then starts the server or the app. On the server: migrations of its own,
routes, the limits of each person, pages search engines may index, and events (a page load, a person
created, a guest turned into an account, a canvas opened, shapes drawn, a person deleted). In the app:
a block in Settings, tabs in the admin dashboard, a badge after the name and a reaction when someone
reaches a limit. Billing or a hosted version's own pages fit there.

## Sync

- An element is Excalidraw's own JSON object. The server alone applies Excalidraw's rule: the higher
  `version` wins, on a tie the lower `versionNonce`. Every client converges on the server's copy.
- A room loads a canvas on first connection, keeps its elements in memory, numbers each accepted
  change (`seq`) and writes changed elements to the database a second later, retrying on failure. An
  empty room is written out and unloaded after 30 seconds.
- One WebSocket per open canvas. The client sends `hello` with the last `seq` it saw and gets
  `welcome` with what changed since, then sends `push` with its changed elements and `presence` with
  its cursor and selection. Each person receives one `batch` of the elements and cursors that changed:
  at once after a quiet moment, then at most every 40 ms. Deleted elements stay as tombstones
  (`isDeleted`).
- Batches also reach their author: the client skips whatever is not newer than its own scene, so a
  shape being dragged never jumps back. Remote changes never enter the local undo history.
- Images go over HTTP; only their ids travel in elements.
- The canvas color is not an element: whoever can edit sets it over HTTP, the server keeps it in
  `app_state` and sends the room a `background` message.

## Identity and sharing

- Everyone is a user. The first visit creates a guest with a session cookie that lasts a year while in
  use. A guest's canvases are deleted a day after their creation (`GUEST_CANVAS_HOURS`, `expires_at`);
  the sidebar counts down to the next one and closing the tab asks first. Signing in by email link,
  Google or OIDC turns the guest into an account and keeps its canvases. An email link opened in another
  browser brings the account the canvases, seats and projects of the guest who asked for it (remembered
  with the link while it works), but never its keys or agent links, which are deleted: whoever opens a
  link may not be whoever asked for it. A new address picks its password on the page its first link
  opens; after that a password is only ever chosen through a link sent to the address, so nobody can
  put one on someone else's email.
- A canvas address holds 22 random characters and is the secret. `link_access` decides what it gives:
  `edit` (default), `view` or `none` (owner only). Opening a canvas records a seat, which lists it
  under "Shared with me".
- A link preview shows the drawing only while the address opens the canvas. Link crawlers run no
  script, so the browser of someone who can edit draws a 1200×630 image a few seconds after each change
  and sends it (`card_at` says when; the page's `og:image` changes address with it).
- Each person files the canvases of their list, their own and shared ones, into projects of their own
  and marks some as favorites (`projects`, `canvas_places`). Nobody else sees how someone files them.
- Writes must come from the app's own origin. Only the Better Auth endpoints the app uses are
  reachable, and every login email goes through one rate-limited route.

## Administration

Accounts with `"isAdmin"` set in the `user` table open `/admin` (`admin.ts`, `stats.ts`): an overview
with people and agents counted apart, the people one by one, a live view, every canvas with take-down
and delete, and the feedback people send from the app (`feedback.ts`: their words, up to five
screenshots, and what the browser and the server knew of the moment).

- The numbers come from the database, from `activity` (one row per person and day they opened a
  canvas) and from `hits` (one row per day, metric and key: a visitor, an hour, a shape type, an
  agent…). A visitor is a hash of address and browser that changes every day. Counters add up in memory
  and are written every 30 seconds, so drawing never waits on them; `activity` keeps 90 days, `hits`
  everything, and nothing is sent anywhere.
- What each person keeps (images, drawing data, the trash; `usage.ts`) is read live and recorded every
  hour as the day's figure (`storage_days`, a year).
- A guest made by a program (no browser at sign-in, `"isProgram"`) is not one of the people: the agents
  it makes links for work for the owners of those canvases.
- An admin can open any canvas read-only without appearing on it (`?watch`), to moderate. Each such
  view is recorded in `admin_views`.

## Agents

- The Share panel of a canvas gives, under "Agents", a prompt and an MCP address, both carrying an
  agent link, `/agent/<token>`: one per person and canvas, acting with that person's rights on that
  canvas only. The panel lists them with their last use; the canvas owner sees everyone's and can turn
  any off. Like a canvas address, the link is the secret. `GET` tells the agent how to work, `POST` is
  an MCP server for that canvas, and `/elements`, `/delete`, `/point` and `/screenshot` do the same
  over plain HTTP.
- For all of a person's canvases, keys made in Settings act with that person's rights: only a SHA-256
  hash is stored, the key is shown once and can be revoked. `POST /mcp` is their MCP server (tools
  `list_canvases`, `create_canvas`, `read_canvas`, `put_elements`, `delete_elements`, `point`,
  `screenshot_canvas`) and `/api/v1` the same over HTTP: `GET` and `POST /canvases`,
  `GET /canvases/:id` (`?compact` for the agent-friendly form), `POST` and
  `DELETE /canvases/:id/elements`, `POST /canvases/:id/point` and `GET /canvases/:id/screenshot`.
  [mcp.md](mcp.md) covers them.
- MCP is Streamable HTTP with one JSON answer per request and no sessions.
- A screenshot is drawn by the editor itself in a headless Chromium (`server/render.ts`,
  playwright-core) that opens `/__render`: started on the first picture, one picture at a time, closed
  after two idle minutes or when a picture takes over 30 seconds, which is then refused. Without Chromium
  on the machine, screenshots answer that they are unavailable.
- An agent that acts on a canvas is in its room: active for a minute after each action, gone after ten.
  People see it among the avatars with a robot, and its cursor rests beside what it reads, draws,
  erases or points at, never on top, and disappears once it is idle. The `point` tool moves it on
  purpose, with a few words next to it. Each batch says which elements an agent wrote: browsers play
  them back shape by shape (fading in, moving, fading out), then show a card in the top right that
  names the agent and what it did; clicking it shows the change.
- Writes go through the canvas's room like a person's, so whoever has it open sees them appear. The
  server completes partial elements (id, version, z-order, text size), turns a shape's `label` into
  its bound text, and changes only the fields an update gives.

## Storage and housekeeping

- `server/migrations.ts` holds the versioned schema, written for Postgres and translated for SQLite by
  `server/db.ts`. A build's own migrations run after it.
- One server per database: Postgres holds an advisory lock, SQLite a lock file. Rooms live in memory,
  so scaling out means sharding canvases by id across processes.
- Every minute the server deletes guests' canvases past their lifetime. Every hour it removes empty
  untitled canvases idle for a day, deleted canvases after 30 days, guests who own nothing and were not
  seen for 30 days, unreferenced images, expired sessions and activity older than 90 days, then records
  what each person keeps.

## Limits

- One core kept 1,200 people drawing nonstop under 100 ms p99 (measured 2026-10-27, SQLite).
- 50,000 elements and 100 MB of them as JSON per canvas. WebSocket messages up to about 3 MB. A client
  sends at most 500 elements or about 1 MB at a time, and about 2 MB a second.

## Distribution

The Docker image builds the web app and runs the server with Node, with Chromium for screenshots.
Settings are environment variables ([self-hosting.md](self-hosting.md)).

## Decisions

- No end-to-end encryption: the server reads canvases to store, list, moderate and serve them to
  agents.
- No CRDT: element-level last-writer-wins, with the server as referee.
- The editor is a hard fork of Excalidraw, changed where it lives, with nothing that syncs with them:
  their fixes come over by hand ([fork.md](fork.md)).
