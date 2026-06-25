import { AGENT_TOOL_GATEWAY_TOOLS } from "@openstrat/workers";
import { codexAuthStatus, type OpenStratCliHome } from "./home.js";
import {
  appendArtifactIndexEntry,
  listWorkbenchSessions,
  readArtifactIndex,
  readWorkbenchSession,
  writeSessionSummary,
  type WorkbenchSessionRecord
} from "./session-store.js";
import {
  booleanArg,
  createStrategyAuthoringGuide,
  ingestDataset,
  inspectDataset,
  intervalArg,
  listBacktests,
  listDatasets,
  listMarkets,
  listStrategyFiles,
  type MarketIndexEntry,
  optionalNumberArg,
  parseWorkbenchArgs,
  planBacktest,
  planDatasetIngestion,
  refreshHyperliquidMarketCatalog,
  runBacktest,
  runRiskPreflight,
  stringArg,
  validateDataset,
  validateStrategyFile
} from "./trading-workbench.js";
import {
  buildWorkbenchSnapshot,
  formatArtifactLatest,
  formatHelp,
  formatReadiness,
  formatStatus,
  guidedWorkflow,
  repairHintForError
} from "./workbench-summary.js";

export interface SlashCommandContext {
  cwd: string;
  env: Record<string, string | undefined>;
  home: OpenStratCliHome;
  session: WorkbenchSessionRecord;
}

export interface SlashCommandResult {
  command: string;
  status: "ok" | "unavailable" | "error";
  summary: string;
  data: Record<string, unknown>;
  next_suggested_action?: string;
  session?: WorkbenchSessionRecord;
}

export const OPENSTRAT_SLASH_COMMANDS = [
  "/help",
  "/status",
  "/guide",
  "/model",
  "/effort",
  "/markets",
  "/datasets",
  "/strategy",
  "/backtest",
  "/risk",
  "/ready",
  "/artifacts",
  "/sessions",
  "/new",
  "/resume",
  "/compact",
  "/deploy"
] as const;

export function isSlashCommand(input: string): boolean {
  return input.trim().startsWith("/");
}

