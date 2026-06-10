# Lane 8 Checkpoint: Deployment Handoff

Date: 2026-06-10
Branch: `goal/06-16-2026-e2e-scaffolding`

## Files Changed

- `packages/cli/src/commands.ts`
- `packages/cli/src/commands.test.ts`

## What Changed

- Added `openstrat deploy handoff`.
- The command builds a `BotRunManifest` from deployment gate, backtest report, risk policy, and strategy manifest refs.
- The command writes manifest, provider plan, and handoff artifacts under `deployment-handoffs/<bot-run-id>/`.
- Local terminal handoffs require `--ack-local-reliability` and preserve the local workspace path.
- Fly and Sprite targets are plan-only and validate missing CLI/auth without launching remote infrastructure.
- The handoff artifact can carry decision ledger and memory proposal refs from Lane 7.
- Sample handoff creation materializes the sample strategy manifest artifact when needed.
- Deployment handoff creation appends `deployment.handoff.created` to the event log.

## Commands Run

- `pnpm test packages/cli/src/commands.test.ts`
- `pnpm test`
- `pnpm typecheck`
- `pnpm lint`
- `pnpm format:check`
- `pnpm build`
- `./packages/cli/dist/openstrat market ingest-fixture --symbol BTC --interval 15m` with temp `HOME`
- `./packages/cli/dist/openstrat backtest run-sample --strategy-ref sample_moving_average_breakout --dataset-ref <dataset-ref> --fee-bps 5 --slippage-bps 10` with temp `HOME`
- `./packages/cli/dist/openstrat gate create-sample --strategy-ref sample_moving_average_breakout --backtest-report-ref <report-ref> --risk-policy-ref risk/sample --ready` with temp `HOME`
- `./packages/cli/dist/openstrat ledger record-sample --strategy-ref sample_moving_average_breakout --dataset-ref <dataset-ref> --backtest-report-ref <report-ref> --gate-ref <gate-ref>` with temp `HOME`
- `./packages/cli/dist/openstrat memory propose-sample --decision-ref <decision-ref> --backtest-report-ref <report-ref> --gate-ref <gate-ref>` with temp `HOME`
- `./packages/cli/dist/openstrat deploy handoff --target local_terminal --gate-ref <gate-ref> --backtest-report-ref <report-ref> --risk-policy-ref risk/sample --strategy-manifest-ref <strategy-manifest-ref> --decision-ref <decision-ref> --memory-proposal-ref <memory-ref> --ack-local-reliability` with temp `HOME`
- `./packages/cli/dist/openstrat deploy handoff --target fly_machine --gate-ref <gate-ref> --backtest-report-ref <report-ref> --risk-policy-ref risk/sample --strategy-manifest-ref <strategy-manifest-ref> --app-name openstrat-bot --region iad` with temp `HOME`

## Pass/Fail Status

- New deployment handoff CLI test: passed.
- Full CLI command test file: passed, 10 tests.
- Full workspace test suite: passed, 18 files and 81 tests.
- Workspace typecheck: passed across all workspace packages.
- Lint: passed.
- Format check: passed.
- Build: passed.
- Linked CLI local handoff smoke: passed with `validation: ok`.
- Linked CLI Fly handoff smoke: passed with plan-only remote validation errors.

## Remaining Issues

- Remote providers still produce handoff plans only; remote launch remains out of scope.
- Local bot launch through the CLI remains out of scope for this lane.
- Provider auth checks currently use the workers' unavailable default environment from the CLI handoff path.

## Goal Completion

All eight lanes are implemented and checkpointed on `goal/06-16-2026-e2e-scaffolding`. The final goal gates passed after the last formatting change:

- `pnpm test`
- `pnpm typecheck`
- `pnpm lint`
- `pnpm format:check`
