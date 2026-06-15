# Market Data Foundation

OpenStrat treats market data as reproducible dataset artifacts, not as ad hoc API responses. Strategies, backtests, risk gates, CLI commands, and agents should depend on dataset refs with explicit provenance and freshness.

This keeps OpenStrat aligned with its product boundary: Pi and Codex provide the agent/runtime harness, but OpenStrat owns trading state, dataset contracts, provenance, validation, risk, and deployment semantics.

## Storage Model

Market data is split into four object-store roots:

- `raw/`: immutable venue/API payload captures.
- `normalized/`: typed records derived from raw payloads.
- `datasets/`: append-only dataset manifests that bind raw refs, normalized refs, source metadata, coverage, and freshness.
- `indexes/market-datasets/`: lookup indexes for source, venue, canonical symbol, families, and time ranges.

The durable dataset manifest is the unit that downstream work should reference. Raw and normalized objects stay separate so a future validator can replay derivations and compare normalized outputs against original source payloads.

## Dataset Manifest

A market dataset manifest records:

- canonical symbol, source, venue, and asset class
- covered time range
- acquisition method: fixture, guarded live, historical backfill, replay, or manual import
- source provenance, including whether the source is public-ledger and replayable
- raw payload refs
- normalized data refs
- dataset-level freshness
- coverage families such as registry, mark prices, candles, funding, and orderbook snapshots

Manifest refs must live under `datasets/`. Raw payload refs must live under `raw/`. Normalized refs must live under `normalized/`. Proposal and scratch refs are intentionally excluded from canonical dataset storage.

## Hyperliquid

Hyperliquid is represented as a read-only venue capability with public-ledger, replayable provenance. The fixture-first ingest path writes:

- raw `metaAndAssetCtxs`, candle, funding, and L2 book payloads
- normalized market registry entries
- normalized mark prices
- normalized candles
- normalized funding snapshots
- normalized orderbook snapshots
- one dataset manifest
- one dataset index entry

Tests use fixtures only. Live network access remains opt-in and should follow the same manifest/index path before becoming usable by strategies or backtests.

## Public Ledger Implications

Hyperliquid being public-ledger and replayable changes what OpenStrat can verify:

- raw captures can point to publicly inspectable source semantics instead of relying only on a private vendor response
- datasets can declare replayability as a first-class property
- future validators can compare stored normalized records against replayed or re-fetched public source data
- provenance can distinguish public-ledger data from public API, vendor API, fixture, and synthetic sources

This does not remove the need for freshness, completeness, or source-quality checks. A public ledger improves auditability; it does not make every local dataset automatically current or complete.

## Quality Gates

`validateMarketDataset` checks a dataset ref against:

- requested canonical symbol, source, and venue
- required record families
- dataset freshness and expiry
- missing raw objects
- missing normalized objects

Current validation returns deterministic missing-requirement strings. If these become a public API surface, add stable machine-readable codes.

## CLI And Gateway

`openstrat market ingest-fixture/list/snapshot --json` now returns typed `AgentResultEnvelope.result.data` payloads instead of wrapping human output lines. Human output remains available for normal terminal usage.

`AgentToolGateway.market_data.read_snapshot` still returns `market` and `latest_price`, and can now include dataset refs, raw refs, normalized refs, freshness, and source provenance when the reader provides dataset context.

## Why No Time-Series DB Yet

The current requirement is reproducibility and provenance, not high-volume interactive querying. Object-store manifests plus deterministic indexes are enough for:

- fixture ingest
- small historical windows
- backtest inputs
- provenance-aware agent reads
- quality validation

A time-series database becomes justified when OpenStrat needs sustained high-volume ingestion, low-latency range queries across many symbols, retention policies, compaction, joins across datasets, or query workloads that make manifest/index scans measurably insufficient.

Until then, adding a TSDB would increase operational surface area before the core market-data contract is stable.
