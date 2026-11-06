# Agents and MCP

AI agents (Claude Code, claude.ai, ChatGPT, Cursor, any MCP client) and scripts read and draw on canvases
with the access of the person they act for. A canvas is an Excalidraw scene, and agents work on it live: the
people on it see the agent among the avatars with a robot face, its cursor beside what it reads or draws,
its shapes appearing one by one, and a card that names it and what it changed, which shows the change when
clicked.

| | Agent link | Key |
|---|---|---|
| Made in | Share, under "Agents" | Settings, under "Agents" |
| Gives | one canvas | every canvas of the person |
| MCP | `POST /agent/<token>` | `POST /mcp` with `Authorization: Bearer <key>` |
| Plain HTTP | under `/agent/<token>/` | under `/api/v1` |

Use an agent link to work on one canvas with nothing to set up, and a key when the agent should list, open
and create canvases. The addresses the server hands out start with `BASE_URL`: set it to the public address
([self-hosting.md](self-hosting.md)).

## One canvas: the agent link

On a canvas, open **Share**. Its "Agents" section has two tabs. **Prompt** is a message to paste to any
agent: it names the canvas and asks the agent to open the agent link first, since the page there explains
how to read the canvas and draw on it. **MCP** is the agent link alone, to add to an MCP client. Each person
has one link per canvas, `https://draw.example.com/agent/<token>`, made the first time they open Share.

| Request | What it does |
|---|---|
| `GET /agent/<token>` | A Markdown page that tells the agent how to work, with `curl` examples using the link. |
| `POST /agent/<token>` | The MCP server for this canvas. |
| `GET /agent/<token>/elements` | Reads the canvas, in the compact form described below. |
| `POST /agent/<token>/elements` | Adds or changes elements: `{"elements": [...]}`. |
| `POST /agent/<token>/delete` | Deletes elements: `{"ids": [...]}`. |
| `POST /agent/<token>/point` | Moves the agent's cursor: `{"x": 10, "y": 20}` or `{"ids": [...]}`, and an optional `say`. |
| `GET /agent/<token>/screenshot` | A PNG of the canvas, or of a part of it: `?x=0&y=0&width=800&height=600`. |

A link acts with the access its person has on the canvas at the time of each request. When that person can
only view the canvas, the page leaves out drawing and deleting, the MCP server offers only `read_canvas`,
`point` and `screenshot_canvas`, and writes answer 403 `read_only`. When the person can no longer open the
canvas, requests answer 403 `private`. A link that was turned off answers 404 `gone`.

## All canvases: a key

In **Settings**, under "Agents", press **Create a key**. The key starts with `bd_` and is shown once. A
person can have 20 keys; Settings lists them, named after the day they were made, with their last use and
a **Revoke** button. Send the key as `Authorization: Bearer <key>`, to `POST /mcp` or to the HTTP API:

| Request | What it does |
|---|---|
| `GET /api/v1/canvases` | Lists canvases, as `list_canvases` does. |
| `POST /api/v1/canvases` | Creates a canvas: `{"title": "Roadmap"}`. |
| `GET /api/v1/canvases/<id>` | Reads a canvas with Excalidraw's full elements; `?compact` gives the compact form. |
| `POST /api/v1/canvases/<id>/elements` | Adds or changes elements: `{"elements": [...]}`. |
| `DELETE /api/v1/canvases/<id>/elements` | Deletes elements: `{"ids": [...]}`, or `?ids=a,b`. |
| `POST /api/v1/canvases/<id>/point` | Moves the agent's cursor, as on an agent link. |
| `GET /api/v1/canvases/<id>/screenshot` | A PNG of the canvas, or of `?x=&y=&width=&height=`. |

Without a valid key, requests answer 401 with `WWW-Authenticate: Bearer`. There is no OAuth, and the
addresses under `/.well-known/` where clients look for it answer 404: the client must send the header, as
in `curl -H "Authorization: Bearer $KEY" https://draw.example.com/api/v1/canvases`, with `Bearer` in any
case. HTTP errors are JSON with a matching status, such as
`{"error": "read_only", "message": "This canvas is view-only for you."}`.

