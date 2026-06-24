# Global Install TUI Hardening Goal Report

Status: completed locally, uncommitted.

## Objective

Harden OpenStrat for a real global-install end-to-end local strategy workbench trial. The target user flow is a globally installed `openstrat` binary that can be run in a clean project directory, authenticate Codex, guide the user through data planning/ingestion, strategy authoring, validation, local backtesting, local risk preflight, artifact inspection, and readiness review. Wallet provisioning, signing, live trading, cloud deployment, and deployed monitoring remain out of scope.

## Completed Lanes

- Added shared workbench snapshot helpers for project state, evidence counts, latest artifact refs, readiness, install diagnostics, guided workflow steps, and repair hints.
- Improved first-run TUI banner with runtime, auth status, project/user homes, session id, evidence counts, command list, and next suggested action.
- Added `/help`, `/guide`, `/ready`, and `/artifacts latest`.
- Added headless `openstrat help`, `openstrat ready`, and `openstrat artifacts latest`.
- Improved `/status` to show auth, homes, evidence counts, wallet/deploy absence, and local readiness.
- Improved Codex event projection so users see file changes, commands, tool calls, and messages during live/fake turns.
- Added doctor install diagnostics for Node version, CLI entrypoint, executable bit, and dist index.
- Added repair hints for missing auth, missing datasets, missing strategy files, invalid strategies, fixture/live ingestion gating, backtest failures, and risk-preflight failures.
- Updated README with global temp-prefix install, isolated homes, TUI trial flow, fixture/live recipes, readiness checks, and cleanup.

## Checkpoint Index

| Lane           | Checkpoint                                                            | Commit      | Status    |
| -------------- | --------------------------------------------------------------------- | ----------- | --------- |
| Start          | `checkpoint/global-install-tui-hardening/manifest.md`                 | uncommitted | Completed |
| Implementation | `checkpoint/global-install-tui-hardening/01-tui-install-hardening.md` | uncommitted | Completed |
| Verification   | `checkpoint/global-install-tui-hardening/02-final-verification.md`    | uncommitted | Completed |

## Verification

Passing gates:

- `pnpm --filter @openstrat/cli typecheck`
- `pnpm vitest run packages/cli/src/commands.test.ts`
- `pnpm vitest run packages/cli/src/commands.test.ts packages/domain/src/codex-contracts.test.ts`
- `pnpm test`
- `pnpm build`
- `pnpm typecheck`
- `pnpm lint`
- `pnpm format:check`
- `git diff --check`
- disposable temp-prefix global install smoke under `checkpoint/global-install-tui-hardening/smoke-global-rerun`
- TUI smoke from a clean project dir covering auth status, guided dataset plan, fixture ingest, dataset inspect/validate, strategy guide, validation, configured backtest, risk preflight, artifact inspection, session compact, readiness summary, and cleanup

## Remaining Issues

- Full-screen TUI panes and keyboard navigation remain intentionally deferred; this goal keeps the TUI line-oriented but guided.
- Real Codex auth was not exercised in the automated smoke. The installed binary exposes the login path and auth status, but the user still needs to complete `openstrat auth codex` for a live Codex turn.
- Live ingestion still depends on external Hyperliquid availability and explicit `--live`.
- Wallet and deployment are explicitly not configured by this goal.

## Required Final Question

Is OpenStrat ready for the user to try a real global install and local end-to-end strategy workbench flow, and if not, what exact blockers remain?

Answer: yes for a local fixture-backed global-install trial, with one explicit caveat: the user still needs to complete real Codex auth before testing live Codex-authored strategy iteration. The installed binary, first-run TUI, guided command path, dataset ingestion/inspection, strategy guide/validation, configured backtest, risk preflight, latest artifacts, readiness summary, repair hints, and temp-prefix cleanup all passed. Wallet and deployment remain intentionally locked gates.