export async function handleSlashCommand(
  input: string,
  context: SlashCommandContext,
  createSession: () => WorkbenchSessionRecord
): Promise<SlashCommandResult> {
  const [command = "", ...args] = input.trim().split(/\s+/);
  let result: SlashCommandResult;
  try {
    switch (command) {
      case "/help":
        result = helpCommand(command, context);
        break;
      case "/status":
        result = statusCommand(command, context);
        break;
      case "/guide":
        result = guideCommand(command, context);
        break;
      case "/model":
        result = selectorCommand(
          command,
          "Open the interactive model selector in the live TUI."
        );
        break;
      case "/effort":
        result = selectorCommand(
          command,
          "Open the interactive thinking effort selector in the live TUI."
        );
        break;
      case "/markets":
        result = await marketsCommand(command, args, context);
        break;
      case "/datasets":
        result = await datasetsCommand(command, args, context);
        break;
      case "/strategy":
        result = await strategyCommand(command, args, context);
        break;
      case "/backtest":
        result = await backtestCommand(command, args, context);
        break;
      case "/risk":
        result = await riskCommand(command, args, context);
        break;
      case "/ready":
        result = readyCommand(command, context);
        break;
      case "/deploy":
        result = scaffoldCommand(
          command,
          "Deployment is intentionally unavailable in this wallet/cloud-free TUI goal.",
          "Finish local strategy validation and backtest evidence first."
        );
        break;
      case "/artifacts":
        result = artifactsCommand(command, args, context);
        break;
      case "/sessions":
        result = sessionsCommand(command, context);
        break;
      case "/new":
        result = newSessionCommand(command, createSession);
        break;
      case "/resume":
        result = resumeCommand(command, context, args[0]);
        break;
      case "/compact":
        result = compactCommand(command, context);
        break;
      default:
        result = {
          command,
          status: "error",
          summary: `Unknown OpenStrat command: ${command}`,
          data: {
            available_commands: OPENSTRAT_SLASH_COMMANDS
          }
        };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const hint = repairHintForError(message);
    result = {
      command,
      status: "error",
      summary: message,
      data: {
        error: message
      },
      ...(hint ? { next_suggested_action: hint } : {})
    };
  }

  appendArtifactIndexEntry(context.home, {
    session_id: context.session.id,
    kind: "slash_command_result",
    summary: result.summary,
    metadata: {
      command: result.command,
      status: result.status,
      data: result.data
    }
  });
  return result;
}

function helpCommand(
  command: string,
  context: SlashCommandContext
): SlashCommandResult {
  const snapshot = buildWorkbenchSnapshot({
    home: context.home,
    cwd: context.cwd,
    env: context.env,
    session: context.session
  });
  return {
    command,
    status: "ok",
    summary: formatHelp(snapshot),
    data: { snapshot },
    next_suggested_action: snapshot.readiness.next_action
  };
}

function statusCommand(
  command: string,
  context: SlashCommandContext
): SlashCommandResult {
  const auth = codexAuthStatus(context.home, context.env);
  const snapshot = buildWorkbenchSnapshot({
    home: context.home,
    cwd: context.cwd,
    env: context.env,
    session: context.session
  });
  return {
    command,
    status: "ok",
    summary: formatStatus(snapshot),
    data: {
      runtime: "codex_sdk",
      codex_auth: {
        configured: auth.configured,
        method: auth.method
      },
      sandbox_mode: "workspace-write",
      approval_policy: "on-request",
      project_home: context.home.projectRoot,
      openstrat_user_home: context.home.userRoot,
      codex_home_configured: Boolean(context.env.CODEX_HOME),
      codex_thread_id: context.session.codex_thread_id,
      gateway_tools: AGENT_TOOL_GATEWAY_TOOLS,
      datasets: listDatasets(context.home).length,
      markets: listMarkets(context.home).length,
      backtests: listBacktests(context.home).length,
      readiness: snapshot.readiness
    },
    next_suggested_action: snapshot.readiness.next_action
  };
}

function guideCommand(
  command: string,
  context: SlashCommandContext
): SlashCommandResult {
  const snapshot = buildWorkbenchSnapshot({
    home: context.home,
    cwd: context.cwd,
    env: context.env,
    session: context.session
  });
  return {
    command,
    status: "ok",
    summary: ["Guided local strategy workbench path:", ...guidedWorkflow(snapshot)]
      .map((line, index) => (index === 0 ? line : `${index}. ${line}`))
      .join("\n"),
    data: { workflow: guidedWorkflow(snapshot), readiness: snapshot.readiness },
    next_suggested_action: snapshot.readiness.next_action
  };
}

async function marketsCommand(
  command: string,
  args: string[],
  context: SlashCommandContext
): Promise<SlashCommandResult> {
  const parsed = parseWorkbenchArgs(args);
  const refresh = await refreshHyperliquidMarketCatalog(context.home, {
    fixture:
      booleanArg(parsed, "fixture") ||
      context.env.OPENSTRAT_MARKETS_FIXTURE === "1" ||
      context.env.OPENSTRAT_MARKETS_FIXTURE === "true" ||
      context.env.OPENSTRAT_CODEX_RUNTIME === "fake",
    endpoint: typeof parsed.endpoint === "string" ? parsed.endpoint : undefined,
    sessionId: context.session.id
  });
  const markets = listMarkets(context.home);
  const limit = optionalNumberArg(parsed, "limit") ?? 20;
  const query = marketQuery(args, parsed);
  const filteredMarkets = query ? filterMarkets(markets, query) : markets;
  const selectedMarket = query ? selectMarket(markets, query) : undefined;
  const visibleMarkets = marketMenuEntries(
    filteredMarkets.length > 0 ? filteredMarkets : markets,
    limit
  );
  const selectedSymbol = selectedMarket ? marketPlanSymbol(selectedMarket) : undefined;
  const nextAction = selectedMarket
    ? `/datasets plan --symbol ${selectedSymbol} ${selectedSymbol} token 5m and 15m scalping data`
    : "Choose a symbol, then run /datasets plan SOL token 5m and 15m scalping data.";
  return {
    command,
    status: "ok",
    summary: formatMarketMenu(visibleMarkets, {
      active: refresh.active_markets,
      total: markets.length,
      limit,
      query,
      selectedMarket
    }),
    data: {
      markets,
      visible_markets: visibleMarkets,
      ...(selectedMarket ? { selected_market: selectedMarket } : {}),
      registry_ref: refresh.registry_ref,
      raw_ref: refresh.raw_ref,
      supported_venues: ["hyperliquid"],
      tools: ["market_data.read_snapshot", "dataset.plan_ingestion"]
    },
    next_suggested_action: nextAction
  };
}

function marketQuery(
  args: string[],
  parsed: Record<string, unknown>
): string | undefined {
  if (typeof parsed.symbol === "string") {
    return parsed.symbol;
  }
  if (typeof parsed.query === "string") {
    return parsed.query;
  }
  if (args[0] === "select") {
    return args[1];
  }
  const positional = args.find((arg) => !arg.startsWith("--"));
  return positional;
}

function filterMarkets(markets: MarketIndexEntry[], query: string): MarketIndexEntry[] {
  const normalized = normalizeMarketQuery(query);
  return markets.filter((market) =>
    [
      market.canonical_symbol,
      market.display_symbol,
      market.venue_symbol,
      market.quote_token
    ].some(
      (value) =>
        typeof value === "string" && normalizeMarketQuery(value).includes(normalized)
    )
  );
}

function selectMarket(
  markets: MarketIndexEntry[],
  query: string
): MarketIndexEntry | undefined {
  const normalized = normalizeMarketQuery(query);
  return (
    markets.find(
      (market) =>
        typeof market.display_symbol === "string" &&
        normalizeMarketQuery(market.display_symbol) === normalized
    ) ??
    markets.find(
      (market) =>
        typeof market.canonical_symbol === "string" &&
        normalizeMarketQuery(market.canonical_symbol) === normalized
    ) ??
    filterMarkets(markets, query)[0]
  );
}

function marketPlanSymbol(market: MarketIndexEntry): string {
  return normalizeMarketQuery(
    market.canonical_symbol || market.display_symbol || market.venue_symbol || ""
  );
}

function normalizeMarketQuery(value: string): string {
  return value
    .toUpperCase()
    .replace(/-PERP$/, "")
    .replace(/[^A-Z0-9]/g, "");
}

function marketMenuEntries(
  markets: MarketIndexEntry[],
  limit: number
): MarketIndexEntry[] {
  return [...markets]
    .sort((left, right) => {
      const statusRank = statusSortRank(left.status) - statusSortRank(right.status);
      if (statusRank !== 0) {
        return statusRank;
      }
      return (right.liquidity_score ?? 0) - (left.liquidity_score ?? 0);
    })
    .slice(0, Math.max(1, limit));
}

function statusSortRank(status: MarketIndexEntry["status"]): number {
  if (status === "active") {
    return 0;
  }
  if (status === "low_liquidity") {
    return 1;
  }
  if (status === "inactive") {
    return 2;
  }
  return 3;
}

function formatMarketMenu(
  markets: MarketIndexEntry[],
  counts: {
    active: number;
    total: number;
    limit: number;
    query?: string | undefined;
    selectedMarket?: MarketIndexEntry | undefined;
  }
): string {
  const lines = [
    `Hyperliquid perps (${counts.active} active / ${counts.total} total)`,
    counts.query ? `query: ${counts.query}` : undefined,
    counts.selectedMarket
      ? `selected: ${counts.selectedMarket.canonical_symbol}`
      : undefined,
    ...markets.map((market, index) => {
      const leverage =
        market.max_leverage === undefined ? "" : ` ${market.max_leverage}x`;
      const liquidity =
        market.liquidity_score === undefined
          ? ""
          : ` liquidity=${market.liquidity_score.toFixed(2)}`;
      return `${index + 1}. ${market.canonical_symbol} ${market.status}${leverage}${liquidity}`;
    })
  ].filter((line): line is string => line !== undefined);
  if (counts.total > markets.length) {
    lines.push(
      `showing ${markets.length}; use /markets --limit ${counts.total} for all`
    );
  }
  lines.push("example: /datasets plan SOL token 5m and 15m scalping data");
  return lines.join("\n");
}

async function datasetsCommand(
  command: string,
  args: string[],
  context: SlashCommandContext
): Promise<SlashCommandResult> {
  const subcommand = args[0];
  if (subcommand === "plan") {
    const parsed = parseWorkbenchArgs(args.slice(1));
    const prompt = stringArg(parsed, "prompt", args.slice(1).join(" "));
    const plan = planDatasetIngestion({
      prompt,
      symbol: typeof parsed.symbol === "string" ? parsed.symbol : undefined,
      intervals:
        typeof parsed.interval === "string"
          ? [parsed.interval]
          : typeof parsed.intervals === "string"
            ? parsed.intervals.split(",")
            : undefined,
      start: typeof parsed.start === "string" ? parsed.start : undefined,
      end: typeof parsed.end === "string" ? parsed.end : undefined,
      home: context.home,
      sessionId: context.session.id
    });
    return {
      command,
      status: "ok",
      summary: `Planned ${plan.symbol} ${plan.intervals.join("/")} ingestion.`,
      data: { plan },
      next_suggested_action: `Approve one ingest command, for example: ${plan.slash_commands[0]}`
    };
  }

  if (subcommand === "ingest") {
    const parsed = parseWorkbenchArgs(args.slice(1));
    const dataset = await ingestDataset(context.home, {
      symbol: stringArg(parsed, "symbol"),
      interval: intervalArg(parsed.interval),
      start: stringArg(parsed, "start"),
      end: stringArg(parsed, "end"),
      fixture: booleanArg(parsed, "fixture"),
      live: booleanArg(parsed, "live"),
      endpoint: typeof parsed.endpoint === "string" ? parsed.endpoint : undefined,
      sessionId: context.session.id
    });
    return {
      command,
      status: "ok",
      summary: `Ingested dataset ${dataset.id}.`,
      data: { dataset },
      next_suggested_action: `/datasets validate ${dataset.id}`
    };
  }

  if (subcommand === "validate") {
    const validation = validateDataset(context.home, args[1], context.session.id);
    return {
      command,
      status: validation.status === "ok" ? "ok" : "error",
      summary: `${validation.status}: dataset ${validation.dataset_id} validation.`,
      data: { validation },
      next_suggested_action:
        validation.status === "ok"
          ? "/strategy validate"
          : "Fix or re-run dataset ingestion before backtesting."
    };
  }

  if (subcommand === "inspect") {
    const parsed = parseWorkbenchArgs(args.slice(1));
    const inspection = inspectDataset(
      context.home,
      typeof parsed.dataset === "string" ? parsed.dataset : args[1],
      context.session.id
    );
    return {
      command,
      status: inspection.status === "ok" ? "ok" : "error",
      summary: `${inspection.status}: inspected ${inspection.dataset_id} with ${inspection.summary.candle_count} candle rows.`,
      data: { inspection },
      next_suggested_action:
        inspection.status === "ok"
          ? "/strategy guide"
          : "Re-run ingestion or validation before authoring a strategy."
    };
  }

  const datasets = listDatasets(context.home);
  return {
    command,
    status: datasets.length > 0 ? "ok" : "unavailable",
    summary:
      datasets.length > 0
        ? `Found ${datasets.length} dataset(s).`
        : "No project datasets are indexed yet.",
    data: { datasets },
    next_suggested_action:
      datasets.length > 0
        ? "Use /backtest plan once a strategy exists."
        : 'Use /datasets plan "SOL token 5m and 15m scalping data" first.'
  };
}

async function strategyCommand(
  command: string,
  args: string[],
  context: SlashCommandContext
): Promise<SlashCommandResult> {
  if (args[0] === "guide") {
    const parsed = parseWorkbenchArgs(args.slice(1));
    const guide = createStrategyAuthoringGuide(context.home, context.cwd, {
      strategyFile: typeof parsed.strategy === "string" ? parsed.strategy : undefined,
      datasetId: typeof parsed.dataset === "string" ? parsed.dataset : undefined,
      sessionId: context.session.id
    });
    return {
      command,
      status: "ok",
      summary: `Prepared strategy authoring guide for ${guide.strategy_file}.`,
      data: { guide },
      next_suggested_action: guide.next_commands[0] ?? "/strategy validate"
    };
  }

  if (args[0] === "validate") {
    const parsed = parseWorkbenchArgs(args.slice(1));
    const validation = await validateStrategyFile(
      context.home,
      context.cwd,
      typeof parsed.strategy === "string" ? parsed.strategy : args[1],
      typeof parsed.dataset === "string" ? parsed.dataset : undefined,
      context.session.id
    );
    return {
      command,
      status: validation.status === "ok" ? "ok" : "error",
      summary: `${validation.status}: strategy validation for ${validation.strategy_file}.`,
      data: { validation },
      next_suggested_action:
        validation.status === "ok"
          ? "/backtest plan"
          : "Ask Codex to revise the strategy against the validation issues."
    };
  }

  const candidates = listStrategyFiles(context.cwd);
  return {
    command,
    status: "ok",
    summary:
      candidates.length > 0
        ? `Found ${candidates.length} strategy source candidate(s).`
        : "No strategy source file found yet.",
    data: {
      strategy_files: candidates
    },
    next_suggested_action:
      candidates.length > 0
        ? "/strategy validate"
        : "Ask Codex to write a strategy using @openstrat/strategy-sdk."
  };
}

async function backtestCommand(
  command: string,
  args: string[],
  context: SlashCommandContext
): Promise<SlashCommandResult> {
  const subcommand = args[0];
  if (subcommand === "plan") {
    const parsed = parseWorkbenchArgs(args.slice(1));
    const plan = await planBacktest(context.home, context.cwd, {
      strategyFile: typeof parsed.strategy === "string" ? parsed.strategy : undefined,
      datasetId: typeof parsed.dataset === "string" ? parsed.dataset : undefined,
      initialEquityUsd: optionalNumberArg(parsed, "initial_equity"),
      feeBps: optionalNumberArg(parsed, "fee_bps"),
      slippageBps: optionalNumberArg(parsed, "slippage_bps"),
      runId: typeof parsed.run_id === "string" ? parsed.run_id : undefined,
      sessionId: context.session.id
    });
    return {
      command,
      status: "ok",
      summary: `Planned backtest ${plan.run_id}.`,
      data: { plan },
      next_suggested_action: plan.slash_command
    };
  }

  if (subcommand === "run") {
    const parsed = parseWorkbenchArgs(args.slice(1));
    const backtest = await runBacktest(context.home, context.cwd, {
      strategyFile: typeof parsed.strategy === "string" ? parsed.strategy : undefined,
      datasetId: typeof parsed.dataset === "string" ? parsed.dataset : undefined,
      initialEquityUsd: optionalNumberArg(parsed, "initial_equity"),
      feeBps: optionalNumberArg(parsed, "fee_bps"),
      slippageBps: optionalNumberArg(parsed, "slippage_bps"),
      runId: typeof parsed.run_id === "string" ? parsed.run_id : undefined,
      sessionId: context.session.id
    });
    return {
      command,
      status: "ok",
      summary: `Backtest ${backtest.run_id}: ${backtest.metrics.trades} trades, PnL ${backtest.metrics.pnl_usd}.`,
      data: { backtest },
      next_suggested_action: "/risk preflight"
    };
  }

  const backtests = listBacktests(context.home);
  return {
    command,
    status: backtests.length > 0 ? "ok" : "unavailable",
    summary:
      backtests.length > 0
        ? `Found ${backtests.length} backtest report(s).`
        : "No local backtest reports are indexed yet.",
    data: { backtests },
    next_suggested_action:
      backtests.length > 0
        ? "/risk preflight"
        : "Use /backtest plan after dataset and strategy validation pass."
  };
}

async function riskCommand(
  command: string,
  args: string[],
  context: SlashCommandContext
): Promise<SlashCommandResult> {
  if (args[0] === "preflight") {
    const parsed = parseWorkbenchArgs(args.slice(1));
    const preflight = await runRiskPreflight(context.home, context.cwd, {
      strategyFile: typeof parsed.strategy === "string" ? parsed.strategy : undefined,
      datasetId: typeof parsed.dataset === "string" ? parsed.dataset : undefined,
      backtestRunId: typeof parsed.backtest === "string" ? parsed.backtest : undefined,
      maxNotionalUsd: optionalNumberArg(parsed, "max_notional"),
      maxDrawdownPct: optionalNumberArg(parsed, "max_drawdown_pct"),
      minTrades: optionalNumberArg(parsed, "min_trades"),
      minWinRate: optionalNumberArg(parsed, "min_win_rate"),
      policyRef: typeof parsed.policy_ref === "string" ? parsed.policy_ref : undefined,
      sessionId: context.session.id
    });
    return {
      command,
      status: preflight.review.status === "approved" ? "ok" : "unavailable",
      summary: `${preflight.review.status}: local risk preflight ${preflight.id}.`,
      data: { preflight },
      next_suggested_action:
        preflight.review.status === "approved"
          ? "The local strategy loop has dataset, strategy, backtest, and risk evidence."
          : "Resolve failed preflight checks before wallet or deployment work."
    };
  }

  return {
    command,
    status: "unavailable",
    summary:
      "Run /risk preflight after dataset, strategy, and backtest evidence exists.",
    data: {
      backed: true,
      preflight_command: "/risk preflight"
    },
    next_suggested_action: "/risk preflight"
  };
}

function readyCommand(
  command: string,
  context: SlashCommandContext
): SlashCommandResult {
  const snapshot = buildWorkbenchSnapshot({
    home: context.home,
    cwd: context.cwd,
    env: context.env,
    session: context.session
  });
  return {
    command,
    status: snapshot.readiness.local_strategy_ready ? "ok" : "unavailable",
    summary: formatReadiness(snapshot),
    data: { readiness: snapshot.readiness },
    next_suggested_action: snapshot.readiness.next_action
  };
}

function artifactsCommand(
  command: string,
  args: string[],
  context: SlashCommandContext
): SlashCommandResult {
  const snapshot = buildWorkbenchSnapshot({
    home: context.home,
    cwd: context.cwd,
    env: context.env,
    session: context.session
  });
  if (args[0] === "latest") {
    return {
      command,
      status: "ok",
      summary: formatArtifactLatest(snapshot),
      data: { latest: snapshot.latest },
      next_suggested_action: snapshot.readiness.next_action
    };
  }
  const entries = readArtifactIndex(context.home).entries;
  return {
    command,
    status: "ok",
    summary: `Artifact index contains ${entries.length} entr${entries.length === 1 ? "y" : "ies"}.`,
    data: {
      entries: entries.slice(-10)
    },
    next_suggested_action:
      entries.length > 0 ? "/artifacts latest" : snapshot.readiness.next_action
  };
}

function sessionsCommand(
  command: string,
  context: SlashCommandContext
): SlashCommandResult {
  const sessions = listWorkbenchSessions(context.home);
  return {
    command,
    status: "ok",
    summary: `Found ${sessions.length} OpenStrat workbench session(s).`,
    data: {
      sessions: sessions.map((session) => ({
        id: session.id,
        updated_at: session.updated_at,
        cwd: session.cwd,
        codex_thread_id: session.codex_thread_id,
        summary_ref: session.summary_ref
      }))
    }
  };
}

function newSessionCommand(
  command: string,
  createSession: () => WorkbenchSessionRecord
): SlashCommandResult {
  const session = createSession();
  return {
    command,
    status: "ok",
    summary: `Started new OpenStrat session ${session.id}.`,
    data: {
      session_id: session.id
    },
    session
  };
}

function resumeCommand(
  command: string,
  context: SlashCommandContext,
  sessionId?: string
): SlashCommandResult {
  if (!sessionId) {
    return sessionsCommand(command, context);
  }
  const session = readWorkbenchSession(context.home, sessionId);
  if (!session) {
    return {
      command,
      status: "error",
      summary: `Session not found: ${sessionId}`,
      data: { session_id: sessionId }
    };
  }
  return {
    command,
    status: "ok",
    summary: `Resumed OpenStrat session ${session.id}.`,
    data: {
      session_id: session.id,
      codex_thread_id: session.codex_thread_id
    },
    session
  };
}

function compactCommand(
  command: string,
  context: SlashCommandContext
): SlashCommandResult {
  const session = writeSessionSummary(context.home, context.session);
  return {
    command,
    status: "ok",
    summary: `Wrote OpenStrat session summary for ${session.id}.`,
    data: {
      session_id: session.id,
      summary_ref: session.summary_ref
    },
    session
  };
}

function selectorCommand(command: string, summary: string): SlashCommandResult {
  return {
    command,
    status: "ok",
    summary,
    data: {
      interactive_only: true
    }
  };
}

function scaffoldCommand(
  command: string,
  summary: string,
  nextSuggestedAction: string
): SlashCommandResult {
  return {
    command,
    status: "unavailable",
    summary,
    data: {
      backed: false
    },
    next_suggested_action: nextSuggestedAction
  };
}
