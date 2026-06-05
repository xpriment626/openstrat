import { describe, expect, it } from "vitest";
import {
  AgentArtifactRefSchema,
  AgentRuntimeEventSchema,
  AgentSessionManifestSchema,
  AgentToolCallRecordSchema,
  AgentToolGrantSchema,
  AgentTurnSchema,
  BacktestRequestSchema,
  BacktestReportRefSchema,
  DecisionLedgerEntrySchema,
  DeploymentProposalSchema,
  MemoryProposalSchema,
  ResearchBriefSchema,
  RiskValidationRequestSchema,
  StrategyManifestSchema,
  StrategyPatchProposalSchema,
  TradeIntentSchema
} from "./index.js";

const now = "2026-06-05T00:00:00.000Z";
const later = "2026-06-05T00:00:30.000Z";

describe("agent domain contracts", () => {
  it("keeps agent session transcripts separate from canonical ledgers", () => {
    const manifest = AgentSessionManifestSchema.parse({
      id: "agent_session_001",
      created_at: now,
      purpose: "strategy_research",
      autonomy_mode: "strategy_workbench",
      runtime: {
        kind: "pi",
        adapter: "@openstrat/agent-runtime/pi",
        model_profile_id: "model/openai-codex-default"
      },
      transcript_ref: {
        id: "artifact_transcript_001",
        kind: "agent_transcript",
        uri: "agent-sessions/agent_session_001/session.jsonl",
        content_hash: "sha256:transcript",
        created_at: now,
        append_only: true
      },
      event_stream_id: "agent_sessions/agent_session_001",
      tool_grant_ids: ["grant_read_market_data"],
      canonical_ledger_refs: []
    });

    expect(manifest.transcript_ref.kind).toBe("agent_transcript");
    expect(
      AgentSessionManifestSchema.safeParse({
        ...manifest,
        transcript_ref: {
          ...manifest.transcript_ref,
          kind: "trade_ledger"
        }
      }).success
    ).toBe(false);
    expect(
      AgentSessionManifestSchema.safeParse({
        ...manifest,
        canonical_ledger_refs: ["trade-ledgers/live.jsonl"]
      }).success
    ).toBe(false);
  });

  it("validates runtime events, turns, grants, and tool call records", () => {
    expect(
      AgentToolGrantSchema.safeParse({
        id: "grant_read_market_data",
        created_at: now,
        session_id: "agent_session_001",
        tool_name: "market_data.read_snapshot",
        permission: "read",
        scope: "market_data",
        expires_at: later
      }).success
    ).toBe(true);

    expect(
      AgentTurnSchema.safeParse({
        id: "turn_001",
        session_id: "agent_session_001",
        started_at: now,
        completed_at: later,
        status: "completed",
        input_ref: "agent-inputs/turn_001.json",
        output_refs: ["agent-artifacts/research_brief_001.json"],
        tool_call_ids: ["tool_call_001"]
      }).success
    ).toBe(true);

    expect(
      AgentRuntimeEventSchema.safeParse({
        id: "event_001",
        session_id: "agent_session_001",
        turn_id: "turn_001",
        occurred_at: now,
        type: "tool_call_completed",
        payload: { tool_name: "market_data.read_snapshot" },
        event_stream_id: "agent_sessions/agent_session_001"
      }).success
    ).toBe(true);

    expect(
      AgentToolCallRecordSchema.safeParse({
        id: "tool_call_001",
        session_id: "agent_session_001",
        turn_id: "turn_001",
        tool_name: "market_data.read_snapshot",
        arguments: { canonical_symbol: "ETH-PERP" },
        status: "completed",
        requested_at: now,
        completed_at: later,
        output_ref: "agent-artifacts/tool_call_001.result.json",
        side_effect: "none"
      }).success
    ).toBe(true);

    expect(
      AgentToolCallRecordSchema.safeParse({
        id: "tool_call_002",
        session_id: "agent_session_001",
        turn_id: "turn_001",
        tool_name: "orders.write_live",
        arguments: { canonical_symbol: "ETH-PERP" },
        status: "completed",
        requested_at: now,
        side_effect: "live_execution"
      }).success
    ).toBe(false);
  });

  it("validates typed proposal artifacts as append-only proposal records", () => {
    const ref = AgentArtifactRefSchema.parse({
      id: "artifact_research_001",
      kind: "proposal",
      uri: "agent-artifacts/research_brief_001.json",
      content_hash: "sha256:research",
      created_at: now,
      append_only: true
    });

    expect(ref.append_only).toBe(true);
    expect(
      AgentArtifactRefSchema.safeParse({
        ...ref,
        append_only: false
      }).success
    ).toBe(false);

    expect(
      ResearchBriefSchema.safeParse({
        id: "research_brief_001",
        created_at: now,
        session_id: "agent_session_001",
        status: "proposed",
        title: "ETH funding compression",
        question: "Does funding compression precede breakout continuation?",
        summary: "Funding is neutral while realized volatility expands.",
        evidence_refs: ["market-data/hyperliquid/eth/candles.jsonl"],
        artifact_ref: ref
      }).success
    ).toBe(true);

    expect(
      BacktestRequestSchema.safeParse({
        id: "backtest_request_001",
        created_at: now,
        session_id: "agent_session_001",
        status: "proposed",
        strategy_ref: "strategy-proposals/eth_breakout.patch",
        dataset_ref: "datasets/hyperliquid/eth/6m",
        canonical_symbols: ["ETH-PERP"],
        parameters: { lookback: 20 },
        artifact_ref: {
          ...ref,
          id: "artifact_backtest_request_001",
          uri: "agent-artifacts/backtest_request_001.json",
          content_hash: "sha256:backtest-request"
        }
      }).success
    ).toBe(true);

    expect(
      BacktestReportRefSchema.safeParse({
        id: "backtest_report_ref_001",
        created_at: now,
        session_id: "agent_session_001",
        status: "proposed",
        backtest_run_id: "backtest_001",
        report_ref: "backtests/backtest_001/report.json",
        metrics_ref: "backtests/backtest_001/metrics.json",
        artifact_ref: {
          ...ref,
          id: "artifact_backtest_report_ref_001",
          uri: "agent-artifacts/backtest_report_ref_001.json",
          content_hash: "sha256:backtest-report-ref"
        }
      }).success
    ).toBe(true);
  });

  it("keeps strategy, risk, memory, and deployment proposals non-promoted by default", () => {
    const strategyPatch = StrategyPatchProposalSchema.parse({
      id: "strategy_patch_001",
      created_at: now,
      session_id: "agent_session_001",
      status: "proposed",
      strategy_id: "eth_breakout",
      base_strategy_version: "0.1.0",
      patch_format: "unified_diff",
      patch_ref: "agent-artifacts/strategy_patch_001.diff",
      rationale: "Parameterize volatility expansion threshold.",
      tests_ref: "agent-artifacts/strategy_patch_001.tests.json",
      artifact_ref: {
        id: "artifact_strategy_patch_001",
        kind: "proposal",
        uri: "agent-artifacts/strategy_patch_001.json",
        content_hash: "sha256:strategy-patch",
        created_at: now,
        append_only: true
      }
    });

    expect(strategyPatch.status).toBe("proposed");
    expect(TradeIntentSchema.safeParse(strategyPatch).success).toBe(false);
    expect(StrategyManifestSchema.safeParse(strategyPatch).success).toBe(false);
    expect(DecisionLedgerEntrySchema.safeParse(strategyPatch).success).toBe(false);

    expect(
      RiskValidationRequestSchema.safeParse({
        id: "risk_validation_request_001",
        created_at: now,
        session_id: "agent_session_001",
        status: "proposed",
        intent_ref: "agent-artifacts/proposed_intent.json",
        risk_policy_ref: "risk/conservative_v1.json",
        context_refs: ["market-data/hyperliquid/eth/latest.json"],
        artifact_ref: {
          ...strategyPatch.artifact_ref,
          id: "artifact_risk_validation_request_001",
          uri: "agent-artifacts/risk_validation_request_001.json",
          content_hash: "sha256:risk-validation-request"
        }
      }).success
    ).toBe(true);

    expect(
      MemoryProposalSchema.safeParse({
        id: "memory_proposal_001",
        created_at: now,
        session_id: "agent_session_001",
        status: "proposed",
        subject_type: "strategy",
        subject_id: "eth_breakout",
        claim: "Breakout entries degrade after fee-adjusted low-liquidity regimes.",
        evidence_refs: ["backtests/backtest_001/report.json"],
        confidence: "medium",
        allowed_uses: ["strategy_review", "risk_warning"],
        forbidden_uses: ["auto_promote_to_strategy"],
        requires_human_review: true,
        artifact_ref: {
          ...strategyPatch.artifact_ref,
          id: "artifact_memory_proposal_001",
          uri: "agent-artifacts/memory_proposal_001.json",
          content_hash: "sha256:memory-proposal"
        }
      }).success
    ).toBe(true);

    expect(
      DeploymentProposalSchema.safeParse({
        id: "deployment_proposal_001",
        created_at: now,
        session_id: "agent_session_001",
        status: "proposed",
        strategy_manifest_ref: "strategies/eth_breakout/manifest.json",
        deployment_gate_ref: "gates/gate_001.json",
        target_kind: "local_terminal",
        runtime_mode: "paper",
        duration_ms: 43_200_000,
        artifact_ref: {
          ...strategyPatch.artifact_ref,
          id: "artifact_deployment_proposal_001",
          uri: "agent-artifacts/deployment_proposal_001.json",
          content_hash: "sha256:deployment-proposal"
        }
      }).success
    ).toBe(true);
  });
});
