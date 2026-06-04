import { z } from "zod";
import {
  AutonomyModeSchema,
  BasisPointsSchema,
  CanonicalSymbolSchema,
  IsoDateTimeSchema,
  NonEmptyStringSchema,
  NonNegativeFiniteSchema,
  PositiveFiniteSchema,
  SourceRefSchema
} from "./common.js";
import { ExecutionEstimateSchema, PortfolioDeltaSchema } from "./trade.js";

export const RiskCheckSchema = z.object({
  name: NonEmptyStringSchema,
  status: z.enum(["pass", "warn", "fail"]),
  message: NonEmptyStringSchema,
  value: z.unknown().optional(),
  limit: z.unknown().optional()
});

export const RiskPolicySchema = z.object({
  id: NonEmptyStringSchema,
  created_at: IsoDateTimeSchema,
  mode: AutonomyModeSchema,
  allowed_symbols: z.array(CanonicalSymbolSchema).min(1),
  max_notional_usd: PositiveFiniteSchema,
  max_leverage: PositiveFiniteSchema,
  max_slippage_bps: BasisPointsSchema,
  max_daily_loss_usd: PositiveFiniteSchema.optional(),
  max_drawdown_pct: z.number().finite().min(0).max(100).optional(),
  min_liquidity_score: z.number().finite().min(0).max(1).optional(),
  stale_after_ms: z.number().int().min(0),
  require_evidence_refs: z.boolean().default(true),
  kill_switch: z.boolean().default(false),
  source_refs: z.array(SourceRefSchema).default([])
});

export const RiskReviewStatusSchema = z.enum([
  "approved",
  "rejected",
  "needs_review",
  "stale_data",
  "simulation_required"
]);

export const RiskReviewSchema = z.object({
  id: NonEmptyStringSchema,
  intent_id: NonEmptyStringSchema,
  policy_id: NonEmptyStringSchema,
  created_at: IsoDateTimeSchema,
  status: RiskReviewStatusSchema,
  checks: z.array(RiskCheckSchema).min(1),
  portfolio_delta: PortfolioDeltaSchema.optional(),
  estimated_execution: ExecutionEstimateSchema.optional(),
  required_approvals: z.array(NonEmptyStringSchema).default([])
});

export const DeploymentGateSchema = z.object({
  id: NonEmptyStringSchema,
  created_at: IsoDateTimeSchema,
  strategy_id: NonEmptyStringSchema,
  strategy_version: NonEmptyStringSchema,
  backtest: z.object({
    dataset_ref: SourceRefSchema,
    min_win_rate: z.number().finite().min(0).max(1),
    min_trades: z.number().int().min(1),
    max_drawdown_pct: z.number().finite().min(0).max(100),
    include_fees: z.boolean().default(true),
    include_slippage_model: z.boolean().default(true)
  }),
  deployment: z.object({
    mode: AutonomyModeSchema,
    duration_hours: PositiveFiniteSchema,
    max_notional_usd: PositiveFiniteSchema,
    max_daily_loss_usd: NonNegativeFiniteSchema.optional(),
    kill_switch: z.boolean().default(false)
  }),
  required_reviews: z.array(NonEmptyStringSchema).default([])
});

export const BotRunSchema = z.object({
  id: NonEmptyStringSchema,
  strategy_id: NonEmptyStringSchema,
  strategy_version: NonEmptyStringSchema,
  deployment_gate_id: NonEmptyStringSchema,
  mode: AutonomyModeSchema,
  status: z.enum(["queued", "running", "completed", "failed", "stopped"]),
  started_at: IsoDateTimeSchema.optional(),
  ends_at: IsoDateTimeSchema,
  stopped_at: IsoDateTimeSchema.optional(),
  worker_ref: NonEmptyStringSchema.optional(),
  latest_report_ref: SourceRefSchema.optional()
});

export type RiskCheck = z.infer<typeof RiskCheckSchema>;
export type RiskPolicy = z.infer<typeof RiskPolicySchema>;
export type RiskReviewStatus = z.infer<typeof RiskReviewStatusSchema>;
export type RiskReview = z.infer<typeof RiskReviewSchema>;
export type DeploymentGate = z.infer<typeof DeploymentGateSchema>;
export type BotRun = z.infer<typeof BotRunSchema>;
