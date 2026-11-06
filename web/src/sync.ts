// One WebSocket per open canvas: sends local changes (batched), applies everyone else's, carries presence.
import { watching } from "./nav";
import type { ExcalidrawImperativeAPI, Collaborator, BinaryFileData, SocketId } from "@betterdraw/editor/types";
import type { ExcalidrawElement, OrderedExcalidrawElement } from "@betterdraw/element/types";
import { reconcileElements, restoreElements, CaptureUpdateAction, newElementWith } from "@betterdraw/editor";
import { avatarSrc } from "./avatar";

type El = OrderedExcalidrawElement;
export type Presence = {
  id: string;
  name: string;
  color: string;
  image?: string;
  pointer?: Collaborator["pointer"];
  button?: "down" | "up";
  selectedElementIds?: Record<string, true>;
  view?: [number, number, number, number]; // what they see: followers see the same
  agent?: boolean;
  state?: "active" | "idle";
  say?: string;
  sayUntil?: number;
  focus?: [number, number, number, number]; // what an agent works on: its cursor rests beside it
};
// What an agent just changed, with how each element was before, for the card that shows it.
export type AgentChange = { seat: string; name: string; before: Map<string, ExcalidrawElement | null> };
export type Status = "connecting" | "online" | "offline";
export type Gone = "deleted" | "blocked" | "private" | "not_found";

export class Sync {
  private ws: WebSocket | null = null;
  private known = new Map<string, number>(); // element id -> last version sent or received
  private seen = new Map<string, ExcalidrawElement>(); // what the scene held last time, to notice removals
  private pending = new Map<string, ExcalidrawElement>(); // changes waiting to be sent
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastFlush = 0; // when the last batch left, and how big it was: big drags are sent less often
  private lastFlushBytes = 0;
  private selection = "";
  private lastSeq = 0;
  private ready = false;
  private closed = false;
  private retry = 0;
  private goneReason: Gone | null = null;
  private uploaded = new Set<string>();
  private fetching = new Set<string>();
  private people = new Map<string, Presence>();
  private playing = new Map<string, Promise<void>>(); // per agent: its changes, played one after the other
  me = { connId: "", color: { background: "#888", stroke: "#444" } };
  onPresence: (list: Presence[]) => void = () => {};
  onStatus: (s: Status) => void = () => {};
  onWelcome: (role: string, first: boolean) => void = () => {};
  onError: (code: string) => void = () => {};
  onGone: (why: Gone) => void = () => {};
  onAgentChange: (change: AgentChange) => void = () => {};

  constructor(
    private canvasId: string,
    private api: ExcalidrawImperativeAPI,
    private name: string,
  ) {
    this.connect();
    addEventListener("pagehide", this.flushNow);
  }

  // Closing the tab right after drawing must not lose the last stroke.
  private flushNow = () => {
    if (this.timer) clearTimeout(this.timer);
    this.flush();
  };

