import { describe, expect, it } from "vitest";
import {
  MarketDatasetIndexEntrySchema,
  MarketDatasetManifestSchema,
  MarketFreshnessPolicySchema,
  MarketRawPayloadRefSchema,
  MarketVenueCapabilitySchema,
  NormalizedMarketDataRefSchema
} from "./index.js";

const receivedAt = "2026-06-04T00:00:00.000Z";
const startAt = "2023-04-19T17:00:00.000Z";
const endAt = "2023-04-19T18:00:00.000Z";

const rawMeta = {
  ref: "raw/hyperliquid/meta-and-asset-ctxs/2026-06-04T00-00-00.000Z.json",
  kind: "meta_and_asset_contexts",
  source: "hyperliquid",
  venue: "hyperliquid",
  captured_at: receivedAt,
  request: { type: "metaAndAssetCtxs" },
  immutable: true
} as const;

const rawCandles = {
  ref: "raw/hyperliquid/candles/BTC/15m/1681923600000-1681927200000.json",
  kind: "candles",
  source: "hyperliquid",
  venue: "hyperliquid",
  captured_at: receivedAt,
  request: {
    type: "candleSnapshot",
    req: {
      coin: "BTC",
      interval: "15m",
      startTime: 1681923600000,
      endTime: 1681927200000
    }
  },
  immutable: true
} as const;

const normalizedCandles = {
  ref: "normalized/hyperliquid/candles/BTC/15m/1681923600000-1681927200000.json",
  family: "candles",
  canonical_symbol: "BTC-PERP",
  source: "hyperliquid",
  venue: "hyperliquid",
  created_at: receivedAt,
  raw_refs: [rawCandles.ref],
  immutable: true
} as const;

const baseManifest = {
  dataset_ref: "datasets/hyperliquid/BTC-PERP/2026-06-04T00-00-00.000Z.json",
  canonical_symbol: "BTC-PERP",
  source: "hyperliquid",
  venue: "hyperliquid",
  asset_class: "crypto",
  created_at: receivedAt,
  time_range: {
    start_at: startAt,
    end_at: endAt
  },
  acquisition: {
    method: "fixture",
    requested_at: receivedAt,
    completed_at: receivedAt,
    actor: "openstrat-cli",
    deterministic: true
  },
  source_provenance: {
    source_kind: "public_ledger",
    public_ledger: true,
    replayable: true,
    verification_refs: ["https://hyperliquid.gitbook.io/hyperliquid-docs/"]
  },
  raw_refs: [rawMeta, rawCandles],
  normalized_refs: [normalizedCandles],
  freshness: {
    as_of: receivedAt,
    stale_after_ms: 5000
  },
  coverage: {
    families: ["candles"],
    candle_intervals: ["15m"]
  },
  append_only: true
} as const;

describe("market data foundation contracts", () => {
  it("describes venue capabilities including public-ledger provenance", () => {
    const capability = MarketVenueCapabilitySchema.parse({
      source: "hyperliquid",
      venue: "hyperliquid",
      source_kind: "public_ledger",
      public_ledger: true,
      replayable: true,
      asset_classes: ["crypto"],
      acquisition_methods: ["fixture", "guarded_live", "historical_backfill"],
      record_families: [
        "market_registry",
        "mark_prices",
        "candles",
        "funding_rates",
        "orderbook_snapshots"
      ],
      canonical_symbol_examples: ["BTC-PERP"]
    });

    expect(capability.public_ledger).toBe(true);
    expect(
      MarketVenueCapabilitySchema.safeParse({
        ...capability,
        source_kind: "public_ledger",
        public_ledger: false
      }).success
    ).toBe(false);
  });

  it("separates immutable raw payload refs from normalized refs", () => {
    expect(MarketRawPayloadRefSchema.parse(rawMeta).ref).toContain("raw/");
    expect(NormalizedMarketDataRefSchema.parse(normalizedCandles).ref).toContain(
      "normalized/"
    );
    expect(
      MarketRawPayloadRefSchema.safeParse({
        ...rawMeta,
        ref: "normalized/hyperliquid/meta.json"
      }).success
    ).toBe(false);
    expect(
      NormalizedMarketDataRefSchema.safeParse({
        ...normalizedCandles,
        ref: "raw/hyperliquid/candles.json"
      }).success
    ).toBe(false);
    expect(
      MarketRawPayloadRefSchema.safeParse({ ...rawMeta, immutable: false }).success
    ).toBe(false);
  });

  it("validates dataset manifests with raw refs, normalized refs, freshness, and provenance", () => {
    const manifest = MarketDatasetManifestSchema.parse(baseManifest);

    expect(manifest.dataset_ref).toBe(baseManifest.dataset_ref);
    expect(manifest.source_provenance).toMatchObject({
      public_ledger: true,
      replayable: true,
      source_kind: "public_ledger"
    });
    expect(manifest.raw_refs.map((ref) => ref.ref)).toContain(rawMeta.ref);
    expect(manifest.normalized_refs.map((ref) => ref.ref)).toContain(
      normalizedCandles.ref
    );
  });

  it("rejects unsafe, mismatched, stale, and incomplete dataset manifests", () => {
    expect(
      MarketDatasetManifestSchema.safeParse({
        ...baseManifest,
        dataset_ref: "agent-artifacts/BTC-PERP/dataset.json"
      }).success
    ).toBe(false);
    expect(
      MarketDatasetManifestSchema.safeParse({
        ...baseManifest,
        normalized_refs: [
          {
            ...normalizedCandles,
            canonical_symbol: "ETH-PERP"
          }
        ]
      }).success
    ).toBe(false);
    expect(
      MarketDatasetManifestSchema.safeParse({
        ...baseManifest,
        raw_refs: []
      }).success
    ).toBe(false);
    expect(
      MarketDatasetManifestSchema.safeParse({
        ...baseManifest,
        normalized_refs: []
      }).success
    ).toBe(false);
    expect(
      MarketFreshnessPolicySchema.safeParse({
        as_of: receivedAt,
        stale_after_ms: 5000,
        expires_at: "2026-06-03T23:59:59.000Z"
      }).success
    ).toBe(false);
  });

  it("indexes datasets by canonical symbol, source, venue, time range, and families", () => {
    const entry = MarketDatasetIndexEntrySchema.parse({
      dataset_ref: baseManifest.dataset_ref,
      canonical_symbol: "BTC-PERP",
      source: "hyperliquid",
      venue: "hyperliquid",
      created_at: receivedAt,
      start_at: startAt,
      end_at: endAt,
      acquisition_method: "fixture",
      families: ["candles"],
      freshness: {
        as_of: receivedAt,
        stale_after_ms: 5000
      }
    });

    expect(entry).toMatchObject({
      canonical_symbol: "BTC-PERP",
      source: "hyperliquid",
      venue: "hyperliquid",
      acquisition_method: "fixture"
    });
  });
});
