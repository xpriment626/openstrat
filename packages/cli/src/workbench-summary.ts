import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  codexAuthStatus,
  type CodexAuthStatus,
  type OpenStratCliHome
} from "./home.js";
import {
  listWorkbenchSessions,
  readArtifactIndex,
  type ArtifactIndexEntry,
  type WorkbenchSessionRecord
} from "./session-store.js";
import {
  listBacktests,
  listDatasets,
  listMarkets,
  listStrategyFiles
} from "./trading-workbench.js";

export interface WorkbenchSnapshot {
  cwd: string;
  auth: CodexAuthStatus;
  homes: {
    project: string;
    user: string;
    codex: string;
  };
  session?: {
    id: string;
    codex_thread_id?: string;
    summary_ref?: string;
  };
  counts: {
    datasets: number;
    markets: number;
    strategies: number;
    backtests: number;
    sessions: number;
    artifacts: number;
  };
  latest: Partial<Record<ArtifactIndexEntry["kind"], ArtifactIndexEntry>>;
  readiness: {
    status: "ready_for_wallet_and_deploy_prereqs" | "needs_local_work";
    local_strategy_ready: boolean;
    wallet_configured: false;
    deployment_configured: false;
    blockers: string[];
    warnings: string[];
    next_action: string;
  };
}

export interface InstallDiagnostics {
  node_version: string;
  node_requirement: string;
  node_ok: boolean;
  cli_entrypoint?: string;
  cli_entrypoint_exists?: boolean;
  bin_executable?: boolean;
  dist_index_exists?: boolean;
}

export function buildWorkbenchSnapshot(input: {
  home: OpenStratCliHome;
  cwd: string;
  env: Record<string, string | undefined>;
  session?: WorkbenchSessionRecord | undefined;
}): WorkbenchSnapshot {
  const artifacts = readArtifactIndex(input.home).entries;
  const datasets = listDatasets(input.home);
  const backtests = listBacktests(input.home);
  const strategies = listStrategyFiles(input.cwd);
  const latest = latestArtifactsByKind(artifacts);
  const auth = codexAuthStatus(input.home, input.env);
  const hasDatasetEvidence =
    datasets.length > 0 &&
    artifactOk(latest.dataset_validation, "validation") &&
    artifactOk(latest.dataset_inspection, "inspection");
  const hasStrategyEvidence =
    strategies.length > 0 && artifactOk(latest.strategy_validation, "validation");
  const hasBacktestEvidence = backtests.length > 0 || Boolean(latest.backtest_report);
  const hasRiskEvidence =
    artifactReviewStatus(latest.risk_preflight) === "approved" ||
    latest.risk_preflight?.summary.startsWith("approved:") === true;
  const warnings = [
    auth.configured ? undefined : "Codex auth is missing for live Codex turns."
  ].filter((warning): warning is string => warning !== undefined);
  const blockers = [
    hasDatasetEvidence
      ? undefined
      : "Dataset evidence is incomplete: plan, ingest, validate, and inspect data.",
    hasStrategyEvidence
      ? undefined
      : "Strategy evidence is incomplete: create a strategy, request a guide, and validate it against a dataset.",
    hasBacktestEvidence
      ? undefined
      : "Backtest evidence is missing: run a configured local backtest.",
    hasRiskEvidence
      ? undefined
      : "Risk evidence is missing or not approved: run local risk preflight."
  ].filter((blocker): blocker is string => blocker !== undefined);
  const localStrategyReady =
    hasDatasetEvidence && hasStrategyEvidence && hasBacktestEvidence && hasRiskEvidence;

  return {
    cwd: input.cwd,
    auth,
    homes: {
      project: input.home.projectRoot,
      user: input.home.userRoot,
      codex: input.home.codexHome
    },
    ...(input.session
      ? {
          session: {
            id: input.session.id,
            ...(input.session.codex_thread_id
              ? { codex_thread_id: input.session.codex_thread_id }
              : {}),
            ...(input.session.summary_ref
              ? { summary_ref: input.session.summary_ref }
              : {})
          }
        }
      : {}),
    counts: {
      datasets: datasets.length,
      markets: listMarkets(input.home).length,
      strategies: strategies.length,
      backtests: backtests.length,
      sessions: listWorkbenchSessions(input.home).length,
      artifacts: artifacts.length
    },
    latest,
    readiness: {
      status: localStrategyReady
        ? "ready_for_wallet_and_deploy_prereqs"
        : "needs_local_work",
      local_strategy_ready: localStrategyReady,
      wallet_configured: false,
      deployment_configured: false,
      blockers,
      warnings,
      next_action: nextAction({
        auth,
        datasets: datasets.length,
        strategies: strategies.length,
        backtests: backtests.length,
        latest
      })
    }
  };
}