  private connect() {
    if (this.closed) return;
    this.onStatus("connecting");
    const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws${watching() ? "?watch" : ""}`);
    this.ws = ws;
    ws.onopen = () => ws.send(JSON.stringify({ t: "hello", canvas: this.canvasId, lastSeq: this.lastSeq, name: this.name }));
    ws.onmessage = (ev) => this.handle(JSON.parse(ev.data));
    ws.onclose = (ev) => {
      this.onStatus("offline");
      if (this.closed) return;
      if (ev.code === 4001) return location.reload(); // access changed: start over
      if (ev.code === 4004) return this.onGone("deleted");
      if (ev.code === 4010) return this.onGone("blocked");
      if (ev.code === 4003) return this.onGone(this.goneReason ?? "private");
      setTimeout(() => this.connect(), Math.min(10_000, 500 * 2 ** this.retry++));
    };
  }

  private handle(m: any) {
    if (m.t === "welcome") {
      const first = !this.ready;
      this.retry = 0;
      this.me = { connId: m.you.connId, color: m.you.color };
      this.apply(m.elements);
      this.lastSeq = m.seq;
      this.ready = true;
      this.onStatus("online");
      this.people = new Map((m.presence as Presence[]).map((p) => [p.id, p]));
      this.selection = ""; // the server forgot it: send it again on the next change
      this.onPresence([...this.people.values()]);
      this.onWelcome(m.role, first);
      // Whatever changed here while offline is newer than what the server has: send it now.
      this.pushChanged(this.api.getSceneElementsIncludingDeleted());
    } else if (m.t === "batch") {
      if (m.elements) this.apply(m.elements, m.agents);
      this.lastSeq = Math.max(this.lastSeq, m.seq);
      // Our own presence comes back too: only someone else's is news. Re-rendering for nothing would
      // fire onChange, which would send presence, which would come back, 25 times a second.
      let changed = false;
      for (const p of m.presence ?? [])
        if (p.id !== this.me.connId) {
          this.see(p);
          changed = true;
        }
      for (const id of m.gone ?? []) changed = this.people.delete(id) || changed;
      if (changed) this.onPresence([...this.people.values()]);
    } else if (m.t === "ack") {
      this.lastSeq = Math.max(this.lastSeq, m.seq);
      if (m.rejected?.length) this.apply(m.rejected);
    } else if (m.t === "background") {
      // Someone picked another canvas color: it is not a step of our own undo history.
      this.api.updateScene({ appState: { viewBackgroundColor: m.color }, captureUpdate: CaptureUpdateAction.NEVER });
    } else if (m.t === "error") {
      if (["not_found", "private", "blocked"].includes(m.code)) this.goneReason = m.code;
      else this.onError(m.code);
    }
  }

  // Someone's presence. An agent's cursor glides instead of jumping, stays where its playback puts it
  // while it plays, and shows what it says for a few seconds.
  private see(p: Presence) {
    const prev = this.people.get(p.id);
    if (p.say) {
      p.sayUntil = Date.now() + 8000;
      setTimeout(() => this.onPresence([...this.people.values()]), 8100);
    } else if (prev?.sayUntil && prev.sayUntil > Date.now()) [p.say, p.sayUntil] = [prev.say, prev.sayUntil];
    if (!p.agent) return void this.people.set(p.id, p);
    // While its changes play, the playback moves the cursor (from the first shape on a first visit);
    // otherwise the cursor glides beside what the agent now looks at.
    const to = p.focus ? this.beside(p.focus, p) : p.pointer;
    this.people.set(p.id, { ...p, pointer: prev?.pointer });
    if (!to || this.playing.has(p.id)) return;
    if (prev?.pointer) this.glide(p.id, to, 350);
    else this.people.set(p.id, { ...p, pointer: { x: to.x, y: to.y, tool: "pointer" } });
  }

  // Remote elements in. What an agent wrote plays back shape by shape; everything else applies at once.
  private apply(remote: El[], agents?: Record<string, string[]>) {
    if (!remote?.length) return;
    if (agents) {
      const byId = new Map(remote.map((e) => [e.id, e]));
      for (const [seat, ids] of Object.entries(agents)) {
        const els = ids.map((id) => byId.get(id)).filter((e): e is El => !!e);
        els.forEach((e) => byId.delete(e.id));
        if (els.length) this.playAgent(seat, els);
      }
      remote = [...byId.values()];
    }
    this.applyNow(remote);
  }

  private playAgent(seat: string, els: El[]) {
    const run = (this.playing.get(seat) ?? Promise.resolve()).then(() => this.play(seat, els)).catch(() => this.applyNow(els));
    this.playing.set(seat, run);
    run.finally(() => this.playing.get(seat) === run && this.playing.delete(seat));
  }

  // The agent's cursor goes to each shape, which then fades in, moves or fades out. Big batches go by
  // groups, so a playback lasts a few seconds. Hidden tabs and reduced motion get the result at once.
  private async play(seat: string, els: El[]) {
    const local = new Map(this.api.getSceneElementsIncludingDeleted().map((e) => [e.id, e]));
    const before = new Map(els.map((e) => [e.id, local.get(e.id) ?? null]));
    if (document.hidden || matchMedia("(prefers-reduced-motion: reduce)").matches) this.applyNow(els);
    else {
      const steps = stepsOf(els);
      const pace = Math.max(160, Math.min(450, 7000 / steps.length));
      for (const step of steps) {
        await this.glide(seat, focusOf(step), pace * 0.4);
        await this.tween(step, pace * 0.6);
        this.applyNow(step);
      }
      const p = this.people.get(seat);
      if (p?.focus) await this.glide(seat, this.beside(p.focus, p), 300);
    }
    this.onAgentChange({ seat, name: this.people.get(seat)?.name ?? "Agent", before });
  }

  // Where an agent's cursor rests: beside what it works on, never on top. Below first, then to the right,
  // then the other sides; the first place where neither the cursor nor its name covers a shape wins.
  private beside([x0, y0, x1, y1]: [number, number, number, number], p: Presence) {
    const zoom = this.api.getAppState().zoom.value;
    const said = p.say && (p.sayUntil ?? 0) > Date.now() ? p.say.length + 2 : 0;
    const [w, h, gap] = [((p.name.length + said) * 7 + 30) / zoom, 40 / zoom, 12 / zoom];
    const spots = [
      [x0, y1 + gap],
      [x1 + gap, y0],
      [x1 + gap, y1 + gap],
      [x0 - w - gap, y0],
      [x0, y0 - h - gap],
    ];
    const taken = this.api.getSceneElements().map(boxOf);
    const free = ([x, y]: number[]) => !taken.some(([a, b, c, d]) => a < x + w && c > x && b < y + h && d > y);
    const [x, y] = spots.find(free) ?? spots[0];
    return { x, y };
  }

  private glide(seat: string, to: { x: number; y: number } | undefined, ms: number) {
    const from = this.people.get(seat)?.pointer ?? to;
    if (!to || !from) return Promise.resolve();
    return frames(ms, (k) => {
      const p = this.people.get(seat);
      if (!p) return;
      this.people.set(seat, { ...p, pointer: { x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k, tool: "pointer" } });
      this.onPresence([...this.people.values()]);
    });
  }

  // In-between frames are copies at the version already shown, so they are never sent back.
  private tween(step: El[], ms: number) {
    const scene = new Map(this.api.getSceneElementsIncludingDeleted().map((e) => [e.id, e]));
    const mix = (a: number | undefined, b: number | undefined, k: number) => (a ?? 0) + ((b ?? 0) - (a ?? 0)) * k;
    const plans = step.flatMap((to): ((k: number) => ExcalidrawElement)[] => {
      const from = scene.get(to.id);
      if (!from || from.isDeleted) {
        if (to.isDeleted) return [];
        this.known.set(to.id, to.version);
        return [(k) => ({ ...to, opacity: (to.opacity ?? 100) * k })];
      }
      if (to.isDeleted) return [(k) => ({ ...from, opacity: (from.opacity ?? 100) * (1 - k) })];
      return [
        (k) => ({
          ...from,
          x: mix(from.x, to.x, k),
          y: mix(from.y, to.y, k),
          width: mix(from.width, to.width, k),
          height: mix(from.height, to.height, k),
          angle: mix(from.angle, to.angle, k) as ExcalidrawElement["angle"],
        }),
      ];
    });
    return plans.length ? frames(ms, (k) => this.show(plans.map((f) => f(k)))) : Promise.resolve();
  }

  private show(copies: ExcalidrawElement[]) {
    const scene = [...this.api.getSceneElementsIncludingDeleted()];
    for (const c of copies) {
      const i = scene.findIndex((e) => e.id === c.id);
      if (i >= 0) scene[i] = c as El;
      else {
        const j = scene.findIndex((e) => (e.index ?? "") > ((c as El).index ?? ""));
        scene.splice(j < 0 ? scene.length : j, 0, c as El);
      }
    }
    this.api.updateScene({ elements: scene, captureUpdate: CaptureUpdateAction.NEVER });
  }

  // Remote elements in; Excalidraw's own reconcile decides; never touches the undo history.
  private applyNow(remote: El[]) {
    if (!remote?.length) return;
    const local = this.api.getSceneElementsIncludingDeleted();
    const byId = new Map(local.map((el) => [el.id, el]));
    // Our own changes come back in every batch, already outdated while a drag goes on: keep only what
    // is newer than the scene (Excalidraw's rule), so nothing jumps back and nothing re-renders.
    const newer = remote.filter((r) => {
      const l = byId.get(r.id);
      return !l || r.version > l.version || (r.version === l.version && r.versionNonce < l.versionNonce);
    });
    if (!newer.length) return;
    // No local elements for restoreElements: given them, it raises older copies above the local version.
    const restored = new Set(restoreElements(newer, null) as unknown as El[]);
    const reconciled = reconcileElements(local, [...restored] as any, this.api.getAppState());
    for (const el of reconciled)
      if (restored.has(el)) {
        this.known.set(el.id, el.version);
        this.seen.set(el.id, el);
        this.pending.delete(el.id);
      }
    this.api.updateScene({ elements: reconciled, captureUpdate: CaptureUpdateAction.NEVER });
    this.fetchMissingFiles(reconciled);
  }

  // Called from Excalidraw's onChange with the whole scene: queue what changed since last time.
  pushChanged(elements: readonly ExcalidrawElement[]) {
    if (!this.ready) return;
    for (const el of elements) {
      this.seen.set(el.id, el);
      const v = this.known.get(el.id);
      if (v === undefined || el.version > v) {
        this.pending.set(el.id, el);
        this.known.set(el.id, el.version);
      }
    }
    // An element that left the scene without being deleted (the whole scene was replaced, by an import
    // for instance) must disappear for everyone too. Excalidraw keeps deleted elements, so this is rare.
    if (this.seen.size > elements.length) {
      const present = new Set(elements.map((el) => el.id));
      for (const [id, el] of this.seen)
        if (!present.has(id)) {
          this.seen.delete(id);
          if (!el.isDeleted) {
            const tomb = newElementWith(el as any, { isDeleted: true }) as ExcalidrawElement;
            this.pending.set(id, tomb);
            this.known.set(id, tomb.version);
          }
        }
    }
    // The first change goes at once, then at most one batch every 40 ms, or less often for big ones so
    // that a long drag stays under ~2 MB/s (the server cuts connections that send much more).
    if (this.pending.size && !this.timer) {
      const gap = Math.max(40, this.lastFlushBytes / 2000);
      this.timer = setTimeout(() => this.flush(), Math.max(0, this.lastFlush + gap - performance.now()));
    }
  }

  // Batches of at most 500 elements or about 1 MB; whatever cannot be sent now waits for the reconnect.
  private flush() {
    this.timer = null;
    if (watching()) return this.pending.clear();
    if (this.ws?.readyState !== WebSocket.OPEN || !this.pending.size) return;
    this.lastFlush = performance.now();
    this.lastFlushBytes = 0;
    let parts: string[] = [],
      size = 0;
    const send = () => {
      this.ws!.send(`{"t":"push","elements":[${parts.join(",")}]}`);
      this.lastFlushBytes += size;
      parts = [];
      size = 0;
    };
    for (const el of this.pending.values()) {
      const s = JSON.stringify(el);
      if (parts.length && (parts.length >= 500 || size + s.length > 1_000_000)) send();
      parts.push(s);
      size += s.length;
    }
    if (parts.length) send();
    this.pending.clear();
  }

  presence(p: Partial<Presence>) {
    if (watching()) return;
    if (this.ready && this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ t: "presence", presence: p }));
  }

  // Excalidraw reports its whole state after every render: only a new selection is worth sending.
  select(ids: Record<string, true>) {
    const key = Object.keys(ids).join();
    if (key === this.selection || !this.ready) return;
    this.selection = key;
    this.presence({ selectedElementIds: ids });
  }

  setName(name: string) {
    this.name = name;
    this.presence({ name });
  }

  // ---- images: the bytes go over HTTP, only their ids travel in the scene ----
  async uploadFiles(files: Record<string, BinaryFileData>) {
    for (const f of Object.values(files)) {
      if (this.uploaded.has(f.id)) continue;
      this.uploaded.add(f.id);
      const blob = dataUrlToBlob(f.dataURL);
      const r = await fetch(`/api/canvases/${this.canvasId}/files/${encodeURIComponent(f.id)}`, {
        method: "PUT",
        body: blob,
        headers: { "content-type": f.mimeType },
      }).catch(() => null);
      if (!r || !r.ok) {
        const code = r ? ((await r.json().catch(() => ({}))).error ?? "generic") : "network";
        if (["too_big", "unsupported_type", "quota_storage", "private", "read_only"].includes(code)) this.onError("image_" + code);
        else {
          this.onError("image_failed");
          setTimeout(() => this.uploaded.delete(f.id), 10_000); // try again on a later change
        }
        continue;
      }
      const els = this.api
        .getSceneElementsIncludingDeleted()
        .map((el) => (el.type === "image" && el.fileId === f.id && el.status !== "saved" ? newElementWith(el, { status: "saved" }) : el));
      this.api.updateScene({ elements: els, captureUpdate: CaptureUpdateAction.NEVER });
    }
  }

  private async fetchMissingFiles(elements: readonly ExcalidrawElement[]) {
    const have = this.api.getFiles();
    for (const el of elements) {
      if (el.type !== "image" || !el.fileId || el.isDeleted || have[el.fileId] || this.fetching.has(el.fileId)) continue;
      this.fetching.add(el.fileId);
      try {
        const r = await fetch(`/api/canvases/${this.canvasId}/files/${encodeURIComponent(el.fileId)}${watching() ? "?watch" : ""}`);
        if (!r.ok) continue;
        const blob = await r.blob();
        const dataURL = await new Promise<string>((res) => {
          const fr = new FileReader();
          fr.onload = () => res(fr.result as string);
          fr.readAsDataURL(blob);
        });
        this.uploaded.add(el.fileId);
        this.api.addFiles([{ id: el.fileId, mimeType: blob.type as any, dataURL: dataURL as any, created: Date.now() }]);
      } finally {
        this.fetching.delete(el.fileId);
      }
    }
  }

  close() {
    this.closed = true;
    removeEventListener("pagehide", this.flushNow);
    this.flushNow();
    this.ws?.close();
  }
}

// fetch(dataURL) would be blocked by the app's Content-Security-Policy: decode it by hand.
function dataUrlToBlob(dataURL: string) {
  const [head, data] = dataURL.split(",", 2);
  const mime = head.match(/^data:([^;]+)/)?.[1] ?? "application/octet-stream";
  const bytes = head.includes(";base64")
    ? Uint8Array.from(atob(data), (c) => c.charCodeAt(0))
    : new TextEncoder().encode(decodeURIComponent(data));
  return new Blob([bytes], { type: mime });
}

// Animation frames with easing; in a hidden tab, the end at once.
function frames(ms: number, step: (k: number) => void) {
  return new Promise<void>((done) => {
    if (document.hidden) return (step(1), done());
    const t0 = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - t0) / ms);
      step(t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
      if (t < 1) requestAnimationFrame(tick);
      else done();
    };
    requestAnimationFrame(tick);
  });
}

// A shape and the text inside it appear together; at most 40 steps, so long batches go by groups.
function stepsOf(els: El[]) {
  const ids = new Set(els.map((e) => e.id));
  const inside = (e: El) => e.type === "text" && typeof (e as any).containerId === "string" && ids.has((e as any).containerId);
  const steps = els.filter((e) => !inside(e)).map((e) => [e, ...els.filter((t) => inside(t) && (t as any).containerId === e.id)]);
  const per = Math.ceil(steps.length / 40);
  return Array.from({ length: Math.ceil(steps.length / per) }, (_, i) => steps.slice(i * per, (i + 1) * per).flat());
}

// The bounding box of an element, as [left, top, right, bottom].
function boxOf(e: ExcalidrawElement): [number, number, number, number] {
  const pts: readonly (readonly number[])[] =
    "points" in e && e.points.length
      ? e.points
      : [
          [0, 0],
          [e.width, e.height],
        ];
  const xs = pts.map((q) => e.x + q[0]);
  const ys = pts.map((q) => e.y + q[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

// While drawing, the cursor sits at the bottom-right corner of the shape that appears, not on it.
function focusOf(step: El[]) {
  const [, , x1, y1] = boxOf(step[0]);
  return { x: x1 + 6, y: y1 + 6 };
}

export const toCollaborators = (list: Presence[], meConnId: string) => {
  const map = new Map<SocketId, Collaborator>();
  for (const p of list) {
    if (p.id === meConnId) continue;
    map.set(p.id as SocketId, {
      id: p.id,
      socketId: p.id as SocketId,
      username: p.say && (p.sayUntil ?? 0) > Date.now() ? `${p.name}: ${p.say}` : p.name,
      color: { background: p.color, stroke: p.color },
      avatarUrl: avatarSrc(p.name, p.image, p.agent),
      ...(p.agent ? { userState: (p.state === "idle" ? "idle" : "active") as Collaborator["userState"] } : {}),
      pointer: p.agent && p.state === "idle" ? undefined : p.pointer, // an idle agent keeps its avatar, not its cursor
      button: p.button,
      selectedElementIds: p.selectedElementIds,
    });
  }
  return map;
};
