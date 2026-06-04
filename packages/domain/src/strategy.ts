import { z } from "zod";
import {
  AutonomyModeSchema,
  CanonicalSymbolSchema,
  ConfidenceSchema,
  IsoDateTimeSchema,
  JsonRecordSchema,
  NonEmptyStringSchema,
  SourceRefSchema
} from "./common.js";

export const StrategyRuntimeSchema = z.enum([
  "typescript",
  "javascript",
  "python",
  "wasm"
]);

export const StrategyDataRequirementSchema = z.object({
  kind: z.enum([
    "candles",
    "funding_rates",
    "open_interest",
    "orderbook_snapshots",
    "trades",
    "liquidations",
    "portfolio_snapshots"
  ]),
  canonical_symbol: CanonicalSymbolSchema.optional(),
  interval: NonEmptyStringSchema.optional(),
  min_lookback: NonEmptyStringSchema.optional(),
  source: NonEmptyStringSchema.optional()
});

export const StrategyManifestSchema = z.object({
  strategy_id: NonEmptyStringSchema,
  strategy_version: NonEmptyStringSchema,
  name: NonEmptyStringSchema,
  description: NonEmptyStringSchema.optional(),
  runtime: StrategyRuntimeSchema,
  entrypoint: NonEmptyStringSchema,
  autonomy_mode: AutonomyModeSchema.default("strategy_workbench"),
  allowed_symbols: z.array(CanonicalSymbolSchema).min(1),
  parameters: JsonRecordSchema.default({}),
  required_data: z.array(StrategyDataRequirementSchema).default([]),
  output: z.literal("trade_intent"),
  created_at: IsoDateTimeSchema,
  source_refs: z.array(SourceRefSchema).default([])
});

export const DecisionLedgerEntrySchema = z.object({
  id: NonEmptyStringSchema,
  created_at: IsoDateTimeSchema,
  strategy_id: NonEmptyStringSchema,
  strategy_version: NonEmptyStringSchema.optional(),
  run_id: NonEmptyStringSchema.optional(),
  thesis: NonEmptyStringSchema,
  evidence_refs: z.array(SourceRefSchema).min(1),
  assumptions: z.array(NonEmptyStringSchema).default([]),
  invalidation_conditions: z.array(NonEmptyStringSchema).default([]),
  confidence: ConfidenceSchema,
  created_by: z.object({
    agent_id: NonEmptyStringSchema.optional(),
    model: NonEmptyStringSchema.optional(),
    role: NonEmptyStringSchema.optional()
  }),
  tags: z.array(NonEmptyStringSchema).default([])
});

export type StrategyRuntime = z.infer<typeof StrategyRuntimeSchema>;
export type StrategyDataRequirement = z.infer<typeof StrategyDataRequirementSchema>;
export type StrategyManifest = z.infer<typeof StrategyManifestSchema>;
export type DecisionLedgerEntry = z.infer<typeof DecisionLedgerEntrySchema>;
