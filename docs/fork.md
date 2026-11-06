# The editor is a fork of Excalidraw

The editor in `packages/` is a hard fork of [Excalidraw](https://github.com/excalidraw/excalidraw) (MIT). It
started as their `packages/` folder at commit
[701b901](https://github.com/excalidraw/excalidraw/commit/701b901a0f1ba3d0b390d9cdf63d112e25abac4b) of
their `master` (2026-11-05), and it is our code from there: we change it like the rest of the repository,
with no markers in the code and nothing that syncs with them. A fix of theirs comes over by hand (below).

## Names

| Theirs | Ours |
|---|---|
| `packages/excalidraw`, `@excalidraw/excalidraw` | `packages/editor`, `@betterdraw/editor` |
| `@excalidraw/common`, `element`, `math`, `utils`, `fractional-indexing`, `laser-pointer` | `@betterdraw/` and the same name |

What keeps the Excalidraw name, on purpose: the identifiers in the code (`Excalidraw`, `ExcalidrawElement`
and the like), the `.excalidraw` file format with its MIME and clipboard types, so files and pastes still
work both ways, the Excalifont font, the links to their documentation, and the
`@excalidraw/mermaid-to-excalidraw` package, which comes from npm as before.

## How the app uses it

The app compiles the editor from source: `packages/aliases.mjs` maps every `@betterdraw/*` name to its
folder, for Vite, for TypeScript (`packages/tsconfig.paths.json`) and for the tests. Nothing in `packages/`
is built or published on its own. The packages are npm workspaces, on the repository's one lockfile.

Their tests came along and run locally with `npm test` (Vitest, in jsdom), not in CI. `packages/` keeps their
Prettier settings (80 columns), not ours.

The server does not import the editor: `server/agents.ts` keeps its own copy of the element defaults, since
their code needs a bundler to run in Node. When their defaults change, that copy is updated by hand.

## What we changed in their code

- Fonts come from our own site only: no CDN fallback (`fonts/ExcalidrawFontFace.ts`).
- Liberation Sans is version 2.1.5, under the OFL, instead of 1.05, under the GPL. Lilita One is the whole
  font instead of two Google Fonts subsets (`fonts/Liberation`, `fonts/Lilita`).
- In the browser, a font embedded whole in an export goes to base64 32 KB at a time: Liberation Sans is too
  large for one call (`subset/subset-shared.chunk.ts`).
- `roundRect` is our own code: theirs came from a Stack Overflow answer, under CC BY-SA
  (`renderer/roundRect.ts`).
- The points of a selected line or arrow, and the focus point of a bound arrow, take the selection color,
  so they follow the accent (`renderer/interactiveScene.ts`). Where the theme gives no selection color,
  it is our orange (`renderer/helpers.ts`).
- The theme takes our palette from the page's tokens: `--accent` and its shades, and our neutral greys
  (`css/theme.scss`).
- Alt+Z (zen mode) takes the key marked Z on a Latin layout, AZERTY included, wherever Alt leaves the letter
  alone, as on Windows and Linux. Where it does not, as Option does on macOS, and on other layouts, it takes
  the key where QWERTY has Z, as theirs always does (`actions/actionToggleZenMode.tsx`, `matchKey` in
  `common/src/keys.ts`).
- Ctrl+K adds a link only when one element is selected; otherwise the key is left to the app, which
  searches with it (`actions/actionLink.tsx`).
- `setViewport` takes `keepFollowing`, for moves that keep up with the person being followed
  (`viewport.ts`, `components/App.viewport.ts`).
- No panning hint with nothing selected, and no shortcut badges on the tool buttons; their tooltips keep
  the shortcuts (`components/HintViewer.tsx`, `components/Tools.tsx`, `components/IconButton.tsx`).
- The avatar list keeps room for two avatars (`components/UserList.scss`).
- Zen mode keeps the host's top-right UI on screen (`renderTopRightUI` gets the app state to choose what
  it shows), fades the zoom controls out with the rest, and leaves the toolbar's bars their background and
  shadow (`components/LayerUI.tsx`, `footer/Footer.tsx`, `css/styles.scss`).
- The help dialog is titled with its shortcuts, and a dialog with nothing to focus inside takes the focus
  itself, so Escape closes it (`components/HelpDialog.tsx`, `components/Dialog.tsx`).
- No help button and no exit-zen button in the footer: the app has its own. An empty `MainMenu` shows no
  button, and the top-left row keeps a button's height and width, so the shape settings under it stay put
  and the toolbar beside it stays clear of what the app shows there (`footer/Footer.tsx`,
  `main-menu/MainMenu.tsx`, `css/styles.scss`).
- The image export dialog is titled "Export as image" and gives the size of the image in a corner of the
  preview, from `getExportSize` (`components/ImageExportDialog.tsx`, `scene/export.ts`).
- On wider screens the toolbar is a row of short bars: lock, hand and selection; shapes and lines; draw,
  text, image and eraser; an arrow that opens a menu of the other tools (sticky note, frame, web embed,
  draw to shape, bucket fill, lasso, and Mermaid below a line, with no "Generate" heading) and shows the
  one in use; and the laser pointer at the end. That is the only laser button, also when drawing together:
  theirs beside the toolbar is gone (`components/Toolbar.tsx`, `components/Toolbar.scss`,
  `components/Tools.tsx`, `components/LayerUI.tsx`, `components/App.tsx`, `components/ToolIcon.scss`, and
  `components/LaserPointerButton.tsx`, deleted). Phones keep their toolbar. "Web embed" is written in
  sentence case (`locales/en.json`). The menu calls the frame tool "Frame", where the phone's menu and the
  command palette say "Frame tool".
- The sticky note, in that menu, can no longer be dragged out of the toolbar onto the canvas. The drag stays
  in the code (`components/App.toolDrag.ts` and its calls in `components/App.tsx`), which no button reaches:
  `tests/toolDrag.test.tsx` starts it by hand.
- The public `isCollaborating` prop does nothing: what read it went with the laser button that drawing
  together put beside the toolbar (`types.ts`, `index.tsx`).
- A menu item's badge with no type is green, and there is no blue type
  (`components/dropdownMenu/DropdownMenuItem.tsx`).
- The default sidebar opens on its search tab, and has no button of its own at the top right: Ctrl+F, the
  API or a button of the host's opens it (`common/src/constants.ts`, `components/LayerUI.tsx`).
- Opening or dropping a `.excalidrawlib` file says its type is unsupported, and library data dropped on the
  canvas is ignored (`components/App.tsx`).
- After loading a file shared to the app, the share target puts the address back under the page's title
  rather than "Excalidraw" (`components/App.tsx`).
- Dropdown menus open from the keyboard: Enter and Space toggle one, ArrowDown opens it, and closing it from
  the keyboard gives the focus back to its button. The keys used in a menu stay in it: the canvas moved or
  edited the selection with them too (`components/dropdownMenu/DropdownMenuTrigger.tsx`,
  `components/dropdownMenu/DropdownMenuContent.tsx`).
- An `iframe` element, the page Excalidraw's AI built from a wireframe, shows a fixed notice instead of its
  HTML or its error message, and nothing runs in it: a file, a paste or a collaborator can put anything there.
  Web embeds keep their sandbox. Each embed's frame is titled "Embedded content" (`components/App.tsx`).
- Strings in `locales/en.json` that sent people to their GitHub or named Excalidraw say less:
  `toast.unableToEmbed`, the last two lines of the Brave warning, and `mermaid.description`, where diagrams
  become "shapes you can edit". The other locales lack those two Brave lines, which an editor in another
  language shows in English, and still say "Mermaid to Excalidraw": the app shows only English.

## What we removed

What betterdraw never shows is deleted rather than hidden: the shape library, the AI features (Mermaid
stays, as "Mermaid to diagram"), Excalidraw's promotions, links and logo, the analytics hooks, the
translation keys no code uses, and the dependencies only these needed. The actions keep declaring
`trackEvent` as theirs do, though nothing reads it, so that their files stay close to theirs for fixes.
The `magicframe` tool type and the `iframe` and `magicframe` elements stay, so that drawings made with their
AI still open: the tool draws a frame titled "AI Frame", and nothing generates from it.

Code that nothing used goes too:

- The icons in `components/icons.tsx` that nothing imported. Each icon there ships, used or not.
- `nFormatter` (`common/src/utils.ts`).
- `ShareableLinkDialog`, theirs for a collaboration link, with its strings.
- `excalidrawlibIds` in the public `MIME_TYPES`, the type of an item dragged out of the shape library.
- The public `WelcomeScreen.Hints.HelpHint`, whose arrow pointed at the footer's help button: the default
  welcome screen goes without it, and the footer keeps no place for it.

## Taking a fix from Excalidraw

In a clone of their repository, turn the commit into a patch with our paths and names, then apply it here
and settle what does not apply by hand:

```sh
# in excalidraw/
git format-patch -1 <commit> --stdout -- packages/ |
  sed -E -e 's#packages/excalidraw/#packages/editor/#g' \
      -e 's#@excalidraw/excalidraw([^[:alnum:]_]|$)#@betterdraw/editor\1#g' \
      -e 's#@excalidraw/(common|element|math|utils|fractional-indexing|laser-pointer)([^[:alnum:]_]|$)#@betterdraw/\1\2#g' \
  > /tmp/fix.patch

# in betterdraw/
git apply --reject /tmp/fix.patch   # each hunk that does not apply lands in a .rej file
```

The `sed` sticks to POSIX extended expressions, so the one on macOS runs it as GNU's does. It also renames
their links to docs.excalidraw.com, which keep their name here: put those back.

Our histories differ, so `git am -3` cannot fall back on a three-way merge: read the `.rej` files against
the list above, where our code and theirs part. Then run `npm test`, and say in the commit message which
of their commits it brings.
