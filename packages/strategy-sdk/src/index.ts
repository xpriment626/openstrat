import {
  TradeIntentSchema,
  type Candle,
  type FundingRateSnapshot,
  type MarketDatum,
  type OrderbookSnapshot,
  type StrategyManifest,
  type TradeIntent
} from "@openstrat/domain";

export const strategySdkPackageName = "@openstrat/strategy-sdk" as const;

export type StrategyMarketEvent =
  | { kind: "candle"; candle: Candle }
  | { kind: "market_datum"; datum: MarketDatum }
  | { kind: "funding_rate"; funding_rate: FundingRateSnapshot }
  | { kind: "orderbook"; orderbook: OrderbookSnapshot };

export interface StrategyEvaluationInput {
  now: string;
  mode: TradeIntent["mode"];
  risk_policy_ref: string;
  decision_ref: string;
  market_events: StrategyMarketEvent[];
}

export interface StrategyEvaluationResult {
  intents: TradeIntent[];
}

export type StrategyEvaluate = (
  context: StrategyEvaluationInput
) => Promise<unknown[]> | unknown[];

export interface StrategyModule {
  manifest: StrategyManifest;
  evaluate: StrategyEvaluate;
}

export function defineStrategy(
  manifest: StrategyManifest,
  evaluate: StrategyEvaluate
): StrategyModule {
  return { manifest, evaluate };
}

export function parseTradeIntent(candidate: unknown): TradeIntent {
  return TradeIntentSchema.parse(candidate);
}

export interface StrategyRunner {
  evaluate(
    strategy: StrategyModule,
    input: StrategyEvaluationInput
  ): Promise<StrategyEvaluationResult>;
}

export function createStrategyRunner(): StrategyRunner {
  return {
    async evaluate(strategy, input) {
      validateStrategyPurity(strategy);

      const firstInput = deepFreeze(structuredClone(input));
      const firstOutput = await strategy.evaluate(firstInput);
      const intents = parseTradeIntentArray(firstOutput);

      const secondInput = deepFreeze(structuredClone(input));
      const secondOutput = await strategy.evaluate(secondInput);
      const secondIntents = parseTradeIntentArray(secondOutput);
      if (JSON.stringify(intents) !== JSON.stringify(secondIntents)) {
        throw new Error("Strategy output is not deterministic for identical input");
      }

      return { intents };
    }
  };
}

export const movingAverageBreakoutStrategy = defineStrategy(
  {
    strategy_id: "sample_moving_average_breakout",
    strategy_version: "0.1.0",
    name: "Sample moving average breakout",
    description:
      "Reference pure strategy that emits a TradeIntent on a candle breakout.",
    runtime: "typescript",
    entrypoint: "@openstrat/strategy-sdk/samples/moving-average-breakout",
    autonomy_mode: "strategy_workbench",
    allowed_symbols: ["BTC-PERP"],
    parameters: {
      lookback_candles: 3,
      target_notional_usd: 1000
    },
    required_data: [{ kind: "candles", canonical_symbol: "BTC-PERP", interval: "15m" }],
    output: "trade_intent",
    created_at: "2026-06-04T00:00:00.000Z",
    source_refs: []
  },
  (input) => {
    const candles = input.market_events
      .filter(
        (event): event is { kind: "candle"; candle: Candle } => event.kind === "candle"
      )
      .map((event) => event.candle);

    if (candles.length < 3) {
      return [];
    }

    const last = candles.at(-1);
    const previous = candles.slice(-3, -1);
    if (!last) {
      return [];
    }

    const priorHigh = Math.max(...previous.map((candle) => candle.high));
    if (last.close <= priorHigh) {
      return [];
    }

    return [
      {
        id: `sample_moving_average_breakout:${last.close_time}:open`,
        created_at: input.now,
        created_by: {
          strategy_id: "sample_moving_average_breakout",
          strategy_version: "0.1.0"
        },
        mode: input.mode,
        intent_type: "open_position",
        canonical_symbol: last.canonical_symbol,
        side: "long",
        target_notional_usd: 1000,
        max_slippage_bps: 15,
        order_preference: { type: "market" },
        reason_ref: input.decision_ref,
        evidence_refs: [last.raw_ref ?? input.decision_ref],
        risk_policy_ref: input.risk_policy_ref,
        invalidation: {
          thesis_invalid_if: ["breakout candle closes back inside prior range"]
        }
      }
    ];
  }
);

function parseTradeIntentArray(output: unknown): TradeIntent[] {
  if (!Array.isArray(output)) {
    throw new Error("Strategy must return an array of TradeIntent objects");
  }

  return output.map((candidate, index) => {
    const parsed = TradeIntentSchema.safeParse(candidate);
    if (!parsed.success) {
      throw new Error(`Strategy output at index ${index} is not a TradeIntent`);
    }
    return parsed.data;
  });
}

function validateStrategyPurity(strategy: StrategyModule): void {
  const source = strategy.evaluate.toString();
  const forbiddenPatterns = [
    /\bfetch\s*\(/,
    /\bprocess\b/,
    /\bXMLHttpRequest\b/,
    /\bWebSocket\b/,
    /\bHyperliquid\b/i,
    /\bFileObjectStore\b/,
    /\bSqliteEventLog\b/,
    /\bimport\s*\(/,
    /\brequire\s*\(/,
    /\bnode:fs\b/,
    /\bfs\./,
    /\bchild_process\b/,
    /\bDate\.now\s*\(/,
    /\bnew\s+Date\s*\(/,
    /\bMath\.random\s*\(/,
    /\brandomUUID\s*\(/
  ];

  const matched = forbiddenPatterns.find((pattern) => pattern.test(source));
  if (matched) {
    throw new Error(`Strategy references forbidden API: ${matched.source}`);
  }
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") {
    return value;
  }

  Object.freeze(value);
  for (const nested of Object.values(value)) {
    deepFreeze(nested);
  }

  return value;
}
