import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { OPENSTRAT_CODEX_BASELINE_CONTRACT } from "@openstrat/domain";
import { AGENT_TOOL_GATEWAY_TOOLS } from "@openstrat/workers";
import { runOpenStratCli } from "./commands.js";
import { invokeOpenStratMcpTool } from "./mcp.js";
import {
  artifactIndexPath,
  createWorkbenchSession,
  listWorkbenchSessions,
  readArtifactIndex
} from "./session-store.js";
import { resolveOpenStratCliHome } from "./home.js";
import { listBacktests, listDatasets, listMarkets } from "./trading-workbench.js";
import { buildWorkbenchSnapshot } from "./workbench-summary.js";
import {
  createWorkbenchTuiState,
  recordTuiDiagnostic,
  recordTuiEntry,
  renderSlashCommandView,
  renderWorkbenchTui
} from "./workbench-tui.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("OpenStrat CLI Codex workbench", () => {
  it("renders a rich workbench TUI with compact state, cards, diagnostics, footer, and composer control", () => {
    const fixture = createFixture();
    const home = resolveOpenStratCliHome({ cwd: fixture.project, env: fixture.env });
    const session = createWorkbenchSession(home, fixture.project);
    const snapshot = buildWorkbenchSnapshot({
      home,
      cwd: fixture.project,
      env: fixture.env,
      session
    });
    const state = recordTuiDiagnostic(
      recordTuiEntry(
        createWorkbenchTuiState({
          runtimeKind: "fake_codex",
          snapshot,
          commands: ["/markets", "/datasets", "/sessions"]
        }),
        {
          kind: "user",
          title: "You",
          body: "I need SOL scalping data"
        }
      ),
      {
        severity: "warning",
        message: "MCP startup warning was routed out of the main transcript"
      }
    );

    const screen = renderWorkbenchTui(state, {
      width: 90,
      composerPrompt: "openstrat> "
    });
    const liveScreen = renderWorkbenchTui(state, {
      width: 90,
      composerPrompt: "openstrat> ",
      showComposer: false
    });
    const narrowScreen = renderWorkbenchTui(state, {
      width: 50,
      composerPrompt: "openstrat> "
    });

    expect(screen).toContain("OpenStrat Workbench");
    expect(screen).toContain("fake_codex | auth missing");
    expect(screen).toContain("local work | wallet no | deploy no");
    expect(screen).toContain("data 0 | markets 0 | strategies 0 | backtests 0");
    expect(screen).toContain("project ");
    expect(screen).toContain(".openstrat");
    expect(screen).toContain("user ");
    expect(screen).toContain("artifact missing");
    expect(screen).toContain("commands: /markets /datasets /sessions");
    expect(screen).toContain("You");
    expect(screen).toContain("I need SOL scalping data");
    expect(screen).toContain("Diagnostic warning");
    expect(screen).toContain("MCP startup warning");
    expect(screen).toContain("Composer");
    expect(screen).toContain("openstrat>");
    expect(liveScreen).not.toContain("Composer");
    expect(liveScreen).not.toContain("openstrat>");
    expect(narrowScreen.split("\n").every((line) => line.length <= 50)).toBe(true);
  });

  it("renders a selected Hyperliquid market as a dataset-planning action", async () => {
    const fixture = createFixture();
    const home = resolveOpenStratCliHome({
      cwd: fixture.project,
      env: {
        ...fixture.env,
        OPENSTRAT_CODEX_RUNTIME: "fake"
      }
    });
    const session = createWorkbenchSession(home, fixture.project);
    const result = await runOpenStratCli({
      argv: [],
      cwd: fixture.project,
      env: {
        ...fixture.env,
        OPENSTRAT_CODEX_RUNTIME: "fake"
      },
      inputLines: ["/markets SOL", "/exit"],
      stdout: () => undefined,
      stderr: () => undefined
    });

    expect(result.exitCode).toBe(0);
    const screen = renderSlashCommandView({
      command: "/markets",
      status: "ok",
      summary: "Hyperliquid perps",
      data: {
        markets: listMarkets(home),
        selected_market: listMarkets(home).find(
          (market) => market.canonical_symbol === "SOL-PERP"
        )
      },
      next_suggested_action:
        "/datasets plan --symbol SOL SOL token 5m and 15m scalping data",
      session
    });

    expect(screen).toContain("Market Catalog");
    expect(screen).toContain("selected: SOL-PERP");
    expect(screen).toContain("/datasets plan --symbol SOL");
  });

  it("reports auth and home boundaries without reading token contents", async () => {
    const fixture = createFixture();
    mkdirSync(fixture.codexHome, { recursive: true });
    const fakeBin = join(fixture.root, "dist", "openstrat");
    mkdirSync(join(fixture.root, "dist"), { recursive: true });
    writeFileSync(fakeBin, "#!/usr/bin/env node\n", "utf8");
    writeFileSync(join(fixture.root, "dist", "index.js"), "", "utf8");
    chmodSync(fakeBin, 0o755);
    writeFileSync(
      join(fixture.codexHome, "auth.json"),
      JSON.stringify({ token: "secret-token-that-must-not-print" }),
      "utf8"
    );
    const output: string[] = [];

    const result = await runOpenStratCli({
      argv: ["doctor"],
      cwd: fixture.project,
      env: fixture.env,
      cliEntrypoint: fakeBin,
      stdout: (line) => output.push(line),
      stderr: (line) => output.push(line)
    });

    expect(result.exitCode).toBe(0);
    expect(output.join("\n")).toContain("codex auth: chatgpt_cache");
    expect(output.join("\n")).not.toContain("secret-token-that-must-not-print");
    expect(output.join("\n")).toContain(`project home: ${fixture.openstratHome}`);
    expect(output.join("\n")).toContain(`user home: ${fixture.userHome}`);
    expect(output.join("\n")).toContain("node: v");
    expect(output.join("\n")).toContain(`cli entrypoint: ${fakeBin}`);
    expect(output.join("\n")).toContain("bin executable: yes");
    expect(output.join("\n")).toContain("dist index: present");
  });

  it("launches bare TUI, handles slash commands, and projects fake Codex turns", async () => {
    const fixture = createFixture();
    const output: string[] = [];

    const result = await runOpenStratCli({
      argv: [],
      cwd: fixture.project,
      env: {
        ...fixture.env,
        OPENSTRAT_CODEX_RUNTIME: "fake"
      },
      inputLines: [
        "/help",
        "/status",
        "/guide",
        "/markets",
        "/new",
        "write a simple OpenStrat strategy",
        "/strategy",
        "/ready",
        "/compact",
        "/exit"
      ],
      stdout: (line) => output.push(line),
      stderr: (line) => output.push(line)
    });

    expect(result.exitCode).toBe(0);
    expect(output[0]).toContain("OpenStrat Workbench");
    expect(output.join("\n")).toContain("fake_codex | auth missing");
    expect(output.join("\n")).toContain("project ");
    expect(output.join("\n")).toContain(".openstrat");
    expect(output.join("\n")).toContain("OpenStrat local workbench commands");
    expect(output.join("\n")).toContain("Guided local strategy workbench path");
    expect(output.join("\n")).toContain("Started new OpenStrat session");
    expect(output.join("\n")).toContain("codex: file_change completed");
    expect(output.join("\n")).toContain("Found 1 strategy source candidate");
    expect(output.join("\n")).toContain("local strategy ready: no");
    expect(readFileSync(join(fixture.project, "src", "strategy.ts"), "utf8")).toContain(
      "defineStrategy"
    );

    const home = resolveOpenStratCliHome({
      cwd: fixture.project,
      env: {
        ...fixture.env,
        OPENSTRAT_CODEX_RUNTIME: "fake"
      }
    });
    const sessions = listWorkbenchSessions(home);
    expect(sessions.length).toBeGreaterThanOrEqual(2);
    expect(readArtifactIndex(home).entries.map((entry) => entry.kind)).toEqual(
      expect.arrayContaining([
        "slash_command_result",
        "codex_file_change",
        "codex_agent_message",
        "session_summary"
      ])
    );
  });

  it("loads a Hyperliquid perps market menu before dataset ingestion", async () => {
    const fixture = createFixture();
    const output: string[] = [];

    const result = await runOpenStratCli({
      argv: [],
      cwd: fixture.project,
      env: {
        ...fixture.env,
        OPENSTRAT_CODEX_RUNTIME: "fake"
      },
      inputLines: ["/markets", "/exit"],
      stdout: (line) => output.push(line),
      stderr: (line) => output.push(line)
    });

    expect(result.exitCode).toBe(0);
    expect(output.join("\n")).toContain("Hyperliquid perps");
    expect(output.join("\n")).toContain("SOL-PERP");
    expect(output.join("\n")).toContain("HYPE-PERP");
    expect(output.join("\n")).toContain("/datasets plan SOL token");
    const home = resolveOpenStratCliHome({ cwd: fixture.project, env: fixture.env });
    expect(listMarkets(home).map((market) => market.canonical_symbol)).toEqual(
      expect.arrayContaining(["BTC-PERP", "ETH-PERP", "SOL-PERP", "HYPE-PERP"])
    );
  });

  it("projects command views, diagnostics, sessions, and Codex progress through the TUI loop", async () => {
    const fixture = createFixture();
    const output: string[] = [];

    const result = await runOpenStratCli({
      argv: [],
      cwd: fixture.project,
      env: {
        ...fixture.env,
        OPENSTRAT_CODEX_RUNTIME: "fake"
      },
      inputLines: [
        "/markets SOL",
        "/definitely-not-real",
        "write a strategy for the selected SOL dataset",
        "/sessions",
        "/compact",
        "/exit"
      ],
      stdout: (line) => output.push(line),
      stderr: (line) => output.push(line)
    });

    const rendered = output.join("\n");
    expect(result.exitCode).toBe(0);
    expect(rendered).toContain("Workbench View");
    expect(rendered).toContain("Market Catalog");
    expect(rendered).toContain("selected: SOL-PERP");
    expect(rendered).toContain("/datasets plan --symbol SOL");
    expect(rendered).toContain("Diagnostic error");
    expect(rendered).toContain("Unknown OpenStrat command: /definitely-not-real");
    expect(rendered).toContain("codex: file_change completed");
    expect(rendered).toContain("Sessions");
    expect(rendered).toContain("Wrote OpenStrat session summary");
    expect(rendered).toContain("Composer");
  });

  it("honors COLUMNS for scripted non-TTY TUI output", async () => {
    const fixture = createFixture();
    const output: string[] = [];

    const result = await runOpenStratCli({
      argv: [],
      cwd: fixture.project,
      env: {
        ...fixture.env,
        COLUMNS: "54",
        OPENSTRAT_CODEX_RUNTIME: "fake"
      },
      inputLines: ["/markets SOL", "/exit"],
      stdout: (line) => output.push(line),
      stderr: (line) => output.push(line)
    });

    expect(result.exitCode).toBe(0);
    expect(output.join("\n")).toContain("selected: SOL-PERP");
    expect(output.filter((line) => line.length > 54)).toEqual([]);
  });

  it("uses the alternate screen for live TTY workbench rendering", async () => {
    const fixture = createFixture();
    const stdout: string[] = [];
    const terminal = new CapturingTtyWritable(96, 20);

    const result = await runOpenStratCli({
      argv: [],
      cwd: fixture.project,
      env: {
        ...fixture.env,
        OPENSTRAT_CODEX_RUNTIME: "fake"
      },
      stdin: Readable.from(["/exit\n"]),
      output: terminal,
      stdout: (line) => stdout.push(line),
      stderr: (line) => stdout.push(line)
    });

    const rawScreen = terminal.output;
    expect(result.exitCode).toBe(0);
    expect(rawScreen).toContain("\x1b[?1049h");
    expect(rawScreen).toContain("\x1b[H\x1b[2JOpenStrat Workbench");
    expect(rawScreen).toContain("\x1b[?1049l");
    expect(rawScreen).not.toContain("+- Composer");
    expect(renderedTtyFrameHeights(rawScreen).every((height) => height <= 19)).toBe(
      true
    );
    expect(stdout).toContain("bye");
  });

  it("clips rich TUI rendering to the requested viewport height", () => {
    const fixture = createFixture();
    const home = resolveOpenStratCliHome({ cwd: fixture.project, env: fixture.env });
    const session = createWorkbenchSession(home, fixture.project);
    const snapshot = buildWorkbenchSnapshot({
      home,
      cwd: fixture.project,
      env: fixture.env,
      session
    });
    const state = createWorkbenchTuiState({
      runtimeKind: "fake_codex",
      snapshot,
      commands: ["/help", "/markets", "/datasets", "/sessions"],
      entries: [
        {
          kind: "command",
          title: "/markets ok",
          body: Array.from(
            { length: 40 },
            (_, index) => `${index + 1}. MARKET-${index + 1}-PERP active liquidity=1.00`
          ).join("\n")
        }
      ],
      activeView: [
        "Market Catalog",
        ...Array.from({ length: 40 }, (_, index) => {
          return `${index + 1}. MARKET-${index + 1}-PERP active liquidity=1.00`;
        })
      ].join("\n")
    });

    const rendered = renderWorkbenchTui(state, {
      width: 80,
      showComposer: false,
      height: 20
    } as Parameters<typeof renderWorkbenchTui>[1] & { height: number });

    expect(rendered.split("\n").length).toBeLessThanOrEqual(20);
    expect(rendered).toContain("OpenStrat Workbench");
    expect(rendered).toContain("session ");
  });

  it("runs a headless prompt through the same session and artifact projection", async () => {
    const fixture = createFixture();
    const output: string[] = [];

    const result = await runOpenStratCli({
      argv: ["chat", "--prompt", "write a strategy"],
      cwd: fixture.project,
      env: {
        ...fixture.env,
        OPENSTRAT_CODEX_RUNTIME: "fake"
      },
      stdout: (line) => output.push(line),
      stderr: (line) => output.push(line)
    });

    expect(result.exitCode).toBe(0);
    expect(output.join("\n")).toContain("Fake Codex completed the turn");
    expect(readFileSync(join(fixture.project, "src", "strategy.ts"), "utf8")).toContain(
      "fake_codex_strategy"
    );
    const home = resolveOpenStratCliHome({ cwd: fixture.project, env: fixture.env });
    expect(readFileSync(artifactIndexPath(home), "utf8")).toContain(
      "codex_file_change"
    );
  });

  it("lets fake Codex write strategy code aligned to the latest selected dataset", async () => {
    const fixture = createFixture();
    await runOpenStratCli({
      argv: [
        "datasets",
        "ingest",
        "--symbol",
        "SOL",
        "--interval",
        "5m",
        "--start",
        "2026-06-01T00:00:00.000Z",
        "--end",
        "2026-06-01T01:00:00.000Z",
        "--fixture"
      ],
      cwd: fixture.project,
      env: fixture.env,
      stdout: () => undefined,
      stderr: () => undefined
    });

    const result = await runOpenStratCli({
      argv: ["chat", "--prompt", "write a strategy for the selected SOL dataset"],
      cwd: fixture.project,
      env: {
        ...fixture.env,
        OPENSTRAT_CODEX_RUNTIME: "fake"
      },
      stdout: () => undefined,
      stderr: () => undefined
    });

    expect(result.exitCode).toBe(0);
    const source = readFileSync(join(fixture.project, "src", "strategy.ts"), "utf8");
    expect(source).toContain('allowed_symbols: ["SOL-PERP"]');
    expect(source).toContain(
      'required_data: [{ kind: "candles", canonical_symbol: "SOL-PERP", interval: "5m" }]'
    );
  });

  it("lists and resumes OpenStrat sessions without owning Codex internals", async () => {
    const fixture = createFixture();
    await runOpenStratCli({
      argv: ["chat", "--prompt", "write a strategy"],
      cwd: fixture.project,
      env: {
        ...fixture.env,
        OPENSTRAT_CODEX_RUNTIME: "fake"
      },
      stdout: () => undefined,
      stderr: () => undefined
    });
    const home = resolveOpenStratCliHome({ cwd: fixture.project, env: fixture.env });
    const [session] = listWorkbenchSessions(home);
    expect(session?.codex_thread_id).toMatch(/^fake_thread_/);

    const output: string[] = [];
    const result = await runOpenStratCli({
      argv: [],
      cwd: fixture.project,
      env: {
        ...fixture.env,
        OPENSTRAT_CODEX_RUNTIME: "fake"
      },
      inputLines: ["/sessions", `/resume ${session?.id}`, "/exit"],
      stdout: (line) => output.push(line),
      stderr: (line) => output.push(line)
    });

    expect(result.exitCode).toBe(0);
    expect(output.join("\n")).toContain(`Resumed OpenStrat session ${session?.id}`);
    expect(output.join("\n")).toContain("Found 2 OpenStrat workbench session");
  });

  it("fails clearly for unknown slash commands", async () => {
    const fixture = createFixture();
    const output: string[] = [];

    const result = await runOpenStratCli({
      argv: [],
      cwd: fixture.project,
      env: {
        ...fixture.env,
        OPENSTRAT_CODEX_RUNTIME: "fake"
      },
      inputLines: ["/definitely-not-real", "/exit"],
      stdout: (line) => output.push(line),
      stderr: (line) => output.push(line)
    });

    expect(result.exitCode).toBe(0);
    expect(output.join("\n")).toContain(
      "Unknown OpenStrat command: /definitely-not-real"
    );
  });

  it("keeps the Codex baseline tool contract aligned with gateway and MCP names", () => {
    expect(
      OPENSTRAT_CODEX_BASELINE_CONTRACT.openstrat_tools.map((tool) => tool.name)
    ).toEqual([...AGENT_TOOL_GATEWAY_TOOLS]);
    expect(
      OPENSTRAT_CODEX_BASELINE_CONTRACT.openstrat_tools.map((tool) =>
        tool.name.replaceAll(".", "_")
      )
    ).toEqual([
      "market_data_read_snapshot",
      "dataset_plan_ingestion",
      "dataset_execute_ingestion",
      "dataset_validate",
      "dataset_inspect",
      "strategy_guide",
      "strategy_validate",
      "backtest_plan",
      "backtest_run",
      "backtest_request",
      "risk_preflight",
      "risk_validate_intent",
      "strategy_patch_capture",
      "memory_proposal_capture",
      "deployment_gate_inspect"
    ]);
  });

  it("runs the local trading workbench loop from data planning to risk preflight", async () => {
    const fixture = createFixture();
    writeStrategyFixture(fixture.project, "SOL-PERP", "5m");
    const output: string[] = [];

    const result = await runOpenStratCli({
      argv: [],
      cwd: fixture.project,
      env: {
        ...fixture.env,
        OPENSTRAT_CODEX_RUNTIME: "fake"
      },
      inputLines: [
        "/datasets plan SOL token 5m and 15m scalping data",
        "/datasets ingest --symbol SOL --interval 5m --start 2026-06-01T00:00:00.000Z --end 2026-06-01T01:00:00.000Z --fixture",
        "/datasets validate",
        "/datasets inspect",
        "/strategy guide --strategy src/strategy.ts",
        "/strategy validate --strategy src/strategy.ts",
        "/backtest plan --initial-equity 20000 --fee-bps 7 --slippage-bps 3 --run-id scalper_smoke",
        "/backtest run --initial-equity 20000 --fee-bps 7 --slippage-bps 3 --run-id scalper_smoke",
        "/risk preflight --max-notional 1500 --max-drawdown-pct 25 --min-trades 1 --min-win-rate 0 --policy-ref risk/local-test",
        "/artifacts latest",
        "/ready",
        "/exit"
      ],
      stdout: (line) => output.push(line),
      stderr: (line) => output.push(line)
    });

    const home = resolveOpenStratCliHome({ cwd: fixture.project, env: fixture.env });
    expect(result.exitCode).toBe(0);
    expect(output.join("\n")).toContain("Planned SOL 5m/15m ingestion");
    expect(output.join("\n")).toContain("Ingested dataset dataset_hyperliquid_sol_5m");
    expect(output.join("\n")).toContain("ok: dataset");
    expect(output.join("\n")).toContain("ok: inspected dataset_hyperliquid_sol_5m");
    expect(output.join("\n")).toContain("Prepared strategy authoring guide");
    expect(output.join("\n")).toContain("ok: strategy validation");
    expect(output.join("\n")).toContain("Planned backtest scalper_smoke");
    expect(output.join("\n")).toContain("Backtest scalper_smoke");
    expect(output.join("\n")).toContain("approved: local risk preflight");
    expect(output.join("\n")).toContain("Latest local evidence");
    expect(output.join("\n")).toContain("local strategy ready: yes");
    expect(output.join("\n")).toContain("wallet configured: no");
    expect(output.join("\n")).toContain("deployment configured: no");
    expect(listDatasets(home)).toHaveLength(1);
    expect(listMarkets(home).map((market) => market.canonical_symbol)).toContain(
      "SOL-PERP"
    );
    expect(listBacktests(home)).toHaveLength(1);
    expect(listBacktests(home)[0]?.config).toMatchObject({
      initial_equity_usd: 20000,
      fee_bps: 7,
      slippage_bps: 3
    });
    expect(readArtifactIndex(home).entries.map((entry) => entry.kind)).toEqual(
      expect.arrayContaining([
        "dataset_ingestion_plan",
        "dataset_ingest_result",
        "dataset_inspection",
        "dataset_validation",
        "strategy_authoring_guide",
        "strategy_validation",
        "backtest_plan",
        "backtest_report",
        "risk_preflight"
      ])
    );
  });

  it("plans ingestion from natural language and fails clearly without fixture or live approval", async () => {
    const fixture = createFixture();
    const output: string[] = [];
    const planResult = await runOpenStratCli({
      argv: [
        "datasets",
        "plan",
        "--prompt",
        "I need SOL token data for a 5 or 15m scalping strategy"
      ],
      cwd: fixture.project,
      env: fixture.env,
      stdout: (line) => output.push(line),
      stderr: (line) => output.push(line)
    });
    expect(planResult.exitCode).toBe(0);
    expect(output.join("\n")).toContain('"symbol": "SOL"');
    expect(output.join("\n")).toContain('"5m"');
    expect(output.join("\n")).toContain('"15m"');

    const failed: string[] = [];
    const ingestResult = await runOpenStratCli({
      argv: [
        "datasets",
        "ingest",
        "--symbol",
        "SOL",
        "--interval",
        "5m",
        "--start",
        "2026-06-01T00:00:00.000Z",
        "--end",
        "2026-06-01T01:00:00.000Z"
      ],
      cwd: fixture.project,
      env: fixture.env,
      stdout: (line) => failed.push(line),
      stderr: (line) => failed.push(line)
    });
    expect(ingestResult.exitCode).toBe(1);
    expect(failed.join("\n")).toContain("requires --fixture");
    expect(failed.join("\n")).toContain("next: Use `--fixture`");
  });

  it("returns actionable strategy validation and risk threshold failures", async () => {
    const fixture = createFixture();
    writeInvalidStrategyFixture(fixture.project);
    await runOpenStratCli({
      argv: [
        "datasets",
        "ingest",
        "--symbol",
        "SOL",
        "--interval",
        "5m",
        "--start",
        "2026-06-01T00:00:00.000Z",
        "--end",
        "2026-06-01T01:00:00.000Z",
        "--fixture"
      ],
      cwd: fixture.project,
      env: fixture.env,
      stdout: () => undefined,
      stderr: () => undefined
    });

    const validationOutput: string[] = [];
    const validation = await runOpenStratCli({
      argv: [
        "strategy",
        "validate",
        "--strategy",
        "src/strategy.ts",
        "--dataset",
        "dataset_hyperliquid_sol_5m_1780272000000_1780275600000"
      ],
      cwd: fixture.project,
      env: fixture.env,
      stdout: (line) => validationOutput.push(line),
      stderr: (line) => validationOutput.push(line)
    });

    expect(validation.exitCode).toBe(1);
    expect(validationOutput.join("\n")).toContain("required_data");
    expect(validationOutput.join("\n")).toContain("Strategy execution probe failed");
    expect(validationOutput.join("\n")).toContain("TradeIntent");

    writeStrategyFixture(fixture.project, "SOL-PERP", "5m");
    await runOpenStratCli({
      argv: [
        "backtest",
        "run",
        "--strategy",
        "src/strategy.ts",
        "--run-id",
        "risk_threshold_test"
      ],
      cwd: fixture.project,
      env: fixture.env,
      stdout: () => undefined,
      stderr: () => undefined
    });

    const riskOutput: string[] = [];
    const risk = await runOpenStratCli({
      argv: [
        "risk",
        "preflight",
        "--strategy",
        "src/strategy.ts",
        "--backtest",
        "risk_threshold_test",
        "--min-trades",
        "2"
      ],
      cwd: fixture.project,
      env: fixture.env,
      stdout: (line) => riskOutput.push(line),
      stderr: (line) => riskOutput.push(line)
    });

    expect(risk.exitCode).toBe(1);
    expect(riskOutput.join("\n")).toContain('"name": "min_trades"');
    expect(riskOutput.join("\n")).toContain('"status": "fail"');
  });

  it("routes Codex-facing MCP tools through the OpenStrat gateway", async () => {
    const fixture = createFixture();
    const output = await invokeOpenStratMcpTool(
      "strategy_patch.capture",
      {
        call_id: "mcp_call_strategy_patch",
        session_id: "session_mcp",
        turn_id: "turn_mcp",
        proposal: {
          id: "strategy_patch_001",
          created_at: "2026-06-22T00:00:00.000Z",
          session_id: "session_mcp",
          status: "proposed",
          strategy_id: "btc_breakout",
          patch_format: "unified_diff",
          patch_ref: "agent-artifacts/strategy_patch_001.diff",
          rationale: "Test capture through MCP bridge.",
          artifact_ref: {
            id: "artifact_strategy_patch_001",
            kind: "proposal",
            uri: "agent-artifacts/strategy_patch_001.json",
            content_hash: "sha256:strategy-patch",
            created_at: "2026-06-22T00:00:00.000Z",
            append_only: true
          }
        }
      },
      fixture.env,
      fixture.project
    );

    expect(output.status).toBe("completed");
    expect(output.canonical_tool_name).toBe("strategy_patch.capture");
    expect(
      existsSync(
        join(
          fixture.openstratHome,
          "objects",
          "agent-artifacts",
          "strategy_patch_001.json"
        )
      )
    ).toBe(true);
  });

  it("routes Codex-facing MCP tools through the trading workbench", async () => {
    const fixture = createFixture();
    writeStrategyFixture(fixture.project, "SOL-PERP", "5m");

    const plan = await invokeOpenStratMcpTool(
      "dataset.plan_ingestion",
      {
        call_id: "mcp_call_dataset_plan",
        session_id: "session_mcp",
        turn_id: "turn_mcp",
        prompt: "Need SOL 5m scalping candles"
      },
      fixture.env,
      fixture.project
    );
    expect(plan.status).toBe("completed");
    expect(JSON.stringify(plan.result)).toContain("SOL-PERP");

    const ingest = await invokeOpenStratMcpTool(
      "dataset.execute_ingestion",
      {
        call_id: "mcp_call_dataset_ingest",
        session_id: "session_mcp",
        turn_id: "turn_mcp",
        symbol: "SOL",
        interval: "5m",
        start: "2026-06-01T00:00:00.000Z",
        end: "2026-06-01T01:00:00.000Z",
        fixture: true
      },
      fixture.env,
      fixture.project
    );
    expect(ingest.status).toBe("completed");

    const inspect = await invokeOpenStratMcpTool(
      "dataset.inspect",
      {
        call_id: "mcp_call_dataset_inspect",
        session_id: "session_mcp",
        turn_id: "turn_mcp"
      },
      fixture.env,
      fixture.project
    );
    expect(inspect.status).toBe("completed");
    expect(JSON.stringify(inspect.result)).toContain('"candle_count"');

    const guide = await invokeOpenStratMcpTool(
      "strategy.guide",
      {
        call_id: "mcp_call_strategy_guide",
        session_id: "session_mcp",
        turn_id: "turn_mcp",
        strategy_file: "src/strategy.ts"
      },
      fixture.env,
      fixture.project
    );
    expect(guide.status).toBe("completed");
    expect(JSON.stringify(guide.result)).toContain("@openstrat/strategy-sdk");

    const backtest = await invokeOpenStratMcpTool(
      "backtest.run",
      {
        call_id: "mcp_call_backtest_run",
        session_id: "session_mcp",
        turn_id: "turn_mcp",
        strategy_file: "src/strategy.ts",
        initial_equity_usd: 25000,
        fee_bps: 8,
        slippage_bps: 4,
        run_id: "mcp_configured_backtest"
      },
      fixture.env,
      fixture.project
    );
    expect(backtest.status).toBe("completed");
    const home = resolveOpenStratCliHome({ cwd: fixture.project, env: fixture.env });
    expect(listBacktests(home)).toHaveLength(1);
    expect(listBacktests(home)[0]?.config.initial_equity_usd).toBe(25000);

    const risk = await invokeOpenStratMcpTool(
      "risk.preflight",
      {
        call_id: "mcp_call_risk_preflight",
        session_id: "session_mcp",
        turn_id: "turn_mcp",
        strategy_file: "src/strategy.ts",
        backtest_run_id: "mcp_configured_backtest",
        min_trades: 1,
        max_drawdown_pct: 25
      },
      fixture.env,
      fixture.project
    );
    expect(risk.status).toBe("completed");
    expect(JSON.stringify(risk.result)).toContain('"status":"approved"');
  });

  it("plans uninstall cleanup without claiming external Codex state", async () => {
    const fixture = createFixture();
    mkdirSync(fixture.openstratHome, { recursive: true });
    mkdirSync(join(fixture.userHome, "sessions"), { recursive: true });
    mkdirSync(fixture.codexHome, { recursive: true });
    writeFileSync(join(fixture.codexHome, "config.toml"), 'model = "gpt-test"\n');
    const output: string[] = [];

    const result = await runOpenStratCli({
      argv: ["uninstall", "--dry-run"],
      cwd: fixture.project,
      env: fixture.env,
      stdout: (line) => output.push(line),
      stderr: (line) => output.push(line)
    });

    expect(result.exitCode).toBe(0);
    expect(output.join("\n")).toContain("OpenStrat uninstall cleanup plan");
    expect(output.join("\n")).toContain(
      `[dry-run] remove project home: ${fixture.openstratHome}`
    );
    expect(output.join("\n")).toContain(
      `[dry-run] remove user home: ${fixture.userHome}`
    );
    expect(output.join("\n")).toContain(
      `preserve external Codex home: ${fixture.codexHome}`
    );
    expect(output.join("\n")).toContain("npm uninstall -g @openstrat/cli");
    expect(existsSync(fixture.openstratHome)).toBe(true);
    expect(existsSync(fixture.userHome)).toBe(true);
    expect(existsSync(fixture.codexHome)).toBe(true);
  });

  it("requires explicit confirmation before removing OpenStrat-owned state", async () => {
    const fixture = createFixture();
    mkdirSync(fixture.openstratHome, { recursive: true });
    mkdirSync(fixture.userHome, { recursive: true });
    const failedOutput: string[] = [];

    const failed = await runOpenStratCli({
      argv: ["cleanup", "--project"],
      cwd: fixture.project,
      env: fixture.env,
      stdout: (line) => failedOutput.push(line),
      stderr: (line) => failedOutput.push(line)
    });

    expect(failed.exitCode).toBe(1);
    expect(failedOutput.join("\n")).toContain("cleanup requires --dry-run or --yes");
    expect(existsSync(fixture.openstratHome)).toBe(true);
    expect(existsSync(fixture.userHome)).toBe(true);

    const output: string[] = [];
    const result = await runOpenStratCli({
      argv: ["cleanup", "--project", "--yes"],
      cwd: fixture.project,
      env: fixture.env,
      stdout: (line) => output.push(line),
      stderr: (line) => output.push(line)
    });

    expect(result.exitCode).toBe(0);
    expect(output.join("\n")).toContain(
      `removed project home: ${fixture.openstratHome}`
    );
    expect(existsSync(fixture.openstratHome)).toBe(false);
    expect(existsSync(fixture.userHome)).toBe(true);
  });
});

