import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, join } from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { AuthStorage } from "@earendil-works/pi-coding-agent";
import {
  createAgentRuntimePolicy,
  createAgentRuntimePolicyEnforcer,
  createFakePiAgentSessionFactory,
  createPiAgentRuntimeAdapter,
  createStrategyProposalWorkflow,
  FakeCodexAppServerRuntimeAdapter,
  FileCodexAppServerBindingStore,
  FileCodexAppServerTranscriptStore,
  FilePiTranscriptStore,
  type CodexAppServerRuntimeEvent,
  type PiAgentSessionFactory
} from "@openstrat/agent-runtime";
import {
  preflightStrategyDatasetCompatibility,
  runCandleBacktest
} from "@openstrat/backtesting";
import {
  AgentResultEnvelopeSchema,
  BacktestReportSchema,
  BotRunManifestSchema,
  CandleIntervalSchema,
  DecisionLedgerEntrySchema,
  DeploymentGateSchema,
  MarketDatasetManifestSchema,
  MemoryProposalSchema,
  StrategyManifestSchema,
  type AgentResultEnvelope,
  type BacktestReport,
  type BotRunManifest,
  type DeploymentGate,
  type MarketDatasetManifest,
  type NormalizedMarketDataRef,
  type StrategyManifest
} from "@openstrat/domain";
import {
  getMarketDatasetManifest,
  HyperliquidInfoClient,
  ingestHyperliquidWindow,
  validateMarketDataset,
  type HyperliquidReadClient
} from "@openstrat/market-data";
import { FileObjectStore, SqliteEventLog } from "@openstrat/persistence";
import {
  createStrategyRunner,
  defineStrategy,
  movingAverageBreakoutStrategy,
  type StrategyMarketEvent,
  type StrategyModule
} from "@openstrat/strategy-sdk";
import {
  type AgentToolGateway,
  createAgentToolGateway,
  type DeploymentGateInspection,
  FlyMachineDeploymentProvider,
  LocalTerminalDeploymentProvider,
  SpriteMicrovmDeploymentProvider
} from "@openstrat/workers";
import {
  ensureOpenStratHome,
  findProjectRegistration,
  getPiAuthPath,
  listProjectRegistrations,
  projectObjectRef,
  projectObjectRoot,
  registerProject,
  resolveOpenStratHome,
  safePurgeOpenStratHome,
  type OpenStratHome
} from "./home.js";
import { cliVersion } from "./version.js";

const MIN_NODE_VERSION = "22.19.0";
const CODEX_PROVIDER_ID = "openai-codex";
const MARKET_FIXTURE_RECEIVED_AT = "2026-06-04T00:00:00.000Z";
const SAMPLE_STRATEGY_SOURCE = `import { defineStrategy } from "@openstrat/strategy-sdk";

export const strategy = defineStrategy(
  {
    strategy_id: "sample_moving_average_breakout",
    strategy_version: "0.1.0",
    name: "Sample moving average breakout",
    description: "Reference pure strategy captured by the OpenStrat workbench.",
    runtime: "typescript",
    entrypoint: "strategies/sample_moving_average_breakout.ts",
    autonomy_mode: "strategy_workbench",
    allowed_symbols: ["BTC-PERP"],
    parameters: { lookback_candles: 3, target_notional_usd: 1000 },
    required_data: [{ kind: "candles", canonical_symbol: "BTC-PERP", interval: "15m" }],
    output: "trade_intent",
    created_at: "2026-06-04T00:00:00.000Z",
    source_refs: []
  },
  () => []
);
`;

interface DeploymentGateArtifact {
  artifact_ref: string;
  created_at: string;
  gate_ref: string;
  strategy_ref: string;
  backtest_report_ref: string;
  risk_policy_ref: string;
  inspection: DeploymentGateInspection;
}

interface StrategyValidationArtifact {
  validation_ref: string;
  created_at: string;
  project: {
    id: string;
    cwd: string;
    registration_ref: string;
    object_root: string;
  };
  strategy: StrategyManifest;
  manifest_path?: string;
  source_path?: string;
  dataset_preflight?: {
    dataset_ref: string;
    required_families: string[];
    validation: {
      valid: boolean;
      missing_requirements: string[];
    };
  };
  evaluation: {
    intents: number;
  };
}

interface LocalBacktestRequestArtifact {
  request_ref: string;
  created_at: string;
  generated_at: string;
  project: {
    id: string;
    cwd: string;
    registration_ref: string;
    object_root: string;
  };
  strategy: StrategyManifest;
  strategy_manifest_ref: string;
  strategy_source_ref: string;
  manifest_path?: string;
  source_path?: string;
  dataset_ref: string;
  validation_ref?: string;
  fee_model_ref: string;
  slippage_model_ref: string;
  command_inputs: Record<string, unknown>;
  reproducibility: {
    engine: "@openstrat/backtesting";
    cli_version: string;
    deterministic: boolean;
    as_of?: string;
  };
}

interface BacktestMetricsArtifact {
  metrics_ref: string;
  created_at: string;
  backtest_report_ref: string;
  trade_ledger_ref: string;
  metrics: Record<string, unknown>;
}

interface ProjectStatusSnapshot {
  command: "project";
  subcommand: "status";
  generated_at: string;
  home: {
    root: string;
    objects_dir: string;
    sessions_dir: string;
  };
  project: {
    id: string;
    cwd: string;
    registration_ref: string;
    object_root: string;
  };
  latest: {
    strategy_manifest_path?: string;
    strategy_source_path?: string;
    dataset_ref?: string;
    strategy_validation_ref?: string;
    backtest_request_ref?: string;
    backtest_report_ref?: string;
    backtest_metrics_ref?: string;
    trade_ledger_ref?: string;
    gate_ref?: string;
    gate_artifact_ref?: string;
    transcript_ref?: string;
    chat_session_id?: string;
    export_manifest_path?: string;
  };
  counts: {
    datasets: number;
    validations: number;
    backtests: number;
    gates: number;
    chat_sessions: number;
    exports: number;
  };
  status_ref: string;
}

type ChatRuntimeKind = "codex_app_server" | "pi";
type CliJsonData = Record<string, unknown>;
type SetCliJsonData = (data: CliJsonData) => void;

export interface RunOpenStratCliInput {
  argv: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

export interface RunOpenStratCliResult {
  exitCode: number;
  stdout: string[];
  stderr: string[];
}

export async function runOpenStratCli(
  inputOptions: RunOpenStratCliInput
): Promise<RunOpenStratCliResult> {
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  const argv = [...inputOptions.argv];
  const jsonMode = removeBooleanFlag(argv, "--json");
  const commandName = commandNameForJson(argv);
  let jsonData: CliJsonData | undefined;
  const setJsonData: SetCliJsonData = (data) => {
    jsonData = data;
  };
  const emitOut = (line: string) => {
    stdoutLines.push(line);
    if (!jsonMode) {
      inputOptions.stdout?.(line);
    }
  };
  const emitJsonOut = (line: string) => {
    stdoutLines.push(line);
    inputOptions.stdout?.(line);
  };
  const emitErr = (line: string) => {
    stderrLines.push(line);
    inputOptions.stderr?.(line);
  };
  const env = inputOptions.env ?? process.env;
  const cwd = inputOptions.cwd ?? process.cwd();
  const home = resolveOpenStratHome({ cwd, env });

  try {
    if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
      printHelp(emitOut);
      return finishCliSuccess({
        commandName,
        data: jsonData,
        emitJsonOut,
        jsonMode,
        stderrLines,
        stdoutLines
      });
    }
    if (argv[0] === "--version" || argv[0] === "-v") {
      emitOut(cliVersion);
      return finishCliSuccess({
        commandName,
        data: jsonData,
        emitJsonOut,
        jsonMode,
        stderrLines,
        stdoutLines
      });
    }

    const command = argv.shift();
    switch (command) {
      case "init":
        await commandInit({ cwd, emitOut, home });
        break;
      case "doctor":
        await commandDoctor({ cwd, emitOut, env, home });
        break;
      case "auth":
        await commandAuth({ argv, emitOut, env, home });
        break;
      case "chat":
        await commandChat({ argv, cwd, emitOut, env, home });
        break;
      case "artifacts":
        await commandArtifacts({ emitOut, home });
        break;
      case "market":
        await commandMarket({ argv, emitOut, env, home, setJsonData });
        break;
      case "strategy":
        await commandStrategy({ argv, cwd, emitOut, home, setJsonData });
        break;
      case "backtest":
        await commandBacktest({ argv, cwd, emitOut, home, setJsonData });
        break;
      case "gate":
        await commandGate({ argv, cwd, emitOut, home });
        break;
      case "project":
        await commandProject({ argv, cwd, emitOut, home, setJsonData });
        break;
      case "bundle":
        await commandBundle({ argv, cwd, emitOut, home, setJsonData });
        break;
      case "deploy":
        await commandDeploy({ argv, cwd, emitOut, home });
        break;
      case "ledger":
        await commandLedger({ argv, emitOut, home });
        break;
      case "memory":
        await commandMemory({ argv, emitOut, home });
        break;
      case "gateway":
        await commandGateway({ emitOut, home });
        break;
      case "upgrade":
      case "update":
        commandUpgrade({ argv, emitOut });
        break;
      case "reset":
        commandReset({ argv, emitOut, home });
        break;
      default:
        if (jsonMode) {
          return finishCliError({
            commandName,
            emitJsonOut,
            error: new Error(`Unknown command: ${command ?? ""}`),
            jsonMode,
            stderrLines,
            stdoutLines
          });
        }
        emitErr(`Unknown command: ${command ?? ""}`);
        return { exitCode: 1, stdout: stdoutLines, stderr: stderrLines };
    }
    return finishCliSuccess({
      commandName,
      data: jsonData,
      emitJsonOut,
      jsonMode,
      stderrLines,
      stdoutLines
    });
  } catch (error) {
    if (jsonMode) {
      return finishCliError({
        commandName,
        emitJsonOut,
        error,
        jsonMode,
        stderrLines,
        stdoutLines
      });
    }
    emitErr(error instanceof Error ? error.message : String(error));
    return { exitCode: 1, stdout: stdoutLines, stderr: stderrLines };
  }
}

function finishCliSuccess(options: {
  commandName: string;
  data: CliJsonData | undefined;
  emitJsonOut: (line: string) => void;
  jsonMode: boolean;
  stderrLines: string[];
  stdoutLines: string[];
}): RunOpenStratCliResult {
  if (!options.jsonMode) {
    return {
      exitCode: 0,
      stdout: options.stdoutLines,
      stderr: options.stderrLines
    };
  }

  const outputLines = [...options.stdoutLines];
  options.stdoutLines.length = 0;
  options.stderrLines.length = 0;
  const data = options.data ?? {
    command: options.commandName,
    output_lines: outputLines
  };
  const result = AgentResultEnvelopeSchema.parse({
    status: "completed",
    data: "command" in data ? data : { command: options.commandName, ...data },
    side_effect: "none"
  });
  options.emitJsonOut(cliJsonEnvelope(options.commandName, result));
  return {
    exitCode: 0,
    stdout: options.stdoutLines,
    stderr: options.stderrLines
  };
}

function finishCliError(options: {
  commandName: string;
  emitJsonOut: (line: string) => void;
  error: unknown;
  jsonMode: boolean;
  stderrLines: string[];
  stdoutLines: string[];
}): RunOpenStratCliResult {
  const message =
    options.error instanceof Error ? options.error.message : String(options.error);
  if (!options.jsonMode) {
    options.stderrLines.push(message);
    return {
      exitCode: 1,
      stdout: options.stdoutLines,
      stderr: options.stderrLines
    };
  }

  options.stdoutLines.length = 0;
  options.stderrLines.length = 0;
  const result = cliErrorResult(message);
  options.emitJsonOut(cliJsonEnvelope(options.commandName, result));
  return {
    exitCode: 1,
    stdout: options.stdoutLines,
    stderr: options.stderrLines
  };
}

function cliJsonEnvelope(commandName: string, result: AgentResultEnvelope): string {
  return JSON.stringify({
    command: commandName,
    result
  });
}

function cliErrorResult(message: string): AgentResultEnvelope {
  if (isCliContractError(message)) {
    return AgentResultEnvelopeSchema.parse({
      status: "blocked",
      reason: message,
      side_effect: "none"
    });
  }
  return AgentResultEnvelopeSchema.parse({
    status: "failed",
    error: message,
    side_effect: "none"
  });
}

function isCliContractError(message: string): boolean {
  return (
    message.startsWith("Usage:") ||
    message.startsWith("Missing required flag:") ||
    message.startsWith("No prompt provided") ||
    message.startsWith("Pass exactly one of") ||
    message.startsWith("Unknown command:")
  );
}

function commandNameForJson(argv: readonly string[]): string {
  const command = argv[0];
  if (!command || command === "--help" || command === "-h") {
    return "help";
  }
  if (command === "--version" || command === "-v") {
    return "version";
  }
  return command;
}

function removeBooleanFlag(argv: string[], flag: string): boolean {
  let found = false;
  for (let index = argv.length - 1; index >= 0; index -= 1) {
    if (argv[index] === flag) {
      argv.splice(index, 1);
      found = true;
    }
  }
  return found;
}

async function commandInit(options: {
  cwd: string;
  emitOut: (line: string) => void;
  home: OpenStratHome;
}): Promise<void> {
  const existing = findProjectRegistration(options.home, options.cwd);
  const registration = registerProject(options.home, options.cwd);
  options.emitOut(`OpenStrat home: ${options.home.root}`);
  options.emitOut(
    existing
      ? `Project already registered: ${registration.cwd}`
      : `Project registered: ${registration.cwd}`
  );
}

async function commandBacktest(options: {
  argv: string[];
  cwd: string;
  emitOut: (line: string) => void;
  home: OpenStratHome;
  setJsonData: SetCliJsonData;
}): Promise<void> {
  const subcommand = options.argv.shift();
  switch (subcommand) {
    case "run":
      await commandBacktestRunLocal(options);
      return;
    case "run-sample":
      await commandBacktestRunSample(options);
      return;
    default:
      throw new Error("Usage: openstrat backtest <run|run-sample>");
  }
}

