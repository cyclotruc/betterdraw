# Translations

The editor's text in each language, one file per language, as Excalidraw's translators left them when we
forked ([docs/fork.md](../../../docs/fork.md)). `en.json` is the source: a key missing from another language
falls back to it.

The editor takes its language from its `langCode` prop, English by default. The betterdraw app sets none,
so the editor shows English, like the app's own text (`web/src/texts.ts`). These files stay as they came
([AGENTS.md](../../../AGENTS.md)): no new languages, and the strings we add are in English only.
