# Sinfonie

Electron + React desktop app: multi-repo agent workspaces. Main process in `src/main`, renderer in
`src/renderer/src`, shared types and the IPC contract in `src/shared`.

- **Before any UI or UX work, read [`docs/design/README.md`](docs/design/README.md)**: the personas, the
  role/mode model, Maestro's behaviour, voice rules for guided mode, the visual system and interaction rules.
- Checks: `pnpm typecheck` (both tsc projects plus `pnpm lint:ui`) and `pnpm build`.
- Guided mode must never show developer jargon: use `useWords()` (`lib/guided.ts`) and `friendlyError()`
  (`lib/errors.ts`), and watch the dev-only guided checker's console warnings in `pnpm dev`.
