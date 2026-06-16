import {
  BacktestReportSchema,
  MarketDatasetManifestSchema,
  type BacktestReport,
  type BacktestRun,
  type Candle,
  type MarketDataRecordFamily,
  type MarketDatasetManifest,
  type StrategyDataRequirement,
  type StrategyManifest,
  type TradeIntent
} from "@openstrat/domain";
import {
  validateMarketDataset,
  type MarketDatasetValidationResult
} from "@openstrat/market-data";
import type { ObjectStore } from "@openstrat/persistence";
import {
  createStrategyRunner,
  type StrategyModule,
  type StrategyMarketEvent
} from "@openstrat/strategy-sdk";

export const backtestingPackageName = "@openstrat/backtesting" as const;

export interface BacktestRequest {
  run: BacktestRun;
  strategy: StrategyManifest;
}

export interface BacktestReplayFrame {
  timestamp: string;
  market_refs: string[];
}

export interface BacktestRunner {
  run(request: BacktestRequest): Promise<BacktestReport>;
}

export interface StrategyReplayAdapter {
  evaluate(frame: BacktestReplayFrame): Promise<TradeIntent[]>;
}

export interface SlippageModelInput {
  candle: Candle;
  intent: TradeIntent;
  notional_usd: number;
}

export interface SlippageModelResult {
  slippage_bps: number;
  source_ref?: string;
}

export interface CandleBacktestRequest {
  run_id: string;
  strategy: StrategyModule;
  object_store: ObjectStore;
  artifact_ref_root?: string;
  dataset_ref: string;
  candle_refs: string[];
  raw_artifact_refs: string[];
  generated_at: string;
  initial_equity_usd: number;
  fee_bps: number;
  slippage_model: (input: SlippageModelInput) => SlippageModelResult;
  mode?: TradeIntent["mode"];
  risk_policy_ref?: string;
}

export interface StrategyDatasetCompatibilityPreflightInput {
  object_store: ObjectStore;
  strategy: StrategyManifest;
  dataset_ref: string;
  as_of?: string;
  source?: string;
  venue?: string;
  require_object_refs?: boolean;
}

export interface StrategyDatasetCompatibilityPreflightResult {
  manifest: MarketDatasetManifest;
  validation: MarketDatasetValidationResult;
  required_families: MarketDataRecordFamily[];
}

export interface BacktestTradeLedgerEntry {
  id: string;
  canonical_symbol: string;
  side: "long" | "short";
  opened_at: string;
  closed_at: string;
  entry_intent_id: string;
  exit_intent_id: string;
  entry_price: number;
  exit_price: number;
  quantity: number;
  notional_usd: number;
  gross_pnl_usd: number;
  net_pnl_usd: number;
  fees_usd: number;
  slippage_usd: number;
  source_refs: string[];
}

interface OpenPosition {
  canonical_symbol: string;
  side: "long" | "short";
  opened_at: string;
  entry_intent_id: string;
  entry_price: number;
  quantity: number;
  notional_usd: number;
  fees_usd: number;
  slippage_usd: number;
  source_refs: string[];
}

