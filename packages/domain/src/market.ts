import { z } from "zod";
import {
  BasisPointsSchema,
  CanonicalSymbolSchema,
  IsoDateTimeSchema,
  JsonRecordSchema,
  NonEmptyStringSchema,
  NonNegativeFiniteSchema,
  PositiveFiniteSchema,
  RatioSchema,
  SourceRefSchema
} from "./common.js";

export const MarketStatusSchema = z.enum([
  "active",
  "inactive",
  "ambiguous",
  "degraded",
  "delisted",
  "read_only",
  "disallowed_by_policy"
]);

export const AssetClassSchema = z.enum([
  "crypto",
  "equities",
  "commodities",
  "indices",
  "fx",
  "other"
]);

export const MarketDataSourceSchema = NonEmptyStringSchema;
export const PriceMethodSchema = z.enum([
  "mark",
  "index",
  "oracle",
  "last_trade",
  "mid",
  "aggregated"
]);

export const CandleIntervalSchema = z.enum([
  "1m",
  "5m",
  "15m",
  "30m",
  "1h",
  "4h",
  "1d"
]);

export const CandleMethodSchema = z.enum([
  "venue_ohlcv",
  "aggregated_ohlcv",
  "derived"
]);

export const MarketRegistryEntrySchema = z.object({
  canonical_symbol: CanonicalSymbolSchema,
  display_symbol: NonEmptyStringSchema,
  venue_symbol: NonEmptyStringSchema.optional(),
  venue: NonEmptyStringSchema.optional(),
  source: MarketDataSourceSchema.default("hyperliquid"),
  asset_class: AssetClassSchema,
  quote_token: NonEmptyStringSchema,
  collateral_token: NonEmptyStringSchema.optional(),
  max_leverage: PositiveFiniteSchema.optional(),
  min_order_size: PositiveFiniteSchema.optional(),
  tick_size: PositiveFiniteSchema.optional(),
  lot_size: PositiveFiniteSchema.optional(),
  status: MarketStatusSchema,
  liquidity_score: RatioSchema.optional(),
  last_verified_at: IsoDateTimeSchema,
  source_refs: z.array(SourceRefSchema).min(1),
  metadata: JsonRecordSchema.optional()
});

export const MarketDatumSchema = z.object({
  value: z.unknown(),
  source: MarketDataSourceSchema,
  venue: NonEmptyStringSchema.optional(),
  symbol: NonEmptyStringSchema,
  canonical_symbol: CanonicalSymbolSchema,
  method: PriceMethodSchema.optional(),
  timestamp: IsoDateTimeSchema,
  received_at: IsoDateTimeSchema,
  stale_after_ms: z.number().int().min(0),
  confidence: RatioSchema.optional(),
  raw_ref: SourceRefSchema.optional()
});

export const CandleSchema = z
  .object({
    symbol: NonEmptyStringSchema,
    canonical_symbol: CanonicalSymbolSchema,
    source: MarketDataSourceSchema,
    venue: NonEmptyStringSchema.optional(),
    interval: CandleIntervalSchema,
    open_time: IsoDateTimeSchema,
    close_time: IsoDateTimeSchema,
    open: NonNegativeFiniteSchema,
    high: NonNegativeFiniteSchema,
    low: NonNegativeFiniteSchema,
    close: NonNegativeFiniteSchema,
    volume: NonNegativeFiniteSchema,
    quote_volume: NonNegativeFiniteSchema.optional(),
    method: CandleMethodSchema.optional(),
    received_at: IsoDateTimeSchema,
    raw_ref: SourceRefSchema.optional()
  })
  .superRefine((candle, ctx) => {
    const openTime = Date.parse(candle.open_time);
    const closeTime = Date.parse(candle.close_time);
    if (
      Number.isFinite(openTime) &&
      Number.isFinite(closeTime) &&
      closeTime <= openTime
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "close_time must be after open_time",
        path: ["close_time"]
      });
    }

    const candleMax = Math.max(candle.open, candle.close);
    const candleMin = Math.min(candle.open, candle.close);
    if (candle.high < candleMax) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "high must be greater than or equal to open and close",
        path: ["high"]
      });
    }
    if (candle.low > candleMin) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "low must be less than or equal to open and close",
        path: ["low"]
      });
    }
  });

export const OrderbookLevelSchema = z.object({
  price: PositiveFiniteSchema,
  size: NonNegativeFiniteSchema,
  order_count: z.number().int().min(0).optional()
});

export const OrderbookSnapshotSchema = z
  .object({
    source: MarketDataSourceSchema,
    venue: NonEmptyStringSchema.optional(),
    symbol: NonEmptyStringSchema,
    canonical_symbol: CanonicalSymbolSchema,
    timestamp: IsoDateTimeSchema,
    received_at: IsoDateTimeSchema,
    depth: z.number().int().positive(),
    bids: z.array(OrderbookLevelSchema).min(1),
    asks: z.array(OrderbookLevelSchema).min(1),
    stale_after_ms: z.number().int().min(0),
    spread_bps: BasisPointsSchema.optional(),
    raw_ref: SourceRefSchema.optional()
  })
  .superRefine((snapshot, ctx) => {
    const bestBid = snapshot.bids[0];
    const bestAsk = snapshot.asks[0];
    if (bestBid && bestAsk && bestBid.price >= bestAsk.price) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "best bid must be lower than best ask",
        path: ["bids", 0, "price"]
      });
    }
    if (snapshot.depth < Math.max(snapshot.bids.length, snapshot.asks.length)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "depth must cover the submitted bid and ask levels",
        path: ["depth"]
      });
    }
  });

export type MarketStatus = z.infer<typeof MarketStatusSchema>;
export type AssetClass = z.infer<typeof AssetClassSchema>;
export type MarketDataSource = z.infer<typeof MarketDataSourceSchema>;
export type PriceMethod = z.infer<typeof PriceMethodSchema>;
export type CandleInterval = z.infer<typeof CandleIntervalSchema>;
export type CandleMethod = z.infer<typeof CandleMethodSchema>;
export type MarketRegistryEntry = z.infer<typeof MarketRegistryEntrySchema>;
export type MarketDatum = z.infer<typeof MarketDatumSchema>;
export type Candle = z.infer<typeof CandleSchema>;
export type OrderbookLevel = z.infer<typeof OrderbookLevelSchema>;
export type OrderbookSnapshot = z.infer<typeof OrderbookSnapshotSchema>;
