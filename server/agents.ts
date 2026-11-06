// Agents read and draw on canvases with the rights of the person who let them in, two ways:
// - an agent link, given in the Agents section of a canvas's Share panel: that canvas only, nothing to set
//   up. GET explains everything to the agent, POST is an MCP server, /elements and /delete are plain HTTP;
// - a key made in Settings, for all of the person's canvases: an MCP server at /mcp and an HTTP API
//   under /api/v1.
// MCP here is Streamable HTTP with JSON answers and no sessions. Every change goes through the canvas's
// room, so whoever has the canvas open sees it appear.
import { createHash, randomBytes, randomInt } from "node:crypto";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { generateNKeysBetween } from "fractional-indexing";
import { q, toDate } from "./db.js";
import { env } from "./env.js";
import { sessionUser } from "./auth.js";
import { access, canEdit, canvasRow, createCanvas } from "./canvases.js";
import { getRoom, type El, type Room } from "./rooms.js";
import { limited, sameOrigin } from "./security.js";
import { event, hit, noteShapes } from "./stats.js";
import { render, TooSlow } from "./render.js";
import { storage } from "./storage.js";

// `via` says how it connected for this request: MCP, the HTTP API or an agent link. `worksFor` is the person
// it works for: the one whose key or link it uses, or, for a link a program's guest made, the canvas's owner.
type Agent = { id: string; anonymous: boolean; seat: { id: string; name: string; person: string }; via?: string; worksFor?: string };
type Status = 400 | 401 | 403 | 404 | 413 | 429 | 503;
class Refusal extends Error {
  constructor(
    public code: string,
    public status: Status,
    message: string,
  ) {
    super(message);
  }
}

const ID = /^[\w-]{1,64}$/;
const hash = (key: string) => createHash("sha256").update(key).digest("hex");
const newId = () => randomBytes(12).toString("base64url");
const nonce = () => randomInt(1, 2 ** 31 - 1);
const urlOf = (id: string) => `${env.baseUrl}/c/${id}`;
const linkId = (token: string) => hash(token).slice(0, 16);
// The seat of the agent behind a key or an agent link, as counted for the admin dashboard.
export const keySeat = (id: string) => "agent-k" + id;
export const linkSeat = (token: string) => "agent-" + linkId(token);

// What people see of an agent in a canvas: the name it gave itself (agent_name), or else the program's
// name when it gave one over MCP, and whose agent it is. Its seat id stays the same across requests, so
// its cursor and avatar do too.
const programs = new Map<string, string>();
const chosen = new Map<string, string>();
// A program's name as its MCP client gives it, without control characters, or the | that separates the fields of
// the stats it is counted in.
const pretty = (s: string) =>
  s
    .replace(/[\p{C}|_-]+/gu, " ")
    .replace(/\b\w/g, (ch) => ch.toUpperCase())
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 30);
const seatName = (id: string, person: string) =>
  `${chosen.get(id) ?? programs.get(id) ?? "Agent"} (${person.replace(/\s+/g, " ").trim().slice(0, 40)})`;
const seatOf = (id: string, person: string) => ({ id, person, name: seatName(id, person) });
// An agent naming itself: any call may carry agent_name, and the name stays until it gives another one. Of the
// names a request carries, the first that holds something counts.
const NAME_MAX = 24;
function nameSelf(a: Agent, ...given: unknown[]) {
  for (const raw of given) {
    if (typeof raw !== "string") continue;
    const name = raw
      .replace(/[\p{C}<>]/gu, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, NAME_MAX)
      .trim();
    if (!name) continue;
    chosen.set(a.seat.id, name);
    a.seat.name = seatName(a.seat.id, a.seat.person);
    return;
  }
}
const AGENT_NAME = {
  type: "string",
  maxLength: NAME_MAX,
  description:
    'Optional: a short name for yourself, shown to people next to your cursor, like "Mapper" or "Diagram bot". One or two words. Give it once; it stays.',
};

// ---------- who is calling ----------
const lastUse = new Map<string, number>();
async function agentOf(c: Context): Promise<Agent | null> {
  // The scheme's name is case-insensitive (RFC 9110): "bearer" works as well as "Bearer".
  const key = c.req.header("authorization")?.match(/^Bearer\s+(bd_[\w-]{20,100})\s*$/i)?.[1];
  if (!key) return null;
  const [k] = await q<{ id: string; user_id: string; anon: unknown; name: string }>(
    `select k.id, k.user_id, u."isAnonymous" as anon, u.name from api_keys k join "user" u on u.id = k.user_id where k.hash = $1`,
    [hash(key)],
  );
  if (!k) return null;
  if (Date.now() - (lastUse.get(k.id) ?? 0) > 60_000) {
    lastUse.set(k.id, Date.now());
    q(`update api_keys set last_used_at = now() where id = $1`, [k.id]).catch(() => {});
  }
  return { id: k.user_id, anonymous: !!k.anon, seat: seatOf(keySeat(k.id), k.name) };
}

async function rights(a: Agent, ref: unknown) {
  const text = String(ref ?? "").trim();
  const id = text.match(/\/c\/([\w-]+)/)?.[1] ?? text;
  if (!ID.test(id)) throw new Refusal("not_found", 404, "No such canvas.");
  const r = await access(id, { id: a.id });
  if (r.role === "none")
    throw r.error === "not_found"
      ? new Refusal("not_found", 404, "No such canvas.")
      : new Refusal(r.error ?? "private", 403, r.error === "blocked" ? "This canvas was taken down." : "This canvas is private.");
  return { id, title: r.cv!.title, role: r.role };
}

async function open(a: Agent, ref: unknown, write: boolean) {
  const r = await rights(a, ref);
  if (write && !canEdit(r.role)) throw new Refusal("read_only", 403, "This canvas is view-only for you.");
  const room = getRoom(r.id);
  await room.loaded;
  return { ...r, room };
}

// ---------- elements ----------
const SHAPES = new Set(["rectangle", "ellipse", "diamond"]);
const TYPES = ["rectangle", "ellipse", "diamond", "text", "arrow", "line", "freedraw", "frame"];
// The most elements put_elements takes in one call, and ids delete_elements takes.
const MAX_CALL = 500;
const isNum = (v: unknown) => typeof v === "number" && Number.isFinite(v);
const isPos = (v: unknown) => isNum(v) && (v as number) >= 0;
const isIn = (min: number, max: number) => (v: unknown) => isNum(v) && (v as number) >= min && (v as number) <= max;
const isOneOf =
  (...values: string[]) =>
  (v: unknown) =>
    typeof v === "string" && values.includes(v);
const isStr = (v: unknown): v is string => typeof v === "string" && v.length <= 20_000;
const isStrOrNull = (v: unknown) => v === null || (typeof v === "string" && v.length <= 2_000);
const isIds = (v: unknown) => Array.isArray(v) && v.length <= 50 && v.every((x) => typeof x === "string" && ID.test(x));
const isPoints = (v: unknown) =>
  Array.isArray(v) &&
  v.length >= 1 &&
  v.length <= 10_000 &&
  v.every((p) => Array.isArray(p) && p.length === 2 && isNum(p[0]) && isNum(p[1]));
