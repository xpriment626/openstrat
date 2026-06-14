# Goal-Oriented Design 01: Foundational Runs

Status: Draft
Date: 2026-06-14

## Purpose

OpenStrat should use Codex goals as a product development primitive, not only as a task runner. A goal is a bounded long-horizon run that can traverse many implementation slices, checkpoints, and commits while preserving a clear definition of done.

The point is not to assume each completed goal can blindly trigger the next. The point is to make every goal produce enough durable context that a future Codex session, after one or more context compactions, can decide whether the next goal is still the right goal.

## Current Foundation

OpenStrat now has two useful foundations:

- An end-to-end CLI scaffold covering local install, market fixture ingest, strategy validation, backtest reports, risk/deployment gates, decision ledger, memory proposals, and deployment handoff.
- A Codex app-server runtime scaffold covering runtime contracts, adapter boundary, durable Codex thread bindings, transcript/event projection, gateway-routed tools, Codex-first chat, and session resume.

Those foundations prove the harness shape. The next work should harden the contracts underneath the shape.

## Product Boundary

OpenStrat uses Pi/Codex as runtime substrate, but it should not become a general coding harness.

Codex can write code, inspect files, propose patches, and operate long-running goals. OpenStrat should decide what those actions mean in trading terms:

- market data becomes datasets with provenance
- code changes become strategy proposals
- backtests become evidence artifacts
- risk checks become reviews and gates
- deployment remains blocked until evidence and policy line up
- runtime actions are projected into OpenStrat event logs and transcripts

The harness owns trading state, provenance, risk, artifacts, policy, and auditability. The coding runtime owns agent execution mechanics.

## Goal Run Contract

Every long-horizon goal should follow the same operating contract.

Required outputs:

- checkpoint after each lane
- one commit per completed lane
- files changed
- commands run
- pass/fail status
- remaining issues
- next lane unlocked
- final gate report
- recommended next goal
- explicit readiness assessment for that next goal

Required final question:

```text
Given what changed during this goal, is the next planned goal still correct?
```

A goal can recommend continuing, revising, splitting, or delaying the next goal. It should not silently assume the original roadmap still holds.

## Shared Context Across Goals

The following context should be preserved across every major goal:

- OpenStrat is a specialized trading strategy harness, not a general assistant.
- Codex is first-class for runtime execution and development loops.
- OpenRouter/BYOK remains a future generic provider path, not part of the Codex app-server lifecycle.
- Generated strategy code must not call exchanges directly.
- Trading tools route through `AgentToolGateway`.
- Durable artifacts beat chat memory.
- Raw market data and normalized records must stay separate.
- Backtests consume dataset refs, not ad hoc API responses.
- Strategy changes begin as proposals, not canonical mutation.
- Deployment planning is gated by evidence, policy, and risk review.
- UI panels should eventually organize trading artifacts, not arbitrary code files.

## Foundational Goal Sequence

### Goal 1: Harness Contract Hardening

Objective: make the harness contracts stable enough for Codex, CLI, tests, and future UI panels to consume without scraping human text.

Primary slices:

- artifact ref conventions
- event envelope conventions
- command result envelopes
- CLI `--json` output mode
- gateway tool schemas
- session grants and tool permissions
- standard blocked/error/completed result shapes
- checkpoint and final-report templates

Done means another goal can consume command and tool outputs as structured data.

### Goal 2: Market Data Foundation

Objective: make market data reproducible, queryable, and provenance-aware before adding more live ingestion.

Primary slices:

- `VenueDataAdapter` boundary
- Hyperliquid capability manifest
- acquisition cache vs durable dataset store split
- immutable raw payload refs
- normalized records for market metadata, prices, candles, funding, and orderbook snapshots
- dataset manifest schema
- dataset registry/index
- freshness and staleness rules
- fixture datasets with nontrivial coverage
- guarded live ingest path

Done means a backtest can depend on a dataset ref with enough provenance to reproduce or reject it.

### Goal 3: Strategy Workspace Foundation

Objective: let users work with real local strategies while keeping OpenStrat in control of validation and promotion.

Primary slices:

- strategy project scaffold
- strategy manifest format
- local TypeScript strategy loading
- deterministic runner validation
- purity checks
- parameter schemas
- Codex patch proposal capture
- human promotion from proposal to canonical strategy version

Done means Codex can help write strategy code without bypassing strategy proposal and validation flow.

### Goal 4: Backtest Evidence Loop

Objective: make backtests reliable evidence for risk and deployment gates.

Primary slices:

- backtest request artifacts
- backtest run artifacts
- report artifacts
- trade ledger artifacts
- fee model refs
- slippage model refs
- dataset compatibility checks
- reproducibility checks
- metrics normalized for gate evaluation

Done means a strategy ref plus dataset ref produces a report that risk and deployment logic can trust.

### Goal 5: Risk, Policy, And Deployment Gate Hardening

Objective: make deployment readiness a deterministic harness decision.

Primary slices:

- risk policy artifacts
- risk review artifacts
- gate lifecycle states
- threshold evaluation against backtest metrics
- stale evidence handling
- kill switch handling
- paper deployment plan
- provider-shaped deployment handoff without live execution by default

Done means deployment planning is blocked unless evidence, policy, and risk reviews line up.

### Goal 6: Goal Ops And Dogfooding

Objective: make OpenStrat itself better at running long-horizon Codex goals.

Primary slices:

- goal prompt templates by goal type
- checkpoint schema
- final report artifact
- current project state summary command
- recommended next goal generator
- readiness assessment generator
- goal artifact index

Done means a future Codex session can resume OpenStrat planning from durable project artifacts instead of thread memory.

### Goal 7: First Real User MVP Loop

Objective: make a coherent user-facing loop that can be tested by people outside the project.

Primary slices:

- install and doctor path
- sample project creation
- fixture or guarded market ingest
- strategy scaffold
- strategy validation
- backtest run
- gate inspection
- Codex chat against project state
- session resume
- artifact bundle export for debugging

Done means a real user can complete one strategy research loop without hand-held local setup.

## Readiness Gates Between Goals

Before starting any next goal, inspect:

- tracked git status
- ignored/generated artifact state
- latest checkpoint
- final gate results
- remaining issues from the prior goal
- whether the prior goal changed the assumptions for the next one
- whether a narrower repair goal is needed first

The next goal should be rewritten if the prior goal changed a core boundary, exposed missing schemas, or left verification incomplete.

## First Recommended Goal

The next major goal should be `Harness Contract Hardening`.

Market data is the most domain-sensitive area, but starting with market ingestion directly risks building on fuzzy contracts. The safer first pass is to harden the cross-cutting result, artifact, event, and tool schemas that market data will rely on.

After that, `Market Data Foundation` should get its own long-horizon goal. It should treat Lane 3 as a storage and provenance architecture problem first, not an ingestion feature.

## Compaction Handoff

If a future session only has this document and the latest checkpoints, it should know:

- the project is deliberately moving toward goal-first development
- goals are not blindly chained
- every goal must leave durable context for the next one
- the immediate next major foundation is harness contract hardening
- market data foundation is the highest-risk domain goal after that
- Codex is first-class, but OpenStrat owns trading semantics and safety boundaries
