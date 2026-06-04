import { z } from "zod";

export const IsoDateTimeSchema = z.string().datetime({ offset: true });
export const NonEmptyStringSchema = z.string().trim().min(1);
export const CanonicalSymbolSchema = NonEmptyStringSchema.regex(
  /^[A-Z0-9][A-Z0-9._:/-]*$/,
  "Canonical symbols should be stable uppercase identifiers"
);
export const SourceRefSchema = NonEmptyStringSchema;
export const JsonRecordSchema = z.record(z.string(), z.unknown());
export const NonNegativeFiniteSchema = z.number().finite().min(0);
export const PositiveFiniteSchema = z.number().finite().positive();
export const RatioSchema = z.number().finite().min(0).max(1);
export const PercentSchema = z.number().finite().min(0).max(100);
export const BasisPointsSchema = z.number().finite().min(0).max(10_000);

export const ConfidenceSchema = z.enum(["low", "medium", "high"]);
export const AutonomyModeSchema = z.enum([
  "research_only",
  "strategy_workbench",
  "paper_trading",
  "draft_orders",
  "constrained_live",
  "adaptive_management"
]);

export type IsoDateTime = z.infer<typeof IsoDateTimeSchema>;
export type Confidence = z.infer<typeof ConfidenceSchema>;
export type AutonomyMode = z.infer<typeof AutonomyModeSchema>;
