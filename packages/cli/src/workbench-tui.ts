import type { SlashCommandResult } from "./slash-commands.js";
import type { WorkbenchSnapshot } from "./workbench-summary.js";

export interface WorkbenchTuiEntry {
  id?: string;
  kind:
    | "user"
    | "assistant"
    | "command"
    | "progress"
    | "system"
    | "thinking"
    | "working"
    | "tool_call"
    | "tool_result"
    | "tool_error";
  title: string;
  body: string;
}

export interface WorkbenchTuiDiagnostic {
  severity: "info" | "warning" | "error";
  message: string;
}

export interface WorkbenchTuiFooterState {
  model?: string;
  thinking?: string;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cacheHitPercent?: number;
  contextPercent?: number;
  contextWindow?: number;
  costUsd?: number;
  autoCompact?: boolean;
}

export interface WorkbenchTuiState {
  runtimeKind: string;
  snapshot: WorkbenchSnapshot;
  commands: readonly string[];
  entries: WorkbenchTuiEntry[];
  diagnostics: WorkbenchTuiDiagnostic[];
  thinkingVisible: boolean;
  toolsExpanded: boolean;
  footer?: WorkbenchTuiFooterState;
  activeView?: string;
}

export interface RenderWorkbenchTuiOptions {
  width?: number;
  height?: number;
  composerPrompt?: string;
  showComposer?: boolean;
  color?: boolean;
}

