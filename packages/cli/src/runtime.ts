import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  Codex,
  type CodexOptions,
  type ModelReasoningEffort,
  type ThreadEvent
} from "@openai/codex-sdk";
import type { OpenStratCliHome } from "./home.js";
import { listDatasets, planDatasetIngestion } from "./trading-workbench.js";

type CodexConfigObject = NonNullable<CodexOptions["config"]>;

export type OpenStratThinkingEffort = "auto" | ModelReasoningEffort;

export interface CodexTurnInput {
  prompt: string;
  cwd: string;
  env: Record<string, string | undefined>;
  codexThreadId?: string | undefined;
  home: OpenStratCliHome;
  cliEntrypoint?: string | undefined;
  model?: string | undefined;
  thinking?: OpenStratThinkingEffort | undefined;
  onEvent?: (event: ThreadEvent) => void;
}

export interface CodexTurnResult {
  codexThreadId?: string | undefined;
  finalResponse: string;
  events: ThreadEvent[];
}

export interface CodexWorkbenchRuntime {
  kind: "codex_sdk" | "fake_codex";
  displayModel?: string;
  availableModels?: readonly string[];
  thinking?: OpenStratThinkingEffort;
  contextWindow?: number;
  runTurn(input: CodexTurnInput): Promise<CodexTurnResult>;
}

export function createCodexWorkbenchRuntime(
  env: Record<string, string | undefined>
): CodexWorkbenchRuntime {
  if (env.OPENSTRAT_CODEX_RUNTIME === "fake") {
    return new FakeCodexWorkbenchRuntime();
  }
  return new SdkCodexWorkbenchRuntime(env);
}

class SdkCodexWorkbenchRuntime implements CodexWorkbenchRuntime {
  readonly kind = "codex_sdk" as const;
  readonly displayModel: string;
  readonly availableModels: readonly string[];
  readonly thinking: OpenStratThinkingEffort;
  readonly contextWindow?: number;

  constructor(env: Record<string, string | undefined>) {
    this.displayModel = stringEnv(env, "OPENSTRAT_CODEX_MODEL") ?? this.kind;
    this.availableModels = modelListEnv(env, this.displayModel);
    this.thinking = reasoningEffortEnv(env) ?? "auto";
    const contextWindow = numberEnv(env, "OPENSTRAT_CODEX_CONTEXT_WINDOW");
    if (contextWindow !== undefined) {
      this.contextWindow = contextWindow;
    }
  }

  async runTurn(input: CodexTurnInput): Promise<CodexTurnResult> {
    const codex = new Codex({
      env: codexEnvironment(input.env, input.home),
      config: {
        mcp_servers: openStratMcpConfig(input)
      }
    });
    const selectedModel = input.model ?? this.displayModel;
    const selectedThinking = input.thinking ?? this.thinking;
    const threadOptions = {
      workingDirectory: input.cwd,
      skipGitRepoCheck: true,
      sandboxMode: "workspace-write" as const,
      approvalPolicy: "on-request" as const,
      ...(selectedModel !== this.kind ? { model: selectedModel } : {}),
      ...(selectedThinking !== "auto" ? { modelReasoningEffort: selectedThinking } : {})
    };
    const thread = input.codexThreadId
      ? codex.resumeThread(input.codexThreadId, threadOptions)
      : codex.startThread(threadOptions);
    const { events } = await thread.runStreamed(openStratPrompt(input.prompt));
    const captured: ThreadEvent[] = [];
    let finalResponse = "";

    for await (const event of events) {
      captured.push(event);
      input.onEvent?.(event);
      if (event.type === "item.completed" && event.item.type === "agent_message") {
        finalResponse = event.item.text;
      }
    }

    return {
      codexThreadId: thread.id ?? input.codexThreadId,
      finalResponse,
      events: captured
    };
  }
}

class FakeCodexWorkbenchRuntime implements CodexWorkbenchRuntime {
  readonly kind = "fake_codex" as const;
  readonly displayModel = "fake_codex";
  readonly availableModels = ["fake_codex", "fake_codex-high"] as const;
  readonly thinking = "auto" as const;