export function buildInstallDiagnostics(cliEntrypoint?: string): InstallDiagnostics {
  const diagnostics: InstallDiagnostics = {
    node_version: process.version,
    node_requirement: ">=22.19.0",
    node_ok: nodeVersionAtLeast(process.version, 22, 19, 0)
  };
  if (!cliEntrypoint) {
    return diagnostics;
  }
  const resolvedEntrypoint = existsSync(cliEntrypoint)
    ? realpathSync(cliEntrypoint)
    : cliEntrypoint;
  const entrypointExists = existsSync(cliEntrypoint);
  const distDir = dirname(resolvedEntrypoint);
  const distIndex = join(distDir, "index.js");
  return {
    ...diagnostics,
    cli_entrypoint: cliEntrypoint,
    cli_entrypoint_exists: entrypointExists,
    bin_executable: entrypointExists
      ? (statSync(cliEntrypoint).mode & 0o111) !== 0
      : false,
    dist_index_exists: existsSync(distIndex)
  };
}

export function formatWorkbenchBanner(input: {
  runtimeKind: string;
  snapshot: WorkbenchSnapshot;
  commands: readonly string[];
}): string {
  const { snapshot } = input;
  return [
    "OpenStrat Workbench",
    `runtime: ${input.runtimeKind}`,
    `session: ${snapshot.session?.id ?? "none"}`,
    `codex auth: ${snapshot.auth.configured ? snapshot.auth.method : "missing"}`,
    `project home: ${snapshot.homes.project}`,
    `user home: ${snapshot.homes.user}`,
    `state: ${snapshot.counts.datasets} dataset(s), ${snapshot.counts.strategies} strategy file(s), ${snapshot.counts.backtests} backtest(s), ${snapshot.counts.artifacts} artifact(s)`,
    `commands: ${input.commands.join(", ")}`,
    `next: ${snapshot.readiness.next_action}`
  ].join("\n");
}

export function formatHelp(snapshot: WorkbenchSnapshot): string {
  return [
    "OpenStrat local workbench commands:",
    "",
    "Core:",
    "  /help - grouped commands, examples, and guided path",
    "  /status - project homes, auth, evidence counts, and next action",
    "  /guide - guided local strategy workflow",
    "  /ready - local readiness summary before wallet/deploy work",
    "",
    "Market data:",
    "  /markets [symbol] - refresh/select Hyperliquid perps",
    "  /datasets plan|ingest|validate|inspect - dataset workflow",
    "",
    "Strategy loop:",
    "  /strategy guide|validate - SDK guidance and validation",
    "  /backtest plan|run - local configured candle backtests",
    "  /risk preflight - local evidence and threshold gate",
    "  /artifacts latest - latest evidence refs by kind",
    "",
    "Sessions:",
    "  /sessions - list workbench sessions",
    "  /resume <id> - resume a prior OpenStrat session",
    "  /new - start a fresh session",
    "  /compact - write a workbench memory summary",
    "",
    "Examples:",
    "  /markets SOL",
    '  /datasets plan "SOL token 5m and 15m scalping data"',
    "  /strategy guide --strategy src/strategy.ts",
    "  /backtest run --strategy src/strategy.ts --run-id local_smoke",
    "",
    "Guided path:",
    ...guidedWorkflow(snapshot).map((step, index) => `${index + 1}. ${step}`)
  ].join("\n");
}

export function formatStatus(snapshot: WorkbenchSnapshot): string {
  return [
    `session: ${snapshot.session?.id ?? "none"}`,
    `codex auth: ${snapshot.auth.configured ? snapshot.auth.method : "missing"}`,
    `project home: ${snapshot.homes.project}`,
    `user home: ${snapshot.homes.user}`,
    `codex home: ${snapshot.homes.codex}`,
    `state: ${snapshot.counts.datasets} dataset(s), ${snapshot.counts.markets} market(s), ${snapshot.counts.strategies} strategy file(s), ${snapshot.counts.backtests} backtest(s)`,
    `artifacts: ${snapshot.counts.artifacts}`,
    `local readiness: ${snapshot.readiness.status}`,
    `wallet: not configured`,
    `deployment: not configured`
  ].join("\n");
}

