import {
  CanonicalObjectRefSchema,
  MarketDatasetIndexEntrySchema,
  MarketDatasetManifestSchema,
  type MarketDataAcquisitionMethod,
  type MarketDataRecordFamily,
  type MarketDatasetIndexEntry,
  type MarketDatasetManifest
} from "@openstrat/domain";
import type { ObjectStore, PutObjectOptions } from "@openstrat/persistence";

export interface MarketDataObjectRefInput {
  source: string;
  family: string;
  parts: readonly string[];
}

export interface MarketDatasetRefInput {
  source: string;
  canonical_symbol: string;
  received_at: string;
}

export interface MarketDatasetIndexRefInput {
  source: string;
  venue: string;
  canonical_symbol: string;
}

export interface MarketDatasetIndexQuery extends MarketDatasetIndexRefInput {
  start_at?: string;
  end_at?: string;
  families?: readonly MarketDataRecordFamily[];
}

export interface MarketDatasetValidationOptions {
  as_of?: string;
  canonical_symbol?: string;
  source?: string;
  venue?: string;
  required_families?: readonly MarketDataRecordFamily[];
  require_object_refs?: boolean;
}

export interface MarketDatasetValidationResult {
  dataset_ref: string;
  canonical_symbol: string;
  source: string;
  venue: string;
  families: readonly MarketDataRecordFamily[];
  freshness: MarketDatasetManifest["freshness"];
  valid: boolean;
  missing_requirements: string[];
}

export function rawMarketDataObjectRef(input: MarketDataObjectRefInput): string {
  return marketDataObjectRef("raw", input);
}

export function normalizedMarketDataObjectRef(input: MarketDataObjectRefInput): string {
  return marketDataObjectRef("normalized", input);
}

export function marketDatasetManifestRef(input: MarketDatasetRefInput): string {
  return CanonicalObjectRefSchema.parse(
    [
      "datasets",
      safePathSegment(input.source),
      safePathSegment(input.canonical_symbol),
      `${slugTimestamp(input.received_at)}.json`
    ].join("/")
  );
}

export function marketDatasetIndexRef(input: MarketDatasetIndexRefInput): string {
  return CanonicalObjectRefSchema.parse(
    [
      "indexes",
      "market-datasets",
      safePathSegment(input.source),
      safePathSegment(input.venue),
      `${safePathSegment(input.canonical_symbol)}.json`
    ].join("/")
  );
}

export function putMarketDatasetManifest(
  store: ObjectStore,
  manifestInput: MarketDatasetManifest,
  options?: PutObjectOptions
): MarketDatasetManifest {
  const manifest = MarketDatasetManifestSchema.parse(manifestInput);
  store.putJson(manifest.dataset_ref, manifest, options);
  return manifest;
}

export function getMarketDatasetManifest(
  store: ObjectStore,
  datasetRef: string
): MarketDatasetManifest {
  return MarketDatasetManifestSchema.parse(store.getJson(datasetRef));
}

export function marketDatasetIndexEntryFromManifest(
  manifestInput: MarketDatasetManifest
): MarketDatasetIndexEntry {
  const manifest = MarketDatasetManifestSchema.parse(manifestInput);
  return MarketDatasetIndexEntrySchema.parse({
    dataset_ref: manifest.dataset_ref,
    canonical_symbol: manifest.canonical_symbol,
    source: manifest.source,
    venue: manifest.venue,
    created_at: manifest.created_at,
    start_at: manifest.time_range.start_at,
    end_at: manifest.time_range.end_at,
    acquisition_method: manifest.acquisition.method as MarketDataAcquisitionMethod,
    families: manifest.coverage.families,
    freshness: manifest.freshness
  });
}

export function writeMarketDatasetIndexEntry(
  store: ObjectStore,
  entryInput: MarketDatasetIndexEntry
): MarketDatasetIndexEntry {
  const entry = MarketDatasetIndexEntrySchema.parse(entryInput);
  const ref = marketDatasetIndexRef(entry);
  const existing = readIndexEntries(store, ref);
  const next = [
    ...existing.filter((candidate) => candidate.dataset_ref !== entry.dataset_ref),
    entry
  ].sort(compareDatasetIndexEntries);
  store.putJson(ref, next, { overwrite: store.exists(ref) });
  return entry;
}

export function writeMarketDatasetManifestAndIndex(
  store: ObjectStore,
  manifestInput: MarketDatasetManifest
): MarketDatasetIndexEntry {
  const manifest = putMarketDatasetManifest(store, manifestInput);
  return writeMarketDatasetIndexEntry(
    store,
    marketDatasetIndexEntryFromManifest(manifest)
  );
}

export function listMarketDatasetIndexEntries(
  store: ObjectStore,
  query: MarketDatasetIndexQuery
): MarketDatasetIndexEntry[] {
  const ref = marketDatasetIndexRef(query);
  return readIndexEntries(store, ref).filter((entry) =>
    matchesMarketDatasetIndexQuery(entry, query)
  );
}