async function commandBacktestRunLocal(options: {
  argv: string[];
  cwd: string;
  emitOut: (line: string) => void;
  home: OpenStratHome;
  setJsonData: SetCliJsonData;
}): Promise<void> {
  ensureOpenStratHome(options.home);
  const registration = registerProject(options.home, options.cwd);
  const store = new FileObjectStore(options.home.objectsDir);
  const loadedStrategy = await loadLocalStrategy(
    options.cwd,
    stringFlag(options.argv, "--manifest") ?? "openstrat.strategy.json"
  );
  const strategy = loadedStrategy.strategy;
  const datasetRef = requiredFlag(options.argv, "--dataset-ref");
  const feeBps = numberFlag(options.argv, "--fee-bps");
  const slippageBps = numberFlag(options.argv, "--slippage-bps");
  const asOf = stringFlag(options.argv, "--as-of");
  const validationRef =
    stringFlag(options.argv, "--validation-ref") ??
    latestStrategyValidationRef(
      options.home,
      projectObjectRoot(registration),
      strategy.manifest.strategy_id,
      datasetRef
    );
  const dataset = preflightStrategyDatasetCompatibility({
    object_store: store,
    strategy: strategy.manifest,
    dataset_ref: datasetRef,
    ...(asOf ? { as_of: asOf } : {})
  }).manifest;

  const createdAt = new Date().toISOString();
  const runId = `local_backtest_${Date.now()}_${safeRefSegment(
    strategy.manifest.strategy_id
  )}`;
  const backtestRoot = projectObjectRef(registration, "backtests", runId);
  const requestRef = `${backtestRoot}/request.json`;
  const reportRef = `${backtestRoot}/report.json`;
  const metricsRef = `${backtestRoot}/metrics.json`;
  const strategyRefs = writeLocalStrategyObjectRefs({
    createdAt,
    loadedStrategy,
    registration,
    store
  });
  const requestArtifact: LocalBacktestRequestArtifact = {
    request_ref: requestRef,
    created_at: createdAt,
    generated_at: createdAt,
    project: {
      id: registration.id,
      cwd: registration.cwd,
      registration_ref: registration.ref,
      object_root: projectObjectRoot(registration)
    },
    strategy: strategy.manifest,
    strategy_manifest_ref: strategyRefs.manifest_ref,
    strategy_source_ref: strategyRefs.source_ref,
    ...(loadedStrategy.manifest_path
      ? { manifest_path: loadedStrategy.manifest_path }
      : {}),
    ...(loadedStrategy.source_path ? { source_path: loadedStrategy.source_path } : {}),
    dataset_ref: dataset.dataset_ref,
    ...(validationRef ? { validation_ref: validationRef } : {}),
    fee_model_ref: `fees/fixed/${feeBps}bps`,
    slippage_model_ref: `slippage/fixed/${slippageBps}bps`,
    command_inputs: {
      manifest: stringFlag(options.argv, "--manifest") ?? "openstrat.strategy.json",
      dataset_ref: datasetRef,
      fee_bps: feeBps,
      slippage_bps: slippageBps,
      ...(asOf ? { as_of: asOf } : {}),
      ...(validationRef ? { validation_ref: validationRef } : {})
    },
    reproducibility: {
      engine: "@openstrat/backtesting",
      cli_version: cliVersion,
      deterministic: true,
      ...(asOf ? { as_of: asOf } : {})
    }
  };
  store.putJson(requestRef, requestArtifact);

  const report = await runCandleBacktest({
    run_id: runId,
    strategy,
    object_store: store,
    artifact_ref_root: backtestRoot,
    dataset_ref: dataset.dataset_ref,
    candle_refs: normalizedRefsFor(dataset, "candles").map((ref) => ref.ref),
    raw_artifact_refs: dataset.raw_refs.map((rawRef) => rawRef.ref),
    generated_at: createdAt,
    initial_equity_usd: 10_000,
    fee_bps: feeBps,
    slippage_model: () => ({
      slippage_bps: slippageBps,
      source_ref: `slippage/fixed/${slippageBps}bps`
    }),
    mode: "paper",
    risk_policy_ref: "risk/local"
  });
  const reportWithEvidence = BacktestReportSchema.parse({
    ...report,
    artifact_refs: uniqueRefs([
      requestRef,
      metricsRef,
      strategyRefs.manifest_ref,
      strategyRefs.source_ref,
      ...(validationRef ? [validationRef] : []),
      ...report.artifact_refs
    ])
  });
  const metricsArtifact: BacktestMetricsArtifact = {
    metrics_ref: metricsRef,
    created_at: createdAt,
    backtest_report_ref: reportRef,
    trade_ledger_ref: reportWithEvidence.trade_ledger_ref,
    metrics: reportWithEvidence.metrics
  };
  store.putJson(metricsRef, metricsArtifact);
  store.putJson(reportRef, reportWithEvidence);

  options.setJsonData({
    command: "backtest",
    subcommand: "run",
    project_id: registration.id,
    project_object_root: projectObjectRoot(registration),
    request_ref: requestRef,
    report_ref: reportRef,
    trade_ledger_ref: reportWithEvidence.trade_ledger_ref,
    metrics_ref: metricsRef,
    strategy_manifest_ref: strategyRefs.manifest_ref,
    strategy_source_ref: strategyRefs.source_ref,
    ...(validationRef ? { validation_ref: validationRef } : {}),
    trades: reportWithEvidence.metrics.trades
  });

  options.emitOut(`request: ${requestRef}`);
  options.emitOut(`report: ${reportRef}`);
  options.emitOut(`trade_ledger: ${reportWithEvidence.trade_ledger_ref}`);
  options.emitOut(`metrics: ${metricsRef}`);
  options.emitOut(`trades: ${reportWithEvidence.metrics.trades}`);
  options.emitOut(`project: ${registration.id}`);
  options.emitOut(`project_objects: ${projectObjectRoot(registration)}`);
}

async function commandBacktestRunSample(options: {
  argv: string[];
  emitOut: (line: string) => void;
  home: OpenStratHome;
}): Promise<void> {
  const strategyRef = requiredFlag(options.argv, "--strategy-ref");
  if (strategyRef !== movingAverageBreakoutStrategy.manifest.strategy_id) {
    throw new Error(`Unknown sample strategy ref: ${strategyRef}`);
  }
  const datasetRef = requiredFlag(options.argv, "--dataset-ref");
  const feeBps = numberFlag(options.argv, "--fee-bps");
  const slippageBps = numberFlag(options.argv, "--slippage-bps");
  const asOf = stringFlag(options.argv, "--as-of");
  const store = new FileObjectStore(options.home.objectsDir);
  const dataset = preflightStrategyDatasetCompatibility({
    object_store: store,
    strategy: movingAverageBreakoutStrategy.manifest,
    dataset_ref: datasetRef,
    ...(asOf ? { as_of: asOf } : {}),
    source: "hyperliquid",
    venue: "hyperliquid"
  }).manifest;
  const runId = `sample_backtest_${Date.now()}`;
  const report = await runCandleBacktest({
    run_id: runId,
    strategy: movingAverageBreakoutStrategy,
    object_store: store,
    dataset_ref: dataset.dataset_ref,
    candle_refs: normalizedRefsFor(dataset, "candles").map((ref) => ref.ref),
    raw_artifact_refs: dataset.raw_refs.map((rawRef) => rawRef.ref),
    generated_at: new Date().toISOString(),
    initial_equity_usd: 10_000,
    fee_bps: feeBps,
    slippage_model: () => ({
      slippage_bps: slippageBps,
      source_ref: `slippage/fixed/${slippageBps}bps`
    }),
    mode: "paper",
    risk_policy_ref: "risk/sample"
  });
  const reportRef = `backtests/${runId}/report.json`;
  store.putJson(reportRef, report);

  options.emitOut(`report: ${reportRef}`);
  options.emitOut(`trade_ledger: ${report.trade_ledger_ref}`);
  options.emitOut(`trades: ${report.metrics.trades}`);
}

async function commandGate(options: {
  argv: string[];
  cwd: string;
  emitOut: (line: string) => void;
  home: OpenStratHome;
}): Promise<void> {
  const subcommand = options.argv.shift();
  switch (subcommand) {
    case "create-sample":
      await commandGateCreateSample(options);
      return;
    case "inspect":
      await commandGateInspect(options);
      return;
    case "create-local":
      await commandGateCreateLocal(options);
      return;
    default:
      throw new Error("Usage: openstrat gate <create-local|create-sample|inspect>");
  }
}

async function commandGateCreateSample(options: {
  argv: string[];
  emitOut: (line: string) => void;
  home: OpenStratHome;
}): Promise<void> {
  ensureOpenStratHome(options.home);
  const strategyRef = requiredFlag(options.argv, "--strategy-ref");
  const backtestReportRef = requiredFlag(options.argv, "--backtest-report-ref");
  const riskPolicyRef = requiredFlag(options.argv, "--risk-policy-ref");
  const readiness = sampleGateReadiness(options.argv);
  const store = new FileObjectStore(options.home.objectsDir);
  const report = BacktestReportSchema.parse(store.getJson(backtestReportRef));
  if (report.strategy_id !== strategyRef) {
    throw new Error(
      `Strategy ref ${strategyRef} does not match backtest report strategy ${report.strategy_id}`
    );
  }

  const createdAt = new Date().toISOString();
  const gate = DeploymentGateSchema.parse({
    id: `sample_gate_${Date.now()}_${readiness}`,
    created_at: createdAt,
    strategy_id: strategyRef,
    strategy_version: report.strategy_version,
    backtest: {
      dataset_ref: report.dataset_ref,
      min_win_rate: 0,
      min_trades: 1,
      max_drawdown_pct: 100,
      include_fees: readiness === "ready",
      include_slippage_model: readiness === "ready"
    },
    deployment: {
      mode: "paper_trading",
      duration_hours: 12,
      max_notional_usd: 1000,
      max_daily_loss_usd: 250,
      kill_switch: readiness !== "ready"
    },
    required_reviews: readiness === "ready" ? ["risk"] : []
  });
  const inspection = await inspectGateWithGateway(options.home, store, gate);
  const gateRef = `deployment-gates/${gate.id}.json`;
  const artifactRef = `deployment-gate-artifacts/${gate.id}.json`;
  const artifact: DeploymentGateArtifact = {
    artifact_ref: artifactRef,
    created_at: createdAt,
    gate_ref: gateRef,
    strategy_ref: strategyRef,
    backtest_report_ref: backtestReportRef,
    risk_policy_ref: riskPolicyRef,
    inspection
  };
  store.putJson(gateRef, gate);
  store.putJson(artifactRef, artifact);

  options.emitOut(`gate: ${gateRef}`);
  options.emitOut(`artifact: ${artifactRef}`);
  options.emitOut(`ready: ${inspection.ready ? "yes" : "no"}`);
  for (const requirement of inspection.missing_requirements) {
    options.emitOut(`missing: ${requirement}`);
  }
}

async function commandGateInspect(options: {
  argv: string[];
  emitOut: (line: string) => void;
  home: OpenStratHome;
}): Promise<void> {
  const ref = options.argv[0];
  if (!ref) {
    throw new Error("Usage: openstrat gate inspect <GATE_OR_ARTIFACT_REF>");
  }

  const store = new FileObjectStore(options.home.objectsDir);
  const raw = store.getJson<unknown>(ref);
  if (isDeploymentGateArtifact(raw)) {
    options.emitOut(
      JSON.stringify(
        {
          gate_ref: raw.gate_ref,
          artifact_ref: ref,
          ...raw.inspection
        },
        null,
        2
      )
    );
    return;
  }
  const loaded = readDeploymentGateRef(store, ref);
  const inspection = await inspectGateWithGateway(options.home, store, loaded.gate);
  options.emitOut(
    JSON.stringify(
      {
        gate_ref: loaded.gate_ref,
        ...(loaded.artifact_ref ? { artifact_ref: loaded.artifact_ref } : {}),
        ...inspection
      },
      null,
      2
    )
  );
}

async function commandGateCreateLocal(options: {
  argv: string[];
  cwd: string;
  emitOut: (line: string) => void;
  home: OpenStratHome;
}): Promise<void> {
  ensureOpenStratHome(options.home);
  const registration = registerProject(options.home, options.cwd);
  const store = new FileObjectStore(options.home.objectsDir);
  const backtestReportRef = requiredFlag(options.argv, "--backtest-report-ref");
  const riskPolicyRef = requiredFlag(options.argv, "--risk-policy-ref");
  const report = BacktestReportSchema.parse(store.getJson(backtestReportRef));
  const minTrades = optionalNumberFlag(options.argv, "--min-trades") ?? 1;
  const minWinRate = optionalNumberFlag(options.argv, "--min-win-rate") ?? 0;
  const maxDrawdownPct = optionalNumberFlag(options.argv, "--max-drawdown-pct") ?? 100;
  const maxAgeMinutes = optionalNumberFlag(options.argv, "--max-age-minutes");
  const createdAt = new Date().toISOString();
  const gate = DeploymentGateSchema.parse({
    id: `local_gate_${Date.now()}_${safeRefSegment(report.strategy_id)}`,
    created_at: createdAt,
    strategy_id: report.strategy_id,
    strategy_version: report.strategy_version,
    backtest: {
      dataset_ref: report.dataset_ref,
      min_win_rate: minWinRate,
      min_trades: minTrades,
      max_drawdown_pct: maxDrawdownPct,
      include_fees: true,
      include_slippage_model: true
    },
    deployment: {
      mode: "paper_trading",
      duration_hours: 12,
      max_notional_usd: 1000,
      max_daily_loss_usd: 250,
      kill_switch: false
    },
    required_reviews: []
  });
  const inspection = await inspectLocalGateEvidence({
    createdAt,
    gate,
    home: options.home,
    report,
    store,
    ...(maxAgeMinutes !== undefined ? { maxAgeMinutes } : {})
  });
  const gateRef = projectObjectRef(registration, "gates", gate.id, "gate.json");
  const artifactRef = projectObjectRef(registration, "gates", gate.id, "artifact.json");
  const artifact: DeploymentGateArtifact = {
    artifact_ref: artifactRef,
    created_at: createdAt,
    gate_ref: gateRef,
    strategy_ref: report.strategy_id,
    backtest_report_ref: backtestReportRef,
    risk_policy_ref: riskPolicyRef,
    inspection
  };
  store.putJson(gateRef, gate);
  store.putJson(artifactRef, artifact);

  options.emitOut(`gate: ${gateRef}`);
  options.emitOut(`artifact: ${artifactRef}`);
  options.emitOut(`ready: ${inspection.ready ? "yes" : "no"}`);
  for (const requirement of inspection.missing_requirements) {
    options.emitOut(`missing: ${requirement}`);
  }
}