export function formatArtifactLatest(snapshot: WorkbenchSnapshot): string {
  const kinds: ArtifactIndexEntry["kind"][] = [
    "dataset_ingestion_plan",
    "dataset_ingest_result",
    "dataset_validation",
    "dataset_inspection",
    "strategy_authoring_guide",
    "strategy_validation",
    "backtest_report",
    "risk_preflight",
    "session_summary"
  ];
  const lines = kinds.map((kind) => {
    const artifact = snapshot.latest[kind];
    return artifact
      ? `${kind}: ${artifact.summary}${artifact.ref ? ` (${artifact.ref})` : ""}`
      : `${kind}: missing`;
  });
  return ["Latest local evidence:", ...lines].join("\n");
}

export function formatReadiness(snapshot: WorkbenchSnapshot): string {
  return [
    `local strategy ready: ${snapshot.readiness.local_strategy_ready ? "yes" : "no"}`,
    `status: ${snapshot.readiness.status}`,
    `wallet configured: no`,
    `deployment configured: no`,
    snapshot.readiness.blockers.length > 0
      ? `blockers: ${snapshot.readiness.blockers.join(" | ")}`
      : "blockers: none for the local wallet/deploy prerequisite loop",
    snapshot.readiness.warnings.length > 0
      ? `warnings: ${snapshot.readiness.warnings.join(" | ")}`
      : "warnings: none",
    `next: ${snapshot.readiness.next_action}`
  ].join("\n");
}

