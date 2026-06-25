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
import { PassThrough, Readable, Writable } from "node:stream";
import type { ModelReasoningEffort, ThreadEvent } from "@openai/codex-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { OPENSTRAT_CODEX_BASELINE_CONTRACT } from "@openstrat/domain";
import { AGENT_TOOL_GATEWAY_TOOLS } from "@openstrat/workers";
import { runOpenStratCli } from "./commands.js";
import {
  buildOpenStratCodexConfig,
  buildOpenStratCodexThreadOptions,
  createCodexWorkbenchRuntime,
  type CodexTurnInput,
  type CodexWorkbenchRuntime
} from "./runtime.js";
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
  renderWorkbenchTuiAppend,
  renderWorkbenchTui,
  setTuiThinkingVisible,
  setTuiToolsExpanded
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
    expect(screen).toContain("I need SOL scalping data");
    expect(screen).toContain("Diagnostic warning");
    expect(screen).toContain("MCP startup warning");
    expect(screen).not.toContain("Composer");
    expect(screen).toContain("openstrat>");
    expect(screen).not.toContain("Natural language runs through Codex");
    expect(liveScreen).not.toContain("Composer");
    expect(liveScreen).not.toContain("openstrat>");
    expect(narrowScreen.split("\n").every((line) => line.length <= 50)).toBe(true);
  });

  it("renders the static composer as a Pi-style magenta input box", () => {
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
      commands: ["/help", "/markets"]
    });

    const rendered = renderWorkbenchTui(state, {
      width: 72,
      composerPrompt: "openstrat> ",
      color: true
    });
    const plain = stripAnsi(rendered);

    expect(plain).toContain("openstrat>");
    expect(plain).not.toContain("No messages yet");
    expect(plain).not.toContain("Ask naturally");
    expect(plain).not.toContain("Composer");
    expect(rendered).toContain("\x1b[38;2;236;174;236m+");
    expect(rendered).toContain("\x1b[38;2;236;174;236m|\x1b[0m openstrat> ");
    expect(rendered).not.toContain("+~ Composer");
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
    expect(output.join("\n")).toContain("--live");
    expect(output.join("\n")).not.toContain("--fixture");
    expect(output.join("\n")).toContain("Started new OpenStrat session");
    expect(output.join("\n")).toContain("write src/strategy.ts");
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
    expect(rendered).toContain("OpenStrat /markets ok");
    expect(rendered).toContain("Market Catalog");
    expect(rendered).toContain("selected: SOL-PERP");
    expect(rendered).toContain("/datasets plan --symbol SOL");
    expect(rendered).toContain("Diagnostic error");
    expect(rendered).toContain("Unknown OpenStrat command: /definitely-not-real");
    expect(rendered).toContain("write src/strategy.ts");
    expect(rendered).toContain("Sessions");
    expect(rendered).toContain("Wrote OpenStrat session summary");
    expect(rendered).not.toContain("Composer");
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

  it("uses normal-screen TTY rendering so transcript output remains scrollable", async () => {
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
    expect(rawScreen).not.toContain("\x1b[?1049h");
    expect(rawScreen).not.toContain("\x1b[?1049l");
    expect(rawScreen).not.toContain("\x1b[H\x1b[2J");
    expect(rawScreen).toContain("\x1b[38;2;236;174;236m+");
    expect(rawScreen).toContain("openstrat>");
    expect(rawScreen).toContain("OpenStrat Workbench");
    expect(rawScreen).not.toContain("+- Composer");
    expect(rawScreen).not.toContain("earlier line(s); latest output shown");
    expect(stdout).toContain("bye");
  });

  it("uses an owned live composer that applies backspace before submitting", async () => {
    const fixture = createFixture();
    const stdout: string[] = [];
    const terminal = new CapturingTtyWritable(96, 20);
    const stdin = attachScriptedInput(terminal, ["bad\x7fk", "/exit"]);

    const result = await runOpenStratCli({
      argv: [],
      cwd: fixture.project,
      env: {
        ...fixture.env,
        OPENSTRAT_CODEX_RUNTIME: "fake"
      },
      stdin,
      output: terminal,
      stdout: (line) => stdout.push(line),
      stderr: (line) => stdout.push(line)
    });

    const plain = stripAnsi(terminal.output);
    expect(result.exitCode).toBe(0);
    expect(plain).toContain("bak");
    expect(plain).not.toContain("bad\x7fk");
    expect(stdout).toContain("bye");
  });

  it("lets the owned live composer exit on ctrl-d when empty", async () => {
    const fixture = createFixture();
    const stdout: string[] = [];
    const terminal = new CapturingTtyWritable(96, 20);
    const stdin = attachScriptedInput(terminal, ["\x04"]);

    const result = await runOpenStratCli({
      argv: [],
      cwd: fixture.project,
      env: {
        ...fixture.env,
        OPENSTRAT_CODEX_RUNTIME: "fake"
      },
      stdin,
      output: terminal,
      stdout: (line) => stdout.push(line),
      stderr: (line) => stdout.push(line)
    });

    const plain = stripAnsi(terminal.output);
    expect(result.exitCode).toBe(0);
    expect(plain).toContain("openstrat>");
    expect(plain).not.toContain("working running Codex turn");
    expect(stdout).toContain("bye");
  });

  it("pauses owned composer stdin on exit without requiring EOF", async () => {
    const fixture = createFixture();
    const stdout: string[] = [];
    const terminal = new CapturingTtyWritable(96, 20);
    const stdin = new PausingPassThrough();
    let sent = false;
    terminal.onPrompt = () => {
      if (sent) {
        return;
      }
      sent = true;
      queueMicrotask(() => {
        stdin.write("/exit\n");
      });
    };

    const result = await runOpenStratCli({
      argv: [],
      cwd: fixture.project,
      env: {
        ...fixture.env,
        OPENSTRAT_CODEX_RUNTIME: "fake"
      },
      stdin,
      output: terminal,
      stdout: (line) => stdout.push(line),
      stderr: (line) => stdout.push(line)
    });

    expect(result.exitCode).toBe(0);
    expect(stdin.pauseCount).toBeGreaterThan(0);
    expect(stdout).toContain("bye");
    stdin.destroy();
  });

  it("lets the owned live composer insert text at the cursor", async () => {
    const fixture = createFixture();
    const stdout: string[] = [];
    const terminal = new CapturingTtyWritable(96, 20);
    const stdin = attachScriptedInput(terminal, ["ac\x1b[Db", "/exit"]);

    const result = await runOpenStratCli({
      argv: [],
      cwd: fixture.project,
      env: {
        ...fixture.env,
        OPENSTRAT_CODEX_RUNTIME: "fake"
      },
      stdin,
      output: terminal,
      stdout: (line) => stdout.push(line),
      stderr: (line) => stdout.push(line)
    });

    const plain = stripAnsi(terminal.output);
    expect(result.exitCode).toBe(0);
    expect(plain).toContain("abc");
    expect(plain).not.toContain("[Db");
    expect(stdout).toContain("bye");
  });

  it("lets the owned live composer recall the previous submitted prompt", async () => {
    const fixture = createFixture();
    const stdout: string[] = [];
    const terminal = new CapturingTtyWritable(96, 20);
    const stdin = attachScriptedInput(terminal, ["remember this", "\x1b[A", "/exit"]);

    const result = await runOpenStratCli({
      argv: [],
      cwd: fixture.project,
      env: {
        ...fixture.env,
        OPENSTRAT_CODEX_RUNTIME: "fake"
      },
      stdin,
      output: terminal,
      stdout: (line) => stdout.push(line),
      stderr: (line) => stdout.push(line)
    });

    const plain = stripAnsi(terminal.output);
    expect(result.exitCode).toBe(0);
    expect(plain).not.toContain("[A");
    expect((plain.match(/remember this/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(stdout).toContain("bye");
  });

  it("lets the owned live composer submit a multiline prompt", async () => {
    const fixture = createFixture();
    const stdout: string[] = [];
    const terminal = new CapturingTtyWritable(96, 20);
    const stdin = new PassThrough();
    let promptCount = 0;
    terminal.onPrompt = () => {
      promptCount += 1;
      if (promptCount === 1) {
        queueMicrotask(() => {
          stdin.write("first line\\\nsecond line\n");
        });
        return;
      }
      if (promptCount === 2) {
        queueMicrotask(() => {
          stdin.write("/exit\n");
          stdin.end();
        });
      }
    };
    const runtime = new ScriptedCodexRuntime([
      {
        type: "thread.started",
        thread_id: "scripted_thread"
      },
      {
        type: "turn.started"
      },
      {
        type: "turn.completed",
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          reasoning_output_tokens: 7
        }
      }
    ]);

    const result = await runOpenStratCli({
      argv: [],
      cwd: fixture.project,
      env: fixture.env,
      runtime,
      stdin,
      output: terminal,
      stdout: (line) => stdout.push(line),
      stderr: (line) => stdout.push(line)
    });

    const plain = stripAnsi(terminal.output);
    expect(result.exitCode).toBe(0);
    expect(runtime.turns).toHaveLength(1);
    expect(runtime.turns[0]?.prompt).toBe("first line\nsecond line");
    expect(plain).toContain("first line");
    expect(plain).toContain("second line");
    expect(plain).toContain("|            second line");
    expect(stdout).toContain("bye");
  });

  it("lets tab complete a unique slash-command prefix in the live composer", async () => {
    const fixture = createFixture();
    const stdout: string[] = [];
    const terminal = new CapturingTtyWritable(96, 20);
    const stdin = attachScriptedInput(terminal, ["/mar\tSOL", "/exit"]);

    const result = await runOpenStratCli({
      argv: [],
      cwd: fixture.project,
      env: {
        ...fixture.env,
        OPENSTRAT_CODEX_RUNTIME: "fake"
      },
      stdin,
      output: terminal,
      stdout: (line) => stdout.push(line),
      stderr: (line) => stdout.push(line)
    });

    const plain = stripAnsi(terminal.output);
    expect(result.exitCode).toBe(0);
    expect(plain).toContain("/markets SOL");
    expect(plain).toContain("OpenStrat /markets ok");
    expect(plain).toContain("selected: SOL-PERP");
    expect(plain).not.toContain("/marSOL");
    expect(plain).not.toContain("\t");
    expect(stdout).toContain("bye");
  });

  it("shows slash-command suggestions for ambiguous tab completion", async () => {
    const fixture = createFixture();
    const stdout: string[] = [];
    const terminal = new CapturingTtyWritable(96, 20);
    const stdin = new PassThrough();
    let sent = false;
    terminal.onPrompt = () => {
      if (sent) {
        return;
      }
      sent = true;
      queueMicrotask(() => {
        stdin.write("/s\t\x03");
      });
    };

    const result = await runOpenStratCli({
      argv: [],
      cwd: fixture.project,
      env: {
        ...fixture.env,
        OPENSTRAT_CODEX_RUNTIME: "fake"
      },
      stdin,
      output: terminal,
      stdout: (line) => stdout.push(line),
      stderr: (line) => stdout.push(line)
    });

    const plain = stripAnsi(terminal.output);
    expect(result.exitCode).toBe(0);
    expect(plain).toContain("matches: /status /strategy /sessions");
    expect(plain).not.toContain("OpenStrat /s");
    expect(plain).not.toContain("\t");
    expect(stdout).toContain("bye");
    stdin.destroy();
  });

  it("lets arrow keys select and tab accept slash-command suggestions", async () => {
    const fixture = createFixture();
    const stdout: string[] = [];
    const terminal = new CapturingTtyWritable(96, 20);
    const stdin = attachScriptedInput(terminal, ["/s\t\x1b[B\t", "/exit"]);

    const result = await runOpenStratCli({
      argv: [],
      cwd: fixture.project,
      env: {
        ...fixture.env,
        OPENSTRAT_CODEX_RUNTIME: "fake"
      },
      stdin,
      output: terminal,
      stdout: (line) => stdout.push(line),
      stderr: (line) => stdout.push(line)
    });

    const plain = stripAnsi(terminal.output);
    expect(result.exitCode).toBe(0);
    expect(plain).toContain("› /strategy");
    expect(terminal.output).toContain("\x1b[38;2;236;174;236m› /strategy");
    expect(plain).toContain("| openstrat> /strategy ");
    expect(plain).toContain("OpenStrat /strategy ok");
    expect(plain).not.toContain("OpenStrat /s error");
    expect(plain).not.toContain("Unknown OpenStrat command: /s");
    expect(plain).not.toContain("\t");
    expect(stdout).toContain("bye");
  });

  it("keeps live TTY chat in flow after opening a workbench command view", async () => {
    const fixture = createFixture();
    const stdout: string[] = [];
    const terminal = new CapturingTtyWritable(96, 20);
    const stdin = attachScriptedInput(terminal, [
      "/markets SOL",
      "write a SOL strategy after opening the market panel",
      "/exit"
    ]);

    const result = await runOpenStratCli({
      argv: [],
      cwd: fixture.project,
      env: {
        ...fixture.env,
        OPENSTRAT_CODEX_RUNTIME: "fake"
      },
      stdin,
      output: terminal,
      stdout: (line) => stdout.push(line),
      stderr: (line) => stdout.push(line)
    });

    const rawScreen = terminal.output;
    expect(result.exitCode).toBe(0);
    expect(rawScreen).not.toContain("\x1b[?1049h");
    expect(rawScreen).not.toContain("+- Chat ");
    expect(rawScreen).not.toContain("+- Workbench View ");
    expect(rawScreen).not.toContain("earlier chat line(s)");
    expect(rawScreen).toContain("OpenStrat /markets ok");
    expect(rawScreen).toContain("Market Catalog");
    expect(rawScreen).toContain("write a SOL strategy after opening the market panel");
    expect(rawScreen).toContain("Fake Codex completed the turn.");
    expect(rawScreen.indexOf("OpenStrat /markets ok")).toBeLessThan(
      rawScreen.indexOf("Market Catalog")
    );
    expect(rawScreen.indexOf("Market Catalog")).toBeLessThan(
      rawScreen.indexOf("write a SOL strategy")
    );
    expect((rawScreen.match(/OpenStrat Workbench/g) ?? []).length).toBe(1);
    expect(stdout).toContain("bye");
  });

  it("projects live Codex progress as typed TUI states without misleading codex prefixes", async () => {
    const fixture = createFixture();
    const stdout: string[] = [];
    const terminal = new CapturingTtyWritable(100, 24);
    const stdin = attachScriptedInput(terminal, [
      "write a SOL strategy with the selected market",
      "/exit"
    ]);

    const result = await runOpenStratCli({
      argv: [],
      cwd: fixture.project,
      env: {
        ...fixture.env,
        OPENSTRAT_CODEX_RUNTIME: "fake"
      },
      stdin,
      output: terminal,
      stdout: (line) => stdout.push(line),
      stderr: (line) => stdout.push(line)
    });

    const rawScreen = terminal.output;
    const plain = stripAnsi(rawScreen);
    expect(result.exitCode).toBe(0);
    expect(rawScreen).toContain("\x1b[38;2;236;174;236mWorking...");
    expect(rawScreen).toContain("\x1b[38;2;150;150;150mrunning Codex turn");
    expect(rawScreen).toContain("\x1b[48;2;40;50;40m");
    expect(plain).toContain("Working... running Codex turn");
    expect(plain).toContain("write src/strategy.ts");
    expect(plain).toContain("Fake Codex completed the turn.");
    expect(plain).toContain("↑1");
    expect(plain).toContain("↓1");
    expect(plain).toContain("fake_codex • auto");
    expect(plain).not.toContain("codex: working");
    expect(plain).not.toContain("codex: codex");
    expect(plain).not.toContain("Codex: Fake Codex completed the turn.");
    expect(stdout).toContain("bye");
  });

  it("continues appending live TTY turns after the retained transcript cap", async () => {
    const fixture = createFixture();
    const stdout: string[] = [];
    const terminal = new CapturingTtyWritable(96, 20);
    const finalPrompt = "turn 22 after retained entry cap";
    const stdin = attachScriptedInput(terminal, [
      ...Array.from({ length: 21 }, (_, index) => `turn ${index + 1}`),
      finalPrompt,
      "/exit"
    ]);

    const result = await runOpenStratCli({
      argv: [],
      cwd: fixture.project,
      env: {
        ...fixture.env,
        OPENSTRAT_CODEX_RUNTIME: "fake"
      },
      stdin,
      output: terminal,
      stdout: (line) => stdout.push(line),
      stderr: (line) => stdout.push(line)
    });

    const rawScreen = terminal.output;
    expect(result.exitCode).toBe(0);
    expect(rawScreen).toContain(finalPrompt);
    expect(rawScreen).toContain("Fake Codex completed the turn.");
    expect(rawScreen).not.toContain("\x1b[?1049h");
    expect((rawScreen.match(/OpenStrat Workbench/g) ?? []).length).toBe(1);
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
        "Hyperliquid perps",
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

  it("keeps chat turns readable when command output is active", () => {
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
          kind: "user",
          title: "You",
          body: "first user turn should stay visible"
        },
        {
          kind: "assistant",
          title: "Codex",
          body: "first assistant response should stay visible"
        },
        {
          kind: "command",
          title: "/markets ok",
          body: "Hyperliquid perps\nnext: choose SOL"
        },
        {
          kind: "user",
          title: "You",
          body: "latest user turn should also stay visible"
        }
      ],
      activeView: [
        "Market Catalog",
        "Hyperliquid perps",
        ...Array.from({ length: 40 }, (_, index) => {
          return `${index + 1}. MARKET-${index + 1}-PERP active liquidity=1.00`;
        })
      ].join("\n")
    });

    const rendered = renderWorkbenchTui(state, {
      width: 92,
      showComposer: false,
      height: 30
    });

    expect(rendered.split("\n").length).toBeLessThanOrEqual(30);
    expect(rendered).not.toContain("+- Chat ");
    expect(rendered).not.toContain("+- Workbench View ");
    expect(rendered.indexOf("first user turn should stay visible")).toBeLessThan(
      rendered.indexOf("OpenStrat /markets ok")
    );
    expect(rendered.indexOf("OpenStrat /markets ok")).toBeLessThan(
      rendered.indexOf("Market Catalog")
    );
    expect(rendered).toContain("first user turn should stay visible");
    expect(rendered).toContain("first assistant response should stay visible");
    expect(rendered).toContain("Hyperliquid perps");
    expect(rendered).toContain("latest user turn should also stay visible");
    expect(rendered).toContain("... ");
  });

  it("renders workbench output inline in the chat flow instead of boxing previous chat", () => {
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
          kind: "user",
          title: "You",
          body: "first user turn should stay in the main flow"
        },
        {
          kind: "assistant",
          title: "Codex",
          body: "first assistant response should stay in the main flow"
        },
        {
          kind: "command",
          title: "/markets ok",
          body: "Hyperliquid perps\nnext: choose SOL"
        }
      ],
      activeView: [
        "Market Catalog",
        "Hyperliquid perps",
        ...Array.from({ length: 18 }, (_, index) => {
          return `${index + 1}. MARKET-${index + 1}-PERP active liquidity=1.00`;
        })
      ].join("\n")
    });

    const rendered = renderWorkbenchTui(state, {
      width: 92,
      showComposer: false,
      height: 30
    });

    expect(rendered).not.toContain("+- Chat ");
    expect(rendered).not.toContain("earlier chat line(s)");
    expect(
      rendered.indexOf("first user turn should stay in the main flow")
    ).toBeLessThan(
      rendered.indexOf("first assistant response should stay in the main flow")
    );
    expect(
      rendered.indexOf("first assistant response should stay in the main flow")
    ).toBeLessThan(rendered.indexOf("OpenStrat /markets ok"));
    expect(rendered.indexOf("OpenStrat /markets ok")).toBeLessThan(
      rendered.indexOf("Market Catalog")
    );
    expect(rendered).toContain("first user turn should stay in the main flow");
    expect(rendered).toContain("first assistant response should stay in the main flow");
  });

  it("renders active workbench views as titled typed blocks", () => {
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
          body: "Hyperliquid perps\nnext: choose SOL"
        }
      ],
      activeView: [
        "Market Catalog",
        "Hyperliquid perps",
        ...Array.from({ length: 18 }, (_, index) => {
          return `${index + 1}. MARKET-${index + 1}-PERP active liquidity=1.00`;
        })
      ].join("\n")
    });

    const rendered = renderWorkbenchTui(state, {
      width: 92,
      showComposer: false,
      color: true
    });
    const plain = stripAnsi(rendered);

    expect(plain).toContain("OpenStrat /markets ok");
    expect(plain).toContain("Market Catalog");
    expect(plain).toContain("Hyperliquid perps");
    expect(plain).toContain("ctrl+o to expand");
    expect(rendered).toContain(
      "\x1b[48;2;40;50;40m\x1b[1m\x1b[38;2;212;212;212mMarket Catalog"
    );
    expect(rendered).not.toContain(
      "\x1b[48;2;40;50;40m\x1b[38;2;128;128;128m  Hyperliquid perps"
    );
    expect(rendered).toContain(
      "\x1b[48;2;40;50;40m\x1b[38;2;212;212;212m  Hyperliquid perps"
    );
    expect(rendered).not.toContain(
      "\x1b[48;2;40;50;40m\x1b[38;2;212;212;212m  Market Catalog"
    );
  });

  it("renders slash command results as typed workbench blocks", () => {
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
          body: "Hyperliquid perps\nnext: choose SOL"
        }
      ]
    });

    const rendered = renderWorkbenchTui(state, {
      width: 92,
      showComposer: false,
      color: true
    });
    const plain = stripAnsi(rendered);

    expect(plain).toContain("OpenStrat /markets ok");
    expect(plain).toContain("Hyperliquid perps");
    expect(rendered).toContain(
      "\x1b[48;2;40;50;40m\x1b[1m\x1b[38;2;212;212;212mOpenStrat /markets ok"
    );
    expect(rendered).toContain(
      "\x1b[48;2;40;50;40m\x1b[38;2;212;212;212m  Hyperliquid perps"
    );
    expect(rendered).not.toContain("\nOpenStrat /markets ok\n");
  });

  it("renders unavailable and error slash command statuses with non-success tones", () => {
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
      commands: ["/help", "/markets", "/ready"],
      entries: [
        {
          kind: "command",
          title: "/ready unavailable",
          body: "local strategy ready: no"
        },
        {
          kind: "command",
          title: "/definitely-not-real error",
          body: "Unknown OpenStrat command: /definitely-not-real"
        }
      ]
    });

    const rendered = renderWorkbenchTui(state, {
      width: 92,
      showComposer: false,
      color: true
    });
    const plain = stripAnsi(rendered);

    expect(plain).toContain("OpenStrat /ready unavailable");
    expect(plain).toContain("OpenStrat /definitely-not-real error");
    expect(rendered).toContain(
      "\x1b[48;2;40;40;50m\x1b[1m\x1b[38;2;212;212;212mOpenStrat /ready unavailable"
    );
    expect(rendered).toContain(
      "\x1b[48;2;60;40;40m\x1b[1m\x1b[38;2;212;212;212mOpenStrat /definitely-not-real error"
    );
  });

  it("renders Pi-style typed transcript states with distinct visual treatments", () => {
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
          kind: "user",
          title: "You",
          body: "testing text output and rendering behaviour"
        },
        {
          kind: "thinking",
          title: "Thinking",
          body: "The user is testing text output; respond briefly."
        },
        {
          kind: "working",
          title: "Working",
          body: "running strategy workspace checks"
        },
        {
          kind: "tool_call",
          title: "read ~/Lab/openstrat/packages/cli/src/workbench-tui.ts",
          body: "packages/cli/src/workbench-tui.ts"
        },
        {
          kind: "tool_result",
          title: "$ pnpm test",
          body: Array.from({ length: 18 }, (_, index) => {
            return `line ${index + 1}: test output`;
          }).join("\n")
        },
        {
          kind: "assistant",
          title: "Codex",
          body: "Text output and rendering work on this end."
        },
        {
          kind: "tool_error",
          title: "$ pnpm lint",
          body: "lint failed"
        }
      ]
    });

    const rendered = renderWorkbenchTui(state, {
      width: 100,
      showComposer: true,
      color: true
    });
    const plain = stripAnsi(rendered);

    expect(rendered).toContain("\x1b[48;2;52;53;65m");
    expect(rendered.split("\x1b[48;2;52;53;65m").length - 1).toBeGreaterThanOrEqual(3);
    expect(rendered).toContain("\x1b[38;2;236;174;236m");
    expect(rendered).toContain("\x1b[3m");
    expect(rendered).toContain("\x1b[38;2;0;215;255m");
    expect(rendered).toContain("\x1b[48;2;40;50;40m");
    expect(rendered.split("\x1b[48;2;40;40;50m").length - 1).toBeGreaterThanOrEqual(3);
    expect(rendered).toContain("\x1b[48;2;60;40;40m");
    expect(rendered).toContain(
      "\x1b[48;2;40;50;40m\x1b[1m\x1b[38;2;212;212;212m  $ pnpm test"
    );
    expect(rendered).toContain("\x1b[48;2;40;50;40m\x1b[38;2;212;212;212m  Completed");
    expect(rendered).toContain(
      "\x1b[48;2;60;40;40m\x1b[1m\x1b[38;2;212;212;212m  $ pnpm lint"
    );
    expect(rendered).toContain(
      "\x1b[48;2;60;40;40m\x1b[38;2;212;212;212m    lint failed"
    );
    expect(plain).toContain("testing text output and rendering behaviour");
    expect(plain).toContain("The user is testing text output; respond briefly.");
    expect(plain).toContain("Working... running strategy workspace checks");
    expect(plain).not.toContain("working running strategy workspace checks");
    expect(plain).toContain("read ~/Lab/openstrat/packages/cli/src/workbench-tui.ts");
    expect(plain).not.toContain("\n  packages/cli/src/workbench-tui.ts");
    expect(plain).toContain("$ pnpm test");
    expect(plain).toContain("... (");
    expect(plain).toContain("ctrl+o to expand");
    expect(plain).toContain("Text output and rendering work on this end.");
    expect(plain).toContain("$ pnpm lint");
    expect(plain).toContain("lint failed");
    expect(plain).toContain("openstrat>");
    expect(plain).not.toContain("codex: codex");
  });

  it("renders assistant final text with terminal markdown structure", () => {
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
      commands: ["/help", "/markets"],
      entries: [
        {
          kind: "assistant",
          title: "Codex",
          body: [
            "# Strategy note",
            "",
            "- keep risk bounded",
            "- validate fills",
            "",
            "Use `max_slippage_bps` before deploy.",
            "",
            "```ts",
            "const risk = 0.01;",
            "```"
          ].join("\n")
        }
      ]
    });

    const rendered = renderWorkbenchTui(state, {
      width: 92,
      showComposer: false,
      color: true
    });
    const plain = stripAnsi(rendered);

    expect(plain).toContain("\n Strategy note\n");
    expect(plain).not.toContain("\nStrategy note\n");
    expect(plain).not.toContain("# Strategy note");
    expect(plain).toContain("   - keep risk bounded");
    expect(plain).toContain("   - validate fills");
    expect(plain).toContain(
      "   - validate fills\n\n Use max_slippage_bps before deploy."
    );
    expect(plain).toContain(" Use max_slippage_bps before deploy.");
    expect(plain).toContain(" Use max_slippage_bps before deploy.\n\n     const risk");
    expect(plain).toContain("     const risk = 0.01;");
    expect(plain).not.toContain("```");
    expect(rendered).toContain("\x1b[38;2;0;215;255m");
  });

  it("toggles clipped tool output between Pi-style collapsed and expanded states", () => {
    const fixture = createFixture();
    const home = resolveOpenStratCliHome({ cwd: fixture.project, env: fixture.env });
    const session = createWorkbenchSession(home, fixture.project);
    const snapshot = buildWorkbenchSnapshot({
      home,
      cwd: fixture.project,
      env: fixture.env,
      session
    });
    const longOutput = Array.from({ length: 16 }, (_, index) => {
      return `line ${index + 1}: tool output`;
    }).join("\n");
    const collapsedState = createWorkbenchTuiState({
      runtimeKind: "fake_codex",
      snapshot,
      commands: ["/help", "/markets"],
      entries: [
        {
          kind: "tool_result",
          title: "$ pnpm test",
          body: longOutput
        }
      ]
    });

    const collapsed = stripAnsi(
      renderWorkbenchTui(collapsedState, {
        width: 92,
        showComposer: false,
        color: true
      })
    );
    const expanded = stripAnsi(
      renderWorkbenchTui(setTuiToolsExpanded(collapsedState, true), {
        width: 92,
        showComposer: false,
        color: true
      })
    );

    expect(collapsed).toContain("Completed");
    expect(collapsed).toContain("ctrl+o to expand");
    expect(collapsed).not.toContain("line 10: tool output");
    expect(collapsed).not.toContain("line 16: tool output");
    expect(expanded).toContain("line 16: tool output");
    expect(expanded).toContain("ctrl+o to collapse");
    expect(expanded).not.toContain("ctrl+o to expand");
  });

  it("renders tool output as readable stdout stderr and body sections", () => {
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
      commands: ["/help", "/markets"],
      entries: [
        {
          kind: "tool_result",
          title: "$ pnpm test",
          body: [
            "RUN packages/cli/src/commands.test.ts",
            "28 passed",
            "stderr: deprecated flag",
            "body: structured result accepted",
            "status: completed",
            "exit: 0"
          ].join("\n")
        }
      ]
    });

    const rendered = renderWorkbenchTui(setTuiToolsExpanded(state, true), {
      width: 92,
      showComposer: false,
      color: true
    });
    const plain = stripAnsi(rendered);

    expect(plain).toContain("$ pnpm test");
    expect(plain).toContain("stdout");
    expect(plain).toContain("  RUN packages/cli/src/commands.test.ts");
    expect(plain).toContain("  28 passed");
    expect(plain).toContain("stderr");
    expect(plain).toContain("  deprecated flag");
    expect(plain).toContain("body");
    expect(plain).toContain("  structured result accepted");
    expect(plain).not.toContain("status completed");
    expect(plain).not.toContain("exit 0");
    expect(plain).not.toContain("stderr: deprecated flag");
    expect(plain).not.toContain("body: structured result accepted");
  });

  it("renders collapsed shell command results as a clean Pi-style action row", () => {
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
      commands: ["/help", "/markets"],
      entries: [
        {
          kind: "tool_result",
          title: "$ pnpm test",
          body: "RUN packages/cli/src/commands.test.ts\n28 passed\nstatus: completed\nexit: 0"
        }
      ]
    });

    const rendered = renderWorkbenchTui(state, {
      width: 72,
      showComposer: false,
      color: true
    });
    const plain = stripAnsi(rendered);
    expect(rendered).toContain("\x1b[48;2;40;50;40m");
    expect(rendered).toContain("\x1b[1m\x1b[38;2;212;212;212m  $ pnpm test");
    expect(plain).toContain("$ pnpm test");
    expect(plain).toContain("Completed");
    expect(plain).toContain("ctrl+o to expand");
    expect(plain).not.toContain("RUN packages/cli/src/commands.test.ts");
    expect(plain).not.toContain("status completed");
    expect(plain).not.toContain("exit 0");
  });

  it("renders pending shell commands with a Pi-style running row", () => {
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
      commands: ["/help", "/markets"],
      entries: [
        {
          kind: "tool_call",
          title: "$ pnpm test",
          body: "status: in_progress"
        }
      ]
    });

    const rendered = renderWorkbenchTui(state, {
      width: 72,
      showComposer: false,
      color: true
    });
    const plain = stripAnsi(rendered);

    expect(plain).toContain("$ pnpm test");
    expect(plain).toContain("Running...");
    expect(plain).not.toContain("status in_progress");
    expect(rendered).toContain("\x1b[48;2;40;40;50m");
    expect(rendered).toContain("\x1b[1m\x1b[38;2;212;212;212m  $ pnpm test");
    expect(rendered).toContain("\x1b[38;2;212;212;212m  Running...");
  });

  it("toggles thinking traces between visible content and a Pi-style hidden label", () => {
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
      commands: ["/help", "/markets"],
      entries: [
        {
          kind: "thinking",
          title: "Thinking",
          body: "I should inspect the local strategy files before responding."
        }
      ]
    });

    const visible = stripAnsi(
      renderWorkbenchTui(state, {
        width: 92,
        showComposer: false,
        color: true
      })
    );
    const hiddenRendered = renderWorkbenchTui(setTuiThinkingVisible(state, false), {
      width: 92,
      showComposer: false,
      color: true
    });
    const hidden = stripAnsi(hiddenRendered);

    expect(visible).toContain(
      "I should inspect the local strategy files before responding."
    );
    expect(hidden).toContain("Thinking...");
    expect(hidden).not.toContain(
      "I should inspect the local strategy files before responding."
    );
    expect(hiddenRendered).toContain("\x1b[3m");
  });

  it("coalesces tool lifecycle entries with the same display id", () => {
    const fixture = createFixture();
    const home = resolveOpenStratCliHome({ cwd: fixture.project, env: fixture.env });
    const session = createWorkbenchSession(home, fixture.project);
    const snapshot = buildWorkbenchSnapshot({
      home,
      cwd: fixture.project,
      env: fixture.env,
      session
    });
    const pendingEntry = {
      id: "cmd_1",
      kind: "tool_call",
      title: "$ pnpm test",
      body: "status: in_progress"
    } as unknown as Parameters<typeof recordTuiEntry>[1];
    const completedEntry = {
      id: "cmd_1",
      kind: "tool_result",
      title: "$ pnpm test",
      body: "RUN packages/cli/src/commands.test.ts\n28 passed\nstatus: completed\nexit: 0"
    } as unknown as Parameters<typeof recordTuiEntry>[1];
    let state = createWorkbenchTuiState({
      runtimeKind: "fake_codex",
      snapshot,
      commands: ["/help", "/markets", "/datasets", "/sessions"]
    });

    state = recordTuiEntry(state, pendingEntry);
    state = recordTuiEntry(state, completedEntry);

    const rendered = renderWorkbenchTui(state, {
      width: 100,
      showComposer: false,
      color: true
    });
    const plain = stripAnsi(rendered);

    expect((plain.match(/\$ pnpm test/g) ?? []).length).toBe(1);
    expect(plain).not.toContain("status: in_progress");
    expect(plain).not.toContain("28 passed");
    expect(plain).toContain("Completed");
    expect(rendered).toContain("\x1b[48;2;40;50;40m");
  });

  it("restates tool action titles in appended update rows", () => {
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
      runtimeKind: "codex_sdk",
      snapshot,
      commands: ["/help", "/markets", "/datasets", "/sessions"]
    });

    const rendered = renderWorkbenchTuiAppend(state, {
      width: 100,
      color: true,
      updatedEntry: {
        id: "mcp_read_1",
        kind: "tool_result",
        title: "read SOL-PERP",
        body: 'body: {"status":"completed","message":"market loaded"}\nstatus: completed'
      }
    });
    const plain = stripAnsi(rendered);

    expect(plain).toContain("read SOL-PERP");
    expect(plain).toContain("market loaded");
    expect(plain).not.toContain("status completed");
    expect(plain).not.toContain('{"status":"completed"');
    expect(plain).not.toContain("\ncompleted");
  });

  it("renders Codex-style footer usage, context, model, and thinking state when available", () => {
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
      runtimeKind: "codex_sdk",
      snapshot,
      commands: ["/help", "/markets"],
      footer: {
        model: "gpt-5.1-codex",
        thinking: "high",
        inputTokens: 93000,
        outputTokens: 3400,
        reasoningTokens: 16000,
        cacheHitPercent: 6.6,
        contextPercent: 3,
        contextWindow: 1000000,
        costUsd: 0.01,
        autoCompact: true
      }
    });

    const rendered = renderWorkbenchTui(state, {
      width: 110,
      showComposer: false
    });

    expect(rendered).toContain("↑93k");
    expect(rendered).toContain("↓3.4k");
    expect(rendered).toContain("R16k");
    expect(rendered).toContain("CH6.6%");
    expect(rendered).toContain("$0.010");
    expect(rendered).toContain("3.0%/1.0M (auto)");
    expect(rendered).toContain("gpt-5.1-codex • high");
    expect(rendered).toContain("codex_sdk");
    expect(rendered).toContain("auth missing");
  });

  it("colors high footer context usage like Pi status thresholds", () => {
    const fixture = createFixture();
    const home = resolveOpenStratCliHome({ cwd: fixture.project, env: fixture.env });
    const session = createWorkbenchSession(home, fixture.project);
    const snapshot = buildWorkbenchSnapshot({
      home,
      cwd: fixture.project,
      env: fixture.env,
      session
    });
    const warningState = createWorkbenchTuiState({
      runtimeKind: "codex_sdk",
      snapshot,
      commands: ["/help", "/markets"],
      footer: {
        model: "gpt-5.1-codex",
        thinking: "high",
        contextPercent: 75,
        contextWindow: 1000000,
        autoCompact: true
      }
    });
    const errorState = createWorkbenchTuiState({
      runtimeKind: "codex_sdk",
      snapshot,
      commands: ["/help", "/markets"],
      footer: {
        model: "gpt-5.1-codex",
        thinking: "high",
        contextPercent: 92,
        contextWindow: 1000000,
        autoCompact: true
      }
    });

    const warningRendered = renderWorkbenchTui(warningState, {
      width: 110,
      showComposer: false,
      color: true
    });
    const errorRendered = renderWorkbenchTui(errorState, {
      width: 110,
      showComposer: false,
      color: true
    });

    expect(stripAnsi(warningRendered)).toContain("75.0%/1.0M (auto)");
    expect(warningRendered).toContain("\x1b[38;2;255;255;0m75.0%/1.0M (auto)");
    expect(stripAnsi(errorRendered)).toContain("92.0%/1.0M (auto)");
    expect(errorRendered).toContain("\x1b[38;2;204;102;102m92.0%/1.0M (auto)");
  });

  it("uses env-selected Codex model, thinking effort, and context window metadata", () => {
    const fixture = createFixture();
    const runtime = createCodexWorkbenchRuntime({
      ...fixture.env,
      OPENSTRAT_CODEX_MODEL: "gpt-5.1-codex",
      OPENSTRAT_CODEX_THINKING: "high",
      OPENSTRAT_CODEX_CONTEXT_WINDOW: "1000000"
    });

    expect(runtime.kind).toBe("codex_sdk");
    expect(runtime.displayModel).toBe("gpt-5.1-codex");
    expect(runtime.thinking).toBe("high");
    expect(runtime.contextWindow).toBe(1000000);
  });

  it("uses env-selected Codex model cycle candidates when provided", () => {
    const fixture = createFixture();
    const runtime = createCodexWorkbenchRuntime({
      ...fixture.env,
      OPENSTRAT_CODEX_MODEL: "gpt-5.1-codex",
      OPENSTRAT_CODEX_MODELS: "gpt-5.1-codex, gpt-5.1-codex-high"
    });

    expect(runtime.displayModel).toBe("gpt-5.1-codex");
    expect(runtime.availableModels).toEqual(["gpt-5.1-codex", "gpt-5.1-codex-high"]);
  });

  it("approves the embedded OpenStrat MCP server for non-interactive Codex SDK turns", () => {
    const fixture = createFixture();
    const home = resolveOpenStratCliHome({ cwd: fixture.project, env: fixture.env });
    const config = buildOpenStratCodexConfig({
      home,
      cliEntrypoint: "/tmp/openstrat"
    });
    const mcpServers = config.mcp_servers as Record<string, Record<string, unknown>>;
    const openstrat = mcpServers.openstrat;

    expect(openstrat?.command).toBe(process.execPath);
    expect(openstrat?.args).toEqual(["/tmp/openstrat", "mcp"]);
    expect(openstrat?.enabled).toBe(true);
    expect(openstrat?.required).toBe(false);
    expect(openstrat?.default_tools_approval_mode).toBe("approve");
    expect(openstrat?.startup_timeout_sec).toBe(10);
    expect(openstrat?.tool_timeout_sec).toBe(300);
  });

  it("runs embedded Codex SDK turns without an interactive approval prompt", () => {
    const fixture = createFixture();
    const options = buildOpenStratCodexThreadOptions({
      cwd: fixture.project,
      runtimeKind: "codex_sdk",
      selectedModel: "gpt-5.1-codex",
      selectedThinking: "high"
    });

    expect(options.workingDirectory).toBe(fixture.project);
    expect(options.skipGitRepoCheck).toBe(true);
    expect(options.sandboxMode).toBe("workspace-write");
    expect(options.approvalPolicy).toBe("never");
    expect(options.model).toBe("gpt-5.1-codex");
    expect(options.modelReasoningEffort).toBe("high");
  });

  it("renders live SDK reasoning and tool lifecycle events as Pi-style typed states", async () => {
    const fixture = createFixture();
    const stdout: string[] = [];
    const terminal = new CapturingTtyWritable(110, 28);
    const stdin = attachScriptedInput(terminal, [
      "inspect the strategy workspace",
      "/exit"
    ]);
    const runtime = new ScriptedCodexRuntime([
      {
        type: "thread.started",
        thread_id: "scripted_thread"
      },
      {
        type: "turn.started"
      },
      {
        type: "item.completed",
        item: {
          id: "reasoning_1",
          type: "reasoning",
          text: "I should inspect the local strategy files before responding."
        }
      },
      {
        type: "item.started",
        item: {
          id: "cmd_1",
          type: "command_execution",
          command: "pnpm test",
          aggregated_output: "",
          status: "in_progress"
        }
      },
      {
        type: "item.updated",
        item: {
          id: "cmd_1",
          type: "command_execution",
          command: "pnpm test",
          aggregated_output: "RUN packages/cli/src/commands.test.ts",
          status: "in_progress"
        }
      },
      {
        type: "item.completed",
        item: {
          id: "cmd_1",
          type: "command_execution",
          command: "pnpm test",
          aggregated_output: "RUN packages/cli/src/commands.test.ts\n28 passed",
          exit_code: 0,
          status: "completed"
        }
      },
      {
        type: "item.completed",
        item: {
          id: "tool_1",
          type: "mcp_tool_call",
          server: "openstrat",
          tool: "read_market",
          arguments: { symbol: "SOL-PERP" },
          error: { message: "market is not loaded" },
          status: "failed"
        }
      },
      {
        type: "turn.completed",
        usage: {
          input_tokens: 100,
          cached_input_tokens: 25,
          output_tokens: 20,
          reasoning_output_tokens: 7
        }
      }
    ]);

    const result = await runOpenStratCli({
      argv: [],
      cwd: fixture.project,
      env: fixture.env,
      runtime,
      stdin,
      output: terminal,
      stdout: (line) => stdout.push(line),
      stderr: (line) => stdout.push(line)
    });

    const rawScreen = terminal.output;
    const plain = stripAnsi(rawScreen);
    expect(result.exitCode).toBe(0);
    expect(rawScreen).toContain("\x1b[3m");
    expect(rawScreen).toContain("\x1b[48;2;40;40;50m");
    expect(rawScreen).toContain("\x1b[48;2;40;50;40m");
    expect(rawScreen).toContain("\x1b[48;2;60;40;40m");
    expect(plain).toContain(
      "I should inspect the local strategy files before responding."
    );
    expect(plain).toContain("$ pnpm test");
    expect((plain.match(/\$ pnpm test/g) ?? []).length).toBe(2);
    expect(plain).not.toContain("RUN packages/cli/src/commands.test.ts");
    expect(plain).not.toContain("28 passed");
    expect(plain).toContain("Completed");
    expect(plain).toContain("read SOL-PERP");
    expect(plain).toContain("market is not loaded");
    expect(plain).toContain("scripted-final-response");
    expect(plain).toContain("↑100");
    expect(plain).toContain("↓20");
    expect(plain).toContain("R7");
    expect(plain).toContain("CH25.0%");
    expect(plain).toContain("gpt-scripted • high");
    expect(plain).not.toContain("codex: codex");
    expect(stdout).toContain("bye");
  });

  it("renders MCP tool calls as Pi-style action rows when a target is clear", async () => {
    const fixture = createFixture();
    const stdout: string[] = [];
    const terminal = new CapturingTtyWritable(110, 36);
    const stdin = attachScriptedInput(terminal, ["inspect openstrat tools", "/exit"]);
    const runtime = new ScriptedCodexRuntime([
      {
        type: "turn.started"
      },
      {
        type: "item.started",
        item: {
          id: "mcp_read_1",
          type: "mcp_tool_call",
          server: "openstrat",
          tool: "market_data_read_snapshot",
          arguments: { canonical_symbol: "SOL-PERP" },
          status: "in_progress"
        }
      },
      {
        type: "item.completed",
        item: {
          id: "mcp_read_1",
          type: "mcp_tool_call",
          server: "openstrat",
          tool: "market_data_read_snapshot",
          arguments: { canonical_symbol: "SOL-PERP" },
          result: {
            content: [],
            structured_content: { status: "completed", message: "market loaded" }
          },
          status: "completed"
        }
      },
      {
        type: "item.completed",
        item: {
          id: "mcp_check_1",
          type: "mcp_tool_call",
          server: "openstrat",
          tool: "strategy_validate",
          arguments: { strategy_file: "src/strategy.ts" },
          error: { message: "missing dataset evidence" },
          status: "failed"
        }
      },
      {
        type: "turn.completed",
        usage: {
          input_tokens: 42,
          cached_input_tokens: 0,
          output_tokens: 9,
          reasoning_output_tokens: 0
        }
      }
    ]);

    const result = await runOpenStratCli({
      argv: [],
      cwd: fixture.project,
      env: fixture.env,
      runtime,
      stdin,
      output: terminal,
      stdout: (line) => stdout.push(line),
      stderr: (line) => stdout.push(line)
    });

    const plain = stripAnsi(terminal.output);
    expect(result.exitCode).toBe(0);
    expect(plain).toContain("read SOL-PERP");
    expect(plain).toContain("check src/strategy.ts");
    expect(plain).toContain("market loaded");
    expect(plain).toContain("stderr");
    expect(plain).toContain("missing dataset evidence");
    expect(plain).toContain("Running...");
    expect(plain).not.toContain("status completed");
    expect(plain).not.toContain("status failed");
    expect(plain).not.toContain("canonical_symbol");
    expect(plain).not.toContain("strategy_file");
    expect(plain).not.toContain("openstrat.market_data_read_snapshot");
    expect(plain).not.toContain("openstrat.strategy_validate");
    expect(stdout).toContain("bye");
  });

  it("renders SDK file changes as Pi-style write edit and delete rows", async () => {
    const fixture = createFixture();
    const stdout: string[] = [];
    const terminal = new CapturingTtyWritable(110, 36);
    const stdin = attachScriptedInput(terminal, ["apply file changes", "/exit"]);
    const runtime = new ScriptedCodexRuntime([
      {
        type: "turn.started"
      },
      {
        type: "item.completed",
        item: {
          id: "file_add_1",
          type: "file_change",
          status: "completed",
          changes: [{ path: "src/strategy.ts", kind: "add" }]
        }
      },
      {
        type: "item.completed",
        item: {
          id: "file_update_1",
          type: "file_change",
          status: "completed",
          changes: [{ path: "src/risk.ts", kind: "update" }]
        }
      },
      {
        type: "item.completed",
        item: {
          id: "file_delete_1",
          type: "file_change",
          status: "failed",
          changes: [{ path: "src/obsolete.ts", kind: "delete" }]
        }
      },
      {
        type: "turn.completed",
        usage: {
          input_tokens: 10,
          cached_input_tokens: 0,
          output_tokens: 4,
          reasoning_output_tokens: 0
        }
      }
    ]);

    const result = await runOpenStratCli({
      argv: [],
      cwd: fixture.project,
      env: fixture.env,
      runtime,
      stdin,
      output: terminal,
      stdout: (line) => stdout.push(line),
      stderr: (line) => stdout.push(line)
    });

    const plain = stripAnsi(terminal.output);
    expect(result.exitCode).toBe(0);
    expect(plain).toContain("write src/strategy.ts");
    expect(plain).toContain("edit src/risk.ts");
    expect(plain).toContain("delete src/obsolete.ts");
    expect(plain).not.toContain("status completed");
    expect(plain).not.toContain("status failed");
    expect(plain).not.toContain("file_change completed");
    expect(plain).not.toContain("file_change failed");
    expect(stdout).toContain("bye");
  });

  it("lets ctrl-o expand the latest clipped tool output in the live TTY", async () => {
    const fixture = createFixture();
    const stdout: string[] = [];
    const terminal = new CapturingTtyWritable(110, 28);
    const stdin = new PassThrough();
    const longOutput = Array.from({ length: 16 }, (_, index) => {
      return `line ${index + 1}: scripted command output`;
    }).join("\n");
    let promptCount = 0;
    terminal.onPrompt = () => {
      promptCount += 1;
      if (promptCount === 1) {
        queueMicrotask(() => {
          stdin.write("inspect the strategy workspace\n");
        });
        return;
      }
      if (promptCount === 2) {
        queueMicrotask(() => {
          stdin.write("\x0f");
          stdin.write("/exit\n");
          stdin.end();
        });
      }
    };
    const runtime = new ScriptedCodexRuntime([
      {
        type: "thread.started",
        thread_id: "scripted_thread"
      },
      {
        type: "turn.started"
      },
      {
        type: "item.completed",
        item: {
          id: "cmd_1",
          type: "command_execution",
          command: "pnpm test",
          aggregated_output: longOutput,
          exit_code: 0,
          status: "completed"
        }
      },
      {
        type: "turn.completed",
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          reasoning_output_tokens: 7
        }
      }
    ]);

    const result = await runOpenStratCli({
      argv: [],
      cwd: fixture.project,
      env: fixture.env,
      runtime,
      stdin,
      output: terminal,
      stdout: (line) => stdout.push(line),
      stderr: (line) => stdout.push(line)
    });

    const plain = stripAnsi(terminal.output);
    expect(result.exitCode).toBe(0);
    expect(plain).toContain("ctrl+o to expand");
    expect(plain).toContain("line 16: scripted command output");
    expect(plain).toContain("ctrl+o to collapse");
    const expandedOutputIndex = terminal.output.indexOf(
      "line 16: scripted command output"
    );
    expect(terminal.output.lastIndexOf("\x1b[J", expandedOutputIndex)).toBeGreaterThan(
      terminal.output.indexOf("ctrl+o to expand")
    );
    expect(plain).not.toContain("CHNaN");
    expect(plain).not.toContain("\x0f");
    expect(stdout).toContain("bye");
  });

  it("lets ctrl-o expand the latest clipped slash-command output in the live TTY", async () => {
    const fixture = createFixture();
    const stdout: string[] = [];
    const terminal = new CapturingTtyWritable(110, 28);
    const stdin = new PassThrough();
    let promptCount = 0;
    terminal.onPrompt = () => {
      promptCount += 1;
      if (promptCount === 1) {
        queueMicrotask(() => {
          stdin.write("/help\n");
        });
        return;
      }
      if (promptCount === 2) {
        queueMicrotask(() => {
          stdin.write("\x0f");
          stdin.write("/exit\n");
          stdin.end();
        });
      }
    };

    const result = await runOpenStratCli({
      argv: [],
      cwd: fixture.project,
      env: {
        ...fixture.env,
        OPENSTRAT_CODEX_RUNTIME: "fake"
      },
      stdin,
      output: terminal,
      stdout: (line) => stdout.push(line),
      stderr: (line) => stdout.push(line)
    });

    const plain = stripAnsi(terminal.output);
    expect(result.exitCode).toBe(0);
    expect(plain).toContain("ctrl+o to expand");
    expect(plain).toContain("Guided path:");
    expect(plain).toContain("ctrl+o to collapse");
    const expandedOutputIndex = terminal.output.indexOf("Guided path:");
    expect(terminal.output.lastIndexOf("\x1b[J", expandedOutputIndex)).toBeGreaterThan(
      terminal.output.indexOf("ctrl+o to expand")
    );
    expect(plain).not.toContain("\x0f");
    expect(stdout).toContain("bye");
  });

  it("lets ctrl-t hide thinking traces in the live TTY", async () => {
    const fixture = createFixture();
    const stdout: string[] = [];
    const terminal = new CapturingTtyWritable(110, 28);
    const stdin = new PassThrough();
    let promptCount = 0;
    terminal.onPrompt = () => {
      promptCount += 1;
      if (promptCount === 1) {
        queueMicrotask(() => {
          stdin.write("inspect the strategy workspace\n");
        });
        return;
      }
      if (promptCount === 2) {
        queueMicrotask(() => {
          stdin.write("\x14");
          stdin.write("/exit\n");
          stdin.end();
        });
      }
    };
    const runtime = new ScriptedCodexRuntime([
      {
        type: "thread.started",
        thread_id: "scripted_thread"
      },
      {
        type: "turn.started"
      },
      {
        type: "item.completed",
        item: {
          id: "reasoning_1",
          type: "reasoning",
          text: "I should inspect the local strategy files before responding."
        }
      },
      {
        type: "turn.completed",
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          reasoning_output_tokens: 7
        }
      }
    ]);

    const result = await runOpenStratCli({
      argv: [],
      cwd: fixture.project,
      env: fixture.env,
      runtime,
      stdin,
      output: terminal,
      stdout: (line) => stdout.push(line),
      stderr: (line) => stdout.push(line)
    });

    const plain = stripAnsi(terminal.output);
    expect(result.exitCode).toBe(0);
    expect(plain).toContain(
      "I should inspect the local strategy files before responding."
    );
    expect(plain).toContain("Thinking...");
    expect(plain).not.toContain("\x14");
    expect(stdout).toContain("bye");
  });

  it("lets shift-tab cycle thinking effort for the next live turn", async () => {
    const fixture = createFixture();
    const stdout: string[] = [];
    const terminal = new CapturingTtyWritable(110, 28);
    const stdin = new PassThrough();
    let promptCount = 0;
    terminal.onPrompt = () => {
      promptCount += 1;
      if (promptCount === 1) {
        queueMicrotask(() => {
          stdin.write("\x1b[Zinspect the strategy workspace\n");
        });
        return;
      }
      if (promptCount === 2) {
        queueMicrotask(() => {
          stdin.write("/exit\n");
          stdin.end();
        });
      }
    };
    const runtime = new ScriptedCodexRuntime(
      [
        {
          type: "thread.started",
          thread_id: "scripted_thread"
        },
        {
          type: "turn.started"
        },
        {
          type: "turn.completed",
          usage: {
            input_tokens: 100,
            output_tokens: 20,
            reasoning_output_tokens: 7
          }
        }
      ],
      "auto"
    );

    const result = await runOpenStratCli({
      argv: [],
      cwd: fixture.project,
      env: fixture.env,
      runtime,
      stdin,
      output: terminal,
      stdout: (line) => stdout.push(line),
      stderr: (line) => stdout.push(line)
    });

    const plain = stripAnsi(terminal.output);
    expect(result.exitCode).toBe(0);
    expect(runtime.turns[0]?.prompt).toContain("inspect the strategy workspace");
    expect(runtime.turns[0]?.thinking).toBe("minimal");
    expect(plain).toContain("gpt-scripted • minimal");
    expect(plain).not.toContain("[Z");
    expect(stdout).toContain("bye");
  });

  it("lets ctrl-p cycle Codex model for the next live turn", async () => {
    const fixture = createFixture();
    const stdout: string[] = [];
    const terminal = new CapturingTtyWritable(110, 28);
    const stdin = new PassThrough();
    let promptCount = 0;
    terminal.onPrompt = () => {
      promptCount += 1;
      if (promptCount === 1) {
        queueMicrotask(() => {
          stdin.write("\x10inspect the strategy workspace\n");
        });
        return;
      }
      if (promptCount === 2) {
        queueMicrotask(() => {
          stdin.write("/exit\n");
          stdin.end();
        });
      }
    };
    const runtime = new ScriptedCodexRuntime([
      {
        type: "thread.started",
        thread_id: "scripted_thread"
      },
      {
        type: "turn.started"
      },
      {
        type: "turn.completed",
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          reasoning_output_tokens: 7
        }
      }
    ]);

    const result = await runOpenStratCli({
      argv: [],
      cwd: fixture.project,
      env: fixture.env,
      runtime,
      stdin,
      output: terminal,
      stdout: (line) => stdout.push(line),
      stderr: (line) => stdout.push(line)
    });

    const plain = stripAnsi(terminal.output);
    expect(result.exitCode).toBe(0);
    expect(runtime.turns[0]?.prompt).toContain("inspect the strategy workspace");
    expect(runtime.turns[0]?.model).toBe("gpt-scripted-high");
    expect(plain).toContain("gpt-scripted-high • high");
    expect(plain).not.toContain("\x10");
    expect(stdout).toContain("bye");
  });

  it("lets shift-ctrl-p cycle Codex model backward for the next live turn", async () => {
    const fixture = createFixture();
    const stdout: string[] = [];
    const terminal = new CapturingTtyWritable(110, 28);
    const stdin = new PassThrough();
    let promptCount = 0;
    terminal.onPrompt = () => {
      promptCount += 1;
      if (promptCount === 1) {
        queueMicrotask(() => {
          stdin.write("\x1b[80;6uinspect the strategy workspace\n");
        });
        return;
      }
      if (promptCount === 2) {
        queueMicrotask(() => {
          stdin.write("/exit\n");
          stdin.end();
        });
      }
    };
    const runtime = new ScriptedCodexRuntime(
      [
        {
          type: "thread.started",
          thread_id: "scripted_thread"
        },
        {
          type: "turn.started"
        },
        {
          type: "turn.completed",
          usage: {
            input_tokens: 100,
            output_tokens: 20,
            reasoning_output_tokens: 7
          }
        }
      ],
      "high",
      ["gpt-scripted", "gpt-scripted-low", "gpt-scripted-high"]
    );

    const result = await runOpenStratCli({
      argv: [],
      cwd: fixture.project,
      env: fixture.env,
      runtime,
      stdin,
      output: terminal,
      stdout: (line) => stdout.push(line),
      stderr: (line) => stdout.push(line)
    });

    const plain = stripAnsi(terminal.output);
    expect(result.exitCode).toBe(0);
    expect(runtime.turns[0]?.prompt).toContain("inspect the strategy workspace");
    expect(runtime.turns[0]?.model).toBe("gpt-scripted-high");
    expect(plain).toContain("gpt-scripted-high • high");
    expect(terminal.output).not.toContain("\x1b[80;6u");
    expect(stdout).toContain("bye");
  });

  it("lets ctrl-l open a model selector and choose the next live turn model", async () => {
    const fixture = createFixture();
    const stdout: string[] = [];
    const terminal = new CapturingTtyWritable(110, 30);
    const stdin = new PassThrough();
    let promptCount = 0;
    terminal.onPrompt = () => {
      promptCount += 1;
      if (promptCount === 1) {
        queueMicrotask(() => {
          stdin.write("\x0c\x1b[B\rinspect the strategy workspace\n");
        });
        return;
      }
      if (promptCount === 2) {
        queueMicrotask(() => {
          stdin.write("/exit\n");
          stdin.end();
        });
      }
    };
    const runtime = new ScriptedCodexRuntime(
      [
        {
          type: "thread.started",
          thread_id: "scripted_thread"
        },
        {
          type: "turn.started"
        },
        {
          type: "turn.completed",
          usage: {
            input_tokens: 100,
            output_tokens: 20,
            reasoning_output_tokens: 7
          }
        }
      ],
      "high",
      ["gpt-scripted", "gpt-scripted-low", "gpt-scripted-high"]
    );

    const result = await runOpenStratCli({
      argv: [],
      cwd: fixture.project,
      env: fixture.env,
      runtime,
      stdin,
      output: terminal,
      stdout: (line) => stdout.push(line),
      stderr: (line) => stdout.push(line)
    });

    const plain = stripAnsi(terminal.output);
    expect(result.exitCode).toBe(0);
    expect(runtime.turns[0]?.prompt).toContain("inspect the strategy workspace");
    expect(runtime.turns[0]?.model).toBe("gpt-scripted-low");
    expect(plain).toContain("model selector");
    expect(plain).toContain(
      "type to search | up/down choose | enter select | ctrl+c cancel"
    );
    expect(plain).not.toContain("enter s\nelect");
    expect(terminal.output).toContain("\x1b[38;2;236;174;236mmodel selector");
    expect(plain).toContain("gpt-scripted ✓ current");
    expect(terminal.output).toContain("\x1b[38;2;126;186;126m✓ current");
    expect(plain).toContain("› gpt-scripted-low");
    expect(terminal.output).toContain("\x1b[38;2;236;174;236m› gpt-scripted-low");
    expect(plain.split("\r").join("")).toContain(
      `|            › gpt-scripted-low\n|              gpt-scripted-high\n+${"-".repeat(108)}+`
    );
    expect(plain).toContain("gpt-scripted-low • high");
    expect(terminal.output).not.toContain("\x0c");
    expect(stdout).toContain("bye");
  });

  it("lets /model open a selectable model menu and choose the next live turn model", async () => {
    const fixture = createFixture();
    const stdout: string[] = [];
    const terminal = new CapturingTtyWritable(110, 30);
    const stdin = new PassThrough();
    let promptCount = 0;
    terminal.onPrompt = () => {
      promptCount += 1;
      if (promptCount === 1) {
        queueMicrotask(() => {
          stdin.write("/model\r\x1b[B\rinspect the strategy workspace\n");
        });
        return;
      }
      if (promptCount === 2) {
        queueMicrotask(() => {
          stdin.write("/exit\n");
          stdin.end();
        });
      }
    };
    const runtime = new ScriptedCodexRuntime(
      [
        {
          type: "thread.started",
          thread_id: "scripted_thread"
        },
        {
          type: "turn.started"
        },
        {
          type: "turn.completed",
          usage: {
            input_tokens: 100,
            output_tokens: 20,
            reasoning_output_tokens: 7
          }
        }
      ],
      "high",
      ["gpt-scripted", "gpt-scripted-low", "gpt-scripted-high"]
    );

    const result = await runOpenStratCli({
      argv: [],
      cwd: fixture.project,
      env: fixture.env,
      runtime,
      stdin,
      output: terminal,
      stdout: (line) => stdout.push(line),
      stderr: (line) => stdout.push(line)
    });

    const plain = stripAnsi(terminal.output);
    expect(result.exitCode).toBe(0);
    expect(runtime.turns[0]?.prompt).toBe("inspect the strategy workspace");
    expect(runtime.turns[0]?.model).toBe("gpt-scripted-low");
    expect(plain).toContain("model selector");
    expect(plain).toContain("› gpt-scripted-low");
    expect(plain).not.toContain("OpenStrat /model");
    expect(plain).not.toContain("/modelinspect the strategy workspace");
    expect(stdout).toContain("bye");
  });

  it("lets /effort open a selectable thinking effort menu for the next live turn", async () => {
    const fixture = createFixture();
    const stdout: string[] = [];
    const terminal = new CapturingTtyWritable(110, 30);
    const stdin = new PassThrough();
    let promptCount = 0;
    terminal.onPrompt = () => {
      promptCount += 1;
      if (promptCount === 1) {
        queueMicrotask(() => {
          stdin.write("/effort\r\x1b[B\rinspect the strategy workspace\n");
        });
        return;
      }
      if (promptCount === 2) {
        queueMicrotask(() => {
          stdin.write("/exit\n");
          stdin.end();
        });
      }
    };
    const runtime = new ScriptedCodexRuntime(
      [
        {
          type: "thread.started",
          thread_id: "scripted_thread"
        },
        {
          type: "turn.started"
        },
        {
          type: "turn.completed",
          usage: {
            input_tokens: 100,
            output_tokens: 20,
            reasoning_output_tokens: 7
          }
        }
      ],
      "auto"
    );

    const result = await runOpenStratCli({
      argv: [],
      cwd: fixture.project,
      env: fixture.env,
      runtime,
      stdin,
      output: terminal,
      stdout: (line) => stdout.push(line),
      stderr: (line) => stdout.push(line)
    });

    const plain = stripAnsi(terminal.output);
    expect(result.exitCode).toBe(0);
    expect(runtime.turns[0]?.prompt).toBe("inspect the strategy workspace");
    expect(runtime.turns[0]?.thinking).toBe("minimal");
    expect(plain).toContain("effort selector");
    expect(plain).toContain("› minimal");
    expect(plain).not.toContain("OpenStrat /effort");
    expect(plain).not.toContain("/effortinspect the strategy workspace");
    expect(stdout).toContain("bye");
  });

  it("filters the ctrl-l model selector by typed search without polluting the prompt", async () => {
    const fixture = createFixture();
    const stdout: string[] = [];
    const terminal = new CapturingTtyWritable(110, 30);
    const stdin = new PassThrough();
    let promptCount = 0;
    terminal.onPrompt = () => {
      promptCount += 1;
      if (promptCount === 1) {
        queueMicrotask(() => {
          stdin.write("\x0chigh\rinspect the strategy workspace\n");
        });
        return;
      }
      if (promptCount === 2) {
        queueMicrotask(() => {
          stdin.write("/exit\n");
          stdin.end();
        });
      }
    };
    const runtime = new ScriptedCodexRuntime(
      [
        {
          type: "thread.started",
          thread_id: "scripted_thread"
        },
        {
          type: "turn.started"
        },
        {
          type: "turn.completed",
          usage: {
            input_tokens: 100,
            output_tokens: 20,
            reasoning_output_tokens: 7
          }
        }
      ],
      "high",
      ["gpt-scripted", "gpt-scripted-low", "gpt-scripted-high"]
    );

    const result = await runOpenStratCli({
      argv: [],
      cwd: fixture.project,
      env: fixture.env,
      runtime,
      stdin,
      output: terminal,
      stdout: (line) => stdout.push(line),
      stderr: (line) => stdout.push(line)
    });

    const plain = stripAnsi(terminal.output);
    expect(result.exitCode).toBe(0);
    expect(runtime.turns[0]?.prompt).toBe("inspect the strategy workspace");
    expect(runtime.turns[0]?.model).toBe("gpt-scripted-high");
    expect(plain).toContain("search: high");
    expect(terminal.output).toContain("\x1b[38;2;236;174;236msearch:");
    expect(plain).toContain("› gpt-scripted-high");
    expect(terminal.output).toContain("\x1b[38;2;236;174;236m› gpt-scripted-high");
    expect(plain).toContain("gpt-scripted-high • high");
    expect(plain).not.toContain("highinspect the strategy workspace");
    expect(stdout).toContain("bye");
  });

  it("renders streamed SDK turn failures as red terminal blocks", async () => {
    const fixture = createFixture();
    const stdout: string[] = [];
    const terminal = new CapturingTtyWritable(100, 24);
    const stdin = attachScriptedInput(terminal, ["please fail the turn", "/exit"]);
    const runtime = new ScriptedCodexRuntime([
      {
        type: "thread.started",
        thread_id: "scripted_thread"
      },
      {
        type: "turn.started"
      },
      {
        type: "turn.failed",
        error: {
          message: "SDK turn failed"
        }
      }
    ]);

    const result = await runOpenStratCli({
      argv: [],
      cwd: fixture.project,
      env: fixture.env,
      runtime,
      stdin,
      output: terminal,
      stdout: (line) => stdout.push(line),
      stderr: (line) => stdout.push(line)
    });

    const rawScreen = terminal.output;
    const plain = stripAnsi(rawScreen);
    expect(result.exitCode).toBe(0);
    expect(rawScreen).toContain("\x1b[48;2;60;40;40m");
    expect(plain).toContain("turn failed");
    expect(plain).toContain("SDK turn failed");
    expect(plain).not.toContain("codex: codex");
    expect(stdout).toContain("bye");
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
    expect(output.join("\n")).toContain("--live");
    expect(output.join("\n")).not.toContain("--fixture");

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
    expect(failed.join("\n")).toContain("requires --live");
    expect(failed.join("\n")).toContain("next: Pass `--live`");
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

function attachScriptedInput(
  terminal: CapturingTtyWritable,
  lines: readonly string[]
): PassThrough {
  const stdin = new PassThrough();
  const scriptedInput = [...lines];
  terminal.onPrompt = () => {
    const line = scriptedInput.shift();
    if (line === undefined) {
      return;
    }
    queueMicrotask(() => {
      stdin.write(`${line}\n`);
      if (scriptedInput.length === 0) {
        stdin.end();
      }
    });
  };
  return stdin;
}

function stripAnsi(value: string): string {
  return value.replace(new RegExp(String.raw`\x1b\[[0-9;]*[A-Za-z]`, "g"), "");
}

class ScriptedCodexRuntime implements CodexWorkbenchRuntime {
  readonly kind = "codex_sdk";
  readonly displayModel = "gpt-scripted";
  readonly availableModels: readonly string[];
  readonly thinking: "auto" | ModelReasoningEffort;
  readonly turns: CodexTurnInput[] = [];

  constructor(
    private readonly events: ThreadEvent[],
    thinking: "auto" | ModelReasoningEffort = "high",
    availableModels: readonly string[] = ["gpt-scripted", "gpt-scripted-high"]
  ) {
    this.thinking = thinking;
    this.availableModels = availableModels;
  }

  async runTurn(input: CodexTurnInput) {
    this.turns.push(input);
    for (const event of this.events) {
      input.onEvent?.(event);
    }
    return {
      codexThreadId: "scripted_thread",
      finalResponse: this.events.some((event) => event.type === "turn.failed")
        ? ""
        : "scripted-final-response",
      events: this.events
    };
  }
}

class CapturingTtyWritable extends Writable {
  readonly isTTY = true;
  readonly columns: number;
  readonly rows: number;
  output = "";
  onPrompt?: () => void;

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
    const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
    this.output += text;
    if (text.includes("openstrat>") && !text.includes("\r")) {
      this.onPrompt?.();
    }
    callback();
  }
}

class PausingPassThrough extends PassThrough {
  pauseCount = 0;

  override pause(): this {
    this.pauseCount += 1;
    return super.pause() as this;
  }
}
