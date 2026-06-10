# Lane 7 Checkpoint: Agent Memory and Decision Ledger

Date: 2026-06-10
Branch: `goal/06-16-2026-e2e-scaffolding`

## Files Changed

- `packages/cli/src/commands.ts`
- `packages/cli/src/commands.test.ts`

## What Changed

- Added `openstrat ledger record-sample`.
- Added `openstrat ledger list`.
- Added `openstrat memory propose-sample`.
- Added `openstrat memory list`.
- Decision ledger entries are validated with `DecisionLedgerEntrySchema`.
- Decision ledger artifacts link strategy, dataset, backtest report, and deployment gate refs.
- Memory proposals are captured through the existing agent tool gateway `memory_proposal.capture` path.
- Memory proposal artifacts remain `status: proposed`, require human review, and do not receive promotion events.
- The append-only event log records both `agent.decision.recorded` and `agent.proposal.captured`.

## Commands Run

- `pnpm test packages/cli/src/commands.test.ts`
- `pnpm typecheck`
- `pnpm format:check`
- `pnpm lint`
- `pnpm build`
- `./packages/cli/dist/openstrat market ingest-fixture --symbol BTC --interval 15m` with temp `HOME`
- `./packages/cli/dist/openstrat backtest run-sample --strategy-ref sample_moving_average_breakout --dataset-ref <dataset-ref> --fee-bps 5 --slippage-bps 10` with temp `HOME`
- `./packages/cli/dist/openstrat gate create-sample --strategy-ref sample_moving_average_breakout --backtest-report-ref <report-ref> --risk-policy-ref risk/sample --ready` with temp `HOME`
- `./packages/cli/dist/openstrat ledger record-sample --strategy-ref sample_moving_average_breakout --dataset-ref <dataset-ref> --backtest-report-ref <report-ref> --gate-ref <gate-ref>` with temp `HOME`
- `./packages/cli/dist/openstrat ledger list` with temp `HOME`
- `./packages/cli/dist/openstrat memory propose-sample --decision-ref <decision-ref> --backtest-report-ref <report-ref> --gate-ref <gate-ref>` with temp `HOME`
- `./packages/cli/dist/openstrat memory list` with temp `HOME`

## Pass/Fail Status

- New decision/memory CLI test: passed.
- Full CLI command test file: passed, 9 tests.
- Workspace typecheck: passed across all workspace packages.
- Format check: passed.
- Lint: passed.
- Build: passed.
- Linked CLI decision and memory smoke: passed.

## Remaining Issues

- Memory proposal review and promotion workflows remain intentionally out of scope.
- Decision ledger entries are sample-scaffolded and not yet generated from live Pi reasoning traces.
- Ledger listing is basic terminal output, not a query API.

## Next Lane Unlocked

Lane 8: Deployment handoff. The CLI can now carry evidence from data, strategy, backtest, gate, decision, and memory proposal artifacts into a deployment manifest or provider handoff without treating chat transcripts as canonical state.