export function createWorkbenchTuiState(input: {
  runtimeKind: string;
  snapshot: WorkbenchSnapshot;
  commands: readonly string[];
  entries?: WorkbenchTuiEntry[];
  diagnostics?: WorkbenchTuiDiagnostic[];
  thinkingVisible?: boolean;
  toolsExpanded?: boolean;
  footer?: WorkbenchTuiFooterState;
  activeView?: string;
}): WorkbenchTuiState {
  return {
    runtimeKind: input.runtimeKind,
    snapshot: input.snapshot,
    commands: input.commands,
    entries: input.entries ?? [],
    diagnostics: input.diagnostics ?? [],
    thinkingVisible: input.thinkingVisible ?? true,
    toolsExpanded: input.toolsExpanded ?? false,
    ...(input.footer ? { footer: input.footer } : {}),
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
  const existingIndex = entry.id
    ? state.entries.findIndex((candidate) => candidate.id === entry.id)
    : -1;
  if (existingIndex >= 0) {
    return {
      ...state,
      entries: state.entries.map((candidate, index) =>
        index === existingIndex ? entry : candidate
      )
    };
  }
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

export function updateTuiFooter(
  state: WorkbenchTuiState,
  footer: WorkbenchTuiFooterState
): WorkbenchTuiState {
  return {
    ...state,
    footer: {
      ...state.footer,
      ...footer
    }
  };
}

export function setTuiToolsExpanded(
  state: WorkbenchTuiState,
  toolsExpanded: boolean
): WorkbenchTuiState {
  return {
    ...state,
    toolsExpanded
  };
}

export function setTuiThinkingVisible(
  state: WorkbenchTuiState,
  thinkingVisible: boolean
): WorkbenchTuiState {
  return {
    ...state,
    thinkingVisible
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
  const style = renderStyle(options);
  const header = renderHeader(state, width);
  const footer = renderFooter(state, width, style);
  const fixed = fixedBodySections(state, width, options, style);

  if (options.height !== undefined && Number.isFinite(options.height)) {
    return renderHeightAwareWorkbench({
      state,
      width,
      height: Math.floor(options.height),
      header,
      footer,
      fixed
    }).join("\n");
  }

  const transcript = renderTranscriptFlow(
    state.entries,
    state.activeView,
    width,
    style,
    state.toolsExpanded,
    state.thinkingVisible
  );
  return [
    ...header,
    ...fixed.commandSurface,
    ...transcript,
    ...fixed.diagnostics,
    ...fixed.composer,
    ...footer
  ].join("\n");
}

export function renderWorkbenchTuiAppend(
  state: WorkbenchTuiState,
  options: {
    width?: number;
    fromEntry?: number;
    fromDiagnostic?: number;
    includeFooter?: boolean;
    color?: boolean;
    updatedEntry?: WorkbenchTuiEntry;
  } = {}
): string {
  const width = clamp(Math.floor(options.width ?? 100), 48, 140);
  const style = renderStyle(options);
  const fromEntry = Math.max(0, Math.floor(options.fromEntry ?? 0));
  const fromDiagnostic = Math.max(0, Math.floor(options.fromDiagnostic ?? 0));
  const activeCommandIndex = state.activeView ? lastCommandIndex(state.entries) : -1;
  const lines: string[] = [];

  if (options.updatedEntry) {
    lines.push(
      ...renderFlowEntryUpdate(
        options.updatedEntry,
        width,
        style,
        state.toolsExpanded,
        state.thinkingVisible
      )
    );
  }

  state.entries.slice(fromEntry).forEach((entry, index) => {
    const absoluteIndex = fromEntry + index;
    const hasInlineOutput =
      absoluteIndex === activeCommandIndex && state.activeView !== undefined;
    lines.push(
      ...renderFlowEntry(
        entry,
        width,
        style,
        state.toolsExpanded,
        state.thinkingVisible,
        hasInlineOutput
      )
    );
    if (hasInlineOutput && state.activeView) {
      lines.push(
        ...renderInlineWorkbenchOutput(
          state.activeView,
          width,
          style,
          state.toolsExpanded,
          entry.kind === "command" ? commandBlockTone(entry.title) : "success"
        )
      );
    }
  });

  lines.push(
    ...state.diagnostics
      .slice(fromDiagnostic)
      .flatMap((diagnostic) =>
        wrapPrefixedFlow(
          `Diagnostic ${diagnostic.severity}: `,
          [diagnostic.message],
          width
        )
      )
  );
  if (options.includeFooter && state.footer) {
    lines.push("", ...renderFooterStatus(state, width, style));
  }

  return lines.join("\n");
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

function renderHeightAwareWorkbench(input: {
  state: WorkbenchTuiState;
  width: number;
  height: number;
  header: string[];
  footer: string[];
  fixed: FixedBodySections;
}): string[] {
  const viewportHeight = Math.max(8, input.height);
  const chat = renderTranscriptFlow(
    input.state.entries,
    input.state.activeView,
    input.width,
    input.fixed.style,
    input.state.toolsExpanded,
    input.state.thinkingVisible,
    2
  );
  const body = [
    ...input.fixed.commandSurface,
    ...chat,
    ...input.fixed.diagnostics,
    ...input.fixed.composer
  ];

  return fitToHeight(input.header, body, input.footer, input.width, viewportHeight);
}

interface FixedBodySections {
  commandSurface: string[];
  diagnostics: string[];
  composer: string[];
  style: RenderStyle;
}

function fixedBodySections(
  state: WorkbenchTuiState,
  width: number,
  options: RenderWorkbenchTuiOptions,
  style: RenderStyle
): FixedBodySections {
  return {
    style,
    commandSurface:
      state.entries.length > 0 || state.activeView
        ? renderCommandHint(state.commands, width)
        : renderCommandPalette(state.commands, width),
    diagnostics: state.diagnostics.flatMap((diagnostic) =>
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
    ),
    composer:
      options.showComposer === false
        ? []
        : renderComposerInput(options.composerPrompt ?? "openstrat> ", width, style)
  };
}

function renderTranscriptFlow(
  entries: readonly WorkbenchTuiEntry[],
  activeView: string | undefined,
  width: number,
  style: RenderStyle,
  toolsExpanded: boolean,
  thinkingVisible: boolean,
  inlineWorkbenchMaxBodyLines = 8
): string[] {
  if (entries.length === 0 && !activeView) {
    return [];
  }

  const recentEntries = entries.slice(-20);
  const activeCommandIndex = activeView ? lastCommandIndex(recentEntries) : -1;
  const lines: string[] = [];

  recentEntries.forEach((entry, index) => {
    const hasInlineOutput = index === activeCommandIndex && activeView !== undefined;
    lines.push(
      ...renderFlowEntry(
        entry,
        width,
        style,
        toolsExpanded,
        thinkingVisible,
        hasInlineOutput
      )
    );
    if (hasInlineOutput) {
      lines.push(
        ...renderInlineWorkbenchOutput(
          activeView,
          width,
          style,
          toolsExpanded,
          entry.kind === "command" ? commandBlockTone(entry.title) : "success",
          inlineWorkbenchMaxBodyLines
        )
      );
    }
  });

  if (activeView && activeCommandIndex === -1) {
    lines.push(
      "",
      ...renderInlineWorkbenchOutput(
        activeView,
        width,
        style,
        toolsExpanded,
        "success",
        inlineWorkbenchMaxBodyLines
      )
    );
  }

  return lines;
}

function renderFlowEntry(
  entry: WorkbenchTuiEntry,
  width: number,
  style: RenderStyle,
  toolsExpanded: boolean,
  thinkingVisible: boolean,
  suppressCommandBody = false
): string[] {
  const rawBody = entry.body.split("\n");
  const body = rawBody.filter((line) => line.length > 0);
  if (entry.kind === "user") {
    return ["", ...renderUserMessage(body, width, style)];
  }
  if (entry.kind === "thinking") {
    return ["", ...renderThinkingMessage(body, width, style, thinkingVisible)];
  }
  if (entry.kind === "working") {
    return ["", ...renderWorkingMessage(body, width, style)];
  }
  if (entry.kind === "tool_call") {
    return [
      "",
      ...renderToolBlock(entry.title, body, width, style, "pending", toolsExpanded)
    ];
  }
  if (entry.kind === "tool_result") {
    return [
      "",
      ...renderToolBlock(entry.title, body, width, style, "success", toolsExpanded)
    ];
  }
  if (entry.kind === "tool_error") {
    return [
      "",
      ...renderToolBlock(entry.title, body, width, style, "error", toolsExpanded)
    ];
  }
  if (entry.kind === "command") {
    return [
      "",
      ...renderCommandBlock(
        entry.title,
        suppressCommandBody ? [] : body,
        width,
        style,
        toolsExpanded
      )
    ];
  }
  if (entry.kind === "progress") {
    return ["", ...renderProgressMessage(body, width, style)];
  }
  if (entry.kind === "assistant") {
    return ["", ...renderAssistantMessage(rawBody, width, style)];
  }
  return ["", ...wrapPrefixedFlow(`${entry.title}: `, body, width)];
}

function renderFlowEntryUpdate(
  entry: WorkbenchTuiEntry,
  width: number,
  style: RenderStyle,
  toolsExpanded: boolean,
  thinkingVisible: boolean
): string[] {
  const body = entry.body.split("\n").filter((line) => line.length > 0);
  if (entry.kind === "tool_call") {
    return [
      "",
      ...renderToolUpdateBlock("update", body, width, style, "pending", toolsExpanded)
    ];
  }
  if (entry.kind === "tool_result") {
    return [
      "",
      ...renderToolUpdateBlock(
        entry.title,
        body,
        width,
        style,
        "success",
        toolsExpanded
      )
    ];
  }
  if (entry.kind === "tool_error") {
    return [
      "",
      ...renderToolUpdateBlock(entry.title, body, width, style, "error", toolsExpanded)
    ];
  }
  return renderFlowEntry(entry, width, style, toolsExpanded, thinkingVisible);
}

function renderUserMessage(
  body: string[],
  width: number,
  style: RenderStyle
): string[] {
  const contentWidth = Math.max(1, width - 4);
  const contentRows = (body.length > 0 ? body : [""])
    .flatMap((line) => wrapLine(line, contentWidth))
    .map((line) => padRight(`  ${line}`, width));
  return [padRight("", width), ...contentRows, padRight("", width)].map((line) =>
    colorize(line, style, "userBox")
  );
}

function renderThinkingMessage(
  body: string[],
  width: number,
  style: RenderStyle,
  visible: boolean
): string[] {
  const visibleBody = body.length > 0 ? body : [""];
  const rows = (visible ? visibleBody : ["Thinking..."]).flatMap((line) =>
    wrapPrefixedLine("  ", line, width)
  );
  return rows.map((line) => colorize(line, style, "thinking"));
}

function renderWorkingMessage(
  body: string[],
  width: number,
  style: RenderStyle
): string[] {
  const text = body.join(" ").trim() || "working";
  const prefix = "Working... ";
  return wrapPrefixedLine(prefix, text, width).map((line, index) => {
    if (!style.color) {
      return line;
    }
    if (index > 0) {
      return colorize(line, style, "muted");
    }
    return `${colorize(prefix, style, "working")}${colorize(
      line.slice(prefix.length),
      style,
      "muted"
    )}`;
  });
}

function renderProgressMessage(
  body: string[],
  width: number,
  style: RenderStyle
): string[] {
  const text = body.join(" ").trim();
  return wrapPrefixedLine("status ", text, width).map((line) =>
    colorize(line, style, "muted")
  );
}

function renderAssistantMessage(
  body: string[],
  width: number,
  style: RenderStyle
): string[] {
  return renderAssistantMarkdownRows(body.length > 0 ? body : [""]).flatMap((row) => {
    if (row.text.length === 0) {
      return [""];
    }
    return wrapPrefixedLine(" ", row.text, width).map((line) =>
      colorize(line, style, row.tone)
    );
  });
}

function renderAssistantMarkdownRows(
  lines: string[]
): Array<{ text: string; tone: StyleTone }> {
  const rows: Array<{ text: string; tone: StyleTone }> = [];
  let inFence = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      rows.push({ text: `    ${line}`, tone: "assistantCode" });
      continue;
    }

    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading?.[2]) {
      rows.push({
        text: stripInlineMarkdown(heading[2]),
        tone: "assistantHeading"
      });
      continue;
    }

    const bullet = /^[-*]\s+(.+)$/.exec(trimmed);
    if (bullet?.[1]) {
      rows.push({
        text: `  - ${stripInlineMarkdown(bullet[1])}`,
        tone: "assistant"
      });
      continue;
    }

    const ordered = /^(\d+[.)])\s+(.+)$/.exec(trimmed);
    if (ordered?.[1] && ordered[2]) {
      rows.push({
        text: `  ${ordered[1]} ${stripInlineMarkdown(ordered[2])}`,
        tone: "assistant"
      });
      continue;
    }

    rows.push({ text: stripInlineMarkdown(line), tone: "assistant" });
  }

  return rows;
}

