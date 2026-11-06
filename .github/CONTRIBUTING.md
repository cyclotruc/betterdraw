# Contributing

The project stays small on purpose: before adding a feature, ask whether it can be done with fewer
moving parts, fewer clicks for the people drawing, and no new dependency. [docs/vision.md](../docs/vision.md)
says what the project is for, [docs/architecture.md](../docs/architecture.md) where things are.

## Set up

```bash
npm install
cp .env.example .env  # optional: without it, everything lives in ./data, with SQLite
npm run dev           # server on :3000, Vite on :5173 (open this one)
```

## Rules

- `npm run check` (types) and `npm run build` must pass; CI runs both on every pull request.
- The editor in `packages/` is a fork of Excalidraw: read [docs/fork.md](../docs/fork.md) before changing
  it, add your change to its list, and run its tests with `npm test`.
- Change the database only by adding a migration at the end of `server/migrations.ts`, written for both
  Postgres and SQLite.
- Every string a person reads goes through `t()`, from `web/src/texts.ts`, in English.
- Few tests: the editor's came with the fork and run locally, not in CI. Add one only to pin a change you
  make in the editor.
- Sign your commits as yourself. If an AI agent helps you, it adds no co-author line, session link or
  "Generated with" line: CI refuses those, and so does the hook in `.githooks/` once you turn it on with
  `git config core.hooksPath .githooks`.
- Keep comments for the why, in plain sentences.

Security problems go to [SECURITY.md](SECURITY.md), not to a public issue. Everyone here follows the
[code of conduct](CODE_OF_CONDUCT.md).
