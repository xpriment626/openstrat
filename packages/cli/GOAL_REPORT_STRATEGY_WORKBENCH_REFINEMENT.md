# Strategy Workbench Refinement Goal Report

Status: completed locally, uncommitted.

## Objective

Refine OpenStrat's local trading workbench loop so Codex can reason against real project trading state and drive strategy authoring with better evidence quality. This goal keeps wallets, signing, deployment, monitoring, and strategy-quality tuning out of scope.

## Completed Lanes

- Added dataset inspection for indexed datasets, including candle counts, coverage, object refs, raw refs, and validation status.
- Added strategy authoring guidance with a valid `@openstrat/strategy-sdk` template, checklist, forbidden APIs, validation command, and next commands.
- Strengthened strategy validation with explicit SDK/import/forbidden API/entrypoint/required_data/allowed_symbol checks.
- Added a deterministic strategy execution probe against ingested dataset candles using the same strategy runner used by backtests.
- Exposed explicit backtest configuration across CLI, slash commands, and MCP: run id, initial equity, fee bps, and slippage bps.
- Persisted richer backtest evidence in the backtest index: dataset refs, artifact refs, config, warnings, metrics, and next actions.
- Added local risk preflight controls for optional policy refs, max notional, max drawdown, min trades, and min win rate.
- Added Codex-facing MCP tools for `dataset.inspect` and `strategy.guide`.
- Replaced generic MCP tool descriptions/schemas with argument-aware schemas for the workbench tools.
- Updated README workflow examples for inspect, guide, configured backtests, and thresholded risk preflight.

## Checkpoint Index

| Lane           | Checkpoint                                                                 | Commit      | Status    |
| -------------- | -------------------------------------------------------------------------- | ----------- | --------- |
| Start          | `checkpoint/strategy-workbench-refinement/manifest.md`                     | uncommitted | Completed |
| Implementation | `checkpoint/strategy-workbench-refinement/01-core-workbench-refinement.md` | uncommitted | Completed |
| Verification   | `checkpoint/strategy-workbench-refinement/02-final-verification.md`        | uncommitted | Completed |

## Verification

Passing gates:

- `pnpm vitest run packages/cli/src/commands.test.ts`
- `pnpm vitest run packages/domain/src/codex-contracts.test.ts packages/cli/src/commands.test.ts`
- `pnpm test`
- `pnpm build`
- `pnpm typecheck`
- `pnpm lint`
- `pnpm format:check`
- `git diff --check`
- disposable smoke under `checkpoint/strategy-workbench-refinement/smoke-local`, covering dataset planning/inspection, fixture ingestion, strategy guide/validation feedback, non-default backtest config, risk preflight, artifacts/transcripts, and failure handling.

## Remaining Issues

- The TUI is still intentionally plain text.
- Live ingestion still depends on external Hyperliquid availability and explicit `--live` approval.
- Strategy dependency management remains intentionally narrow: strategy files should stay on the OpenStrat SDK contract, not arbitrary package imports.
- The local risk preflight is an evidence and policy-threshold gate, not a live-trading approval system.

## Required Final Question

Is the local workbench strong enough to proceed to wallet provisioning and approval behavior, or should the next goal still focus on strategy-workbench/data/backtest/risk refinement?

Current answer: mostly ready to proceed toward wallet provisioning and approval behavior after the final gates pass. The workbench now has enough local substrate for wallet work to attach to concrete strategy/backtest/risk evidence rather than placeholders. Remaining refinements around richer TUI presentation and broader data adapters can continue later, but they no longer block starting wallet provisioning/approval exploration.