// What an agent may set, and how each value is checked: a value Excalidraw would not know is ignored like
// any other bad value. Everything else is the server's business.
const WRITABLE: Record<string, (v: unknown) => boolean> = {
  x: isNum,
  y: isNum,
  width: isPos,
  height: isPos,
  angle: isNum,
  strokeColor: isStr,
  backgroundColor: isStr,
  fillStyle: isOneOf("solid", "hachure", "cross-hatch", "zigzag"),
  strokeWidth: isPos,
  strokeStyle: isOneOf("solid", "dashed", "dotted"),
  roughness: isIn(0, 2),
  opacity: isIn(0, 100),
  groupIds: isIds,
  frameId: isStrOrNull,
  link: isStrOrNull,
  locked: (v) => typeof v === "boolean",
  text: isStr,
  fontSize: isPos,
  fontFamily: isNum,
  textAlign: isOneOf("left", "center", "right"),
  verticalAlign: isOneOf("top", "middle", "bottom"),
  containerId: isStrOrNull,
  points: isPoints,
  startArrowhead: isStrOrNull,
  endArrowhead: isStrOrNull,
  name: isStrOrNull,
};

function fresh(type: string, id: string, index: string): El {
  const el: El = {
    id,
    type,
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    angle: 0,
    strokeColor: "#1e1e1e",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 2,
    strokeStyle: "solid",
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    index,
    roundness: type === "rectangle" ? { type: 3 } : type === "text" || type === "frame" || type === "freedraw" ? null : { type: 2 },
    seed: nonce(),
    version: 1,
    versionNonce: nonce(),
    isDeleted: false,
    boundElements: null,
    updated: Date.now(),
    link: null,
    locked: false,
  };
  if (type === "text")
    Object.assign(el, {
      text: "",
      fontSize: 20,
      fontFamily: 5,
      textAlign: "left",
      verticalAlign: "top",
      containerId: null,
      originalText: "",
      autoResize: true,
      lineHeight: 1.25,
    });
  if (type === "arrow" || type === "line")
    Object.assign(el, {
      points: null,
      lastCommittedPoint: null,
      startBinding: null,
      endBinding: null,
      startArrowhead: null,
      endArrowhead: type === "arrow" ? "arrow" : null,
      elbowed: false,
    });
  if (type === "freedraw") Object.assign(el, { points: [[0, 0]], pressures: [], simulatePressure: true, lastCommittedPoint: null });
  if (type === "frame") el.name = null;
  return el;
}

const bump = (el: El) => Object.assign(el, { version: el.version + 1, versionNonce: nonce(), updated: Date.now() });

// The browser measures text; this guess holds until someone edits it.
const textSize = (text: string, fontSize: number) => {
  const lines = text.split("\n");
  return {
    width: Math.ceil(Math.max(...lines.map((l) => l.length), 1) * fontSize * 0.55),
    height: Math.ceil(lines.length * fontSize * 1.25),
  };
};

// Fields Excalidraw derives itself, kept coherent with what the agent gave.
function settle(el: El, given: Record<string, unknown>) {
  if (el.type === "text") {
    el.originalText = el.text;
    if (("text" in given || "fontSize" in given) && !("width" in given && "height" in given))
      Object.assign(el, textSize(String(el.text ?? ""), Number(el.fontSize) || 20));
  }
  if ((el.type === "arrow" || el.type === "line") && !Array.isArray(el.points))
    el.points = [
      [0, 0],
      [Number(el.width), Number(el.height)],
    ];
  if ("points" in given && Array.isArray(el.points) && !("width" in given && "height" in given)) {
    const xs = (el.points as number[][]).map((p) => p[0]);
    const ys = (el.points as number[][]).map((p) => p[1]);
    el.width = Math.max(...xs) - Math.min(...xs);
    el.height = Math.max(...ys) - Math.min(...ys);
  }
}

const center = (t: El, s: El) =>
  Object.assign(t, {
    x: Number(s.x) + (Number(s.width) - Number(t.width)) / 2,
    y: Number(s.y) + (Number(s.height) - Number(t.height)) / 2,
  });
const labelOf = (shape: El) => (shape.boundElements as { type: string; id: string }[] | null)?.find((b) => b.type === "text")?.id;

// Z-order: new elements go above everything already on the canvas, in the order given.
function indexer(room: Room) {
  let last: string | null = null;
  for (const e of room.elements.values()) if (typeof e.index === "string" && (last === null || e.index > last)) last = e.index;
  return () => {
    try {
      last = generateNKeysBetween(last, null, 1)[0];
    } catch {
      last = generateNKeysBetween(null, null, 1)[0];
    }
    return last;
  };
}

// What an agent needs to read a scene, without Excalidraw's bookkeeping.
const DEFAULTS: Record<string, unknown> = {
  angle: 0,
  strokeColor: "#1e1e1e",
  backgroundColor: "transparent",
  fillStyle: "solid",
  strokeWidth: 2,
  strokeStyle: "solid",
  roughness: 1,
  opacity: 100,
  fontSize: 20,
  textAlign: "left",
  verticalAlign: "top",
  locked: false,
};
const KEEP = ["id", "type", "x", "y", "width", "height", "angle", "text", "fontSize", "textAlign", "verticalAlign", "containerId", "points"]
  .concat(["startArrowhead", "endArrowhead", "strokeColor", "backgroundColor", "fillStyle", "strokeWidth", "strokeStyle", "roughness"])
  .concat(["opacity", "groupIds", "frameId", "link", "locked", "name", "fileId"]);
function compact(e: El) {
  const out: Record<string, unknown> = {};
  for (const k of KEEP) {
    let v = e[k];
    if (v === undefined || v === null || v === DEFAULTS[k] || (Array.isArray(v) && !v.length)) continue;
    if (k === "x" || k === "y" || k === "width" || k === "height") v = Math.round(v as number);
    if (k === "points") {
      if (e.type === "freedraw" || (v as unknown[]).length > 100) continue;
      v = (v as number[][]).map((p) => p.map(Math.round));
    }
    out[k] = v;
  }
  return out;
}

// ---------- operations, shared by MCP and the HTTP API ----------
// Counted for the admin dashboard, in memory: each request, how it came, and which operation, from which
// program, on which canvas.
function noteCall(a: Agent, via: string) {
  a.via = via;
  hit("agent", a.seat.id);
  hit("agent_seat", `${a.worksFor ?? a.id}|${a.seat.id}|${via}|${programs.get(a.seat.id) ?? "Unnamed"}`);
}
function noteTool(a: Agent, name: string, canvas?: string) {
  const program = programs.get(a.seat.id) ?? "Unnamed";
  hit("agent_flow", `${program}|${a.via ?? "Unknown"}|${name}`);
  if (canvas) hit("agent_seat_canvas", `${a.seat.id}|${canvas}`);
  event({ kind: "agent", who: a.seat.name, user: a.worksFor ?? a.id, canvas, detail: name, key: `agent:${a.seat.id}:${canvas ?? ""}` });
}

async function listCanvases(a: Agent) {
  noteTool(a, "list_canvases");
  const rows = await q<{ id: string; title: string; updated_at: unknown; mine: unknown }>(
    `select c.id, c.title, c.updated_at, (c.owner_id = $1) as mine from canvases c
      where c.deleted_at is null and c.blocked_at is null
        and (c.owner_id = $1 or exists (select 1 from canvas_access x where x.canvas_id = c.id and x.user_id = $1))
      order by c.updated_at desc limit 200`,
    [a.id],
  );
  return {
    canvases: rows.map((r) => ({
      id: r.id,
      title: r.title,
      url: urlOf(r.id),
      mine: !!r.mine,
      updated: toDate(r.updated_at).toISOString(),
    })),
  };
}