export function preflightStrategyDatasetCompatibility(
  input: StrategyDatasetCompatibilityPreflightInput
): StrategyDatasetCompatibilityPreflightResult {
  const manifest = MarketDatasetManifestSchema.parse(
    input.object_store.getJson(input.dataset_ref)
  );
  let requiredFamilies: MarketDataRecordFamily[];
  try {
    requiredFamilies = requiredFamiliesForStrategy(input.strategy.required_data);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Strategy dataset preflight failed for ${input.dataset_ref}: ${message}`,
      { cause: error }
    );
  }
  const expectedCanonicalSymbol = expectedDatasetCanonicalSymbol(input.strategy);
  const validation = validateMarketDataset(input.object_store, input.dataset_ref, {
    ...(input.as_of ? { as_of: input.as_of } : {}),
    ...(expectedCanonicalSymbol ? { canonical_symbol: expectedCanonicalSymbol } : {}),
    ...(input.source ? { source: input.source } : {}),
    ...(input.venue ? { venue: input.venue } : {}),
    required_families: requiredFamilies,
    require_object_refs: input.require_object_refs ?? true
  });
  const missingRequirements = [
    ...validation.missing_requirements,
    ...strategyDatasetMissingRequirements(input.strategy, manifest)
  ];
  if (missingRequirements.length > 0) {
    throw new Error(
      `Strategy dataset preflight failed for ${input.dataset_ref}: ${missingRequirements.join("; ")}`
    );
  }

  return {
    manifest,
    required_families: requiredFamilies,
    validation: {
      ...validation,
      valid: true,
      missing_requirements: []
    }
  };
}

export async function runCandleBacktest(
  request: CandleBacktestRequest
): Promise<BacktestReport> {
  const candles = request.candle_refs
    .flatMap((ref) => request.object_store.getJson<Candle[]>(ref))
    .sort(
      (left: Candle, right: Candle) =>
        Date.parse(left.open_time) - Date.parse(right.open_time)
    );
  const runner = createStrategyRunner();
  const marketEvents: StrategyMarketEvent[] = [];
  const openPositions = new Map<string, OpenPosition>();
  const tradeLedger: BacktestTradeLedgerEntry[] = [];
  const artifactRefs = [...request.candle_refs, ...request.raw_artifact_refs];

  let feesUsd = 0;
  let slippageUsd = 0;
  let turnoverUsd = 0;
  let equity = request.initial_equity_usd;
  let peakEquity = request.initial_equity_usd;
  let maxDrawdownPct = 0;

  for (const candle of candles) {
    marketEvents.push({ kind: "candle", candle });
    const result = await runner.evaluate(request.strategy, {
      now: candle.close_time,
      mode: request.mode ?? "paper",
      risk_policy_ref: request.risk_policy_ref ?? "risk/backtest",
      decision_ref: `backtests/${request.run_id}/frame/${candle.close_time}`,
      market_events: marketEvents
    });

    for (const intent of result.intents) {
      const notional = intent.target_notional_usd ?? 0;
      if (isOpenIntent(intent)) {
        const slippage = request.slippage_model({
          candle,
          intent,
          notional_usd: notional
        });
        const entryFee = feeUsd(notional, request.fee_bps);
        const entrySlippage = feeUsd(notional, slippage.slippage_bps);
        openPositions.set(intent.canonical_symbol, {
          canonical_symbol: intent.canonical_symbol,
          side: intent.side === "short" || intent.side === "sell" ? "short" : "long",
          opened_at: candle.close_time,
          entry_intent_id: intent.id,
          entry_price: candle.close,
          quantity: notional / candle.close,
          notional_usd: notional,
          fees_usd: entryFee,
          slippage_usd: entrySlippage,
          source_refs: sourceRefs(candle, slippage.source_ref)
        });
        feesUsd += entryFee;
        slippageUsd += entrySlippage;
        turnoverUsd += notional;
        continue;
      }

      if (isCloseIntent(intent)) {
        const position = openPositions.get(intent.canonical_symbol);
        if (!position) {
          continue;
        }

        const slippage = request.slippage_model({
          candle,
          intent,
          notional_usd: position.notional_usd
        });
        const exitFee = feeUsd(position.notional_usd, request.fee_bps);
        const exitSlippage = feeUsd(position.notional_usd, slippage.slippage_bps);
        const grossPnl =
          position.side === "long"
            ? (candle.close - position.entry_price) * position.quantity
            : (position.entry_price - candle.close) * position.quantity;
        const tradeFees = position.fees_usd + exitFee;
        const tradeSlippage = position.slippage_usd + exitSlippage;
        const netPnl = grossPnl - tradeFees - tradeSlippage;

        feesUsd += exitFee;
        slippageUsd += exitSlippage;
        turnoverUsd += position.notional_usd;
        equity += netPnl;
        peakEquity = Math.max(peakEquity, equity);
        maxDrawdownPct = Math.max(
          maxDrawdownPct,
          peakEquity === 0 ? 0 : ((peakEquity - equity) / peakEquity) * 100
        );

        tradeLedger.push({
          id: `${request.run_id}:trade:${tradeLedger.length + 1}`,
          canonical_symbol: intent.canonical_symbol,
          side: position.side,
          opened_at: position.opened_at,
          closed_at: candle.close_time,
          entry_intent_id: position.entry_intent_id,
          exit_intent_id: intent.id,
          entry_price: position.entry_price,
          exit_price: candle.close,
          quantity: position.quantity,
          notional_usd: position.notional_usd,
          gross_pnl_usd: round(grossPnl),
          net_pnl_usd: round(netPnl),
          fees_usd: round(tradeFees),
          slippage_usd: round(tradeSlippage),
          source_refs: uniqueRefs([
            ...position.source_refs,
            ...sourceRefs(candle, slippage.source_ref)
          ])
        });
        openPositions.delete(intent.canonical_symbol);
      }
    }
  }

  const tradeLedgerRoot = request.artifact_ref_root ?? `backtests/${request.run_id}`;
  const tradeLedgerRef = `${tradeLedgerRoot}/trade-ledger.json`;
  request.object_store.putJson(tradeLedgerRef, tradeLedger);

  const wins = tradeLedger.filter((trade) => trade.net_pnl_usd > 0).length;
  const losses = tradeLedger.filter((trade) => trade.net_pnl_usd < 0).length;
  const pnlUsd = tradeLedger.reduce((sum, trade) => sum + trade.net_pnl_usd, 0);

  return BacktestReportSchema.parse({
    run_id: request.run_id,
    strategy_id: request.strategy.manifest.strategy_id,
    strategy_version: request.strategy.manifest.strategy_version,
    dataset_ref: request.dataset_ref,
    generated_at: request.generated_at,
    metrics: {
      trades: tradeLedger.length,
      wins,
      losses,
      win_rate: tradeLedger.length === 0 ? 0 : wins / tradeLedger.length,
      pnl_usd: round(pnlUsd),
      max_drawdown_pct: round(maxDrawdownPct),
      turnover_usd: round(turnoverUsd),
      fees_usd: round(feesUsd),
      slippage_usd: round(slippageUsd)
    },
    trade_ledger_ref: tradeLedgerRef,
    artifact_refs: uniqueRefs([tradeLedgerRef, ...artifactRefs]),
    warnings: openPositions.size > 0 ? ["Backtest ended with open positions"] : []
  });
}

function requiredFamiliesForStrategy(
  requirements: readonly StrategyDataRequirement[]
): MarketDataRecordFamily[] {
  const families = new Set<MarketDataRecordFamily>();
  for (const requirement of requirements) {
    families.add(familyForStrategyRequirement(requirement));
  }
  return [...families];
}

function familyForStrategyRequirement(
  requirement: StrategyDataRequirement
): MarketDataRecordFamily {
  switch (requirement.kind) {
    case "candles":
      return "candles";
    case "funding_rates":
      return "funding_rates";
    case "orderbook_snapshots":
      return "orderbook_snapshots";
    default:
      throw new Error(`unsupported strategy data requirement: ${requirement.kind}`);
  }
}

function expectedDatasetCanonicalSymbol(
  strategy: StrategyManifest
): string | undefined {
  const requiredSymbols = uniqueRefs(
    strategy.required_data
      .map((requirement) => requirement.canonical_symbol)
      .filter((symbol): symbol is string => symbol !== undefined)
  );
  return requiredSymbols[0] ?? strategy.allowed_symbols[0];
}

function strategyDatasetMissingRequirements(
  strategy: StrategyManifest,
  manifest: MarketDatasetManifest
): string[] {
  const missingRequirements: string[] = [];
  if (!strategy.allowed_symbols.includes(manifest.canonical_symbol)) {
    missingRequirements.push(
      `dataset canonical_symbol ${manifest.canonical_symbol} is not allowed by strategy allowed_symbols: ${strategy.allowed_symbols.join(", ")}`
    );
  }

  for (const requirement of strategy.required_data) {
    if (
      requirement.canonical_symbol &&
      requirement.canonical_symbol !== manifest.canonical_symbol
    ) {
      missingRequirements.push(
        `required_data ${requirement.kind} canonical_symbol mismatch: expected ${requirement.canonical_symbol}, got ${manifest.canonical_symbol}`
      );
    }
    if (requirement.source && requirement.source !== manifest.source) {
      missingRequirements.push(
        `required_data ${requirement.kind} source mismatch: expected ${requirement.source}, got ${manifest.source}`
      );
    }
    if (
      requirement.kind === "candles" &&
      requirement.interval &&
      !manifest.coverage.candle_intervals.some(
        (interval) => interval === requirement.interval
      )
    ) {
      missingRequirements.push(`missing candle interval: ${requirement.interval}`);
    }
  }

  return missingRequirements;
}

function isOpenIntent(intent: TradeIntent): boolean {
  return (
    intent.intent_type === "open_position" || intent.intent_type === "increase_position"
  );
}

function isCloseIntent(intent: TradeIntent): boolean {
  return (
    intent.intent_type === "close_position" || intent.intent_type === "reduce_position"
  );
}

function feeUsd(notionalUsd: number, basisPoints: number): number {
  return notionalUsd * (basisPoints / 10_000);
}

function sourceRefs(candle: Candle, modelRef?: string): string[] {
  return uniqueRefs(
    [candle.raw_ref, modelRef].filter((ref): ref is string => ref !== undefined)
  );
}

function uniqueRefs(refs: string[]): string[] {
  return [...new Set(refs)];
}

function round(value: number): number {
  return Number(value.toFixed(6));
}
