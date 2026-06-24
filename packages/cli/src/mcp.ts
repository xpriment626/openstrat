import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  BacktestRequestSchema,
  DeploymentGateSchema,
  MemoryProposalSchema,
  MarketDatumSchema,
  OPENSTRAT_CODEX_BASELINE_CONTRACT,
  RiskReviewSchema,
  RiskPolicySchema,
  StrategyPatchProposalSchema,
  TradeIntentSchema,
  type Candle,
  type MarketDatum,
  type MarketRegistryEntry,
  type OrderbookSnapshot,
  type RiskPolicy,
  type RiskReview,
  type TradeIntent
} from "@openstrat/domain";
import type {
  CandleQuery,
  MarketDataQuery,
  MarketDataReader,
  OrderbookQuery
} from "@openstrat/market-data";
import { FileObjectStore, SqliteEventLog } from "@openstrat/persistence";
import type { RiskContext, RiskPolicyEngine } from "@openstrat/risk";
import {
  createAgentToolGateway,
  type AgentToolGatewayToolName
} from "@openstrat/workers";
import { z } from "zod";
import { ensureOpenStratCliHome, resolveOpenStratCliHome } from "./home.js";
import {
  booleanArg,
  createStrategyAuthoringGuide,
  ingestDataset,
  inspectDataset,
  intervalArg,
  listDatasets,
  listMarkets,
  optionalNumberArg,
  planBacktest,
  planDatasetIngestion,
  runBacktest,
  runRiskPreflight,
  stringArg as workbenchStringArg,
  validateDataset,
  validateStrategyFile
} from "./trading-workbench.js";

export interface OpenStratMcpToolOutput {
  [key: string]: unknown;
  status: "completed" | "failed";
  canonical_tool_name: AgentToolGatewayToolName;
  result?: unknown;
  error?: string;
}

