import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileObjectStore } from "@openstrat/persistence";
import {
  CandleSchema,
  FundingRateSnapshotSchema,
  MarketDatasetManifestSchema,
  MarketDatumSchema,
  MarketRegistryEntrySchema,
  OrderbookSnapshotSchema
} from "@openstrat/domain";
import {
  HyperliquidInfoClient,
  deriveHyperliquidMarketRegistry,
  hyperliquidVenueCapability,
  ingestHyperliquidWindow,
  normalizeHyperliquidCandleSnapshot,
  normalizeHyperliquidFundingHistory,
  normalizeHyperliquidL2Book,
  normalizeHyperliquidMetaAndAssetCtxs
} from "./index.js";
import { validateMarketDataset } from "../datasets.js";

const receivedAt = "2026-06-04T00:00:00.000Z";

function readFixture<T>(name: string): T {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")
  ) as T;
}

describe("Hyperliquid read-only adapter", () => {
  it("declares public-ledger venue capabilities without write actions", () => {
    const capability = hyperliquidVenueCapability();

    expect(capability).toMatchObject({
      source: "hyperliquid",
      venue: "hyperliquid",
      source_kind: "public_ledger",
      public_ledger: true,
      replayable: true
    });
    expect(capability.acquisition_methods).toEqual(
      expect.arrayContaining(["fixture", "guarded_live", "historical_backfill"])
    );
    expect(capability.record_families).toEqual(
      expect.arrayContaining([
        "market_registry",
        "mark_prices",
        "candles",
        "funding_rates",
        "orderbook_snapshots"
      ])
    );
  });

  it("posts only info endpoint read requests with typed request wrappers", async () => {
    const calls: unknown[] = [];
    const client = new HyperliquidInfoClient({
      endpoint: "https://example.invalid/info",
      fetch: async (_url, init) => {
        calls.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify(readFixture("meta-and-asset-ctxs.json")), {
          headers: { "content-type": "application/json" },
          status: 200
        });
      }
    });

    await client.metaAndAssetCtxs();

    expect(calls).toEqual([{ type: "metaAndAssetCtxs" }]);
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(client))).not.toEqual(
      expect.arrayContaining(["exchange", "order", "cancel", "withdraw"])
    );
  });

  it("normalizes metaAndAssetCtxs into registry entries and provenance-aware market data", () => {
    const response = readFixture("meta-and-asset-ctxs.json");

    const normalized = normalizeHyperliquidMetaAndAssetCtxs(response, {
      received_at: receivedAt,
      raw_ref: "raw/hyperliquid/meta-and-asset-ctxs.json"
    });

    expect(normalized.registry.map((entry) => entry.status)).toEqual([
      "active",
      "delisted",
      "low_liquidity",
      "inactive"
    ]);
    expect(normalized.registry[0]).toMatchObject({
      canonical_symbol: "BTC-PERP",
      display_symbol: "BTC",
      venue_symbol: "BTC",
      venue: "hyperliquid",
      source: "hyperliquid",
      asset_class: "crypto",
      quote_token: "USDC",
      collateral_token: "USDC",
      max_leverage: 50,
      metadata: {
        hyperliquid_asset_id: 0,
        sz_decimals: 5
      }
    });
    expect(
      normalized.registry.every(
        (entry) => MarketRegistryEntrySchema.safeParse(entry).success
      )
    ).toBe(true);
    expect(normalized.mark_prices[0]).toMatchObject({
      value: 113377,
      source: "hyperliquid",
      venue: "hyperliquid",
      symbol: "BTC",
      canonical_symbol: "BTC-PERP",
      method: "mark",
      raw_ref: "raw/hyperliquid/meta-and-asset-ctxs.json"
    });
    expect(
      normalized.mark_prices.every(
        (datum) => MarketDatumSchema.safeParse(datum).success
      )
    ).toBe(true);
  });

  it("normalizes l2Book, candleSnapshot, and fundingHistory into harness contracts", () => {
    const orderbook = normalizeHyperliquidL2Book(readFixture("l2-book-btc.json"), {
      received_at: receivedAt,
      raw_ref: "raw/hyperliquid/l2-book-btc.json"
    });
    const candles = normalizeHyperliquidCandleSnapshot(
      readFixture("candles-btc-15m.json"),
      {
        received_at: receivedAt,
        raw_ref: "raw/hyperliquid/candles-btc-15m.json"
      }
    );
    const funding = normalizeHyperliquidFundingHistory(
      readFixture("funding-btc.json"),
      {
        received_at: receivedAt,
        raw_ref: "raw/hyperliquid/funding-btc.json"
      }
    );

    expect(OrderbookSnapshotSchema.safeParse(orderbook).success).toBe(true);
    expect(orderbook.canonical_symbol).toBe("BTC-PERP");
    expect(orderbook.depth).toBe(2);
    expect(orderbook.bids[0]).toEqual({
      price: 113377,
      size: 7.6699,
      order_count: 17
    });
    expect(orderbook.asks[0]).toEqual({
      price: 113397,
      size: 0.11543,
      order_count: 3
    });
    expect(candles).toHaveLength(2);
    expect(candles.every((candle) => CandleSchema.safeParse(candle).success)).toBe(
      true
    );
    expect(candles[0]).toMatchObject({
      canonical_symbol: "BTC-PERP",
      interval: "15m",
      open: 29295,
      high: 29309,
      low: 29250,
      close: 29258,
      volume: 0.98639
    });
    expect(funding).toHaveLength(2);
    expect(
      funding.every((item) => FundingRateSnapshotSchema.safeParse(item).success)
    ).toBe(true);
    expect(funding[1]).toMatchObject({
      canonical_symbol: "BTC-PERP",
      funding_rate: -0.000003,
      premium: -0.00002
    });
  });
});

