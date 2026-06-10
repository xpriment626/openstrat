import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import { join } from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { AuthStorage } from "@earendil-works/pi-coding-agent";
import {
  createAgentRuntimePolicy,
  createAgentRuntimePolicyEnforcer,
  createFakePiAgentSessionFactory,
  createPiAgentRuntimeAdapter,
  createStrategyProposalWorkflow,
  FilePiTranscriptStore,
  type PiAgentSessionFactory
} from "@openstrat/agent-runtime";
import { runCandleBacktest } from "@openstrat/backtesting";
import {
  BacktestReportSchema,
  BotRunManifestSchema,
  DecisionLedgerEntrySchema,
  DeploymentGateSchema,
  MemoryProposalSchema,
  type BotRunManifest,
  type DeploymentGate
} from "@openstrat/domain";
import {
  HyperliquidInfoClient,
  ingestHyperliquidWindow,
  normalizeHyperliquidMetaAndAssetCtxs,
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

interface MarketDatasetManifest {
  dataset_ref: string;
  canonical_symbol: string;
  source: string;
  venue: string;
  received_at: string;
  registry_ref: string;
  latest_price_ref: string;
  candle_refs: string[];
  funding_refs: string[];
  orderbook_refs: string[];
  raw_refs: {
    meta_and_asset_ctxs: string;
    candles: string;
    funding: string;
    l2_book: string;
  };
  freshness: {
    latest_price_stale_after_ms?: number;
  };
}

interface DeploymentGateArtifact {
  artifact_ref: string;
  created_at: string;
  gate_ref: string;
  strategy_ref: string;
  backtest_report_ref: string;
  risk_policy_ref: string;
  inspection: DeploymentGateInspection;
}

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
  const emitOut = (line: string) => {
    stdoutLines.push(line);
    inputOptions.stdout?.(line);
  };
  const emitErr = (line: string) => {
    stderrLines.push(line);
    inputOptions.stderr?.(line);
  };
  const env = inputOptions.env ?? process.env;
  const cwd = inputOptions.cwd ?? process.cwd();
  const home = resolveOpenStratHome({ env });
  const argv = [...inputOptions.argv];

  try {
    if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
      printHelp(emitOut);
      return { exitCode: 0, stdout: stdoutLines, stderr: stderrLines };
    }
    if (argv[0] === "--version" || argv[0] === "-v") {
      emitOut(cliVersion);
      return { exitCode: 0, stdout: stdoutLines, stderr: stderrLines };
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
        await commandMarket({ argv, emitOut, home });
        break;
      case "strategy":
        await commandStrategy({ argv, emitOut, home });
        break;
      case "backtest":
        await commandBacktest({ argv, emitOut, home });
        break;
      case "gate":
        await commandGate({ argv, emitOut, home });
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
        emitErr(`Unknown command: ${command ?? ""}`);
        return { exitCode: 1, stdout: stdoutLines, stderr: stderrLines };
    }
    return { exitCode: 0, stdout: stdoutLines, stderr: stderrLines };
  } catch (error) {
    emitErr(error instanceof Error ? error.message : String(error));
    return { exitCode: 1, stdout: stdoutLines, stderr: stderrLines };
  }
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
  emitOut: (line: string) => void;
  home: OpenStratHome;
}): Promise<void> {
  const subcommand = options.argv.shift();
  switch (subcommand) {
    case "run-sample":
      await commandBacktestRunSample(options);
      return;
    default:
      throw new Error("Usage: openstrat backtest run-sample");
  }
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
  const store = new FileObjectStore(options.home.objectsDir);
  const dataset = store.getJson<MarketDatasetManifest>(datasetRef);
  const runId = `sample_backtest_${Date.now()}`;
  const report = await runCandleBacktest({
    run_id: runId,
    strategy: movingAverageBreakoutStrategy,
    object_store: store,
    dataset_ref: dataset.dataset_ref,
    candle_refs: dataset.candle_refs,
    raw_artifact_refs: Object.values(dataset.raw_refs),
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
    default:
      throw new Error("Usage: openstrat gate <create-sample|inspect>");
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
  emitOut: (line: string) => void;
  home: OpenStratHome;
}): Promise<void> {
  const subcommand = options.argv.shift();
  switch (subcommand) {
    case "validate":
      await commandStrategyValidate(options);
      return;
    case "propose-sample":
      commandStrategyProposeSample(options);
      return;
    default:
      throw new Error("Usage: openstrat strategy <validate|propose-sample>");
  }
}

async function commandStrategyValidate(options: {
  argv: string[];
  emitOut: (line: string) => void;
}): Promise<void> {
  const sample = stringFlag(options.argv, "--sample");
  const strategy = sampleStrategy(sample);
  const result = await createStrategyRunner().evaluate(strategy, {
    now: "2026-06-04T00:45:00.000Z",
    mode: "paper",
    risk_policy_ref: "risk/sample",
    decision_ref: "strategy-workbench/sample-validation",
    market_events: sampleStrategyMarketEvents()
  });

  options.emitOut(`strategy valid: ${strategy.manifest.strategy_id}`);
  options.emitOut(`intents: ${result.intents.length}`);
}

function commandStrategyProposeSample(options: {
  argv: string[];
  emitOut: (line: string) => void;
  home: OpenStratHome;
}): void {
  ensureOpenStratHome(options.home);
  const strategyId =
    stringFlag(options.argv, "--strategy-id") ?? "sample_moving_average_breakout";
  const objects = new FileObjectStore(options.home.objectsDir);
  const events = new SqliteEventLog(options.home.stateDbPath);
  try {
    const workflow = createStrategyProposalWorkflow({
      events,
      objects,
      now: () => "2026-06-04T00:45:00.000Z"
    });
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

    options.emitOut(`proposal: ${proposal.id}`);
    options.emitOut(`artifact: ${proposal.artifact_ref.uri}`);
    options.emitOut(`patch: ${proposal.patch_ref}`);
  } finally {
    events.close();
  }
}

async function commandMarket(options: {
  argv: string[];
  emitOut: (line: string) => void;
  home: OpenStratHome;
}): Promise<void> {
  const subcommand = options.argv.shift();
  switch (subcommand) {
    case "ingest-fixture":
      await commandMarketIngestFixture(options);
      return;
    case "list":
      commandMarketList(options);
      return;
    case "snapshot":
      commandMarketSnapshot(options);
      return;
    default:
      throw new Error(
        "Usage: openstrat market <ingest-fixture|list|snapshot> [options]"
      );
  }
}

async function commandMarketIngestFixture(options: {
  argv: string[];
  emitOut: (line: string) => void;
  home: OpenStratHome;
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
  const normalized = normalizeHyperliquidMetaAndAssetCtxs(
    store.getJson(result.raw_refs.meta_and_asset_ctxs),
    {
      received_at: MARKET_FIXTURE_RECEIVED_AT,
      raw_ref: result.raw_refs.meta_and_asset_ctxs
    }
  );
  const canonicalSymbol = `${symbol}-PERP`;
  const market = normalized.registry.find(
    (entry) => entry.canonical_symbol === canonicalSymbol
  );
  const latestPrice = normalized.mark_prices.find(
    (datum) => datum.canonical_symbol === canonicalSymbol
  );
  if (!market || !latestPrice) {
    throw new Error(`Fixture market not found: ${canonicalSymbol}`);
  }

  const timestampSlug = slugTimestamp(MARKET_FIXTURE_RECEIVED_AT);
  const latestPriceRef = `normalized/hyperliquid/mark-prices/${canonicalSymbol}/${timestampSlug}.json`;
  const datasetRef = `datasets/hyperliquid/${canonicalSymbol}/${timestampSlug}.json`;
  store.putJson(latestPriceRef, latestPrice, { overwrite: true });
  store.putJson(
    datasetRef,
    {
      dataset_ref: datasetRef,
      canonical_symbol: canonicalSymbol,
      source: market.source,
      venue: market.venue,
      received_at: MARKET_FIXTURE_RECEIVED_AT,
      registry_ref: result.registry_ref,
      latest_price_ref: latestPriceRef,
      candle_refs: result.candle_refs,
      funding_refs: result.funding_refs,
      orderbook_refs: result.orderbook_refs,
      raw_refs: result.raw_refs,
      freshness: {
        latest_price_stale_after_ms: latestPrice.stale_after_ms
      }
    },
    { overwrite: true }
  );

  options.emitOut(`dataset: ${datasetRef}`);
  options.emitOut(`registry: ${result.registry_ref}`);
  options.emitOut(`latest_price: ${latestPriceRef}`);
  options.emitOut(`raw: ${result.raw_refs.meta_and_asset_ctxs}`);
}

function commandMarketList(options: {
  emitOut: (line: string) => void;
  home: OpenStratHome;
}): void {
  const store = new FileObjectStore(options.home.objectsDir);
  const refs = listMarketDatasetRefs(options.home);
  if (refs.length === 0) {
    options.emitOut("No market datasets found.");
    return;
  }

  for (const ref of refs) {
    const dataset = store.getJson<MarketDatasetManifest>(ref);
    options.emitOut(
      `${dataset.canonical_symbol} ${dataset.source} ${dataset.venue} ${ref}`
    );
  }
}

function commandMarketSnapshot(options: {
  argv: string[];
  emitOut: (line: string) => void;
  home: OpenStratHome;
}): void {
  const canonicalSymbol = options.argv[0];
  if (!canonicalSymbol) {
    throw new Error("Usage: openstrat market snapshot <CANONICAL_SYMBOL>");
  }

  const store = new FileObjectStore(options.home.objectsDir);
  const datasetRef = listMarketDatasetRefs(options.home)
    .map((ref) => store.getJson<MarketDatasetManifest>(ref))
    .filter((dataset) => dataset.canonical_symbol === canonicalSymbol)
    .sort((left, right) =>
      right.received_at.localeCompare(left.received_at)
    )[0]?.dataset_ref;
  if (!datasetRef) {
    throw new Error(`Market dataset not found: ${canonicalSymbol}`);
  }

  const dataset = store.getJson<MarketDatasetManifest>(datasetRef);
  const registry = store.getJson<{ canonical_symbol: string }[]>(dataset.registry_ref);
  const market = registry.find(
    (entry) => entry.canonical_symbol === dataset.canonical_symbol
  );
  if (!market) {
    throw new Error(`Market registry entry not found: ${dataset.canonical_symbol}`);
  }

  options.emitOut(
    JSON.stringify(
      {
        dataset_ref: dataset.dataset_ref,
        market,
        latest_price: store.getJson(dataset.latest_price_ref)
      },
      null,
      2
    )
  );
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

function printHelp(emitOut: (line: string) => void): void {
  emitOut("openstrat <command>");
  emitOut(
    "commands: init, doctor, auth codex, chat, artifacts, market, strategy, backtest, gate, deploy, ledger, memory, gateway, upgrade, update, reset --purge"
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

function slugTimestamp(value: string): string {
  return value.replace(/[:]/g, "-");
}

function createFixtureHyperliquidClient(): HyperliquidReadClient {
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
            prevDayPx: "110000.0",
            dayNtlVlm: "1500000000.0",
            markPx: "113377.0",
            midPx: "113387.0",
            funding: "0.0000125",
            openInterest: "10000.0",
            premium: "0.0001",
            oraclePx: "113370.0",
            impactPxs: ["113376.0", "113397.0"],
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
          s: "BTC",
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
          s: "BTC",
          t: 1681924500000,
          v: "0.456"
        }
      ];
    },
    async fundingHistory() {
      return [
        {
          coin: "BTC",
          fundingRate: "0.0000125",
          premium: "0.0001",
          time: 1681923600000
        },
        {
          coin: "BTC",
          fundingRate: "-0.000003",
          premium: "-0.00002",
          time: 1681927200000
        }
      ];
    },
    async l2Book() {
      return {
        coin: "BTC",
        time: 1754450974231,
        levels: [
          [
            { px: "113377.0", sz: "7.6699", n: 17 },
            { px: "113376.0", sz: "4.13714", n: 8 }
          ],
          [
            { px: "113397.0", sz: "0.11543", n: 3 },
            { px: "113398.0", sz: "1.2", n: 4 }
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

function sampleStrategyMarketEvents(): StrategyMarketEvent[] {
  return [
    {
      kind: "candle",
      candle: {
        symbol: "BTC",
        canonical_symbol: "BTC-PERP",
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
        symbol: "BTC",
        canonical_symbol: "BTC-PERP",
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
        symbol: "BTC",
        canonical_symbol: "BTC-PERP",
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
