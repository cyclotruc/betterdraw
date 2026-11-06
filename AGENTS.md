# AGENTS.md

Rules from the maintainers for coding agents working in this repository. Read docs/vision.md and
docs/architecture.md first.

- **Few tests.** The editor's tests came with the fork (`packages/`, Vitest) and run locally with
  `npm test`, not in CI. Add one only to pin a change you make in the editor's code; none elsewhere.
- **English only.** The product, its emails, the docs, the code, comments and commits are all in
  English. The editor's own translations came with the fork and stay as they are; add no others.
- **The editor is a fork of Excalidraw.** Read docs/fork.md before changing `packages/`, and add your
  change to its list in the same commit. Change their code where it lives, in their style (their
  Prettier settings, `packages/.prettierrc.json`, never the root's), with no marker comments, and keep
  each change small enough to read next to theirs.
- **Names.** The product is betterdraw, in lowercase, and the editor's packages are `@betterdraw/*`.
  Excalidraw keeps its name where it names their code, the `.excalidraw` file format or the Excalifont
  font (docs/fork.md).
- **Migrations.** Change the database only by adding a migration at the end of `server/migrations.ts`,
  written for both SQLite and Postgres. Never edit one that has shipped. A build's own migrations
  (`server/extend.ts`) take ids of their own.
- **Never sign a commit.** Commits and pull requests in this repository are signed by the people who make
  them. Add no co-author line for an AI, no session link, no "Generated with" line, and never commit as
  an agent: the author is the human you work for. `.claude/settings.json` turns Claude Code's own
  attribution off, the hook in `.githooks/` refuses such a commit (turn it on once per clone with
  `git config core.hooksPath .githooks`), and CI refuses one that gets through.
- **One light CI.** `.github/workflows/ci.yml` checks the signatures above, then installs, type-checks
  and builds. Keep it that small: no test job, no deploy.
- **No temporary documents.** No reports, plans, drafts, notes or research in the repository. The docs
  are README.md, THIRD_PARTY_NOTICES.txt, docs/vision.md, docs/architecture.md, docs/self-hosting.md,
  docs/mcp.md, docs/branding.md, docs/fork.md, docs/changelog.md, packages/editor/locales/README.md,
  .github/CONTRIBUTING.md, .github/SECURITY.md and .github/CODE_OF_CONDUCT.md.
- **Credit what you copy.** A font, an icon or code taken from another project gets its entry in
  THIRD_PARTY_NOTICES.txt, with its copyright lines and license, in the same commit.
- **docs/vision.md and docs/architecture.md stay minimal and current.** When a change makes one of them
  wrong, fix it in the same commit. Cut rather than add.
