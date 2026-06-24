import type { SlashCommandResult } from "./slash-commands.js";
import type { WorkbenchSnapshot } from "./workbench-summary.js";

export interface WorkbenchTuiEntry {
  kind: "user" | "assistant" | "command" | "progress" | "system";
  title: string;
  body: string;
}

export interface WorkbenchTuiDiagnostic {
  severity: "info" | "warning" | "error";
  message: string;
}

export interface WorkbenchTuiState {
  runtimeKind: string;
  snapshot: WorkbenchSnapshot;
  commands: readonly string[];
  entries: WorkbenchTuiEntry[];
  diagnostics: WorkbenchTuiDiagnostic[];
  activeView?: string;
}

export interface RenderWorkbenchTuiOptions {
  width?: number;
  height?: number;
  composerPrompt?: string;
  showComposer?: boolean;
}

export function createWorkbenchTuiState(input: {
  runtimeKind: string;
  snapshot: WorkbenchSnapshot;
  commands: readonly string[];
  entries?: WorkbenchTuiEntry[];
  diagnostics?: WorkbenchTuiDiagnostic[];
  activeView?: string;
}): WorkbenchTuiState {
  return {
    runtimeKind: input.runtimeKind,
    snapshot: input.snapshot,
    commands: input.commands,
    entries: input.entries ?? [],
    diagnostics: input.diagnostics ?? [],
    ...(input.activeView ? { activeView: input.activeView } : {})
  };
}

export function updateTuiSnapshot(
  state: WorkbenchTuiState,
  snapshot: WorkbenchSnapshot
): WorkbenchTuiState {
  return {
    ...state,
    snapshot
  };
}

export function recordTuiEntry(
  state: WorkbenchTuiState,
  entry: WorkbenchTuiEntry
): WorkbenchTuiState {
  return {
    ...state,
    entries: [...state.entries, entry].slice(-60)
  };
}

export function recordTuiDiagnostic(
  state: WorkbenchTuiState,
  diagnostic: WorkbenchTuiDiagnostic
): WorkbenchTuiState {
  return {
    ...state,
    diagnostics: [...state.diagnostics, diagnostic].slice(-12)
  };
}

export function recordSlashCommandView(
  state: WorkbenchTuiState,
  result: SlashCommandResult
): WorkbenchTuiState {
  const view = renderSlashCommandView(result);
  return recordTuiEntry(
    {
      ...state,
      activeView: view
    },
    {
      kind: "command",
      title: `${result.command} ${result.status}`,
      body: summarizeSlashCommandResult(result)
    }
  );
}

export function renderWorkbenchTui(
  state: WorkbenchTuiState,
  options: RenderWorkbenchTuiOptions = {}
): string {
  const width = clamp(Math.floor(options.width ?? 100), 48, 140);
  const snapshot = state.snapshot;
  const latest = latestArtifact(snapshot);
  const transcript =
    state.entries.length > 0
      ? state.entries.slice(-8).flatMap((entry) => renderEntryCard(entry, width))
      : card(
          "Transcript",
          ["No messages yet.", "Ask naturally or run /help for deterministic actions."],
          width
        );
  const diagnostics = state.diagnostics.flatMap((diagnostic) =>
    card(
      `Diagnostic ${diagnostic.severity}`,
      [diagnostic.message],
      width,
      diagnostic.severity === "error"
        ? "!"
        : diagnostic.severity === "warning"
          ? "~"
          : "-"
    )
  );
  const activeView = state.activeView
    ? card("Workbench View", clipLines(state.activeView.split("\n"), 14), width)
    : [];
  const composer =
    options.showComposer === false
      ? []
      : card(
          "Composer",
          [
            options.composerPrompt ?? "openstrat> ",
            "Natural language runs through Codex. Slash commands are deterministic."
          ],
          width
        );
  const header = renderHeader(state, width);
  const commandSurface =
    state.entries.length > 0
      ? renderCommandHint(state.commands, width)
      : renderCommandPalette(state.commands, width);
  const body = [
    ...commandSurface,
    ...transcript,
    ...activeView,
    ...diagnostics,
    ...composer
  ];
  const footer = renderFooter(
    [
      shortenPath(snapshot.cwd),
      `${state.runtimeKind}`,
      `session ${shortId(snapshot.session?.id)}`,
      `artifact ${artifactRef(latest)}`
    ],
    width
  );

  return fitToHeight(header, body, footer, width, options.height).join("\n");
}

