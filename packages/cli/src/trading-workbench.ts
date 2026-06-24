import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runCandleBacktest } from "@openstrat/backtesting";
import {
  BacktestReportSchema,
  CandleSchema,
  RiskReviewSchema,
  StrategyManifestSchema,
  type BacktestReport,
  type Candle,
  type CandleInterval,
  type MarketRegistryEntry,
  type RiskReview,
  type StrategyManifest
} from "@openstrat/domain";
import {
  deriveHyperliquidMarketRegistry,
  HyperliquidInfoClient,
  ingestHyperliquidWindow,
  type HyperliquidMetaAndAssetCtxsResponse,
  type HyperliquidReadClient
} from "@openstrat/market-data";
import { FileObjectStore } from "@openstrat/persistence";
import {
  createStrategyRunner,
  type StrategyMarketEvent,
  type StrategyModule
} from "@openstrat/strategy-sdk";
import { build as esbuildBuild, type Plugin } from "esbuild";
import { z } from "zod";
import { readJsonFile, writeJsonFile, type OpenStratCliHome } from "./home.js";
import { appendArtifactIndexEntry, type ArtifactIndexEntry } from "./session-store.js";

const SUPPORTED_INTERVALS = [
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
] as const satisfies readonly CandleInterval[];

const StrategyModuleSchema = z.object({
  manifest: StrategyManifestSchema,
  evaluate: z.function()
});

export interface DatasetIndexEntry {
  id: string;
  created_at: string;
  updated_at: string;
  source: "hyperliquid" | "synthetic";
  venue: "hyperliquid" | "synthetic";
  status: "planned" | "available" | "failed";
  symbol: string;
  canonical_symbol: string;
  interval: CandleInterval;
  start_at: string;
  end_at: string;
  start_time_ms: number;
  end_time_ms: number;
  registry_ref: string;
  candle_refs: string[];
  funding_refs: string[];
  orderbook_refs: string[];
  raw_refs: string[];
  row_counts: {
    candles: number;
    funding: number;
    orderbooks: number;
  };
  ingest_command: string;
}

export interface MarketIndexEntry extends MarketRegistryEntry {
  dataset_ids: string[];
}

export interface MarketCatalogRefreshResult {
  id: string;
  created_at: string;
  source: "hyperliquid";
  venue: "hyperliquid";
  raw_ref: string;
  registry_ref: string;
  markets: MarketIndexEntry[];
  active_markets: number;
}

export interface DatasetIngestionPlan {
  id: string;
  created_at: string;
  prompt: string;
  source: "hyperliquid";
  venue: "hyperliquid";
  symbol: string;
  canonical_symbol: string;
  intervals: CandleInterval[];
  start_at: string;
  end_at: string;
  start_time_ms: number;
  end_time_ms: number;
  rationale: string[];
  assumptions: string[];
  ingest_commands: string[];
  slash_commands: string[];
  expected_dataset_ids: string[];
}

export interface DatasetValidationResult {
  id: string;
  created_at: string;
  dataset_id: string;
  status: "ok" | "error";
  checks: Array<{
    name: string;
    status: "pass" | "fail";
    message: string;
  }>;
}

export interface DatasetInspectionResult {
  id: string;
  created_at: string;
  dataset_id: string;
  status: "ok" | "error";
  summary: {
    canonical_symbol: string;
    interval: CandleInterval;
    source: DatasetIndexEntry["source"];
    venue: DatasetIndexEntry["venue"];
    start_at: string;
    end_at: string;
    candle_count: number;
    funding_count: number;
    orderbook_count: number;
    first_candle_at?: string;
    last_candle_at?: string;
  };
  refs: {
    registry_ref: string;
    candle_refs: string[];
    funding_refs: string[];
    orderbook_refs: string[];
    raw_refs: string[];
  };
  validation: {
    status: "ok" | "error";
    missing_refs: string[];
    interval_mismatches: string[];
    candle_refs: Array<{
      ref: string;
      count: number;
    }>;
  };
}

export interface StrategyAuthoringGuide {
  id: string;
  created_at: string;
  strategy_file: string;
  dataset_id?: string;
  checklist: string[];
  forbidden: string[];
  template: string;
  validate_command: string;
  next_commands: string[];
}

export interface StrategyValidationResult {
  id: string;
  created_at: string;
  strategy_file: string;
  status: "ok" | "error";
  manifest?: StrategyManifest;
  issues: string[];
  warnings: string[];
  checks: Array<{
    name: string;
    status: "pass" | "warn" | "fail";
    message: string;
  }>;
}

export interface BacktestPlan {
  id: string;
  created_at: string;
  run_id: string;
  strategy_file: string;
  dataset_id: string;
  dataset_ref: string;
  candle_refs: string[];
  raw_artifact_refs: string[];
  initial_equity_usd: number;
  fee_bps: number;
  slippage_bps: number;
  command: string;
  slash_command: string;
}

export interface BacktestIndexEntry {
  id: string;
  created_at: string;
  run_id: string;
  strategy_id: string;
  strategy_version: string;
  strategy_file: string;
  dataset_id: string;
  report_ref: string;
  trade_ledger_ref: string;
  dataset_ref: string;
  artifact_refs: string[];
  config: {
    initial_equity_usd: number;
    fee_bps: number;
    slippage_bps: number;
  };
  metrics: BacktestReport["metrics"];
  warnings: string[];
  next_actions: string[];
  status: "passed" | "failed" | "error";
}

export interface RiskPreflightResult {
  id: string;
  created_at: string;
  strategy_file: string;
  dataset_id: string;
  backtest_run_id?: string;
  review_ref: string;
  review: RiskReview;
}

interface RiskPreflightPolicyInput {
  maxNotionalUsd?: number | undefined;
  maxDrawdownPct?: number | undefined;
  minTrades?: number | undefined;
  minWinRate?: number | undefined;
  policyRef?: string | undefined;
}

interface IndexFile<T> {
  version: 1;
  entries: T[];
}

interface IngestDatasetInput {
  symbol: string;
  interval: CandleInterval;
  start: string;
  end: string;
  fixture?: boolean;
  live?: boolean;
  endpoint?: string | undefined;
  sessionId?: string;
}

interface CommandArgs {
  [key: string]: string | boolean | undefined;
}

