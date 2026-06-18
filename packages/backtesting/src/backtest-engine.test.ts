import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type Candle,
  type MarketDatasetManifest,
  type StrategyDataRequirement
} from "@openstrat/domain";
import { FileObjectStore } from "@openstrat/persistence";
import { defineStrategy } from "@openstrat/strategy-sdk";
import {
  preflightStrategyDatasetCompatibility,
  runCandleBacktest,
  type BacktestTradeLedgerEntry
} from "./index.js";

const now = "2026-06-04T00:00:00.000Z";
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "openstrat-backtest-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("candle backtest engine", () => {
  it("preflights a strategy against a compatible dataset manifest", () => {
    const store = new FileObjectStore(tempDir);
    const dataset = putSyntheticDataset(store);

    const result = preflightStrategyDatasetCompatibility({
      object_store: store,
      strategy: twoRoundTripStrategy.manifest,
      dataset_ref: dataset.dataset_ref,
      as_of: now,
      source: "synthetic",
      venue: "synthetic"
    });

    expect(result.manifest.dataset_ref).toBe(dataset.dataset_ref);
    expect(result.validation).toMatchObject({
      valid: true,
      missing_requirements: []
    });
  });

  it("rejects datasets outside strategy symbol coverage", () => {
    const store = new FileObjectStore(tempDir);
    const dataset = putSyntheticDataset(store, {
      canonical_symbol: "ETH-PERP",
      dataset_ref: "datasets/synthetic/ETH-PERP/base.json",
      normalized_refs: [
        {
          ref: "normalized/synthetic/candles/ETH-15m.json",
          family: "candles",
          canonical_symbol: "ETH-PERP",
          source: "synthetic",
          venue: "synthetic",
          created_at: now,
          raw_refs: ["raw/synthetic/candles/BTC-15m.json"],
          immutable: true
        }
      ]
    });

    expect(() =>
      preflightStrategyDatasetCompatibility({
        object_store: store,
        strategy: twoRoundTripStrategy.manifest,
        dataset_ref: dataset.dataset_ref,
        as_of: now
      })
    ).toThrow(
      /Strategy dataset preflight failed for datasets\/synthetic\/ETH-PERP\/base\.json: .*canonical_symbol mismatch/
    );
  });

  it("rejects missing required dataset families", () => {
    const store = new FileObjectStore(tempDir);
    const dataset = putSyntheticDataset(store);
    const strategy = strategyWithRequirements([
      { kind: "candles", canonical_symbol: "BTC-PERP", interval: "15m" },
      { kind: "funding_rates", canonical_symbol: "BTC-PERP" }
    ]);

    expect(() =>
      preflightStrategyDatasetCompatibility({
        object_store: store,
        strategy: strategy.manifest,
        dataset_ref: dataset.dataset_ref,
        as_of: now
      })
    ).toThrow(/missing family: funding_rates/);
  });

  it("rejects unsupported strategy data requirements deterministically", () => {
    const store = new FileObjectStore(tempDir);
    const dataset = putSyntheticDataset(store);
    const strategy = strategyWithRequirements([
      { kind: "portfolio_snapshots", canonical_symbol: "BTC-PERP" }
    ]);

    expect(() =>
      preflightStrategyDatasetCompatibility({
        object_store: store,
        strategy: strategy.manifest,
        dataset_ref: dataset.dataset_ref,
        as_of: now
      })
    ).toThrow(/unsupported strategy data requirement: portfolio_snapshots/);
  });

  it("rejects datasets with missing normalized objects", () => {
    const store = new FileObjectStore(tempDir);
    const dataset = putSyntheticDataset(store, {}, { writeNormalized: false });

    expect(() =>
      preflightStrategyDatasetCompatibility({
        object_store: store,
        strategy: twoRoundTripStrategy.manifest,
        dataset_ref: dataset.dataset_ref,
        as_of: now
      })
    ).toThrow(
      /missing normalized object: normalized\/synthetic\/candles\/BTC-15m\.json/
    );
  });

  it("rejects stale datasets when an as_of context is supplied", () => {
    const store = new FileObjectStore(tempDir);
    const dataset = putSyntheticDataset(store, {
      freshness: {
        as_of: now,
        stale_after_ms: 1_000
      }
    });

    expect(() =>
      preflightStrategyDatasetCompatibility({
        object_store: store,
        strategy: twoRoundTripStrategy.manifest,
        dataset_ref: dataset.dataset_ref,
        as_of: "2026-06-04T00:00:02.000Z"
      })
    ).toThrow(/freshness stale/);
  });

  it("runs a deterministic strategy over stored candles and writes inspectable evidence artifacts", async () => {
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
    expect(report.intent_ledger_ref).toBe(
      "backtests/backtest_synthetic_001/intent-ledger.json"
    );
    expect(report.equity_curve_ref).toBe(
      "backtests/backtest_synthetic_001/equity-curve.json"
    );
    expect(report.diagnostics_ref).toBe(
      "backtests/backtest_synthetic_001/diagnostics.json"
    );
    expect(report.summary_ref).toBe("backtests/backtest_synthetic_001/summary.md");
    expect(report.artifact_refs).toEqual(
      expect.arrayContaining([
        candleRef,
        rawRef,
        report.trade_ledger_ref,
        report.intent_ledger_ref,
        report.equity_curve_ref,
        report.diagnostics_ref,
        report.summary_ref
      ])
    );
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

    const intentLedger = store.getJson<unknown[]>(report.intent_ledger_ref);
    const equityCurve = store.getJson<{ equity_usd: number }[]>(
      report.equity_curve_ref
    );
    const diagnostics = store.getJson<{
      candles: number;
      closed_trades: number;
      emitted_intents: number;
      open_positions_at_end: number;
    }>(report.diagnostics_ref);
    const summary = store.getBytes(report.summary_ref).toString("utf8");

    expect(intentLedger).toHaveLength(4);
    expect(intentLedger[0]).toMatchObject({
      action: "opened",
      intent_id: "intent_open_1"
    });
    expect(equityCurve.at(-1)).toMatchObject({ equity_usd: 9994 });
    expect(diagnostics).toMatchObject({
      candles: 4,
      closed_trades: 2,
      emitted_intents: 4,
      open_positions_at_end: 0
    });
    expect(summary).toContain("Backtest backtest_synthetic_001");
    expect(summary).toContain("Net PnL: -6");
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

function strategyWithRequirements(requiredData: StrategyDataRequirement[]) {
  return defineStrategy(
    {
      ...twoRoundTripStrategy.manifest,
      strategy_id: `strategy_${requiredData.map((requirement) => requirement.kind).join("_")}`,
      required_data: requiredData
    },
    () => []
  );
}

function putSyntheticDataset(
  store: FileObjectStore,
  overrides: Partial<MarketDatasetManifest> = {},
  options: { writeNormalized?: boolean; writeRaw?: boolean } = {}
): MarketDatasetManifest {
  const rawRef = "raw/synthetic/candles/BTC-15m.json";
  const candleRef = "normalized/synthetic/candles/BTC-15m.json";
  const manifest: MarketDatasetManifest = {
    dataset_ref: "datasets/synthetic/BTC-PERP/base.json",
    canonical_symbol: "BTC-PERP",
    source: "synthetic",
    venue: "synthetic",
    asset_class: "crypto",
    created_at: now,
    time_range: {
      start_at: "2026-06-04T00:00:00.000Z",
      end_at: "2026-06-04T01:00:00.000Z"
    },
    acquisition: {
      method: "fixture",
      requested_at: now,
      completed_at: now,
      deterministic: true
    },
    source_provenance: {
      source_kind: "fixture",
      public_ledger: false,
      replayable: true,
      verification_refs: ["fixtures/synthetic"]
    },
    raw_refs: [
      {
        ref: rawRef,
        kind: "candles",
        source: "synthetic",
        venue: "synthetic",
        captured_at: now,
        request: {},
        immutable: true
      }
    ],
    normalized_refs: [
      {
        ref: candleRef,
        family: "candles",
        canonical_symbol: "BTC-PERP",
        source: "synthetic",
        venue: "synthetic",
        created_at: now,
        raw_refs: [rawRef],
        immutable: true
      }
    ],
    freshness: {
      as_of: now,
      stale_after_ms: 60 * 60 * 1000
    },
    coverage: {
      families: ["candles"],
      candle_intervals: ["15m"]
    },
    append_only: true,
    ...overrides
  };

  if (options.writeRaw !== false) {
    for (const rawRefEntry of manifest.raw_refs) {
      store.putJson(rawRefEntry.ref, { source: rawRefEntry.source });
    }
  }
  if (options.writeNormalized !== false) {
    for (const normalizedRef of manifest.normalized_refs) {
      store.putJson(normalizedRef.ref, syntheticCandles());
    }
  }
  store.putJson(manifest.dataset_ref, manifest);
  return manifest;
}

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