## Connect a client

Claude Code, with an agent link or with a key:

```bash
claude mcp add --transport http betterdraw https://draw.example.com/agent/<token>
claude mcp add --transport http betterdraw https://draw.example.com/mcp --header "Authorization: Bearer <key>"
```

claude.ai and ChatGPT take an MCP server as a URL: add the agent link as a custom connector. They connect
from their own servers, so the betterdraw server must be reachable from the internet. Cursor reads MCP
servers from its `mcp.json`; with an agent link, give only the `url`:

```json
{
  "mcpServers": {
    "betterdraw": {
      "url": "https://draw.example.com/mcp",
      "headers": { "Authorization": "Bearer <key>" }
    }
  }
}
```

Any other MCP client works with the same address and header. The server speaks Streamable HTTP without
sessions or event stream: each POST carries one JSON-RPC message or a list of up to 20, run one after the
other, and gets one JSON answer (202 with no body for notifications alone), and `GET /mcp` answers 405. It
accepts the protocol versions 2025-11-25, 2025-06-18, 2025-03-26 and 2024-11-05, answers `initialize`,
`ping`, `tools/list` and `tools/call`, and offers tools only. Its answer to `initialize` carries
instructions for the agent: how to work on a canvas people may be watching, and a drawing style. An agent
without MCP needs only the prompt: the page behind the link explains the plain HTTP calls.

A request refused as a whole, before its messages are read, still gets a JSON-RPC error, with `id` null
and the status the HTTP API would give: no key (401), a page from another site (403), an agent link turned
off (404) or whose canvas its person can no longer open (403), too big a request (413) or too many (429).
Its `code` is -32000 past the rate limit and -32001 otherwise, its `message` says why, and `data.error`
holds the reason the HTTP API gives in `error`, such as `rate_limited`. A body that is not JSON gets -32700,
and an empty list or one of more than 20 messages -32600, both with status 400. In a list, a message the
server fails on gets -32603 and the others their answers.

## Tools

| Tool | What it does | Parameters | Offered on |
|---|---|---|---|
| `list_canvases` | Lists the canvases the person owns or has opened, most recently changed first, at most 200: `id`, `title`, `url`, `mine`, `updated`. | none | `/mcp` |
| `create_canvas` | Creates an empty canvas owned by the person and returns its `id` and `url`. | `title` | `/mcp` |
| `read_canvas` | Returns the canvas's `id`, `title`, `url`, the person's `role` on it, and its elements in compact form. | `canvas` | `/mcp`, links |
| `put_elements` | Adds or changes up to 500 elements and returns the ids `created` and `updated`. | `canvas`, `elements` | `/mcp`, links that can edit |
| `delete_elements` | Deletes up to 500 elements and the text inside them, and returns the ids `deleted`. | `canvas`, `ids` | `/mcp`, links that can edit |
| `point` | Moves the agent's cursor to the elements of `ids` found on the canvas, or else to `x` and `y`, with up to 140 characters of `say` beside it. Changes nothing. | `canvas`, `x`, `y`, `ids`, `say` | `/mcp`, links |
| `screenshot_canvas` | Returns a PNG of the whole drawing, or of the part given by `x`, `y`, `width` and `height`. | `canvas`, `x`, `y`, `width`, `height` | `/mcp`, links |

`canvas` is a canvas id or its address; over an agent link, tools take no `canvas`. Every tool also takes
`agent_name`. A result is JSON in a text block, or an image for a screenshot. A refusal is a result marked
`isError` with one sentence, such as "This canvas is view-only for you."

**Reading.** The compact form keeps each element's `id`, `type`, `fileId` and the fields an agent can write
(below) except `fontFamily`. It leaves out deleted elements, fields that are empty or at their default, and
the points of freedraw elements and of any element with more than 100 points, and rounds `x`, `y`, `width`,
`height` and points to whole pixels. `GET /api/v1/canvases/<id>` without `?compact` returns Excalidraw's
full elements. Text inside a shape is a text element whose `containerId` is the shape's id.

