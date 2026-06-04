import {
  TradeIntentSchema,
  type StrategyManifest,
  type TradeIntent
} from "@openstrat/domain";

export const strategySdkPackageName = "@openstrat/strategy-sdk" as const;

export interface StrategyContext {
  now: string;
  market_refs: string[];
  decision_refs: string[];
}

export type StrategyEvaluate = (context: StrategyContext) => Promise<TradeIntent[]>;

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