function createFixture(): {
  root: string;
  project: string;
  openstratHome: string;
  userHome: string;
  codexHome: string;
  env: Record<string, string>;
} {
  const root = mkdtempSync(join(tmpdir(), "openstrat-cli-test-"));
  roots.push(root);
  const project = join(root, "project");
  const openstratHome = join(project, ".openstrat");
  const userHome = join(root, "user-openstrat");
  const codexHome = join(root, "codex-home");
  mkdirSync(project, { recursive: true });
  return {
    root,
    project,
    openstratHome,
    userHome,
    codexHome,
    env: {
      HOME: root,
      OPENSTRAT_HOME: openstratHome,
      OPENSTRAT_USER_HOME: userHome,
      CODEX_HOME: codexHome
    }
  };
}

function writeStrategyFixture(
  project: string,
  canonicalSymbol: string,
  interval: string
): void {
  mkdirSync(join(project, "src"), { recursive: true });
  writeFileSync(
    join(project, "src", "strategy.ts"),
    `import { defineStrategy } from "@openstrat/strategy-sdk";

export default defineStrategy({
  strategy_id: "fixture_scalper",
  strategy_version: "0.1.0",
  name: "Fixture scalper",
  runtime: "typescript",
  entrypoint: "src/strategy.ts",
  autonomy_mode: "strategy_workbench",
  allowed_symbols: ["${canonicalSymbol}"],
  parameters: { target_notional_usd: 1000 },
  required_data: [{ kind: "candles", canonical_symbol: "${canonicalSymbol}", interval: "${interval}" }],
  output: "trade_intent",
  created_at: "2026-06-22T00:00:00.000Z",
  source_refs: []
}, (input) => {
  const candles = input.market_events
    .filter((event) => event.kind === "candle")
    .map((event) => event.candle);
  const last = candles.at(-1);
  if (!last) {
    return [];
  }
  const base = {
    created_at: input.now,
    created_by: {
      strategy_id: "fixture_scalper",
      strategy_version: "0.1.0"
    },
    mode: input.mode,
    canonical_symbol: "${canonicalSymbol}",
    target_notional_usd: 1000,
    max_slippage_bps: 10,
    reason_ref: input.decision_ref,
    evidence_refs: [last.raw_ref ?? input.decision_ref],
    risk_policy_ref: input.risk_policy_ref
  };
  if (candles.length === 2) {
    return [{ ...base, id: "fixture_open_" + last.close_time, intent_type: "open_position", side: "long" }];
  }
  if (candles.length === 4) {
    return [{ ...base, id: "fixture_close_" + last.close_time, intent_type: "close_position", side: "sell" }];
  }
  return [];
});
`,
    "utf8"
  );
}