async function commandDeploy(options: {
  argv: string[];
  cwd: string;
  emitOut: (line: string) => void;
  home: OpenStratHome;
}): Promise<void> {
  const subcommand = options.argv.shift();
  switch (subcommand) {
    case "plan":
      await commandDeployPlan(options);
      return;
    case "handoff":
      await commandDeployHandoff(options);
      return;
    default:
      throw new Error("Usage: openstrat deploy <plan --gate-ref|handoff --target>");
  }
}

async function commandDeployPlan(options: {
  argv: string[];
  emitOut: (line: string) => void;
  home: OpenStratHome;
}): Promise<void> {
  const gateRef = requiredFlag(options.argv, "--gate-ref");
  const store = new FileObjectStore(options.home.objectsDir);
  const loaded = readDeploymentGateRef(store, gateRef);
  const inspection = await inspectGateWithGateway(options.home, store, loaded.gate);
  if (!inspection.ready) {
    throw new Error(
      `deployment gate is not ready: ${inspection.missing_requirements.join("; ")}`
    );
  }

  options.emitOut("deployment plan: local_terminal");
  options.emitOut(`gate: ${loaded.gate_ref}`);
  options.emitOut(`strategy: ${loaded.gate.strategy_id}`);
  options.emitOut(`mode: ${loaded.gate.deployment.mode}`);
  options.emitOut(`duration_hours: ${loaded.gate.deployment.duration_hours}`);
  options.emitOut(`max_notional_usd: ${loaded.gate.deployment.max_notional_usd}`);
}

async function commandDeployHandoff(options: {
  argv: string[];
  cwd: string;
  emitOut: (line: string) => void;
  home: OpenStratHome;
}): Promise<void> {
  ensureOpenStratHome(options.home);
  const targetKind = requiredFlag(options.argv, "--target");
  const gateRef = requiredFlag(options.argv, "--gate-ref");
  const backtestReportRef = requiredFlag(options.argv, "--backtest-report-ref");
  const riskPolicyRef = requiredFlag(options.argv, "--risk-policy-ref");
  const strategyManifestRef = requiredFlag(options.argv, "--strategy-manifest-ref");
  const decisionRef = stringFlag(options.argv, "--decision-ref");
  const memoryProposalRef = stringFlag(options.argv, "--memory-proposal-ref");
  const store = new FileObjectStore(options.home.objectsDir);
  const loadedGate = readDeploymentGateRef(store, gateRef);
  const gateInspection = await inspectGateWithGateway(
    options.home,
    store,
    loadedGate.gate
  );
  if (!gateInspection.ready) {
    throw new Error(
      `deployment gate is not ready: ${gateInspection.missing_requirements.join("; ")}`
    );
  }

  const report = BacktestReportSchema.parse(store.getJson(backtestReportRef));
  if (report.strategy_id !== loadedGate.gate.strategy_id) {
    throw new Error("Deployment handoff refs must point at the same strategy");
  }
  ensureSampleStrategyManifest(store, strategyManifestRef, loadedGate.gate);

  const createdAt = new Date().toISOString();
  const durationMs = loadedGate.gate.deployment.duration_hours * 60 * 60 * 1000;
  const manifest = BotRunManifestSchema.parse({
    id: `bot_run_${Date.now()}_${safeRefSegment(
      loadedGate.gate.strategy_id
    )}_${safeRefSegment(targetKind)}`,
    strategy_id: loadedGate.gate.strategy_id,
    strategy_version: loadedGate.gate.strategy_version,
    deployment_gate_id: loadedGate.gate.id,
    target: deploymentTargetFromArgs(options.argv, targetKind, options.cwd),
    runtime: {
      mode: runtimeModeForGate(loadedGate.gate),
      heartbeat_interval_ms: 30_000,
      max_runtime_ms: durationMs,
      reliability_boundary_acknowledged:
        targetKind !== "local_terminal" ||
        options.argv.includes("--ack-local-reliability")
    },
    approval_refs: {
      strategy_manifest_ref: strategyManifestRef,
      deployment_gate_ref: gateRef,
      backtest_report_ref: backtestReportRef,
      risk_policy_ref: riskPolicyRef
    },
    created_at: createdAt,
    starts_at: createdAt,
    ends_at: new Date(Date.parse(createdAt) + durationMs).toISOString()
  });
  const provider = deploymentProviderFor(manifest.target.kind);
  const plan = provider.prepare(manifest);
  const validation = provider.validate(plan);
  const refs = deploymentHandoffRefs(manifest.id);
  store.putJson(refs.manifest_ref, manifest);
  store.putJson(refs.plan_ref, plan);
  store.putJson(refs.handoff_ref, {
    id: `${manifest.id}_handoff`,
    created_at: createdAt,
    manifest_ref: refs.manifest_ref,
    plan_ref: refs.plan_ref,
    provider_kind: plan.provider_kind,
    remote: plan.remote,
    launch: "not_launched",
    validation,
    ...(decisionRef ? { decision_ref: decisionRef } : {}),
    ...(memoryProposalRef ? { memory_proposal_ref: memoryProposalRef } : {})
  });

  const events = new SqliteEventLog(options.home.stateDbPath);
  try {
    events.append({
      stream_id: `deployment-handoffs/${manifest.id}`,
      type: "deployment.handoff.created",
      occurred_at: createdAt,
      payload: {
        manifest_ref: refs.manifest_ref,
        plan_ref: refs.plan_ref,
        handoff_ref: refs.handoff_ref,
        provider_kind: plan.provider_kind,
        remote: plan.remote,
        validation
      }
    });
  } finally {
    events.close();
  }

  options.emitOut(`manifest: ${refs.manifest_ref}`);
  options.emitOut(`plan: ${refs.plan_ref}`);
  options.emitOut(`handoff: ${refs.handoff_ref}`);
  options.emitOut(`target: ${plan.target_kind}`);
  options.emitOut(`remote: ${plan.remote ? "yes" : "no"}`);
  options.emitOut(`validation: ${validation.ok ? "ok" : validation.errors.join("; ")}`);
}

async function commandLedger(options: {
  argv: string[];
  emitOut: (line: string) => void;
  home: OpenStratHome;
}): Promise<void> {
  const subcommand = options.argv.shift();
  switch (subcommand) {
    case "record-sample":
      commandLedgerRecordSample(options);
      return;
    case "list":
      commandLedgerList(options);
      return;
    default:
      throw new Error("Usage: openstrat ledger <record-sample|list>");
  }
}

function commandLedgerRecordSample(options: {
  argv: string[];
  emitOut: (line: string) => void;
  home: OpenStratHome;
}): void {
  ensureOpenStratHome(options.home);
  const strategyRef = requiredFlag(options.argv, "--strategy-ref");
  const datasetRef = requiredFlag(options.argv, "--dataset-ref");
  const backtestReportRef = requiredFlag(options.argv, "--backtest-report-ref");
  const gateRef = requiredFlag(options.argv, "--gate-ref");
  const store = new FileObjectStore(options.home.objectsDir);
  const report = BacktestReportSchema.parse(store.getJson(backtestReportRef));
  const gate = readDeploymentGateRef(store, gateRef).gate;
  if (report.strategy_id !== strategyRef || gate.strategy_id !== strategyRef) {
    throw new Error("Decision ledger refs must point at the same strategy");
  }

  const createdAt = new Date().toISOString();
  const entry = DecisionLedgerEntrySchema.parse({
    id: `decision_${Date.now()}_${safeRefSegment(strategyRef)}`,
    created_at: createdAt,
    strategy_id: strategyRef,
    strategy_version: report.strategy_version,
    run_id: report.run_id,
    thesis:
      "Sample strategy has fixture-backed evidence sufficient to continue gated paper deployment planning.",
    evidence_refs: [datasetRef, backtestReportRef, gateRef],
    assumptions: [
      "Fixture market data is only representative for scaffolding.",
      "Backtest report includes the configured fee and slippage inputs."
    ],
    invalidation_conditions: [
      "Deployment gate becomes not ready.",
      "Additional backtest evidence contradicts the sample thesis."
    ],
    confidence: "low",
    created_by: {
      agent_id: "openstrat-cli",
      model: "sample-fixture",
      role: "strategy_research_harness"
    },
    tags: ["sample", "e2e-scaffolding"]
  });
  const decisionRef = `decision-ledgers/${entry.id}.json`;
  store.putJson(decisionRef, entry);

  const events = new SqliteEventLog(options.home.stateDbPath);
  try {
    events.append({
      stream_id: `decision-ledgers/${strategyRef}`,
      type: "agent.decision.recorded",
      occurred_at: createdAt,
      payload: {
        decision_id: entry.id,
        decision_ref: decisionRef,
        strategy_id: entry.strategy_id,
        evidence_refs: entry.evidence_refs
      }
    });
  } finally {
    events.close();
  }

  options.emitOut(`decision: ${decisionRef}`);
  options.emitOut(`strategy: ${entry.strategy_id}`);
  options.emitOut(`evidence_refs: ${entry.evidence_refs.length}`);
}

function commandLedgerList(options: {
  emitOut: (line: string) => void;
  home: OpenStratHome;
}): void {
  const store = new FileObjectStore(options.home.objectsDir);
  const refs = listObjectRefs(options.home, "decision-ledgers");
  if (refs.length === 0) {
    options.emitOut("No decision ledger entries found.");
    return;
  }

  for (const ref of refs) {
    const entry = DecisionLedgerEntrySchema.parse(store.getJson(ref));
    options.emitOut(`${entry.id} ${entry.strategy_id} ${ref}`);
  }
}

async function commandMemory(options: {
  argv: string[];
  emitOut: (line: string) => void;
  home: OpenStratHome;
}): Promise<void> {
  const subcommand = options.argv.shift();
  switch (subcommand) {
    case "propose-sample":
      await commandMemoryProposeSample(options);
      return;
    case "list":
      commandMemoryList(options);
      return;
    default:
      throw new Error("Usage: openstrat memory <propose-sample|list>");
  }
}

async function commandMemoryProposeSample(options: {
  argv: string[];
  emitOut: (line: string) => void;
  home: OpenStratHome;
}): Promise<void> {
  ensureOpenStratHome(options.home);
  const decisionRef = requiredFlag(options.argv, "--decision-ref");
  const backtestReportRef = requiredFlag(options.argv, "--backtest-report-ref");
  const gateRef = requiredFlag(options.argv, "--gate-ref");
  const store = new FileObjectStore(options.home.objectsDir);
  const decision = DecisionLedgerEntrySchema.parse(store.getJson(decisionRef));
  BacktestReportSchema.parse(store.getJson(backtestReportRef));
  readDeploymentGateRef(store, gateRef);

  const createdAt = new Date().toISOString();
  const sessionId = "cli_memory";
  const turnId = "turn_memory_sample";
  const proposalId = `memory_proposal_${Date.now()}_${safeRefSegment(
    decision.strategy_id
  )}`;
  const proposal = await withCliAgentToolGateway(options.home, store, (gateway) =>
    gateway.captureMemoryProposal({
      call_id: `cli_memory_${proposalId}`,
      session_id: sessionId,
      turn_id: turnId,
      proposal: {
        id: proposalId,
        created_at: createdAt,
        session_id: sessionId,
        turn_id: turnId,
        status: "proposed",
        subject_type: "strategy",
        subject_id: decision.strategy_id,
        claim:
          "Treat this sample decision as evidence-linked scaffolding, not promoted trading memory.",
        evidence_refs: [decisionRef, backtestReportRef, gateRef],
        confidence: "low",
        allowed_uses: ["strategy_review", "research_context"],
        forbidden_uses: ["auto_promote_to_strategy", "live_trading_without_review"],
        expiry_or_recheck: "before provider deployment",
        dissent: [
          "Two-candle fixture evidence is insufficient for causal performance memory."
        ],
        requires_human_review: true,
        artifact_ref: proposalArtifactRef(sessionId, proposalId, createdAt, {
          decision_ref: decisionRef,
          backtest_report_ref: backtestReportRef,
          gate_ref: gateRef
        })
      }
    })
  );

  options.emitOut(`proposal: ${proposal.id}`);
  options.emitOut(`artifact: ${proposal.artifact_ref.uri}`);
  options.emitOut(`status: ${proposal.status}`);
  options.emitOut(
    `requires_human_review: ${proposal.requires_human_review ? "yes" : "no"}`
  );
}

function commandMemoryList(options: {
  emitOut: (line: string) => void;
  home: OpenStratHome;
}): void {
  const store = new FileObjectStore(options.home.objectsDir);
  const refs = listObjectRefs(options.home, "agent-artifacts");
  const proposals = refs
    .map((ref) => ({
      ref,
      proposal: MemoryProposalSchema.safeParse(store.getJson(ref))
    }))
    .filter((entry) => entry.proposal.success);
  if (proposals.length === 0) {
    options.emitOut("No memory proposals found.");
    return;
  }

  for (const entry of proposals) {
    if (entry.proposal.success) {
      const proposal = entry.proposal.data;
      options.emitOut(
        `${proposal.id} ${proposal.subject_type}:${proposal.subject_id} ${proposal.status} ${entry.ref}`
      );
    }
  }
}

