# Lane 1 Checkpoint: Harness Contract Audit

Date: 2026-06-14
Branch: `codex/goal-01-harness-contract-hardening`

## Files Changed

- `checkpoints/goal-01-harness-contract-hardening-lane-1-contract-audit.md`

## What Was Inspected

- Domain schemas in `packages/domain/src/common.ts`, `packages/domain/src/agent.ts`, `packages/domain/src/market.ts`, `packages/domain/src/backtest.ts`, `packages/domain/src/strategy.ts`, `packages/domain/src/risk.ts`, and `packages/domain/src/deployment.ts`.
- Persistence contracts in `packages/persistence/src/object-store.ts`, `packages/persistence/src/event-log.ts`, and `packages/persistence/src/persistence.test.ts`.
- Gateway contracts in `packages/workers/src/agent-tool-gateway.ts` and `packages/workers/src/agent-tool-gateway.test.ts`.
- Runtime projection contracts in `packages/agent-runtime/src/pi-adapter.ts`, `packages/agent-runtime/src/codex-app-server-adapter.ts`, and their tests.
- CLI command/output contracts in `packages/cli/src/commands.ts`, `packages/cli/src/index.ts`, and `packages/cli/src/commands.test.ts`.
- Goal context in `docs/goal-oriented-design-01-foundational-runs.md` and prior lane checkpoints.

## Current Contract Inventory

- `AgentArtifactRefSchema` already captures append-only agent artifacts with `id`, `kind`, `uri`, `content_hash`, `created_at`, `append_only`, and `metadata`.
- `AgentToolGrantSchema` already models grants by session, tool name, permission, scope, and optional expiry.
- `AgentToolCallRecordSchema` already models requested/completed/blocked/failed tool calls with side effect and optional `output_ref` or `error`.
- `AgentRuntimeEventSchema` exists, but it uses local event type names such as `tool_call_completed`, while emitted runtime events use dotted event log names such as `agent.runtime.tool_call_completed`.
- `SqliteEventLog` gives append-only sequencing and metadata storage, while `FileObjectStore` guards path traversal and rejects overwrites unless explicitly requested.
- `AgentToolGateway` owns the current harness tool list and typed methods for market data, backtest requests, risk validation, strategy proposals, memory proposals, and deployment gate inspection.
- CLI commands already produce durable object refs for market datasets, strategy proposals, backtest reports, deployment gates, decision ledgers, memory proposals, and deployment handoffs.

## Inconsistencies Found

- Ref taxonomy is too loose. `SourceRefSchema` is only a non-empty string, while `ObjectRefSchema` is persistence-local and path-safe only inside `FileObjectStore`. Domain schemas therefore accept refs that the object store might reject later.
- Artifact refs are uneven. Agent proposals use `AgentArtifactRefSchema`, but market datasets, deployment gate artifacts, backtest reports, decision ledgers, and handoff artifacts mostly use local interfaces or plain string refs.
- Canonical vs proposal refs are implied by path names (`agent-artifacts/`, `scratch/`, `deployment-gates/`) rather than enforced by shared helpers.
- Runtime events and gateway events have overlapping but different envelopes. Pi and Codex emit `agent.runtime.tool_call_*`; the gateway emits `agent.tool_call.*` with an embedded `tool_call` record. Both are useful, but no shared result envelope ties them together.
- The domain `AgentRuntimeEventTypeSchema` is not the schema for persisted runtime event log rows because persisted rows use dotted event names.
- Generic gateway invocation only dispatches `market_data.read_snapshot`; the advertised gateway tool list contains six tools, but five still require typed methods.
- Tool registry data is split across `AGENT_TOOL_GATEWAY_TOOLS`, runtime policy defaults, disabled native tool lists, typed gateway methods, and tests. There is no single source for input schema, output schema, grant scope, permission, and side-effect class.
- Session grants exist in the domain but are not used by CLI chat, Pi adapter, Codex app-server adapter, or `AgentToolGateway.invoke` checks.
- CLI result shape is not stable. Some commands emit human key-value lines, some emit JSON directly, and errors are plain stderr strings. There is no shared `--json` envelope for success, blocked, or error output.
- Several CLI manifest builders duplicate agent session manifest shape instead of parsing through one reusable constructor.

## Lane 2 Targets

- Define shared ref schemas/helpers before broad CLI JSON work: object refs, source refs, artifact refs, append-only refs, and proposal/canonical ref categories.
- Move path-safety rules out of persistence-only implementation where domain-level artifact refs need to reject invalid refs earlier.
- Add tests first for allowed refs, escaping refs, proposal refs, canonical refs, and append-only artifact refs.
- Keep changes narrow: do not redesign market dataset storage, OpenRouter, UI, or live trading.

## Commands Run

- `pnpm test`
- Source audit commands using `rg`, `sed`, and `nl` over `packages/`, `docs/`, and `checkpoints/`.

## Pass/Fail Status

- Baseline tests passed: 19 test files, 92 tests.
- No production behavior was changed in this lane.

## Remaining Issues

- Lane 2 must harden refs before other lanes build on `--json` outputs or gateway schema registries.
- Lane 3 should standardize event/result envelopes after ref helpers exist, because envelopes will need to reference object and artifact refs precisely.
- Lane 4 should consolidate tool schemas, side-effect classes, and grant requirements into one registry.
- Lane 5 should add machine-readable CLI output through shared envelopes rather than per-command ad hoc JSON.

## Next Lane Unlocked

Lane 2: Artifact and ref conventions. The current contract inventory is clear enough to add shared ref helpers and tests without guessing about the rest of the harness.
