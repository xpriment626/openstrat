# Lane 1 Checkpoint: Local CLI Baseline

Date: 2026-06-10
Branch: `goal/06-16-2026-e2e-scaffolding`

## Files Changed

- `.gitignore`
- `packages/cli/README.md`
- `packages/cli/build.mjs`
- `packages/cli/package.json`
- `packages/cli/src/package-metadata.test.ts`

## What Changed

- The published `openstrat` bin now points to `dist/openstrat`, a generated shell wrapper.
- The wrapper resolves the invoked npm bin shim and prefers the adjacent `node` executable before falling back to `env node`.
- This fixes linked installs where `openstrat` resolves from the nvm prefix but `node` resolves to an older `/usr/local/bin/node`.
- The CLI README now documents the package-local link loop.
- Local `openstrat-*.tgz` pack artifacts are ignored.

## Commands Run

- `pnpm test packages/cli/src/package-metadata.test.ts`
- `pnpm build`
- `cd packages/cli && npm link`
- `zsh -lc 'hash -r; command -v openstrat; openstrat --version'`
- `openstrat init --cwd <temp-workspace>` with temp `HOME`
- `openstrat doctor --cwd <temp-workspace>` with temp `HOME`
- `OPENSTRAT_FAKE_PI=1 openstrat chat --cwd <temp-workspace> --prompt "Say hello from OpenStrat in one sentence."` with temp `HOME`

## Pass/Fail Status

- `pnpm build`: passed.
- Package-local `npm link`: passed from `cd packages/cli`.
- Fresh-shell `openstrat --version`: passed and printed `0.0.1-dev.0`.
- Fresh-shell `openstrat doctor`: passed with Node `24.10.0 (ok)`.
- Fresh-shell fake `openstrat chat`: passed and printed `Hello from OpenStrat.`

## Remaining Issues

- `openstrat doctor` still reports `Codex auth: missing` and `Fly: auth unavailable` in the temp smoke environment. That is expected for a clean temp `HOME` and is not a Lane 1 blocker.
- Node emits the experimental SQLite warning during CLI runs.

## Next Lane Unlocked

Lane 2: Pi tool gateway bridge. The CLI is now locally linkable and runnable from a fresh shell, so the next slice can focus on routing fake Pi tool calls through `AgentToolGateway`.