async function newCanvas(a: Agent, title: unknown) {
  const r = await createCanvas(a, title);
  if (!("error" in r)) {
    noteTool(a, "create_canvas", r.id);
    hit("canvas", "agent");
  }
  if ("error" in r)
    throw new Refusal(
      r.error,
      403,
      r.error === "quota_canvases" ? "The limit of canvases is reached: delete one first." : "New canvases are closed on this server.",
    );
  return { id: r.id, url: urlOf(r.id) };
}

// The area an agent read, drew, erased or pointed at, as [left, top, right, bottom]. Text inside a shape
// counts as its shape.
function boxOf(els: El[]): [number, number, number, number] | undefined {
  const shapes = els.filter((e) => !(e.type === "text" && e.containerId));
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const e of shapes.length ? shapes : els) {
    const [x, y] = [Number(e.x) || 0, Number(e.y) || 0];
    const pts = Array.isArray(e.points)
      ? (e.points as number[][])
      : [
          [0, 0],
          [Number(e.width) || 0, Number(e.height) || 0],
        ];
    for (const [px, py] of pts) [x0, y0, x1, y1] = [Math.min(x0, x + px), Math.min(y0, y + py), Math.max(x1, x + px), Math.max(y1, y + py)];
  }
  return Number.isFinite(x0) ? [x0, y0, x1, y1] : undefined;
}

// Reading a canvas and drawing a picture of it each hold a whole canvas in memory, as text or as images: at most
// HEAVY_AT_ONCE of them run at once, server-wide, and the others wait their turn.
const HEAVY_AT_ONCE = 4;
let heavyRunning = 0;
const heavyWaiting: (() => void)[] = [];
async function heavy<T>(run: () => Promise<T>): Promise<T> {
  if (heavyRunning < HEAVY_AT_ONCE) heavyRunning++;
  else await new Promise<void>((go) => heavyWaiting.push(go));
  try {
    return await run();
  } finally {
    const next = heavyWaiting.shift();
    if (next) next();
    else heavyRunning--;
  }
}

async function readCanvas(a: Agent, ref: unknown, short: boolean) {
  const { id, title, role, room } = await open(a, ref, false);
  noteTool(a, "read_canvas", id);
  const elements = [...room.elements.values()].filter((e) => !e.isDeleted);
  room.agentActed(a.seat, boxOf(elements));
  room.idle();
  return { id, title, url: urlOf(id), role, elements: short ? elements.map(compact) : elements };
}

// A PNG of the canvas as people see it, or of a part of it (x, y, width and height in canvas pixels).
// Images on the canvas are drawn too, up to 20 MB of them.
class Png {
  constructor(public data: Buffer) {}
}
async function screenshot(a: Agent, ref: unknown, input: Record<string, unknown>) {
  if (limited("shot:" + a.id, 20, 60_000)) throw new Refusal("rate_limited", 429, "At most 20 screenshots a minute.");
  const { id, room } = await open(a, ref, false);
  noteTool(a, "screenshot_canvas", id);
  const nums = ["x", "y", "width", "height"].map((k) => input[k]);
  const given = nums.filter((v) => v !== undefined);
  if (given.length && (given.length < 4 || !nums.every(isNum) || !isPos(input.width) || !isPos(input.height)))
    throw new Refusal("bad_request", 400, "For a part of the canvas, pass x, y, width and height, in canvas pixels.");
  const box = given.length
    ? { x: Number(input.x), y: Number(input.y), width: Number(input.width), height: Number(input.height) }
    : undefined;
  if (box && (box.width < 1 || box.height < 1 || box.width > 50_000 || box.height > 50_000))
    throw new Refusal("bad_request", 400, "width and height go from 1 to 50000.");
  const elements = [...room.elements.values()].filter((e) => !e.isDeleted);
  if (!elements.length && !box) throw new Refusal("bad_request", 400, "The canvas is empty: there is nothing to see yet.");
  const files: Record<string, { id: string; mimeType: string; dataURL: string; created: number }> = {};
  const wanted = [...new Set(elements.map((e) => e.fileId).filter((f): f is string => typeof f === "string"))];
  if (wanted.length) {
    let total = 0;
    const rows = await q<{ file_id: string; mime: string; size: number }>(`select file_id, mime, size from files where canvas_id = $1`, [
      id,
    ]);
    for (const r of rows.filter((r) => wanted.includes(r.file_id))) {
      if ((total += Number(r.size)) > 20_000_000) break;
      const bytes = await storage.get(id, r.file_id).catch(() => null);
      if (bytes)
        files[r.file_id] = {
          id: r.file_id,
          mimeType: r.mime,
          dataURL: `data:${r.mime};base64,${Buffer.from(bytes).toString("base64")}`,
          created: 0,
        };
    }
  }
  room.agentActed(a.seat, box ? [box.x, box.y, box.x + box.width, box.y + box.height] : boxOf(elements));
  room.idle();
  try {
    const background = String((await canvasRow(id))?.app_state?.viewBackgroundColor || "#ffffff");
    return new Png(await render({ elements, files, background, box }));
  } catch (e: any) {
    // The first line says why; Playwright adds a boxed banner below it, the same for every failed picture.
    console.error("screenshot:", String(e?.message ?? e).split("\n")[0]);
    if (e instanceof TooSlow)
      throw new Refusal("too_slow", 503, "Drawing this picture took too long. Ask for a part of the canvas: x, y, width and height.");
    throw new Refusal("unavailable", 503, "Screenshots are not available on this server right now.");
  }
}

