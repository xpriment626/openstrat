import type {
  BacktestReport,
  BacktestRun,
  StrategyManifest,
  TradeIntent
} from "@openstrat/domain";

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