function stripInlineMarkdown(value: string): string {
  return value
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1");
}

function renderToolBlock(
  title: string,
  body: string[],
  width: number,
  style: RenderStyle,
  tone: "pending" | "success" | "error",
  expanded: boolean,
  maxBodyLines = 12
): string[] {
  if (isShellCommandTitle(title)) {
    return renderShellCommandBlock(title, body, width, style, tone, expanded);
  }
  const bodyRows = formatToolBodyRows(title, body, expanded, maxBodyLines);
  const rows = [title, ...bodyRows].flatMap((line, index) => {
    const prefix = index === 0 ? "" : "  ";
    return wrapPrefixedLine(prefix, line, width);
  });
  const styleName =
    tone === "error" ? "toolError" : tone === "pending" ? "toolPending" : "toolSuccess";
  return renderPaddedToolRows(rows, width, style, styleName);
}

function renderCommandBlock(
  title: string,
  body: string[],
  width: number,
  style: RenderStyle,
  expanded: boolean
): string[] {
  return renderToolBlock(
    `OpenStrat ${title}`,
    body,
    width,
    style,
    commandBlockTone(title),
    expanded
  );
}

function commandBlockTone(title: string): "pending" | "success" | "error" {
  const status = title.trim().split(/\s+/).at(-1);
  if (status === "error") {
    return "error";
  }
  if (status === "unavailable") {
    return "pending";
  }
  return "success";
}