export async function runOpenStratMcpServer(
  env: Record<string, string | undefined> = process.env,
  cwd = process.cwd()
): Promise<void> {
  const home = resolveOpenStratCliHome({ cwd, env });
  ensureOpenStratCliHome(home);
  const server = new McpServer(
    {
      name: "openstrat",
      version: "0.0.0"
    },
    {
      instructions:
        "OpenStrat exposes trading-strategy workbench tools. Generated strategy code must use OpenStrat strategy contracts and must not call exchanges directly."
    }
  );

  for (const tool of OPENSTRAT_CODEX_BASELINE_CONTRACT.openstrat_tools) {
    server.registerTool(
      tool.name.replaceAll(".", "_"),
      {
        description: mcpToolDescription(tool.name as AgentToolGatewayToolName),
        inputSchema: mcpInputSchema(tool.name as AgentToolGatewayToolName)
      },
      async (args) => {
        const input = args as Record<string, unknown>;
        const output = await invokeOpenStratMcpTool(
          tool.name as AgentToolGatewayToolName,
          input,
          env,
          cwd
        );
        return {
          content: [{ type: "text", text: JSON.stringify(output) }],
          structuredContent: output
        };
      }
    );
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

function mcpToolDescription(toolName: AgentToolGatewayToolName): string {
  switch (toolName) {
    case "dataset.plan_ingestion":
      return "Plan market-data ingestion from a natural-language trading need. Propose commands; do not ingest until approved.";
    case "dataset.execute_ingestion":
      return "Ingest approved market data into the project .openstrat object store. Use fixture=true for deterministic local tests or live=true for Hyperliquid read-only API access.";
    case "dataset.validate":
      return "Validate that indexed dataset refs and candle rows are usable before strategy/backtest work.";
    case "dataset.inspect":
      return "Inspect indexed dataset coverage, candle counts, refs, symbols, intervals, and validation status before authoring or backtesting a strategy.";
    case "strategy.guide":
      return "Return OpenStrat strategy authoring guidance and a valid @openstrat/strategy-sdk template for the selected dataset.";
    case "strategy.validate":
      return "Validate strategy source against OpenStrat manifest, dataset, deterministic output, and forbidden API constraints.";
    case "backtest.plan":
      return "Plan a local backtest with explicit dataset, strategy, equity, fee, slippage, and run id settings.";
    case "backtest.run":
      return "Run a local deterministic candle backtest and persist report, ledger, metrics, warnings, and artifact refs.";
    case "risk.preflight":
      return "Run local evidence-based risk preflight over dataset, strategy validation, and backtest metrics. No wallets, signing, or live trading.";
    default:
      return `${toolName}: OpenStrat project workbench tool.`;
  }
}

function mcpInputSchema(toolName: AgentToolGatewayToolName): z.ZodTypeAny {
  const base = {
    call_id: z.string().optional(),
    session_id: z.string().optional(),
    turn_id: z.string().optional()
  };
  switch (toolName) {
    case "market_data.read_snapshot":
      return z
        .object({
          ...base,
          canonical_symbol: z.string().describe("Example: SOL-PERP")
        })
        .passthrough();
    case "dataset.plan_ingestion":
      return z
        .object({
          ...base,
          prompt: z.string().optional(),
          symbol: z.string().optional().describe("Example: SOL"),
          intervals: z.array(z.string()).optional().describe("Examples: 5m, 15m"),
          start: z.string().optional().describe("ISO timestamp or epoch ms"),
          end: z.string().optional().describe("ISO timestamp or epoch ms")
        })
        .passthrough();
    case "dataset.execute_ingestion":
      return z
        .object({
          ...base,
          symbol: z.string(),
          interval: z.string(),
          start: z.string(),
          end: z.string(),
          fixture: z.boolean().optional(),
          live: z.boolean().optional(),
          endpoint: z.string().optional()
        })
        .passthrough();
    case "dataset.validate":
    case "dataset.inspect":
      return z.object({ ...base, dataset_id: z.string().optional() }).passthrough();
    case "strategy.guide":
    case "strategy.validate":
      return z
        .object({
          ...base,
          strategy_file: z.string().optional(),
          dataset_id: z.string().optional()
        })
        .passthrough();
    case "backtest.plan":
    case "backtest.run":
      return z
        .object({
          ...base,
          strategy_file: z.string().optional(),
          dataset_id: z.string().optional(),
          initial_equity_usd: z.number().optional(),
          fee_bps: z.number().optional(),
          slippage_bps: z.number().optional(),
          run_id: z.string().optional()
        })
        .passthrough();
    case "risk.preflight":
      return z
        .object({
          ...base,
          strategy_file: z.string().optional(),
          dataset_id: z.string().optional(),
          backtest_run_id: z.string().optional(),
          max_notional_usd: z.number().optional(),
          max_drawdown_pct: z.number().optional(),
          min_trades: z.number().optional(),
          min_win_rate: z.number().optional(),
          policy_ref: z.string().optional()
        })
        .passthrough();
    default:
      return z.object(base).passthrough();
  }
}

export async function invokeOpenStratMcpTool(
  toolName: AgentToolGatewayToolName,
  args: Record<string, unknown>,
  env: Record<string, string | undefined>,
  cwd: string
): Promise<OpenStratMcpToolOutput> {
  const home = resolveOpenStratCliHome({ cwd, env });
  ensureOpenStratCliHome(home);
  const events = new SqliteEventLog(home.stateDbPath);
  const objects = new FileObjectStore(`${home.projectRoot}/objects`);
  const gateway = createAgentToolGateway({
    events,
    objects,
    marketData: new ProjectMarketDataReader(home),
    risk: new UnavailableRiskEngine(),
    now: () => new Date().toISOString()
  });
  const base = invocationBase(args);

  try {
    switch (toolName) {
      case "market_data.read_snapshot":
        return completed(
          toolName,
          await gateway.readMarketDataSnapshot({
            ...base,
            canonical_symbol: stringArg(args, "canonical_symbol")
          })
        );
      case "dataset.plan_ingestion":
        return completed(
          toolName,
          planDatasetIngestion({
            prompt: optionalStringArg(args, "prompt") ?? "",
            symbol: optionalStringArg(args, "symbol"),
            intervals: stringArrayArg(args, "intervals"),
            start: optionalStringArg(args, "start"),
            end: optionalStringArg(args, "end"),
            home,
            sessionId: base.session_id
          })
        );
      case "dataset.execute_ingestion":
        return completed(
          toolName,
          await ingestDataset(home, {
            symbol: workbenchStringArg(args, "symbol"),
            interval: intervalArg(args.interval),
            start: workbenchStringArg(args, "start"),
            end: workbenchStringArg(args, "end"),
            fixture: booleanArg(args, "fixture"),
            live: booleanArg(args, "live"),
            endpoint: optionalStringArg(args, "endpoint"),
            sessionId: base.session_id
          })
        );
      case "dataset.validate":
        return completed(
          toolName,
          validateDataset(home, optionalStringArg(args, "dataset_id"), base.session_id)
        );
      case "dataset.inspect":
        return completed(
          toolName,
          inspectDataset(home, optionalStringArg(args, "dataset_id"), base.session_id)
        );
      case "strategy.guide":
        return completed(
          toolName,
          createStrategyAuthoringGuide(home, cwd, {
            strategyFile: optionalStringArg(args, "strategy_file"),
            datasetId: optionalStringArg(args, "dataset_id"),
            sessionId: base.session_id
          })
        );
      case "strategy.validate":
        return completed(
          toolName,
          await validateStrategyFile(
            home,
            cwd,
            optionalStringArg(args, "strategy_file"),
            optionalStringArg(args, "dataset_id"),
            base.session_id
          )
        );
      case "backtest.plan":
        return completed(
          toolName,
          await planBacktest(home, cwd, {
            strategyFile: optionalStringArg(args, "strategy_file"),
            datasetId: optionalStringArg(args, "dataset_id"),
            initialEquityUsd: optionalNumberArg(args, "initial_equity_usd"),
            feeBps: optionalNumberArg(args, "fee_bps"),
            slippageBps: optionalNumberArg(args, "slippage_bps"),
            runId: optionalStringArg(args, "run_id"),
            sessionId: base.session_id
          })
        );
      case "backtest.run":
        return completed(
          toolName,
          await runBacktest(home, cwd, {
            strategyFile: optionalStringArg(args, "strategy_file"),
            datasetId: optionalStringArg(args, "dataset_id"),
            initialEquityUsd: optionalNumberArg(args, "initial_equity_usd"),
            feeBps: optionalNumberArg(args, "fee_bps"),
            slippageBps: optionalNumberArg(args, "slippage_bps"),
            runId: optionalStringArg(args, "run_id"),
            sessionId: base.session_id
          })
        );
      case "backtest.request":
        return completed(
          toolName,
          await gateway.captureBacktestRequest({
            ...base,
            request: BacktestRequestSchema.parse(requiredRecord(args, "request"))
          })
        );
      case "risk.preflight":
        return completed(
          toolName,
          await runRiskPreflight(home, cwd, {
            strategyFile: optionalStringArg(args, "strategy_file"),
            datasetId: optionalStringArg(args, "dataset_id"),
            backtestRunId: optionalStringArg(args, "backtest_run_id"),
            maxNotionalUsd: optionalNumberArg(args, "max_notional_usd"),
            maxDrawdownPct: optionalNumberArg(args, "max_drawdown_pct"),
            minTrades: optionalNumberArg(args, "min_trades"),
            minWinRate: optionalNumberArg(args, "min_win_rate"),
            policyRef: optionalStringArg(args, "policy_ref"),
            sessionId: base.session_id
          })
        );
      case "risk.validate_intent":
        return completed(
          toolName,
          await gateway.validateRisk({
            ...base,
            intent: TradeIntentSchema.parse(requiredRecord(args, "intent")),
            policy: RiskPolicySchema.parse(requiredRecord(args, "policy")),
            context: riskContextArg(args, "context")
          })
        );
      case "strategy_patch.capture":
        return completed(
          toolName,
          await gateway.captureStrategyPatchProposal({
            ...base,
            proposal: StrategyPatchProposalSchema.parse(
              requiredRecord(args, "proposal")
            )
          })
        );
      case "memory_proposal.capture":
        return completed(
          toolName,
          await gateway.captureMemoryProposal({
            ...base,
            proposal: MemoryProposalSchema.parse(requiredRecord(args, "proposal"))
          })
        );
      case "deployment_gate.inspect":
        return completed(
          toolName,
          await gateway.inspectDeploymentGate({
            ...base,
            gate: DeploymentGateSchema.parse(requiredRecord(args, "gate"))
          })
        );
    }
  } catch (error) {
    return {
      status: "failed",
      canonical_tool_name: toolName,
      error: error instanceof Error ? error.message : String(error)
    };
  } finally {
    events.close();
  }
}

function completed(
  toolName: AgentToolGatewayToolName,
  result: unknown
): OpenStratMcpToolOutput {
  return {
    status: "completed",
    canonical_tool_name: toolName,
    result
  };
}

function invocationBase(args: Record<string, unknown>): {
  call_id: string;
  session_id: string;
  turn_id: string;
} {
  return {
    call_id: optionalStringArg(args, "call_id") ?? `mcp_call_${Date.now()}`,
    session_id: optionalStringArg(args, "session_id") ?? "mcp_session",
    turn_id: optionalStringArg(args, "turn_id") ?? "mcp_turn"
  };
}

function stringArg(args: Record<string, unknown>, name: string): string {
  const value = optionalStringArg(args, name);
  if (!value) {
    throw new Error(`Missing string argument: ${name}`);
  }
  return value;
}

function optionalStringArg(
  args: Record<string, unknown>,
  name: string
): string | undefined {
  const value = args[name];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function requiredRecord(
  args: Record<string, unknown>,
  name: string
): Record<string, unknown> {
  const value = args[name];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Missing object argument: ${name}`);
  }
  return value as Record<string, unknown>;
}

function stringArrayArg(
  args: Record<string, unknown>,
  name: string
): string[] | undefined {
  const value = args[name];
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    return value.split(",").map((item) => item.trim());
  }
  return undefined;
}

function riskContextArg(args: Record<string, unknown>, name: string): RiskContext {
  const value = requiredRecord(args, name);
  if (
    !Array.isArray(value.market_refs) ||
    value.market_refs.some((ref) => typeof ref !== "string")
  ) {
    throw new Error(`Missing string array argument: ${name}.market_refs`);
  }
  return {
    market_refs: value.market_refs,
    ...(typeof value.portfolio_ref === "string"
      ? { portfolio_ref: value.portfolio_ref }
      : {}),
    ...(typeof value.decision_ref === "string"
      ? { decision_ref: value.decision_ref }
      : {})
  };
}

class ProjectMarketDataReader implements MarketDataReader {
  constructor(private readonly home: ReturnType<typeof resolveOpenStratCliHome>) {}

  async getMarket(canonicalSymbol: string): Promise<MarketRegistryEntry | undefined> {
    return listMarkets(this.home).find(
      (market) => market.canonical_symbol === canonicalSymbol
    );
  }

  async getLatestPrice(query: MarketDataQuery): Promise<MarketDatum> {
    const dataset = this.latestDataset(query.canonical_symbol);
    const candles = this.latestCandles(dataset.candle_refs);
    const candle = candles.at(-1);
    if (!candle) {
      throw new Error(`no candles available for ${query.canonical_symbol}`);
    }
    return MarketDatumSchema.parse({
      value: candle.close,
      source: dataset.source,
      venue: dataset.venue,
      symbol: dataset.symbol,
      canonical_symbol: dataset.canonical_symbol,
      method: "last_trade",
      timestamp: candle.close_time,
      received_at: new Date().toISOString(),
      stale_after_ms: 60_000,
      raw_ref: candle.raw_ref
    });
  }

  async getCandles(query: CandleQuery): Promise<Candle[]> {
    const dataset = this.latestDataset(query.canonical_symbol, query.interval);
    return this.latestCandles(dataset.candle_refs).filter(
      (candle) =>
        candle.open_time >= query.start_at && candle.close_time <= query.end_at
    );
  }

  async getOrderbookSnapshot(query: OrderbookQuery): Promise<OrderbookSnapshot> {
    const dataset = this.latestDataset(query.canonical_symbol);
    const ref = dataset.orderbook_refs.at(-1);
    if (!ref) {
      throw new Error(`no orderbook refs available for ${query.canonical_symbol}`);
    }
    return objectsForHome(this.home).getJson<OrderbookSnapshot>(ref);
  }

  private latestDataset(canonicalSymbol: string, interval?: string) {
    const dataset = listDatasets(this.home).find(
      (entry) =>
        entry.canonical_symbol === canonicalSymbol &&
        (interval === undefined || entry.interval === interval)
    );
    if (!dataset) {
      throw new Error(`dataset not found for ${canonicalSymbol}`);
    }
    return dataset;
  }

  private latestCandles(refs: string[]): Candle[] {
    return refs.flatMap((ref) => objectsForHome(this.home).getJson<Candle[]>(ref));
  }
}

function objectsForHome(
  home: ReturnType<typeof resolveOpenStratCliHome>
): FileObjectStore {
  return new FileObjectStore(home.objectsDir);
}

class UnavailableRiskEngine implements RiskPolicyEngine {
  async review(
    intent: TradeIntent,
    policy: RiskPolicy,
    _context: RiskContext
  ): Promise<RiskReview> {
    return RiskReviewSchema.parse({
      id: `${intent.id}:${policy.id}:unavailable`,
      intent_id: intent.id,
      policy_id: policy.id,
      created_at: new Date().toISOString(),
      status: "simulation_required",
      checks: [
        {
          name: "risk_engine_wiring",
          status: "fail",
          message:
            "Project risk engine dependencies are not wired to the MCP bridge yet."
        }
      ],
      required_approvals: ["risk"]
    });
  }
}