async function commandStrategy(options: {
  argv: string[];
  cwd: string;
  emitOut: (line: string) => void;
  home: OpenStratHome;
  setJsonData: SetCliJsonData;
}): Promise<void> {
  const subcommand = options.argv.shift();
  switch (subcommand) {
    case "init":
      commandStrategyInit(options);
      return;
    case "validate":
      await commandStrategyValidate(options);
      return;
    case "propose-sample":
      commandStrategyProposeSample(options);
      return;
    default:
      throw new Error("Usage: openstrat strategy <init|validate|propose-sample>");
  }
}

function commandStrategyInit(options: {
  argv: string[];
  cwd: string;
  emitOut: (line: string) => void;
  home: OpenStratHome;
  setJsonData: SetCliJsonData;
}): void {
  ensureOpenStratHome(options.home);
  const registration = registerProject(options.home, options.cwd);
  const strategyId = stringFlag(options.argv, "--strategy-id") ?? "local_strategy";
  const safeStrategyId = safeRefSegment(strategyId);
  const canonicalSymbol =
    stringFlag(options.argv, "--symbol")?.toUpperCase() ?? "BTC-PERP";
  const interval = stringFlag(options.argv, "--interval") ?? "15m";
  const manifestRel =
    stringFlag(options.argv, "--manifest") ?? "openstrat.strategy.json";
  const entrypointRel =
    stringFlag(options.argv, "--entrypoint") ?? `strategies/${safeStrategyId}.ts`;
  const manifestPath = resolveWorkspacePath(
    options.cwd,
    manifestRel,
    "strategy manifest"
  );
  const entrypointPath = resolveWorkspacePath(
    options.cwd,
    entrypointRel,
    "strategy entrypoint"
  );
  const manifest = StrategyManifestSchema.parse({
    strategy_id: strategyId,
    strategy_version: "0.1.0",
    name: titleFromStrategyId(strategyId),
    description: "Local OpenStrat strategy scaffold.",
    runtime: "typescript",
    entrypoint: toPosixPath(relative(resolve(options.cwd), entrypointPath)),
    autonomy_mode: "strategy_workbench",
    allowed_symbols: [canonicalSymbol],
    parameters: {},
    required_data: [
      {
        kind: "candles",
        canonical_symbol: canonicalSymbol,
        interval
      }
    ],
    output: "trade_intent",
    created_at: new Date().toISOString(),
    source_refs: []
  });

  assertNewFile(manifestPath);
  assertNewFile(entrypointPath);
  writeNewFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  writeNewFile(entrypointPath, localStrategySource(strategyId));

  const objectRoot = projectObjectRoot(registration);
  options.setJsonData({
    command: "strategy",
    subcommand: "init",
    home: options.home.root,
    project: registration,
    project_object_root: objectRoot,
    manifest_path: manifestPath,
    source_path: entrypointPath
  });
  options.emitOut(`home: ${options.home.root}`);
  options.emitOut(`project: ${registration.id}`);
  options.emitOut(`project_objects: ${objectRoot}`);
  options.emitOut(
    `manifest: ${toPosixPath(relative(resolve(options.cwd), manifestPath))}`
  );
  options.emitOut(
    `source: ${toPosixPath(relative(resolve(options.cwd), entrypointPath))}`
  );
}

async function commandStrategyValidate(options: {
  argv: string[];
  cwd: string;
  emitOut: (line: string) => void;
  home: OpenStratHome;
  setJsonData: SetCliJsonData;
}): Promise<void> {
  ensureOpenStratHome(options.home);
  const registration = registerProject(options.home, options.cwd);
  const store = new FileObjectStore(options.home.objectsDir);
  const sample = stringFlag(options.argv, "--sample");
  const loadedStrategy: LoadedLocalStrategy = sample
    ? { strategy: sampleStrategy(sample) }
    : await loadLocalStrategy(
        options.cwd,
        stringFlag(options.argv, "--manifest") ?? "openstrat.strategy.json"
      );
  const strategy = loadedStrategy.strategy;
  const datasetRef = stringFlag(options.argv, "--dataset-ref");
  const asOf = stringFlag(options.argv, "--as-of");
  const datasetPreflight = datasetRef
    ? preflightStrategyDatasetCompatibility({
        object_store: store,
        strategy: strategy.manifest,
        dataset_ref: datasetRef,
        ...(asOf ? { as_of: asOf } : {})
      })
    : undefined;
  const result = await createStrategyRunner().evaluate(strategy, {
    now: asOf ?? "2026-06-04T00:45:00.000Z",
    mode: "paper",
    risk_policy_ref: "risk/sample",
    decision_ref: "strategy-workbench/validation",
    market_events: sampleStrategyMarketEvents(strategy.manifest.allowed_symbols[0])
  });
  const createdAt = new Date().toISOString();
  const validationRef = projectObjectRef(
    registration,
    "workbench",
    "strategy-validations",
    safeRefSegment(strategy.manifest.strategy_id),
    `${timestampRefSegment(createdAt)}.json`
  );
  const objectRoot = projectObjectRoot(registration);
  const artifact: StrategyValidationArtifact = {
    validation_ref: validationRef,
    created_at: createdAt,
    project: {
      id: registration.id,
      cwd: registration.cwd,
      registration_ref: registration.ref,
      object_root: objectRoot
    },
    strategy: strategy.manifest,
    ...(loadedStrategy.manifest_path
      ? { manifest_path: loadedStrategy.manifest_path }
      : {}),
    ...(loadedStrategy.source_path ? { source_path: loadedStrategy.source_path } : {}),
    ...(datasetPreflight
      ? {
          dataset_preflight: {
            dataset_ref: datasetPreflight.manifest.dataset_ref,
            required_families: datasetPreflight.required_families,
            validation: {
              valid: datasetPreflight.validation.valid,
              missing_requirements: datasetPreflight.validation.missing_requirements
            }
          }
        }
      : {}),
    evaluation: {
      intents: result.intents.length
    }
  };
  store.putJson(validationRef, artifact);
  options.setJsonData({
    command: "strategy",
    subcommand: "validate",
    validation_ref: validationRef,
    project_id: registration.id,
    project_object_root: objectRoot,
    strategy_id: strategy.manifest.strategy_id,
    intents: result.intents.length,
    ...(datasetPreflight ? { dataset_ref: datasetPreflight.manifest.dataset_ref } : {})
  });

  options.emitOut(`strategy valid: ${strategy.manifest.strategy_id}`);
  options.emitOut(`intents: ${result.intents.length}`);
  options.emitOut(`validation: ${validationRef}`);
  options.emitOut(`home: ${options.home.root}`);
  options.emitOut(`project: ${registration.id}`);
  options.emitOut(`project_objects: ${objectRoot}`);
  if (datasetPreflight) {
    options.emitOut(`dataset_preflight: ${datasetPreflight.manifest.dataset_ref}`);
  }
}

function commandStrategyProposeSample(options: {
  argv: string[];
  cwd: string;
  emitOut: (line: string) => void;
  home: OpenStratHome;
  setJsonData: SetCliJsonData;
}): void {
  ensureOpenStratHome(options.home);
  const registration = registerProject(options.home, options.cwd);
  const strategyId =
    stringFlag(options.argv, "--strategy-id") ?? "sample_moving_average_breakout";
  const objects = new FileObjectStore(options.home.objectsDir);
  const events = new SqliteEventLog(options.home.stateDbPath);
  const objectRoot = projectObjectRoot(registration);
  try {
    const workflowDependencies = {
      events,
      object_ref_root: objectRoot,
      objects,
      now: () => "2026-06-04T00:45:00.000Z"
    };
    const workflow = createStrategyProposalWorkflow(workflowDependencies);
    const proposal = workflow.capturePatchBundle({
      session_id: "cli_strategy_workbench",
      turn_id: "turn_strategy_sample",
      strategy_id: strategyId,
      base_strategy_version: "0.1.0",
      rationale:
        "Capture the sample moving-average breakout strategy as a scratch proposal.",
      files: [
        {
          path: `strategies/${strategyId}.ts`,
          content: SAMPLE_STRATEGY_SOURCE
        }
      ]
    });

    options.setJsonData({
      command: "strategy",
      subcommand: "propose-sample",
      project_id: registration.id,
      project_object_root: objectRoot,
      proposal_id: proposal.id,
      artifact_ref: proposal.artifact_ref.uri,
      patch_ref: proposal.patch_ref
    });
    options.emitOut(`proposal: ${proposal.id}`);
    options.emitOut(`artifact: ${proposal.artifact_ref.uri}`);
    options.emitOut(`patch: ${proposal.patch_ref}`);
    options.emitOut(`home: ${options.home.root}`);
    options.emitOut(`project: ${registration.id}`);
    options.emitOut(`project_objects: ${objectRoot}`);
  } finally {
    events.close();
  }
}

interface LoadedLocalStrategy {
  strategy: StrategyModule;
  manifest_path?: string;
  source_path?: string;
}

async function loadLocalStrategy(
  cwd: string,
  manifestInput: string
): Promise<LoadedLocalStrategy> {
  const manifestPath = resolveWorkspacePath(cwd, manifestInput, "strategy manifest");
  const manifest = StrategyManifestSchema.parse(
    JSON.parse(readFileSync(manifestPath, "utf8"))
  );
  if (manifest.runtime !== "typescript" && manifest.runtime !== "javascript") {
    throw new Error(
      `Unsupported local strategy runtime: ${manifest.runtime}. Use typescript or javascript.`
    );
  }

  const sourcePath = resolveWorkspacePath(
    cwd,
    manifest.entrypoint,
    "strategy entrypoint"
  );
  const imported = (await import(
    `${pathToFileURL(sourcePath).href}?openstrat=${Date.now()}`
  )) as unknown;
  const evaluate = strategyEvaluateFromModule(imported, manifest);
  return {
    manifest_path: manifestPath,
    source_path: sourcePath,
    strategy: {
      manifest,
      evaluate
    }
  };
}

function strategyEvaluateFromModule(
  imported: unknown,
  manifest: StrategyManifest
): StrategyModule["evaluate"] {
  const module = imported as {
    evaluate?: unknown;
    strategy?: { evaluate?: unknown; manifest?: unknown };
  };
  if (typeof module.evaluate === "function") {
    return module.evaluate as StrategyModule["evaluate"];
  }

  if (module.strategy && typeof module.strategy.evaluate === "function") {
    const exportedManifest = StrategyManifestSchema.safeParse(module.strategy.manifest);
    if (
      exportedManifest.success &&
      exportedManifest.data.strategy_id !== manifest.strategy_id
    ) {
      throw new Error(
        `Strategy module manifest ${exportedManifest.data.strategy_id} does not match manifest ${manifest.strategy_id}`
      );
    }
    return module.strategy.evaluate as StrategyModule["evaluate"];
  }

  throw new Error(
    "Strategy entrypoint must export evaluate(context) or strategy.evaluate"
  );
}

function resolveWorkspacePath(cwd: string, inputPath: string, label: string): string {
  if (!inputPath || inputPath.includes("\0")) {
    throw new Error(`Invalid ${label} path: ${inputPath}`);
  }
  const workspaceRoot = resolve(cwd);
  const resolvedPath = resolve(workspaceRoot, inputPath);
  const fromWorkspace = relative(workspaceRoot, resolvedPath);
  if (
    fromWorkspace === "" ||
    fromWorkspace.startsWith("..") ||
    isAbsolute(fromWorkspace)
  ) {
    throw new Error(`${label} path must stay inside the project workspace`);
  }
  return resolvedPath;
}

function writeNewFile(path: string, contents: string): void {
  assertNewFile(path);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, "utf8");
}

function assertNewFile(path: string): void {
  if (existsSync(path)) {
    throw new Error(`Refusing to overwrite existing file: ${path}`);
  }
}

function localStrategySource(strategyId: string): string {
  return `export function evaluate(_input: unknown) {
  return [];
}

export const strategyId = ${JSON.stringify(strategyId)};
`;
}

function titleFromStrategyId(strategyId: string): string {
  return strategyId
    .split(/[_-]+/u)
    .filter((part) => part.length > 0)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
}

function timestampRefSegment(isoTimestamp: string): string {
  return isoTimestamp.replace(/[:]/gu, "-");
}

function toPosixPath(path: string): string {
  return path.replace(/\\/gu, "/");
}

async function commandMarket(options: {
  argv: string[];
  emitOut: (line: string) => void;
  env: Record<string, string | undefined>;
  home: OpenStratHome;
  setJsonData: SetCliJsonData;
}): Promise<void> {
  const subcommand = options.argv.shift();
  switch (subcommand) {
    case "ingest-fixture":
      await commandMarketIngestFixture(options);
      return;
    case "ingest-live":
      await commandMarketIngestLive(options);
      return;
    case "list":
      commandMarketList(options);
      return;
    case "snapshot":
      commandMarketSnapshot(options);
      return;
    default:
      throw new Error(
        "Usage: openstrat market <ingest-fixture|ingest-live|list|snapshot> [options]"
      );
  }
}

async function commandMarketIngestFixture(options: {
  argv: string[];
  emitOut: (line: string) => void;
  home: OpenStratHome;
  setJsonData: SetCliJsonData;
}): Promise<void> {
  ensureOpenStratHome(options.home);
  const symbol = stringFlag(options.argv, "--symbol")?.toUpperCase() ?? "BTC";
  const interval = stringFlag(options.argv, "--interval") ?? "15m";
  if (symbol !== "BTC" || interval !== "15m") {
    throw new Error("Fixture ingest currently supports --symbol BTC --interval 15m");
  }

  const store = new FileObjectStore(options.home.objectsDir);
  const client = createFixtureHyperliquidClient();
  const result = await ingestHyperliquidWindow({
    client,
    object_store: store,
    coin: symbol,
    interval: "15m",
    start_time_ms: 1681923600000,
    end_time_ms: 1681927200000,
    received_at: MARKET_FIXTURE_RECEIVED_AT
  });
  options.setJsonData({
    command: "market",
    subcommand: "ingest-fixture",
    dataset_ref: result.dataset_ref,
    dataset_manifest: result.dataset_manifest,
    dataset_index_entry: result.dataset_index_entry,
    registry_ref: result.registry_ref,
    latest_price_ref: result.latest_price_ref,
    price_refs: result.price_refs,
    raw_refs: result.raw_refs
  });

  options.emitOut(`dataset: ${result.dataset_ref}`);
  options.emitOut(`registry: ${result.registry_ref}`);
  options.emitOut(`latest_price: ${result.latest_price_ref}`);
  options.emitOut(`raw: ${result.raw_refs.meta_and_asset_ctxs}`);
}