function renderToolUpdateBlock(
  title: string,
  body: string[],
  width: number,
  style: RenderStyle,
  tone: "pending" | "success" | "error",
  expanded: boolean
): string[] {
  if (isShellCommandTitle(title)) {
    return renderShellCommandBlock(title, body, width, style, tone, expanded);
  }
  const rows = [title, ...formatToolBodyRows(title, body, expanded)].flatMap(
    (line, index) => {
      const prefix = index === 0 ? "" : "  ";
      return wrapPrefixedLine(prefix, line, width);
    }
  );
  const styleName =
    tone === "error" ? "toolError" : tone === "pending" ? "toolPending" : "toolSuccess";
  return renderPaddedToolRows(rows, width, style, styleName);
}

function renderPaddedToolRows(
  rows: string[],
  width: number,
  style: RenderStyle,
  styleName: "toolPending" | "toolSuccess" | "toolError"
): string[] {
  return [
    { line: "", titleRow: false },
    ...rows.map((line, index) => ({ line, titleRow: index === 0 })),
    { line: "", titleRow: false }
  ].map(({ line, titleRow }) =>
    colorize(padRight(line, width), style, toolRowTone(styleName, titleRow))
  );
}

function renderShellCommandBlock(
  title: string,
  body: string[],
  width: number,
  style: RenderStyle,
  tone: "pending" | "success" | "error",
  expanded: boolean
): string[] {
  const borderTone = tone === "error" ? "shellErrorBorder" : "bashBorder";
  const titleTone = tone === "error" ? "toolErrorTitle" : "bashTitle";
  const outputTone = tone === "error" ? "toolErrorOutput" : "bashOutput";
  const border = colorize("─".repeat(width), style, borderTone);
  const titleRows = wrapPrefixedLine("  ", title, width).map((line) =>
    colorize(padRight(line, width), style, titleTone)
  );
  const bodyRows = formatShellCommandBodyRows(title, body, expanded, tone).flatMap(
    (line) => wrapPrefixedLine("  ", line, width)
  );
  return [
    border,
    ...titleRows,
    ...bodyRows.map((line) => colorize(padRight(line, width), style, outputTone)),
    border
  ];
}

