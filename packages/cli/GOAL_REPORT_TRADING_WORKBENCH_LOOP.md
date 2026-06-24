# Trading Workbench Loop Goal Report

Status: completed locally, uncommitted.

## Objective

Refactor OpenStrat from the Codex SDK TUI baseline into a foundational local trading workbench loop. The goal is not merely to generate strategy code. The goal is to enrich the Codex conversation with OpenStrat trading state: market-data planning, dataset refs, strategy validation, backtest evidence, risk preflight, and artifact projection.

## Completed Lanes

- Added project trading-environment paths under `.openstrat`.
- Added dataset ingestion planning from natural language.
- Added explicit fixture/live-gated Hyperliquid ingestion through project object storage.
- Added dataset and market indexes.
- Added dataset validation.
- Added strategy validation against `@openstrat/strategy-sdk` source and manifest expectations.
- Added local candle backtest planning and execution over indexed dataset refs.
- Added local risk/evidence preflight without wallets, signing, live orders, or deployment.
- Added slash command, headless CLI, fake-runtime prompt, and MCP surfaces for the loop.
- Added tests covering TUI slash flow and MCP routing through the trading workbench.

## Checkpoint Index

| Lane           | Checkpoint                                                                             | Commit      | Status    |
| -------------- | -------------------------------------------------------------------------------------- | ----------- | --------- |
| Start          | `checkpoint/interactive-trading-workbench-loop/manifest.md`                            | uncommitted | Completed |
| Implementation | `checkpoint/interactive-trading-workbench-loop/01-foundational-loop-implementation.md` | uncommitted | Completed |
| Verification   | `checkpoint/interactive-trading-workbench-loop/02-final-verification.md`               | uncommitted | Completed |

## Final Gates

Passing gates:

- `pnpm install`
- `pnpm test -- packages/cli/src/commands.test.ts packages/domain/src/codex-contracts.test.ts packages/workers/src/agent-tool-gateway.test.ts`
- `pnpm test`
- `pnpm build`
- `pnpm typecheck`
- `pnpm lint`
- `pnpm format:check`
- `git diff --check`
- disposable project smoke under `checkpoint/interactive-trading-workbench-loop/smoke-1782101961`

## Remaining Issues

- The TUI is still intentionally plain text.
- Live ingestion still depends on explicit `--live` and external Hyperliquid availability.
- Strategy packaging is minimal: local strategy files are compiled through a controlled strategy-sdk shim for validation/backtesting.

## Next Goal Recommendation

Recommendation: continue to refinements on top of this local trading loop.

Readiness: ready for local strategy-workbench refinement; not ready for wallets/cloud as the immediate next layer.

Rationale: the foundational loop exists and passes deterministic verification. The next useful work should refine the OpenStrat trading environment and strategy authoring ergonomics before adding wallet provisioning, signing, deployment, or monitoring.

## Required Final Question

After this goal, can a user use OpenStrat locally to go from natural-language trading research intent to dataset refs, validated strategy code, backtest evidence, and risk preflight without wallet or cloud deployment?

Answer: yes, for a local deterministic workbench loop. A user can now use OpenStrat to plan market-data ingestion from natural-language intent, run approved fixture/live-gated ingestion, obtain dataset refs, validate strategy code against OpenStrat contracts, run a local candle backtest, and produce risk preflight artifacts without wallet or cloud deployment.

Remaining prerequisites before wallet/cloud work: richer strategy authoring guidance, broader data-adapter coverage, more robust live-data error handling, richer strategy package/dependency management, and more complete backtest/risk configuration controls.