async function putElements(a: Agent, ref: unknown, input: unknown) {
  if (!Array.isArray(input) || !input.length) throw new Refusal("bad_request", 400, "Pass elements: a list of Excalidraw elements.");
  if (input.length > MAX_CALL) throw new Refusal("too_many", 413, `At most ${MAX_CALL} elements at a time.`);
  const { id: canvas, room } = await open(a, ref, true);
  const out = new Map<string, El>(); // everything this call writes, by id
  const current = (id: string) => out.get(id) ?? room.elements.get(id);
  const next = indexer(room);
  // The texts inside each shape, by containerId, read from the canvas on the first label of the call.
  let inside: Map<string, string[]> | undefined;
  const textsIn = (shape: El) => {
    if (!inside) {
      inside = new Map();
      for (const e of room.elements.values())
        if (e.type === "text" && !e.isDeleted && typeof e.containerId === "string")
          inside.set(e.containerId, [...(inside.get(e.containerId) ?? []), e.id]);
    }
    const ids = [labelOf(shape), ...(inside.get(shape.id) ?? []), ...[...out.values()].filter((e) => e.type === "text").map((e) => e.id)];
    return [...new Set(ids)]
      .map((id) => (id ? current(id) : undefined))
      .filter((e): e is El => !!e && e.type === "text" && !e.isDeleted && e.containerId === shape.id);
  };
  const created: string[] = [],
    updated: string[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Refusal("bad_request", 400, "Each element must be an object.");
    const r = raw as Record<string, unknown>;
    if (r.id !== undefined && (typeof r.id !== "string" || !ID.test(r.id)))
      throw new Refusal("bad_request", 400, "An id is up to 64 letters, digits, _ or -.");
    const old = typeof r.id === "string" ? current(r.id) : undefined;
    const live = old && !old.isDeleted ? old : undefined;
    if (!live && !TYPES.includes(String(r.type))) throw new Refusal("bad_request", 400, `type must be one of: ${TYPES.join(", ")}.`);
    const el = live ? bump({ ...live }) : fresh(String(r.type), typeof r.id === "string" ? r.id : newId(), next());
    // The id of a deleted element: the new one must win over what is left of the old one, as everywhere the
    // higher version wins.
    if (old && !live) el.version = old.version + 1;
    for (const [k, ok] of Object.entries(WRITABLE)) if (k in r && ok(r[k])) el[k] = r[k];
    settle(el, r);
    out.set(el.id, el);
    // An id given twice is listed once, as created if this call made it.
    if (!created.includes(el.id) && !updated.includes(el.id)) (live ? updated : created).push(el.id);

    // A label is the text inside a shape, which follows the shape. A shape has one: the text its boundElements
    // names, or else one whose containerId is the shape. A new label replaces it, and any other text inside.
    if (isStr(r.label) && SHAPES.has(el.type)) {
      const [label, ...extra] = textsIn(el);
      const t = label ? bump({ ...label }) : fresh("text", newId(), next());
      Object.assign(t, { text: r.label, originalText: r.label, containerId: el.id, textAlign: "center", verticalAlign: "middle" });
      Object.assign(t, textSize(r.label, Number(t.fontSize) || 20));
      out.set(t.id, center(t, el));
      for (const e of extra) out.set(e.id, bump({ ...e, isDeleted: true }));
      const others = ((el.boundElements as { type: string; id: string }[] | null) ?? []).filter((b) => b.type !== "text");
      el.boundElements = [...others, { type: "text", id: t.id }];
    } else if (["x", "y", "width", "height"].some((k) => k in r)) {
      const boundId = labelOf(el);
      const bound = boundId ? current(boundId) : undefined;
      if (bound && !bound.isDeleted) out.set(bound.id, center(bump({ ...bound }), el));
    }
  }
  for (const el of out.values())
    if (JSON.stringify(el).length > env.maxElementBytes) throw new Refusal("too_big", 413, "An element is too big.");
  const { accepted, refused, created: drawn } = room.push([...out.values()]);
  noteTool(a, "put_elements", canvas);
  noteShapes({ id: a.worksFor ?? a.id, name: a.seat.name, agent: true }, canvas, drawn, accepted.length);
  if (drawn.length) hit("agent_seat_shapes", a.seat.id, drawn.length);
  if (accepted.length) room.queueElements(accepted, a.seat.id);
  room.agentActed(a.seat, boxOf(accepted));
  room.idle();
  // Only what the room took: on a full canvas, the elements that did not fit are counted apart.
  const written = new Set(accepted.map((e) => e.id));
  return {
    canvas,
    url: urlOf(canvas),
    created: created.filter((id) => written.has(id)),
    updated: updated.filter((id) => written.has(id)),
    ...(refused ? { refused: `${refused} ${refused === 1 ? "element" : "elements"} did not fit: the canvas is full.` } : {}),
  };
}

async function deleteElements(a: Agent, ref: unknown, ids: unknown) {
  if (!Array.isArray(ids) || !ids.length || !ids.every((i) => typeof i === "string"))
    throw new Refusal("bad_request", 400, "Pass ids: a list of element ids.");
  if (ids.length > MAX_CALL) throw new Refusal("too_many", 413, `At most ${MAX_CALL} ids at a time.`);
  const { id: canvas, room } = await open(a, ref, true);
  const gone = new Set(ids as string[]);
  for (const e of room.elements.values()) if (typeof e.containerId === "string" && gone.has(e.containerId)) gone.add(e.id);
  const out: El[] = [];
  for (const id of gone) {
    const e = room.elements.get(id);
    if (e && !e.isDeleted) out.push(bump({ ...e, isDeleted: true }));
  }
  // A shape that stays while its label goes no longer names it, as in the editor.
  const shapes = new Map<string, El>();
  for (const e of out) {
    const id = e.containerId;
    const shape = typeof id === "string" && !gone.has(id) ? (shapes.get(id) ?? room.elements.get(id)) : undefined;
    const bound = shape?.boundElements as { type: string; id: string }[] | null | undefined;
    if (!shape || shape.isDeleted || !bound?.some((b) => b.id === e.id)) continue;
    shapes.set(shape.id, { ...(shapes.has(shape.id) ? shape : bump({ ...shape })), boundElements: bound.filter((b) => b.id !== e.id) });
  }
  const { accepted } = room.push([...out, ...shapes.values()]);
  noteTool(a, "delete_elements", canvas);
  noteShapes({ id: a.worksFor ?? a.id, name: a.seat.name, agent: true }, canvas, [], accepted.length);
  if (accepted.length) room.queueElements(accepted, a.seat.id);
  room.agentActed(a.seat, boxOf(accepted));
  room.idle();
  return { canvas, deleted: accepted.filter((e) => e.isDeleted).map((e) => e.id) };
}

// Pointing changes nothing on the canvas: the cursor moves there, with a few words next to it if given. The
// elements named win; x and y serve when none of them is on the canvas.
async function point(a: Agent, ref: unknown, input: Record<string, unknown>) {
  const { id: canvas, room } = await open(a, ref, false);
  noteTool(a, "point", canvas);
  const ids = Array.isArray(input.ids) ? input.ids.map(String) : [];
  const box =
    boxOf(ids.map((id) => room.elements.get(id)).filter((e): e is El => !!e && !e.isDeleted)) ??
    (isNum(input.x) && isNum(input.y) ? ([input.x, input.y, input.x, input.y] as [number, number, number, number]) : undefined);
  if (!box) throw new Refusal("bad_request", 400, "Pass x and y, or the ids of elements on the canvas.");
  const say = typeof input.say === "string" ? input.say.replace(/\s+/g, " ").trim().slice(0, 140) : "";
  room.agentActed(a.seat, box, say || undefined);
  room.idle();
  return { canvas, pointed: { x: (box[0] + box[2]) / 2, y: (box[1] + box[3]) / 2 }, ...(say ? { said: say } : {}) };
}

