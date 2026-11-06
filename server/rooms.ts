// One room per open canvas: the authoritative copy of its elements, in memory, written to the database
// a second after each change. A room with nobody left in it is written out and unloaded.
import { createHash } from "node:crypto";
import type { WebSocket } from "ws";
import { env } from "./env.js";
import { q } from "./db.js";
import { metrics } from "./metrics.js";

// A scene element as Excalidraw ships it. The server only reads a few fields.
export type El = {
  id: string;
  version: number;
  versionNonce: number;
  type: string;
  isDeleted?: boolean;
  fileId?: string;
  [k: string]: unknown;
};

export type Presence = {
  id: string;
  name: string;
  color: string;
  image?: string; // their profile picture, if they have one
  pointer?: { x: number; y: number; tool: "pointer" | "laser" };
  button?: "down" | "up";
  selectedElementIds?: Record<string, true>;
  // The part of the canvas a person sees, [x0, y0, x1, y1]: whoever follows them sees the same.
  view?: [number, number, number, number];
  // Agents act over HTTP, not through a socket: the room keeps their presence for them.
  agent?: boolean;
  state?: "active" | "idle";
  say?: string;
  // The area an agent read, drew, erased or pointed at: browsers rest its cursor beside it, not on it.
  focus?: [number, number, number, number];
};

export const colorFor = (id: string) => {
  const h = parseInt(createHash("sha256").update(id).digest("hex").slice(0, 4), 16) % 360;
  return { background: `hsl(${h} 70% 55%)`, stroke: `hsl(${h} 70% 30%)` };
};

// An agent is active for a minute after each action and stays in the room for ten. People are counted
// the same way in the sidebar: a tab left open and untouched for ten minutes is nobody there.
const AGENT_ACTIVE_MS = 60_000;
const AGENT_STAYS_MS = 10 * 60_000;

export type Role = "owner" | "editor" | "viewer" | "none";
export type Client = {
  ws: WebSocket;
  connId: string;
  user: { id: string; name: string; image?: string | null; anonymous?: boolean };
  role: Role;
  presence?: Presence;
  last: number; // when this person last drew or moved here
  joined: number;
};
// Who is on a canvas, as the sidebar shows it.
export type Here = { id: string; name: string; color: string; image?: string; agent?: boolean; idle?: boolean };

const ID = /^[\w-]{1,64}$/;
const valid = (e: any): e is El =>
  !!e &&
  typeof e === "object" &&
  typeof e.id === "string" &&
  ID.test(e.id) &&
  Number.isInteger(e.version) &&
  e.version >= 0 &&
  Number.isInteger(e.versionNonce) &&
  typeof e.type === "string" &&
  e.type.length <= 32;

// Excalidraw's own rule (packages/excalidraw/data/reconcile.ts): higher version wins,
// same version -> lower versionNonce wins. Deterministic on every node.
const remoteWins = (local: El | undefined, remote: El) =>
  !local || remote.version > local.version || (remote.version === local.version && remote.versionNonce < local.versionNonce);

export class Room {
  elements = new Map<string, El>();
  elementSeq = new Map<string, number>();
  seq = 0;
  clients = new Set<Client>();
  // Admins watching unseen: they get every batch, and appear nowhere (presence, who is here, counts).
  watchers = new Set<Client>();
  dirty = new Set<string>();
  // What each element weighs as JSON, and their sum: the canvas's drawing data, written with each flush.
  private sizes = new Map<string, number>();
  bytes = 0;
  loaded: Promise<void>;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private unloadTimer: ReturnType<typeof setTimeout> | null = null;
  private chain: Promise<void> = Promise.resolve();
  // Changes and cursor moves are sent out together every 40 ms: one message per tick to each person
  // instead of one per change, which is what keeps a busy room cheap.
  agents = new Map<string, Presence & { last: number }>();
  // Each batch also says which elements an agent wrote, in order, so that browsers can play them back.
  private out = {
    elements: new Map<string, El>(),
    presence: new Map<string, Presence>(),
    gone: [] as string[],
    agents: new Map<string, string[]>(),
  };
  private outTimer: ReturnType<typeof setTimeout> | null = null;
  private lastOut = 0;
  private retryMs = 1000;
  private disposed = false;

  constructor(public canvasId: string) {
    this.loaded = this.load();
  }

  private async load() {
    const [c] = await q<{ seq: string }>(`select seq from canvases where id = $1`, [this.canvasId]);
    let seq = Number(c?.seq ?? 0);
    for (const r of await q<{ element_id: string; seq: string; data: El }>(
      `select element_id, seq, data from elements where canvas_id = $1`,
      [this.canvasId],
    )) {
      this.elements.set(r.element_id, r.data);
      this.elementSeq.set(r.element_id, Number(r.seq));
      this.weigh(r.element_id, JSON.stringify(r.data));
      seq = Math.max(seq, Number(r.seq));
    }
    this.seq = seq;
  }

  private weigh(id: string, json: string) {
    const n = Buffer.byteLength(json);
    this.bytes += n - (this.sizes.get(id) ?? 0);
    this.sizes.set(id, n);
  }