  async runTurn(input: CodexTurnInput): Promise<CodexTurnResult> {
    const threadId = input.codexThreadId ?? `fake_thread_${Date.now()}`;
    const events: ThreadEvent[] = [
      { type: "thread.started", thread_id: threadId },
      { type: "turn.started" }
    ];
    let planningText = "";

    if (/\b(data|dataset|ingest|candles|scalp|scalping)\b/i.test(input.prompt)) {
      const plan = planDatasetIngestion({
        prompt: input.prompt,
        home: input.home,
        sessionId: "fake_codex"
      });
      planningText = `\n\nDataset plan: ${plan.symbol} ${plan.intervals.join("/")} ${plan.start_at} to ${plan.end_at}. Suggested command: ${plan.slash_commands[0]}`;
    }

    if (input.prompt.toLowerCase().includes("strategy")) {
      const strategyContext = fakeStrategyContext(input);
      const strategyPath = join(input.cwd, "src", "strategy.ts");
      mkdirSync(join(strategyPath, ".."), { recursive: true });
      writeFileSync(
        strategyPath,
        `import { defineStrategy } from "@openstrat/strategy-sdk";\n\nexport const strategy = defineStrategy({\n  strategy_id: "fake_codex_strategy",\n  strategy_version: "0.1.0",\n  name: "Fake Codex Strategy",\n  description: "Deterministic test strategy written by the fake Codex runtime.",\n  runtime: "typescript",\n  entrypoint: "src/strategy.ts",\n  autonomy_mode: "strategy_workbench",\n  allowed_symbols: ["${strategyContext.canonicalSymbol}"],\n  parameters: {},\n  required_data: [{ kind: "candles", canonical_symbol: "${strategyContext.canonicalSymbol}", interval: "${strategyContext.interval}" }],\n  output: "trade_intent",\n  created_at: "2026-06-22T00:00:00.000Z",\n  source_refs: []\n}, () => []);\n`,
        "utf8"
      );
      events.push({
        type: "item.completed",
        item: {
          id: "fake_file_change_001",
          type: "file_change",
          status: "completed",
          changes: [{ path: "src/strategy.ts", kind: "add" }]
        }
      });
    }

    const finalResponse = `Fake Codex completed the turn. In live mode, Codex SDK owns file/shell tools.${planningText}`;
    events.push({
      type: "item.completed",
      item: {
        id: "fake_agent_message_001",
        type: "agent_message",
        text: finalResponse
      }
    });
    events.push({
      type: "turn.completed",
      usage: {
        input_tokens: 1,
        cached_input_tokens: 0,
        output_tokens: 1,
        reasoning_output_tokens: 0
      }
    });

    for (const event of events) {
      input.onEvent?.(event);
    }

    return {
      codexThreadId: threadId,
      finalResponse,
      events
    };
  }
}

function fakeStrategyContext(input: CodexTurnInput): {
  canonicalSymbol: string;
  interval: string;
} {
  const dataset = listDatasets(input.home)[0];
  if (dataset) {
    return {
      canonicalSymbol: dataset.canonical_symbol,
      interval: dataset.interval
    };
  }
  const promptSymbol = /\b([A-Z0-9]{2,10})(?:-PERP)?\b/.exec(input.prompt)?.[1];
  return {
    canonicalSymbol: `${promptSymbol ?? "BTC"}-PERP`,
    interval: /\b5\s*m\b/i.test(input.prompt) ? "5m" : "15m"
  };
}

function codexEnvironment(
  env: Record<string, string | undefined>,
  home: OpenStratCliHome
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  result.CODEX_HOME = home.codexHome;
  result.OPENSTRAT_HOME = home.projectRoot;
  result.OPENSTRAT_USER_HOME = home.userRoot;
  return result;
}

function stringEnv(
  env: Record<string, string | undefined>,
  key: string
): string | undefined {
  const value = env[key]?.trim();
  return value ? value : undefined;
}

function modelListEnv(
  env: Record<string, string | undefined>,
  selectedModel: string
): readonly string[] {
  const configured = env.OPENSTRAT_CODEX_MODELS?.split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  const models = configured && configured.length > 0 ? configured : [selectedModel];
  return uniquePreservingOrder(
    models.includes(selectedModel) ? models : [selectedModel, ...models]
  );
}

function uniquePreservingOrder(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function numberEnv(
  env: Record<string, string | undefined>,
  key: string
): number | undefined {
  const value = Number(env[key]);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function reasoningEffortEnv(
  env: Record<string, string | undefined>
): ModelReasoningEffort | undefined {
  const value = stringEnv(env, "OPENSTRAT_CODEX_THINKING");
  return value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh"
    ? value
    : undefined;
}

function openStratMcpConfig(input: CodexTurnInput): CodexConfigObject {
  const entrypoint = input.cliEntrypoint;
  if (!entrypoint) {
    return {};
  }
  return {
    openstrat: {
      command: process.execPath,
      args: [entrypoint, "mcp"],
      env: {
        OPENSTRAT_HOME: input.home.projectRoot,
        OPENSTRAT_USER_HOME: input.home.userRoot,
        CODEX_HOME: input.home.codexHome
      },
      enabled: true,
      required: false,
      default_tools_approval_mode: "auto"
    }
  };
}

function openStratPrompt(prompt: string): string {
  return [
    "You are running inside OpenStrat, a trading strategy engineering workbench.",
    "Use Codex native file and shell tools for code inspection, edits, tests, and validation.",
    "Use OpenStrat MCP tools for trading-domain context when available.",
    "For market data requests, infer missing symbol, venue, interval, and date-range assumptions, then propose an OpenStrat ingest command before executing ingestion.",
    "For strategy work, connect dataset refs, strategy validation, local backtest evidence, and risk preflight artifacts instead of stopping at freeform code generation.",
    "Generated strategy code must stay exchange-agnostic and use OpenStrat strategy contracts.",
    "",
    prompt
  ].join("\n");
}
