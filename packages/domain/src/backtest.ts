import { z } from "zod";
import {
  CanonicalSymbolSchema,
  IsoDateTimeSchema,
  JsonRecordSchema,
  NonEmptyStringSchema,
  NonNegativeFiniteSchema,
  PercentSchema,
  RatioSchema,
  SourceRefSchema
} from "./common.js";

export const BacktestStatusSchema = z.enum([
  "queued",
  "running",
  "passed",
  "failed",
  "error"
]);

export const BacktestRunSchema = z.object({
  id: NonEmptyStringSchema,
  strategy_id: NonEmptyStringSchema,
  strategy_version: NonEmptyStringSchema,
  dataset_ref: SourceRefSchema,
  canonical_symbols: z.array(CanonicalSymbolSchema).min(1),
  started_at: IsoDateTimeSchema,
  completed_at: IsoDateTimeSchema.optional(),
  status: BacktestStatusSchema,
  parameters: JsonRecordSchema.default({}),
  artifact_refs: z.array(SourceRefSchema).default([])
});

export const BacktestMetricsSchema = z.object({
  trades: z.number().int().min(0),
  wins: z.number().int().min(0),
  losses: z.number().int().min(0),
  win_rate: RatioSchema,
  pnl_usd: z.number().finite(),
  max_drawdown_pct: PercentSchema,
  turnover_usd: NonNegativeFiniteSchema,
  fees_usd: NonNegativeFiniteSchema,
  slippage_usd: NonNegativeFiniteSchema
});

export const BacktestReportSchema = z
  .object({
    run_id: NonEmptyStringSchema,
    strategy_id: NonEmptyStringSchema,
    strategy_version: NonEmptyStringSchema,
    dataset_ref: SourceRefSchema,
    generated_at: IsoDateTimeSchema,
    metrics: BacktestMetricsSchema,
    trade_ledger_ref: SourceRefSchema,
    intent_ledger_ref: SourceRefSchema.optional(),
    equity_curve_ref: SourceRefSchema.optional(),
    diagnostics_ref: SourceRefSchema.optional(),
    summary_ref: SourceRefSchema.optional(),
    artifact_refs: z.array(SourceRefSchema).default([]),
    warnings: z.array(NonEmptyStringSchema).default([])
  })
  .superRefine((report, ctx) => {
    const finishedTrades = report.metrics.wins + report.metrics.losses;
    if (finishedTrades > report.metrics.trades) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "wins plus losses cannot exceed total trades",
        path: ["metrics", "trades"]
      });
    }
  });

export type BacktestStatus = z.infer<typeof BacktestStatusSchema>;
export type BacktestRun = z.infer<typeof BacktestRunSchema>;
export type BacktestMetrics = z.infer<typeof BacktestMetricsSchema>;
export type BacktestReport = z.infer<typeof BacktestReportSchema>;
