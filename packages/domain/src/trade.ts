import { z } from "zod";
import {
  BasisPointsSchema,
  CanonicalSymbolSchema,
  IsoDateTimeSchema,
  NonEmptyStringSchema,
  NonNegativeFiniteSchema,
  PositiveFiniteSchema,
  SourceRefSchema
} from "./common.js";

export const TradeModeSchema = z.enum(["research", "paper", "draft", "live"]);
export const TradeIntentTypeSchema = z.enum([
  "open_position",
  "increase_position",
  "reduce_position",
  "close_position",
  "rebalance",
  "hedge"
]);
export const TradeSideSchema = z.enum(["long", "short", "buy", "sell"]);
export const OrderPreferenceSchema = z.object({
  type: z.enum(["market", "limit", "twap", "post_only"]),
  limit_price: PositiveFiniteSchema.optional(),
  time_in_force: z.enum(["ioc", "gtc", "fok"]).optional()
});

export const TradeIntentSchema = z
  .object({
    id: NonEmptyStringSchema,
    created_at: IsoDateTimeSchema,
    created_by: z.object({
      agent_id: NonEmptyStringSchema.optional(),
      model: NonEmptyStringSchema.optional(),
      strategy_id: NonEmptyStringSchema,
      strategy_version: NonEmptyStringSchema
    }),
    mode: TradeModeSchema,
    intent_type: TradeIntentTypeSchema,
    canonical_symbol: CanonicalSymbolSchema,
    side: TradeSideSchema,
    target_notional_usd: PositiveFiniteSchema.optional(),
    target_quantity: PositiveFiniteSchema.optional(),
    max_slippage_bps: BasisPointsSchema,
    max_fee_bps: BasisPointsSchema.optional(),
    leverage: PositiveFiniteSchema.optional(),
    order_preference: OrderPreferenceSchema.optional(),
    reason_ref: SourceRefSchema,
    evidence_refs: z.array(SourceRefSchema).min(1),
    risk_policy_ref: SourceRefSchema,
    invalidation: z
      .object({
        stop_loss: PositiveFiniteSchema.optional(),
        take_profit: PositiveFiniteSchema.optional(),
        thesis_invalid_if: z.array(NonEmptyStringSchema).default([])
      })
      .optional()
  })
  .superRefine((intent, ctx) => {
    if (
      intent.target_notional_usd === undefined &&
      intent.target_quantity === undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "target_notional_usd or target_quantity is required",
        path: ["target_notional_usd"]
      });
    }
    if (
      intent.order_preference?.type === "limit" &&
      intent.order_preference.limit_price === undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "limit orders require limit_price",
        path: ["order_preference", "limit_price"]
      });
    }
  });

export const PortfolioSnapshotSchema = z.object({
  id: NonEmptyStringSchema,
  timestamp: IsoDateTimeSchema,
  account_ref: NonEmptyStringSchema,
  equity_usd: NonNegativeFiniteSchema,
  free_collateral_usd: NonNegativeFiniteSchema,
  margin_used_usd: NonNegativeFiniteSchema,
  gross_exposure_usd: NonNegativeFiniteSchema,
  net_exposure_usd: z.number().finite(),
  positions: z.array(
    z.object({
      canonical_symbol: CanonicalSymbolSchema,
      side: z.enum(["long", "short"]),
      notional_usd: NonNegativeFiniteSchema,
      quantity: z.number().finite(),
      entry_price: PositiveFiniteSchema.optional(),
      mark_price: PositiveFiniteSchema.optional(),
      unrealized_pnl_usd: z.number().finite().optional()
    })
  )
});

export const PortfolioDeltaSchema = z.object({
  before: PortfolioSnapshotSchema,
  after_estimated: PortfolioSnapshotSchema,
  changes: z.array(
    z.object({
      field: NonEmptyStringSchema,
      before: z.union([z.number(), z.string(), z.null()]),
      after: z.union([z.number(), z.string(), z.null()]),
      severity: z.enum(["info", "warn", "fail"])
    })
  )
});

export const ExecutionEstimateSchema = z.object({
  estimated_fill_price: PositiveFiniteSchema.optional(),
  estimated_slippage_bps: BasisPointsSchema,
  estimated_fee_bps: BasisPointsSchema.optional(),
  estimated_fee_usd: NonNegativeFiniteSchema.optional(),
  liquidity_source_refs: z.array(SourceRefSchema).default([])
});

export type TradeMode = z.infer<typeof TradeModeSchema>;
export type TradeIntentType = z.infer<typeof TradeIntentTypeSchema>;
export type TradeSide = z.infer<typeof TradeSideSchema>;
export type OrderPreference = z.infer<typeof OrderPreferenceSchema>;
export type TradeIntent = z.infer<typeof TradeIntentSchema>;
export type PortfolioSnapshot = z.infer<typeof PortfolioSnapshotSchema>;
export type PortfolioDelta = z.infer<typeof PortfolioDeltaSchema>;
export type ExecutionEstimate = z.infer<typeof ExecutionEstimateSchema>;