export function renderSlashCommandView(result: SlashCommandResult): string {
  if (result.command === "/markets") {
    return renderMarketCatalogView(result);
  }
  if (result.command === "/sessions" || result.command === "/resume") {
    return renderSessionView(result);
  }
  if (result.command === "/datasets") {
    return renderDatasetView(result);
  }
  if (result.command === "/strategy") {
    return renderSimpleCommandView("Strategy", result);
  }
  if (result.command === "/backtest") {
    return renderSimpleCommandView("Backtest", result);
  }
  if (result.command === "/risk") {
    return renderSimpleCommandView("Risk", result);
  }
  if (result.command === "/artifacts") {
    return renderSimpleCommandView("Artifacts", result);
  }
  if (result.command === "/ready") {
    return renderSimpleCommandView("Readiness", result);
  }
  if (result.command === "/status") {
    return renderSimpleCommandView("Status", result);
  }
  if (result.command === "/guide" || result.command === "/help") {
    return renderSimpleCommandView("Guide", result);
  }
  return renderSimpleCommandView("Command", result);
}

function renderMarketCatalogView(result: SlashCommandResult): string {
  const selected = isRecord(result.data.selected_market)
    ? result.data.selected_market
    : undefined;
  const summaryLines = result.summary.split("\n");
  const hasSelectedLine = summaryLines.some((line) => line.startsWith("selected: "));
  return [
    "Market Catalog",
    ...summaryLines,
    selected && !hasSelectedLine
      ? `selected: ${stringValue(selected.canonical_symbol) ?? "unknown"}`
      : undefined,
    result.next_suggested_action ? `next: ${result.next_suggested_action}` : undefined
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

function renderDatasetView(result: SlashCommandResult): string {
  const plan = isRecord(result.data.plan) ? result.data.plan : undefined;
  const datasets = Array.isArray(result.data.datasets) ? result.data.datasets : [];
  const datasetRows = datasets.slice(0, 8).map((dataset, index) => {
    if (!isRecord(dataset)) {
      return undefined;
    }
    const id = stringValue(dataset.id) ?? "unknown";
    const symbol = stringValue(dataset.symbol) ?? stringValue(dataset.canonical_symbol);
    const interval = stringValue(dataset.interval);
    const status = stringValue(dataset.status);
    return `${index + 1}. ${id}${symbol ? ` ${symbol}` : ""}${interval ? ` ${interval}` : ""}${status ? ` ${status}` : ""}`;
  });
  return [
    "Dataset Workflow",
    result.summary,
    plan ? "approval: required before ingestion" : undefined,
    plan && Array.isArray(plan.slash_commands)
      ? `commands: ${plan.slash_commands.join(" | ")}`
      : undefined,
    ...datasetRows.filter((row): row is string => row !== undefined),
    result.next_suggested_action ? `next: ${result.next_suggested_action}` : undefined
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

function renderSessionView(result: SlashCommandResult): string {
  const sessions = Array.isArray(result.data.sessions) ? result.data.sessions : [];
  const rows = sessions.slice(0, 10).map((session) => {
    if (!isRecord(session)) {
      return undefined;
    }
    const id = stringValue(session.id) ?? "unknown";
    const updated = stringValue(session.updated_at) ?? "unknown";
    const codexThread = stringValue(session.codex_thread_id);
    return `${id} updated=${updated}${codexThread ? ` codex=${codexThread}` : ""}`;
  });
  return [
    "Sessions",
    result.summary,
    ...rows.filter((row): row is string => row !== undefined),
    result.next_suggested_action ? `next: ${result.next_suggested_action}` : undefined
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

function renderSimpleCommandView(title: string, result: SlashCommandResult): string {
  const summaryLines = result.summary.split("\n");
  const hasNextLine = summaryLines.some((line) => line.startsWith("next: "));
  return [
    title,
    `status: ${result.status}`,
    ...summaryLines,
    result.next_suggested_action && !hasNextLine
      ? `next: ${result.next_suggested_action}`
      : undefined
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

function summarizeSlashCommandResult(result: SlashCommandResult): string {
  const lines = result.summary.split("\n").filter((line) => line.length > 0);
  if (result.command === "/markets") {
    const selected = lines.find((line) => line.startsWith("selected: "));
    return [
      lines[0] ?? result.summary,
      selected,
      result.next_suggested_action ? `next: ${result.next_suggested_action}` : undefined
    ]
      .filter((line): line is string => line !== undefined)
      .join("\n");
  }
  if (result.command === "/help" || result.command === "/guide") {
    return [
      lines[0] ?? result.summary,
      result.next_suggested_action ? `next: ${result.next_suggested_action}` : undefined
    ]
      .filter((line): line is string => line !== undefined)
      .join("\n");
  }
  const visible = lines.slice(0, 3);
  const omitted = lines.length - visible.length;
  return [
    ...visible,
    omitted > 0 ? `... ${omitted} more line(s) in Workbench View` : undefined,
    result.next_suggested_action ? `next: ${result.next_suggested_action}` : undefined
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

function latestArtifact(snapshot: WorkbenchSnapshot) {
  return Object.values(snapshot.latest)
    .filter((entry) => entry !== undefined)
    .sort((left, right) => right.created_at.localeCompare(left.created_at))[0];
}

function artifactRef(
  artifact:
    | NonNullable<WorkbenchSnapshot["latest"][keyof WorkbenchSnapshot["latest"]]>
    | undefined
): string {
  if (!artifact) {
    return "missing";
  }
  return artifact.ref ?? artifact.kind;
}

function wrapLine(line: string, width: number): string[] {
  if (width <= 0) {
    return [""];
  }
  if (line.length === 0) {
    return [""];
  }
  if (line.length <= width) {
    return [line];
  }
  const words = line.split(/\s+/);
  const rows: string[] = [];
  let current = "";
  for (const word of words) {
    if (word.length > width) {
      if (current.length > 0) {
        rows.push(current);
        current = "";
      }
      for (let index = 0; index < word.length; index += width) {
        rows.push(word.slice(index, index + width));
      }
      continue;
    }
    if (current.length === 0) {
      current = word;
      continue;
    }
    if (`${current} ${word}`.length > width) {
      rows.push(current);
      current = word;
      continue;
    }
    current = `${current} ${word}`;
  }
  if (current.length > 0) {
    rows.push(current);
  }
  return rows.length > 0 ? rows : [line.slice(0, width)];
}

function renderHeader(state: WorkbenchTuiState, width: number): string[] {
  const snapshot = state.snapshot;
  const local = snapshot.readiness.local_strategy_ready ? "local ready" : "local work";
  const auth = snapshot.auth.configured ? snapshot.auth.method : "auth missing";
  const title = "OpenStrat Workbench";
  const topRight = `${state.runtimeKind} | ${auth}`;
  const counts = [
    `data ${snapshot.counts.datasets}`,
    `markets ${snapshot.counts.markets}`,
    `strategies ${snapshot.counts.strategies}`,
    `backtests ${snapshot.counts.backtests}`,
    `artifacts ${snapshot.counts.artifacts}`
  ].join(" | ");
  const readiness = `${local} | wallet no | deploy no`;
  const pathWidth = Math.max(12, Math.floor((width - 18) / 2));
  const homes = `project ${truncateMiddle(
    shortenPath(snapshot.homes.project),
    pathWidth
  )} | user ${truncateMiddle(shortenPath(snapshot.homes.user), pathWidth)}`;
  return [
    balancedLine(title, topRight, width),
    rule(width),
    truncateLine(`${readiness} | ${counts}`, width),
    truncateLine(homes, width),
    ...wrapLine(`next: ${snapshot.readiness.next_action}`, width)
  ];
}

function renderCommandPalette(commands: readonly string[], width: number): string[] {
  const groups = [
    ["core", ["/help", "/status", "/guide", "/ready"]],
    ["data", ["/markets", "/datasets"]],
    ["strategy", ["/strategy", "/backtest", "/risk", "/artifacts"]],
    ["session", ["/sessions", "/new", "/resume", "/compact"]],
    ["later", ["/deploy"]]
  ];
  const known = new Set(commands);
  const lines = groups
    .map(([group, names]) => {
      const visible = (names as string[]).filter((name) => known.has(name));
      return visible.length > 0 ? `${group}: ${visible.join(" ")}` : undefined;
    })
    .filter((line): line is string => line !== undefined);
  return card("Commands", lines, width);
}

function renderCommandHint(commands: readonly string[], width: number): string[] {
  const preferred = [
    "/help",
    "/markets",
    "/datasets",
    "/strategy",
    "/backtest",
    "/risk",
    "/sessions",
    "/ready"
  ].filter((command) => commands.includes(command));
  return [truncateLine(`commands: ${preferred.join(" ")}`, width)];
}

function renderEntryCard(entry: WorkbenchTuiEntry, width: number): string[] {
  const marker =
    entry.kind === "user"
      ? ">"
      : entry.kind === "assistant"
        ? "*"
        : entry.kind === "command"
          ? "$"
          : entry.kind === "progress"
            ? "~"
            : "-";
  const title =
    entry.kind === "command"
      ? `Command ${entry.title}`
      : entry.kind === "progress"
        ? `Working ${entry.title}`
        : entry.title;
  return card(title, entry.body.split("\n"), width, marker);
}

function card(title: string, lines: string[], width: number, marker = "-"): string[] {
  const outerWidth = Math.max(24, width);
  const contentWidth = Math.max(8, outerWidth - 4);
  const safeTitle = truncateLine(` ${title} `, Math.max(1, outerWidth - 6));
  const topRemainder = Math.max(0, outerWidth - safeTitle.length - 3);
  const top = `+${marker}${safeTitle}${"-".repeat(topRemainder)}+`;
  const body = (lines.length > 0 ? lines : [""])
    .flatMap((line) => wrapLine(line, contentWidth))
    .slice(0, 32)
    .map((line) => `| ${padRight(truncateLine(line, contentWidth), contentWidth)} |`);
  const bottom = `+${"-".repeat(outerWidth - 2)}+`;
  return [top, ...body, bottom];
}

function renderFooter(parts: string[], width: number): string[] {
  const [cwd = "", runtime = "", session = "", artifact = ""] = parts;
  return [
    rule(width),
    balancedLine(cwd, runtime, width),
    balancedLine(session, artifact, width)
  ];
}

function fitToHeight(
  header: string[],
  body: string[],
  footer: string[],
  width: number,
  height: number | undefined
): string[] {
  if (height === undefined || !Number.isFinite(height)) {
    return [...header, ...body, ...footer];
  }
  const viewportHeight = Math.max(8, Math.floor(height));
  const all = [...header, ...body, ...footer];
  if (all.length <= viewportHeight) {
    return all;
  }

  const reserved = header.length + footer.length;
  if (reserved >= viewportHeight - 1) {
    const headerRows = Math.max(1, viewportHeight - footer.length - 1);
    return [
      ...header.slice(0, headerRows),
      truncateLine("... viewport clipped", width),
      ...footer
    ].slice(0, viewportHeight);
  }

  const bodyRows = viewportHeight - reserved;
  const visibleRows = Math.max(0, bodyRows - 1);
  const visibleBody = body.slice(-visibleRows);
  const omitted = body.length - visibleBody.length;
  const marker =
    omitted > 0
      ? [truncateLine(`... ${omitted} earlier line(s); latest output shown`, width)]
      : [];
  return [...header, ...marker, ...visibleBody, ...footer].slice(0, viewportHeight);
}

function clipLines(lines: string[], maxLines: number): string[] {
  if (lines.length <= maxLines) {
    return lines;
  }
  const omitted = lines.length - maxLines;
  return [...lines.slice(0, maxLines), `... ${omitted} more line(s)`];
}

function balancedLine(left: string, right: string, width: number): string {
  const safeRight = truncateLine(right, Math.max(0, Math.floor(width / 2)));
  const leftWidth = Math.max(0, width - safeRight.length - 1);
  const safeLeft = truncateLine(left, leftWidth);
  const spacing = Math.max(1, width - safeLeft.length - safeRight.length);
  return `${safeLeft}${" ".repeat(spacing)}${safeRight}`;
}

function truncateLine(line: string, width: number): string {
  if (line.length <= width) {
    return line;
  }
  if (width <= 3) {
    return ".".repeat(Math.max(0, width));
  }
  return `${line.slice(0, width - 3)}...`;
}

function truncateMiddle(line: string, width: number): string {
  if (line.length <= width) {
    return line;
  }
  if (width <= 5) {
    return truncateLine(line, width);
  }
  const start = Math.ceil((width - 3) / 2);
  const end = Math.floor((width - 3) / 2);
  return `${line.slice(0, start)}...${line.slice(line.length - end)}`;
}

function padRight(line: string, width: number): string {
  return `${line}${" ".repeat(Math.max(0, width - line.length))}`;
}

function rule(width: number): string {
  return "-".repeat(width);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function shortenPath(path: string): string {
  const home = process.env.HOME;
  if (home && path.startsWith(home)) {
    return `~${path.slice(home.length)}`;
  }
  return path;
}

function shortId(id: string | undefined): string {
  if (!id) {
    return "none";
  }
  if (id.length <= 22) {
    return id;
  }
  return `${id.slice(0, 12)}...${id.slice(-6)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