**Writing.** Coordinates are canvas pixels, x to the right and y down. A new element needs a `type`:
`rectangle`, `ellipse`, `diamond`, `text`, `arrow`, `line`, `freedraw` or `frame`. The server takes the
fields below, and ignores without an error every other field and every value that fails its check:

| Fields | Accepted values |
|---|---|
| `x`, `y`, `angle` (radians), `fontFamily` | numbers |
| `width`, `height`, `strokeWidth`, `fontSize` | numbers from 0 |
| `roughness` | numbers from 0 to 2 |
| `opacity` | numbers from 0 to 100 |
| `fillStyle` | `solid`, `hachure`, `cross-hatch` or `zigzag` |
| `strokeStyle` | `solid`, `dashed` or `dotted` |
| `textAlign` | `left`, `center` or `right` |
| `verticalAlign` | `top`, `middle` or `bottom` |
| `text`, `label` (below), `strokeColor`, `backgroundColor` | strings up to 20,000 characters |
| `frameId`, `link`, `containerId`, `startArrowhead`, `endArrowhead`, `name` | null, or strings up to 2,000 characters |
| `groupIds` | up to 50 ids |
| `points` | 1 to 10,000 `[x, y]` pairs, relative to the element's `x` and `y` |
| `locked` | true or false |

A new element starts at 0, 0, 100 by 100, with a `#1e1e1e` stroke 2 wide, a transparent background, solid
fill and stroke, roughness 1 and opacity 100; text at 20 pixels in Excalifont, aligned left and top; arrows
with an arrowhead at the end. When a call gives a text or a font size, the server estimates the text's width
and height, unless both are given. An arrow or line without `points` runs from its `x`, `y` across its
`width` and `height`; with `points`, its size follows them. `label`, on a rectangle, ellipse or diamond,
writes text centered inside it, as a text element bound to the shape. A shape has one label: a new `label`
replaces its text and deletes any other text inside the shape, and moving or resizing the shape centers
the label again. The answer does not list the label's id.

**Ids.** An id has up to 64 letters, digits, `_` or `-`; without one, the server makes one. Sending an
existing id changes that element: only the fields given change, and its type stays. Sending the id of a
deleted element makes a new one. New elements go above everything already there, in the order given. A call
is refused as a whole (400) when an element is not an object, has a malformed id, or is new with an unknown
type. When the canvas is full, the answer's `refused` says how many elements did not fit, and `created` and
`updated` list only the elements written. `delete_elements` also deletes the elements whose `containerId`
is one of the ids, and skips ids it does not find. A label deleted on its own leaves its shape without one.

**Names and presence.** People see an agent as "Name (Person)", Person being whoever it acts for.
`agent_name` sets Name: up to 24 characters, without control characters, `<` or `>`. It goes in a tool's
arguments, in the address of any request as `?agent_name=`, in an `X-Agent-Name` header, or in the JSON
sent to an HTTP route. Until then, Name is the program name the MCP client gave (`claude-code` shows as
"Claude Code"), or "Agent". The server keeps it for that key or link until it gets another or restarts. An
agent stays in a canvas's room ten minutes after its last call there, active for the first minute, its
cursor beside what it last read, drew, deleted or pointed at.

**Screenshots.** Excalidraw's own export draws the PNG in a headless Chromium on the server: the light
theme, the canvas's background color, and its images up to 20 MB in all. The picture is at most twice the
canvas scale and 1600 pixels on its longer side. A part needs all four of `x`, `y`, `width` and `height`,
with sizes from 1 to 50,000; a whole empty canvas is refused. The browser starts with the first screenshot,
draws one at a time and closes after two idle minutes. A picture still unfinished after 30 seconds is given
up, so that the ones waiting behind it go on, and its browser is closed: the tool answers "Drawing this
picture took too long. Ask for a part of the canvas: x, y, width and height." (over HTTP, 503 `too_slow`), and
the next screenshot starts a fresh browser. The Docker image includes it. Without Docker, run
`npx playwright-core install chromium-headless-shell` in the repository (with `--with-deps`, as root, when the
system lacks the libraries it needs), or point `CHROMIUM_PATH` at a Chromium executable. Without it, the tool
answers "Screenshots are not available on this server right now." (over HTTP, 503 `unavailable`) and the
server output says why.