export function validateMarketDataset(
  store: ObjectStore,
  datasetRef: string,
  options: MarketDatasetValidationOptions = {}
): MarketDatasetValidationResult {
  const manifest = getMarketDatasetManifest(store, datasetRef);
  const missingRequirements: string[] = [];
  const requiredFamilies = options.required_families ?? [];
  const requireObjectRefs = options.require_object_refs ?? true;

  if (
    options.canonical_symbol &&
    manifest.canonical_symbol !== options.canonical_symbol
  ) {
    missingRequirements.push(
      `canonical_symbol mismatch: expected ${options.canonical_symbol}, got ${manifest.canonical_symbol}`
    );
  }
  if (options.source && manifest.source !== options.source) {
    missingRequirements.push(
      `source mismatch: expected ${options.source}, got ${manifest.source}`
    );
  }
  if (options.venue && manifest.venue !== options.venue) {
    missingRequirements.push(
      `venue mismatch: expected ${options.venue}, got ${manifest.venue}`
    );
  }

  for (const family of requiredFamilies) {
    if (!manifest.coverage.families.includes(family)) {
      missingRequirements.push(`missing family: ${family}`);
    }
  }

  if (options.as_of && isMarketDatasetStale(manifest, options.as_of)) {
    missingRequirements.push(
      `freshness stale: as_of ${manifest.freshness.as_of} + ${manifest.freshness.stale_after_ms}ms is before ${options.as_of}`
    );
  }
  if (
    options.as_of &&
    manifest.freshness.expires_at &&
    Date.parse(manifest.freshness.expires_at) < Date.parse(options.as_of)
  ) {
    missingRequirements.push(
      `freshness expired: expires_at ${manifest.freshness.expires_at} is before ${options.as_of}`
    );
  }

  if (requireObjectRefs) {
    for (const rawRef of manifest.raw_refs) {
      if (!store.exists(rawRef.ref)) {
        missingRequirements.push(`missing raw object: ${rawRef.ref}`);
      }
    }
    for (const normalizedRef of manifest.normalized_refs) {
      if (!store.exists(normalizedRef.ref)) {
        missingRequirements.push(`missing normalized object: ${normalizedRef.ref}`);
      }
    }
  }

  return {
    dataset_ref: manifest.dataset_ref,
    canonical_symbol: manifest.canonical_symbol,
    source: manifest.source,
    venue: manifest.venue,
    families: manifest.coverage.families,
    freshness: manifest.freshness,
    valid: missingRequirements.length === 0,
    missing_requirements: missingRequirements
  };
}

function marketDataObjectRef(
  prefix: "normalized" | "raw",
  input: MarketDataObjectRefInput
): string {
  return CanonicalObjectRefSchema.parse(
    [
      prefix,
      safePathSegment(input.source),
      safePathSegment(input.family),
      ...input.parts.map(safePathSegment)
    ].join("/") + ".json"
  );
}

function readIndexEntries(store: ObjectStore, ref: string): MarketDatasetIndexEntry[] {
  if (!store.exists(ref)) {
    return [];
  }
  const parsed = MarketDatasetIndexEntrySchema.array().parse(store.getJson(ref));
  return [...parsed].sort(compareDatasetIndexEntries);
}

function matchesMarketDatasetIndexQuery(
  entry: MarketDatasetIndexEntry,
  query: MarketDatasetIndexQuery
): boolean {
  if (query.start_at && query.end_at) {
    if (
      !timeRangesOverlap(entry, {
        start_at: query.start_at,
        end_at: query.end_at
      })
    ) {
      return false;
    }
  }
  if (
    query.families &&
    !query.families.every((family) => entry.families.includes(family))
  ) {
    return false;
  }
  return true;
}

function isMarketDatasetStale(manifest: MarketDatasetManifest, asOf: string): boolean {
  const staleAt =
    Date.parse(manifest.freshness.as_of) + manifest.freshness.stale_after_ms;
  return staleAt < Date.parse(asOf);
}

function timeRangesOverlap(
  entry: MarketDatasetIndexEntry,
  query: Required<Pick<MarketDatasetIndexQuery, "end_at" | "start_at">>
): boolean {
  return (
    Date.parse(entry.start_at) < Date.parse(query.end_at) &&
    Date.parse(entry.end_at) > Date.parse(query.start_at)
  );
}

function compareDatasetIndexEntries(
  left: MarketDatasetIndexEntry,
  right: MarketDatasetIndexEntry
): number {
  return (
    left.start_at.localeCompare(right.start_at) ||
    left.end_at.localeCompare(right.end_at) ||
    left.dataset_ref.localeCompare(right.dataset_ref)
  );
}

function safePathSegment(value: string): string {
  const segment = value.trim().replace(/[^a-zA-Z0-9._:-]+/g, "_");
  if (segment.length === 0 || segment === "." || segment === "..") {
    throw new Error(`Invalid market data ref segment: ${value}`);
  }
  return segment;
}

function slugTimestamp(value: string): string {
  return value.replaceAll(":", "-");
}
