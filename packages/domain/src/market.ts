import { z } from "zod";
import {
  BasisPointsSchema,
  CanonicalSymbolSchema,
  CanonicalObjectRefSchema,
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
  "low_liquidity",
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
  "3m",
  "5m",
  "15m",
  "30m",
  "1h",
  "2h",
  "4h",
  "8h",
  "12h",
  "1d",
  "3d",
  "1w",
  "1M"
]);

export const CandleMethodSchema = z.enum([
  "venue_ohlcv",
  "aggregated_ohlcv",
  "derived"
]);

export const MarketDataRecordFamilySchema = z.enum([
  "market_registry",
  "mark_prices",
  "index_prices",
  "oracle_prices",
  "candles",
  "funding_rates",
  "orderbook_snapshots",
  "trades",
  "open_interest",
  "liquidations"
]);

export const MarketDataAcquisitionMethodSchema = z.enum([
  "fixture",
  "guarded_live",
  "historical_backfill",
  "replay",
  "manual_import"
]);

export const MarketDataSourceKindSchema = z.enum([
  "public_ledger",
  "public_api",
  "vendor_api",
  "fixture",
  "synthetic"
]);

const RawObjectRefSchema = CanonicalObjectRefSchema.refine(
  (ref) => ref.startsWith("raw/"),
  "raw payload refs must live under raw/"
);

const NormalizedObjectRefSchema = CanonicalObjectRefSchema.refine(
  (ref) => ref.startsWith("normalized/"),
  "normalized market data refs must live under normalized/"
);

const DatasetObjectRefSchema = CanonicalObjectRefSchema.refine(
  (ref) => ref.startsWith("datasets/"),
  "market dataset refs must live under datasets/"
);

export const MarketFreshnessPolicySchema = z
  .object({
    as_of: IsoDateTimeSchema,
    stale_after_ms: z.number().int().min(0),
    expires_at: IsoDateTimeSchema.optional()
  })
  .superRefine((freshness, ctx) => {
    if (
      freshness.expires_at &&
      Date.parse(freshness.expires_at) < Date.parse(freshness.as_of)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "expires_at must be at or after as_of",
        path: ["expires_at"]
      });
    }
  });

export const MarketSourceProvenanceSchema = z
  .object({
    source_kind: MarketDataSourceKindSchema,
    public_ledger: z.boolean(),
    replayable: z.boolean(),
    verification_refs: z.array(SourceRefSchema).default([]),
    notes: NonEmptyStringSchema.optional()
  })
  .superRefine((provenance, ctx) => {
    if (provenance.source_kind === "public_ledger" && !provenance.public_ledger) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "public ledger sources must set public_ledger",
        path: ["public_ledger"]
      });
    }
    if (provenance.public_ledger && !provenance.replayable) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "public ledger sources must be replayable",
        path: ["replayable"]
      });
    }
  });

export const MarketVenueCapabilitySchema = z
  .object({
    source: MarketDataSourceSchema,
    venue: NonEmptyStringSchema,
    source_kind: MarketDataSourceKindSchema,
    public_ledger: z.boolean(),
    replayable: z.boolean(),
    asset_classes: z.array(AssetClassSchema).min(1),
    acquisition_methods: z.array(MarketDataAcquisitionMethodSchema).min(1),
    record_families: z.array(MarketDataRecordFamilySchema).min(1),
    canonical_symbol_examples: z.array(CanonicalSymbolSchema).default([]),
    metadata: JsonRecordSchema.optional()
  })
  .superRefine((capability, ctx) => {
    if (capability.source_kind === "public_ledger" && !capability.public_ledger) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "public ledger venues must set public_ledger",
        path: ["public_ledger"]
      });
    }
    if (capability.public_ledger && !capability.replayable) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "public ledger venues must be replayable",
        path: ["replayable"]
      });
    }
  });

export const MarketRawPayloadKindSchema = z.enum([
  "meta_and_asset_contexts",
  "candles",
  "funding",
  "l2_book",
  "trades",
  "open_interest",
  "liquidations",
  "other"
]);