async function commandMarketIngestLive(options: {
  argv: string[];
  emitOut: (line: string) => void;
  env: Record<string, string | undefined>;
  home: OpenStratHome;
  setJsonData: SetCliJsonData;
}): Promise<void> {
  ensureOpenStratHome(options.home);
  if (!options.argv.includes("--confirm-live")) {
    throw new Error(
      "Live market ingest requires --confirm-live because it reads the live Hyperliquid API"
    );
  }

  const symbol = requiredFlag(options.argv, "--symbol").toUpperCase();
  const coin = hyperliquidCoinFromSymbol(symbol);
  const interval = CandleIntervalSchema.parse(
    stringFlag(options.argv, "--interval") ?? "15m"
  );
  const endTimeMs = optionalNumberFlag(options.argv, "--end-time-ms") ?? Date.now();
  const lookbackMinutes = optionalNumberFlag(options.argv, "--lookback-minutes") ?? 60;
  const startTimeMs =
    optionalNumberFlag(options.argv, "--start-time-ms") ??
    endTimeMs - lookbackMinutes * 60_000;
  if (startTimeMs >= endTimeMs) {
    throw new Error("--start-time-ms must be before --end-time-ms");
  }

  const receivedAt =
    stringFlag(options.argv, "--received-at") ?? new Date().toISOString();
  const store = new FileObjectStore(options.home.objectsDir);
  const client =
    options.env.OPENSTRAT_FAKE_HYPERLIQUID === "1"
      ? createFixtureHyperliquidClient(coin)
      : new HyperliquidInfoClient();
  const result = await ingestHyperliquidWindow({
    client,
    object_store: store,
    coin,
    interval,
    start_time_ms: startTimeMs,
    end_time_ms: endTimeMs,
    received_at: receivedAt,
    acquisition_method: "guarded_live"
  });
  const validation = validateMarketDataset(store, result.dataset_ref, {
    as_of: receivedAt,
    canonical_symbol: `${coin}-PERP`,
    source: "hyperliquid",
    venue: "hyperliquid",
    required_families: [
      "market_registry",
      "mark_prices",
      "candles",
      "funding_rates",
      "orderbook_snapshots"
    ]
  });

  options.setJsonData({
    command: "market",
    subcommand: "ingest-live",
    dataset_ref: result.dataset_ref,
    dataset_manifest: result.dataset_manifest,
    dataset_index_entry: result.dataset_index_entry,
    registry_ref: result.registry_ref,
    latest_price_ref: result.latest_price_ref,
    price_refs: result.price_refs,
    raw_refs: result.raw_refs,
    validation
  });

  options.emitOut(`dataset: ${result.dataset_ref}`);
  options.emitOut(`registry: ${result.registry_ref}`);
  options.emitOut(`latest_price: ${result.latest_price_ref}`);
  options.emitOut(`validation: ${validation.valid ? "valid" : "invalid"}`);
}

function commandMarketList(options: {
  emitOut: (line: string) => void;
  home: OpenStratHome;
  setJsonData: SetCliJsonData;
}): void {
  const store = new FileObjectStore(options.home.objectsDir);
  const datasets = listMarketDatasetRefs(options.home).map((ref) =>
    getMarketDatasetManifest(store, ref)
  );
  options.setJsonData({
    command: "market",
    subcommand: "list",
    datasets: datasets.map(marketDatasetListItem)
  });
  if (datasets.length === 0) {
    options.emitOut("No market datasets found.");
    return;
  }

  for (const dataset of datasets) {
    options.emitOut(
      `${dataset.canonical_symbol} ${dataset.source} ${dataset.venue} ${dataset.dataset_ref}`
    );
  }
}

function commandMarketSnapshot(options: {
  argv: string[];
  emitOut: (line: string) => void;
  home: OpenStratHome;
  setJsonData: SetCliJsonData;
}): void {
  const canonicalSymbol = options.argv[0];
  if (!canonicalSymbol) {
    throw new Error("Usage: openstrat market snapshot <CANONICAL_SYMBOL>");
  }

  const store = new FileObjectStore(options.home.objectsDir);
  const datasetRef = listMarketDatasetRefs(options.home)
    .map((ref) => getMarketDatasetManifest(store, ref))
    .filter((dataset) => dataset.canonical_symbol === canonicalSymbol)
    .sort((left, right) =>
      right.created_at.localeCompare(left.created_at)
    )[0]?.dataset_ref;
  if (!datasetRef) {
    throw new Error(`Market dataset not found: ${canonicalSymbol}`);
  }

  const dataset = getMarketDatasetManifest(store, datasetRef);
  const registryRef = requireNormalizedRef(dataset, "market_registry").ref;
  const latestPriceRef = requireNormalizedRef(dataset, "mark_prices").ref;
  const registry = store.getJson<{ canonical_symbol: string }[]>(registryRef);
  const market = registry.find(
    (entry) => entry.canonical_symbol === dataset.canonical_symbol
  );
  if (!market) {
    throw new Error(`Market registry entry not found: ${dataset.canonical_symbol}`);
  }

  const latestPrice = store.getJson(latestPriceRef);
  const snapshot = {
    command: "market",
    subcommand: "snapshot",
    dataset_ref: dataset.dataset_ref,
    registry_ref: registryRef,
    latest_price_ref: latestPriceRef,
    market,
    latest_price: latestPrice,
    raw_refs: dataset.raw_refs,
    normalized_refs: dataset.normalized_refs,
    freshness: dataset.freshness,
    source_provenance: dataset.source_provenance
  };
  options.setJsonData(snapshot);
  options.emitOut(JSON.stringify(snapshot, null, 2));
}

async function commandDoctor(options: {
  cwd: string;
  emitOut: (line: string) => void;
  env: Record<string, string | undefined>;
  home: OpenStratHome;
}): Promise<void> {
  const initialized = existsSync(options.home.configPath);
  const project = findProjectRegistration(options.home, options.cwd);
  options.emitOut(`OpenStrat ${cliVersion}`);
  options.emitOut(`home: ${options.home.root}`);
  options.emitOut(`home initialized: ${initialized ? "yes" : "no"}`);
  options.emitOut(`project registered: ${project ? "yes" : "no"}`);
  options.emitOut(
    `Node: ${process.versions.node} (${nodeSatisfies(process.versions.node) ? "ok" : `requires >=${MIN_NODE_VERSION}`})`
  );
  options.emitOut(`Hyperliquid: ${await checkHyperliquid(options.env)}`);
  options.emitOut(
    `Codex auth: ${codexAuthConfigured(options.home) ? "configured" : "missing"}`
  );
  options.emitOut(`Fly: ${checkCliAuth(options.env, "fly", ["auth", "whoami"])}`);
  options.emitOut(`Sprite: ${checkCliAuth(options.env, "sprite", ["auth", "whoami"])}`);
}

async function commandAuth(options: {
  argv: string[];
  emitOut: (line: string) => void;
  env: Record<string, string | undefined>;
  home: OpenStratHome;
}): Promise<void> {
  if (options.argv[0] !== "codex") {
    throw new Error("Usage: openstrat auth codex");
  }
  ensureOpenStratHome(options.home);
  mkdirSync(options.home.authDir, { recursive: true });
  const authPath = getPiAuthPath(options.home);
  if (options.env.OPENSTRAT_FAKE_CODEX_AUTH === "1") {
    writeFakeCodexAuth(authPath);
    options.emitOut(`Codex auth configured via ${CODEX_PROVIDER_ID}`);
    options.emitOut(`auth path: ${authPath}`);
    return;
  }

  const auth = AuthStorage.create(authPath);
  await auth.login(CODEX_PROVIDER_ID, {
    onAuth: (info) => {
      options.emitOut(info.instructions ?? "Open this URL to continue Codex login:");
      options.emitOut(info.url);
    },
    onDeviceCode: (info) => {
      options.emitOut(`Open ${info.verificationUri}`);
      options.emitOut(`Enter code: ${info.userCode}`);
    },
    onManualCodeInput: async () => promptLine("Paste OAuth code: "),
    onProgress: (message) => options.emitOut(message),
    onPrompt: async (prompt) => promptLine(`${prompt.message} `),
    onSelect: async (prompt) => prompt.options[0]?.id
  });
  options.emitOut(`Codex auth configured via ${CODEX_PROVIDER_ID}`);
  options.emitOut(`auth path: ${authPath}`);
}

async function commandChat(options: {
  argv: string[];
  cwd: string;
  emitOut: (line: string) => void;
  env: Record<string, string | undefined>;
  home: OpenStratHome;
}): Promise<void> {
  ensureOpenStratHome(options.home);
  const prompt = await promptFromArgs(options.argv);
  if (!prompt) {
    throw new Error("No prompt provided");
  }

  const runtimeKind = chatRuntimeFromArgs(options.argv, options.env);
  if (runtimeKind === "pi") {
    if (stringFlag(options.argv, "--resume")) {
      throw new Error("Codex chat resume is only supported for codex_app_server");
    }
    await commandPiChat(options, prompt);
    return;
  }
  await commandCodexAppServerChat(options, prompt);
}

async function commandCodexAppServerChat(
  options: {
    argv: string[];
    cwd: string;
    emitOut: (line: string) => void;
    env: Record<string, string | undefined>;
    home: OpenStratHome;
  },
  prompt: string
): Promise<void> {
  const events = new SqliteEventLog(options.home.stateDbPath);
  const resumeSessionId = stringFlag(options.argv, "--resume");
  const sessionId = resumeSessionId ?? `agent_session_${Date.now()}`;
  const bindingStore = new FileCodexAppServerBindingStore(options.home.root);
  const transcriptStore = new FileCodexAppServerTranscriptStore(options.home.root);
  const adapter = new FakeCodexAppServerRuntimeAdapter({
    bindingStore,
    events,
    now: () => new Date().toISOString(),
    runtimeEvents: fakeCodexChatEvents({
      finalOnly: options.env.OPENSTRAT_FAKE_CODEX_FINAL_ONLY === "1"
    }),
    transcriptStore
  });

  const createdAt = new Date().toISOString();
  const manifest = codexChatManifest(options.home, sessionId, createdAt);
  const contextStatusRef = writeProjectStatusArtifact(options.home, options.cwd);
  const existingBinding = resumeSessionId
    ? bindingStore.read(resumeSessionId)
    : undefined;
  if (resumeSessionId && !existingBinding) {
    throw new Error(
      `No Codex app-server binding found for session: ${resumeSessionId}`
    );
  }
  const runtime = existingBinding
    ? await adapter.resumeSession({
        manifest,
        toolNames: existingBinding.enabled_tools,
        codex_thread_id: existingBinding.codex_thread_id,
        transcript_ref: existingBinding.transcript_ref
      })
    : await adapter.startSession({
        manifest,
        toolNames: ["market_data.read_snapshot"]
      });
  await adapter.prompt({
    session_id: sessionId,
    prompt: `${prompt}\n\nOpenStrat project_status_ref: ${contextStatusRef}`
  });
  await adapter.dispose(sessionId);
  const projectStatusRef = writeProjectStatusArtifact(options.home, options.cwd, {
    chat_session_id: sessionId,
    transcript_ref: runtime.transcript_ref
  });

  const stream = events.list(`agent_sessions/${sessionId}`);
  const deltas = stream
    .filter((event) => event.type === "agent.runtime.message_delta")
    .map((event) => (event.payload as { delta?: string }).delta ?? "")
    .join("");
  options.emitOut(
    deltas ||
      finalAssistantTextFromStream(stream) ||
      "OpenStrat chat session completed."
  );
  options.emitOut("runtime: codex_app_server");
  options.emitOut(`session: ${sessionId}`);
  options.emitOut(`codex thread: ${runtime.codex_thread_id}`);
  if (runtime.resumed_from_codex_thread_id) {
    options.emitOut(`resumed codex thread: ${runtime.resumed_from_codex_thread_id}`);
  }
  options.emitOut(`transcript: ${runtime.transcript_ref}`);
  options.emitOut(`project_status: ${projectStatusRef}`);
  options.emitOut(`disabled native tools: ${runtime.disabled_native_tools.join(",")}`);
  events.close();
}

async function commandPiChat(
  options: {
    argv: string[];
    cwd: string;
    emitOut: (line: string) => void;
    env: Record<string, string | undefined>;
    home: OpenStratHome;
  },
  prompt: string
): Promise<void> {
  const events = new SqliteEventLog(options.home.stateDbPath);
  const sessionId = `agent_session_${Date.now()}`;
  const transcriptStore = new FilePiTranscriptStore(options.home.root);
  const sessionFactory =
    options.env.OPENSTRAT_FAKE_PI === "1"
      ? createFakePiAgentSessionFactory({
          events: fakePiChatEvents({
            finalOnly: options.env.OPENSTRAT_FAKE_PI_FINAL_ONLY === "1"
          })
        })
      : createPersistedPiSessionFactory(options.home);
  const adapter = createPiAgentRuntimeAdapter({
    events,
    now: () => new Date().toISOString(),
    policy: createAgentRuntimePolicyEnforcer(
      createAgentRuntimePolicy({
        autonomy_mode: "strategy_workbench",
        allowed_model_profile_ids: ["model/openai-codex-subscription"],
        allowed_tool_names: ["market_data.read_snapshot"]
      })
    ),
    sessionFactory,
    transcriptStore
  });

  const createdAt = new Date().toISOString();
  const runtime = await adapter.startSession({
    manifest: {
      id: sessionId,
      created_at: createdAt,
      purpose: "strategy_research",
      autonomy_mode: "strategy_workbench",
      runtime: {
        kind: "pi",
        adapter: "@openstrat/agent-runtime/pi",
        model_profile_id: "model/openai-codex-subscription",
        provider: "openai-codex",
        model: "gpt-5.5"
      },
      transcript_ref: {
        id: `artifact_transcript_${sessionId}`,
        kind: "agent_transcript",
        uri: join(options.home.sessionsDir, `${sessionId}.jsonl`),
        content_hash: "sha256:pending",
        created_at: createdAt,
        append_only: true
      },
      event_stream_id: `agent_sessions/${sessionId}`,
      tool_grant_ids: [],
      canonical_ledger_refs: []
    },
    toolNames: ["market_data.read_snapshot"]
  });
  await adapter.prompt({ session_id: sessionId, prompt });
  await adapter.dispose(sessionId);

  const stream = events.list(`agent_sessions/${sessionId}`);
  const deltas = stream
    .filter((event) => event.type === "agent.runtime.message_delta")
    .map((event) => (event.payload as { delta?: string }).delta ?? "")
    .join("");
  options.emitOut(
    deltas ||
      finalAssistantTextFromStream(stream) ||
      "OpenStrat chat session completed."
  );
  options.emitOut("runtime: pi");
  options.emitOut(`session: ${sessionId}`);
  options.emitOut(`transcript: ${runtime.transcript_ref}`);
  options.emitOut(`disabled native tools: ${runtime.disabled_builtin_tools.join(",")}`);
  events.close();
}

