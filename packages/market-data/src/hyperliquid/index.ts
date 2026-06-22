import { z } from "zod";
import type {
  Candle,
  CandleInterval,
  FundingRateSnapshot,
  MarketDatum,
  MarketRegistryEntry,
  OrderbookSnapshot
} from "@openstrat/domain";
import {
  CandleSchema,
  FundingRateSnapshotSchema,
  MarketDatumSchema,
  MarketRegistryEntrySchema,
  OrderbookSnapshotSchema
} from "@openstrat/domain";
import type { ObjectStore } from "@openstrat/persistence";

export const HYPERLIQUID_INFO_ENDPOINT = "https://api.hyperliquid.xyz/info";
const SOURCE = "hyperliquid";
const VENUE = "hyperliquid";
const DEFAULT_STALE_AFTER_MS = 5_000;
const DEFAULT_LOW_LIQUIDITY_NOTIONAL_USD = 100_000;

const DecimalStringSchema = z.string().regex(/^-?[0-9]+(\.[0-9]+)?$/);
const NonNegativeDecimalStringSchema = z.string().regex(/^[0-9]+(\.[0-9]+)?$/);

export const HyperliquidCandleIntervalSchema = z.enum([
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

export const HyperliquidMetaAndAssetCtxsRequestSchema = z.object({
  type: z.literal("metaAndAssetCtxs"),
  dex: z.string().optional()
});

export const HyperliquidL2BookRequestSchema = z.object({
  type: z.literal("l2Book"),
  coin: z.string().min(1),
  nSigFigs: z
    .union([z.literal(2), z.literal(3), z.literal(4), z.literal(5), z.null()])
    .optional(),
  mantissa: z.union([z.literal(1), z.literal(2), z.literal(5), z.null()]).optional()
});

export const HyperliquidCandleSnapshotRequestSchema = z.object({
  type: z.literal("candleSnapshot"),
  req: z.object({
    coin: z.string().min(1),
    interval: HyperliquidCandleIntervalSchema,
    startTime: z.number().int().min(0),
    endTime: z.number().int().min(0).optional()
  })
});

export const HyperliquidFundingHistoryRequestSchema = z.object({
  type: z.literal("fundingHistory"),
  coin: z.string().min(1),
  startTime: z.number().int().min(0),
  endTime: z.number().int().min(0).optional()
});

export const HyperliquidUniverseAssetSchema = z
  .object({
    name: z.string().min(1),
    szDecimals: z.number().int().min(0),
    maxLeverage: z.number().positive(),
    marginTableId: z.number().int().optional(),
    onlyIsolated: z.literal(true).optional(),
    isDelisted: z.literal(true).optional(),
    marginMode: z.enum(["strictIsolated", "noCross"]).optional(),
    growthMode: z.literal("enabled").optional(),
    lastGrowthModeChangeTime: z.string().optional()
  })
  .passthrough();

export const HyperliquidAssetCtxSchema = z
  .object({
    prevDayPx: NonNegativeDecimalStringSchema,
    dayNtlVlm: NonNegativeDecimalStringSchema,
    markPx: NonNegativeDecimalStringSchema,
    midPx: NonNegativeDecimalStringSchema.nullable(),
    funding: DecimalStringSchema,
    openInterest: NonNegativeDecimalStringSchema,
    premium: DecimalStringSchema.nullable(),
    oraclePx: NonNegativeDecimalStringSchema,
    impactPxs: z.array(NonNegativeDecimalStringSchema).nullable(),
    dayBaseVlm: NonNegativeDecimalStringSchema.optional()
  })
  .passthrough();

export const HyperliquidMetaResponseSchema = z
  .object({
    universe: z.array(HyperliquidUniverseAssetSchema),
    marginTables: z.array(z.tuple([z.number(), z.unknown()])),
    collateralToken: z.number().optional()
  })
  .passthrough();

export const HyperliquidMetaAndAssetCtxsResponseSchema = z.tuple([
  HyperliquidMetaResponseSchema,
  z.array(HyperliquidAssetCtxSchema)
]);

export const HyperliquidL2BookLevelSchema = z.object({
  px: NonNegativeDecimalStringSchema,
  sz: NonNegativeDecimalStringSchema,
  n: z.number().int().min(0)
});

export const HyperliquidL2BookResponseSchema = z
  .object({
    coin: z.string().min(1),
    time: z.number().int().min(0),
    levels: z.tuple([
      z.array(HyperliquidL2BookLevelSchema),
      z.array(HyperliquidL2BookLevelSchema)
    ]),
    spread: NonNegativeDecimalStringSchema.optional()
  })
  .nullable();

export const HyperliquidCandleSchema = z.object({
  t: z.number().int().min(0),
  T: z.number().int().min(0),
  s: z.string().min(1),
  i: HyperliquidCandleIntervalSchema,
  o: NonNegativeDecimalStringSchema,
  c: NonNegativeDecimalStringSchema,
  h: NonNegativeDecimalStringSchema,
  l: NonNegativeDecimalStringSchema,
  v: NonNegativeDecimalStringSchema,
  n: z.number().int().min(0)
});

export const HyperliquidCandleSnapshotResponseSchema = z.array(HyperliquidCandleSchema);

export const HyperliquidFundingHistoryItemSchema = z.object({
  coin: z.string().min(1),
  fundingRate: DecimalStringSchema,
  premium: DecimalStringSchema,
  time: z.number().int().min(0)
});

export const HyperliquidFundingHistoryResponseSchema = z.array(
  HyperliquidFundingHistoryItemSchema
);

export type HyperliquidMetaAndAssetCtxsRequest = z.infer<
  typeof HyperliquidMetaAndAssetCtxsRequestSchema
>;
export type HyperliquidL2BookRequest = z.infer<typeof HyperliquidL2BookRequestSchema>;
export type HyperliquidCandleSnapshotRequest = z.infer<
  typeof HyperliquidCandleSnapshotRequestSchema
>;
export type HyperliquidFundingHistoryRequest = z.infer<
  typeof HyperliquidFundingHistoryRequestSchema
>;
export type HyperliquidMetaAndAssetCtxsResponse = z.infer<
  typeof HyperliquidMetaAndAssetCtxsResponseSchema
>;
export type HyperliquidL2BookResponse = z.infer<typeof HyperliquidL2BookResponseSchema>;
export type HyperliquidCandleSnapshotResponse = z.infer<
  typeof HyperliquidCandleSnapshotResponseSchema
>;
export type HyperliquidFundingHistoryResponse = z.infer<
  typeof HyperliquidFundingHistoryResponseSchema
>;

export interface HyperliquidInfoClientOptions {
  endpoint?: string;
  fetch?: typeof fetch;
}

export interface ProvenanceOptions {
  received_at: string;
  raw_ref: string;
}

export interface RegistryDerivationOptions extends ProvenanceOptions {
  low_liquidity_notional_usd?: number;
}

export interface NormalizedMetaAndAssetCtxs {
  registry: MarketRegistryEntry[];
  mark_prices: MarketDatum[];
  mid_prices: MarketDatum[];
  oracle_prices: MarketDatum[];
  funding_rates: FundingRateSnapshot[];
}

export interface HyperliquidReadClient {
  metaAndAssetCtxs(dex?: string): Promise<HyperliquidMetaAndAssetCtxsResponse>;
  l2Book(
    request: Omit<HyperliquidL2BookRequest, "type">
  ): Promise<HyperliquidL2BookResponse>;
  candleSnapshot(
    request: HyperliquidCandleSnapshotRequest["req"]
  ): Promise<HyperliquidCandleSnapshotResponse>;
  fundingHistory(
    request: Omit<HyperliquidFundingHistoryRequest, "type">
  ): Promise<HyperliquidFundingHistoryResponse>;
}

export class HyperliquidInfoClient implements HyperliquidReadClient {
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HyperliquidInfoClientOptions = {}) {
    this.endpoint = options.endpoint ?? HYPERLIQUID_INFO_ENDPOINT;
    this.fetchImpl = options.fetch ?? fetch;
  }

  async metaAndAssetCtxs(dex?: string): Promise<HyperliquidMetaAndAssetCtxsResponse> {
    const request = HyperliquidMetaAndAssetCtxsRequestSchema.parse(
      dex === undefined
        ? { type: "metaAndAssetCtxs" }
        : { type: "metaAndAssetCtxs", dex }
    );
    const response = await this.postInfo(request);
    return HyperliquidMetaAndAssetCtxsResponseSchema.parse(response);
  }

  async l2Book(
    request: Omit<HyperliquidL2BookRequest, "type">
  ): Promise<HyperliquidL2BookResponse> {
    const body = HyperliquidL2BookRequestSchema.parse({ type: "l2Book", ...request });
    const response = await this.postInfo(body);
    return HyperliquidL2BookResponseSchema.parse(response);
  }

  async candleSnapshot(
    request: HyperliquidCandleSnapshotRequest["req"]
  ): Promise<HyperliquidCandleSnapshotResponse> {
    const body = HyperliquidCandleSnapshotRequestSchema.parse({
      type: "candleSnapshot",
      req: request
    });
    const response = await this.postInfo(body);
    return HyperliquidCandleSnapshotResponseSchema.parse(response);
  }

  async fundingHistory(
    request: Omit<HyperliquidFundingHistoryRequest, "type">
  ): Promise<HyperliquidFundingHistoryResponse> {
    const body = HyperliquidFundingHistoryRequestSchema.parse({
      type: "fundingHistory",
      ...request
    });
    const response = await this.postInfo(body);
    return HyperliquidFundingHistoryResponseSchema.parse(response);
  }

  private async postInfo(body: unknown): Promise<unknown> {
    const response = await this.fetchImpl(this.endpoint, {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
      method: "POST"
    });

    if (!response.ok) {
      throw new Error(`Hyperliquid info request failed: ${response.status}`);
    }

    return response.json();
  }
}

export function normalizeHyperliquidMetaAndAssetCtxs(
  response: unknown,
  options: RegistryDerivationOptions
): NormalizedMetaAndAssetCtxs {
  const parsed = HyperliquidMetaAndAssetCtxsResponseSchema.parse(response);
  const registry = deriveHyperliquidMarketRegistry(parsed, options);
  const [, assetCtxs] = parsed;

  const markPrices: MarketDatum[] = [];
  const midPrices: MarketDatum[] = [];
  const oraclePrices: MarketDatum[] = [];
  const fundingRates: FundingRateSnapshot[] = [];

  for (let index = 0; index < registry.length; index += 1) {
    const entry = registry[index];
    const assetCtx = assetCtxs[index];
    if (!entry || !assetCtx) {
      continue;
    }

    markPrices.push(
      marketDatum({
        canonical_symbol: entry.canonical_symbol,
        method: "mark",
        options,
        symbol: entry.display_symbol,
        timestamp: options.received_at,
        value: numberFromDecimal(assetCtx.markPx)
      })
    );

    if (assetCtx.midPx !== null) {
      midPrices.push(
        marketDatum({
          canonical_symbol: entry.canonical_symbol,
          method: "mid",
          options,
          symbol: entry.display_symbol,
          timestamp: options.received_at,
          value: numberFromDecimal(assetCtx.midPx)
        })
      );
    }

    oraclePrices.push(
      marketDatum({
        canonical_symbol: entry.canonical_symbol,
        method: "oracle",
        options,
        symbol: entry.display_symbol,
        timestamp: options.received_at,
        value: numberFromDecimal(assetCtx.oraclePx)
      })
    );

    fundingRates.push(
      FundingRateSnapshotSchema.parse({
        source: SOURCE,
        venue: VENUE,
        symbol: entry.display_symbol,
        canonical_symbol: entry.canonical_symbol,
        timestamp: options.received_at,
        received_at: options.received_at,
        funding_rate: numberFromDecimal(assetCtx.funding),
        premium:
          assetCtx.premium === null ? undefined : numberFromDecimal(assetCtx.premium),
        raw_ref: options.raw_ref
      })
    );
  }

  return {
    registry,
    mark_prices: markPrices,
    mid_prices: midPrices,
    oracle_prices: oraclePrices,
    funding_rates: fundingRates
  };
}

export function deriveHyperliquidMarketRegistry(
  response: unknown,
  options: RegistryDerivationOptions
): MarketRegistryEntry[] {
  const [meta, assetCtxs] = HyperliquidMetaAndAssetCtxsResponseSchema.parse(response);
  const lowLiquidityThreshold =
    options.low_liquidity_notional_usd ?? DEFAULT_LOW_LIQUIDITY_NOTIONAL_USD;

  return meta.universe.map((asset, index) => {
    const assetCtx = assetCtxs[index];
    const dayNotional = assetCtx ? numberFromDecimal(assetCtx.dayNtlVlm) : 0;
    const openInterest = assetCtx ? numberFromDecimal(assetCtx.openInterest) : 0;
    const status = classifyMarket(
      asset.isDelisted === true,
      dayNotional,
      openInterest,
      lowLiquidityThreshold
    );
    const liquidityScore = liquidityScoreFromNotional(
      dayNotional,
      lowLiquidityThreshold
    );

    return MarketRegistryEntrySchema.parse({
      canonical_symbol: canonicalSymbol(asset.name),
      display_symbol: asset.name,
      venue_symbol: asset.name,
      venue: VENUE,
      source: SOURCE,
      asset_class: "crypto",
      quote_token: "USDC",
      collateral_token: "USDC",
      max_leverage: asset.maxLeverage,
      min_order_size: 10 ** -asset.szDecimals,
      status,
      liquidity_score: liquidityScore,
      last_verified_at: options.received_at,
      source_refs: [options.raw_ref],
      metadata: {
        hyperliquid_asset_id: index,
        margin_table_id: asset.marginTableId,
        margin_mode: asset.marginMode,
        only_isolated: asset.onlyIsolated === true,
        sz_decimals: asset.szDecimals
      }
    });
  });
}

export function normalizeHyperliquidL2Book(
  response: unknown,
  options: ProvenanceOptions
): OrderbookSnapshot {
  const parsed = HyperliquidL2BookResponseSchema.parse(response);
  if (parsed === null) {
    throw new Error("Hyperliquid l2Book returned null for unknown market");
  }

  const snapshot = {
    source: SOURCE,
    venue: VENUE,
    symbol: parsed.coin,
    canonical_symbol: canonicalSymbol(parsed.coin),
    timestamp: new Date(parsed.time).toISOString(),
    received_at: options.received_at,
    depth: Math.max(parsed.levels[0].length, parsed.levels[1].length),
    bids: parsed.levels[0].map((level) => ({
      price: numberFromDecimal(level.px),
      size: numberFromDecimal(level.sz),
      order_count: level.n
    })),
    asks: parsed.levels[1].map((level) => ({
      price: numberFromDecimal(level.px),
      size: numberFromDecimal(level.sz),
      order_count: level.n
    })),
    stale_after_ms: DEFAULT_STALE_AFTER_MS,
    raw_ref: options.raw_ref
  };

  return OrderbookSnapshotSchema.parse(snapshot);
}

export function normalizeHyperliquidCandleSnapshot(
  response: unknown,
  options: ProvenanceOptions
): Candle[] {
  const parsed = HyperliquidCandleSnapshotResponseSchema.parse(response);
  return parsed.map((candle) =>
    CandleSchema.parse({
      symbol: candle.s,
      canonical_symbol: canonicalSymbol(candle.s),
      source: SOURCE,
      venue: VENUE,
      interval: candle.i,
      open_time: new Date(candle.t).toISOString(),
      close_time: new Date(candle.T).toISOString(),
      open: numberFromDecimal(candle.o),
      high: numberFromDecimal(candle.h),
      low: numberFromDecimal(candle.l),
      close: numberFromDecimal(candle.c),
      volume: numberFromDecimal(candle.v),
      method: "venue_ohlcv",
      received_at: options.received_at,
      raw_ref: options.raw_ref
    })
  );
}

export function normalizeHyperliquidFundingHistory(
  response: unknown,
  options: ProvenanceOptions
): FundingRateSnapshot[] {
  const parsed = HyperliquidFundingHistoryResponseSchema.parse(response);
  return parsed.map((item) =>
    FundingRateSnapshotSchema.parse({
      source: SOURCE,
      venue: VENUE,
      symbol: item.coin,
      canonical_symbol: canonicalSymbol(item.coin),
      timestamp: new Date(item.time).toISOString(),
      received_at: options.received_at,
      funding_rate: numberFromDecimal(item.fundingRate),
      premium: numberFromDecimal(item.premium),
      raw_ref: options.raw_ref
    })
  );
}

export interface HyperliquidIngestRequest {
  client: HyperliquidReadClient;
  object_store: ObjectStore;
  coin: string;
  interval: CandleInterval;
  start_time_ms: number;
  end_time_ms: number;
  received_at?: string;
}

export interface HyperliquidIngestResult {
  registry_ref: string;
  candle_refs: string[];
  funding_refs: string[];
  orderbook_refs: string[];
  raw_refs: {
    meta_and_asset_ctxs: string;
    candles: string;
    funding: string;
    l2_book: string;
  };
}

export async function ingestHyperliquidWindow(
  request: HyperliquidIngestRequest
): Promise<HyperliquidIngestResult> {
  const receivedAt = request.received_at ?? new Date().toISOString();
  const timestampSlug = slugTimestamp(receivedAt);
  const windowSlug = `${request.coin}/${request.interval}/${request.start_time_ms}-${request.end_time_ms}`;

  const rawRefs = {
    meta_and_asset_ctxs: `raw/hyperliquid/meta-and-asset-ctxs/${timestampSlug}.json`,
    candles: `raw/hyperliquid/candles/${windowSlug}.json`,
    funding: `raw/hyperliquid/funding/${request.coin}/${request.start_time_ms}-${request.end_time_ms}.json`,
    l2_book: `raw/hyperliquid/l2-book/${request.coin}/${timestampSlug}.json`
  };

  const [metaAndAssetCtxs, candlesRaw, fundingRaw, l2BookRaw] = await Promise.all([
    request.client.metaAndAssetCtxs(),
    request.client.candleSnapshot({
      coin: request.coin,
      interval: request.interval,
      startTime: request.start_time_ms,
      endTime: request.end_time_ms
    }),
    request.client.fundingHistory({
      coin: request.coin,
      startTime: request.start_time_ms,
      endTime: request.end_time_ms
    }),
    request.client.l2Book({ coin: request.coin })
  ]);

  request.object_store.putJson(rawRefs.meta_and_asset_ctxs, metaAndAssetCtxs);
  request.object_store.putJson(rawRefs.candles, candlesRaw);
  request.object_store.putJson(rawRefs.funding, fundingRaw);
  request.object_store.putJson(rawRefs.l2_book, l2BookRaw);

  const registry = deriveHyperliquidMarketRegistry(metaAndAssetCtxs, {
    received_at: receivedAt,
    raw_ref: rawRefs.meta_and_asset_ctxs
  });
  const candles = normalizeHyperliquidCandleSnapshot(candlesRaw, {
    received_at: receivedAt,
    raw_ref: rawRefs.candles
  });
  const funding = normalizeHyperliquidFundingHistory(fundingRaw, {
    received_at: receivedAt,
    raw_ref: rawRefs.funding
  });
  const orderbook = normalizeHyperliquidL2Book(l2BookRaw, {
    received_at: receivedAt,
    raw_ref: rawRefs.l2_book
  });

  const registryRef = `normalized/hyperliquid/registry/${timestampSlug}.json`;
  const candleRef = `normalized/hyperliquid/candles/${windowSlug}.json`;
  const fundingRef = `normalized/hyperliquid/funding/${request.coin}/${request.start_time_ms}-${request.end_time_ms}.json`;
  const orderbookRef = `normalized/hyperliquid/l2-book/${request.coin}/${timestampSlug}.json`;

  request.object_store.putJson(registryRef, registry);
  request.object_store.putJson(candleRef, candles);
  request.object_store.putJson(fundingRef, funding);
  request.object_store.putJson(orderbookRef, orderbook);

  return {
    registry_ref: registryRef,
    candle_refs: [candleRef],
    funding_refs: [fundingRef],
    orderbook_refs: [orderbookRef],
    raw_refs: rawRefs
  };
}

function marketDatum(input: {
  canonical_symbol: string;
  method: "mark" | "mid" | "oracle";
  options: ProvenanceOptions;
  symbol: string;
  timestamp: string;
  value: number;
}): MarketDatum {
  return MarketDatumSchema.parse({
    value: input.value,
    source: SOURCE,
    venue: VENUE,
    symbol: input.symbol,
    canonical_symbol: input.canonical_symbol,
    method: input.method,
    timestamp: input.timestamp,
    received_at: input.options.received_at,
    stale_after_ms: DEFAULT_STALE_AFTER_MS,
    raw_ref: input.options.raw_ref
  });
}

function canonicalSymbol(coin: string): string {
  return `${coin.toUpperCase()}-PERP`;
}

function classifyMarket(
  isDelisted: boolean,
  dayNotional: number,
  openInterest: number,
  lowLiquidityThreshold: number
): MarketRegistryEntry["status"] {
  if (isDelisted) {
    return "delisted";
  }
  if (dayNotional === 0 && openInterest === 0) {
    return "inactive";
  }
  if (dayNotional < lowLiquidityThreshold) {
    return "low_liquidity";
  }
  return "active";
}

function liquidityScoreFromNotional(
  dayNotional: number,
  lowLiquidityThreshold: number
): number {
  if (lowLiquidityThreshold <= 0) {
    return 1;
  }
  return Math.max(0, Math.min(1, dayNotional / lowLiquidityThreshold));
}

function numberFromDecimal(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid decimal value: ${value}`);
  }
  return parsed;
}

function slugTimestamp(value: string): string {
  return value.replaceAll(":", "-");
}