describe("Hyperliquid registry and historical ingest", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "openstrat-hl-ingest-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("derives canonical registry entries from Hyperliquid metadata", () => {
    const registry = deriveHyperliquidMarketRegistry(
      readFixture("meta-and-asset-ctxs.json"),
      {
        received_at: receivedAt,
        raw_ref: "raw/hyperliquid/meta.json",
        low_liquidity_notional_usd: 100_000
      }
    );

    expect(registry.map((entry) => [entry.canonical_symbol, entry.status])).toEqual([
      ["BTC-PERP", "active"],
      ["LOOM-PERP", "delisted"],
      ["TINY-PERP", "low_liquidity"],
      ["ZERO-PERP", "inactive"]
    ]);
  });

  it("ingests a bounded symbol window and stores raw plus normalized source refs", async () => {
    const store = new FileObjectStore(tempDir);
    const client = {
      metaAndAssetCtxs: async () => readFixture("meta-and-asset-ctxs.json"),
      l2Book: async () => readFixture("l2-book-btc.json"),
      candleSnapshot: async () => readFixture("candles-btc-15m.json"),
      fundingHistory: async () => readFixture("funding-btc.json")
    };

    const result = await ingestHyperliquidWindow({
      client,
      object_store: store,
      coin: "BTC",
      interval: "15m",
      start_time_ms: 1681923600000,
      end_time_ms: 1681927200000,
      received_at: receivedAt
    });

    expect(result.registry_ref).toBe(
      "normalized/hyperliquid/registry/2026-06-04T00-00-00.000Z.json"
    );
    expect(result.dataset_ref).toBe(
      "datasets/hyperliquid/BTC-PERP/2026-06-04T00-00-00.000Z.json"
    );
    expect(result.latest_price_ref).toBe(
      "normalized/hyperliquid/mark-prices/BTC-PERP/2026-06-04T00-00-00.000Z.json"
    );
    expect(result.candle_refs).toHaveLength(1);
    expect(result.funding_refs).toHaveLength(1);
    expect(result.orderbook_refs).toHaveLength(1);
    expect(result.price_refs).toEqual([result.latest_price_ref]);
    expect(store.exists(result.raw_refs.meta_and_asset_ctxs)).toBe(true);
    expect(store.exists(result.raw_refs.candles)).toBe(true);
    expect(store.exists(result.dataset_ref)).toBe(true);
    expect(store.exists(result.latest_price_ref)).toBe(true);
    expect(MarketDatasetManifestSchema.safeParse(result.dataset_manifest).success).toBe(
      true
    );
    expect(result.dataset_manifest.source_provenance).toMatchObject({
      source_kind: "public_ledger",
      public_ledger: true,
      replayable: true
    });
    expect(store.getJson(result.candle_refs[0])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          canonical_symbol: "BTC-PERP",
          raw_ref: result.raw_refs.candles
        })
      ])
    );
    expect(store.getJson(result.latest_price_ref)).toMatchObject({
      canonical_symbol: "BTC-PERP",
      method: "mark",
      raw_ref: result.raw_refs.meta_and_asset_ctxs
    });
    expect(
      store.getJson("indexes/market-datasets/hyperliquid/hyperliquid/BTC-PERP.json")
    ).toEqual([
      expect.objectContaining({
        dataset_ref: result.dataset_ref,
        canonical_symbol: "BTC-PERP",
        acquisition_method: "fixture"
      })
    ]);
    expect(
      validateMarketDataset(store, result.dataset_ref, {
        as_of: "2026-06-04T00:00:04.000Z",
        canonical_symbol: "BTC-PERP",
        source: "hyperliquid",
        venue: "hyperliquid",
        required_families: [
          "market_registry",
          "mark_prices",
          "candles",
          "funding_rates",
          "orderbook_snapshots"
        ]
      })
    ).toMatchObject({
      valid: true,
      missing_requirements: [],
      families: [
        "market_registry",
        "mark_prices",
        "candles",
        "funding_rates",
        "orderbook_snapshots"
      ]
    });
  });
});
