import { describe, expect, it } from "vitest";
import {
  type MarketDatum,
  type MarketRegistryEntry,
  type RiskPolicy,
  type TradeIntent
} from "@openstrat/domain";
import { validateTradeIntentRisk } from "./index.js";

const now = "2026-06-04T00:00:00.000Z";

describe("risk policy validator", () => {
  it("approves intents that pass market, freshness, size, leverage, drawdown, loss, slippage, mode, and evidence checks", () => {
    const review = validateTradeIntentRisk(intent(), policy(), context());

    expect(review.status).toBe("approved");
    expect(review.checks.every((check) => check.status === "pass")).toBe(true);
    expect(review.intent_id).toBe("intent_001");
    expect(review.policy_id).toBe("risk/conservative_v1");
  });

  it("returns needs_review with warn checks for low-liquidity markets near policy limits", () => {
    const review = validateTradeIntentRisk(
      intent({ target_notional_usd: 4500 }),
      policy(),
      {
        ...context(),
        market: market({ status: "low_liquidity", liquidity_score: 0.25 }),
        estimated_slippage_bps: 23
      }
    );

    expect(review.status).toBe("needs_review");
    expect(review.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "market_status", status: "warn" }),
        expect.objectContaining({ name: "slippage_budget", status: "warn" }),
        expect.objectContaining({ name: "max_notional", status: "warn" })
      ])
    );
  });

  it("rejects intents that breach hard policy limits or required evidence", () => {
    const review = validateTradeIntentRisk(
      intent({
        evidence_refs: [],
        leverage: 4,
        target_notional_usd: 6000
      }),
      policy(),
      {
        ...context(),
        current_daily_loss_usd: 400,
        current_drawdown_pct: 15
      }
    );

    expect(review.status).toBe("rejected");
    expect(review.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "required_evidence_refs", status: "fail" }),
        expect.objectContaining({ name: "max_leverage", status: "fail" }),
        expect.objectContaining({ name: "max_notional", status: "fail" }),
        expect.objectContaining({ name: "max_daily_loss", status: "fail" }),
        expect.objectContaining({ name: "max_drawdown", status: "fail" })
      ])
    );
  });

  it("returns stale_data when latest market data exceeds freshness policy", () => {
    const review = validateTradeIntentRisk(intent(), policy(), {
      ...context(),
      latest_market_data: marketDatum({
        received_at: "2026-06-03T23:59:50.000Z",
        stale_after_ms: 1000
      })
    });

    expect(review.status).toBe("stale_data");
    expect(review.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "data_freshness", status: "fail" })
      ])
    );
  });

  it("returns simulation_required when slippage estimate is missing", () => {
    const review = validateTradeIntentRisk(intent(), policy(), {
      ...context(),
      estimated_slippage_bps: undefined
    });

    expect(review.status).toBe("simulation_required");
    expect(review.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "slippage_budget", status: "warn" })
      ])
    );
  });
});

function policy(overrides: Partial<RiskPolicy> = {}): RiskPolicy {
  return {
    id: "risk/conservative_v1",
    created_at: now,
    mode: "draft_orders",
    allowed_symbols: ["BTC-PERP"],
    max_notional_usd: 5000,
    max_leverage: 2,
    max_slippage_bps: 25,
    max_daily_loss_usd: 350,
    max_drawdown_pct: 12,
    min_liquidity_score: 0.2,
    stale_after_ms: 5000,
    require_evidence_refs: true,
    kill_switch: false,
    source_refs: [],
    ...overrides
  };
}

function intent(overrides: Partial<TradeIntent> = {}): TradeIntent {
  return {
    id: "intent_001",
    created_at: now,
    created_by: {
      strategy_id: "synthetic",
      strategy_version: "0.1.0"
    },
    mode: "draft",
    intent_type: "open_position",
    canonical_symbol: "BTC-PERP",
    side: "long",
    target_notional_usd: 2500,
    max_slippage_bps: 20,
    leverage: 1.5,
    order_preference: { type: "market" },
    reason_ref: "decision_001",
    evidence_refs: ["backtests/run_001/report.json"],
    risk_policy_ref: "risk/conservative_v1",
    ...overrides
  };
}

function context(
  overrides: Partial<Parameters<typeof validateTradeIntentRisk>[2]> = {}
) {
  return {
    now,
    review_id: "risk_review_001",
    market: market(),
    latest_market_data: marketDatum(),
    estimated_slippage_bps: 12,
    current_drawdown_pct: 3,
    current_daily_loss_usd: 50,
    ...overrides
  };
}

function market(overrides: Partial<MarketRegistryEntry> = {}): MarketRegistryEntry {
  return {
    canonical_symbol: "BTC-PERP",
    display_symbol: "BTC",
    venue_symbol: "BTC",
    venue: "hyperliquid",
    source: "hyperliquid",
    asset_class: "crypto",
    quote_token: "USDC",
    collateral_token: "USDC",
    max_leverage: 50,
    status: "active",
    liquidity_score: 0.95,
    last_verified_at: now,
    source_refs: ["raw/hyperliquid/meta.json"],
    ...overrides
  };
}

function marketDatum(overrides: Partial<MarketDatum> = {}): MarketDatum {
  return {
    value: 100,
    source: "hyperliquid",
    venue: "hyperliquid",
    symbol: "BTC",
    canonical_symbol: "BTC-PERP",
    method: "mark",
    timestamp: now,
    received_at: now,
    stale_after_ms: 5000,
    raw_ref: "raw/hyperliquid/mark.json",
    ...overrides
  };
}
