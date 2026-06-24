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
import { createCodexWorkbenchRuntime, type CodexWorkbenchRuntime } from "./runtime.js";
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
  renderWorkbenchTui,
  updateTuiSnapshot
} from "./workbench-tui.js";

const ENTER_ALT_SCREEN = "\x1b[?1049h\x1b[2J\x1b[3J\x1b[H";
const REFRESH_SCREEN = "\x1b[H\x1b[2J";
const EXIT_ALT_SCREEN = "\x1b[?1049l";

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
    commands: OPENSTRAT_SLASH_COMMANDS
  });
  const terminalOutput = isTerminalOutput(options.output) ? options.output : undefined;
  const interactiveOutput = lines.length === 0 ? terminalOutput : undefined;
  const useInteractiveScreen = interactiveOutput !== undefined;
  let interactiveScreenActive = false;
  let exitMessage: string | undefined;
  const enterInteractiveScreen = () => {
    if (!interactiveOutput || interactiveScreenActive) {
      return;
    }
    interactiveOutput.write(ENTER_ALT_SCREEN);
    interactiveScreenActive = true;
  };
  const exitInteractiveScreen = () => {
    if (!interactiveOutput || !interactiveScreenActive) {
      return;
    }
    interactiveOutput.write(EXIT_ALT_SCREEN);
    interactiveScreenActive = false;
  };
  const render = () => {
    tui = updateTuiSnapshot(tui, snapshot());
    const width = terminalWidth(options.env, options.output);
    const height = interactiveOutput
      ? terminalHeight(options.env, options.output)
      : undefined;
    const screen = renderWorkbenchTui(tui, {
      composerPrompt: "openstrat> ",
      showComposer: !useInteractiveScreen,
      ...(width === undefined ? {} : { width }),
      ...(height === undefined ? {} : { height: Math.max(8, height - 1) })
    });
    if (interactiveOutput) {
      enterInteractiveScreen();
      interactiveOutput.write(`${REFRESH_SCREEN}${screen}\n`);
      return;
    }
    emitBlock(options.stdout, screen);
  };
  const reader =
    lines.length === 0 && options.stdin
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
        render();
        continue;
      }

      appendTranscript(home, session, "user_message", { text: trimmed });
      tui = recordTuiEntry(tui, {
        kind: "user",
        title: "You",
        body: trimmed
      });
      tui = recordTuiEntry(tui, {
        kind: "progress",
        title: "Codex",
        body: "codex: working"
      });
      render();
      try {
        const result = await runtime.runTurn({
          prompt: trimmed,
          cwd: options.cwd,
          env: options.env,
          codexThreadId: session.codex_thread_id,
          home,
          cliEntrypoint: options.cliEntrypoint,
          onEvent: (event) => {
            appendTranscript(home, session, "codex_event", { event });
            projectCodexEventsToArtifacts(home, session, event);
            const progress = formatCodexProgressEvent(event);
            if (progress) {
              tui = recordTuiEntry(tui, {
                kind: "progress",
                title: "Codex",
                body: progress
              });
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
        render();
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
    exitInteractiveScreen();
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

function terminalHeight(
  env: Record<string, string | undefined>,
  output: Writable | undefined
): number | undefined {
  const rows = Number(env.LINES);
  if (Number.isFinite(rows) && rows >= 8) {
    return rows;
  }
  const outputRows = (output as { rows?: unknown } | undefined)?.rows;
  return typeof outputRows === "number" && Number.isFinite(outputRows)
    ? outputRows
    : undefined;
}

function stringFlag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) {
    return undefined;
  }
  return argv[index + 1];
}

function formatCodexProgressEvent(event: ThreadEvent): string | undefined {
  if (event.type !== "item.completed") {
    return undefined;
  }
  const item = event.item;
  if (item.type === "agent_message") {
    return "codex: message completed";
  }
  if (item.type === "file_change") {
    return `codex: file_change ${item.status} ${item.changes.map((change) => change.path).join(", ")}`;
  }
  if (item.type === "command_execution") {
    return `codex: command ${item.status} exit=${item.exit_code ?? "pending"} ${item.command}`;
  }
  if (item.type === "mcp_tool_call") {
    return `codex: tool ${item.server}.${item.tool} ${item.status}`;
  }
  return `codex: ${item.type} completed`;
}