export function planDatasetIngestion(input: {
  prompt?: string | undefined;
  symbol?: string | undefined;
  intervals?: string[] | undefined;
  start?: string | undefined;
  end?: string | undefined;
  now?: string | undefined;
  sessionId?: string | undefined;
  home?: OpenStratCliHome | undefined;
}): DatasetIngestionPlan {
  const prompt = input.prompt ?? "";
  const now = input.now ?? new Date().toISOString();
  const end = input.end ?? now;
  const start =
    input.start ??
    new Date(Date.parse(end) - inferLookbackDays(prompt) * 86_400_000).toISOString();
  const symbol = normalizeCoin(input.symbol ?? inferSymbol(prompt));
  const intervals = normalizeIntervals(input.intervals ?? inferIntervals(prompt));
  const startTimeMs = parseTimeArg(start);
  const endTimeMs = parseTimeArg(end);
  const canonicalSymbol = `${symbol}-PERP`;

  const plan: DatasetIngestionPlan = {
    id: `ingest_plan_${slug(symbol)}_${hashParts([prompt, symbol, ...intervals, start, end])}`,
    created_at: now,
    prompt,
    source: "hyperliquid",
    venue: "hyperliquid",
    symbol,
    canonical_symbol: canonicalSymbol,
    intervals,
    start_at: new Date(startTimeMs).toISOString(),
    end_at: new Date(endTimeMs).toISOString(),
    start_time_ms: startTimeMs,
    end_time_ms: endTimeMs,
    rationale: [
      `${canonicalSymbol} is the project canonical perp symbol for Hyperliquid ${symbol}.`,
      intervals.length > 1
        ? `${intervals.join(", ")} intervals let the strategy compare execution and context windows.`
        : `${intervals[0]} candles match the requested working timeframe.`
    ],
    assumptions: [
      "Use Hyperliquid read-only market data.",
      "Store raw and normalized artifacts under project .openstrat/objects.",
      "Run ingestion only after the user approves the proposed command."
    ],
    ingest_commands: intervals.map(
      (interval) =>
        `openstrat datasets ingest --symbol ${symbol} --interval ${interval} --start ${new Date(startTimeMs).toISOString()} --end ${new Date(endTimeMs).toISOString()} --live`
    ),
    slash_commands: intervals.map(
      (interval) =>
        `/datasets ingest --symbol ${symbol} --interval ${interval} --start ${new Date(startTimeMs).toISOString()} --end ${new Date(endTimeMs).toISOString()} --live`
    ),
    expected_dataset_ids: intervals.map((interval) =>
      datasetId("hyperliquid", symbol, interval, startTimeMs, endTimeMs)
    )
  };

  if (input.home) {
    const ref = `plans/${plan.id}.json`;
    objectStore(input.home).putJson(ref, plan, { overwrite: true });
    recordWorkbenchArtifact(input.home, input.sessionId ?? "planner", {
      kind: "dataset_ingestion_plan",
      ref,
      summary: `Planned ${symbol} ${intervals.join("/")} Hyperliquid ingestion.`,
      metadata: { plan }
    });
  }

  return plan;
}

export async function ingestDataset(
  home: OpenStratCliHome,
  input: IngestDatasetInput
): Promise<DatasetIndexEntry> {
  if (input.fixture !== true && input.live !== true) {
    throw new Error(
      "Dataset ingestion requires --fixture for deterministic local data or --live for Hyperliquid read-only API access."
    );
  }

  const symbol = normalizeCoin(input.symbol);
  const startTimeMs = parseTimeArg(input.start);
  const endTimeMs = parseTimeArg(input.end);
  const receivedAt = new Date().toISOString();
  const store = objectStore(home);
  const client =
    input.fixture === true
      ? fixtureHyperliquidClient(symbol, input.interval, startTimeMs, endTimeMs)
      : new HyperliquidInfoClient(
          input.endpoint === undefined ? {} : { endpoint: input.endpoint }
        );

  const result = await ingestHyperliquidWindow({
    client,
    object_store: store,
    coin: symbol,
    interval: input.interval,
    start_time_ms: startTimeMs,
    end_time_ms: endTimeMs,
    received_at: receivedAt
  });
  const candles = result.candle_refs.flatMap((ref) => store.getJson<Candle[]>(ref));
  const funding = result.funding_refs.flatMap((ref) => store.getJson<unknown[]>(ref));
  const orderbooks = result.orderbook_refs.map((ref) => store.getJson<unknown>(ref));
  const entry: DatasetIndexEntry = {
    id: datasetId("hyperliquid", symbol, input.interval, startTimeMs, endTimeMs),
    created_at: receivedAt,
    updated_at: receivedAt,
    source: "hyperliquid",
    venue: "hyperliquid",
    status: "available",
    symbol,
    canonical_symbol: `${symbol}-PERP`,
    interval: input.interval,
    start_at: new Date(startTimeMs).toISOString(),
    end_at: new Date(endTimeMs).toISOString(),
    start_time_ms: startTimeMs,
    end_time_ms: endTimeMs,
    registry_ref: result.registry_ref,
    candle_refs: result.candle_refs,
    funding_refs: result.funding_refs,
    orderbook_refs: result.orderbook_refs,
    raw_refs: Object.values(result.raw_refs),
    row_counts: {
      candles: candles.length,
      funding: funding.length,
      orderbooks: orderbooks.length
    },
    ingest_command: `openstrat datasets ingest --symbol ${symbol} --interval ${input.interval} --start ${new Date(startTimeMs).toISOString()} --end ${new Date(endTimeMs).toISOString()} ${input.fixture === true ? "--fixture" : "--live"}`
  };

  upsertIndexEntry(datasetIndexPath(home), entry, (candidate) => candidate.id);
  upsertMarketsFromRegistry(
    home,
    entry,
    store.getJson<MarketRegistryEntry[]>(result.registry_ref)
  );
  recordWorkbenchArtifact(home, input.sessionId ?? "ingest", {
    kind: "dataset_ingest_result",
    ref: datasetIndexPath(home),
    summary: `Ingested ${entry.canonical_symbol} ${entry.interval} dataset ${entry.id}.`,
    metadata: { dataset: entry }
  });
  return entry;
}

export function listDatasets(home: OpenStratCliHome): DatasetIndexEntry[] {
  return readIndex<DatasetIndexEntry>(datasetIndexPath(home)).entries.sort(
    (left, right) => right.updated_at.localeCompare(left.updated_at)
  );
}

export function listMarkets(home: OpenStratCliHome): MarketIndexEntry[] {
  return readIndex<MarketIndexEntry>(marketIndexPath(home)).entries.sort(
    (left, right) => left.canonical_symbol.localeCompare(right.canonical_symbol)
  );
}

export async function refreshHyperliquidMarketCatalog(
  home: OpenStratCliHome,
  input: {
    fixture?: boolean | undefined;
    endpoint?: string | undefined;
    sessionId?: string | undefined;
  } = {}
): Promise<MarketCatalogRefreshResult> {
  const receivedAt = new Date().toISOString();
  const client =
    input.fixture === true
      ? fixtureHyperliquidMarketCatalogClient()
      : new HyperliquidInfoClient(
          input.endpoint === undefined ? {} : { endpoint: input.endpoint }
        );
  const response = await client.metaAndAssetCtxs();
  const refSlug = slug(new Date(receivedAt).toISOString());
  const rawRef = `raw/hyperliquid/meta-and-asset-ctxs/catalog-${refSlug}.json`;
  const registryRef = `normalized/hyperliquid/registry/catalog-${refSlug}.json`;
  const store = objectStore(home);
  store.putJson(rawRef, response);
  const registry = deriveHyperliquidMarketRegistry(response, {
    received_at: receivedAt,
    raw_ref: rawRef
  });
  store.putJson(registryRef, registry);
  const markets = upsertMarketCatalog(home, registry);
  const result: MarketCatalogRefreshResult = {
    id: `market_catalog_${hashParts([receivedAt, rawRef])}`,
    created_at: receivedAt,
    source: "hyperliquid",
    venue: "hyperliquid",
    raw_ref: rawRef,
    registry_ref: registryRef,
    markets,
    active_markets: markets.filter((market) => market.status === "active").length
  };
  recordWorkbenchArtifact(home, input.sessionId ?? "markets", {
    kind: "market_catalog",
    ref: registryRef,
    summary: `Loaded ${result.active_markets} active Hyperliquid perp market(s).`,
    metadata: { market_catalog: result }
  });
  return result;
}

