# Lane 5 Checkpoint: Codex-First CLI Flow

Date: 2026-06-11
Branch: `codex/codex-app-server-runtime`

## Files Changed

- `packages/cli/src/commands.ts`
- `packages/cli/src/commands.test.ts`

## What Changed

- `openstrat chat` now defaults to the Codex app-server runtime path.
- Added `--runtime pi` / `OPENSTRAT_CHAT_RUNTIME=pi` as the explicit Pi fallback.
- Added Codex app-server chat session creation through the fake app-server adapter.
- CLI Codex chat now writes Codex binding and transcript files under OpenStrat home.
- CLI output now reports `runtime: codex_app_server`, Codex thread id, transcript path, and disabled native tools.
- Added Codex final-only output handling through projected `agent.runtime.turn_completed` events.
- Preserved the existing Pi final-only path behind `--runtime pi`.

## Commands Run

- `pnpm test packages/cli/src/commands.test.ts`
- `pnpm --filter @openstrat/agent-runtime build`
- `pnpm --filter openstrat typecheck`
- `pnpm test packages/agent-runtime/src/codex-app-server-adapter.test.ts packages/cli/src/commands.test.ts`
- `pnpm format:check`
- `git diff --check`

## Pass/Fail Status

- CLI command tests: passed, 11 tests.
- Codex adapter plus CLI focused tests: passed, 18 tests.
- CLI package typecheck: passed after refreshing ignored agent-runtime build output.
- Repository format check: passed.
- Whitespace diff check: passed.

## Remaining Issues

- Resume/recovery is not yet exposed from the CLI over persisted Codex bindings.
- The Codex CLI path still uses the fake app-server adapter scaffold.
- Docs still need to describe Codex as the first-class runtime and Pi/OpenRouter as boundaries.

## Next Lane Unlocked

Lane 6: Resume and recovery. The CLI now creates Codex app-server sessions and durable bindings by default, so the next lane can resume from those bindings and prove interrupted sessions can continue without losing OpenStrat-owned transcript/event state.