// ---------- MCP ----------
const PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const CANVAS = { type: "string", description: "The canvas id, or its address." };
// How agents should draw, the same words in the MCP instructions and in the guide of an agent link.
const STYLE = `## Drawing style: think whiteboard, not spreadsheet
Draw like someone sketching on a whiteboard while explaining: loose, airy, a bit spontaneous. Don't pack everything into a perfect grid.

- Leave generous space between shapes and even more between groups.
- Keep text short, like quick notes. Put details in a separate note or drop them.
- Not everything needs a box: free text, a quick arrow or a scribbled annotation is often enough.
- Never shrink text to make it fit. Make the shape bigger or split it.
- Prefer short, simple arrows with few crossings. If they tangle, rethink the layout.
- Use the screenshot when visual clarity and readability are crucial.`;
const INSTRUCTIONS = `${env.appName} canvases are Excalidraw scenes that people may be watching live: they see your cursor, and your shapes appear one by one. Coordinates are canvas pixels: x grows to the right, y grows down. Read a canvas before changing it, leave room around what is already there, keep the ids you create to change, label or delete those elements later, and use point to show people what you are talking about. People see you under a generated name: pass agent_name with any call to pick a short one of your own (one or two words). When the person cares about how it looks, take a screenshot_canvas to check your work before you say you are done: overlaps, text that spills out of its shape and crooked arrows show there, not in the coordinates.\n\n${STYLE}`;
type Tool = {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
};
const TOOLS: Tool[] = [
  {
    name: "list_canvases",
    description:
      "Lists the canvases you can open, yours and those shared with you, the most recently changed first (at most 200); mine is true for yours.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "create_canvas",
    description: "Creates an empty canvas and returns its id and its address, which is what you share.",
    inputSchema: { type: "object", properties: { title: { type: "string" } } },
  },
  {
    name: "read_canvas",
    description: "Returns a canvas's title and its elements, without Excalidraw's bookkeeping fields.",
    inputSchema: { type: "object", properties: { canvas: CANVAS }, required: ["canvas"] },
  },
  {
    name: "put_elements",
    description:
      "Adds elements to a canvas, or changes them; people looking at the canvas see them appear. Each element is an Excalidraw element. " +
      "To add one, give its type (rectangle, ellipse, diamond, text, arrow, line, freedraw or frame) and its position: x and y, plus width and height for shapes; " +
      "text and fontSize for text; points for arrows and lines, as [[0,0],[dx,dy],…] relative to x and y. " +
      "Optional: strokeColor and backgroundColor (CSS colors), fillStyle (solid, hachure, cross-hatch), strokeWidth, strokeStyle (solid, dashed, dotted), " +
      "roughness (0 to 2), opacity (0 to 100), angle (radians), and label on a rectangle, ellipse or diamond to write text inside it. " +
      "Give an id to choose it, or to change an existing element: only the fields you pass change. Returns the ids created and updated.",
    inputSchema: {
      type: "object",
      properties: { canvas: CANVAS, elements: { type: "array", items: { type: "object" }, maxItems: MAX_CALL } },
      required: ["canvas", "elements"],
    },
  },
  {
    name: "delete_elements",
    description: "Deletes elements from a canvas by id, with the text inside them.",
    inputSchema: {
      type: "object",
      properties: { canvas: CANVAS, ids: { type: "array", items: { type: "string" }, maxItems: MAX_CALL } },
      required: ["canvas", "ids"],
    },
  },
  {
    name: "screenshot_canvas",
    description:
      "Returns a PNG of the canvas as people see it, to check how your drawing looks: the whole drawing, or the part given by x, y, width and height in canvas pixels. " +
      "Up to 1600 pixels on its longer side. Changes nothing on the canvas.",
    inputSchema: {
      type: "object",
      properties: { canvas: CANVAS, x: { type: "number" }, y: { type: "number" }, width: { type: "number" }, height: { type: "number" } },
      required: ["canvas"],
    },
  },
  {
    name: "point",
    description:
      "Moves your cursor to a place, or to elements, so the people watching see what you are looking at, " +
      "with an optional short sentence next to it (say, up to 140 characters). Changes nothing on the canvas.",
    inputSchema: {
      type: "object",
      properties: {
        canvas: CANVAS,
        x: { type: "number" },
        y: { type: "number" },
        ids: { type: "array", items: { type: "string" } },
        say: { type: "string", maxLength: 140 },
      },
      required: ["canvas"],
    },
  },
];

function tool(a: Agent, name: string, args: Record<string, unknown>) {
  nameSelf(a, args.agent_name);
  if (name === "list_canvases") return listCanvases(a);
  if (name === "create_canvas") return newCanvas(a, args.title);
  if (name === "read_canvas") return readCanvas(a, args.canvas, true);
  if (name === "put_elements") return putElements(a, args.canvas, args.elements);
  if (name === "delete_elements") return deleteElements(a, args.canvas, args.ids);
  if (name === "point") return point(a, args.canvas, args);
  if (name === "screenshot_canvas") return screenshot(a, args.canvas, args);
  throw new Refusal("unknown_tool", 404, `There is no tool named ${name}.`);
}

for (const t of TOOLS) t.inputSchema.properties.agent_name = AGENT_NAME;

// The same tools for an agent link, which already names the canvas.
const LINK_TOOLS: Tool[] = TOOLS.filter((t) =>
  ["read_canvas", "put_elements", "delete_elements", "point", "screenshot_canvas"].includes(t.name),
).map((t) => {
  const { canvas: _, ...properties } = t.inputSchema.properties;
  return { ...t, inputSchema: { type: "object", properties, required: t.inputSchema.required?.filter((r) => r !== "canvas") } };
});

type Tools = { list: Tool[]; call: (name: string, args: Record<string, unknown>) => Promise<unknown>; program: (name: string) => void };

async function rpc(m: any, tools: Tools) {
  if (!m || typeof m !== "object" || m.jsonrpc !== "2.0" || typeof m.method !== "string")
    return { jsonrpc: "2.0", id: m?.id ?? null, error: { code: -32600, message: "Invalid request" } };
  if (m.id === undefined || m.id === null) return null; // a notification: nothing to answer
  const result = (r: unknown) => ({ jsonrpc: "2.0", id: m.id, result: r });
  if (m.method === "initialize" && typeof m.params?.clientInfo?.name === "string") tools.program(m.params.clientInfo.name);
  if (m.method === "initialize")
    return result({
      protocolVersion: PROTOCOLS.includes(m.params?.protocolVersion) ? m.params.protocolVersion : PROTOCOLS[0],
      capabilities: { tools: {} },
      serverInfo: { name: env.appName, version: env.version },
      instructions: INSTRUCTIONS,
    });
  if (m.method === "ping") return result({});
  if (m.method === "tools/list") return result({ tools: tools.list });
  if (m.method === "tools/call")
    try {
      const out = await tools.call(String(m.params?.name), m.params?.arguments ?? {});
      if (out instanceof Png) return result({ content: [{ type: "image", data: out.data.toString("base64"), mimeType: "image/png" }] });
      return result({ content: [{ type: "text", text: JSON.stringify(out) }] });
    } catch (e) {
      if (e instanceof Refusal) return result({ content: [{ type: "text", text: e.message }], isError: true });
      // A fault of the server's fails this message alone: the others of its list still get their answers.
      console.error("MCP tools/call:", e);
      return { jsonrpc: "2.0", id: m.id, error: { code: -32603, message: "Internal error" } };
    }
  return { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `Unknown method: ${m.method}` } };
}

// One HTTP request of MCP: a message or a list of up to MAX_MESSAGES, answered one after the other, and 202 when there
// is nothing to answer. Its answers hold MAX_ANSWERS at most: the one that would pass it, and every one after it, is
// an error instead, and the messages after it are not run.
const MAX_MESSAGES = 20;
const MAX_ANSWERS = 32 * 1024 * 1024;
const HEAVY_TOOLS = new Set(["read_canvas", "screenshot_canvas"]);
const tooLarge = (id: unknown, ran: boolean) => ({
  jsonrpc: "2.0",
  id: id ?? null,
  error: {
    code: -32000,
    message: `Response too large: the answers to one request hold at most ${MAX_ANSWERS / 1048576} MB, so this message ${ran ? "ran but its answer is left out" : "did not run"}.`,
  },
});
async function answer(c: Context, m: unknown, tools: Tools) {
  const out: string[] = [];
  let size = 0;
  for (const x of Array.isArray(m) ? m : [m]) {
    const msg = (x && typeof x === "object" ? x : {}) as { id?: unknown; method?: unknown; params?: { name?: unknown } };
    const name = msg.params?.name;
    if (size > MAX_ANSWERS) {
      if (msg.id != null || typeof msg.method !== "string") out.push(JSON.stringify(tooLarge(msg.id, false))); // notifications get nothing
      continue;
    }
    // The answer is written while the message holds its turn, so that only a few whole canvases are in memory at once.
    const run = async () => {
      const a = await rpc(x, tools);
      return a && JSON.stringify(a);
    };
    const text = await (msg.method === "tools/call" && typeof name === "string" && HEAVY_TOOLS.has(name) ? heavy(run) : run());
    if (!text) continue;
    size += Buffer.byteLength(text);
    out.push(size > MAX_ANSWERS ? JSON.stringify(tooLarge(msg.id, true)) : text);
  }
  if (!out.length) return c.body(null, 202);
  return c.body(Array.isArray(m) ? `[${out.join(",")}]` : out[0], 200, { "content-type": "application/json" });
}

