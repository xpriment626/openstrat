import { describe, expect, it } from "vitest";
import type {
  DeploymentGate,
  MarketDatum,
  MarketRegistryEntry,
  RiskPolicy,
  RiskReview,
  TradeIntent
} from "@openstrat/domain";
import type { MarketDataReader } from "@openstrat/market-data";
import { SqliteEventLog, type ObjectStore } from "@openstrat/persistence";
import type { RiskContext, RiskPolicyEngine } from "@openstrat/risk";
import {
  createAgentToolGateway,
  type AgentToolGatewayToolName
} from "./agent-tool-gateway.js";

const now = "2026-06-05T00:00:00.000Z";

class MemoryObjectStore implements ObjectStore {
  readonly values = new Map<string, unknown>();

  putBytes(ref: string, bytes: Uint8Array): void {
    this.values.set(ref, Buffer.from(bytes).toString("utf8"));
  }

  getBytes(ref: string): Buffer {
    const value = this.values.get(ref);
    if (typeof value !== "string") {
      throw new Error(`missing bytes: ${ref}`);
    }
    return Buffer.from(value);
  }

  putJson(ref: string, value: unknown): void {
    if (this.values.has(ref)) {
      throw new Error(`Object already exists: ${ref}`);
    }
    this.values.set(ref, value);
  }

  getJson<T = unknown>(ref: string): T {
    if (!this.values.has(ref)) {
      throw new Error(`missing json: ${ref}`);
    }
    return this.values.get(ref) as T;
  }

  exists(ref: string): boolean {
    return this.values.has(ref);
  }
}

function createGatewayFixture(riskReview: RiskReview = sampleRiskReview("rejected")) {
  const events = new SqliteEventLog(":memory:");
  const objects = new MemoryObjectStore();
  const marketData = new StubMarketDataReader();
  const risk: RiskPolicyEngine = {
    async review(
      _intent: TradeIntent,
      _policy: RiskPolicy,
      _context: RiskContext
    ): Promise<RiskReview> {
      return riskReview;
    }
  };

  const gateway = createAgentToolGateway({
    events,
    marketData,
    objects,
    risk,
    now: () => now
  });

  return { events, gateway, marketData, objects };
}

describe("agent tool gateway", () => {
  it("reads market data through a read-only tool and writes an audit event", async () => {
    const { events, gateway } = createGatewayFixture();

    const result = await gateway.readMarketDataSnapshot({
      call_id: "tool_call_001",
      session_id: "agent_session_001",
      turn_id: "turn_001",
      canonical_symbol: "ETH-PERP"
    });

    expect(result.market.canonical_symbol).toBe("ETH-PERP");
    expect(result.latest_price.value).toBe(3500);
    expect(events.list("agent_sessions/agent_session_001")).toMatchObject([
      {
        type: "agent.tool_call.completed",
        payload: {
          tool_name: "market_data.read_snapshot",
          side_effect: "none"
        }
      }
    ]);
  });

  it("captures backtest, strategy, and memory proposals as append-only artifacts", async () => {
    const { events, gateway, objects } = createGatewayFixture();

    const backtest = await gateway.captureBacktestRequest({
      call_id: "tool_call_backtest",
      session_id: "agent_session_001",
      turn_id: "turn_001",
      request: {
        id: "backtest_request_001",
        created_at: now,
        session_id: "agent_session_001",
        status: "proposed",
        strategy_ref: "agent-artifacts/strategy_patch_001.json",
        dataset_ref: "datasets/hyperliquid/eth/6m",
        canonical_symbols: ["ETH-PERP"],
        parameters: { lookback: 20 },
        artifact_ref: proposalRef("backtest_request_001")
      }
    });

    const strategy = await gateway.captureStrategyPatchProposal({
      call_id: "tool_call_strategy",
      session_id: "agent_session_001",
      turn_id: "turn_001",
      proposal: {
        id: "strategy_patch_001",
        created_at: now,
        session_id: "agent_session_001",
        status: "proposed",
        strategy_id: "eth_breakout",
        base_strategy_version: "0.1.0",
        patch_format: "unified_diff",
        patch_ref: "agent-artifacts/strategy_patch_001.diff",
        rationale: "Tighten breakout threshold.",
        artifact_ref: proposalRef("strategy_patch_001")
      }
    });

    const memory = await gateway.captureMemoryProposal({
      call_id: "tool_call_memory",
      session_id: "agent_session_001",
      turn_id: "turn_001",
      proposal: {
        id: "memory_proposal_001",
        created_at: now,
        session_id: "agent_session_001",
        status: "proposed",
        subject_type: "strategy",
        subject_id: "eth_breakout",
        claim: "Low liquidity regimes degrade this setup after fees.",
        evidence_refs: ["backtests/backtest_001/report.json"],
        confidence: "medium",
        allowed_uses: ["strategy_review"],
        forbidden_uses: ["auto_promote_to_strategy"],
        requires_human_review: true,
        artifact_ref: proposalRef("memory_proposal_001")
      }
    });

    expect(backtest.status).toBe("proposed");
    expect(strategy.status).toBe("proposed");
    expect(memory.status).toBe("proposed");
    expect(objects.exists(backtest.artifact_ref.uri)).toBe(true);
    expect(objects.exists(strategy.artifact_ref.uri)).toBe(true);
    expect(objects.exists(memory.artifact_ref.uri)).toBe(true);
    expect(
      events
        .list("agent_sessions/agent_session_001")
        .filter((event) => event.type === "agent.proposal.captured")
    ).toHaveLength(3);
  });

  it("validates risk through the risk engine and preserves rejected reviews", async () => {
    const rejected = sampleRiskReview("rejected");
    const { events, gateway } = createGatewayFixture(rejected);

    const review = await gateway.validateRisk({
      call_id: "tool_call_risk",
      session_id: "agent_session_001",
      turn_id: "turn_001",
      intent: sampleIntent(),
      policy: sampleRiskPolicy(),
      context: {
        market_refs: ["market-data/hyperliquid/eth/latest.json"],
        decision_ref: "agent-artifacts/research_brief_001.json"
      }
    });

    expect(review.status).toBe("rejected");
    expect(
      events.list("agent_sessions/agent_session_001").at(-1)?.payload
    ).toMatchObject({
      tool_name: "risk.validate_intent",
      result_ref: "risk_review_001"
    });
  });

  it("inspects deployment gates without approving deployment", async () => {
    const { events, gateway } = createGatewayFixture();

    const inspection = await gateway.inspectDeploymentGate({
      call_id: "tool_call_deployment_gate",
      session_id: "agent_session_001",
      turn_id: "turn_001",
      gate: {
        ...sampleDeploymentGate(),
        required_reviews: []
      }
    });

    expect(inspection.ready).toBe(false);
    expect(inspection.missing_requirements).toContain("risk review required");
    expect(
      events.list("agent_sessions/agent_session_001").at(-1)?.payload
    ).toMatchObject({
      tool_name: "deployment_gate.inspect",
      side_effect: "none"
    });
  });

  it("fails closed for unsupported live execution tools", async () => {
    const { events, gateway } = createGatewayFixture();

    await expect(
      gateway.invoke({
        tool_name: "orders.write_live" as AgentToolGatewayToolName,
        call_id: "tool_call_live",
        session_id: "agent_session_001",
        turn_id: "turn_001",
        arguments: { canonical_symbol: "ETH-PERP" }
      })
    ).rejects.toThrow("not available");

    expect(events.list("agent_sessions/agent_session_001").at(-1)).toMatchObject({
      type: "agent.tool_call.blocked",
      payload: {
        tool_name: "orders.write_live",
        side_effect: "none"
      }
    });
  });
});

