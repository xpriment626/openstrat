import { createInterface } from "node:readline/promises";
import { stdout as processStdout } from "node:process";
import type { ThreadEvent } from "@openai/codex-sdk";
import type { Readable, Writable } from "node:stream";
import { parseCleanupScopes, runCleanupPlan } from "./cleanup.js";
import { runCodexLogin } from "./codex-cli.js";
import {
  codexAuthStatus,
  ensureOpenStratCliHome,
  resolveOpenStratCliHome
} from "./home.js";
import { runOpenStratMcpServer } from "./mcp.js";
import {
  createCodexWorkbenchRuntime,
  type CodexWorkbenchRuntime,
  type OpenStratThinkingEffort
} from "./runtime.js";
import {
  appendTranscript,
  createWorkbenchSession,
  listWorkbenchSessions,
  projectCodexEventsToArtifacts,
  saveWorkbenchSession
} from "./session-store.js";
import {
  handleSlashCommand,
  isSlashCommand,
  OPENSTRAT_SLASH_COMMANDS
} from "./slash-commands.js";
import {
  booleanArg,
  createStrategyAuthoringGuide,
  ingestDataset,
  inspectDataset,
  intervalArg,
  listBacktests,
  listDatasets,
  optionalNumberArg,
  parseWorkbenchArgs,
  planBacktest,
  planDatasetIngestion,
  runBacktest,
  runRiskPreflight,
  stringArg as workbenchStringArg,
  validateDataset,
  validateStrategyFile
} from "./trading-workbench.js";
import {
  buildInstallDiagnostics,
  buildWorkbenchSnapshot,
  formatArtifactLatest,
  formatHelp,
  formatInstallDiagnostics,
  formatReadiness,
  repairHintForError
} from "./workbench-summary.js";
import {
  createWorkbenchTuiState,
  recordSlashCommandView,
  recordTuiDiagnostic,
  recordTuiEntry,
  renderWorkbenchTuiAppend,
  renderWorkbenchTui,
  setTuiThinkingVisible,
  setTuiToolsExpanded,
  updateTuiFooter,
  type WorkbenchTuiFooterState,
  type WorkbenchTuiEntry,
  updateTuiSnapshot
} from "./workbench-tui.js";

export interface RunOpenStratCliOptions {
  argv: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  stdin?: Readable;
  output?: Writable;
  inputLines?: string[] | undefined;
  cliEntrypoint?: string | undefined;
  runtime?: CodexWorkbenchRuntime;
}

export interface CliResult {
  exitCode: number;
}