// A request refused as a whole, before any message is read (no key, a link turned off, a page from another
// site, too many requests, too big a body): on an MCP address it still answers in JSON-RPC, which clients show,
// with the reason in error.data.error as in the HTTP API's errors.
const rpcRefusal = (c: Context, status: Status, error: string, message: string, headers?: Record<string, string>) =>
  c.json({ jsonrpc: "2.0", id: null, error: { code: status === 429 ? -32000 : -32001, message, data: { error } } }, status, headers);

// Requests a minute for each person's keys, and for each agent link.
const PER_MINUTE = 600;
const TOO_MANY = `Too many requests: at most ${PER_MINUTE} a minute.`;
const OTHER_SITE = "Requests from the pages of another site are refused.";
// Each message of a batch counts as a request of its own. The request itself was counted already.
const batchTooMany = (key: string, m: unknown) => Array.isArray(m) && m.length > 1 && limited(key, PER_MINUTE, 60_000, m.length - 1);
// An MCP request refused as a whole before any of its messages runs: a body that is not JSON, an empty list, or a
// list of more messages than one request may carry.
const UNREADABLE = Symbol("unreadable");
function badRequest(c: Context, m: unknown) {
  const no = (code: number, message: string, error = "bad_request") =>
    c.json({ jsonrpc: "2.0", id: null, error: { code, message, data: { error } } }, 400);
  if (m === UNREADABLE) return no(-32700, "Parse error: the body is not JSON.");
  if (Array.isArray(m) && !m.length) return no(-32600, "Invalid request: an empty list.");
  if (Array.isArray(m) && m.length > MAX_MESSAGES)
    return no(-32600, `Invalid request: at most ${MAX_MESSAGES} messages at a time.`, "too_many");
  return null;
}

// A request's JSON body as an object: no body, or anything else, reads as an empty one.
const obj = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? v : {}) as Record<string, unknown>;

// ---------- agent links ----------
// When a link was last used, for the Share panel. Written at most once a minute per link.
const used = new Map<string, number>();
function touch(token: string) {
  if (Date.now() - (used.get(token) ?? 0) < 60_000) return;
  used.set(token, Date.now());
  q(`update agent_links set last_used_at = now() where token = $1`, [token]).catch(() => {});
}

type Link = { agent: Agent; canvas: string; by: string };
async function linkOf(token: string): Promise<Link | null> {
  if (!/^[\w-]{20,64}$/.test(token)) return null;
  const [l] = await q<{ user_id: string; canvas_id: string; anon: unknown; name: string; program: unknown; owner: string }>(
    `select l.user_id, l.canvas_id, u."isAnonymous" as anon, u.name, u."isProgram" as program, c.owner_id as owner
       from agent_links l join "user" u on u.id = l.user_id join canvases c on c.id = l.canvas_id where l.token = $1`,
    [token],
  );
  return l
    ? {
        agent: {
          id: l.user_id,
          anonymous: !!l.anon,
          seat: seatOf(linkSeat(token), l.name),
          worksFor: l.program ? l.owner : l.user_id,
        },
        canvas: l.canvas_id,
        by: l.name,
      }
    : null;
}

function linkTool(l: Link, name: string, args: Record<string, unknown>) {
  nameSelf(l.agent, args.agent_name);
  if (name === "read_canvas") return readCanvas(l.agent, l.canvas, true);
  if (name === "put_elements") return putElements(l.agent, l.canvas, args.elements);
  if (name === "delete_elements") return deleteElements(l.agent, l.canvas, args.ids);
  if (name === "point") return point(l.agent, l.canvas, args);
  if (name === "screenshot_canvas") return screenshot(l.agent, l.canvas, args);
  throw new Refusal("unknown_tool", 404, `There is no tool named ${name}.`);
}

// What an agent reads first when given an agent link: everything it needs, with the link filled in.
function guide(url: string, title: string, editable: boolean, by: string) {
  const one = (s: string) => s.replace(/\s+/g, " ").trim();
  const lines = [
    `# ${title ? `"${one(title)}"` : "An untitled canvas"} on ${env.appName}`,
    "",
    `${one(by) || "Someone"} gave you this address to work with them on this canvas. People may be watching it: what you change appears for them at once. You can ${editable ? "read it and draw on it" : "read it, but not change it"}.`,
    "",
    "## Read the canvas",
    "",
    "```",
    `curl -s ${url}/elements`,
    "```",
    "",
    "You get the title and the elements, in Excalidraw's format without its bookkeeping fields. Coordinates are canvas pixels: x grows to the right, y grows down.",
  ];
  if (editable)
    lines.push(
      "",
      "## Draw, or change what is there",
      "",
      "```",
      `curl -s -X POST ${url}/elements -H 'content-type: application/json' -d '{"elements": [`,
      `  {"type": "rectangle", "id": "idea", "x": 100, "y": 100, "width": 220, "height": 90, "label": "First idea", "backgroundColor": "#ffec99"},`,
      `  {"type": "arrow", "x": 330, "y": 145, "points": [[0, 0], [160, 0]]},`,
      `  {"type": "text", "x": 100, "y": 220, "text": "A note"}`,
      `]}'`,
      "```",
      "",
      "- `type` is rectangle, ellipse, diamond, text, arrow, line, freedraw or frame.",
      "- Shapes need x, y, width and height. Text needs `text`, and `fontSize` if not 20. Arrows and lines need `points`, relative to x and y.",
      "- Optional: strokeColor and backgroundColor (CSS colors), fillStyle (solid, hachure, cross-hatch), strokeWidth, strokeStyle (solid, dashed, dotted), roughness (0 to 2), opacity (0 to 100), angle (radians), and `label` on a rectangle, ellipse or diamond to write inside it.",
      "- Choose an `id` to refer to an element later. Send an existing id to change that element: only the fields you send change.",
      "",
      "## Delete elements",
      "",
      "```",
      `curl -s -X POST ${url}/delete -H 'content-type: application/json' -d '{"ids": ["idea"]}'`,
      "```",
    );
  lines.push(
    "",
    "## Your name",
    "",
    "People see you under a generated name. To pick your own, add `agent_name` to any request, once, in its address as below or in the JSON you send: keep it short, one or two words.",
    "",
    "```",
    `curl -s '${url}/elements?agent_name=Mapper'`,
    "```",
    "",
    "## Show what you are looking at",
    "",
    "People see your cursor, and your shapes appear one by one. Point at a place or at elements, with a few words if you like:",
    "",
    "```",
    `curl -s -X POST ${url}/point -H 'content-type: application/json' -d '{"ids": ["idea"], "say": "This is where it starts"}'`,
    "```",
    "",
    "## Look at it",
    "",
    "A PNG of the canvas as people see it, whole, or a part of it in canvas pixels:",
    "",
    "```",
    `curl -s ${url}/screenshot -o canvas.png`,
    `curl -s '${url}/screenshot?x=0&y=0&width=800&height=600' -o part.png`,
    "```",
    "",
    "When the person cares about how it looks, take one to check your work before you say you are done: overlaps, text that spills out of its shape and crooked arrows show there, not in the coordinates.",
    "",
    STYLE,
    "",
    "## As an MCP server",
    "",
    `This address is also an MCP server (Streamable HTTP) with the tools read_canvas${editable ? ", put_elements, delete_elements" : ""}, point and screenshot_canvas. In Claude Code: \`claude mcp add --transport http ${env.appName} ${url}\`. In claude.ai or ChatGPT, add it as a custom connector.`,
    "",
    "Read the canvas before drawing, and leave room around what is already there.",
  );
  return lines.join("\n") + "\n";
}