function writeInvalidStrategyFixture(project: string): void {
  mkdirSync(join(project, "src"), { recursive: true });
  writeFileSync(
    join(project, "src", "strategy.ts"),
    `import { defineStrategy } from "@openstrat/strategy-sdk";

export default defineStrategy({
  strategy_id: "invalid_strategy",
  strategy_version: "0.1.0",
  name: "Invalid strategy",
  runtime: "typescript",
  entrypoint: "src/strategy.ts",
  autonomy_mode: "strategy_workbench",
  allowed_symbols: ["SOL-PERP"],
  parameters: {},
  required_data: [],
  output: "trade_intent",
  created_at: "2026-06-22T00:00:00.000Z",
  source_refs: []
}, () => {
  return [{ id: "not-a-trade-intent" }];
});
`,
    "utf8"
  );
}

function renderedTtyFrameHeights(output: string): number[] {
  return output
    .split("\x1b[H\x1b[2J")
    .slice(1)
    .map((frame) => frame.split("openstrat>")[0] ?? "")
    .map((frame) => frame.split(/\r?\n/).filter((line) => line.length > 0).length);
}

class CapturingTtyWritable extends Writable {
  readonly isTTY = true;
  readonly columns: number;
  readonly rows: number;
  output = "";

  constructor(columns: number, rows = 40) {
    super();
    this.columns = columns;
    this.rows = rows;
  }

  _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void
  ): void {
    this.output += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
    callback();
  }
}