## Limits

| What | Limit |
|---|---|
| Requests with a key | 600 a minute per person: all their keys, MCP and HTTP together, each message of an MCP list counting as one |
| Requests through an agent link | 600 a minute per link, counted the same way |
| Screenshots | 20 a minute per person, keys and links together |
| Elements per `put_elements`, ids per `delete_elements` | 500 |
| One element | 2 MB as JSON (`MAX_ELEMENT_KB`) |
| One request | 32 MB, 16 times the largest element (`MAX_ELEMENT_KB`) |
| Messages per MCP request | 20, run one after the other, whose answers hold 32 MB in all |
| Canvas reads and screenshots | 4 at once on the whole server; the others wait their turn |
| Elements per canvas | 50,000, deleted ones included (`MAX_ELEMENTS_PER_CANVAS`) |
| One canvas | 100 MB of elements as JSON, deleted ones included (`MAX_CANVAS_MB`) |
| Canvases per person | 5 for a guest, no limit for an account (`QUOTA_CANVASES_GUEST`, `QUOTA_CANVASES_USER`) |
| Keys | 20 per person |

Past a rate limit, the server answers with status 429; over MCP, a screenshot past its limit is a refusal.
A request past its size is refused with 413 before it is read. A list of more than 20 MCP messages is
refused as a whole with status 400 and JSON-RPC error -32600. Once the answers to a list pass 32 MB, the
message whose answer passed it and every message after it are answered with error -32000 ("Response too
large"), and those after it are not run. On a full canvas, `put_elements` writes what fits and says how many
elements did not. Past the canvas quota, `create_canvas` is refused.

## Security

- An agent acts with its person's rights, and whoever holds its key or link can do the same. Neither
  expires. A key reaches every canvas the person owns or has opened, creates canvases, and opens any canvas
  whose address it is given, as the person could in a browser; that canvas then joins the person's list. A
  link reaches its one canvas with whatever access its person has there at each request. When that access
  came from opening the canvas's address, the link follows what the address gives: it only reads once the
  owner makes the canvas view-only, is refused once the canvas is private, and draws again once the owner
  lets anyone with the address edit.
- Keys are stored as a SHA-256 hash and shown once. **Revoke** in Settings takes effect on the next request.
- Agent link tokens are stored in clear, in the `agent_links` table, so that Share can show the same link
  again: like a canvas address, the link is the secret. In Share, under "Agents", **Active links** shows
  your link to the canvas, or every link to it for its owner. **Turn off** cuts a link at once; turning off
  your own gives you a new one.
- Keys and links are deleted with their person's account, links also with their canvas when it is deleted
  for good. A guest's keys and links pass to the account the guest signs in to from its own browser. When
  the email link is opened in another browser, the account gets the guest's canvases but not its keys and
  links, which are deleted.
- Writes from a page on another site are refused: a POST or DELETE whose `Origin` names neither the
  server's address nor `BASE_URL` answers 403 `bad_origin`. Requests without an `Origin`, as scripts send
  them, pass.
- The server prints nothing for agent requests, only a line with the reason when a screenshot fails. The
  database keeps the last use of each key and link, and the admin dashboard's daily counters, without an end
  date: agent calls, the canvases agents worked on and the shapes they drew. Admins also see recent agent
  actions live. The token is in the URL, so a reverse proxy's access log can hold it: `deploy/Caddyfile`
  rewrites `/agent/<token>` and `/c/<id>` before writing its log.
