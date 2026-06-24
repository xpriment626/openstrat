import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface OpenStratCliHome {
  projectRoot: string;
  userRoot: string;
  codexHome: string;
  configPath: string;
  stateDbPath: string;
  sessionsDir: string;
  transcriptsDir: string;
  artifactsDir: string;
  backtestsDir: string;
  datasetsDir: string;
  summariesDir: string;
  logsDir: string;
  objectsDir: string;
  riskDir: string;
  strategiesDir: string;
}

export interface ResolveHomeOptions {
  cwd: string;
  env: Record<string, string | undefined>;
}

export interface CodexAuthStatus {
  configured: boolean;
  method: "chatgpt_cache" | "api_key" | "access_token" | "missing";
}

export function resolveOpenStratCliHome(options: ResolveHomeOptions): OpenStratCliHome {
  const accountHome = options.env.HOME ?? homedir();
  const projectRoot = resolve(
    options.env.OPENSTRAT_HOME ?? join(options.cwd, ".openstrat")
  );
  const userRoot = resolve(
    options.env.OPENSTRAT_USER_HOME ?? join(accountHome, ".openstrat")
  );
  const codexHome = resolve(options.env.CODEX_HOME ?? join(accountHome, ".codex"));

  return {
    projectRoot,
    userRoot,
    codexHome,
    configPath: join(projectRoot, "config.json"),
    stateDbPath: join(projectRoot, "state.sqlite"),
    sessionsDir: join(projectRoot, "sessions"),
    transcriptsDir: join(projectRoot, "transcripts"),
    artifactsDir: join(projectRoot, "artifacts"),
    backtestsDir: join(projectRoot, "backtests"),
    datasetsDir: join(projectRoot, "datasets"),
    summariesDir: join(projectRoot, "summaries"),
    logsDir: join(projectRoot, "logs"),
    objectsDir: join(projectRoot, "objects"),
    riskDir: join(projectRoot, "risk"),
    strategiesDir: join(projectRoot, "strategies")
  };
}

export function ensureOpenStratCliHome(home: OpenStratCliHome): void {
  for (const dir of [
    home.projectRoot,
    home.userRoot,
    home.sessionsDir,
    home.transcriptsDir,
    home.artifactsDir,
    home.backtestsDir,
    home.datasetsDir,
    home.summariesDir,
    home.logsDir,
    home.objectsDir,
    home.riskDir,
    home.strategiesDir
  ]) {
    mkdirSync(dir, { recursive: true });
  }

  if (!existsSync(home.configPath)) {
    writeJsonFile(home.configPath, {
      version: 1,
      runtime: "codex_sdk",
      project_scope: ".openstrat"
    });
  }
}

export function codexAuthStatus(
  home: OpenStratCliHome,
  env: Record<string, string | undefined>
): CodexAuthStatus {
  if (env.CODEX_ACCESS_TOKEN) {
    return { configured: true, method: "access_token" };
  }
  if (env.CODEX_API_KEY || env.OPENAI_API_KEY) {
    return { configured: true, method: "api_key" };
  }
  if (existsSync(join(home.codexHome, "auth.json"))) {
    return { configured: true, method: "chatgpt_cache" };
  }
  return { configured: false, method: "missing" };
}

export function readJsonFile<T>(path: string, fallback: T): T {
  if (!existsSync(path)) {
    return fallback;
  }
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function writeJsonFile(path: string, value: unknown): void {
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function listJsonFiles(dir: string): string[] {
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir)
    .filter((entry) => entry.endsWith(".json"))
    .sort();
}
