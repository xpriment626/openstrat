# Lane 2 Checkpoint: Pi Tool Gateway Bridge

Date: 2026-06-10
Branch: `goal/06-16-2026-e2e-scaffolding`

## Files Changed

- `packages/agent-runtime/src/pi-adapter.ts`
- `packages/agent-runtime/src/pi-adapter.test.ts`
- `packages/workers/src/agent-tool-gateway.ts`
- `packages/workers/src/agent-tool-gateway.test.ts`

## What Changed

- `AgentToolGateway.invoke` now dispatches supported `market_data.read_snapshot` calls through the typed `readMarketDataSnapshot` method.
- `PiRuntimeAdapterDependencies` now accepts an optional `toolGateway`.
- Fake Pi `tool_execution_start` events can carry structured `arguments`.
- The Pi adapter logs `agent.runtime.tool_call_requested`, calls the gateway, and then logs `agent.runtime.tool_call_completed` on success or `agent.runtime.tool_call_blocked` on gateway rejection.
- Fake Pi sessions now await async event listeners so gateway calls complete before `prompt` resolves.

## Commands Run

- `pnpm test packages/workers/src/agent-tool-gateway.test.ts packages/agent-runtime/src/pi-adapter.test.ts`
- `pnpm typecheck`

## Pass/Fail Status

- Targeted gateway and Pi adapter tests: passed, 14 tests.
- Workspace typecheck: passed across all workspace packages.

## Remaining Issues

- Only `market_data.read_snapshot` is dispatched through generic `invoke` so far.
- Other supported gateway tools still require typed gateway methods until their lanes need generic dispatch.

## Next Lane Unlocked

Lane 3: Market dataset and provenance loop. Pi can now use the harness-owned gateway for a read-only market data request, so the next slice can make market data ingestion and retrieval a durable CLI/artifact workflow.
