# Branding

betterdraw comes with its own name, accent color and logo. A server can show its own instead: this page
lists where each one lives. If you host betterdraw for other people, give it a name and a logo of your
own, so that nobody takes your server for someone else's.

## Name and accent color

`branding/brand.json` holds both:

```json
{ "name": "betterdraw", "accent": "#e8590c" }
```

The server and the app read it when they start and build: page titles and link previews, the emails
and their default sender, the sidebar and the welcome screen, the prompt and instructions given to
agents, export file names, and the accent color every person starts with. People can still pick
another accent in Settings, among those listed in `web/src/prefs.ts`, where the first one is yours.

A few places hold the color itself, because they apply before the app's script runs or where it never
runs. Change them along with `brand.json`:

- `web/index.html`: the `theme-color` of the browser's bar.
- `web/src/styles.css`: `--accent` at the top, from which its lighter and darker shades are mixed.
- `server/app.ts`: the link colors of the legal pages, a darker shade of the accent on white and a
  lighter one on black.
- `packages/editor/renderer/helpers.ts`: `DEFAULT_SELECTION_COLOR`, the editor's selection color when
  the page gives none.

## Logo and images

- `web/src/Logo.tsx`: the mark shown in the sidebar and on the welcome screen. Its square takes the
  accent color, its sketch the text color.
- `web/public/`: `favicon.svg` (the mark redrawn on a 16 px grid, so it stays crisp in a tab),
  `favicon.ico`, `apple-touch-icon.png` (180×180), `og.png` (the link preview of every page that is not
  a shared canvas, 1200×630) and `email-logo.png` (the top of every email, 344×64, shown at half size).
- `branding/svg/` and `branding/png/`: the sources of the mark, the wordmark and the icon, for light
  and dark backgrounds. Nothing reads them at run time.

## Font

The name in the sidebar and on the welcome screen, the Share button and a few titles are set in
Bricolage Grotesque ExtraBold, under the SIL Open Font License (`branding/font/OFL.txt`). It is served
from `web/public/fonts/`, declared at the top of `web/src/styles.css`, and loaded by the emails too
(`server/mail.ts`). Drawings use the editor's own fonts, which stay as they are.