  liveCount() {
    let n = 0;
    for (const e of this.elements.values()) if (!e.isDeleted) n++;
    return n;
  }

  // In depth order: browsers draw elements in the order they get them, and the map keeps the order they were
  // loaded from the database in, which is not their depth.
  elementsSince(since: number) {
    const out: El[] = [];
    for (const [id, s] of this.elementSeq) if (s > since) out.push(this.elements.get(id)!);
    const key = (e: El) => (typeof e.index === "string" ? e.index : "");
    return out.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  }

  // Accepted elements go to everyone else; for refused ones the sender gets the server's copy back.
  // A full canvas refuses what would make it bigger: new elements past MAX_ELEMENTS_PER_CANVAS or MAX_CANVAS_MB,
  // and changes past a tenth more than MAX_CANVAS_MB, so that what is on a full canvas can still be moved and
  // deleted. Each element is weighed as it arrives, so the limit holds between writes too.
  push(incoming: unknown[]) {
    const accepted: El[] = [],
      rejected: El[] = [],
      created: string[] = [];
    let refused = 0;
    for (const el of incoming) {
      if (!valid(el)) {
        refused++;
        continue;
      }
      const local = this.elements.get(el.id);
      if (!local && this.elements.size >= env.maxElements) {
        refused++;
        continue;
      }
      if (remoteWins(local, el)) {
        const json = JSON.stringify(el);
        const grows = Buffer.byteLength(json) - (this.sizes.get(el.id) ?? 0);
        if (grows > 0 && this.bytes + grows > (local ? env.maxCanvasBytes * 1.1 : env.maxCanvasBytes)) {
          refused++;
          continue;
        }
        this.weigh(el.id, json);
        this.seq++;
        this.elements.set(el.id, el);
        this.elementSeq.set(el.id, this.seq);
        this.dirty.add(el.id);
        accepted.push(el);
        if (!local && !el.isDeleted) created.push(el.type);
      } else if (local) rejected.push(local);
    }
    metrics.accepted += accepted.length;
    metrics.refused += refused;
    if (accepted.length) this.scheduleFlush();
    return { accepted, rejected, refused, created };
  }

  join(c: Client) {
    if (this.unloadTimer) clearTimeout(this.unloadTimer);
    this.unloadTimer = null;
    this.clients.add(c);
  }

  leave(c: Client) {
    this.clients.delete(c);
    this.watchers.delete(c);
    this.idle();
  }
  watch(c: Client) {
    if (this.unloadTimer) clearTimeout(this.unloadTimer);
    this.unloadTimer = null;
    this.watchers.add(c);
  }

  // Unload in 30 seconds if nobody is here: after the last person leaves, or after an agent's visit.
  idle() {
    if (!this.clients.size && !this.watchers.size && !this.disposed && !this.unloadTimer)
      this.unloadTimer = setTimeout(() => this.unload(), 30_000);
  }

  private async unload() {
    this.unloadTimer = null;
    if (this.clients.size || this.watchers.size) return;
    await this.flush();
    if (!this.clients.size && !this.watchers.size && !this.dirty.size && rooms.get(this.canvasId) === this) rooms.delete(this.canvasId);
  }

  // Close every connection (canvas deleted, blocked, or access changed).
  kick(code: number, reason: string, except?: (c: Client) => boolean) {
    for (const c of [...this.clients, ...this.watchers]) if (!except?.(c)) c.ws.close(code, reason);
  }