export async function runOpenStratCli(
  options: RunOpenStratCliOptions
): Promise<CliResult> {
  const stdout = options.stdout ?? ((line: string) => console.log(line));
  const stderr = options.stderr ?? ((line: string) => console.error(line));
  const home = resolveOpenStratCliHome({ cwd: options.cwd, env: options.env });
  const [command, ...rest] = options.argv;
  if (command !== "cleanup" && command !== "uninstall") {
    ensureOpenStratCliHome(home);
  }

  try {
    if (command === "cleanup") {
      return runCleanupCommand(rest, options.cwd, options.env, home, stdout);
    }
    if (command === "uninstall") {
      return runCleanupCommand(rest, options.cwd, options.env, home, stdout, true);
    }
    if (command === "mcp") {
      await runOpenStratMcpServer(options.env, options.cwd);
      return { exitCode: 0 };
    }
    if (command === "doctor") {
      emitDoctor(stdout, home, options.env, options.cliEntrypoint);
      return { exitCode: 0 };
    }
    if (command === "help" || command === "--help" || command === "-h") {
      emitBlock(
        stdout,
        formatHelp(buildWorkbenchSnapshot({ home, cwd: options.cwd, env: options.env }))
      );
      return { exitCode: 0 };
    }
    if (command === "auth" && rest[0] === "status") {
      emitAuthStatus(stdout, home, options.env);
      return { exitCode: 0 };
    }
    if (command === "auth" && (rest[0] === "codex" || rest[0] === "login")) {
      const exitCode = await runCodexLogin({
        home,
        env: options.env,
        argv: rest.slice(1)
      });
      return { exitCode };
    }
    if (command === "sessions") {
      emitSessions(stdout, home);
      return { exitCode: 0 };
    }
    if (command === "ready" || command === "readiness") {
      emitBlock(
        stdout,
        formatReadiness(
          buildWorkbenchSnapshot({ home, cwd: options.cwd, env: options.env })
        )
      );
      return { exitCode: 0 };
    }
    if (command === "artifacts") {
      return runArtifactsCommand(rest, options.cwd, home, options.env, stdout);
    }
    if (command === "datasets") {
      return await runDatasetsCommand(rest, options.cwd, home, stdout);
    }
    if (command === "strategy") {
      return await runStrategyCommand(rest, options.cwd, home, stdout);
    }
    if (command === "backtest") {
      return await runBacktestCommand(rest, options.cwd, home, stdout);
    }
    if (command === "risk") {
      return await runRiskCommand(rest, options.cwd, home, stdout);
    }
    if (command === "chat") {
      const prompt = stringFlag(rest, "--prompt");
      if (!prompt) {
        throw new Error("Usage: openstrat chat --prompt <prompt>");
      }
      return await runHeadlessTurn({
        ...options,
        prompt,
        stdout,
        stderr
      });
    }
    if (command === undefined) {
      return await runWorkbenchTui({
        ...options,
        stdout,
        stderr
      });
    }

    throw new Error(`Unknown command: ${command}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr(message);
    const hint = repairHintForError(message);
    if (hint) {
      stderr(`next: ${hint}`);
    }
    return { exitCode: 1 };
  }
}

function runCleanupCommand(
  rest: string[],
  cwd: string,
  env: Record<string, string | undefined>,
  home: ReturnType<typeof resolveOpenStratCliHome>,
  stdout: (line: string) => void,
  uninstallMode = false
): CliResult {
  const result = runCleanupPlan({
    cwd,
    env,
    home,
    scopes: parseCleanupScopes(rest),
    dryRun: rest.includes("--dry-run"),
    yes: rest.includes("--yes"),
    uninstallMode
  });
  for (const line of result.lines) {
    stdout(line);
  }
  return { exitCode: result.exitCode };
}

async function runHeadlessTurn(
  options: RunOpenStratCliOptions & {
    prompt: string;
    stdout: (line: string) => void;
    stderr: (line: string) => void;
  }
): Promise<CliResult> {
  const home = resolveOpenStratCliHome({ cwd: options.cwd, env: options.env });
  const runtime = options.runtime ?? createCodexWorkbenchRuntime(options.env);
  let session = createWorkbenchSession(home, options.cwd, "OpenStrat headless chat");
  appendTranscript(home, session, "user_message", { text: options.prompt });
  const result = await runtime.runTurn({
    prompt: options.prompt,
    cwd: options.cwd,
    env: options.env,
    home,
    cliEntrypoint: options.cliEntrypoint,
    onEvent: (event) => {
      appendTranscript(home, session, "codex_event", { event });
      projectCodexEventsToArtifacts(home, session, event);
    }
  });
  session = saveWorkbenchSession(home, {
    ...session,
    ...(result.codexThreadId ? { codex_thread_id: result.codexThreadId } : {})
  });
  appendTranscript(home, session, "codex_final_response", {
    text: result.finalResponse
  });
  options.stdout(`session: ${session.id}`);
  if (session.codex_thread_id) {
    options.stdout(`codex_thread: ${session.codex_thread_id}`);
  }
  options.stdout(result.finalResponse);
  return { exitCode: 0 };
}

async function runWorkbenchTui(
  options: RunOpenStratCliOptions & {
    stdout: (line: string) => void;
    stderr: (line: string) => void;
  }
): Promise<CliResult> {
  const home = resolveOpenStratCliHome({ cwd: options.cwd, env: options.env });
  const runtime = options.runtime ?? createCodexWorkbenchRuntime(options.env);
  let session = createWorkbenchSession(home, options.cwd);
  const nextSession = () => createWorkbenchSession(home, options.cwd);
  const lines = options.inputLines ?? [];
  const snapshot = () =>
    buildWorkbenchSnapshot({
      home,
      cwd: options.cwd,
      env: options.env,
      session
    });
  let tui = createWorkbenchTuiState({
    runtimeKind: runtime.kind,
    snapshot: snapshot(),
    commands: OPENSTRAT_SLASH_COMMANDS,
    footer: {
      model: runtime.displayModel ?? runtime.kind,
      thinking: runtime.thinking ?? "auto",
      autoCompact: true,
      ...(runtime.contextWindow ? { contextWindow: runtime.contextWindow } : {})
    }
  });
  const terminalOutput = isTerminalOutput(options.output) ? options.output : undefined;
  const interactiveOutput = lines.length === 0 ? terminalOutput : undefined;
  const useInteractiveScreen = interactiveOutput !== undefined;
  let interactiveInitialRendered = false;
  let interactiveRenderedEntryCount = tui.entries.length;
  let interactiveRenderedDiagnosticCount = tui.diagnostics.length;
  let interactiveLastRenderedFooter = JSON.stringify(tui.footer ?? {});
  let exitMessage: string | undefined;
  let selectedModel = runtime.displayModel ?? runtime.kind;
  let selectedThinking: OpenStratThinkingEffort = runtime.thinking ?? "auto";
  const modelCandidates = modelCycleCandidates(runtime, selectedModel);
  const render = (
    change: { appendedEntries?: number; updatedEntry?: WorkbenchTuiEntry } = {}
  ) => {
    tui = updateTuiSnapshot(tui, snapshot());
    const width = terminalWidth(options.env, options.output);
    if (interactiveOutput && interactiveInitialRendered) {
      const footerSignature = JSON.stringify(tui.footer ?? {});
      const fromEntry =
        change.appendedEntries && change.appendedEntries > 0
          ? Math.max(0, tui.entries.length - change.appendedEntries)
          : interactiveRenderedEntryCount;
      const update = renderWorkbenchTuiAppend(tui, {
        ...(width === undefined ? {} : { width }),
        fromEntry,
        fromDiagnostic: interactiveRenderedDiagnosticCount,
        includeFooter: footerSignature !== interactiveLastRenderedFooter,
        color: true,
        ...(change.updatedEntry ? { updatedEntry: change.updatedEntry } : {})
      });
      interactiveRenderedEntryCount = tui.entries.length;
      interactiveRenderedDiagnosticCount = tui.diagnostics.length;
      interactiveLastRenderedFooter = footerSignature;
      if (update.length > 0) {
        interactiveOutput.write(`${update}\n`);
      }
      return;
    }
    const screen = renderWorkbenchTui(tui, {
      composerPrompt: "openstrat> ",
      showComposer: !useInteractiveScreen,
      color: interactiveOutput !== undefined,
      ...(width === undefined ? {} : { width })
    });
    if (interactiveOutput) {
      interactiveOutput.write(`${screen}\n`);
      interactiveInitialRendered = true;
      interactiveRenderedEntryCount = tui.entries.length;
      interactiveRenderedDiagnosticCount = tui.diagnostics.length;
      interactiveLastRenderedFooter = JSON.stringify(tui.footer ?? {});
      return;
    }
    emitBlock(options.stdout, screen);
  };
  const toggleToolExpansion = () => {
    const latestToolEntry = latestExpandableToolEntry(tui.entries);
    if (!latestToolEntry) {
      return;
    }
    tui = setTuiToolsExpanded(tui, !tui.toolsExpanded);
    render({ updatedEntry: latestToolEntry });
  };
  const toggleThinkingVisibility = () => {
    const latestThinkingEntry = latestThinkingTuiEntry(tui.entries);
    if (!latestThinkingEntry) {
      return;
    }
    tui = setTuiThinkingVisible(tui, !tui.thinkingVisible);
    render({ updatedEntry: latestThinkingEntry });
  };
  const cycleThinkingEffort = () => {
    selectedThinking = nextThinkingEffort(selectedThinking);
    tui = updateTuiFooter(tui, { thinking: selectedThinking });
    render();
  };
  const cycleModel = (direction: -1 | 1) => {
    const nextModel = modelCandidateAtOffset(modelCandidates, selectedModel, direction);
    if (nextModel === selectedModel) {
      return;
    }
    selectedModel = nextModel;
    tui = updateTuiFooter(tui, { model: selectedModel });
    render();
  };
  const interactiveReader =
    interactiveOutput && options.stdin
      ? new InteractiveLineReader(options.stdin, interactiveOutput, {
          onToggleToolOutput: toggleToolExpansion,
          onToggleThinkingVisibility: toggleThinkingVisibility,
          onCycleThinkingEffort: cycleThinkingEffort,
          onCycleModel: () => cycleModel(1),
          onCycleModelBackward: () => cycleModel(-1),
          getModelSelector: () => ({
            models: modelCandidates,
            selectedModel
          }),
          onSelectModel: (model) => {
            selectedModel = model;
            tui = updateTuiFooter(tui, { model: selectedModel });
            render();
          },
          getEffortSelector: () => ({
            efforts: THINKING_EFFORT_SEQUENCE,
            selectedEffort: selectedThinking
          }),
          onSelectEffort: (effort) => {
            selectedThinking = effort;
            tui = updateTuiFooter(tui, { thinking: selectedThinking });
            render();
          },
          slashCommands: OPENSTRAT_SLASH_COMMANDS
        })
      : undefined;
  const reader =
    lines.length === 0 && options.stdin && !interactiveReader
      ? createInterface({
          input: options.stdin,
          output: options.output ?? processStdout,
          terminal: false
        })
      : undefined;

  render();

  try {
    let index = 0;
    while (true) {
      const line =
        index < lines.length
          ? lines[index++]
          : interactiveReader
            ? await interactiveReader.readLine(
                terminalWidth(options.env, options.output)
              )
            : reader
              ? await reader.question("openstrat> ")
              : undefined;
      if (line === undefined) {
        break;
      }
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        continue;
      }
      if (trimmed === "/exit" || trimmed === "/quit") {
        exitMessage = "bye";
        break;
      }
      if (isSlashCommand(trimmed)) {
        const result = await handleSlashCommand(
          trimmed,
          {
            cwd: options.cwd,
            env: options.env,
            home,
            session
          },
          nextSession
        );
        appendTranscript(home, session, "slash_command", {
          command: result.command,
          status: result.status,
          data: result.data
        });
        if (result.session) {
          session = result.session;
        }
        tui = recordSlashCommandView(tui, result);
        if (result.status === "error") {
          tui = recordTuiDiagnostic(tui, {
            severity: "error",
            message: result.summary
          });
        }
        render({ appendedEntries: 1 });
        continue;
      }

      appendTranscript(home, session, "user_message", { text: trimmed });
      tui = recordTuiEntry(tui, {
        kind: "user",
        title: "You",
        body: trimmed
      });
      tui = recordTuiEntry(tui, {
        kind: "working",
        title: "Working",
        body: "running Codex turn"
      });
      render({ appendedEntries: 2 });
      try {
        const result = await runtime.runTurn({
          prompt: trimmed,
          cwd: options.cwd,
          env: options.env,
          codexThreadId: session.codex_thread_id,
          home,
          cliEntrypoint: options.cliEntrypoint,
          model: selectedModel,
          thinking: selectedThinking,
          onEvent: (event) => {
            appendTranscript(home, session, "codex_event", { event });
            projectCodexEventsToArtifacts(home, session, event);
            const footer = projectCodexFooterEvent(
              event,
              runtime,
              selectedModel,
              selectedThinking
            );
            if (footer) {
              tui = updateTuiFooter(tui, footer);
            }
            const progress = projectCodexProgressEvent(event);
            if (progress) {
              const replacesEntry =
                progress.id !== undefined &&
                tui.entries.some((entry) => entry.id === progress.id);
              tui = recordTuiEntry(tui, progress);
              render(
                replacesEntry ? { updatedEntry: progress } : { appendedEntries: 1 }
              );
            } else if (footer) {
              render();
            }
          }
        });
        session = saveWorkbenchSession(home, {
          ...session,
          ...(result.codexThreadId ? { codex_thread_id: result.codexThreadId } : {})
        });
        appendTranscript(home, session, "codex_final_response", {
          text: result.finalResponse
        });
        tui = recordTuiEntry(tui, {
          kind: "assistant",
          title: "Codex",
          body: result.finalResponse
        });
        render({ appendedEntries: 1 });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        appendTranscript(home, session, "error", { message });
        tui = recordTuiDiagnostic(tui, {
          severity: "error",
          message
        });
        render();
      }
    }
  } finally {
    reader?.close();
    interactiveReader?.close();
  }

  if (exitMessage) {
    options.stdout(exitMessage);
  }
  return { exitCode: 0 };
}

function runArtifactsCommand(
  argv: string[],
  cwd: string,
  home: ReturnType<typeof resolveOpenStratCliHome>,
  env: Record<string, string | undefined>,
  stdout: (line: string) => void
): CliResult {
  const [subcommand] = argv;
  if (subcommand === "latest") {
    emitBlock(stdout, formatArtifactLatest(buildWorkbenchSnapshot({ home, cwd, env })));
    return { exitCode: 0 };
  }
  throw new Error("Usage: openstrat artifacts latest");
}

async function runDatasetsCommand(
  argv: string[],
  _cwd: string,
  home: ReturnType<typeof resolveOpenStratCliHome>,
  stdout: (line: string) => void
): Promise<CliResult> {
  const [subcommand, ...rest] = argv;
  const parsed = parseWorkbenchArgs(rest);
  if (subcommand === "plan") {
    const plan = planDatasetIngestion({
      prompt: workbenchStringArg(parsed, "prompt", rest.join(" ")),
      symbol: typeof parsed.symbol === "string" ? parsed.symbol : undefined,
      intervals:
        typeof parsed.interval === "string"
          ? [parsed.interval]
          : typeof parsed.intervals === "string"
            ? parsed.intervals.split(",")
            : undefined,
      start: typeof parsed.start === "string" ? parsed.start : undefined,
      end: typeof parsed.end === "string" ? parsed.end : undefined,
      home,
      sessionId: "cli"
    });
    emitJson(stdout, plan);
    return { exitCode: 0 };
  }
  if (subcommand === "ingest") {
    const dataset = await ingestDataset(home, {
      symbol: workbenchStringArg(parsed, "symbol"),
      interval: intervalArg(parsed.interval),
      start: workbenchStringArg(parsed, "start"),
      end: workbenchStringArg(parsed, "end"),
      fixture: booleanArg(parsed, "fixture"),
      live: booleanArg(parsed, "live"),
      endpoint: typeof parsed.endpoint === "string" ? parsed.endpoint : undefined,
      sessionId: "cli"
    });
    emitJson(stdout, dataset);
    return { exitCode: 0 };
  }
  if (subcommand === "validate") {
    const validation = validateDataset(
      home,
      typeof parsed.dataset === "string" ? parsed.dataset : argv[1],
      "cli"
    );
    emitJson(stdout, validation);
    return { exitCode: validation.status === "ok" ? 0 : 1 };
  }
  if (subcommand === "inspect") {
    const inspection = inspectDataset(
      home,
      typeof parsed.dataset === "string" ? parsed.dataset : argv[1],
      "cli"
    );
    emitJson(stdout, inspection);
    return { exitCode: inspection.status === "ok" ? 0 : 1 };
  }
  emitJson(stdout, { datasets: listDatasets(home) });
  return { exitCode: 0 };
}

async function runStrategyCommand(
  argv: string[],
  cwd: string,
  home: ReturnType<typeof resolveOpenStratCliHome>,
  stdout: (line: string) => void
): Promise<CliResult> {
  const [subcommand, ...rest] = argv;
  const parsed = parseWorkbenchArgs(rest);
  if (subcommand === "guide") {
    const guide = createStrategyAuthoringGuide(home, cwd, {
      strategyFile: typeof parsed.strategy === "string" ? parsed.strategy : undefined,
      datasetId: typeof parsed.dataset === "string" ? parsed.dataset : undefined,
      sessionId: "cli"
    });
    emitJson(stdout, guide);
    return { exitCode: 0 };
  }
  if (subcommand !== "validate") {
    throw new Error("Usage: openstrat strategy guide|validate [--strategy <file>]");
  }
  const validation = await validateStrategyFile(
    home,
    cwd,
    typeof parsed.strategy === "string" ? parsed.strategy : undefined,
    typeof parsed.dataset === "string" ? parsed.dataset : undefined,
    "cli"
  );
  emitJson(stdout, validation);
  return { exitCode: validation.status === "ok" ? 0 : 1 };
}

async function runBacktestCommand(
  argv: string[],
  cwd: string,
  home: ReturnType<typeof resolveOpenStratCliHome>,
  stdout: (line: string) => void
): Promise<CliResult> {
  const [subcommand, ...rest] = argv;
  const parsed = parseWorkbenchArgs(rest);
  if (subcommand === "plan") {
    const plan = await planBacktest(home, cwd, {
      strategyFile: typeof parsed.strategy === "string" ? parsed.strategy : undefined,
      datasetId: typeof parsed.dataset === "string" ? parsed.dataset : undefined,
      initialEquityUsd: optionalNumberArg(parsed, "initial_equity"),
      feeBps: optionalNumberArg(parsed, "fee_bps"),
      slippageBps: optionalNumberArg(parsed, "slippage_bps"),
      runId: typeof parsed.run_id === "string" ? parsed.run_id : undefined,
      sessionId: "cli"
    });
    emitJson(stdout, plan);
    return { exitCode: 0 };
  }
  if (subcommand === "run") {
    const backtest = await runBacktest(home, cwd, {
      strategyFile: typeof parsed.strategy === "string" ? parsed.strategy : undefined,
      datasetId: typeof parsed.dataset === "string" ? parsed.dataset : undefined,
      initialEquityUsd: optionalNumberArg(parsed, "initial_equity"),
      feeBps: optionalNumberArg(parsed, "fee_bps"),
      slippageBps: optionalNumberArg(parsed, "slippage_bps"),
      runId: typeof parsed.run_id === "string" ? parsed.run_id : undefined,
      sessionId: "cli"
    });
    emitJson(stdout, backtest);
    return { exitCode: 0 };
  }
  emitJson(stdout, { backtests: listBacktests(home) });
  return { exitCode: 0 };
}

async function runRiskCommand(
  argv: string[],
  cwd: string,
  home: ReturnType<typeof resolveOpenStratCliHome>,
  stdout: (line: string) => void
): Promise<CliResult> {
  const [subcommand, ...rest] = argv;
  if (subcommand !== "preflight") {
    throw new Error("Usage: openstrat risk preflight");
  }
  const parsed = parseWorkbenchArgs(rest);
  const preflight = await runRiskPreflight(home, cwd, {
    strategyFile: typeof parsed.strategy === "string" ? parsed.strategy : undefined,
    datasetId: typeof parsed.dataset === "string" ? parsed.dataset : undefined,
    backtestRunId: typeof parsed.backtest === "string" ? parsed.backtest : undefined,
    maxNotionalUsd: optionalNumberArg(parsed, "max_notional"),
    maxDrawdownPct: optionalNumberArg(parsed, "max_drawdown_pct"),
    minTrades: optionalNumberArg(parsed, "min_trades"),
    minWinRate: optionalNumberArg(parsed, "min_win_rate"),
    policyRef: typeof parsed.policy_ref === "string" ? parsed.policy_ref : undefined,
    sessionId: "cli"
  });
  emitJson(stdout, preflight);
  return { exitCode: preflight.review.status === "approved" ? 0 : 1 };
}

function emitDoctor(
  stdout: (line: string) => void,
  home: ReturnType<typeof resolveOpenStratCliHome>,
  env: Record<string, string | undefined>,
  cliEntrypoint?: string | undefined
): void {
  const auth = codexAuthStatus(home, env);
  stdout("openstrat: ok");
  stdout("runtime: codex_sdk");
  stdout(`codex auth: ${auth.configured ? auth.method : "missing"}`);
  stdout(`project home: ${home.projectRoot}`);
  stdout(`user home: ${home.userRoot}`);
  emitBlock(stdout, formatInstallDiagnostics(buildInstallDiagnostics(cliEntrypoint)));
}

function emitAuthStatus(
  stdout: (line: string) => void,
  home: ReturnType<typeof resolveOpenStratCliHome>,
  env: Record<string, string | undefined>
): void {
  const auth = codexAuthStatus(home, env);
  stdout(`codex auth: ${auth.configured ? auth.method : "missing"}`);
}

function emitSessions(
  stdout: (line: string) => void,
  home: ReturnType<typeof resolveOpenStratCliHome>
): void {
  for (const session of listWorkbenchSessions(home)) {
    stdout(
      `${session.id}\t${session.updated_at}\t${session.codex_thread_id ?? "no-codex-thread"}`
    );
  }
}

function emitJson(stdout: (line: string) => void, value: unknown): void {
  stdout(JSON.stringify(value, null, 2));
}

function emitBlock(stdout: (line: string) => void, block: string): void {
  for (const line of block.split("\n")) {
    stdout(line);
  }
}

function isTerminalOutput(
  output: Writable | undefined
): output is Writable & { isTTY: true; columns?: number; rows?: number } {
  return output !== undefined && (output as { isTTY?: boolean }).isTTY === true;
}

function terminalWidth(
  env: Record<string, string | undefined>,
  output: Writable | undefined
): number | undefined {
  const columns = Number(env.COLUMNS);
  if (Number.isFinite(columns) && columns >= 48) {
    return columns;
  }
  const outputColumns = (output as { columns?: unknown } | undefined)?.columns;
  return typeof outputColumns === "number" && Number.isFinite(outputColumns)
    ? outputColumns
    : undefined;
}

function latestExpandableToolEntry(
  entries: readonly WorkbenchTuiEntry[]
): WorkbenchTuiEntry | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (
      entry &&
      (entry.kind === "tool_call" ||
        entry.kind === "tool_result" ||
        entry.kind === "tool_error")
    ) {
      return entry;
    }
  }
  return undefined;
}

function latestThinkingTuiEntry(
  entries: readonly WorkbenchTuiEntry[]
): WorkbenchTuiEntry | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.kind === "thinking") {
      return entry;
    }
  }
  return undefined;
}

const THINKING_EFFORT_SEQUENCE = [
  "auto",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh"
] as const satisfies readonly OpenStratThinkingEffort[];

function nextThinkingEffort(current: OpenStratThinkingEffort): OpenStratThinkingEffort {
  const index = THINKING_EFFORT_SEQUENCE.indexOf(current);
  const nextIndex = (index < 0 ? 0 : index + 1) % THINKING_EFFORT_SEQUENCE.length;
  return THINKING_EFFORT_SEQUENCE[nextIndex] ?? "auto";
}

function modelCycleCandidates(
  runtime: CodexWorkbenchRuntime,
  selectedModel: string
): readonly string[] {
  const candidates = runtime.availableModels ?? [selectedModel];
  return [
    ...new Set(
      candidates.includes(selectedModel) ? candidates : [selectedModel, ...candidates]
    )
  ];
}

function modelCandidateAtOffset(
  candidates: readonly string[],
  selectedModel: string,
  offset: -1 | 1
): string {
  if (candidates.length <= 1) {
    return selectedModel;
  }
  const index = candidates.indexOf(selectedModel);
  const currentIndex = index < 0 ? 0 : index;
  const nextIndex = (currentIndex + offset + candidates.length) % candidates.length;
  return candidates[nextIndex] ?? selectedModel;
}

interface SlashCompletionState {
  tokenStart: number;
  matches: readonly string[];
  selected: number;
}

interface ModelSelectorState {
  models: readonly string[];
  selectedModel: string;
  selected: number;
  query: string;
}

interface EffortSelectorState {
  efforts: readonly OpenStratThinkingEffort[];
  selectedEffort: OpenStratThinkingEffort;
  selected: number;
}

class InteractiveLineReader {
  private pending:
    | {
        line: string[];
        cursor: number;
        resolve: (line: string | undefined) => void;
        rawWasEnabled?: boolean;
        width?: number;
        cursorRow: number;
        cursorCol: number;
        endRow: number;
        endCol: number;
        completionHint?: string | undefined;
        completion?: SlashCompletionState | undefined;
        modelSelector?: ModelSelectorState | undefined;
        effortSelector?: EffortSelectorState | undefined;
      }
    | undefined;
  private readonly queuedChars: string[] = [];
  private readonly history: string[] = [];
  private historyIndex: number | undefined;
  private escapeSequence: string | undefined;
  private ended = false;

  constructor(
    private readonly input: Readable,
    private readonly output: Writable,
    private readonly actions: {
      onToggleToolOutput?: () => void;
      onToggleThinkingVisibility?: () => void;
      onCycleThinkingEffort?: () => void;
      onCycleModel?: () => void;
      onCycleModelBackward?: () => void;
      getModelSelector?: () => {
        models: readonly string[];
        selectedModel: string;
      };
      onSelectModel?: (model: string) => void;
      getEffortSelector?: () => {
        efforts: readonly OpenStratThinkingEffort[];
        selectedEffort: OpenStratThinkingEffort;
      };
      onSelectEffort?: (effort: OpenStratThinkingEffort) => void;
      slashCommands?: readonly string[];
    } = {}
  ) {
    this.input.on("data", this.handleData);
    this.input.once("end", this.handleEnd);
  }

  readLine(width: number | undefined): Promise<string | undefined> {
    if (this.ended) {
      return Promise.resolve(undefined);
    }
    return new Promise((resolve) => {
      const rawWasEnabled = this.enableRawMode();
      this.pending = {
        line: [],
        cursor: 0,
        resolve,
        cursorRow: 1,
        cursorCol: interactivePromptPrefixWidth(),
        endRow: 1,
        endCol: interactivePromptPrefixWidth(),
        ...(rawWasEnabled !== undefined ? { rawWasEnabled } : {}),
        ...(width !== undefined ? { width } : {})
      };
      this.writePromptBlock();
      this.input.resume();
      this.flushQueuedChars();
    });
  }

  close(): void {
    const rawWasEnabled = this.pending?.rawWasEnabled;
    this.pending = undefined;
    this.restoreRawMode(rawWasEnabled);
    this.input.pause();
    this.input.off("data", this.handleData);
    this.input.off("end", this.handleEnd);
  }

  private readonly handleData = (chunk: Buffer | string): void => {
    for (const char of chunk.toString()) {
      this.queuedChars.push(char);
    }
    this.flushQueuedChars();
  };

  private readonly handleEnd = (): void => {
    this.ended = true;
    if (this.pending) {
      const line = this.pending.line.join("");
      this.resolvePending(line.length > 0 ? line : undefined);
    }
  };

  private flushQueuedChars(): void {
    while (this.pending && this.queuedChars.length > 0) {
      const char = this.queuedChars.shift();
      if (char !== undefined) {
        this.handleChar(char);
      }
    }
  }

  private handleChar(char: string): void {
    if (!this.pending) {
      this.queuedChars.unshift(char);
      return;
    }
    if (this.escapeSequence !== undefined) {
      this.escapeSequence += char;
      if (isCompleteInteractiveEscapeSequence(this.escapeSequence)) {
        this.handleEscapeSequence(this.escapeSequence);
        this.escapeSequence = undefined;
      } else if (this.escapeSequence.length >= 16) {
        this.escapeSequence = undefined;
      }
      return;
    }
    if (char === "\x1b") {
      this.escapeSequence = char;
      return;
    }
    if (char === "\r" || char === "\n") {
      if (this.pending.modelSelector) {
        this.acceptModelSelector();
        return;
      }
      if (this.pending.effortSelector) {
        this.acceptEffortSelector();
        return;
      }
      if (this.openSelectorCommand()) {
        return;
      }
      if (
        this.pending.cursor > 0 &&
        this.pending.line[this.pending.cursor - 1] === "\\"
      ) {
        this.pending.line.splice(this.pending.cursor - 1, 1, "\n");
        this.pending.completionHint = undefined;
        this.pending.completion = undefined;
        this.historyIndex = undefined;
        this.redrawPromptBlock();
        return;
      }
      this.pending.completionHint = undefined;
      this.pending.completion = undefined;
      this.pending.cursor = this.pending.line.length;
      this.redrawPromptBlock();
      this.movePromptCursorToEnd();
      this.output.write("\n");
      this.resolvePending(this.pending.line.join(""));
      return;
    }
    if (char === "\x04" && this.pending.line.length === 0) {
      this.movePromptCursorToEnd();
      this.output.write("\n");
      this.resolvePending("/exit");
      return;
    }
    if (char === "\x03") {
      if (this.pending.modelSelector || this.pending.effortSelector) {
        this.cancelSelector();
        return;
      }
      this.movePromptCursorToEnd();
      this.output.write("^C\n");
      this.resolvePending("/exit");
      return;
    }
    if (char === "\x0f") {
      if (this.actions.onToggleToolOutput) {
        this.runActionWithPromptRefresh(this.actions.onToggleToolOutput);
      }
      return;
    }
    if (char === "\x14") {
      if (this.actions.onToggleThinkingVisibility) {
        this.runActionWithPromptRefresh(this.actions.onToggleThinkingVisibility);
      }
      return;
    }
    if (char === "\x10") {
      if (this.actions.onCycleModel) {
        this.runActionWithPromptRefresh(this.actions.onCycleModel);
      }
      return;
    }
    if (char === "\x0c") {
      this.openModelSelector();
      return;
    }
    if (char === "\t") {
      if (!this.acceptSlashCommandCompletion()) {
        this.completeSlashCommandPrefix();
      }
      return;
    }
    if (char === "\x7f" || char === "\b") {
      if (this.deleteModelSelectorSearchChar()) {
        return;
      }
      if (this.pending.effortSelector) {
        return;
      }
      if (this.pending.cursor > 0) {
        this.pending.line.splice(this.pending.cursor - 1, 1);
        this.pending.cursor -= 1;
        this.pending.completionHint = undefined;
        this.pending.completion = undefined;
        this.redrawPromptBlock();
      }
      return;
    }
    if (char >= " ") {
      if (this.insertModelSelectorSearchChar(char)) {
        return;
      }
      if (this.pending.effortSelector) {
        return;
      }
      this.pending.line.splice(this.pending.cursor, 0, char);
      this.pending.cursor += 1;
      this.pending.completionHint = undefined;
      this.pending.completion = undefined;
      this.historyIndex = undefined;
      this.redrawPromptBlock();
    }
  }

  private handleEscapeSequence(sequence: string): void {
    if (!this.pending) {
      return;
    }
    if (sequence === "\x1b[D") {
      this.pending.cursor = Math.max(0, this.pending.cursor - 1);
      this.pending.completionHint = undefined;
      this.pending.completion = undefined;
      this.redrawPromptBlock();
      return;
    }
    if (sequence === "\x1b[C") {
      this.pending.cursor = Math.min(this.pending.line.length, this.pending.cursor + 1);
      this.pending.completionHint = undefined;
      this.pending.completion = undefined;
      this.redrawPromptBlock();
      return;
    }
    if (sequence === "\x1b[A") {
      if (this.cycleSelector(-1)) {
        return;
      }
      if (this.cycleSlashCommandCompletion(-1)) {
        return;
      }
      this.recallPreviousHistory();
      return;
    }
    if (sequence === "\x1b[B") {
      if (this.cycleSelector(1)) {
        return;
      }
      if (this.cycleSlashCommandCompletion(1)) {
        return;
      }
      this.recallNextHistory();
      return;
    }
    if (sequence === "\x1b[Z") {
      if (this.actions.onCycleThinkingEffort) {
        this.runActionWithPromptRefresh(this.actions.onCycleThinkingEffort);
      }
      return;
    }
    if (isShiftCtrlPSequence(sequence)) {
      if (this.actions.onCycleModelBackward) {
        this.runActionWithPromptRefresh(this.actions.onCycleModelBackward);
      }
      return;
    }
    if (sequence === "\x1b[27;1u") {
      if (this.cancelSelector()) {
        return;
      }
    }
    if (sequence === "\x1b\r" || sequence === "\x1b[13;2~") {
      this.insertNewlineAtCursor();
    }
  }

  private completeSlashCommandPrefix(): void {
    const pending = this.pending;
    const slashCommands = this.actions.slashCommands ?? [];
    if (!pending || slashCommands.length === 0) {
      return;
    }
    pending.modelSelector = undefined;
    pending.effortSelector = undefined;
    const lineStart = lastIndexBefore(pending.line, "\n", pending.cursor - 1) + 1;
    const lineEnd = indexAtOrAfter(pending.line, "\n", pending.cursor);
    const token = pending.line.slice(lineStart, pending.cursor).join("");
    if (!token.startsWith("/") || /\s/.test(token)) {
      return;
    }
    const matches = slashCommands.filter((command) => command.startsWith(token));
    if (matches.length > 1) {
      pending.completionHint = `matches: ${matches.join(" ")}`;
      pending.completion = {
        tokenStart: lineStart,
        matches,
        selected: 0
      };
      this.redrawPromptBlock();
      return;
    }
    if (matches.length !== 1) {
      pending.completionHint = undefined;
      pending.completion = undefined;
      return;
    }
    const [command] = matches;
    if (!command) {
      return;
    }
    const nextChar = pending.line[pending.cursor];
    const replacement = `${command}${nextChar === " " ? "" : " "}`;
    pending.line.splice(lineStart, pending.cursor - lineStart, ...replacement);
    pending.cursor = lineStart + replacement.length;
    if (lineEnd >= 0 && pending.cursor > lineEnd) {
      pending.cursor = Math.min(pending.cursor, pending.line.length);
    }
    pending.completionHint = undefined;
    pending.completion = undefined;
    pending.modelSelector = undefined;
    pending.effortSelector = undefined;
    this.historyIndex = undefined;
    this.redrawPromptBlock();
  }

  private acceptSlashCommandCompletion(): boolean {
    const pending = this.pending;
    const completion = pending?.completion;
    if (!pending || !completion) {
      return false;
    }
    const command = completion.matches[completion.selected];
    if (!command) {
      pending.completionHint = undefined;
      pending.completion = undefined;
      this.redrawPromptBlock();
      return true;
    }
    const nextChar = pending.line[pending.cursor];
    const replacement = `${command}${nextChar === " " ? "" : " "}`;
    pending.line.splice(
      completion.tokenStart,
      pending.cursor - completion.tokenStart,
      ...replacement
    );
    pending.cursor = completion.tokenStart + replacement.length;
    pending.completionHint = undefined;
    pending.completion = undefined;
    pending.modelSelector = undefined;
    pending.effortSelector = undefined;
    this.historyIndex = undefined;
    this.redrawPromptBlock();
    return true;
  }

  private cycleSlashCommandCompletion(delta: -1 | 1): boolean {
    const pending = this.pending;
    const completion = pending?.completion;
    if (!pending || !completion || completion.matches.length === 0) {
      return false;
    }
    completion.selected =
      (completion.selected + delta + completion.matches.length) %
      completion.matches.length;
    pending.completionHint = `matches: ${completion.matches.join(" ")}`;
    this.redrawPromptBlock();
    return true;
  }

  private openSelectorCommand(): boolean {
    const pending = this.pending;
    if (!pending) {
      return false;
    }
    const command = pending.line.join("").trim();
    if (command !== "/model" && command !== "/effort") {
      return false;
    }
    pending.line = [];
    pending.cursor = 0;
    pending.completionHint = undefined;
    pending.completion = undefined;
    this.historyIndex = undefined;
    if (command === "/model") {
      this.openModelSelector();
      return true;
    }
    this.openEffortSelector();
    return true;
  }

  private openModelSelector(): void {
    const pending = this.pending;
    const selector = this.actions.getModelSelector?.();
    if (!pending || !selector || selector.models.length === 0) {
      return;
    }
    const selected = Math.max(0, selector.models.indexOf(selector.selectedModel));
    pending.modelSelector = {
      models: selector.models,
      selectedModel: selector.selectedModel,
      selected,
      query: ""
    };
    pending.effortSelector = undefined;
    pending.completionHint = undefined;
    pending.completion = undefined;
    this.historyIndex = undefined;
    this.redrawPromptBlock();
  }

  private openEffortSelector(): void {
    const pending = this.pending;
    const selector = this.actions.getEffortSelector?.();
    if (!pending || !selector || selector.efforts.length === 0) {
      return;
    }
    const selected = Math.max(0, selector.efforts.indexOf(selector.selectedEffort));
    pending.effortSelector = {
      efforts: selector.efforts,
      selectedEffort: selector.selectedEffort,
      selected
    };
    pending.modelSelector = undefined;
    pending.completionHint = undefined;
    pending.completion = undefined;
    this.historyIndex = undefined;
    this.redrawPromptBlock();
  }

  private cycleSelector(delta: -1 | 1): boolean {
    if (this.cycleModelSelector(delta)) {
      return true;
    }
    return this.cycleEffortSelector(delta);
  }

  private cycleModelSelector(delta: -1 | 1): boolean {
    const selector = this.pending?.modelSelector;
    const models = selector ? filteredModelSelectorModels(selector) : [];
    if (!selector || models.length === 0) {
      return false;
    }
    selector.selected = (selector.selected + delta + models.length) % models.length;
    this.redrawPromptBlock();
    return true;
  }

  private cycleEffortSelector(delta: -1 | 1): boolean {
    const selector = this.pending?.effortSelector;
    const efforts = selector?.efforts ?? [];
    if (!selector || efforts.length === 0) {
      return false;
    }
    selector.selected = (selector.selected + delta + efforts.length) % efforts.length;
    this.redrawPromptBlock();
    return true;
  }

  private insertModelSelectorSearchChar(char: string): boolean {
    const selector = this.pending?.modelSelector;
    if (!selector) {
      return false;
    }
    selector.query += char;
    selector.selected = 0;
    this.redrawPromptBlock();
    return true;
  }

  private deleteModelSelectorSearchChar(): boolean {
    const selector = this.pending?.modelSelector;
    if (!selector) {
      return false;
    }
    if (selector.query.length > 0) {
      selector.query = selector.query.slice(0, -1);
      selector.selected = 0;
    }
    this.redrawPromptBlock();
    return true;
  }

  private acceptModelSelector(): boolean {
    const pending = this.pending;
    const selector = pending?.modelSelector;
    if (!pending || !selector) {
      return false;
    }
    const model = filteredModelSelectorModels(selector)[selector.selected];
    pending.modelSelector = undefined;
    pending.completionHint = undefined;
    pending.completion = undefined;
    if (!model) {
      this.redrawPromptBlock();
      return true;
    }
    this.runActionWithPromptRefresh(() => {
      this.actions.onSelectModel?.(model);
    });
    return true;
  }

  private acceptEffortSelector(): boolean {
    const pending = this.pending;
    const selector = pending?.effortSelector;
    if (!pending || !selector) {
      return false;
    }
    const effort = selector.efforts[selector.selected];
    pending.effortSelector = undefined;
    pending.completionHint = undefined;
    pending.completion = undefined;
    if (!effort) {
      this.redrawPromptBlock();
      return true;
    }
    this.runActionWithPromptRefresh(() => {
      this.actions.onSelectEffort?.(effort);
    });
    return true;
  }

  private cancelSelector(): boolean {
    const pending = this.pending;
    if (!pending?.modelSelector && !pending?.effortSelector) {
      return false;
    }
    pending.modelSelector = undefined;
    pending.effortSelector = undefined;
    pending.completionHint = undefined;
    pending.completion = undefined;
    this.redrawPromptBlock();
    return true;
  }

  private recallPreviousHistory(): void {
    if (!this.pending || this.history.length === 0) {
      return;
    }
    this.historyIndex =
      this.historyIndex === undefined
        ? this.history.length - 1
        : Math.max(0, this.historyIndex - 1);
    this.replacePendingLine(this.history[this.historyIndex] ?? "");
  }

  private recallNextHistory(): void {
    if (!this.pending || this.historyIndex === undefined) {
      return;
    }
    if (this.historyIndex >= this.history.length - 1) {
      this.historyIndex = undefined;
      this.replacePendingLine("");
      return;
    }
    this.historyIndex += 1;
    this.replacePendingLine(this.history[this.historyIndex] ?? "");
  }

  private replacePendingLine(value: string): void {
    if (!this.pending) {
      return;
    }
    this.pending.line = [...value];
    this.pending.cursor = this.pending.line.length;
    this.pending.completionHint = undefined;
    this.pending.completion = undefined;
    this.pending.modelSelector = undefined;
    this.pending.effortSelector = undefined;
    this.redrawPromptBlock();
  }

  private insertNewlineAtCursor(): void {
    if (!this.pending) {
      return;
    }
    this.pending.line.splice(this.pending.cursor, 0, "\n");
    this.pending.cursor += 1;
    this.pending.completionHint = undefined;
    this.pending.completion = undefined;
    this.pending.modelSelector = undefined;
    this.pending.effortSelector = undefined;
    this.historyIndex = undefined;
    this.redrawPromptBlock();
  }

  private runActionWithPromptRefresh(action: () => void): void {
    this.clearPromptBlock();
    action();
    this.writePromptBlock();
  }

  private clearPromptBlock(): void {
    if (!this.pending) {
      return;
    }
    if (this.pending.cursorRow > 0) {
      this.output.write(`\x1b[${this.pending.cursorRow}A\r\x1b[J`);
      return;
    }
    this.output.write("\r\x1b[J");
  }

  private redrawPromptBlock(): void {
    if (!this.pending) {
      return;
    }
    if (this.pending.cursorRow > 0) {
      this.writePromptBlock(`\x1b[${this.pending.cursorRow}A\r\x1b[J`);
      return;
    }
    this.writePromptBlock("\r\x1b[J");
  }

  private writePromptBlock(prefix = ""): void {
    const pending = this.pending;
    if (!pending) {
      return;
    }
    const prompt = renderInteractivePrompt(
      pending.width,
      pending.line.join(""),
      pending.cursor,
      renderPromptHints(pending)
    );
    this.output.write(`${prefix}${prompt.block}`);
    pending.cursorRow = prompt.cursor.row;
    pending.cursorCol = prompt.cursor.col;
    pending.endRow = prompt.end.row;
    pending.endCol = prompt.end.col;
    if (prompt.end.row > prompt.cursor.row) {
      this.output.write(`\x1b[${prompt.end.row - prompt.cursor.row}A`);
      this.output.write("\r");
      if (prompt.cursor.col > 0) {
        this.output.write(`\x1b[${prompt.cursor.col}C`);
      }
      return;
    }
    if (prompt.end.col > prompt.cursor.col) {
      this.output.write(`\x1b[${prompt.end.col - prompt.cursor.col}D`);
    }
  }

  private movePromptCursorToEnd(): void {
    const pending = this.pending;
    if (!pending) {
      return;
    }
    const down = pending.endRow - pending.cursorRow;
    if (down > 0) {
      this.output.write(`\x1b[${down}B`);
      this.output.write("\r");
      if (pending.endCol > 0) {
        this.output.write(`\x1b[${pending.endCol}C`);
      }
    } else if (pending.endCol > pending.cursorCol) {
      this.output.write(`\x1b[${pending.endCol - pending.cursorCol}C`);
    } else if (pending.endCol < pending.cursorCol) {
      this.output.write("\r");
      if (pending.endCol > 0) {
        this.output.write(`\x1b[${pending.endCol}C`);
      }
    }
    pending.cursorRow = pending.endRow;
    pending.cursorCol = pending.endCol;
  }

  private resolvePending(line: string | undefined): void {
    const pending = this.pending;
    if (!pending) {
      return;
    }
    this.pending = undefined;
    this.restoreRawMode(pending.rawWasEnabled);
    this.input.pause();
    this.recordHistory(line);
    pending.resolve(line);
  }

  private recordHistory(line: string | undefined): void {
    const historyLine = line ?? "";
    const text = historyLine.trim();
    if (!text || text === "/exit" || text === "/quit") {
      return;
    }
    if (this.history.at(-1) !== historyLine) {
      this.history.push(historyLine);
    }
    this.historyIndex = undefined;
  }

  private enableRawMode(): boolean | undefined {
    const rawInput = this.input as Readable & {
      isTTY?: boolean;
      isRaw?: boolean;
      setRawMode?: (enabled: boolean) => void;
    };
    if (rawInput.isTTY !== true || typeof rawInput.setRawMode !== "function") {
      return undefined;
    }
    const wasRaw = rawInput.isRaw === true;
    rawInput.setRawMode(true);
    return wasRaw;
  }

  private restoreRawMode(wasRaw?: boolean): void {
    const rawInput = this.input as Readable & {
      isTTY?: boolean;
      setRawMode?: (enabled: boolean) => void;
    };
    if (
      wasRaw === undefined ||
      rawInput.isTTY !== true ||
      typeof rawInput.setRawMode !== "function"
    ) {
      return;
    }
    rawInput.setRawMode(wasRaw);
  }
}

function renderInteractivePrompt(
  width: number | undefined,
  text = "",
  cursor = text.length,
  hints: readonly string[] = []
): {
  block: string;
  cursor: { row: number; col: number };
  end: { row: number; col: number };
} {
  const safeWidth = clampTerminalWidth(width);
  const contentWidth = Math.max(1, safeWidth - interactivePromptPrefixWidth());
  const logicalLines = text.split("\n");
  const rows = [magenta(`+${"-".repeat(safeWidth - 2)}+`)];
  const safeCursor = Math.max(0, Math.min(cursor, text.length));
  let cursorPosition: { row: number; col: number } | undefined;
  let absoluteOffset = 0;

  logicalLines.forEach((line, lineIndex) => {
    const wrapped = wrapPromptLine(line, contentWidth);
    const lineCursor =
      safeCursor >= absoluteOffset && safeCursor <= absoluteOffset + line.length
        ? safeCursor - absoluteOffset
        : undefined;
    wrapped.forEach((part, wrapIndex) => {
      const prefix = interactivePromptPrefix(lineIndex === 0 && wrapIndex === 0);
      rows.push(`${prefix}${part}`);
    });
    if (lineCursor !== undefined) {
      const wrapIndex = Math.min(
        Math.floor(lineCursor / contentWidth),
        wrapped.length - 1
      );
      const colOffset = lineCursor - wrapIndex * contentWidth;
      cursorPosition = {
        row: rows.length - wrapped.length + wrapIndex,
        col: interactivePromptPrefixWidth() + colOffset
      };
    }
    absoluteOffset += line.length;
    if (lineIndex < logicalLines.length - 1) {
      absoluteOffset += 1;
    }
  });

  for (const hint of hints) {
    for (const part of wrapPromptLine(hint, contentWidth)) {
      rows.push(`${interactivePromptPrefix(false)}${formatPromptHintPart(part)}`);
    }
  }

  rows.push(renderInteractivePromptClose(safeWidth));

  const lastRow = rows.at(-1) ?? "";
  const end = {
    row: rows.length - 1,
    col: visiblePromptRowLength(lastRow)
  };
  return {
    block: rows.join("\n"),
    cursor: cursorPosition ?? end,
    end
  };
}

function renderInteractivePromptClose(width: number | undefined): string {
  const safeWidth = clampTerminalWidth(width);
  return magenta(`+${"-".repeat(safeWidth - 2)}+`);
}

function renderPromptHints(input: {
  completionHint?: string | undefined;
  completion?: SlashCompletionState | undefined;
  modelSelector?: ModelSelectorState | undefined;
  effortSelector?: EffortSelectorState | undefined;
}): string[] {
  if (input.modelSelector) {
    return renderModelSelectorHints(input.modelSelector);
  }
  if (input.effortSelector) {
    return renderEffortSelectorHints(input.effortSelector);
  }
  return renderCompletionHints(input.completionHint, input.completion);
}

function renderModelSelectorHints(selector: ModelSelectorState): string[] {
  const models = filteredModelSelectorModels(selector);
  const maxVisible = 8;
  const startIndex = Math.max(
    0,
    Math.min(selector.selected - Math.floor(maxVisible / 2), models.length - maxVisible)
  );
  const endIndex = Math.min(models.length, startIndex + maxVisible);
  const rows = [
    magenta("model selector"),
    dim("type to search | up/down choose | enter select | ctrl+c cancel"),
    `${magenta("search:")}${selector.query ? ` ${selector.query}` : ""}`
  ];
  for (let index = startIndex; index < endIndex; index += 1) {
    const model = models[index];
    if (!model) {
      continue;
    }
    const current = model === selector.selectedModel ? ` ${success("✓ current")}` : "";
    rows.push(
      index === selector.selected
        ? magenta(`› ${model}`) + current
        : dim(`  ${model}`) + current
    );
  }
  if (models.length === 0) {
    rows.push("No matching models");
  } else if (models.length > maxVisible) {
    rows.push(`(${selector.selected + 1}/${models.length})`);
  }
  return rows;
}

function filteredModelSelectorModels(selector: ModelSelectorState): readonly string[] {
  const query = selector.query.trim().toLowerCase();
  if (!query) {
    return selector.models;
  }
  return selector.models.filter((model) => model.toLowerCase().includes(query));
}

function renderEffortSelectorHints(selector: EffortSelectorState): string[] {
  return [
    magenta("effort selector"),
    dim("up/down choose | enter select | ctrl+c cancel"),
    ...selector.efforts.map((effort, index) => {
      const current =
        effort === selector.selectedEffort ? ` ${success("✓ current")}` : "";
      return index === selector.selected
        ? magenta(`› ${effort}`) + current
        : dim(`  ${effort}`) + current;
    })
  ];
}

function renderCompletionHints(
  completionHint: string | undefined,
  completion: SlashCompletionState | undefined
): string[] {
  if (!completionHint) {
    return [];
  }
  if (!completion) {
    return [completionHint];
  }
  return [
    completionHint,
    ...completion.matches.map((match, index) => {
      return index === completion.selected ? magenta(`› ${match}`) : dim(`  ${match}`);
    })
  ];
}

function formatPromptHintPart(part: string): string {
  return hasAnsi(part) ? part : dim(part);
}

function hasAnsi(value: string): boolean {
  return new RegExp(String.raw`\x1b\[[0-9;]*[A-Za-z]`).test(value);
}

function isCompleteInteractiveEscapeSequence(sequence: string): boolean {
  if (sequence.charCodeAt(0) !== 27) {
    return false;
  }
  const body = sequence.slice(1);
  return body === "\r" || /^\[[A-DZ]$/.test(body) || /^\[\d+(?:;\d+)*[~u]$/.test(body);
}

function isShiftCtrlPSequence(sequence: string): boolean {
  return sequence === "\x1b[80;6u" || sequence === "\x1b[112;6u";
}

function interactivePromptPrefix(firstLine: boolean): string {
  return `${magenta("|")} ${firstLine ? "openstrat> " : " ".repeat("openstrat> ".length)}`;
}

function interactivePromptPrefixWidth(): number {
  return 2 + "openstrat> ".length;
}

function wrapPromptLine(line: string, width: number): string[] {
  if (line.length === 0) {
    return [""];
  }
  const rows: string[] = [];
  for (let index = 0; index < line.length; index += width) {
    rows.push(line.slice(index, index + width));
  }
  return rows;
}

function lastIndexBefore(
  values: readonly string[],
  target: string,
  from: number
): number {
  for (let index = Math.min(from, values.length - 1); index >= 0; index -= 1) {
    if (values[index] === target) {
      return index;
    }
  }
  return -1;
}

function indexAtOrAfter(
  values: readonly string[],
  target: string,
  from: number
): number {
  for (let index = Math.max(0, from); index < values.length; index += 1) {
    if (values[index] === target) {
      return index;
    }
  }
  return -1;
}

function visiblePromptRowLength(row: string): number {
  return stripAnsiForMeasure(row).length;
}

function stripAnsiForMeasure(value: string): string {
  return value.replace(new RegExp(String.raw`\x1b\[[0-9;]*[A-Za-z]`, "g"), "");
}

function clampTerminalWidth(width: number | undefined): number {
  return Math.max(48, Math.min(140, Math.floor(width ?? 100)));
}

function magenta(value: string): string {
  return `\x1b[38;2;236;174;236m${value}\x1b[0m`;
}

function dim(value: string): string {
  return `\x1b[38;2;150;150;150m${value}\x1b[0m`;
}

function success(value: string): string {
  return `\x1b[38;2;126;186;126m${value}\x1b[0m`;
}

function stringFlag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) {
    return undefined;
  }
  return argv[index + 1];
}

function projectCodexFooterEvent(
  event: ThreadEvent,
  runtime: CodexWorkbenchRuntime,
  model: string,
  thinking: OpenStratThinkingEffort
): WorkbenchTuiFooterState | undefined {
  if (event.type !== "turn.completed") {
    return undefined;
  }
  const usage = event.usage;
  const contextWindow = runtime.contextWindow;
  const contextTokens = usage.input_tokens + usage.output_tokens;
  const cachedInputTokens = usage.cached_input_tokens ?? 0;
  const cacheHitPercent =
    usage.input_tokens > 0 && cachedInputTokens > 0
      ? (cachedInputTokens / usage.input_tokens) * 100
      : undefined;
  return {
    model,
    thinking,
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    reasoningTokens: usage.reasoning_output_tokens,
    autoCompact: true,
    ...(cacheHitPercent !== undefined ? { cacheHitPercent } : {}),
    ...(contextWindow ? { contextWindow } : {}),
    ...(contextWindow ? { contextPercent: (contextTokens / contextWindow) * 100 } : {})
  };
}

function projectCodexProgressEvent(event: ThreadEvent): WorkbenchTuiEntry | undefined {
  if (event.type === "turn.failed") {
    return {
      kind: "tool_error",
      title: "turn failed",
      body: event.error.message
    };
  }
  if (event.type === "error") {
    return {
      kind: "tool_error",
      title: "stream error",
      body: event.message
    };
  }
  if (
    event.type !== "item.started" &&
    event.type !== "item.updated" &&
    event.type !== "item.completed"
  ) {
    return undefined;
  }
  const item = event.item;
  if (item.type === "agent_message") {
    return undefined;
  }
  if (item.type === "reasoning") {
    return {
      id: item.id,
      kind: "thinking",
      title: "Thinking",
      body: item.text
    };
  }
  if (item.type === "file_change") {
    return {
      id: item.id,
      kind: item.status === "failed" ? "tool_error" : "tool_result",
      title: formatFileChangeTitle(item.changes[0]),
      body: [
        ...item.changes.slice(1).map((change) => formatFileChangeTitle(change)),
        `status: ${item.status}`
      ].join("\n")
    };
  }
  if (item.type === "command_execution") {
    return {
      id: item.id,
      kind: terminalToolKind(item.status),
      title: `$ ${item.command}`,
      body: [
        item.aggregated_output.trim(),
        `status: ${item.status}`,
        item.exit_code !== undefined ? `exit: ${item.exit_code}` : undefined
      ]
        .filter((line): line is string => line !== undefined && line.length > 0)
        .join("\n")
    };
  }
  if (item.type === "mcp_tool_call") {
    return {
      id: item.id,
      kind: terminalToolKind(item.status),
      title: formatMcpToolTitle(item.server, item.tool, item.arguments),
      body: formatMcpToolBody({
        error: item.error?.message,
        result: item.result,
        status: item.status,
        arguments: item.arguments
      })
    };
  }
  if (item.type === "web_search") {
    return {
      id: item.id,
      kind: event.type === "item.completed" ? "tool_result" : "tool_call",
      title: "web_search",
      body: item.query
    };
  }
  if (item.type === "todo_list") {
    return {
      id: item.id,
      kind: "progress",
      title: "Todo",
      body: item.items
        .map((todo) => `${todo.completed ? "[x]" : "[ ]"} ${todo.text}`)
        .join("\n")
    };
  }
  if (item.type === "error") {
    return {
      id: item.id,
      kind: "tool_error",
      title: "error",
      body: item.message
    };
  }
  return undefined;
}

function formatFileChangeTitle(
  change: { kind: string; path: string } | undefined
): string {
  if (!change) {
    return "file change";
  }
  return `${fileChangeVerb(change.kind)} ${change.path}`;
}

function fileChangeVerb(kind: string): "write" | "edit" | "delete" {
  if (kind === "add" || kind === "create" || kind === "write") {
    return "write";
  }
  if (kind === "delete" || kind === "remove" || kind === "unlink") {
    return "delete";
  }
  return "edit";
}

function formatMcpToolTitle(server: string, tool: string, args: unknown): string {
  const verb = mcpToolVerb(tool);
  if (!verb) {
    return `${server}.${tool}`;
  }
  return `${verb} ${mcpToolTarget(args) ?? mcpToolFallbackTarget(tool)}`;
}

function mcpToolVerb(
  tool: string
): "read" | "check" | "write" | "run" | "plan" | undefined {
  const segments = tool.toLowerCase().split(/[._-]/).filter(Boolean);
  if (segments.some((segment) => ["read", "inspect", "guide"].includes(segment))) {
    return "read";
  }
  if (
    segments.some((segment) => ["validate", "preflight", "check"].includes(segment))
  ) {
    return "check";
  }
  if (
    segments.some((segment) =>
      ["write", "create", "capture", "execute", "ingest", "ingestion"].includes(segment)
    )
  ) {
    return "write";
  }
  if (segments.includes("run")) {
    return "run";
  }
  if (segments.some((segment) => ["plan", "request"].includes(segment))) {
    return "plan";
  }
  return undefined;
}

function mcpToolTarget(args: unknown): string | undefined {
  if (!isRecord(args)) {
    return undefined;
  }
  const canonicalSymbol = stringRecordValue(args, "canonical_symbol");
  if (canonicalSymbol) {
    return canonicalSymbol;
  }
  const symbol = stringRecordValue(args, "symbol");
  const interval = stringRecordValue(args, "interval");
  if (symbol && interval) {
    return `${symbol} ${interval}`;
  }
  if (symbol) {
    return symbol;
  }
  for (const key of [
    "strategy_file",
    "path",
    "file",
    "dataset_id",
    "backtest_run_id",
    "run_id",
    "tool_name",
    "policy_ref"
  ]) {
    const value = stringRecordValue(args, key);
    if (value) {
      return value;
    }
  }
  return undefined;
}

function mcpToolFallbackTarget(tool: string): string {
  return tool.replaceAll("_", ".");
}

function stringRecordValue(
  record: Record<string, unknown>,
  key: string
): string | undefined {
  const value = record[key];
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function formatMcpToolBody(input: {
  error: string | undefined;
  result: { content: unknown[]; structured_content: unknown } | undefined;
  status: "in_progress" | "completed" | "failed";
  arguments: unknown;
}): string {
  const result = summarizeMcpResult(input.result);
  const args = summarizeUnknown(input.arguments);
  return [
    input.error ? `stderr: ${input.error}` : undefined,
    result ? `body: ${result}` : undefined,
    args ? `${result ? "args" : "body: args"} ${args}` : undefined,
    `status: ${input.status}`
  ]
    .filter((line): line is string => line !== undefined && line.length > 0)
    .join("\n");
}

function terminalToolKind(
  status: "in_progress" | "completed" | "failed"
): WorkbenchTuiEntry["kind"] {
  if (status === "failed") {
    return "tool_error";
  }
  return status === "completed" ? "tool_result" : "tool_call";
}

function summarizeMcpResult(
  result: { content: unknown[]; structured_content: unknown } | undefined
): string | undefined {
  if (!result) {
    return undefined;
  }
  const structured = summarizeUnknown(result.structured_content);
  if (structured) {
    return structured;
  }
  return summarizeUnknown(result.content);
}

function summarizeUnknown(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
