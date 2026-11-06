# Changelog

## 0.1.0 (unreleased)

First release, built on a hard fork of Excalidraw from their commit 701b901 of 2026-11-05
([docs/fork.md](fork.md)).

- Canvases live on the server and are shared by sending their address; anyone with it edits live, with
  cursors, names and a little drawn face for each person (a robot for agents). Owners can make a canvas
  view-only or private.
- Guests draw without signing up, with up to 5 canvases and 10 MB by default. Their canvases last 24 hours
  (`GUEST_CANVAS_HOURS`, 0 keeps them), counted down in a card at the bottom of the sidebar and in Settings,
  and closing the tab asks first. An email link, or Google and OpenID Connect where the server enables them,
  makes an account that keeps their canvases on every device, even when the link is opened in another
  browser; a password can be added.
- Images and preferences are stored with the account. Import `.excalidraw` files, export one as JSON or
  everything as a zip, delete a canvas after a confirmation, with undo, delete the account.
- A sidebar to keep canvases in order: search titles (Ctrl+K), star favorites, file them into projects by
  dragging, rename in place, set its width, and bring it back in one click. Each canvas shows who is on it
  right now, faded after a minute without activity.
- A shared canvas link shows the drawing itself in Slack, X, WhatsApp or iMessage previews; a private canvas
  shows only the betterdraw image.
- A dashboard, opened from the logo: every canvas as a card with a live preview, filtered by favorites,
  shared or project, searched and sorted, with New canvas and Import.
- Dark by default, light in one click, a zen mode that leaves only the tools, soft canvas colors, an accent
  color of your choice, phone and tablet layouts.
- Agents read and draw on canvases: Share gives a prompt or an MCP address for one canvas, and keys in
  Settings open all of them, through MCP or plain HTTP. People see agents at work: a robot avatar, a cursor
  that points and talks, shapes appearing one by one, and a card that shows what it changed.
- A Feedback form: people tell the admins what they like, what is missing or what broke, with screenshots
  if they want.
- An administration dashboard: usage numbers and daily activity, measured on the server only, who is
  drawing right now, the feedback, and removing a person or a canvas. Admins can open any canvas
  read-only without appearing on it; each such view is logged.
- A Dockerfile and a Compose file: one container with a built-in SQLite database and the Chromium that
  agents' screenshots need, or Postgres and S3.
- Compared with Excalidraw: no shape library, no AI features (Mermaid to diagram stays), no promotions and
  no analytics. [docs/fork.md](fork.md) lists what we changed in their code.