  // The canvas is gone: stop writing, forget everything.
  dispose() {
    this.disposed = true;
    if (this.outTimer) clearTimeout(this.outTimer);
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.unloadTimer) clearTimeout(this.unloadTimer);
    this.dirty.clear();
    if (rooms.get(this.canvasId) === this) rooms.delete(this.canvasId);
  }

  queueElements(els: El[], agent?: string) {
    for (const e of els) this.out.elements.set(e.id, e);
    if (agent) this.out.agents.set(agent, [...(this.out.agents.get(agent) ?? []), ...els.map((e) => e.id)]);
    this.scheduleOut();
  }

  // An agent did something here: it is in the room, active, and its cursor is where it looked or drew.
  agentActed(seat: { id: string; name: string }, focus?: [number, number, number, number], say?: string) {
    const prev = this.agents.get(seat.id);
    const p = {
      id: seat.id,
      name: seat.name,
      color: colorFor(seat.id).background,
      agent: true,
      state: "active" as const,
      pointer: focus ? { x: (focus[0] + focus[2]) / 2, y: (focus[1] + focus[3]) / 2, tool: "pointer" as const } : prev?.pointer,
      focus: focus ?? prev?.focus,
      last: Date.now(),
    };
    this.agents.set(seat.id, p);
    const { last: _, ...shown } = p;
    this.queuePresence(say ? { ...shown, say } : shown);
  }

  sweepAgents(now: number) {
    for (const [id, p] of this.agents)
      if (now - p.last > AGENT_STAYS_MS) {
        this.agents.delete(id);
        this.queueGone(id);
      } else if (p.state === "active" && now - p.last > AGENT_ACTIVE_MS) {
        p.state = "idle";
        const { last: _, ...shown } = p;
        this.queuePresence(shown);
      }
  }
  queuePresence(p: Presence) {
    this.out.presence.set(p.id, p);
    this.scheduleOut();
  }
  queueGone(connId: string) {
    this.out.presence.delete(connId);
    this.out.gone.push(connId);
    this.scheduleOut();
  }
  // The first change after a quiet moment goes out at once; then at most one batch every 40 ms.
  private scheduleOut() {
    if (!this.outTimer) this.outTimer = setTimeout(() => this.sendOut(), Math.max(0, this.lastOut + 40 - Date.now()));
  }
  private sendOut() {
    this.outTimer = null;
    this.lastOut = Date.now();
    const { elements, presence, gone, agents } = this.out;
    this.out = { elements: new Map(), presence: new Map(), gone: [], agents: new Map() };
    const msg: Record<string, unknown> = { t: "batch", seq: this.seq };
    if (elements.size) msg.elements = [...elements.values()];
    if (agents.size) msg.agents = Object.fromEntries(agents);
    if (presence.size) msg.presence = [...presence.values()];
    if (gone.length) msg.gone = gone;
    this.broadcast(msg);
  }

  send(c: Client, msg: unknown) {
    if (c.ws.readyState === c.ws.OPEN) c.ws.send(JSON.stringify(msg));
  }
  broadcast(msg: unknown, except?: Client) {
    const text = JSON.stringify(msg);
    for (const c of [...this.clients, ...this.watchers]) if (c !== except && c.ws.readyState === c.ws.OPEN) c.ws.send(text);
  }
  // One entry per person (however many tabs) and per agent, the most recently active first.
  here(now: number, exceptUser?: string) {
    const people = new Map<string, Here & { last: number }>();
    for (const c of this.clients) {
      if (c.user.id === exceptUser || now - c.last > AGENT_STAYS_MS || (people.get(c.user.id)?.last ?? 0) > c.last) continue;
      people.set(c.user.id, {
        id: c.user.id,
        name: c.presence?.name ?? c.user.name,
        color: colorFor(c.user.id).background,
        ...(c.user.image ? { image: c.user.image } : {}),
        last: c.last,
      });
    }
    const list = [
      ...people.values(),
      ...[...this.agents.values()].map((a) => ({ id: a.id, name: a.name, color: a.color, agent: true, last: a.last })),
    ];
    return list.sort((a, b) => b.last - a.last).map(({ last, ...h }) => (now - last > AGENT_ACTIVE_MS ? { ...h, idle: true } : h));
  }

  presenceList() {
    return [...[...this.clients].map((c) => c.presence), ...[...this.agents.values()].map(({ last: _, ...p }) => p)].filter(Boolean);
  }

  private scheduleFlush(delay = 1000) {
    if (this.flushTimer || this.disposed) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, delay);
  }

  // Writes are queued one after the other; a failed write is retried with a growing delay.
  flush(): Promise<void> {
    this.chain = this.chain.then(() => this.write());
    return this.chain;
  }

  private async write() {
    if (this.disposed) return;
    const ids = [...this.dirty];
    if (!ids.length) return;
    this.dirty.clear();
    try {
      for (let i = 0; i < ids.length; i += 500) {
        const rows = ids.slice(i, i + 500).map((id) => {
          const json = JSON.stringify(this.elements.get(id));
          this.weigh(id, json);
          return [this.canvasId, id, this.elementSeq.get(id), json];
        });
        const values = rows.map((_, j) => `($${j * 4 + 1}, $${j * 4 + 2}, $${j * 4 + 3}, $${j * 4 + 4}::jsonb)`).join(",");
        await q(
          `insert into elements (canvas_id, element_id, seq, data) values ${values}
           on conflict (canvas_id, element_id) do update set seq = excluded.seq, data = excluded.data`,
          rows.flat(),
        );
      }
      await q(`update canvases set seq = greatest(seq, $2), live = $3, bytes = $4, updated_at = now() where id = $1`, [
        this.canvasId,
        this.seq,
        this.liveCount(),
        this.bytes,
      ]);
      this.retryMs = 1000;
    } catch (e: any) {
      for (const id of ids) this.dirty.add(id);
      metrics.flushFailures++;
      console.error(`canvas ${this.canvasId}: write failed, retrying in ${this.retryMs / 1000}s: ${e?.message}`);
      const wait = this.retryMs;
      this.retryMs = Math.min(this.retryMs * 2, 30_000);
      this.scheduleFlush(wait);
    }
  }
}

export const rooms = new Map<string, Room>();
setInterval(() => {
  const now = Date.now();
  for (const r of rooms.values()) r.sweepAgents(now);
}, 15_000).unref();
export const getRoom = (id: string) => {
  let r = rooms.get(id);
  if (!r) rooms.set(id, (r = new Room(id)));
  return r;
};
