import {
  BacktestReportSchema,
  type BacktestReport,
  type BacktestRun,
  type Candle,
  type StrategyManifest,
  type TradeIntent
} from "@openstrat/domain";
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

  const tradeLedgerRef = `backtests/${request.run_id}/trade-ledger.json`;
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
