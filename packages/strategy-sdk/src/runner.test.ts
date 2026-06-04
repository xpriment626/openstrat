import { describe, expect, it } from "vitest";
import {
  TradeIntentSchema,
  type Candle,
  type StrategyManifest
} from "@openstrat/domain";
import {
  createStrategyRunner,
  defineStrategy,
  movingAverageBreakoutStrategy,
  type StrategyEvaluationInput
} from "./index.js";

const now = "2026-06-04T00:00:00.000Z";

describe("deterministic strategy runner", () => {
  it("runs a pure sample strategy over normalized market events and emits TradeIntent objects only", async () => {
    const runner = createStrategyRunner();
    const result = await runner.evaluate(
      movingAverageBreakoutStrategy,
      strategyInput([
        candle("2026-06-04T00:00:00.000Z", 100, 101),
        candle("2026-06-04T00:15:00.000Z", 101, 102),
        candle("2026-06-04T00:30:00.000Z", 102, 110)
      ])
    );

    expect(result.intents).toHaveLength(1);
    expect(TradeIntentSchema.safeParse(result.intents[0]).success).toBe(true);
    expect(result.intents[0]).toMatchObject({
      canonical_symbol: "BTC-PERP",
      intent_type: "open_position",
      mode: "paper",
      side: "long",
      target_notional_usd: 1000
    });
  });

  it("rejects strategies that return anything other than TradeIntent objects", async () => {
    const runner = createStrategyRunner();
    const strategy = defineStrategy(sampleManifest("bad_output"), () => [
      {
        type: "order",
        side: "buy"
      }
    ]);

    await expect(runner.evaluate(strategy, strategyInput([]))).rejects.toThrow(
      /TradeIntent/
    );
  });

  it("rejects strategies that reference network, process, filesystem, or Hyperliquid APIs", async () => {
    const runner = createStrategyRunner();
    const strategy = defineStrategy(
      sampleManifest("bad_network"),
      async function badNetwork() {
        await fetch("https://api.hyperliquid.xyz/info");
        process.cwd();
        return [];
      }
    );

    await expect(runner.evaluate(strategy, strategyInput([]))).rejects.toThrow(
      /forbidden API/
    );
  });

  it("rejects strategies that mutate normalized market event input", async () => {
    const runner = createStrategyRunner();
    const strategy = defineStrategy(sampleManifest("bad_mutation"), (input) => {
      input.market_events.push({
        kind: "candle",
        candle: candle("2026-06-04T00:45:00.000Z", 110, 111)
      });
      return [];
    });

    await expect(runner.evaluate(strategy, strategyInput([]))).rejects.toThrow(
      /mutate|read only|not extensible/i
    );
  });
});

function strategyInput(candles: Candle[]): StrategyEvaluationInput {
  return {
    now,
    mode: "paper",
    risk_policy_ref: "risk/backtest",
    decision_ref: "decision/sample",
    market_events: candles.map((item) => ({
      kind: "candle",
      candle: item
    }))
  };
}

function sampleManifest(strategyId: string): StrategyManifest {
  return {
    strategy_id: strategyId,
    strategy_version: "0.1.0",
    name: strategyId,
    runtime: "typescript",
    entrypoint: "test",
    autonomy_mode: "strategy_workbench",
    allowed_symbols: ["BTC-PERP"],
    parameters: {},
    required_data: [{ kind: "candles", canonical_symbol: "BTC-PERP", interval: "15m" }],
    output: "trade_intent",
    created_at: now,
    source_refs: []
  };
}

function candle(openTime: string, open: number, close: number): Candle {
  const openMs = Date.parse(openTime);
  return {
    symbol: "BTC",
    canonical_symbol: "BTC-PERP",
    source: "synthetic",
    venue: "synthetic",
    interval: "15m",
    open_time: openTime,
    close_time: new Date(openMs + 15 * 60 * 1000 - 1).toISOString(),
    open,
    high: Math.max(open, close),
    low: Math.min(open, close),
    close,
    volume: 100,
    method: "derived",
    received_at: now,
    raw_ref: "raw/synthetic/candles.json"
  };
}
