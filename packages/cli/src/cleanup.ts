import { existsSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, parse, relative, resolve } from "node:path";
import type { OpenStratCliHome } from "./home.js";

export interface CleanupOptions {
  cwd: string;
  env: Record<string, string | undefined>;
  home: OpenStratCliHome;
  scopes: CleanupScope[];
  dryRun: boolean;
  yes: boolean;
  uninstallMode?: boolean | undefined;
}

export interface CleanupResult {
  exitCode: number;
  lines: string[];
}

type CleanupScope = "project" | "user";

interface CleanupTarget {
  scope: CleanupScope;
  label: string;
  path: string;
}

export function runCleanupPlan(options: CleanupOptions): CleanupResult {
  const scopes = normalizeScopes(options.scopes);
  const lines = [
    options.uninstallMode
      ? "OpenStrat uninstall cleanup plan"
      : "OpenStrat cleanup plan"
  ];
  const targets = cleanupTargets(options.home, scopes);

  if (!options.dryRun && !options.yes) {
    lines.push(
      options.uninstallMode
        ? "fatal: cleanup review required before uninstalling OpenStrat"
        : "fatal: cleanup requires --dry-run or --yes"
    );
    lines.push(...formatCleanupCommands(options.uninstallMode === true));
    return { exitCode: 1, lines };
  }

  for (const target of targets) {
    lines.push(...applyCleanupTarget(target, options));
  }
  lines.push(formatCodexHomeBoundary(options.home, targets));
  lines.push("preserve external Codex installation and project .codex config");
  if (options.uninstallMode) {
    lines.push("after cleanup: npm uninstall -g @openstrat/cli");
  }
  return { exitCode: 0, lines };
}

function normalizeScopes(scopes: CleanupScope[]): CleanupScope[] {
  if (scopes.length === 0) {
    return ["project", "user"];
  }
  return [...new Set(scopes)];
}

function cleanupTargets(
  home: OpenStratCliHome,
  scopes: CleanupScope[]
): CleanupTarget[] {
  return scopes.map((scope) =>
    scope === "project"
      ? { scope, label: "project home", path: home.projectRoot }
      : { scope, label: "user home", path: home.userRoot }
  );
}

function applyCleanupTarget(target: CleanupTarget, options: CleanupOptions): string[] {
  const path = resolve(target.path);
  const safety = validateCleanupTarget(target, path, options.cwd, options.env);
  if (!safety.ok) {
    return [`refusing ${target.label}: ${path} (${safety.reason})`];
  }
  if (!existsSync(path)) {
    return [`skip missing ${target.label}: ${path}`];
  }
  if (!isDirectory(path)) {
    return [`refusing ${target.label}: ${path} (not a directory)`];
  }
  if (options.dryRun) {
    return [`[dry-run] remove ${target.label}: ${path}`];
  }
  rmSync(path, { recursive: true, force: true });
  return [`removed ${target.label}: ${path}`];
}

function formatCodexHomeBoundary(
  home: OpenStratCliHome,
  targets: CleanupTarget[]
): string {
  const codexHome = resolve(home.codexHome);
  const owningTarget = targets.find((target) =>
    isPathWithin(codexHome, resolve(target.path))
  );
  if (owningTarget) {
    return `OpenStrat-owned Codex home is inside selected ${owningTarget.label}: ${codexHome}`;
  }
  return `preserve external Codex home: ${codexHome}`;
}

function validateCleanupTarget(
  target: CleanupTarget,
  path: string,
  cwd: string,
  env: Record<string, string | undefined>
): { ok: true } | { ok: false; reason: string } {
  const root = parse(path).root;
  const homeCandidates = [homedir(), env.HOME]
    .filter((candidate): candidate is string => Boolean(candidate))
    .map((candidate) => resolve(candidate));
  const resolvedCwd = resolve(cwd);
  if (path === root) {
    return { ok: false, reason: "filesystem root" };
  }
  if (homeCandidates.includes(path)) {
    return { ok: false, reason: "account home" };
  }
  if (target.scope === "project" && path === resolvedCwd) {
    return { ok: false, reason: "project working directory" };
  }
  if (!path.toLowerCase().includes("openstrat")) {
    return { ok: false, reason: "path is not OpenStrat-scoped" };
  }
  return { ok: true };
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isPathWithin(child: string, parent: string): boolean {
  const difference = relative(resolve(parent), resolve(child));
  return difference === "" || (!difference.startsWith("..") && !isAbsolute(difference));
}

function formatCleanupCommands(uninstallMode: boolean): string[] {
  const lines = [
    "review first:",
    "  openstrat cleanup --dry-run",
    "remove project state:",
    "  openstrat cleanup --project --yes",
    "remove user state:",
    "  openstrat cleanup --user --yes"
  ];
  if (uninstallMode) {
    lines.push("then remove the CLI package:");
    lines.push("  npm uninstall -g @openstrat/cli");
  }
  return lines;
}

export function parseCleanupScopes(args: string[]): CleanupScope[] {
  const scopes: CleanupScope[] = [];
  if (args.includes("--all")) {
    return ["project", "user"];
  }
  if (args.includes("--project")) {
    scopes.push("project");
  }
  if (args.includes("--user")) {
    scopes.push("user");
  }
  return scopes;
}