// ---------- routes ----------
// For the admin's agent lists: what each of these people's agents is called (the key's name, or the canvas of
// the agent link) and when it was last used, by seat id; with the links programs' guests made to their
// canvases, named after their guest (`maker`).
export async function seatsOf(userIds: string[]) {
  const out = new Map<string, { label: string; kind: "key" | "link"; lastUsed: string | null; maker?: string }>();
  if (!userIds.length) return out;
  const marks = userIds.map((_, i) => `$${i + 1}`).join(", ");
  for (const k of await q<{ id: string; name: string; last_used_at: unknown }>(
    `select id, name, last_used_at from api_keys where user_id in (${marks})`,
    userIds,
  ))
    out.set(keySeat(k.id), { label: k.name, kind: "key", lastUsed: k.last_used_at ? toDate(k.last_used_at).toISOString() : null });
  for (const l of await q<{ token: string; title: string; last_used_at: unknown; maker: string; program: unknown }>(
    `select l.token, c.title, l.last_used_at, u.name as maker, u."isProgram" as program
       from agent_links l join canvases c on c.id = l.canvas_id join "user" u on u.id = l.user_id
      where l.user_id in (${marks}) or (c.owner_id in (${marks}) and u."isProgram")`,
    userIds,
  ))
    out.set(linkSeat(l.token), {
      label: l.title || "Untitled",
      kind: "link",
      lastUsed: l.last_used_at ? toDate(l.last_used_at).toISOString() : null,
      ...(l.program ? { maker: l.maker } : {}),
    });
  return out;
}

// A screenshot over plain HTTP: the part of the canvas comes as ?x=&y=&width=&height=.
const shotArgs = (c: Context) =>
  Object.fromEntries(["x", "y", "width", "height"].filter((k) => c.req.query(k) !== undefined).map((k) => [k, Number(c.req.query(k))]));
const png = (c: Context, p: Png) => c.body(new Uint8Array(p.data), 200, { "content-type": "image/png", "cache-control": "no-store" });

