// The WebSocket side: one connection per open canvas tab. Messages are small JSON objects:
//   client: hello {canvas, lastSeq, name} · push {elements} · presence {presence}
//   server: welcome {seq, elements, role, you, presence}
//           batch {seq, elements?, presence?, gone?}: what changed in the last 40 ms, sent to everyone
//           ack {seq, rejected}: the server kept a newer copy of some elements · error {code}
import { randomBytes } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { q } from "./db.js";
import { sessionUser, type SessionUser } from "./auth.js";
import { access, watchAccess, canEdit } from "./canvases.js";
import { colorFor, getRoom, rooms, type Client, type Presence, type Room } from "./rooms.js";
import { ipOf, sameOrigin } from "./security.js";
import { metrics } from "./metrics.js";
import { env } from "./env.js";
import { event, isBrowser, noteActivity, noteShapes, visitorOf } from "./stats.js";
import { emit } from "./extend.js";

export function attachRealtime(server: Server) {
  // Clients send at most ~1 MB per message (one oversized element alone can go up to MAX_ELEMENT_KB).
  const wss = new WebSocketServer({ noServer: true, maxPayload: env.maxElementBytes + 1024 * 1024 });
  server.on("upgrade", async (req: IncomingMessage, socket, head) => {
    try {
      if (!req.url?.startsWith("/ws")) return socket.destroy();
      if (!sameOrigin(req.headers.origin, req.headers.host)) {
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        return socket.destroy();
      }
      const user = await sessionUser(new Headers({ cookie: req.headers.cookie ?? "" }));
      if (!user) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        return socket.destroy();
      }
      // Headless browsers (screenshots, recordings, tests) are not people at work.
      const ua = req.headers["user-agent"];
      // /ws?watch: an admin watching unseen. Nothing of theirs is counted or shown to anyone.
      const watching = !!user.admin && new URL(req.url, "http://x").searchParams.has("watch");
      const person = isBrowser(ua) && !user.program && !watching;
      // Today's visitor in this browser, for the extensions told about the canvases people open.
      const visitor = person ? visitorOf(ipOf(req.socket.remoteAddress ?? "", req.headers["x-forwarded-for"]), ua!) : "";
      wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, user, person, watching, visitor));
    } catch {
      socket.destroy();
    }
  });
}

// Presence is relayed to everyone, so only known fields of a bounded size get through.
function cleanPresence(p: any): Partial<Presence> {
  const out: Partial<Presence> = {};
  if (typeof p?.name === "string") out.name = p.name.slice(0, 40);
  if (p?.pointer && Number.isFinite(p.pointer.x) && Number.isFinite(p.pointer.y))
    out.pointer = { x: p.pointer.x, y: p.pointer.y, tool: p.pointer.tool === "laser" ? "laser" : "pointer" };
  if (p?.button === "down" || p?.button === "up") out.button = p.button;
  if (p?.selectedElementIds && typeof p.selectedElementIds === "object") {
    const ids = Object.keys(p.selectedElementIds).slice(0, 500);
    out.selectedElementIds = Object.fromEntries(ids.filter((k) => k.length <= 64).map((k) => [k, true]));
  }
  if (Array.isArray(p?.view) && p.view.length === 4 && p.view.every(Number.isFinite)) out.view = p.view as Presence["view"];
  return out;
}

function onConnection(ws: WebSocket, user: SessionUser, person: boolean, watching: boolean, visitor: string) {
  let room: Room | null = null;
  let me: Client | null = null;
  // Token buckets, one for messages and one for bytes: bursts are fine (a drag sends ~60 messages a
  // second), floods are not.
  let tokens = 300,
    bytes = 16 * 1024 * 1024,
    last = Date.now();
  const send = (m: unknown) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m));
  metrics.connections++;
  ws.on("error", () => {});

  ws.on("message", async (raw) => {
    const now = Date.now();
    const size = (raw as Buffer).length ?? 0;
    tokens = Math.min(300, tokens + ((now - last) / 1000) * 150);
    bytes = Math.min(16 * 1024 * 1024, bytes + ((now - last) / 1000) * 4 * 1024 * 1024);
    last = now;
    bytes -= size;
    if (--tokens < 0 || bytes < 0) return ws.close(4008, "rate limit");
    let m: any;
    try {
      m = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (m.t === "hello" && !room) {
      const a = watching ? await watchAccess(String(m.canvas), user) : await access(String(m.canvas), user);
      if (a.error || a.role === "none") {
        send({ t: "error", code: a.error ?? "private" });
        return ws.close(4003, a.error ?? "private");
      }
      room = getRoom(a.cv!.id);
      await room.loaded;
      if (ws.readyState !== ws.OPEN) return;
      me = { ws, connId: randomBytes(6).toString("base64url"), user, role: a.role, last: now, joined: now };
      if (watching) {
        room.watch(me);
        q(`insert into admin_views (admin_id, canvas_id) values ($1, $2)`, [user.id, room.canvasId]).catch(() => {});
        console.log(`admin ${user.email ?? user.id} watches canvas ${room.canvasId} unseen`);
        return send({
          t: "welcome",
          seq: room.seq,
          elements: room.elementsSince(Number(m.lastSeq) || 0),
          role: "viewer",
          you: { id: user.id, connId: me.connId, color: colorFor(user.id) },
          presence: room.presenceList(),
        });
      }
      me.presence = {
        id: me.connId,
        name: String(m.name || user.name).slice(0, 40),
        color: colorFor(user.id).background,
        ...(user.image ? { image: user.image } : {}),
      };
      room.join(me);
      if (person) {
        noteActivity(user.id);
        emit("canvasOpened", { userId: user.id, canvasId: room.canvasId, visitor });
      }
      event({ kind: "open", who: user.name, user: user.id, canvas: room.canvasId, key: `open:${user.id}:${room.canvasId}` });
      send({
        t: "welcome",
        seq: room.seq,
        elements: room.elementsSince(Number(m.lastSeq) || 0),
        role: a.role,
        you: { id: user.id, connId: me.connId, color: colorFor(user.id) },
        presence: room.presenceList(),
      });
      room.queuePresence(me.presence);
      return;
    }
    if (!room || !me) return;
    if (watching) return; // watchers only listen
    me.last = now;

    if (m.t === "push" && Array.isArray(m.elements)) {
      metrics.pushes++;
      if (!canEdit(me.role)) return send({ t: "error", code: "read_only" });
      if (m.elements.length > 2000) return send({ t: "error", code: "too_many" });
      // Small messages hold small elements; only a big message is worth measuring element by element.
      if (size > 64 * 1024) m.elements = m.elements.filter((e: unknown) => JSON.stringify(e).length <= env.maxElementBytes);
      const { accepted, rejected, refused, created } = room.push(m.elements);
      noteShapes(person ? user : { ...user, agent: true }, room.canvasId, created, accepted.length);
      if (rejected.length) send({ t: "ack", seq: room.seq, rejected });
      if (refused) send({ t: "error", code: "refused", count: refused });
      if (accepted.length) room.queueElements(accepted);
    } else if (m.t === "presence") {
      me.presence = { ...me.presence!, ...cleanPresence(m.presence), id: me.connId };
      room.queuePresence(me.presence);
    }
  });

  ws.on("close", () => {
    metrics.connections--;
    if (room && me) {
      room.leave(me);
      if (!watching) room.queueGone(me.connId);
    }
  });
}

export const openRoomCount = () => rooms.size;