class StubMarketDataReader implements MarketDataReader {
  async getMarket(canonicalSymbol: string): Promise<MarketRegistryEntry | undefined> {
    return {
      canonical_symbol: canonicalSymbol,
      display_symbol: "ETH",
      venue_symbol: "ETH",
      venue: "hyperliquid",
      source: "hyperliquid",
      asset_class: "crypto",
      quote_token: "USDC",
      collateral_token: "USDC",
      max_leverage: 50,
      min_order_size: 0.001,
      tick_size: 0.1,
      lot_size: 0.0001,
      status: "active",
      liquidity_score: 0.9,
      last_verified_at: now,
      source_refs: ["market-registry/hyperliquid/eth.json"]
    };
  }

  async getLatestPrice(): Promise<MarketDatum> {
    return {
      value: 3500,
      source: "hyperliquid",
      venue: "hyperliquid",
      symbol: "ETH",
      canonical_symbol: "ETH-PERP",
      method: "mark",
      timestamp: now,
      received_at: now,
      stale_after_ms: 5000,
      confidence: 0.99,
      raw_ref: "market-data/hyperliquid/eth/latest.json"
    };
  }

  async getCandles(): Promise<never> {
    throw new Error("not used");
  }

  async getOrderbookSnapshot(): Promise<never> {
    throw new Error("not used");
  }
}

function proposalRef(id: string) {
  return {
    id: `artifact_${id}`,
    kind: "proposal" as const,
    uri: `agent-artifacts/${id}.json`,
    content_hash: `sha256:${id}`,
    created_at: now,
    append_only: true as const
  };
}

function sampleIntent(): TradeIntent {
  return {
    id: "intent_001",
    created_at: now,
    created_by: {
      agent_id: "agent_session_001",
      model: "fake",
      strategy_id: "eth_breakout",
      strategy_version: "0.1.0"
    },
    mode: "paper",
    intent_type: "open_position",
    canonical_symbol: "ETH-PERP",
    side: "long",
    target_notional_usd: 2500,
    max_slippage_bps: 15,
    reason_ref: "agent-artifacts/research_brief_001.json",
    evidence_refs: ["agent-artifacts/research_brief_001.json"],
    risk_policy_ref: "risk/conservative_v1.json"
  };
}

function sampleRiskPolicy(): RiskPolicy {
  return {
    id: "risk/conservative_v1",
    created_at: now,
    mode: "paper_trading",
    allowed_symbols: ["ETH-PERP"],
    max_notional_usd: 5000,
    max_leverage: 2,
    max_slippage_bps: 25,
    stale_after_ms: 5000,
    require_evidence_refs: true,
    kill_switch: false,
    source_refs: []
  };
}

function sampleRiskReview(status: RiskReview["status"]): RiskReview {
  return {
    id: "risk_review_001",
    intent_id: "intent_001",
    policy_id: "risk/conservative_v1",
    created_at: now,
    status,
    checks: [
      {
        name: "max_notional",
        status: status === "approved" ? "pass" : "fail",
        message: "Risk engine review result."
      }
    ],
    required_approvals: []
  };
}

function sampleDeploymentGate(): DeploymentGate {
  return {
    id: "gate_001",
    created_at: now,
    strategy_id: "eth_breakout",
    strategy_version: "0.1.0",
    backtest: {
      dataset_ref: "datasets/hyperliquid/eth/6m",
      min_win_rate: 0.55,
      min_trades: 50,
      max_drawdown_pct: 12,
      include_fees: true,
      include_slippage_model: true
    },
    deployment: {
      mode: "paper_trading",
      duration_hours: 12,
      max_notional_usd: 2500,
      kill_switch: false
    },
    required_reviews: ["risk"]
  };
}