export const MarketRawPayloadRefSchema = z.object({
  ref: RawObjectRefSchema,
  kind: MarketRawPayloadKindSchema,
  source: MarketDataSourceSchema,
  venue: NonEmptyStringSchema,
  captured_at: IsoDateTimeSchema,
  request: JsonRecordSchema.default({}),
  content_hash: NonEmptyStringSchema.optional(),
  immutable: z.literal(true).default(true)
});

export const NormalizedMarketDataRefSchema = z.object({
  ref: NormalizedObjectRefSchema,
  family: MarketDataRecordFamilySchema,
  canonical_symbol: CanonicalSymbolSchema.optional(),
  source: MarketDataSourceSchema,
  venue: NonEmptyStringSchema,
  created_at: IsoDateTimeSchema,
  raw_refs: z.array(RawObjectRefSchema).min(1),
  content_hash: NonEmptyStringSchema.optional(),
  immutable: z.literal(true).default(true)
});

export const MarketDataAcquisitionSchema = z
  .object({
    method: MarketDataAcquisitionMethodSchema,
    requested_at: IsoDateTimeSchema,
    completed_at: IsoDateTimeSchema.optional(),
    actor: NonEmptyStringSchema.optional(),
    deterministic: z.boolean().default(false),
    request_ref: SourceRefSchema.optional()
  })
  .superRefine((acquisition, ctx) => {
    if (
      acquisition.completed_at &&
      Date.parse(acquisition.completed_at) < Date.parse(acquisition.requested_at)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "completed_at must be at or after requested_at",
        path: ["completed_at"]
      });
    }
  });

export const MarketDatasetCoverageSchema = z.object({
  families: z.array(MarketDataRecordFamilySchema).min(1),
  candle_intervals: z.array(CandleIntervalSchema).default([])
});

export const MarketDatasetManifestSchema = z
  .object({
    dataset_ref: DatasetObjectRefSchema,
    canonical_symbol: CanonicalSymbolSchema,
    source: MarketDataSourceSchema,
    venue: NonEmptyStringSchema,
    asset_class: AssetClassSchema,
    created_at: IsoDateTimeSchema,
    time_range: z.object({
      start_at: IsoDateTimeSchema,
      end_at: IsoDateTimeSchema
    }),
    acquisition: MarketDataAcquisitionSchema,
    source_provenance: MarketSourceProvenanceSchema,
    raw_refs: z.array(MarketRawPayloadRefSchema).min(1),
    normalized_refs: z.array(NormalizedMarketDataRefSchema).min(1),
    freshness: MarketFreshnessPolicySchema,
    coverage: MarketDatasetCoverageSchema,
    append_only: z.literal(true).default(true),
    metadata: JsonRecordSchema.optional()
  })
  .superRefine((manifest, ctx) => {
    if (
      Date.parse(manifest.time_range.end_at) <= Date.parse(manifest.time_range.start_at)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "time_range.end_at must be after time_range.start_at",
        path: ["time_range", "end_at"]
      });
    }

    const rawRefSet = new Set(manifest.raw_refs.map((rawRef) => rawRef.ref));
    for (const [index, rawRef] of manifest.raw_refs.entries()) {
      if (rawRef.source !== manifest.source) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "raw ref source must match dataset source",
          path: ["raw_refs", index, "source"]
        });
      }
      if (rawRef.venue !== manifest.venue) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "raw ref venue must match dataset venue",
          path: ["raw_refs", index, "venue"]
        });
      }
    }

    const normalizedFamilies = new Set(
      manifest.normalized_refs.map((normalizedRef) => normalizedRef.family)
    );
    for (const [index, normalizedRef] of manifest.normalized_refs.entries()) {
      if (
        normalizedRef.canonical_symbol &&
        normalizedRef.canonical_symbol !== manifest.canonical_symbol
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "normalized ref canonical_symbol must match dataset canonical_symbol",
          path: ["normalized_refs", index, "canonical_symbol"]
        });
      }
      if (normalizedRef.source !== manifest.source) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "normalized ref source must match dataset source",
          path: ["normalized_refs", index, "source"]
        });
      }
      if (normalizedRef.venue !== manifest.venue) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "normalized ref venue must match dataset venue",
          path: ["normalized_refs", index, "venue"]
        });
      }
      for (const rawRef of normalizedRef.raw_refs) {
        if (!rawRefSet.has(rawRef)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "normalized raw_refs must point at dataset raw_refs",
            path: ["normalized_refs", index, "raw_refs"]
          });
        }
      }
    }

    for (const [index, family] of manifest.coverage.families.entries()) {
      if (!normalizedFamilies.has(family)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "coverage families must be backed by normalized refs",
          path: ["coverage", "families", index]
        });
      }
    }
  });