function formatShellCommandBodyRows(
  title: string,
  body: string[],
  expanded: boolean,
  tone: "pending" | "success" | "error"
): string[] {
  const rows = formatToolBodyRows(title, body, expanded);
  if (tone !== "pending") {
    return rows;
  }
  return [...rows.filter((line) => line !== "status in_progress"), "Running..."];
}

function isShellCommandTitle(title: string): boolean {
  return title.startsWith("$ ");
}

function toolRowTone(
  tone: "toolPending" | "toolSuccess" | "toolError",
  titleRow: boolean
): StyleTone {
  if (tone === "toolPending") {
    return titleRow ? "toolPendingTitle" : "toolPendingOutput";
  }
  if (tone === "toolSuccess") {
    return titleRow ? "toolSuccessTitle" : "toolSuccessOutput";
  }
  return titleRow ? "toolErrorTitle" : "toolErrorOutput";
}

function formatToolBodyRows(
  title: string,
  body: string[],
  expanded: boolean,
  maxLines = 12
): string[] {
  return clipToolLines(
    stripRedundantToolTarget(title, sectionToolBody(title, body)),
    expanded,
    maxLines
  );
}

function sectionToolBody(title: string, body: string[]): string[] {
  const rows: string[] = [];
  const pendingStdout: string[] = [];
  let currentSection: "stdout" | "stderr" | "body" | undefined;

  const flushStdout = () => {
    if (pendingStdout.length === 0) {
      return;
    }
    if (title.startsWith("$ ")) {
      rows.push("stdout", ...pendingStdout.map((line) => `  ${line}`));
    } else {
      rows.push(...pendingStdout);
    }
    pendingStdout.length = 0;
  };

  for (const line of body) {
    const section = /^(stdout|stderr|body):\s*(.*)$/i.exec(line);
    if (section?.[1] !== undefined) {
      flushStdout();
      currentSection = section[1].toLowerCase() as "stdout" | "stderr" | "body";
      rows.push(currentSection);
      if (section[2]) {
        rows.push(`  ${section[2]}`);
      }
      continue;
    }

    const metadata = /^(status|exit):\s*(.*)$/i.exec(line);
    if (metadata?.[1] !== undefined) {
      flushStdout();
      currentSection = undefined;
      rows.push(`${metadata[1].toLowerCase()} ${metadata[2] ?? ""}`.trim());
      continue;
    }

    if (currentSection) {
      rows.push(`  ${line}`);
      continue;
    }
    pendingStdout.push(line);
  }

  flushStdout();
  return rows;
}

