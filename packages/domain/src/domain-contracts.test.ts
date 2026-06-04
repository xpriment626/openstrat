import { describe, expect, it } from "vitest";
import {
  BacktestReportSchema,
  BacktestRunSchema,
  BotRunSchema,
  CandleSchema,
  DecisionLedgerEntrySchema,
  DeploymentGateSchema,
  MarketDatumSchema,
  MarketRegistryEntrySchema,
  OrderbookSnapshotSchema,
  RiskPolicySchema,
  RiskReviewSchema,
  StrategyManifestSchema,
  TradeIntentSchema
} from "./index.js";

const now = "2026-06-04T00:00:00.000Z";
const later = "2026-06-04T00:01:00.000Z";

describe("trading harness domain contracts", () => {
  it("validates provenance-aware market primitives", () => {
    expect(
      MarketRegistryEntrySchema.safeParse({
        canonical_symbol: "ETH-PERP",
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
        liquidity_score: 0.92,
        last_verified_at: now,
        source_refs: ["raw/markets/hyperliquid/eth.json"]
      }).success
    ).toBe(true);

    expect(
      MarketDatumSchema.safeParse({
        value: 3650.25,
        source: "hyperliquid",
        venue: "hyperliquid",
        symbol: "ETH",
        canonical_symbol: "ETH-PERP",
        method: "mark",
        timestamp: now,
        received_at: later,
        stale_after_ms: 5000,
        confidence: 0.99,
        raw_ref: "raw/prices/eth-mark.json"
      }).success
    ).toBe(true);

    expect(
      MarketDatumSchema.safeParse({
        value: 3650.25,
        symbol: "ETH",
        canonical_symbol: "ETH-PERP",
        timestamp: now,
        received_at: later,
        stale_after_ms: 5000
      }).success
    ).toBe(false);
  });

  it("rejects malformed candles and crossed orderbooks", () => {
    expect(
      CandleSchema.safeParse({
        symbol: "ETH",
        canonical_symbol: "ETH-PERP",
        source: "hyperliquid",
        interval: "1m",
        open_time: now,
        close_time: later,
        open: 100,
        high: 101,
        low: 99,
        close: 100.5,
        volume: 12,
        method: "venue_ohlcv",
        received_at: later,
        raw_ref: "raw/candles/eth-1m.json"
      }).success
    ).toBe(true);

    expect(
      CandleSchema.safeParse({
        symbol: "ETH",
        canonical_symbol: "ETH-PERP",
        source: "hyperliquid",
        interval: "1m",
        open_time: later,
        close_time: now,
        open: 100,
        high: 99,
        low: 101,
        close: 100.5,
        volume: 12,
        received_at: later
      }).success
    ).toBe(false);

    expect(
      OrderbookSnapshotSchema.safeParse({
        source: "hyperliquid",
        venue: "hyperliquid",
        symbol: "ETH",
        canonical_symbol: "ETH-PERP",
        timestamp: now,
        received_at: later,
        depth: 1,
        bids: [{ price: 100, size: 1 }],
        asks: [{ price: 99, size: 1 }],
        stale_after_ms: 1000
      }).success
    ).toBe(false);
  });

  it("validates strategy, decision, and trade-intent artifacts", () => {
    expect(
      StrategyManifestSchema.safeParse({
        strategy_id: "eth_breakout",
        strategy_version: "0.1.0",
        name: "ETH breakout",
        runtime: "typescript",
        entrypoint: "src/strategy.ts",
        autonomy_mode: "strategy_workbench",
        allowed_symbols: ["ETH-PERP"],
        parameters: { lookback: 20 },
        required_data: [
          { kind: "candles", canonical_symbol: "ETH-PERP", interval: "15m" }
        ],
        output: "trade_intent",
        created_at: now,
        source_refs: ["strategies/eth_breakout/manifest.json"]
      }).success
    ).toBe(true);

    expect(
      DecisionLedgerEntrySchema.safeParse({
        id: "decision_001",
        created_at: now,
        strategy_id: "eth_breakout",
        strategy_version: "0.1.0",
        thesis: "Momentum is expanding after a high-volume range break.",
        evidence_refs: ["backtests/run_001/report.json"],
        assumptions: ["Funding remains neutral"],
        invalidation_conditions: ["Breakout candle closes back inside range"],
        confidence: "medium",
        created_by: { agent_id: "strategy-agent", model: "codex" }
      }).success
    ).toBe(true);

    expect(
      TradeIntentSchema.safeParse({
        id: "intent_001",
        created_at: now,
        created_by: {
          agent_id: "strategy-agent",
          model: "codex",
          strategy_id: "eth_breakout",
          strategy_version: "0.1.0"
        },
        mode: "paper",
        intent_type: "open_position",
        canonical_symbol: "ETH-PERP",
        side: "long",
        target_notional_usd: 2500,
        max_slippage_bps: 15,
        order_preference: { type: "limit", limit_price: 3650, time_in_force: "gtc" },
        reason_ref: "decision_001",
        evidence_refs: ["backtests/run_001/report.json"],
        risk_policy_ref: "risk/conservative_v1"
      }).success
    ).toBe(true);

    expect(
      TradeIntentSchema.safeParse({
        id: "intent_002",
        created_at: now,
        created_by: {
          strategy_id: "eth_breakout",
          strategy_version: "0.1.0"
        },
        mode: "paper",
        intent_type: "open_position",
        canonical_symbol: "ETH-PERP",
        side: "long",
        max_slippage_bps: 15,
        order_preference: { type: "limit" },
        reason_ref: "decision_001",
        evidence_refs: ["backtests/run_001/report.json"],
        risk_policy_ref: "risk/conservative_v1"
      }).success
    ).toBe(false);
  });

  it("validates backtest and deployment governance artifacts", () => {
    expect(
      BacktestRunSchema.safeParse({
        id: "backtest_001",
        strategy_id: "eth_breakout",
        strategy_version: "0.1.0",
        dataset_ref: "datasets/hyperliquid/eth/6m",
        canonical_symbols: ["ETH-PERP"],
        started_at: now,
        completed_at: later,
        status: "passed",
        parameters: { lookback: 20 },
        artifact_refs: ["backtests/run_001/report.json"]
      }).success
    ).toBe(true);

    expect(
      BacktestReportSchema.safeParse({
        run_id: "backtest_001",
        strategy_id: "eth_breakout",
        strategy_version: "0.1.0",
        dataset_ref: "datasets/hyperliquid/eth/6m",
        generated_at: later,
        metrics: {
          trades: 100,
          wins: 58,
          losses: 42,
          win_rate: 0.58,
          pnl_usd: 1250,
          max_drawdown_pct: 8.2,
          turnover_usd: 125000,
          fees_usd: 210,
          slippage_usd: 185
        },
        trade_ledger_ref: "backtests/run_001/trades.jsonl",
        artifact_refs: ["backtests/run_001/equity.csv"]
      }).success
    ).toBe(true);

    expect(
      BacktestReportSchema.safeParse({
        run_id: "backtest_001",
        strategy_id: "eth_breakout",
        strategy_version: "0.1.0",
        dataset_ref: "datasets/hyperliquid/eth/6m",
        generated_at: later,
        metrics: {
          trades: 2,
          wins: 2,
          losses: 2,
          win_rate: 0.5,
          pnl_usd: 10,
          max_drawdown_pct: 1,
          turnover_usd: 100,
          fees_usd: 1,
          slippage_usd: 1
        },
        trade_ledger_ref: "backtests/run_001/trades.jsonl"
      }).success
    ).toBe(false);
  });

  it("validates risk policy, risk review, deployment gate, and bot run records", () => {
    expect(
      RiskPolicySchema.safeParse({
        id: "risk/conservative_v1",
        created_at: now,
        mode: "draft_orders",
        allowed_symbols: ["ETH-PERP"],
        max_notional_usd: 5000,
        max_leverage: 2,
        max_slippage_bps: 25,
        max_daily_loss_usd: 350,
        min_liquidity_score: 0.75,
        stale_after_ms: 5000,
        require_evidence_refs: true,
        kill_switch: false
      }).success
    ).toBe(true);

    expect(
      RiskReviewSchema.safeParse({
        id: "risk_review_001",
        intent_id: "intent_001",
        policy_id: "risk/conservative_v1",
        created_at: later,
        status: "approved",
        checks: [
          {
            name: "max_notional",
            status: "pass",
            message: "Intent stays within max notional.",
            value: 2500,
            limit: 5000
          }
        ],
        required_approvals: []
      }).success
    ).toBe(true);

    expect(
      DeploymentGateSchema.safeParse({
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
          max_notional_usd: 5000,
          max_daily_loss_usd: 350,
          kill_switch: false
        },
        required_reviews: ["risk"]
      }).success
    ).toBe(true);

    expect(
      BotRunSchema.safeParse({
        id: "bot_run_001",
        strategy_id: "eth_breakout",
        strategy_version: "0.1.0",
        deployment_gate_id: "gate_001",
        mode: "paper_trading",
        status: "queued",
        ends_at: "2026-06-04T12:00:00.000Z"
      }).success
    ).toBe(true);

    expect(
      RiskPolicySchema.safeParse({
        id: "risk/bad",
        created_at: now,
        mode: "draft_orders",
        allowed_symbols: ["ETH-PERP"],
        max_notional_usd: 5000,
        max_leverage: 2,
        max_slippage_bps: 25,
        stale_after_ms: -1
      }).success
    ).toBe(false);
  });
});