export const MarketDatasetIndexEntrySchema = z
  .object({
    dataset_ref: DatasetObjectRefSchema,
    canonical_symbol: CanonicalSymbolSchema,
    source: MarketDataSourceSchema,
    venue: NonEmptyStringSchema,
    created_at: IsoDateTimeSchema,
    start_at: IsoDateTimeSchema,
    end_at: IsoDateTimeSchema,
    acquisition_method: MarketDataAcquisitionMethodSchema,
    families: z.array(MarketDataRecordFamilySchema).min(1),
    freshness: MarketFreshnessPolicySchema
  })
  .superRefine((entry, ctx) => {
    if (Date.parse(entry.end_at) <= Date.parse(entry.start_at)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "end_at must be after start_at",
        path: ["end_at"]
      });
    }
  });

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

export const FundingRateSnapshotSchema = z.object({
  source: MarketDataSourceSchema,
  venue: NonEmptyStringSchema.optional(),
  symbol: NonEmptyStringSchema,
  canonical_symbol: CanonicalSymbolSchema,
  timestamp: IsoDateTimeSchema,
  received_at: IsoDateTimeSchema,
  funding_rate: z.number().finite(),
  premium: z.number().finite().optional(),
  raw_ref: SourceRefSchema.optional()
});

export type MarketStatus = z.infer<typeof MarketStatusSchema>;
export type AssetClass = z.infer<typeof AssetClassSchema>;
export type MarketDataSource = z.infer<typeof MarketDataSourceSchema>;
export type PriceMethod = z.infer<typeof PriceMethodSchema>;
export type CandleInterval = z.infer<typeof CandleIntervalSchema>;
export type CandleMethod = z.infer<typeof CandleMethodSchema>;
export type MarketDataRecordFamily = z.infer<typeof MarketDataRecordFamilySchema>;
export type MarketDataAcquisitionMethod = z.infer<
  typeof MarketDataAcquisitionMethodSchema
>;
export type MarketDataSourceKind = z.infer<typeof MarketDataSourceKindSchema>;
export type MarketFreshnessPolicy = z.infer<typeof MarketFreshnessPolicySchema>;
export type MarketSourceProvenance = z.infer<typeof MarketSourceProvenanceSchema>;
export type MarketVenueCapability = z.infer<typeof MarketVenueCapabilitySchema>;
export type MarketRawPayloadKind = z.infer<typeof MarketRawPayloadKindSchema>;
export type MarketRawPayloadRef = z.infer<typeof MarketRawPayloadRefSchema>;
export type NormalizedMarketDataRef = z.infer<typeof NormalizedMarketDataRefSchema>;
export type MarketDataAcquisition = z.infer<typeof MarketDataAcquisitionSchema>;
export type MarketDatasetCoverage = z.infer<typeof MarketDatasetCoverageSchema>;
export type MarketDatasetManifest = z.infer<typeof MarketDatasetManifestSchema>;
export type MarketDatasetIndexEntry = z.infer<typeof MarketDatasetIndexEntrySchema>;
export type MarketRegistryEntry = z.infer<typeof MarketRegistryEntrySchema>;
export type MarketDatum = z.infer<typeof MarketDatumSchema>;
export type Candle = z.infer<typeof CandleSchema>;
export type OrderbookLevel = z.infer<typeof OrderbookLevelSchema>;
export type OrderbookSnapshot = z.infer<typeof OrderbookSnapshotSchema>;
export type FundingRateSnapshot = z.infer<typeof FundingRateSnapshotSchema>;
