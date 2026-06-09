import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { AuthStorage } from "@earendil-works/pi-coding-agent";
import {
  createAgentRuntimePolicy,
  createAgentRuntimePolicyEnforcer,
  createFakePiAgentSessionFactory,
  createPiAgentRuntimeAdapter,
  FilePiTranscriptStore,
  type PiAgentSessionFactory
} from "@openstrat/agent-runtime";
import { HyperliquidInfoClient } from "@openstrat/market-data";
import { SqliteEventLog } from "@openstrat/persistence";
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
    "commands: init, doctor, auth codex, chat, artifacts, gateway, upgrade, update, reset --purge"
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