export function formatInstallDiagnostics(diagnostics: InstallDiagnostics): string {
  return [
    `node: ${diagnostics.node_version} (${diagnostics.node_ok ? "ok" : `requires ${diagnostics.node_requirement}`})`,
    diagnostics.cli_entrypoint
      ? `cli entrypoint: ${diagnostics.cli_entrypoint}`
      : "cli entrypoint: unknown",
    diagnostics.cli_entrypoint_exists === undefined
      ? undefined
      : `cli entrypoint exists: ${diagnostics.cli_entrypoint_exists ? "yes" : "no"}`,
    diagnostics.bin_executable === undefined
      ? undefined
      : `bin executable: ${diagnostics.bin_executable ? "yes" : "no"}`,
    diagnostics.dist_index_exists === undefined
      ? undefined
      : `dist index: ${diagnostics.dist_index_exists ? "present" : "missing"}`
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

export function repairHintForError(message: string): string | undefined {
  if (/Codex auth|auth.*missing|CODEX/i.test(message)) {
    return "Run `openstrat auth codex` with the intended CODEX_HOME, then retry.";
  }
  if (/Strategy file not found/i.test(message)) {
    return "Ask Codex to create `src/strategy.ts`, or run `/strategy guide --strategy src/strategy.ts` first.";
  }
  if (
    /required_data|allowed_symbols|entrypoint|unsupported package|forbidden API|TradeIntent/i.test(
      message
    )
  ) {
    return "Ask Codex to revise the strategy against `/strategy validate --strategy src/strategy.ts --dataset <dataset-id>`.";
  }
  if (/No dataset|Dataset .*not found/i.test(message)) {
    return "Run `/datasets plan`, approve an ingest command, then `/datasets validate` and `/datasets inspect`.";
  }
  if (/requires --fixture|--live/i.test(message)) {
    return "Use `--fixture` for deterministic local tests or `--live` for approved Hyperliquid read-only ingestion.";
  }
  if (/backtest|Backtest/i.test(message)) {
    return "Validate dataset and strategy evidence first, then run `/backtest plan` followed by `/backtest run`.";
  }
  if (/risk|preflight|threshold/i.test(message)) {
    return "Inspect the failed `/risk preflight` checks and rerun with a supported local policy threshold.";
  }
  return undefined;
}

export function guidedWorkflow(snapshot: WorkbenchSnapshot): string[] {
  const datasetId = latestDatasetId(snapshot);
  const strategyFile = "src/strategy.ts";
  return [
    snapshot.auth.configured
      ? "Codex auth is configured for live turns."
      : "Run `openstrat auth codex` before expecting live Codex turns.",
    '/datasets plan "SOL token 5m and 15m scalping data"',
    "/datasets ingest --symbol SOL --interval 5m --start <iso-start> --end <iso-end> --fixture",
    datasetId ? `/datasets validate ${datasetId}` : "/datasets validate",
    datasetId ? `/datasets inspect ${datasetId}` : "/datasets inspect",
    datasetId
      ? `/strategy guide --strategy ${strategyFile} --dataset ${datasetId}`
      : `/strategy guide --strategy ${strategyFile}`,
    `Ask Codex to write or repair ${strategyFile} using the strategy guide and dataset refs.`,
    datasetId
      ? `/strategy validate --strategy ${strategyFile} --dataset ${datasetId}`
      : `/strategy validate --strategy ${strategyFile}`,
    datasetId
      ? `/backtest run --strategy ${strategyFile} --dataset ${datasetId} --initial-equity 20000 --fee-bps 7 --slippage-bps 3 --run-id local_smoke`
      : `/backtest run --strategy ${strategyFile} --initial-equity 20000 --fee-bps 7 --slippage-bps 3 --run-id local_smoke`,
    "/risk preflight --strategy src/strategy.ts --backtest local_smoke --max-notional 1500 --max-drawdown-pct 25 --min-trades 1 --min-win-rate 0 --policy-ref risk/local",
    "/artifacts latest",
    "/ready"
  ];
}

function latestArtifactsByKind(
  artifacts: ArtifactIndexEntry[]
): Partial<Record<ArtifactIndexEntry["kind"], ArtifactIndexEntry>> {
  const latest: Partial<Record<ArtifactIndexEntry["kind"], ArtifactIndexEntry>> = {};
  for (const artifact of artifacts) {
    const current = latest[artifact.kind];
    if (!current || current.created_at.localeCompare(artifact.created_at) <= 0) {
      latest[artifact.kind] = artifact;
    }
  }
  return latest;
}

function artifactOk(
  artifact: ArtifactIndexEntry | undefined,
  metadataKey: string
): boolean {
  if (!artifact) {
    return false;
  }
  const nested = artifact.metadata[metadataKey];
  if (isRecord(nested) && nested.status === "ok") {
    return true;
  }
  return artifact.summary.startsWith("ok:");
}

function artifactReviewStatus(
  artifact: ArtifactIndexEntry | undefined
): string | undefined {
  const preflight = artifact?.metadata.preflight;
  if (!isRecord(preflight)) {
    return undefined;
  }
  const review = preflight.review;
  return isRecord(review) && typeof review.status === "string"
    ? review.status
    : undefined;
}

function nextAction(input: {
  auth: CodexAuthStatus;
  datasets: number;
  strategies: number;
  backtests: number;
  latest: Partial<Record<ArtifactIndexEntry["kind"], ArtifactIndexEntry>>;
}): string {
  if (!input.auth.configured) {
    return "Run `openstrat auth codex`, or continue with OPENSTRAT_CODEX_RUNTIME=fake for local smoke tests.";
  }
  if (!input.latest.dataset_ingestion_plan) {
    return '/datasets plan "SOL token 5m and 15m scalping data"';
  }
  if (input.datasets === 0) {
    return "Approve and run one dataset ingest command from the plan.";
  }
  if (!input.latest.dataset_validation) {
    return "/datasets validate";
  }
  if (!input.latest.dataset_inspection) {
    return "/datasets inspect";
  }
  if (input.strategies === 0) {
    return "Ask Codex to write `src/strategy.ts` using `/strategy guide`.";
  }
  if (!input.latest.strategy_authoring_guide) {
    return "/strategy guide --strategy src/strategy.ts";
  }
  if (!artifactOk(input.latest.strategy_validation, "validation")) {
    return "/strategy validate --strategy src/strategy.ts --dataset <dataset-id>";
  }
  if (input.backtests === 0) {
    return "/backtest run --strategy src/strategy.ts --dataset <dataset-id> --run-id local_smoke";
  }
  if (artifactReviewStatus(input.latest.risk_preflight) !== "approved") {
    return "/risk preflight --strategy src/strategy.ts --backtest <run-id>";
  }
  return "/ready";
}

function latestDatasetId(snapshot: WorkbenchSnapshot): string | undefined {
  const dataset = snapshot.latest.dataset_ingest_result?.metadata.dataset;
  return isRecord(dataset) && typeof dataset.id === "string" ? dataset.id : undefined;
}

function nodeVersionAtLeast(
  version: string,
  major: number,
  minor: number,
  patch: number
): boolean {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match?.[1] || !match[2] || !match[3]) {
    return false;
  }
  const current = [Number(match[1]), Number(match[2]), Number(match[3])];
  const required = [major, minor, patch];
  for (const [index, value] of current.entries()) {
    if (value > required[index]!) {
      return true;
    }
    if (value < required[index]!) {
      return false;
    }
  }
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