export function agents(app: Hono) {
  const json = async (c: Context) => obj(await c.req.json().catch(() => null));

  // Bodies up to 16 times the largest element, 32 MB by default: 500 elements of 64 KB each, or 16 of the largest,
  // more than any real call sends. Past it, the request is refused before its body is read.
  const maxBody = 16 * env.maxElementBytes;
  const tooBig = `The request is too big: at most ${maxBody >= 1048576 ? `${+(maxBody / 1048576).toFixed(1)} MB` : `${Math.ceil(maxBody / 1024)} KB`}.`;
  const limitBody = bodyLimit({
    maxSize: maxBody,
    onError: (c) =>
      c.req.path === "/mcp" || /^\/agent\/[^/]+$/.test(c.req.path)
        ? rpcRefusal(c, 413, "too_big", tooBig)
        : c.json({ error: "too_big", message: tooBig }, 413),
  });
  for (const path of ["/mcp", "/api/v1/*", "/agent/*"]) app.use(path, limitBody);

  // Keys, managed from Settings with the session cookie. A key is shown once and kept as a hash.
  app.get("/api/keys", async (c) => {
    const u = await sessionUser(c.req.raw.headers);
    if (!u) return c.json({ error: "not_signed_in" }, 401);
    const rows = await q<{ id: string; name: string; created_at: unknown; last_used_at: unknown }>(
      `select id, name, created_at, last_used_at from api_keys where user_id = $1 order by created_at`,
      [u.id],
    );
    return c.json(
      rows.map((r) => ({
        id: r.id,
        name: r.name,
        created: toDate(r.created_at).toISOString(),
        lastUsed: r.last_used_at ? toDate(r.last_used_at).toISOString() : null,
      })),
    );
  });
  app.post("/api/keys", async (c) => {
    const u = await sessionUser(c.req.raw.headers);
    if (!u) return c.json({ error: "not_signed_in" }, 401);
    const [{ n }] = await q<{ n: string }>(`select count(*) as n from api_keys where user_id = $1`, [u.id]);
    if (Number(n) >= 20) return c.json({ error: "too_many_keys" }, 403);
    hit("feature", "agent key created");
    const name =
      String((await json(c)).name ?? "")
        .trim()
        .slice(0, 60) || "Agent";
    const key = "bd_" + randomBytes(24).toString("base64url");
    const id = newId();
    await q(`insert into api_keys (id, user_id, name, hash) values ($1, $2, $3, $4)`, [id, u.id, name, hash(key)]);
    return c.json({ id, name, key });
  });
  app.delete("/api/keys/:id", async (c) => {
    const u = await sessionUser(c.req.raw.headers);
    if (!u) return c.json({ error: "not_signed_in" }, 401);
    await q(`delete from api_keys where id = $1 and user_id = $2`, [c.req.param("id"), u.id]);
    return c.json({ ok: true });
  });

  // The HTTP API: the key, then the same rights as the person. A body is read once, here. Its agent_name, like
  // the one in the query or the header, names the agent.
  const gate = (run: (a: Agent, c: Context, body: Record<string, unknown>) => Promise<Response>) => async (c: Context) => {
    const a = await agentOf(c);
    if (!a)
      return c.json({ error: "no_key", message: "Send a key: Authorization: Bearer bd_…" }, 401, {
        "www-authenticate": `Bearer realm="${env.appName}"`,
      });
    if (limited("agent:" + a.id, PER_MINUTE, 60_000)) return c.json({ error: "rate_limited", message: TOO_MANY }, 429);
    noteCall(a, "HTTP API");
    const body = c.req.method === "GET" ? {} : await json(c);
    nameSelf(a, c.req.query("agent_name"), c.req.header("x-agent-name"), body.agent_name);
    try {
      return await run(a, c, body);
    } catch (e) {
      if (e instanceof Refusal) return c.json({ error: e.code, message: e.message }, e.status);
      throw e;
    }
  };
  app.get(
    "/api/v1/canvases",
    gate(async (a, c) => c.json(await listCanvases(a))),
  );
  app.post(
    "/api/v1/canvases",
    gate(async (a, c, b) => c.json(await newCanvas(a, b.title))),
  );
  app.get(
    "/api/v1/canvases/:id",
    gate(async (a, c) => heavy(async () => c.json(await readCanvas(a, c.req.param("id"), c.req.query("compact") !== undefined)))),
  );
  app.get(
    "/api/v1/canvases/:id/screenshot",
    gate(async (a, c) => heavy(async () => png(c, await screenshot(a, c.req.param("id"), shotArgs(c))))),
  );
  app.post(
    "/api/v1/canvases/:id/elements",
    gate(async (a, c, b) => c.json(await putElements(a, c.req.param("id"), b.elements))),
  );
  app.delete(
    "/api/v1/canvases/:id/elements",
    gate(async (a, c, b) => c.json(await deleteElements(a, c.req.param("id"), b.ids ?? c.req.query("ids")?.split(",")))),
  );
  app.post(
    "/api/v1/canvases/:id/point",
    gate(async (a, c, b) => c.json(await point(a, c.req.param("id") ?? "", b))),
  );

  // MCP over HTTP: one JSON answer per request, no event stream, no session.
  app.get("/mcp", (c) => c.json({ error: "Use POST: this server answers in JSON, without an event stream." }, 405, { allow: "POST" }));
  app.post("/mcp", async (c) => {
    // A page from another site must not reach this through the browser of someone who runs it locally.
    if (!sameOrigin(c.req.header("origin"), c.req.header("host"))) return rpcRefusal(c, 403, "bad_origin", OTHER_SITE);
    const a = await agentOf(c);
    if (!a)
      return rpcRefusal(c, 401, "no_key", "Send a key: Authorization: Bearer bd_…", {
        "www-authenticate": `Bearer realm="${env.appName}"`,
      });
    if (limited("agent:" + a.id, PER_MINUTE, 60_000)) return rpcRefusal(c, 429, "rate_limited", TOO_MANY);
    const m = await c.req.json().catch(() => UNREADABLE);
    const bad = badRequest(c, m);
    if (bad) return bad;
    if (batchTooMany("agent:" + a.id, m)) return rpcRefusal(c, 429, "rate_limited", TOO_MANY);
    noteCall(a, "MCP");
    nameSelf(a, c.req.query("agent_name"), c.req.header("x-agent-name"));
    return answer(c, m, { list: TOOLS, call: (name, args) => tool(a, name, args), program: (p) => programs.set(a.seat.id, pretty(p)) });
  });

  // Agent links. Opening Share makes or finds the person's link to the canvas, for its Agents section; once a
  // link is turned off, the next one is new.
  app.post("/api/canvases/:id/agent-link", async (c) => {
    const u = await sessionUser(c.req.raw.headers);
    if (!u) return c.json({ error: "not_signed_in" }, 401);
    const r = await access(c.req.param("id"), u);
    if (r.role === "none") return c.json({ error: r.error ?? "private" }, 403);
    hit("feature", "agent panel opened");
    await q(`insert into agent_links (token, user_id, canvas_id) values ($1, $2, $3) on conflict (user_id, canvas_id) do nothing`, [
      randomBytes(24).toString("base64url"),
      u.id,
      r.cv!.id,
    ]);
    const [l] = await q<{ token: string }>(`select token from agent_links where user_id = $1 and canvas_id = $2`, [u.id, r.cv!.id]);
    return c.json({ url: `${env.baseUrl}/agent/${l.token}` });
  });

  // The agent links of a canvas, to watch and turn off from the Share panel: its owner sees everyone's,
  // anyone else only their own. A link is named by a hash of its token, never by the token itself.
  const linksOf = async (c: Context) => {
    const u = await sessionUser(c.req.raw.headers);
    if (!u) return null;
    const r = await access(c.req.param("id") ?? "", u);
    if (r.role === "none") return null;
    const owner = r.role === "owner";
    const rows = await q<{ token: string; user_id: string; name: string; created_at: unknown; last_used_at: unknown }>(
      `select l.token, l.user_id, u.name, l.created_at, l.last_used_at from agent_links l join "user" u on u.id = l.user_id
        where l.canvas_id = $1 ${owner ? "" : "and l.user_id = $2"} order by l.created_at`,
      owner ? [r.cv!.id] : [r.cv!.id, u.id],
    );
    return { me: u.id, rows };
  };
  app.get("/api/canvases/:id/agent-links", async (c) => {
    const l = await linksOf(c);
    if (!l) return c.json({ error: "private" }, 403);
    return c.json(
      l.rows.map((r) => ({
        id: linkId(r.token),
        mine: r.user_id === l.me,
        by: r.name,
        created: toDate(r.created_at).toISOString(),
        lastUsed: r.last_used_at ? toDate(r.last_used_at).toISOString() : null,
      })),
    );
  });
  app.delete("/api/canvases/:id/agent-links/:link", async (c) => {
    const l = await linksOf(c);
    const row = l?.rows.find((r) => linkId(r.token) === c.req.param("link"));
    if (!row) return c.json({ error: "not_found" }, 404);
    await q(`delete from agent_links where token = $1`, [row.token]);
    return c.json({ ok: true });
  });

  // What an agent link reaches: refusals in the form its address speaks, JSON-RPC on its MCP address (`mcp`) and
  // plain JSON on its HTTP routes. A body is read once, here: the MCP messages, or the JSON whose agent_name, like
  // the one in the query or the header, names the agent.
  const viaLink =
    (run: (l: Link, url: string, c: Context, body: unknown) => Promise<Response>, mcp = false) =>
    async (c: Context) => {
      const refuse = (status: Status, error: string, message: string) =>
        mcp ? rpcRefusal(c, status, error, message) : c.json({ error, message }, status);
      const token = c.req.param("token") ?? "";
      const l = await linkOf(token);
      if (!l) return refuse(404, "gone", "This agent link was turned off. Ask for a new one.");
      touch(token);
      if (c.req.method === "POST" && !sameOrigin(c.req.header("origin"), c.req.header("host")))
        return refuse(403, "bad_origin", OTHER_SITE);
      if (limited("agent-link:" + token, PER_MINUTE, 60_000)) return refuse(429, "rate_limited", TOO_MANY);
      const body = c.req.method === "POST" ? await c.req.json().catch(() => (mcp ? UNREADABLE : null)) : null;
      const bad = mcp && badRequest(c, body);
      if (bad) return bad;
      if (mcp && batchTooMany("agent-link:" + token, body)) return refuse(429, "rate_limited", TOO_MANY);
      noteCall(l.agent, mcp ? "Agent link, MCP" : "Agent link, HTTP");
      nameSelf(l.agent, c.req.query("agent_name"), c.req.header("x-agent-name"), mcp ? undefined : obj(body).agent_name);
      try {
        return await run(l, `${env.baseUrl}/agent/${token}`, c, body);
      } catch (e) {
        if (e instanceof Refusal) return refuse(e.status, e.code, e.message);
        throw e;
      }
    };
  app.get(
    "/agent/:token",
    viaLink(async (l, url, c) => {
      // MCP clients may ask for an event stream here: there is none, they use POST.
      if ((c.req.header("accept") ?? "").includes("text/event-stream"))
        return c.json({ error: "Use POST for MCP." }, 405, { allow: "GET, POST" });
      const r = await rights(l.agent, l.canvas);
      return c.body(guide(url, r.title, canEdit(r.role), l.by), 200, {
        "content-type": "text/markdown; charset=utf-8",
        "cache-control": "no-store",
      });
    }),
  );
  app.post(
    "/agent/:token",
    viaLink(async (l, _url, c, m) => {
      const r = await rights(l.agent, l.canvas);
      const list = canEdit(r.role) ? LINK_TOOLS : LINK_TOOLS.filter((t) => ["read_canvas", "point", "screenshot_canvas"].includes(t.name));
      return answer(c, m, {
        list,
        call: (name, args) => linkTool(l, name, args),
        program: (p) => programs.set(l.agent.seat.id, pretty(p)),
      });
    }, true),
  );
  app.get(
    "/agent/:token/elements",
    viaLink(async (l, _url, c) => heavy(async () => c.json(await readCanvas(l.agent, l.canvas, true)))),
  );
  app.post(
    "/agent/:token/elements",
    viaLink(async (l, _url, c, b) => c.json(await putElements(l.agent, l.canvas, obj(b).elements))),
  );
  app.get(
    "/agent/:token/screenshot",
    viaLink(async (l, _url, c) => heavy(async () => png(c, await screenshot(l.agent, l.canvas, shotArgs(c))))),
  );
  app.post(
    "/agent/:token/delete",
    viaLink(async (l, _url, c, b) => c.json(await deleteElements(l.agent, l.canvas, obj(b).ids))),
  );
  app.post(
    "/agent/:token/point",
    viaLink(async (l, _url, c, b) => c.json(await point(l.agent, l.canvas, obj(b)))),
  );
}
