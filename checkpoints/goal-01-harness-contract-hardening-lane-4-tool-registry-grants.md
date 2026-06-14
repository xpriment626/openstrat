# Lane 4 Checkpoint: Tool Registry And Grants

Date: 2026-06-14
Branch: `codex/goal-01-harness-contract-hardening`

## Files Changed

- `packages/workers/src/agent-tool-registry.ts`
- `packages/workers/src/agent-tool-registry.test.ts`
- `packages/workers/src/agent-tool-gateway.ts`
- `packages/workers/src/index.ts`
- `packages/agent-runtime/src/runtime-policy.ts`
- `packages/agent-runtime/src/runtime-policy.test.ts`
- `checkpoints/goal-01-harness-contract-hardening-lane-4-tool-registry-grants.md`

## What Changed

- Added a harness-owned agent tool registry for the gateway tools:
  - `market_data.read_snapshot`
  - `backtest.request`
  - `risk.validate_intent`
  - `strategy_patch.capture`
  - `memory_proposal.capture`
  - `deployment_gate.inspect`
- Each registry entry now carries:
  - input parser
  - output parser
  - side-effect classification
  - required grant permission and scope
- Added `agentToolGatewayToolNames`, `agentToolGatewayToolDefinition`, `isAgentToolGatewayToolName`, and `agentToolGrantAllows`.
- Updated `AgentToolGateway` to source tool names, supported-tool checks, invocation argument parsing, and side-effect values from the registry instead of local duplicated constants.
- Updated runtime policy defaults for workbench, paper trading, and draft-order modes to use `agentToolGatewayToolNames`.
- Kept hard-blocked execution, signing, process, and native filesystem tools enforced by runtime policy.

## TDD Evidence

- Red tests were added first for:
  - registry names, schemas, side effects, and grants
  - grant allow/deny behavior including expiry
  - runtime policy defaults matching the registry
- Initial focused run failed because `agent-tool-registry.ts` did not exist and runtime policy could not import `agentToolGatewayToolNames`.
- Implementation added the registry and rewired gateway/runtime policy consumers.
- A first implementation composed local Zod schemas with domain package schemas and failed package typecheck due cross-package Zod declaration incompatibility.
- The implementation was corrected to expose small `parse`/`safeParse` schema-like wrappers around domain parsers, avoiding cross-package Zod composition while preserving runtime validation.

## Commands Run

- `pnpm test packages/workers/src/agent-tool-registry.test.ts packages/workers/src/agent-tool-gateway.test.ts packages/agent-runtime/src/runtime-policy.test.ts`
- `pnpm --filter @openstrat/workers build`
- `pnpm --filter @openstrat/workers typecheck`
- `pnpm --filter @openstrat/agent-runtime typecheck`
- `pnpm --filter @openstrat/agent-runtime build`
- `pnpm exec prettier --write packages/workers/src/agent-tool-registry.ts packages/workers/src/agent-tool-registry.test.ts packages/workers/src/agent-tool-gateway.ts packages/workers/src/index.ts packages/agent-runtime/src/runtime-policy.ts packages/agent-runtime/src/runtime-policy.test.ts checkpoints/goal-01-harness-contract-hardening-lane-4-tool-registry-grants.md`
- `pnpm test`
- `pnpm typecheck`
- `pnpm lint`
- `pnpm format:check`
- `pnpm build`
- `git diff --check`

## Pass/Fail Status

- Focused red tests failed for the expected missing-registry reasons.
- Focused green tests passed: 3 test files, 11 tests.
- Workers build passed.
- Workers typecheck passed.
- Agent runtime typecheck passed.
- Agent runtime build passed.
- Full test suite passed: 20 test files, 95 tests.
- Workspace typecheck passed.
- Lint passed.
- Format check passed.
- Build passed.
- Whitespace diff check passed.

## Remaining Issues

- The gateway still only supports generic `invoke` dispatch for `market_data.read_snapshot`; the typed gateway methods cover the other tools.
- Grants can now be checked against registry requirements, but gateway invocation does not yet receive or enforce session grant material.
- CLI `--json` output is still not standardized. Lane 5 should make command output machine-readable and reuse the result-envelope shape where appropriate.

## Next Lane Unlocked

Lane 5: CLI JSON output. Tool contracts now have a central source for names, validation, side effects, and grant requirements, so CLI and runtime surfaces can report success, blocked, and failed states without duplicating gateway metadata.