function stripRedundantToolTarget(title: string, rows: string[]): string[] {
  if (title.startsWith("$ ") || rows.length !== 1) {
    return rows;
  }
  const [row] = rows;
  const target = row?.trim();
  const normalizedTitle = title.trim();
  if (
    !target ||
    (normalizedTitle !== target &&
      !normalizedTitle.endsWith(` ${target}`) &&
      !normalizedTitle.endsWith(`/${target}`))
  ) {
    return rows;
  }
  return [];
}

function renderInlineWorkbenchOutput(
  activeView: string,
  width: number,
  style: RenderStyle,
  expanded: boolean,
  tone: "pending" | "success" | "error" = "success",
  maxBodyLines = 8
): string[] {
  const [title = "Workbench View", ...body] = activeView
    .split("\n")
    .filter((line) => line.length > 0);
  return renderToolBlock(title, body, width, style, tone, expanded, maxBodyLines);
}

function wrapPrefixedFlow(prefix: string, body: string[], width: number): string[] {
  if (body.length === 0) {
    return [prefix.trimEnd()];
  }
  return body.flatMap((line, index) => {
    return wrapPrefixedLine(index === 0 ? prefix : "  ", line, width);
  });
}

function wrapPrefixedLine(prefix: string, line: string, width: number): string[] {
  const contentWidth = Math.max(1, width - prefix.length);
  const continuationPrefix = " ".repeat(
    Math.min(prefix.length, Math.max(0, width - 1))
  );
  return wrapLine(line, contentWidth).map((row, index) => {
    return `${index === 0 ? prefix : continuationPrefix}${row}`;
  });
}

function lastCommandIndex(entries: readonly WorkbenchTuiEntry[]): number {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index]?.kind === "command") {
      return index;
    }
  }
  return -1;
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
    omitted > 0 ? `... ${omitted} more line(s) in command output` : undefined,
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

function renderComposerInput(
  prompt: string,
  width: number,
  style: RenderStyle
): string[] {
  const outerWidth = Math.max(24, width);
  const contentWidth = Math.max(8, outerWidth - 4);
  const top = colorize(`+${"-".repeat(outerWidth - 2)}+`, style, "composerBorder");
  const bottom = colorize(`+${"-".repeat(outerWidth - 2)}+`, style, "composerBorder");
  const body = wrapLine(prompt, contentWidth).map((line) => {
    return `${colorize("|", style, "composerBorder")} ${padRight(
      truncateLine(line, contentWidth),
      contentWidth
    )} ${colorize("|", style, "composerBorder")}`;
  });
  return [top, ...body, bottom];
}

function card(
  title: string,
  lines: string[],
  width: number,
  marker = "-",
  style?: RenderStyle,
  borderTone?: StyleTone
): string[] {
  const outerWidth = Math.max(24, width);
  const contentWidth = Math.max(8, outerWidth - 4);
  const safeTitle = truncateLine(` ${title} `, Math.max(1, outerWidth - 6));
  const topRemainder = Math.max(0, outerWidth - safeTitle.length - 3);
  const top = colorize(
    `+${marker}${safeTitle}${"-".repeat(topRemainder)}+`,
    style,
    borderTone
  );
  const body = (lines.length > 0 ? lines : [""])
    .flatMap((line) => wrapLine(line, contentWidth))
    .slice(0, 32)
    .map((line) => `| ${padRight(truncateLine(line, contentWidth), contentWidth)} |`);
  const bottom = colorize(`+${"-".repeat(outerWidth - 2)}+`, style, borderTone);
  return [top, ...body, bottom];
}

