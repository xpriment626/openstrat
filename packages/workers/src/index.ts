import type { BacktestRunner } from "@openstrat/backtesting";
import type { MarketDataReader } from "@openstrat/market-data";
import type { EventLogRepository, ObjectStore } from "@openstrat/persistence";
import type { RiskPolicyEngine } from "@openstrat/risk";

export const workersPackageName = "@openstrat/workers" as const;

export interface HarnessWorkerDependencies {
  backtests: BacktestRunner;
  events: EventLogRepository;
  marketData: MarketDataReader;
  objects: ObjectStore;
  risk: RiskPolicyEngine;
}

export interface HarnessWorker {
  readonly name: string;
  start(dependencies: HarnessWorkerDependencies): Promise<void>;
  stop(): Promise<void>;
}

export * from "./agent-tool-gateway.js";
export * from "./deployment.js";
