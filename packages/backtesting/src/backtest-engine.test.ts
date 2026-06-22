import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Candle } from "@openstrat/domain";
import { FileObjectStore } from "@openstrat/persistence";
import { defineStrategy } from "@openstrat/strategy-sdk";
import { runCandleBacktest, type BacktestTradeLedgerEntry } from "./index.js";

const now = "2026-06-04T00:00:00.000Z";
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "openstrat-backtest-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("candle backtest engine", () => {
  it("runs a deterministic strategy over stored candles and writes fixed metrics plus trade ledger artifacts", async () => {
    const store = new FileObjectStore(tempDir);
    const candleRef = "normalized/synthetic/candles/BTC-15m.json";
    const rawRef = "raw/synthetic/candles/BTC-15m.json";
    store.putJson(candleRef, syntheticCandles());
    store.putJson(rawRef, { source: "synthetic" });

    const report = await runCandleBacktest({
      run_id: "backtest_synthetic_001",
      strategy: twoRoundTripStrategy,
      object_store: store,
      dataset_ref: "datasets/synthetic/four-candle-roundtrip",
      candle_refs: [candleRef],
      raw_artifact_refs: [rawRef],
      generated_at: now,
      initial_equity_usd: 10_000,
      fee_bps: 10,
      slippage_model: () => ({
        slippage_bps: 5,
        source_ref: "models/slippage/fixed-5bps"
      })
    });

    expect(report.dataset_ref).toBe("datasets/synthetic/four-candle-roundtrip");
    expect(report.trade_ledger_ref).toBe(
      "backtests/backtest_synthetic_001/trade-ledger.json"
    );
    expect(report.artifact_refs).toEqual(expect.arrayContaining([candleRef, rawRef]));
    expect(report.metrics).toMatchObject({
      trades: 2,
      wins: 1,
      losses: 1,
      win_rate: 0.5,
      pnl_usd: -6,
      turnover_usd: 4000,
      fees_usd: 4,
      slippage_usd: 2
    });
    expect(report.metrics.max_drawdown_pct).toBeCloseTo(1.0201, 4);

    const ledger = store.getJson<BacktestTradeLedgerEntry[]>(report.trade_ledger_ref);
    expect(ledger).toHaveLength(2);
    expect(ledger[0]).toMatchObject({
      canonical_symbol: "BTC-PERP",
      side: "long",
      entry_price: 100,
      exit_price: 110,
      gross_pnl_usd: 100,
      net_pnl_usd: 97
    });
    expect(ledger[1]).toMatchObject({
      entry_price: 100,
      exit_price: 90,
      gross_pnl_usd: -100,
      net_pnl_usd: -103
    });
  });
});

const twoRoundTripStrategy = defineStrategy(
  {
    strategy_id: "synthetic_two_round_trip",
    strategy_version: "0.1.0",
    name: "Synthetic two round trip",
    runtime: "typescript",
    entrypoint: "test",
    autonomy_mode: "strategy_workbench",
    allowed_symbols: ["BTC-PERP"],
    parameters: {},
    required_data: [{ kind: "candles", canonical_symbol: "BTC-PERP", interval: "15m" }],
    output: "trade_intent",
    created_at: now,
    source_refs: []
  },
  (input) => {
    const lastEvent = input.market_events.at(-1);
    if (lastEvent?.kind !== "candle") {
      return [];
    }

    const closeTime = lastEvent.candle.close_time;
    const base = {
      created_at: input.now,
      created_by: {
        strategy_id: "synthetic_two_round_trip",
        strategy_version: "0.1.0"
      },
      mode: input.mode,
      canonical_symbol: "BTC-PERP",
      target_notional_usd: 1000,
      max_slippage_bps: 10,
      reason_ref: input.decision_ref,
      evidence_refs: [lastEvent.candle.raw_ref ?? input.decision_ref],
      risk_policy_ref: input.risk_policy_ref
    };

    if (closeTime === "2026-06-04T00:14:59.999Z") {
      return [
        { ...base, id: "intent_open_1", intent_type: "open_position", side: "long" }
      ];
    }
    if (closeTime === "2026-06-04T00:29:59.999Z") {
      return [
        { ...base, id: "intent_close_1", intent_type: "close_position", side: "sell" }
      ];
    }
    if (closeTime === "2026-06-04T00:44:59.999Z") {
      return [
        { ...base, id: "intent_open_2", intent_type: "open_position", side: "long" }
      ];
    }
    if (closeTime === "2026-06-04T00:59:59.999Z") {
      return [
        { ...base, id: "intent_close_2", intent_type: "close_position", side: "sell" }
      ];
    }

    return [];
  }
);

function syntheticCandles(): Candle[] {
  return [
    candle("2026-06-04T00:00:00.000Z", 100),
    candle("2026-06-04T00:15:00.000Z", 110),
    candle("2026-06-04T00:30:00.000Z", 100),
    candle("2026-06-04T00:45:00.000Z", 90)
  ];
}

function candle(openTime: string, close: number): Candle {
  const openMs = Date.parse(openTime);
  return {
    symbol: "BTC",
    canonical_symbol: "BTC-PERP",
    source: "synthetic",
    venue: "synthetic",
    interval: "15m",
    open_time: openTime,
    close_time: new Date(openMs + 15 * 60 * 1000 - 1).toISOString(),
    open: close,
    high: close,
    low: close,
    close,
    volume: 100,
    method: "derived",
    received_at: now,
    raw_ref: "raw/synthetic/candles/BTC-15m.json"
  };
}
