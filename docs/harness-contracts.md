# OpenStrat Harness Contracts

Status: Draft
Date: 2026-06-14

## Ref Taxonomy

OpenStrat separates broad evidence refs from object-store refs.

- `SourceRefSchema`: a non-empty evidence pointer. It can refer to object refs, event refs, fragment refs, external source IDs, or future provider refs.
- `ObjectRefSchema`: a relative POSIX path inside the OpenStrat object store. It rejects empty segments, `.`, `..`, absolute paths, Windows paths, backslashes, and null bytes before persistence touches disk.
- `ProposalObjectRefSchema`: an object ref under `agent-artifacts/` or `scratch/`. Use it for agent proposals, scratch patch bundles, and other non-canonical agent-generated material.
- `CanonicalObjectRefSchema`: an object ref outside proposal/scratch storage. Use it for durable harness-owned artifacts such as datasets, normalized records, backtest reports, deployment gates, decision ledgers, and handoff artifacts.
- `AppendOnlyObjectRefSchema`: an object ref intended to be written once unless a caller explicitly enters an overwrite-capable migration or fixture path.

## Proposal Boundary

Agent proposal artifacts must remain proposal refs. A `ResearchBrief`, `StrategyPatchProposal`, `BacktestRequest`, `RiskValidationRequest`, `MemoryProposal`, or `DeploymentProposal` cannot point its `artifact_ref.uri` at canonical storage.

This preserves the product boundary: Codex and Pi can propose trading work, but OpenStrat decides when a proposal becomes canonical harness state.

## Persistence Boundary

`FileObjectStore` consumes the domain-level `ObjectRefSchema`. Path safety is therefore a domain contract, not only a filesystem implementation detail.

The object store still rejects accidental overwrites by default. Append-only is the default expectation for generated harness artifacts; explicit overwrite remains limited to fixture and migration-style call sites.

## Goal Artifact Boundary

Long-running Codex goals should leave durable project artifacts instead of relying on chat memory alone.

- `GoalRunManifestSchema`: records the objective, branch, lane list, OpenStrat product boundary, and required final question.
- `GoalArtifactIndexSchema`: records checkpoint refs, commits, current status, final gate refs, and next-goal recommendation once complete.
- `GoalFinalGateReportSchema`: records the final gate results, remaining issues, commit trail, and readiness assessment for the next goal.
- `GoalArtifactRefSchema`: keeps goal artifacts under `goal-runs/` and outside agent proposal storage.

The active Harness Contract Hardening goal writes its manifest and index under `goal-runs/goal-01-harness-contract-hardening/`. Lane checkpoints remain in `checkpoints/` for human review, while the index is the machine-readable bridge for future goal runs.
