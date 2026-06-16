import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { SqliteEventLog } from "@openstrat/persistence";

export interface OpenStratHome {
  root: string;
  configPath: string;
  stateDbPath: string;
  objectsDir: string;
  sessionsDir: string;
  projectsDir: string;
  scratchDir: string;
  logsDir: string;
  authDir: string;
}

export interface ResolveOpenStratHomeOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  userHome?: string;
}

export interface ProjectRegistration {
  id: string;
  cwd: string;
  ref: string;
}

export interface PurgeResult {
  deleted: boolean;
  path: string;
}

export function resolveOpenStratHome(
  options: ResolveOpenStratHomeOptions = {}
): OpenStratHome {
  const env = options.env ?? process.env;
  const projectRoot = resolve(options.cwd ?? process.cwd());
  const root = resolve(env.OPENSTRAT_HOME ?? join(projectRoot, ".openstrat"));
  return {
    root,
    configPath: join(root, "config.json"),
    stateDbPath: join(root, "state.sqlite"),
    objectsDir: join(root, "objects"),
    sessionsDir: join(root, "agent-runtime", "sessions"),
    projectsDir: join(root, "projects"),
    scratchDir: join(root, "scratch"),
    logsDir: join(root, "logs"),
    authDir: join(root, "auth")
  };
}

export function ensureOpenStratHome(home: OpenStratHome): void {
  for (const dir of [
    home.root,
    home.objectsDir,
    home.sessionsDir,
    home.projectsDir,
    home.scratchDir,
    home.logsDir,
    home.authDir
  ]) {
    mkdirSync(dir, { recursive: true });
  }

  if (!existsSync(home.configPath)) {
    writeFileSync(
      home.configPath,
      `${JSON.stringify({ version: 1, epoch: "project-v0" }, null, 2)}\n`,
      "utf8"
    );
  }

  const events = new SqliteEventLog(home.stateDbPath);
  events.close();
}

export function getPiAuthPath(home: OpenStratHome): string {
  return join(home.authDir, "pi-auth.json");
}

export function projectObjectRoot(registration: ProjectRegistration): string {
  return `projects/${projectObjectSegment(registration.id)}`;
}

export function projectObjectRef(
  registration: ProjectRegistration,
  ...segments: string[]
): string {
  if (segments.length === 0) {
    throw new Error("Project object ref requires at least one segment");
  }
  return [projectObjectRoot(registration), ...segments.map(projectObjectSegment)].join(
    "/"
  );
}

export function registerProject(
  home: OpenStratHome,
  cwdInput: string
): ProjectRegistration {
  ensureOpenStratHome(home);
  const cwd = resolve(cwdInput);
  const id = projectIdFor(cwd);
  const ref = join(home.projectsDir, `${id}.json`);
  const registration = { id, cwd, ref };

  if (!existsSync(ref)) {
    writeFileSync(ref, `${JSON.stringify(registration, null, 2)}\n`, "utf8");
  }

  return registration;
}

export function findProjectRegistration(
  home: OpenStratHome,
  cwdInput: string
): ProjectRegistration | undefined {
  const ref = join(home.projectsDir, `${projectIdFor(resolve(cwdInput))}.json`);
  if (!existsSync(ref)) {
    return undefined;
  }
  return JSON.parse(readFileSync(ref, "utf8")) as ProjectRegistration;
}

export function listProjectRegistrations(home: OpenStratHome): ProjectRegistration[] {
  if (!existsSync(home.projectsDir)) {
    return [];
  }
  return readdirSync(home.projectsDir)
    .filter((entry) => entry.endsWith(".json"))
    .map((entry) => JSON.parse(readFileSync(join(home.projectsDir, entry), "utf8")))
    .sort((a: ProjectRegistration, b: ProjectRegistration) => a.id.localeCompare(b.id));
}

export function safePurgeOpenStratHome(home: OpenStratHome): PurgeResult {
  assertSafePurgePath(home.root);
  if (!existsSync(home.root)) {
    return { deleted: false, path: home.root };
  }
  rmSync(home.root, { force: true, recursive: true });
  return { deleted: true, path: home.root };
}

function assertSafePurgePath(pathInput: string): void {
  const path = resolve(pathInput);
  const parent = basename(resolve(path, ".."));
  const projectLocalHome = basename(path) === ".openstrat";
  const legacyDevHome = basename(path) === "dev-v0" && parent === ".openstrat";
  if (!projectLocalHome && !legacyDevHome) {
    throw new Error(`Refusing to purge unsafe OpenStrat home: ${path}`);
  }
  if (path === join(homedir(), ".openstrat")) {
    throw new Error(`Refusing to purge unsafe OpenStrat home: ${path}`);
  }
  const fromHome = relative(homedir(), path);
  if (fromHome === "" || fromHome.startsWith("..")) {
    const fromConfiguredRoot =
      path.includes(`${".openstrat"}/dev-v0`) || path.endsWith(`${"/.openstrat"}`);
    if (!fromConfiguredRoot) {
      throw new Error(`Refusing to purge unsafe OpenStrat home: ${path}`);
    }
  }
}

function projectIdFor(cwd: string): string {
  return Buffer.from(cwd).toString("base64url").slice(0, 32);
}

function projectObjectSegment(segment: string): string {
  if (
    segment.length === 0 ||
    segment === "." ||
    segment === ".." ||
    segment.includes("/") ||
    segment.includes("\\") ||
    segment.includes("\0")
  ) {
    throw new Error(`Invalid project object ref segment: ${segment}`);
  }
  return segment;
}