interface RenderStyle {
  color: boolean;
}

type StyleTone =
  | "userBox"
  | "composerBorder"
  | "thinking"
  | "assistant"
  | "assistantHeading"
  | "assistantCode"
  | "working"
  | "muted"
  | "footerWarning"
  | "footerError"
  | "bashBorder"
  | "bashTitle"
  | "bashOutput"
  | "shellErrorBorder"
  | "toolPending"
  | "toolPendingTitle"
  | "toolPendingOutput"
  | "toolSuccess"
  | "toolSuccessTitle"
  | "toolSuccessOutput"
  | "toolError"
  | "toolErrorTitle"
  | "toolErrorOutput"
  | "toolTitle";

function renderStyle(options: { color?: boolean }): RenderStyle {
  return {
    color: options.color === true
  };
}

function colorize(
  value: string,
  style: RenderStyle | undefined,
  tone: StyleTone | undefined
): string {
  if (!style?.color || tone === undefined) {
    return value;
  }
  const codes: Record<StyleTone, string[]> = {
    userBox: ["48;2;52;53;65", "38;2;212;212;212"],
    composerBorder: ["38;2;236;174;236"],
    thinking: ["3", "38;2;128;128;128"],
    assistant: ["38;2;0;215;255"],
    assistantHeading: ["1", "38;2;0;215;255"],
    assistantCode: ["48;2;30;30;36", "38;2;138;190;183"],
    working: ["38;2;236;174;236"],
    muted: ["38;2;150;150;150"],
    footerWarning: ["38;2;255;255;0"],
    footerError: ["38;2;204;102;102"],
    bashBorder: ["38;2;181;189;104"],
    bashTitle: ["1", "38;2;181;189;104"],
    bashOutput: ["38;2;176;184;184"],
    shellErrorBorder: ["38;2;204;102;102"],
    toolPending: ["48;2;40;40;50", "38;2;212;212;212"],
    toolPendingTitle: ["48;2;40;40;50", "1", "38;2;212;212;212"],
    toolPendingOutput: ["48;2;40;40;50", "38;2;176;184;184"],
    toolSuccess: ["48;2;40;50;40", "38;2;212;212;212"],
    toolSuccessTitle: ["48;2;40;50;40", "1", "38;2;212;212;212"],
    toolSuccessOutput: ["48;2;40;50;40", "38;2;176;184;184"],
    toolError: ["48;2;60;40;40", "38;2;212;212;212"],
    toolErrorTitle: ["48;2;60;40;40", "1", "38;2;212;212;212"],
    toolErrorOutput: ["48;2;60;40;40", "38;2;176;184;184"],
    toolTitle: ["1", "38;2;212;212;212"]
  };
  return `${codes[tone].map((code) => `\x1b[${code}m`).join("")}${value}\x1b[0m`;
}

function renderFooter(
  state: WorkbenchTuiState,
  width: number,
  style?: RenderStyle
): string[] {
  const footer = state.footer;
  const cwd = shortenPath(state.snapshot.cwd);
  const runtime = state.runtimeKind;
  const session = `session ${shortId(state.snapshot.session?.id)}`;
  const artifact = `artifact ${artifactRef(latestArtifact(state.snapshot))}`;

  if (!footer) {
    return [
      rule(width),
      balancedLine(cwd, runtime, width),
      balancedLine(session, artifact, width)
    ];
  }

  return [
    rule(width),
    balancedLine(cwd, `${runtime} | ${authLabel(state)}`, width),
    ...renderFooterStatus(state, width, style),
    balancedLine(session, artifact, width)
  ];
}

function renderFooterStatus(
  state: WorkbenchTuiState,
  width: number,
  style?: RenderStyle
): string[] {
  const footer = state.footer;
  if (!footer) {
    return [];
  }
  return [formatFooterStatusLine(footer, width, style)];
}

function formatFooterStatusLine(
  footer: WorkbenchTuiFooterState,
  width: number,
  style?: RenderStyle
): string {
  const usage = formatFooterUsage(footer);
  const line = balancedLine(usage, formatFooterModel(footer), width);
  const contextUsage = formatFooterContextUsage(footer);
  const contextTone = footerContextTone(footer);
  if (!style?.color || !contextUsage || !contextTone) {
    return colorize(line, style, "muted");
  }
  const contextIndex = line.indexOf(contextUsage);
  if (contextIndex < 0) {
    return colorize(line, style, "muted");
  }
  return [
    colorizeNonEmpty(line.slice(0, contextIndex), style, "muted"),
    colorize(contextUsage, style, contextTone),
    colorizeNonEmpty(line.slice(contextIndex + contextUsage.length), style, "muted")
  ].join("");
}

function formatFooterUsage(footer: WorkbenchTuiFooterState): string {
  const parts = [
    footer.inputTokens ? `↑${formatTokenCount(footer.inputTokens)}` : undefined,
    footer.outputTokens ? `↓${formatTokenCount(footer.outputTokens)}` : undefined,
    footer.reasoningTokens ? `R${formatTokenCount(footer.reasoningTokens)}` : undefined,
    footer.cacheHitPercent !== undefined
      ? `CH${footer.cacheHitPercent.toFixed(1)}%`
      : undefined,
    footer.costUsd !== undefined ? `$${footer.costUsd.toFixed(3)}` : undefined,
    formatFooterContextUsage(footer)
  ].filter((part): part is string => part !== undefined);
  return parts.join(" ");
}

function formatFooterContextUsage(footer: WorkbenchTuiFooterState): string | undefined {
  if (footer.contextPercent === undefined || footer.contextWindow === undefined) {
    return undefined;
  }
  return `${footer.contextPercent.toFixed(1)}%/${formatTokenCount(footer.contextWindow)}${footer.autoCompact ? " (auto)" : ""}`;
}

function footerContextTone(
  footer: WorkbenchTuiFooterState
): "footerWarning" | "footerError" | undefined {
  if (footer.contextPercent === undefined) {
    return undefined;
  }
  if (footer.contextPercent > 90) {
    return "footerError";
  }
  if (footer.contextPercent > 70) {
    return "footerWarning";
  }
  return undefined;
}

function colorizeNonEmpty(
  value: string,
  style: RenderStyle | undefined,
  tone: StyleTone | undefined
): string {
  return value.length > 0 ? colorize(value, style, tone) : "";
}

function formatFooterModel(footer: WorkbenchTuiFooterState): string {
  if (!footer.model) {
    return "";
  }
  return footer.thinking ? `${footer.model} • ${footer.thinking}` : footer.model;
}

function authLabel(state: WorkbenchTuiState): string {
  return state.snapshot.auth.configured ? state.snapshot.auth.method : "auth missing";
}

function formatTokenCount(count: number): string {
  if (count < 1000) {
    return count.toString();
  }
  if (count < 10000) {
    return `${(count / 1000).toFixed(1)}k`;
  }
  if (count < 1000000) {
    return `${Math.round(count / 1000)}k`;
  }
  if (count < 10000000) {
    return `${(count / 1000000).toFixed(1)}M`;
  }
  return `${Math.round(count / 1000000)}M`;
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

function clipToolLines(lines: string[], expanded: boolean, maxLines = 10): string[] {
  if (lines.length <= maxLines) {
    return lines;
  }
  if (expanded) {
    return [...lines, "(ctrl+o to collapse)"];
  }
  const omitted = lines.length - maxLines;
  return [...lines.slice(0, maxLines), `... (${omitted} more lines, ctrl+o to expand)`];
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