export function validateDataset(
  home: OpenStratCliHome,
  datasetIdInput?: string,
  sessionId = "dataset_validation"
): DatasetValidationResult {
  const dataset = datasetIdInput
    ? findDataset(home, datasetIdInput)
    : listDatasets(home)[0];
  if (!dataset) {
    throw new Error("No dataset is available to validate.");
  }
  const store = objectStore(home);
  const checks: DatasetValidationResult["checks"] = [];
  for (const ref of [
    dataset.registry_ref,
    ...dataset.candle_refs,
    ...dataset.funding_refs,
    ...dataset.orderbook_refs,
    ...dataset.raw_refs
  ]) {
    checks.push({
      name: `object:${ref}`,
      status: store.exists(ref) ? "pass" : "fail",
      message: store.exists(ref) ? "Object ref exists." : "Object ref is missing."
    });
  }
  for (const candleRef of dataset.candle_refs) {
    try {
      const candles = store.getJson<unknown[]>(candleRef);
      for (const [index, candle] of candles.entries()) {
        CandleSchema.parse(candle);
        if ((candle as Candle).interval !== dataset.interval) {
          throw new Error(`candle ${index} interval does not match dataset`);
        }
      }
      checks.push({
        name: `candles:${candleRef}`,
        status: "pass",
        message: `${candles.length} candle rows match the dataset interval.`
      });
    } catch (error) {
      checks.push({
        name: `candles:${candleRef}`,
        status: "fail",
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }
  const validation: DatasetValidationResult = {
    id: `dataset_validation_${hashParts([dataset.id, new Date().toISOString()])}`,
    created_at: new Date().toISOString(),
    dataset_id: dataset.id,
    status: checks.every((check) => check.status === "pass") ? "ok" : "error",
    checks
  };
  const ref = `datasets/validation/${validation.id}.json`;
  store.putJson(ref, validation, { overwrite: true });
  recordWorkbenchArtifact(home, sessionId, {
    kind: "dataset_validation",
    ref,
    summary: `${validation.status}: dataset ${dataset.id} validation.`,
    metadata: { validation }
  });
  return validation;
}

export function inspectDataset(
  home: OpenStratCliHome,
  datasetIdInput?: string,
  sessionId = "dataset_inspection"
): DatasetInspectionResult {
  const dataset = datasetIdInput
    ? findDataset(home, datasetIdInput)
    : listDatasets(home)[0];
  if (!dataset) {
    throw new Error("No dataset is available to inspect.");
  }

  const store = objectStore(home);
  const allRefs = [
    dataset.registry_ref,
    ...dataset.candle_refs,
    ...dataset.funding_refs,
    ...dataset.orderbook_refs,
    ...dataset.raw_refs
  ];
  const missingRefs = allRefs.filter((ref) => !store.exists(ref));
  const intervalMismatches: string[] = [];
  const candleRefCounts: DatasetInspectionResult["validation"]["candle_refs"] = [];
  const candles = dataset.candle_refs.flatMap((ref) => {
    if (!store.exists(ref)) {
      candleRefCounts.push({ ref, count: 0 });
      return [];
    }
    const rows = store.getJson<Candle[]>(ref);
    candleRefCounts.push({ ref, count: rows.length });
    for (const [index, candle] of rows.entries()) {
      try {
        CandleSchema.parse(candle);
        if (candle.interval !== dataset.interval) {
          intervalMismatches.push(
            `${ref}[${index}] interval ${candle.interval} does not match ${dataset.interval}.`
          );
        }
      } catch (error) {
        intervalMismatches.push(
          `${ref}[${index}] ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    return rows;
  });
  const sortedCandles = [...candles].sort(
    (left, right) => Date.parse(left.open_time) - Date.parse(right.open_time)
  );
  const firstCandle = sortedCandles[0];
  const lastCandle = sortedCandles.at(-1);
  const validationStatus =
    missingRefs.length === 0 && intervalMismatches.length === 0 ? "ok" : "error";
  const inspection: DatasetInspectionResult = {
    id: `dataset_inspection_${hashParts([dataset.id, new Date().toISOString()])}`,
    created_at: new Date().toISOString(),
    dataset_id: dataset.id,
    status: validationStatus,
    summary: {
      canonical_symbol: dataset.canonical_symbol,
      interval: dataset.interval,
      source: dataset.source,
      venue: dataset.venue,
      start_at: dataset.start_at,
      end_at: dataset.end_at,
      candle_count: sortedCandles.length,
      funding_count: dataset.row_counts.funding,
      orderbook_count: dataset.row_counts.orderbooks,
      ...(firstCandle ? { first_candle_at: firstCandle.open_time } : {}),
      ...(lastCandle ? { last_candle_at: lastCandle.close_time } : {})
    },
    refs: {
      registry_ref: dataset.registry_ref,
      candle_refs: dataset.candle_refs,
      funding_refs: dataset.funding_refs,
      orderbook_refs: dataset.orderbook_refs,
      raw_refs: dataset.raw_refs
    },
    validation: {
      status: validationStatus,
      missing_refs: missingRefs,
      interval_mismatches: intervalMismatches,
      candle_refs: candleRefCounts
    }
  };
  const ref = `datasets/inspection/${inspection.id}.json`;
  store.putJson(ref, inspection, { overwrite: true });
  recordWorkbenchArtifact(home, sessionId, {
    kind: "dataset_inspection",
    ref,
    summary: `${inspection.status}: inspected ${dataset.id} with ${inspection.summary.candle_count} candle rows.`,
    metadata: { inspection }
  });
  return inspection;
}

export function createStrategyAuthoringGuide(
  home: OpenStratCliHome,
  cwd: string,
  input: {
    strategyFile?: string | undefined;
    datasetId?: string | undefined;
    sessionId?: string | undefined;
  } = {}
): StrategyAuthoringGuide {
  const dataset = input.datasetId
    ? findDataset(home, input.datasetId)
    : listDatasets(home)[0];
  const strategyFile = normalizeProjectRelativePath(
    cwd,
    input.strategyFile ?? "src/strategy.ts"
  );
  const canonicalSymbol = dataset?.canonical_symbol ?? "SOL-PERP";
  const interval = dataset?.interval ?? "5m";
  const datasetIdForRefs = dataset?.id ?? "dataset_id";
  const strategyId = slug(canonicalSymbol.replace(/-PERP$/, "")).replaceAll("-", "_");
  const guide: StrategyAuthoringGuide = {
    id: `strategy_authoring_guide_${hashParts([strategyFile, datasetIdForRefs, new Date().toISOString()])}`,
    created_at: new Date().toISOString(),
    strategy_file: strategyFile,
    ...(dataset ? { dataset_id: dataset.id } : {}),
    checklist: [
      "Import defineStrategy from @openstrat/strategy-sdk.",
      `Set manifest.entrypoint to ${strategyFile}.`,
      `Include ${canonicalSymbol} in manifest.allowed_symbols.`,
      `Declare required_data with candles for ${canonicalSymbol} ${interval}.`,
      "Make evaluate deterministic: use input.now, input.market_events, and manifest parameters only.",
      "Return an array of TradeIntent objects; return [] when there is no trade.",
      "Attach evidence_refs from candle raw_ref values or the decision_ref."
    ],
    forbidden: [
      "No exchange SDKs, Hyperliquid clients, fetch, WebSocket, shell, fs, process.env, wallet, signer, seed phrase, or private key references.",
      "No Date.now, new Date, Math.random, randomUUID, dynamic import, or require inside evaluate."
    ],
    template: strategyTemplate(strategyFile, canonicalSymbol, interval, strategyId),
    validate_command: `openstrat strategy validate --strategy ${strategyFile}${dataset ? ` --dataset ${dataset.id}` : ""}`,
    next_commands: [
      `/strategy validate --strategy ${strategyFile}${dataset ? ` --dataset ${dataset.id}` : ""}`,
      dataset
        ? `/backtest plan --strategy ${strategyFile} --dataset ${dataset.id}`
        : "/datasets inspect"
    ]
  };
  const ref = `strategies/guides/${guide.id}.json`;
  objectStore(home).putJson(ref, guide, { overwrite: true });
  recordWorkbenchArtifact(home, input.sessionId ?? "strategy_guide", {
    kind: "strategy_authoring_guide",
    ref,
    summary: `Prepared strategy authoring guide for ${strategyFile}.`,
    metadata: { guide }
  });
  return guide;
}

export async function validateStrategyFile(
  home: OpenStratCliHome,
  cwd: string,
  strategyFile?: string,
  datasetIdInput?: string,
  sessionId = "strategy_validation"
): Promise<StrategyValidationResult> {
  const strategyPath = resolveStrategyFile(cwd, strategyFile);
  const source = readFileSync(strategyPath.absolute, "utf8");
  const issues: string[] = [];
  const warnings: string[] = [];
  const checks: StrategyValidationResult["checks"] = [];
  if (
    !source.includes("@openstrat/strategy-sdk") ||
    !source.includes("defineStrategy")
  ) {
    issues.push("Strategy must use defineStrategy from @openstrat/strategy-sdk.");
    checks.push({
      name: "sdk_contract",
      status: "fail",
      message: "Strategy must import defineStrategy from @openstrat/strategy-sdk."
    });
  } else {
    checks.push({
      name: "sdk_contract",
      status: "pass",
      message: "Strategy uses the OpenStrat strategy SDK contract."
    });
  }

  const unsupportedImports = unsupportedStrategyImports(source);
  if (unsupportedImports.length > 0) {
    issues.push(
      `Strategy imports unsupported package(s): ${unsupportedImports.join(", ")}. Keep strategy files limited to @openstrat/strategy-sdk.`
    );
    checks.push({
      name: "imports",
      status: "fail",
      message: `Unsupported imports: ${unsupportedImports.join(", ")}.`
    });
  } else {
    checks.push({
      name: "imports",
      status: "pass",
      message: "No unsupported imports detected."
    });
  }

  for (const pattern of forbiddenStrategySourcePatterns()) {
    if (pattern.test(source)) {
      issues.push(
        `Strategy source references forbidden API or exchange path: ${pattern.source}`
      );
      checks.push({
        name: "forbidden_api",
        status: "fail",
        message: `Forbidden source pattern matched: ${pattern.source}.`
      });
    }
  }
  if (!checks.some((check) => check.name === "forbidden_api")) {
    checks.push({
      name: "forbidden_api",
      status: "pass",
      message: "No forbidden APIs or exchange execution paths detected."
    });
  }

  let manifest: StrategyManifest | undefined;
  const dataset = datasetIdInput ? findDataset(home, datasetIdInput) : undefined;
  if (datasetIdInput && !dataset) {
    issues.push(`Dataset not found: ${datasetIdInput}.`);
    checks.push({
      name: "dataset",
      status: "fail",
      message: `Dataset ${datasetIdInput} is not indexed in this project.`
    });
  }

  try {
    const loaded = await loadStrategyModule(home, strategyPath.absolute);
    manifest = StrategyManifestSchema.parse(loaded.manifest);
    if (manifest.entrypoint !== strategyPath.relative) {
      issues.push(
        `Manifest entrypoint is ${manifest.entrypoint}; expected ${strategyPath.relative}.`
      );
      checks.push({
        name: "entrypoint",
        status: "fail",
        message: `Manifest entrypoint must match ${strategyPath.relative}.`
      });
    } else {
      checks.push({
        name: "entrypoint",
        status: "pass",
        message: "Manifest entrypoint matches the strategy file."
      });
    }
    if (manifest.required_data.length === 0) {
      issues.push(
        "Manifest required_data must declare the candle datasets needed for analysis and backtesting."
      );
      checks.push({
        name: "required_data",
        status: "fail",
        message: "Manifest does not declare required_data."
      });
    } else {
      checks.push({
        name: "required_data",
        status: "pass",
        message: "Manifest declares required_data."
      });
    }

    if (!dataset) {
      warnings.push(
        "Output shape and deterministic execution probe skipped because no dataset_id was supplied."
      );
      checks.push({
        name: "execution_probe",
        status: "warn",
        message: "Supply --dataset <id> to validate output shape and determinism."
      });
    }
    if (dataset) {
      if (!manifest.allowed_symbols.includes(dataset.canonical_symbol)) {
        issues.push(
          `Manifest allowed_symbols does not include dataset symbol ${dataset.canonical_symbol}.`
        );
        checks.push({
          name: "allowed_symbols",
          status: "fail",
          message: `allowed_symbols must include ${dataset.canonical_symbol}.`
        });
      } else {
        checks.push({
          name: "allowed_symbols",
          status: "pass",
          message: `allowed_symbols includes ${dataset.canonical_symbol}.`
        });
      }
      const hasRequiredData = manifest.required_data.some(
        (requirement) =>
          requirement.kind === "candles" &&
          requirement.canonical_symbol === dataset.canonical_symbol &&
          requirement.interval === dataset.interval
      );
      if (!hasRequiredData) {
        issues.push(
          `Manifest required_data does not include ${dataset.canonical_symbol} ${dataset.interval} candles.`
        );
        checks.push({
          name: "dataset_required_data",
          status: "fail",
          message: `required_data must include ${dataset.canonical_symbol} ${dataset.interval} candles.`
        });
      } else {
        checks.push({
          name: "dataset_required_data",
          status: "pass",
          message: `required_data includes ${dataset.canonical_symbol} ${dataset.interval} candles.`
        });
      }
      try {
        const probe = await probeStrategyAgainstDataset(home, loaded, dataset);
        checks.push({
          name: "execution_probe",
          status: "pass",
          message: `Strategy produced ${probe.intentCount} intent(s) in deterministic probe.`
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        issues.push(`Strategy execution probe failed: ${message}`);
        checks.push({
          name: "execution_probe",
          status: "fail",
          message
        });
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    issues.push(message);
    checks.push({
      name: "module_load",
      status: "fail",
      message
    });
  }

  const validation: StrategyValidationResult = {
    id: `strategy_validation_${hashParts([strategyPath.relative, new Date().toISOString()])}`,
    created_at: new Date().toISOString(),
    strategy_file: strategyPath.relative,
    status: issues.length === 0 ? "ok" : "error",
    ...(manifest ? { manifest } : {}),
    issues,
    warnings,
    checks
  };
  const ref = `strategies/validation/${validation.id}.json`;
  objectStore(home).putJson(ref, validation, { overwrite: true });
  recordWorkbenchArtifact(home, sessionId, {
    kind: "strategy_validation",
    ref,
    summary: `${validation.status}: strategy validation for ${validation.strategy_file}.`,
    metadata: { validation }
  });
  return validation;
}

export function listStrategyFiles(cwd: string): string[] {
  return ["src/strategy.ts", "strategies"].flatMap((candidate) => {
    const path = resolve(cwd, candidate);
    if (!existsSync(path)) {
      return [];
    }
    if (candidate.endsWith(".ts")) {
      return [candidate];
    }
    return [];
  });
}

export async function planBacktest(
  home: OpenStratCliHome,
  cwd: string,
  input: {
    strategyFile?: string | undefined;
    datasetId?: string | undefined;
    initialEquityUsd?: number | undefined;
    feeBps?: number | undefined;
    slippageBps?: number | undefined;
    runId?: string | undefined;
    sessionId?: string | undefined;
  } = {}
): Promise<BacktestPlan> {
  const dataset = input.datasetId
    ? findDataset(home, input.datasetId)
    : listDatasets(home)[0];
  if (!dataset) {
    throw new Error("No dataset is available for backtest planning.");
  }
  const strategyPath = resolveStrategyFile(cwd, input.strategyFile);
  const runId =
    input.runId ??
    `backtest_${hashParts([strategyPath.relative, dataset.id, new Date().toISOString()])}`;
  const initialEquityUsd = input.initialEquityUsd ?? 10_000;
  const feeBps = input.feeBps ?? 5;
  const slippageBps = input.slippageBps ?? 2;
  const configFlags = ` --initial-equity ${initialEquityUsd} --fee-bps ${feeBps} --slippage-bps ${slippageBps} --run-id ${runId}`;
  const plan: BacktestPlan = {
    id: `backtest_plan_${hashParts([runId])}`,
    created_at: new Date().toISOString(),
    run_id: runId,
    strategy_file: strategyPath.relative,
    dataset_id: dataset.id,
    dataset_ref: `datasets/${dataset.id}`,
    candle_refs: dataset.candle_refs,
    raw_artifact_refs: dataset.raw_refs,
    initial_equity_usd: initialEquityUsd,
    fee_bps: feeBps,
    slippage_bps: slippageBps,
    command: `openstrat backtest run --strategy ${strategyPath.relative} --dataset ${dataset.id}${configFlags}`,
    slash_command: `/backtest run --strategy ${strategyPath.relative} --dataset ${dataset.id}${configFlags}`
  };
  const ref = `backtests/plans/${plan.id}.json`;
  objectStore(home).putJson(ref, plan, { overwrite: true });
  recordWorkbenchArtifact(home, input.sessionId ?? "backtest_plan", {
    kind: "backtest_plan",
    ref,
    summary: `Planned backtest ${runId} for ${strategyPath.relative} on ${dataset.id}.`,
    metadata: { plan }
  });
  return plan;
}

export async function runBacktest(
  home: OpenStratCliHome,
  cwd: string,
  input: {
    strategyFile?: string | undefined;
    datasetId?: string | undefined;
    initialEquityUsd?: number | undefined;
    feeBps?: number | undefined;
    slippageBps?: number | undefined;
    runId?: string | undefined;
    sessionId?: string | undefined;
  } = {}
): Promise<BacktestIndexEntry> {
  const plan = await planBacktest(home, cwd, input);
  const validation = await validateStrategyFile(
    home,
    cwd,
    plan.strategy_file,
    plan.dataset_id,
    input.sessionId ?? "backtest_run"
  );
  if (validation.status !== "ok") {
    throw new Error(`Strategy validation failed: ${validation.issues.join("; ")}`);
  }
  const strategy = await loadStrategyModule(home, resolve(cwd, plan.strategy_file));
  const store = objectStore(home);
  const report = BacktestReportSchema.parse(
    await runCandleBacktest({
      run_id: plan.run_id,
      strategy,
      object_store: store,
      dataset_ref: plan.dataset_ref,
      candle_refs: plan.candle_refs,
      raw_artifact_refs: plan.raw_artifact_refs,
      generated_at: new Date().toISOString(),
      initial_equity_usd: plan.initial_equity_usd,
      fee_bps: plan.fee_bps,
      slippage_model: () => ({
        slippage_bps: plan.slippage_bps,
        source_ref: `models/slippage/fixed-${plan.slippage_bps}bps`
      })
    })
  );
  const reportRef = `backtests/${plan.run_id}/report.json`;
  store.putJson(reportRef, report, { overwrite: true });
  const entry: BacktestIndexEntry = {
    id: plan.run_id,
    created_at: report.generated_at,
    run_id: plan.run_id,
    strategy_id: report.strategy_id,
    strategy_version: report.strategy_version,
    strategy_file: plan.strategy_file,
    dataset_id: plan.dataset_id,
    report_ref: reportRef,
    trade_ledger_ref: report.trade_ledger_ref,
    dataset_ref: report.dataset_ref,
    artifact_refs: report.artifact_refs,
    config: {
      initial_equity_usd: plan.initial_equity_usd,
      fee_bps: plan.fee_bps,
      slippage_bps: plan.slippage_bps
    },
    metrics: report.metrics,
    warnings: report.warnings,
    next_actions: [
      `/risk preflight --strategy ${plan.strategy_file} --dataset ${plan.dataset_id} --backtest ${plan.run_id}`
    ],
    status: "passed"
  };
  upsertIndexEntry(backtestIndexPath(home), entry, (candidate) => candidate.id);
  recordWorkbenchArtifact(home, input.sessionId ?? "backtest_run", {
    kind: "backtest_report",
    ref: reportRef,
    summary: `Backtest ${entry.run_id}: ${entry.metrics.trades} trades, PnL ${entry.metrics.pnl_usd}, max DD ${entry.metrics.max_drawdown_pct}%.`,
    metadata: { backtest: entry }
  });
  return entry;
}

export function listBacktests(home: OpenStratCliHome): BacktestIndexEntry[] {
  return readIndex<BacktestIndexEntry>(backtestIndexPath(home)).entries.sort(
    (left, right) => right.created_at.localeCompare(left.created_at)
  );
}

export async function runRiskPreflight(
  home: OpenStratCliHome,
  cwd: string,
  input: {
    strategyFile?: string | undefined;
    datasetId?: string | undefined;
    backtestRunId?: string | undefined;
  } & RiskPreflightPolicyInput & {
      sessionId?: string | undefined;
    } = {}
): Promise<RiskPreflightResult> {
  const dataset = input.datasetId
    ? findDataset(home, input.datasetId)
    : listDatasets(home)[0];
  if (!dataset) {
    throw new Error("No dataset is available for risk preflight.");
  }
  const backtest = input.backtestRunId
    ? listBacktests(home).find((entry) => entry.run_id === input.backtestRunId)
    : listBacktests(home)[0];
  const strategyValidation = await validateStrategyFile(
    home,
    cwd,
    input.strategyFile,
    dataset.id,
    input.sessionId ?? "risk_preflight"
  );
  const checks: RiskReview["checks"] = [
    {
      name: "dataset_refs",
      status: dataset.status === "available" ? "pass" : "fail",
      message:
        dataset.status === "available"
          ? "Dataset is available in the project index."
          : "Dataset is not available."
    },
    {
      name: "strategy_validation",
      status: strategyValidation.status === "ok" ? "pass" : "fail",
      message:
        strategyValidation.status === "ok"
          ? "Strategy validates against OpenStrat contracts."
          : strategyValidation.issues.join("; ")
    },
    {
      name: "backtest_evidence",
      status: backtest ? "pass" : "fail",
      message: backtest
        ? `Backtest evidence exists at ${backtest.report_ref}.`
        : "No backtest report is available yet."
    },
    {
      name: "policy_ref",
      status: input.policyRef ? "pass" : "warn",
      message: input.policyRef
        ? `Using local policy ref ${input.policyRef}.`
        : "No local risk policy ref supplied; default preflight thresholds only.",
      ...(input.policyRef ? { value: input.policyRef } : {})
    },
    {
      name: "wallet_and_live_trading_scope",
      status: "pass",
      message:
        "Wallet signing, live orders, and deployment are outside this local preflight."
    }
  ];
  const targetNotionalUsd =
    typeof strategyValidation.manifest?.parameters.target_notional_usd === "number"
      ? strategyValidation.manifest.parameters.target_notional_usd
      : undefined;
  if (input.maxNotionalUsd !== undefined) {
    checks.push({
      name: "max_notional_usd",
      status:
        targetNotionalUsd === undefined
          ? "warn"
          : targetNotionalUsd <= input.maxNotionalUsd
            ? "pass"
            : "fail",
      message:
        targetNotionalUsd === undefined
          ? "Strategy manifest parameters.target_notional_usd is not set."
          : `Strategy target_notional_usd is ${targetNotionalUsd}.`,
      ...(targetNotionalUsd !== undefined ? { value: targetNotionalUsd } : {}),
      limit: input.maxNotionalUsd
    });
  }
  if (input.maxDrawdownPct !== undefined) {
    checks.push({
      name: "max_drawdown_pct",
      status:
        backtest && backtest.metrics.max_drawdown_pct <= input.maxDrawdownPct
          ? "pass"
          : "fail",
      message: backtest
        ? `Backtest max drawdown is ${backtest.metrics.max_drawdown_pct}%.`
        : "No backtest metrics available for max drawdown policy.",
      ...(backtest ? { value: backtest.metrics.max_drawdown_pct } : {}),
      limit: input.maxDrawdownPct
    });
  }
  if (input.minTrades !== undefined) {
    checks.push({
      name: "min_trades",
      status: backtest && backtest.metrics.trades >= input.minTrades ? "pass" : "fail",
      message: backtest
        ? `Backtest produced ${backtest.metrics.trades} trade(s).`
        : "No backtest metrics available for min trades policy.",
      ...(backtest ? { value: backtest.metrics.trades } : {}),
      limit: input.minTrades
    });
  }
  if (input.minWinRate !== undefined) {
    checks.push({
      name: "min_win_rate",
      status:
        backtest && backtest.metrics.win_rate >= input.minWinRate ? "pass" : "fail",
      message: backtest
        ? `Backtest win rate is ${backtest.metrics.win_rate}.`
        : "No backtest metrics available for min win rate policy.",
      ...(backtest ? { value: backtest.metrics.win_rate } : {}),
      limit: input.minWinRate
    });
  }
  const status = checks.every((check) => check.status !== "fail")
    ? "approved"
    : "needs_review";
  const review = RiskReviewSchema.parse({
    id: `risk_preflight_${hashParts([dataset.id, strategyValidation.id, backtest?.run_id ?? "no-backtest", input.policyRef ?? "default"])}`,
    intent_id: "local_workbench_preflight",
    policy_id: input.policyRef ?? "risk/local_workbench_preflight",
    created_at: new Date().toISOString(),
    status,
    checks,
    required_approvals: status === "approved" ? [] : ["risk"]
  });
  const ref = `risk/preflight/${review.id}.json`;
  objectStore(home).putJson(ref, review, { overwrite: true });
  const result: RiskPreflightResult = {
    id: review.id,
    created_at: review.created_at,
    strategy_file: strategyValidation.strategy_file,
    dataset_id: dataset.id,
    ...(backtest ? { backtest_run_id: backtest.run_id } : {}),
    review_ref: ref,
    review
  };
  upsertIndexEntry(riskIndexPath(home), result, (candidate) => candidate.id);
  recordWorkbenchArtifact(home, input.sessionId ?? "risk_preflight", {
    kind: "risk_preflight",
    ref,
    summary: `${review.status}: risk preflight for ${dataset.id}.`,
    metadata: { preflight: result }
  });
  return result;
}

export function parseWorkbenchArgs(argv: string[]): CommandArgs {
  const parsed: CommandArgs = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg?.startsWith("--")) {
      continue;
    }
    const key = arg.slice(2).replaceAll("-", "_");
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      parsed[key] = true;
      continue;
    }
    parsed[key] = next;
    index += 1;
  }
  return parsed;
}

export function intervalArg(value: unknown): CandleInterval {
  if (typeof value !== "string") {
    throw new Error("Missing --interval");
  }
  return asInterval(value);
}

export function stringArg(
  args: CommandArgs | Record<string, unknown>,
  name: string,
  fallback?: string
): string {
  const value = args[name];
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }
  if (fallback !== undefined) {
    return fallback;
  }
  throw new Error(`Missing --${name.replaceAll("_", "-")}`);
}

export function booleanArg(
  args: CommandArgs | Record<string, unknown>,
  name: string
): boolean {
  return args[name] === true || args[name] === "true";
}

export function optionalNumberArg(
  args: CommandArgs | Record<string, unknown>,
  name: string
): number | undefined {
  const value = args[name];
  if (value === undefined || value === false) {
    return undefined;
  }
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid --${name.replaceAll("_", "-")} value: ${String(value)}`);
  }
  return parsed;
}

function inferSymbol(prompt: string): string {
  const tokenMatch = /\b([A-Za-z0-9]{2,10})\s+(?:token|perp|market)\b/i.exec(prompt);
  if (tokenMatch?.[1]) {
    return tokenMatch[1];
  }
  const uppercase = prompt.match(/\b[A-Z0-9]{2,10}\b/g);
  return (
    uppercase?.find((candidate) => !["USD", "USDC", "TUI"].includes(candidate)) ?? "BTC"
  );
}

function normalizeCoin(symbol: string): string {
  return symbol
    .toUpperCase()
    .replace(/-PERP$/, "")
    .replace(/\/USDC$/, "")
    .replace(/[^A-Z0-9]/g, "");
}

function inferIntervals(prompt: string): string[] {
  const text = prompt.toLowerCase();
  const intervals = new Set<string>();
  for (const match of text.matchAll(/\b(1|3|5|15|30)\s*(m|min|minute|minutes)\b/g)) {
    intervals.add(`${match[1]}m`);
  }
  for (const match of text.matchAll(/\b(1|2|4|8|12)\s*(h|hour|hours)\b/g)) {
    intervals.add(`${match[1]}h`);
  }
  if (
    /5\s*(?:m|minute|minutes)?\s*(?:\/|or|and)\s*15\s*(?:m|min|minute|minutes)/.test(
      text
    )
  ) {
    intervals.add("5m");
    intervals.add("15m");
  }
  if (intervals.size === 0 && /scalp|scalping/.test(text)) {
    intervals.add("5m");
    intervals.add("15m");
  }
  if (intervals.size === 0) {
    intervals.add("15m");
  }
  return [...intervals];
}

function normalizeIntervals(intervals: string[]): CandleInterval[] {
  return [...new Set(intervals.map(asInterval))];
}

function asInterval(value: string): CandleInterval {
  if ((SUPPORTED_INTERVALS as readonly string[]).includes(value)) {
    return value as CandleInterval;
  }
  throw new Error(`Unsupported candle interval: ${value}`);
}

function inferLookbackDays(prompt: string): number {
  const match = /\blast\s+(\d+)\s+(day|days|week|weeks)\b/i.exec(prompt);
  if (!match?.[1] || !match[2]) {
    return 30;
  }
  const amount = Number(match[1]);
  return match[2].startsWith("week") ? amount * 7 : amount;
}

function parseTimeArg(value: string): number {
  if (/^\d+$/.test(value)) {
    return Number(value);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid time value: ${value}`);
  }
  return parsed;
}

function datasetId(
  source: string,
  symbol: string,
  interval: CandleInterval,
  startTimeMs: number,
  endTimeMs: number
): string {
  return `dataset_${source}_${slug(symbol)}_${interval}_${startTimeMs}_${endTimeMs}`;
}

function datasetIndexPath(home: OpenStratCliHome): string {
  return join(home.datasetsDir, "index.json");
}

function marketIndexPath(home: OpenStratCliHome): string {
  return join(home.datasetsDir, "markets.json");
}

function backtestIndexPath(home: OpenStratCliHome): string {
  return join(home.backtestsDir, "index.json");
}

function riskIndexPath(home: OpenStratCliHome): string {
  return join(home.riskDir, "preflight-index.json");
}

function readIndex<T>(path: string): IndexFile<T> {
  return readJsonFile<IndexFile<T>>(path, { version: 1, entries: [] });
}

function upsertIndexEntry<T>(path: string, entry: T, idOf: (entry: T) => string): void {
  const index = readIndex<T>(path);
  const entries = index.entries.filter((candidate) => idOf(candidate) !== idOf(entry));
  writeJsonFile(path, { version: 1, entries: [...entries, entry] });
}

function upsertMarketsFromRegistry(
  home: OpenStratCliHome,
  dataset: DatasetIndexEntry,
  registry: MarketRegistryEntry[]
): void {
  const index = readIndex<MarketIndexEntry>(marketIndexPath(home));
  const bySymbol = new Map(
    index.entries.map((entry) => [entry.canonical_symbol, entry])
  );
  for (const market of registry) {
    const current = bySymbol.get(market.canonical_symbol);
    bySymbol.set(market.canonical_symbol, {
      ...market,
      dataset_ids: current
        ? [...new Set([...current.dataset_ids, dataset.id])]
        : market.canonical_symbol === dataset.canonical_symbol
          ? [dataset.id]
          : []
    });
  }
  writeJsonFile(marketIndexPath(home), {
    version: 1,
    entries: [...bySymbol.values()]
  });
}

function upsertMarketCatalog(
  home: OpenStratCliHome,
  registry: MarketRegistryEntry[]
): MarketIndexEntry[] {
  const index = readIndex<MarketIndexEntry>(marketIndexPath(home));
  const existingDatasetIds = new Map(
    index.entries.map((entry) => [entry.canonical_symbol, entry.dataset_ids])
  );
  const entries = registry.map((market) => ({
    ...market,
    dataset_ids: existingDatasetIds.get(market.canonical_symbol) ?? []
  }));
  writeJsonFile(marketIndexPath(home), {
    version: 1,
    entries
  });
  return entries.sort((left, right) =>
    left.canonical_symbol.localeCompare(right.canonical_symbol)
  );
}

function findDataset(
  home: OpenStratCliHome,
  id: string
): DatasetIndexEntry | undefined {
  return listDatasets(home).find((entry) => entry.id === id);
}

function objectStore(home: OpenStratCliHome): FileObjectStore {
  return new FileObjectStore(home.objectsDir);
}

function recordWorkbenchArtifact(
  home: OpenStratCliHome,
  sessionId: string,
  entry: Omit<ArtifactIndexEntry, "id" | "created_at" | "session_id">
): void {
  appendArtifactIndexEntry(home, {
    ...entry,
    session_id: sessionId
  });
}

function normalizeProjectRelativePath(cwd: string, candidate: string): string {
  const absolute = resolve(cwd, candidate);
  const relativePath = relative(cwd, absolute);
  if (
    relativePath === "" ||
    relativePath.startsWith("..") ||
    isAbsolute(relativePath)
  ) {
    throw new Error(`Path escapes project root: ${candidate}`);
  }
  return relativePath;
}

function resolveStrategyFile(
  cwd: string,
  strategyFile = "src/strategy.ts"
): { absolute: string; relative: string } {
  const absolute = resolve(cwd, strategyFile);
  const relativePath = relative(cwd, absolute);
  if (
    relativePath === "" ||
    relativePath.startsWith("..") ||
    isAbsolute(relativePath)
  ) {
    throw new Error(`Strategy file escapes project root: ${strategyFile}`);
  }
  if (!existsSync(absolute)) {
    throw new Error(`Strategy file not found: ${relativePath}`);
  }
  return { absolute, relative: relativePath };
}

async function probeStrategyAgainstDataset(
  home: OpenStratCliHome,
  strategy: StrategyModule,
  dataset: DatasetIndexEntry
): Promise<{ intentCount: number }> {
  const store = objectStore(home);
  const candles = dataset.candle_refs
    .filter((ref) => store.exists(ref))
    .flatMap((ref) => store.getJson<Candle[]>(ref))
    .sort((left, right) => Date.parse(left.open_time) - Date.parse(right.open_time))
    .slice(0, 5);
  if (candles.length === 0) {
    throw new Error(`Dataset ${dataset.id} has no candle rows for strategy probe.`);
  }
  const marketEvents: StrategyMarketEvent[] = candles.map((candle) => ({
    kind: "candle",
    candle
  }));
  const lastCandle = candles.at(-1);
  if (!lastCandle) {
    throw new Error(`Dataset ${dataset.id} has no candle rows for strategy probe.`);
  }
  const runner = createStrategyRunner();
  const result = await runner.evaluate(strategy, {
    now: lastCandle.close_time,
    mode: "paper",
    risk_policy_ref: "risk/strategy_validation",
    decision_ref: `strategies/validation/${dataset.id}/${lastCandle.close_time}`,
    market_events: marketEvents
  });
  return { intentCount: result.intents.length };
}

async function loadStrategyModule(
  home: OpenStratCliHome,
  strategyFile: string
): Promise<StrategyModule> {
  const compiledDir = join(home.strategiesDir, "compiled");
  mkdirSync(compiledDir, { recursive: true });
  const outfile = join(compiledDir, `${hashParts([strategyFile, randomUUID()])}.mjs`);
  await esbuildBuild({
    bundle: true,
    entryPoints: [strategyFile],
    format: "esm",
    outfile,
    platform: "node",
    target: "node22",
    plugins: [openStratStrategyShimPlugin()]
  });
  const module = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
  const candidate = module.default ?? module.strategy;
  const parsed = StrategyModuleSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new Error(
      "Strategy module must export default or named strategy from defineStrategy."
    );
  }
  return parsed.data as StrategyModule;
}

function openStratStrategyShimPlugin(): Plugin {
  return {
    name: "openstrat-strategy-shim",
    setup(build) {
      build.onResolve({ filter: /^@openstrat\/strategy-sdk$/ }, () => ({
        path: "strategy-sdk",
        namespace: "openstrat-shim"
      }));
      build.onLoad({ filter: /^strategy-sdk$/, namespace: "openstrat-shim" }, () => ({
        contents: [
          "export function defineStrategy(manifest, evaluate) { return { manifest, evaluate }; }",
          "export function parseTradeIntent(candidate) { return candidate; }",
          "export function createStrategyRunner() { throw new Error('createStrategyRunner is not available inside strategy files'); }"
        ].join("\n"),
        loader: "js"
      }));
    }
  };
}

function forbiddenStrategySourcePatterns(): RegExp[] {
  return [
    /\bfetch\s*\(/,
    /\bWebSocket\b/,
    /\bXMLHttpRequest\b/,
    /\bHyperliquid\b/i,
    /\bexchange\b.*\b(order|cancel|withdraw|transfer)\b/i,
    /\b(private_key|seed_phrase|wallet|signer)\b/i,
    /\bprocess\.env\b/,
    /\bnode:fs\b/,
    /\bchild_process\b/
  ];
}

function unsupportedStrategyImports(source: string): string[] {
  const modules = new Set<string>();
  for (const match of source.matchAll(
    /\bimport(?:\s+type)?[\s\S]*?\bfrom\s+["']([^"']+)["']/g
  )) {
    if (match[1] && match[1] !== "@openstrat/strategy-sdk") {
      modules.add(match[1]);
    }
  }
  for (const match of source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) {
    if (match[1]) {
      modules.add(match[1]);
    }
  }
  for (const match of source.matchAll(/\brequire\s*\(\s*["']([^"']+)["']\s*\)/g)) {
    if (match[1]) {
      modules.add(match[1]);
    }
  }
  return [...modules].sort();
}

function strategyTemplate(
  strategyFile: string,
  canonicalSymbol: string,
  interval: CandleInterval,
  strategyId: string
): string {
  return `import { defineStrategy } from "@openstrat/strategy-sdk";

export default defineStrategy({
  strategy_id: "${strategyId}_scalper",
  strategy_version: "0.1.0",
  name: "${canonicalSymbol} ${interval} workbench strategy",
  runtime: "typescript",
  entrypoint: "${strategyFile}",
  autonomy_mode: "strategy_workbench",
  allowed_symbols: ["${canonicalSymbol}"],
  parameters: {
    lookback_candles: 20,
    target_notional_usd: 1000
  },
  required_data: [
    { kind: "candles", canonical_symbol: "${canonicalSymbol}", interval: "${interval}" }
  ],
  output: "trade_intent",
  created_at: "2026-06-22T00:00:00.000Z",
  source_refs: []
}, (input) => {
  const candles = input.market_events
    .filter((event) => event.kind === "candle")
    .map((event) => event.candle);
  const lookback = 20;
  if (candles.length < lookback + 1) {
    return [];
  }
  const last = candles.at(-1);
  const previous = candles.slice(-(lookback + 1), -1);
  if (!last) {
    return [];
  }
  const averageClose = previous.reduce((sum, candle) => sum + candle.close, 0) / previous.length;
  if (last.close <= averageClose) {
    return [];
  }
  return [{
    id: "${strategyId}_scalper:" + last.close_time + ":open",
    created_at: input.now,
    created_by: {
      strategy_id: "${strategyId}_scalper",
      strategy_version: "0.1.0"
    },
    mode: input.mode,
    intent_type: "open_position",
    canonical_symbol: "${canonicalSymbol}",
    side: "long",
    target_notional_usd: 1000,
    max_slippage_bps: 10,
    reason_ref: input.decision_ref,
    evidence_refs: [last.raw_ref ?? input.decision_ref],
    risk_policy_ref: input.risk_policy_ref
  }];
});
`;
}

function fixtureHyperliquidClient(
  symbol: string,
  interval: CandleInterval,
  startTimeMs: number,
  endTimeMs: number
): HyperliquidReadClient {
  return {
    async metaAndAssetCtxs() {
      return [
        {
          universe: [
            {
              name: symbol,
              szDecimals: 2,
              maxLeverage: 20,
              marginTableId: 20
            }
          ],
          marginTables: [[20, { description: "fixture margin" }]],
          collateralToken: 0
        },
        [
          {
            prevDayPx: "100.0",
            dayNtlVlm: "50000000.0",
            markPx: "101.0",
            midPx: "101.1",
            funding: "0.00001",
            openInterest: "2000000.0",
            premium: "0.0001",
            oraclePx: "101.0",
            impactPxs: ["100.9", "101.2"],
            dayBaseVlm: "500000.0"
          }
        ]
      ];
    },
    async l2Book() {
      return {
        coin: symbol,
        time: endTimeMs,
        levels: [
          [
            { px: "100.9", sz: "100.0", n: 3 },
            { px: "100.8", sz: "80.0", n: 2 }
          ],
          [
            { px: "101.1", sz: "90.0", n: 4 },
            { px: "101.2", sz: "70.0", n: 2 }
          ]
        ]
      };
    },
    async candleSnapshot() {
      const intervalMs = intervalToMs(interval);
      const candles = [];
      for (let index = 0; index < 8; index += 1) {
        const t = startTimeMs + index * intervalMs;
        if (t > endTimeMs) {
          break;
        }
        const close = 100 + index * 2;
        candles.push({
          t,
          T: t + intervalMs - 1,
          s: symbol,
          i: interval,
          o: String(close - 1),
          c: String(close),
          h: String(close + 1),
          l: String(close - 2),
          v: String(1000 + index),
          n: 100 + index
        });
      }
      return candles;
    },
    async fundingHistory() {
      return [
        {
          coin: symbol,
          fundingRate: "0.00001",
          premium: "0.0001",
          time: startTimeMs
        },
        {
          coin: symbol,
          fundingRate: "0.00002",
          premium: "0.00015",
          time: endTimeMs
        }
      ];
    }
  };
}

function fixtureHyperliquidMarketCatalogClient(): {
  metaAndAssetCtxs(): Promise<HyperliquidMetaAndAssetCtxsResponse>;
} {
  return {
    async metaAndAssetCtxs() {
      return [
        {
          universe: [
            {
              name: "BTC",
              szDecimals: 5,
              maxLeverage: 50,
              marginTableId: 50
            },
            {
              name: "ETH",
              szDecimals: 4,
              maxLeverage: 50,
              marginTableId: 50
            },
            {
              name: "SOL",
              szDecimals: 2,
              maxLeverage: 20,
              marginTableId: 20
            },
            {
              name: "HYPE",
              szDecimals: 2,
              maxLeverage: 10,
              marginTableId: 10
            }
          ],
          marginTables: [
            [50, { description: "fixture 50x" }],
            [20, { description: "fixture 20x" }],
            [10, { description: "fixture 10x" }]
          ],
          collateralToken: 0
        },
        [
          fixtureAssetCtx("112000.0", "1400000000.0", "9000.0"),
          fixtureAssetCtx("4300.0", "950000000.0", "180000.0"),
          fixtureAssetCtx("132.0", "320000000.0", "4000000.0"),
          fixtureAssetCtx("38.0", "120000000.0", "1900000.0")
        ]
      ];
    }
  };
}

function fixtureAssetCtx(
  markPx: string,
  dayNtlVlm: string,
  openInterest: string
): HyperliquidMetaAndAssetCtxsResponse[1][number] {
  return {
    prevDayPx: markPx,
    dayNtlVlm,
    markPx,
    midPx: markPx,
    funding: "0.00001",
    openInterest,
    premium: "0.0001",
    oraclePx: markPx,
    impactPxs: [markPx, markPx],
    dayBaseVlm: "100000.0"
  };
}

function intervalToMs(interval: CandleInterval): number {
  const minutes: Record<string, number> = {
    "1m": 1,
    "3m": 3,
    "5m": 5,
    "15m": 15,
    "30m": 30,
    "1h": 60,
    "2h": 120,
    "4h": 240,
    "8h": 480,
    "12h": 720,
    "1d": 1440,
    "3d": 4320,
    "1w": 10080,
    "1M": 43200
  };
  return (minutes[interval] ?? 15) * 60 * 1000;
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

function hashParts(parts: string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 10);
}