async function commandArtifacts(options: {
  emitOut: (line: string) => void;
  home: OpenStratHome;
}): Promise<void> {
  if (!existsSync(options.home.stateDbPath)) {
    options.emitOut("No artifacts found.");
    return;
  }
  const events = new SqliteEventLog(options.home.stateDbPath);
  const sessions = new Set(events.list().map((event) => event.stream_id));
  options.emitOut(`Artifacts: ${sessions.size}`);
  for (const session of sessions) {
    options.emitOut(session);
  }
  events.close();
}

async function commandProject(options: {
  argv: string[];
  cwd: string;
  emitOut: (line: string) => void;
  home: OpenStratHome;
  setJsonData: SetCliJsonData;
}): Promise<void> {
  const subcommand = options.argv.shift();
  switch (subcommand) {
    case "status": {
      ensureOpenStratHome(options.home);
      const status = buildProjectStatus(options.home, options.cwd);
      options.setJsonData({ ...status });
      options.emitOut(`home: ${status.home.root}`);
      options.emitOut(`project: ${status.project.id}`);
      options.emitOut(`project_objects: ${status.project.object_root}`);
      if (status.latest.dataset_ref) {
        options.emitOut(`dataset: ${status.latest.dataset_ref}`);
      }
      if (status.latest.backtest_report_ref) {
        options.emitOut(`backtest_report: ${status.latest.backtest_report_ref}`);
      }
      if (status.latest.gate_artifact_ref) {
        options.emitOut(`gate_artifact: ${status.latest.gate_artifact_ref}`);
      }
      if (status.latest.transcript_ref) {
        options.emitOut(`transcript: ${status.latest.transcript_ref}`);
      }
      return;
    }
    default:
      throw new Error("Usage: openstrat project status");
  }
}

async function commandBundle(options: {
  argv: string[];
  cwd: string;
  emitOut: (line: string) => void;
  home: OpenStratHome;
  setJsonData: SetCliJsonData;
}): Promise<void> {
  const subcommand = options.argv.shift();
  switch (subcommand) {
    case "export":
      commandBundleExport(options);
      return;
    default:
      throw new Error("Usage: openstrat bundle export --latest");
  }
}

function commandBundleExport(options: {
  argv: string[];
  cwd: string;
  emitOut: (line: string) => void;
  home: OpenStratHome;
  setJsonData: SetCliJsonData;
}): void {
  ensureOpenStratHome(options.home);
  if (!options.argv.includes("--latest")) {
    throw new Error("Usage: openstrat bundle export --latest");
  }
  const registration = registerProject(options.home, options.cwd);
  const store = new FileObjectStore(options.home.objectsDir);
  const status = buildProjectStatus(options.home, options.cwd);
  store.putJson(status.status_ref, status, { overwrite: true });
  const createdAt = new Date().toISOString();
  const bundleId = `bundle_${timestampRefSegment(createdAt)}_${safeRefSegment(
    registration.id
  )}`;
  const bundleDir = join(options.home.root, "exports", bundleId);
  mkdirSync(bundleDir, { recursive: true });
  const refs = projectStatusEvidenceRefs(store, status);
  const objects = Object.fromEntries(
    refs
      .filter((ref) => store.exists(ref))
      .map((ref) => [ref, store.getJson(ref)] as const)
  );
  const manifestPath = join(bundleDir, "bundle.json");
  const artifactsPath = join(bundleDir, "artifacts.json");
  const manifest = {
    command: "bundle",
    subcommand: "export",
    id: bundleId,
    created_at: createdAt,
    project: status.project,
    status,
    refs,
    artifacts_path: artifactsPath
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  writeFileSync(
    artifactsPath,
    `${JSON.stringify({ created_at: createdAt, objects }, null, 2)}\n`,
    "utf8"
  );
  const latestManifestPath = join(options.home.root, "exports", "latest.json");
  writeFileSync(latestManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  options.setJsonData({
    command: "bundle",
    subcommand: "export",
    bundle_dir: bundleDir,
    manifest_path: manifestPath,
    artifacts_path: artifactsPath,
    refs
  });
  options.emitOut(`bundle: ${bundleDir}`);
  options.emitOut(`manifest: ${manifestPath}`);
  options.emitOut(`artifacts: ${artifactsPath}`);
  options.emitOut(`refs: ${refs.length}`);
}

async function commandGateway(options: {
  emitOut: (line: string) => void;
  home: OpenStratHome;
}): Promise<void> {
  const projects = listProjectRegistrations(options.home);
  options.emitOut("OpenStrat Gateway");
  options.emitOut(`home: ${options.home.root}`);
  options.emitOut(`projects: ${projects.length}`);
}

function commandUpgrade(options: {
  argv: string[];
  emitOut: (line: string) => void;
}): void {
  const parsed = parseUpgradeArgs(options.argv);
  const target = parsed.version ?? parsed.tag ?? "dev";
  const command = `npm i -g openstrat@${target}`;
  if (!parsed.execute) {
    options.emitOut("Dry run. Re-run with --execute to upgrade.");
    options.emitOut(command);
    return;
  }
  options.emitOut(`Executing: ${command}`);
  const result = spawnSync("npm", ["i", "-g", `openstrat@${target}`], {
    stdio: "inherit"
  });
  if (result.status !== 0) {
    throw new Error(`npm upgrade failed with status ${result.status ?? "unknown"}`);
  }
}

function commandReset(options: {
  argv: string[];
  emitOut: (line: string) => void;
  home: OpenStratHome;
}): void {
  if (!options.argv.includes("--purge")) {
    throw new Error("Usage: openstrat reset --purge");
  }
  const result = safePurgeOpenStratHome(options.home);
  options.emitOut(`${result.deleted ? "Purged" : "Nothing to purge"}: ${result.path}`);
}

function codexChatManifest(home: OpenStratHome, sessionId: string, createdAt: string) {
  return {
    id: sessionId,
    created_at: createdAt,
    purpose: "strategy_research",
    autonomy_mode: "strategy_workbench",
    runtime: {
      kind: "codex_app_server",
      adapter: "@openstrat/agent-runtime/codex-app-server",
      model_profile_id: "model/openai-codex-subscription",
      provider: "openai-codex",
      model: "gpt-5.5"
    },
    transcript_ref: {
      id: `artifact_transcript_${sessionId}`,
      kind: "agent_transcript",
      uri: join(home.sessionsDir, `${sessionId}.jsonl`),
      content_hash: "sha256:pending",
      created_at: createdAt,
      append_only: true
    },
    event_stream_id: `agent_sessions/${sessionId}`,
    tool_grant_ids: [],
    canonical_ledger_refs: []
  };
}

function printHelp(emitOut: (line: string) => void): void {
  emitOut("openstrat <command>");
  emitOut(
    "commands: init, doctor, auth codex, chat [--runtime codex|pi], artifacts, market, strategy init|validate|propose-sample, backtest run|run-sample, gate create-local|create-sample|inspect, project status, bundle export, deploy, ledger, memory, gateway, upgrade, update, reset --purge"
  );
}

function writeFakeCodexAuth(authPath: string): void {
  mkdirSync(join(authPath, ".."), { recursive: true });
  writeFileSync(
    authPath,
    `${JSON.stringify(
      {
        [CODEX_PROVIDER_ID]: {
          type: "oauth",
          provider: CODEX_PROVIDER_ID,
          access: "fake-access-token",
          refresh: "fake-refresh-token",
          expires: Date.now() + 60_000
        }
      },
      null,
      2
    )}\n`,
    { encoding: "utf8", mode: 0o600 }
  );
}

function codexAuthConfigured(home: OpenStratHome): boolean {
  const authPath = getPiAuthPath(home);
  if (!existsSync(authPath)) {
    return false;
  }
  const parsed = JSON.parse(readFileSync(authPath, "utf8")) as Record<string, unknown>;
  return parsed[CODEX_PROVIDER_ID] !== undefined;
}

async function promptFromArgs(argv: string[]): Promise<string> {
  const promptIndex = argv.indexOf("--prompt");
  if (promptIndex >= 0) {
    return argv[promptIndex + 1] ?? "";
  }
  return promptLine("openstrat> ");
}

function chatRuntimeFromArgs(
  argv: readonly string[],
  env: Record<string, string | undefined>
): ChatRuntimeKind {
  const raw = stringFlag(argv, "--runtime") ?? env.OPENSTRAT_CHAT_RUNTIME ?? "codex";
  switch (raw) {
    case "codex":
    case "codex-app-server":
    case "codex_app_server":
      return "codex_app_server";
    case "pi":
      return "pi";
    default:
      throw new Error(`Unsupported chat runtime: ${raw}`);
  }
}

async function promptLine(message: string): Promise<string> {
  const readline = createInterface({ input, output });
  try {
    return await readline.question(message);
  } finally {
    readline.close();
  }
}

async function checkHyperliquid(
  env: Record<string, string | undefined>
): Promise<string> {
  if (env.OPENSTRAT_FAKE_HYPERLIQUID === "1") {
    return "reachable";
  }
  try {
    const client = new HyperliquidInfoClient();
    await client.metaAndAssetCtxs();
    return "reachable";
  } catch {
    return "unreachable";
  }
}

function checkCliAuth(
  env: Record<string, string | undefined>,
  command: string,
  authArgs: string[]
): string {
  if (env.OPENSTRAT_SKIP_EXTERNAL_CLI_CHECKS === "1") {
    return "skipped";
  }
  const exists = spawnSync(command, ["--help"], {
    encoding: "utf8",
    timeout: 2_000
  });
  if (exists.error || exists.status !== 0) {
    return "CLI unavailable";
  }
  const auth = spawnSync(command, authArgs, {
    encoding: "utf8",
    timeout: 2_000
  });
  return auth.status === 0 ? "authenticated" : "auth unavailable";
}

function nodeSatisfies(version: string): boolean {
  const current = version.split(".").map(Number);
  const minimum = MIN_NODE_VERSION.split(".").map(Number);
  for (let index = 0; index < minimum.length; index += 1) {
    const currentPart = current[index] ?? 0;
    const minimumPart = minimum[index] ?? 0;
    if (currentPart > minimumPart) {
      return true;
    }
    if (currentPart < minimumPart) {
      return false;
    }
  }
  return true;
}

function parseUpgradeArgs(argv: string[]): {
  execute: boolean;
  tag?: string;
  version?: string;
} {
  const tagIndex = argv.indexOf("--tag");
  const versionIndex = argv.indexOf("--version");
  return {
    execute: argv.includes("--execute"),
    ...(tagIndex >= 0 && argv[tagIndex + 1] ? { tag: argv[tagIndex + 1] } : {}),
    ...(versionIndex >= 0 && argv[versionIndex + 1]
      ? { version: argv[versionIndex + 1] }
      : {})
  };
}

function stringFlag(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

function requiredFlag(argv: readonly string[], flag: string): string {
  const value = stringFlag(argv, flag);
  if (!value) {
    throw new Error(`Missing required flag: ${flag}`);
  }
  return value;
}

function sampleGateReadiness(argv: readonly string[]): "ready" | "not_ready" {
  const ready = argv.includes("--ready");
  const notReady = argv.includes("--not-ready");
  if (ready === notReady) {
    throw new Error("Pass exactly one of --ready or --not-ready");
  }
  return ready ? "ready" : "not_ready";
}

function numberFlag(argv: readonly string[], flag: string): number {
  const value = requiredFlag(argv, flag);
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid number for ${flag}: ${value}`);
  }
  return parsed;
}

function optionalNumberFlag(argv: readonly string[], flag: string): number | undefined {
  const value = stringFlag(argv, flag);
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid number for ${flag}: ${value}`);
  }
  return parsed;
}

function hyperliquidCoinFromSymbol(symbol: string): string {
  const trimmed = symbol.trim().toUpperCase();
  if (trimmed.endsWith("-PERP")) {
    return trimmed.slice(0, -"PERP".length - 1);
  }
  if (trimmed.includes("/")) {
    throw new Error(`Hyperliquid live ingest expects a perp symbol, got ${symbol}`);
  }
  return trimmed;
}

function readDeploymentGateRef(
  store: FileObjectStore,
  ref: string
): { artifact_ref?: string; gate: DeploymentGate; gate_ref: string } {
  const value = store.getJson<unknown>(ref);
  if (isDeploymentGateArtifact(value)) {
    return {
      artifact_ref: ref,
      gate_ref: value.gate_ref,
      gate: DeploymentGateSchema.parse(store.getJson(value.gate_ref))
    };
  }

  return {
    gate_ref: ref,
    gate: DeploymentGateSchema.parse(value)
  };
}

function isDeploymentGateArtifact(value: unknown): value is DeploymentGateArtifact {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  return typeof (value as { gate_ref?: unknown }).gate_ref === "string";
}

async function inspectGateWithGateway(
  home: OpenStratHome,
  store: FileObjectStore,
  gate: DeploymentGate
): Promise<DeploymentGateInspection> {
  return withCliAgentToolGateway(home, store, (gateway) =>
    gateway.inspectDeploymentGate({
      call_id: `cli_gate_inspect_${gate.id}`,
      session_id: "cli_deployment_gate",
      turn_id: "turn_gate_inspect",
      gate
    })
  );
}

async function inspectLocalGateEvidence(input: {
  createdAt: string;
  gate: DeploymentGate;
  home: OpenStratHome;
  maxAgeMinutes?: number;
  report: BacktestReport;
  store: FileObjectStore;
}): Promise<DeploymentGateInspection> {
  const staticInspection = await inspectGateWithGateway(
    input.home,
    input.store,
    input.gate
  );
  const missing = [...staticInspection.missing_requirements];
  const report = input.report;
  const gate = input.gate;

  if (report.dataset_ref !== gate.backtest.dataset_ref) {
    missing.push(
      `backtest dataset mismatch: expected ${gate.backtest.dataset_ref}, got ${report.dataset_ref}`
    );
  }
  if (report.metrics.trades < gate.backtest.min_trades) {
    missing.push(
      `backtest trades below minimum: expected ${gate.backtest.min_trades}, got ${report.metrics.trades}`
    );
  }
  if (report.metrics.win_rate < gate.backtest.min_win_rate) {
    missing.push(
      `backtest win rate below minimum: expected ${gate.backtest.min_win_rate}, got ${report.metrics.win_rate}`
    );
  }
  if (report.metrics.max_drawdown_pct > gate.backtest.max_drawdown_pct) {
    missing.push(
      `backtest drawdown above maximum: expected ${gate.backtest.max_drawdown_pct}, got ${report.metrics.max_drawdown_pct}`
    );
  }
  if (input.maxAgeMinutes !== undefined) {
    const ageMs = Date.parse(input.createdAt) - Date.parse(report.generated_at);
    if (ageMs > input.maxAgeMinutes * 60_000) {
      missing.push(
        `backtest report stale: generated_at ${report.generated_at} exceeds ${input.maxAgeMinutes} minutes`
      );
    }
  }

  const missingRequirements = uniqueStrings(missing);
  return {
    gate_id: gate.id,
    ready: missingRequirements.length === 0,
    missing_requirements: missingRequirements,
    required_reviews: gate.required_reviews
  };
}

function writeLocalStrategyObjectRefs(input: {
  createdAt: string;
  loadedStrategy: LoadedLocalStrategy;
  registration: ReturnType<typeof registerProject>;
  store: FileObjectStore;
}): { manifest_ref: string; source_ref: string } {
  const strategy = input.loadedStrategy.strategy.manifest;
  const root = projectObjectRef(
    input.registration,
    "strategies",
    safeRefSegment(strategy.strategy_id),
    timestampRefSegment(input.createdAt)
  );
  const manifestRef = `${root}/manifest.json`;
  const sourceRef = `${root}/source.json`;
  input.store.putJson(manifestRef, strategy);
  input.store.putJson(sourceRef, {
    strategy_id: strategy.strategy_id,
    strategy_version: strategy.strategy_version,
    created_at: input.createdAt,
    ...(input.loadedStrategy.source_path
      ? {
          source_path: input.loadedStrategy.source_path,
          relative_path: toPosixPath(
            relative(input.registration.cwd, input.loadedStrategy.source_path)
          ),
          content: readFileSync(input.loadedStrategy.source_path, "utf8")
        }
      : {})
  });
  return { manifest_ref: manifestRef, source_ref: sourceRef };
}

function latestStrategyValidationRef(
  home: OpenStratHome,
  projectRoot: string,
  strategyId: string,
  datasetRef: string
): string | undefined {
  const store = new FileObjectStore(home.objectsDir);
  const refs = listObjectRefs(
    home,
    `${projectRoot}/workbench/strategy-validations/${safeRefSegment(strategyId)}`
  );
  for (const ref of [...refs].reverse()) {
    const parsed = safeGetJson<StrategyValidationArtifact>(store, ref);
    if (!parsed) {
      continue;
    }
    if (parsed.dataset_preflight?.dataset_ref === datasetRef) {
      return ref;
    }
  }
  return undefined;
}

function buildProjectStatus(
  home: OpenStratHome,
  cwd: string,
  latestOverrides: Partial<ProjectStatusSnapshot["latest"]> = {}
): ProjectStatusSnapshot {
  const registration = registerProject(home, cwd);
  const store = new FileObjectStore(home.objectsDir);
  const objectRoot = projectObjectRoot(registration);
  const datasetRefs = listMarketDatasetRefs(home);
  const latestDatasetRef = latestDatasetByCreatedAt(store, datasetRefs);
  const validationRefs = listObjectRefs(
    home,
    `${objectRoot}/workbench/strategy-validations`
  );
  const backtestRefs = listObjectRefs(home, `${objectRoot}/backtests`);
  const backtestReportRefs = backtestRefs.filter((ref) => ref.endsWith("/report.json"));
  const latestBacktestReportRef = latestRef(backtestReportRefs);
  const latestBacktestReport = latestBacktestReportRef
    ? safeGetJson<BacktestReport>(store, latestBacktestReportRef)
    : undefined;
  const backtestRoot = latestBacktestReportRef
    ? latestBacktestReportRef.slice(0, -"report.json".length)
    : undefined;
  const requestRef = backtestRoot ? `${backtestRoot}request.json` : undefined;
  const metricsRef = backtestRoot ? `${backtestRoot}metrics.json` : undefined;
  const gateArtifactRefs = listObjectRefs(home, `${objectRoot}/gates`).filter((ref) =>
    ref.endsWith("/artifact.json")
  );
  const latestGateArtifactRef = latestRef(gateArtifactRefs);
  const latestGateArtifact = latestGateArtifactRef
    ? safeGetJson<DeploymentGateArtifact>(store, latestGateArtifactRef)
    : undefined;
  const strategyPaths = localStrategyPaths(cwd);
  const chatSessions = listChatSessions(home);
  const latestChatSession = latestRef(chatSessions.map((session) => session.id));
  const latestTranscript = latestChatSession
    ? chatSessions.find((session) => session.id === latestChatSession)
    : undefined;
  const exportManifests = listExportManifestPaths(home);

  const latest: ProjectStatusSnapshot["latest"] = {
    ...strategyPaths,
    ...(latestDatasetRef ? { dataset_ref: latestDatasetRef } : {}),
    ...optionalLatestRef("strategy_validation_ref", latestRef(validationRefs)),
    ...(requestRef && store.exists(requestRef)
      ? { backtest_request_ref: requestRef }
      : {}),
    ...(latestBacktestReportRef
      ? { backtest_report_ref: latestBacktestReportRef }
      : {}),
    ...(metricsRef && store.exists(metricsRef)
      ? { backtest_metrics_ref: metricsRef }
      : {}),
    ...(latestBacktestReport?.trade_ledger_ref
      ? { trade_ledger_ref: latestBacktestReport.trade_ledger_ref }
      : {}),
    ...(latestGateArtifact?.gate_ref ? { gate_ref: latestGateArtifact.gate_ref } : {}),
    ...(latestGateArtifactRef ? { gate_artifact_ref: latestGateArtifactRef } : {}),
    ...(latestTranscript
      ? {
          chat_session_id: latestTranscript.id,
          transcript_ref: latestTranscript.transcript_ref
        }
      : {}),
    ...optionalLatestRef("export_manifest_path", latestRef(exportManifests)),
    ...latestOverrides
  };
  return {
    command: "project",
    subcommand: "status",
    generated_at: new Date().toISOString(),
    home: {
      root: home.root,
      objects_dir: home.objectsDir,
      sessions_dir: home.sessionsDir
    },
    project: {
      id: registration.id,
      cwd: registration.cwd,
      registration_ref: registration.ref,
      object_root: objectRoot
    },
    latest,
    counts: {
      datasets: datasetRefs.length,
      validations: validationRefs.length,
      backtests: backtestReportRefs.length,
      gates: gateArtifactRefs.length,
      chat_sessions: chatSessions.length,
      exports: exportManifests.length
    },
    status_ref: projectObjectRef(registration, "status", "latest.json")
  };
}

function writeProjectStatusArtifact(
  home: OpenStratHome,
  cwd: string,
  latestOverrides: Partial<ProjectStatusSnapshot["latest"]> = {}
): string {
  const status = buildProjectStatus(home, cwd, latestOverrides);
  new FileObjectStore(home.objectsDir).putJson(status.status_ref, status, {
    overwrite: true
  });
  return status.status_ref;
}

function projectStatusEvidenceRefs(
  store: FileObjectStore,
  status: ProjectStatusSnapshot
): string[] {
  const directRefs = [
    status.latest.dataset_ref,
    status.latest.strategy_validation_ref,
    status.latest.backtest_request_ref,
    status.latest.backtest_report_ref,
    status.latest.backtest_metrics_ref,
    status.latest.trade_ledger_ref,
    status.latest.gate_ref,
    status.latest.gate_artifact_ref,
    status.status_ref
  ].filter((ref): ref is string => typeof ref === "string" && ref.length > 0);
  const reportRefs =
    status.latest.backtest_report_ref && store.exists(status.latest.backtest_report_ref)
      ? BacktestReportSchema.parse(store.getJson(status.latest.backtest_report_ref))
          .artifact_refs
      : [];
  return uniqueRefs([...directRefs, ...reportRefs]);
}

async function withCliAgentToolGateway<T>(
  home: OpenStratHome,
  store: FileObjectStore,
  callback: (gateway: AgentToolGateway) => Promise<T>
): Promise<T> {
  ensureOpenStratHome(home);
  const events = new SqliteEventLog(home.stateDbPath);
  try {
    const gateway = createAgentToolGateway({
      events,
      objects: store,
      marketData: {
        async getMarket() {
          throw new Error("market data is unavailable during gate inspection");
        },
        async getLatestPrice() {
          throw new Error("market data is unavailable during gate inspection");
        },
        async getCandles() {
          throw new Error("market data is unavailable during gate inspection");
        },
        async getOrderbookSnapshot() {
          throw new Error("market data is unavailable during gate inspection");
        }
      },
      risk: {
        async review() {
          throw new Error("risk review is unavailable during gate inspection");
        }
      },
      now: () => new Date().toISOString()
    });
    return await callback(gateway);
  } finally {
    events.close();
  }
}

function proposalArtifactRef(
  sessionId: string,
  proposalId: string,
  createdAt: string,
  metadata: Record<string, unknown>
) {
  return {
    id: `${proposalId}_artifact`,
    kind: "proposal" as const,
    uri: `agent-artifacts/${safeRefSegment(sessionId)}/${proposalId}.json`,
    content_hash: `sha256:${proposalId}`,
    created_at: createdAt,
    append_only: true as const,
    metadata
  };
}

function deploymentTargetFromArgs(
  argv: readonly string[],
  targetKind: string,
  cwd: string
): BotRunManifest["target"] {
  switch (targetKind) {
    case "local_terminal":
      return {
        kind: "local_terminal",
        workspace_path: stringFlag(argv, "--workspace-path") ?? cwd,
        reliability_boundary:
          "Local execution depends on this machine staying awake, online, and authorized."
      };
    case "fly_machine":
      return {
        kind: "fly_machine",
        app_name: requiredFlag(argv, "--app-name"),
        ...optionalFlag(argv, "--region", "region")
      };
    case "sprite_microvm":
      return {
        kind: "sprite_microvm",
        project: requiredFlag(argv, "--project"),
        ...optionalFlag(argv, "--image", "image")
      };
    default:
      throw new Error(
        "Unsupported deployment target. Use local_terminal, fly_machine, or sprite_microvm."
      );
  }
}

function runtimeModeForGate(gate: DeploymentGate): BotRunManifest["runtime"]["mode"] {
  switch (gate.deployment.mode) {
    case "draft_orders":
      return "draft";
    case "constrained_live":
    case "adaptive_management":
      return "live";
    default:
      return "paper";
  }
}

function deploymentProviderFor(kind: BotRunManifest["target"]["kind"]) {
  switch (kind) {
    case "local_terminal":
      return new LocalTerminalDeploymentProvider();
    case "fly_machine":
      return new FlyMachineDeploymentProvider();
    case "sprite_microvm":
      return new SpriteMicrovmDeploymentProvider();
  }
}

function deploymentHandoffRefs(botRunId: string): {
  handoff_ref: string;
  manifest_ref: string;
  plan_ref: string;
} {
  const root = `deployment-handoffs/${safeRefSegment(botRunId)}`;
  return {
    manifest_ref: `${root}/manifest.json`,
    plan_ref: `${root}/plan.json`,
    handoff_ref: `${root}/handoff.json`
  };
}

function ensureSampleStrategyManifest(
  store: FileObjectStore,
  strategyManifestRef: string,
  gate: DeploymentGate
): void {
  if (store.exists(strategyManifestRef)) {
    return;
  }
  if (gate.strategy_id !== movingAverageBreakoutStrategy.manifest.strategy_id) {
    throw new Error(`Strategy manifest not found: ${strategyManifestRef}`);
  }
  store.putJson(strategyManifestRef, movingAverageBreakoutStrategy.manifest);
}

function optionalFlag<Key extends string>(
  argv: readonly string[],
  flag: string,
  key: Key
): Partial<Record<Key, string>> {
  const value = stringFlag(argv, flag);
  return value ? ({ [key]: value } as Partial<Record<Key, string>>) : {};
}

function safeRefSegment(value: string): string {
  return (
    value
      .trim()
      .replace(/[^a-zA-Z0-9._-]+/g, "_")
      .replace(/^_+|_+$/g, "") || "ref"
  );
}

function optionalLatestRef<Key extends keyof ProjectStatusSnapshot["latest"]>(
  key: Key,
  value: string | undefined
): Partial<Pick<ProjectStatusSnapshot["latest"], Key>> {
  return value
    ? ({ [key]: value } as Partial<Pick<ProjectStatusSnapshot["latest"], Key>>)
    : {};
}

function latestRef(refs: readonly string[]): string | undefined {
  if (refs.length === 0) {
    return undefined;
  }
  const sorted = [...refs].sort();
  return sorted[sorted.length - 1];
}

function latestDatasetByCreatedAt(
  store: FileObjectStore,
  refs: readonly string[]
): string | undefined {
  const datasets = refs
    .map((ref) => safeGetJson<MarketDatasetManifest>(store, ref))
    .filter((dataset): dataset is MarketDatasetManifest => dataset !== undefined)
    .sort((left, right) => left.created_at.localeCompare(right.created_at));
  return datasets[datasets.length - 1]?.dataset_ref;
}

function safeGetJson<T>(store: FileObjectStore, ref: string): T | undefined {
  try {
    return store.getJson<T>(ref);
  } catch {
    return undefined;
  }
}

function localStrategyPaths(cwd: string): {
  strategy_manifest_path?: string;
  strategy_source_path?: string;
} {
  const manifestPath = join(cwd, "openstrat.strategy.json");
  if (!existsSync(manifestPath)) {
    return {};
  }
  let parsedManifest: unknown;
  try {
    parsedManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    return { strategy_manifest_path: manifestPath };
  }
  const manifest = StrategyManifestSchema.safeParse(parsedManifest);
  if (!manifest.success) {
    return { strategy_manifest_path: manifestPath };
  }
  const sourcePath = join(cwd, manifest.data.entrypoint);
  return {
    strategy_manifest_path: manifestPath,
    ...(existsSync(sourcePath) ? { strategy_source_path: sourcePath } : {})
  };
}

function listChatSessions(
  home: OpenStratHome
): { id: string; transcript_ref: string }[] {
  if (!existsSync(home.sessionsDir)) {
    return [];
  }
  return readdirSync(home.sessionsDir)
    .filter((entry) => entry.endsWith(".jsonl"))
    .sort()
    .map((entry) => ({
      id: entry.replace(/\.jsonl$/u, ""),
      transcript_ref: join(home.sessionsDir, entry)
    }));
}

function listExportManifestPaths(home: OpenStratHome): string[] {
  const exportsRoot = join(home.root, "exports");
  if (!existsSync(exportsRoot)) {
    return [];
  }
  const manifests: string[] = [];
  for (const entry of readdirSync(exportsRoot, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const manifestPath = join(exportsRoot, entry.name, "bundle.json");
      if (existsSync(manifestPath)) {
        manifests.push(manifestPath);
      }
    }
  }
  return manifests.sort();
}

function uniqueRefs(refs: readonly string[]): string[] {
  return [...new Set(refs)];
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function listMarketDatasetRefs(home: OpenStratHome): string[] {
  const datasetsRoot = join(home.objectsDir, "datasets", "hyperliquid");
  if (!existsSync(datasetsRoot)) {
    return [];
  }

  const refs: string[] = [];
  const walk = (dir: string, refPrefix: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const childPath = join(dir, entry.name);
      const childRef = join(refPrefix, entry.name);
      if (entry.isDirectory()) {
        walk(childPath, childRef);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".json")) {
        refs.push(childRef);
      }
    }
  };
  walk(datasetsRoot, "datasets/hyperliquid");
  return refs.sort();
}

function marketDatasetListItem(input: MarketDatasetManifest): CliJsonData {
  const dataset = MarketDatasetManifestSchema.parse(input);
  return {
    dataset_ref: dataset.dataset_ref,
    canonical_symbol: dataset.canonical_symbol,
    source: dataset.source,
    venue: dataset.venue,
    asset_class: dataset.asset_class,
    created_at: dataset.created_at,
    time_range: dataset.time_range,
    acquisition_method: dataset.acquisition.method,
    families: dataset.coverage.families,
    freshness: dataset.freshness,
    source_provenance: dataset.source_provenance
  };
}

function requireNormalizedRef(
  dataset: MarketDatasetManifest,
  family: NormalizedMarketDataRef["family"]
): NormalizedMarketDataRef {
  const normalizedRef = normalizedRefsFor(dataset, family)[0];
  if (!normalizedRef) {
    throw new Error(
      `Market dataset ${dataset.dataset_ref} is missing normalized ${family} ref`
    );
  }
  return normalizedRef;
}

function normalizedRefsFor(
  dataset: MarketDatasetManifest,
  family: NormalizedMarketDataRef["family"]
): NormalizedMarketDataRef[] {
  return dataset.normalized_refs.filter((candidate) => candidate.family === family);
}

function listObjectRefs(home: OpenStratHome, prefix: string): string[] {
  const root = join(home.objectsDir, ...prefix.split("/"));
  if (!existsSync(root)) {
    return [];
  }

  const refs: string[] = [];
  const walk = (dir: string, refPrefix: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const childPath = join(dir, entry.name);
      const childRef = join(refPrefix, entry.name);
      if (entry.isDirectory()) {
        walk(childPath, childRef);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".json")) {
        refs.push(childRef);
      }
    }
  };
  walk(root, prefix);
  return refs.sort();
}

function createFixtureHyperliquidClient(symbol = "BTC"): HyperliquidReadClient {
  const price = symbol === "HYPE" ? "35.25" : "113377.0";
  const midPrice = symbol === "HYPE" ? "35.26" : "113387.0";
  const oraclePrice = symbol === "HYPE" ? "35.20" : "113370.0";
  const bidPrice = symbol === "HYPE" ? "35.24" : "113377.0";
  const askPrice = symbol === "HYPE" ? "35.27" : "113397.0";
  return {
    async metaAndAssetCtxs() {
      return [
        {
          universe: [
            {
              name: symbol,
              szDecimals: 5,
              maxLeverage: 50,
              marginTableId: 50
            }
          ],
          marginTables: [
            [
              50,
              {
                description: "",
                marginTiers: [{ lowerBound: "0.0", maxLeverage: 50 }]
              }
            ]
          ],
          collateralToken: 0
        },
        [
          {
            prevDayPx: price,
            dayNtlVlm: "1500000000.0",
            markPx: price,
            midPx: midPrice,
            funding: "0.0000125",
            openInterest: "10000.0",
            premium: "0.0001",
            oraclePx: oraclePrice,
            impactPxs: [bidPrice, askPrice],
            dayBaseVlm: "12000.0"
          }
        ]
      ];
    },
    async candleSnapshot() {
      return [
        {
          T: 1681924499999,
          c: "29258.0",
          h: "29309.0",
          i: "15m",
          l: "29250.0",
          n: 189,
          o: "29295.0",
          s: symbol,
          t: 1681923600000,
          v: "0.98639"
        },
        {
          T: 1681925399999,
          c: "29280.0",
          h: "29290.0",
          i: "15m",
          l: "29240.0",
          n: 101,
          o: "29258.0",
          s: symbol,
          t: 1681924500000,
          v: "0.456"
        }
      ];
    },
    async fundingHistory() {
      return [
        {
          coin: symbol,
          fundingRate: "0.0000125",
          premium: "0.0001",
          time: 1681923600000
        },
        {
          coin: symbol,
          fundingRate: "-0.000003",
          premium: "-0.00002",
          time: 1681927200000
        }
      ];
    },
    async l2Book() {
      return {
        coin: symbol,
        time: 1754450974231,
        levels: [
          [
            { px: bidPrice, sz: "7.6699", n: 17 },
            { px: symbol === "HYPE" ? "35.23" : "113376.0", sz: "4.13714", n: 8 }
          ],
          [
            { px: askPrice, sz: "0.11543", n: 3 },
            { px: symbol === "HYPE" ? "35.28" : "113398.0", sz: "1.2", n: 4 }
          ]
        ]
      };
    }
  };
}

function sampleStrategy(sample: string | undefined): StrategyModule {
  switch (sample ?? "moving-average-breakout") {
    case "moving-average-breakout":
      return movingAverageBreakoutStrategy;
    case "invalid-random":
      return defineStrategy(
        {
          strategy_id: "invalid_random_strategy",
          strategy_version: "0.1.0",
          name: "Invalid random strategy",
          description: "Fixture strategy that violates purity constraints.",
          runtime: "typescript",
          entrypoint: "fixtures/invalid-random",
          autonomy_mode: "strategy_workbench",
          allowed_symbols: ["BTC-PERP"],
          parameters: {},
          required_data: [
            { kind: "candles", canonical_symbol: "BTC-PERP", interval: "15m" }
          ],
          output: "trade_intent",
          created_at: "2026-06-04T00:00:00.000Z",
          source_refs: []
        },
        () => [
          {
            id: `invalid_random_strategy:${Date.now()}`,
            created_at: "2026-06-04T00:45:00.000Z",
            created_by: {
              strategy_id: "invalid_random_strategy",
              strategy_version: "0.1.0"
            },
            mode: "paper",
            intent_type: "open_position",
            canonical_symbol: "BTC-PERP",
            side: "long",
            target_notional_usd: 1000,
            max_slippage_bps: 15,
            reason_ref: "fixtures/invalid-random",
            evidence_refs: ["fixtures/invalid-random"],
            risk_policy_ref: "risk/sample",
            invalidation: { thesis_invalid_if: ["impure fixture"] }
          }
        ]
      );
    default:
      throw new Error(`Unknown strategy sample: ${sample}`);
  }
}

function sampleStrategyMarketEvents(
  canonicalSymbol = "BTC-PERP"
): StrategyMarketEvent[] {
  const symbol = symbolFromCanonicalSymbol(canonicalSymbol);
  return [
    {
      kind: "candle",
      candle: {
        symbol,
        canonical_symbol: canonicalSymbol,
        source: "hyperliquid",
        venue: "hyperliquid",
        interval: "15m",
        open_time: "2026-06-04T00:00:00.000Z",
        close_time: "2026-06-04T00:15:00.000Z",
        open: 100,
        high: 101,
        low: 99,
        close: 100,
        volume: 10,
        method: "venue_ohlcv",
        received_at: "2026-06-04T00:45:00.000Z",
        raw_ref: "fixtures/candle-1"
      }
    },
    {
      kind: "candle",
      candle: {
        symbol,
        canonical_symbol: canonicalSymbol,
        source: "hyperliquid",
        venue: "hyperliquid",
        interval: "15m",
        open_time: "2026-06-04T00:15:00.000Z",
        close_time: "2026-06-04T00:30:00.000Z",
        open: 100,
        high: 102,
        low: 99,
        close: 101,
        volume: 12,
        method: "venue_ohlcv",
        received_at: "2026-06-04T00:45:00.000Z",
        raw_ref: "fixtures/candle-2"
      }
    },
    {
      kind: "candle",
      candle: {
        symbol,
        canonical_symbol: canonicalSymbol,
        source: "hyperliquid",
        venue: "hyperliquid",
        interval: "15m",
        open_time: "2026-06-04T00:30:00.000Z",
        close_time: "2026-06-04T00:45:00.000Z",
        open: 101,
        high: 104,
        low: 100,
        close: 103,
        volume: 14,
        method: "venue_ohlcv",
        received_at: "2026-06-04T00:45:00.000Z",
        raw_ref: "fixtures/candle-3"
      }
    }
  ];
}

function symbolFromCanonicalSymbol(canonicalSymbol: string): string {
  return canonicalSymbol.endsWith("-PERP")
    ? canonicalSymbol.slice(0, -"PERP".length - 1)
    : canonicalSymbol;
}

function fakePiChatEvents(options: { finalOnly: boolean }) {
  const text = options.finalOnly
    ? "Final assistant text from Pi."
    : "Hello from OpenStrat.";
  const assistant = fakeAssistantMessage(text);
  return [
    ...(options.finalOnly
      ? []
      : [
          {
            type: "message_update",
            message: assistant,
            assistantMessageEvent: {
              type: "text_delta",
              contentIndex: 0,
              delta: text,
              partial: assistant
            }
          }
        ]),
    {
      type: "tool_execution_start",
      toolCallId: "tool_call_native_write",
      toolName: "write"
    },
    {
      type: "agent_end",
      messages: [fakeUserMessage("hello"), assistant],
      willRetry: false
    }
  ] as never;
}

function fakeCodexChatEvents(options: {
  finalOnly: boolean;
}): readonly CodexAppServerRuntimeEvent[] {
  const text = options.finalOnly
    ? "Final assistant text from Codex."
    : "Hello from OpenStrat.";
  const events: CodexAppServerRuntimeEvent[] = [];
  if (!options.finalOnly) {
    events.push({
      type: "message_delta",
      delta: text
    });
  }
  events.push({
    type: "turn_completed",
    assistant_text: text,
    message_count: 1
  });
  return events;
}

function fakeUserMessage(text: string) {
  return {
    role: "user",
    content: text,
    timestamp: Date.now()
  };
}

function fakeAssistantMessage(text: string) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "responses",
    provider: "openai",
    model: "gpt-5.5",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0
      }
    },
    stopReason: "stop",
    timestamp: Date.now()
  };
}

function finalAssistantTextFromStream(
  stream: readonly { type: string; payload: unknown }[]
): string {
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const event = stream[index];
    if (event?.type !== "agent.runtime.turn_completed") {
      continue;
    }
    const payload = event.payload;
    if (
      typeof payload === "object" &&
      payload !== null &&
      "assistant_text" in payload &&
      typeof payload.assistant_text === "string"
    ) {
      return payload.assistant_text;
    }
  }
  return "";
}

function createPersistedPiSessionFactory(home: OpenStratHome): PiAgentSessionFactory {
  return {
    async create(input) {
      const pi = await import("@earendil-works/pi-coding-agent");
      const authStorage = pi.AuthStorage.create(getPiAuthPath(home));
      const modelRegistry = pi.ModelRegistry.inMemory(authStorage);
      const { session } = await pi.createAgentSession({
        agentDir: input.manifest.transcript_ref.uri,
        authStorage,
        cwd: process.cwd(),
        modelRegistry,
        noTools: "builtin",
        sessionManager: pi.SessionManager.inMemory()
      });
      return {
        sessionId: session.sessionId,
        subscribe: (listener) => session.subscribe(listener as never),
        prompt: (prompt) => session.prompt(prompt),
        dispose: () => session.dispose()
      };
    }
  };
}
