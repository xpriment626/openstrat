import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { ThreadEvent } from "@openai/codex-sdk";
import {
  listJsonFiles,
  readJsonFile,
  writeJsonFile,
  type OpenStratCliHome
} from "./home.js";

export interface WorkbenchSessionRecord {
  id: string;
  created_at: string;
  updated_at: string;
  cwd: string;
  title: string;
  status: "active" | "archived";
  transcript_ref: string;
  codex_thread_id?: string;
  summary_ref?: string;
}

export interface TranscriptEntry {
  id: string;
  occurred_at: string;
  session_id: string;
  kind:
    | "session_started"
    | "user_message"
    | "slash_command"
    | "codex_event"
    | "codex_final_response"
    | "error";
  payload: Record<string, unknown>;
}

export interface ArtifactIndexEntry {
  id: string;
  created_at: string;
  session_id: string;
  kind:
    | "codex_agent_message"
    | "codex_command_execution"
    | "codex_file_change"
    | "codex_mcp_tool_call"
    | "backtest_plan"
    | "backtest_report"
    | "market_catalog"
    | "dataset_ingest_result"
    | "dataset_ingestion_plan"
    | "dataset_inspection"
    | "dataset_validation"
    | "risk_preflight"
    | "slash_command_result"
    | "session_summary"
    | "strategy_authoring_guide"
    | "strategy_validation"
    | "error";
  ref?: string;
  summary: string;
  metadata: Record<string, unknown>;
}

export interface ArtifactIndex {
  version: 1;
  entries: ArtifactIndexEntry[];
}

export function createWorkbenchSession(
  home: OpenStratCliHome,
  cwd: string,
  title = "OpenStrat Workbench"
): WorkbenchSessionRecord {
  const now = new Date().toISOString();
  const id = `session_${now.replaceAll(/[-:.TZ]/g, "")}_${randomUUID().slice(0, 8)}`;
  const record: WorkbenchSessionRecord = {
    id,
    created_at: now,
    updated_at: now,
    cwd,
    title,
    status: "active",
    transcript_ref: join(home.transcriptsDir, `${id}.jsonl`)
  };
  saveWorkbenchSession(home, record);
  appendTranscript(home, record, "session_started", {
    title,
    cwd
  });
  return record;
}

export function listWorkbenchSessions(
  home: OpenStratCliHome
): WorkbenchSessionRecord[] {
  return listJsonFiles(home.sessionsDir)
    .map((file) =>
      readJsonFile<WorkbenchSessionRecord>(join(home.sessionsDir, file), nullRecord)
    )
    .filter((record) => record.id !== "")
    .sort((left, right) => right.updated_at.localeCompare(left.updated_at));
}

export function readWorkbenchSession(
  home: OpenStratCliHome,
  id: string
): WorkbenchSessionRecord | undefined {
  const path = sessionPath(home, id);
  if (!existsSync(path)) {
    return undefined;
  }
  return readJsonFile<WorkbenchSessionRecord>(path, nullRecord);
}

export function saveWorkbenchSession(
  home: OpenStratCliHome,
  record: WorkbenchSessionRecord
): WorkbenchSessionRecord {
  mkdirSync(home.sessionsDir, { recursive: true });
  const saved = {
    ...record,
    updated_at: new Date().toISOString()
  };
  writeJsonFile(sessionPath(home, saved.id), saved);
  return saved;
}

export function appendTranscript(
  _home: OpenStratCliHome,
  session: WorkbenchSessionRecord,
  kind: TranscriptEntry["kind"],
  payload: Record<string, unknown>
): TranscriptEntry {
  const entry: TranscriptEntry = {
    id: randomUUID(),
    occurred_at: new Date().toISOString(),
    session_id: session.id,
    kind,
    payload
  };
  mkdirSync(join(session.transcript_ref, ".."), { recursive: true });
  appendFileSync(session.transcript_ref, `${JSON.stringify(entry)}\n`, "utf8");
  return entry;
}

export function readTranscript(session: WorkbenchSessionRecord): TranscriptEntry[] {
  if (!existsSync(session.transcript_ref)) {
    return [];
  }
  return readFileSync(session.transcript_ref, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as TranscriptEntry);
}

export function artifactIndexPath(home: OpenStratCliHome): string {
  return join(home.artifactsDir, "index.json");
}

export function readArtifactIndex(home: OpenStratCliHome): ArtifactIndex {
  return readJsonFile<ArtifactIndex>(artifactIndexPath(home), {
    version: 1,
    entries: []
  });
}

export function appendArtifactIndexEntry(
  home: OpenStratCliHome,
  entry: Omit<ArtifactIndexEntry, "id" | "created_at">
): ArtifactIndexEntry {
  const next: ArtifactIndexEntry = {
    id: randomUUID(),
    created_at: new Date().toISOString(),
    ...entry
  };
  const index = readArtifactIndex(home);
  writeJsonFile(artifactIndexPath(home), {
    version: 1,
    entries: [...index.entries, next]
  });
  return next;
}

export function projectCodexEventsToArtifacts(
  home: OpenStratCliHome,
  session: WorkbenchSessionRecord,
  event: ThreadEvent
): void {
  if (event.type !== "item.completed") {
    return;
  }
  const item = event.item;
  if (item.type === "agent_message") {
    appendArtifactIndexEntry(home, {
      session_id: session.id,
      kind: "codex_agent_message",
      summary: item.text.slice(0, 180),
      metadata: { item_id: item.id }
    });
    return;
  }
  if (item.type === "command_execution") {
    appendArtifactIndexEntry(home, {
      session_id: session.id,
      kind: "codex_command_execution",
      summary: item.command,
      metadata: {
        item_id: item.id,
        status: item.status,
        exit_code: item.exit_code
      }
    });
    return;
  }
  if (item.type === "file_change") {
    appendArtifactIndexEntry(home, {
      session_id: session.id,
      kind: "codex_file_change",
      summary: `${item.status}: ${item.changes.map((change) => change.path).join(", ")}`,
      metadata: {
        item_id: item.id,
        status: item.status,
        changes: item.changes
      }
    });
    return;
  }
  if (item.type === "mcp_tool_call") {
    appendArtifactIndexEntry(home, {
      session_id: session.id,
      kind: "codex_mcp_tool_call",
      summary: `${item.server}.${item.tool}: ${item.status}`,
      metadata: {
        item_id: item.id,
        server: item.server,
        tool: item.tool,
        status: item.status
      }
    });
  }
}

export function writeSessionSummary(
  home: OpenStratCliHome,
  session: WorkbenchSessionRecord
): WorkbenchSessionRecord {
  const transcript = readTranscript(session);
  const summaryRef = join(home.summariesDir, `${session.id}.json`);
  const userMessages = transcript.filter((entry) => entry.kind === "user_message");
  const commands = transcript.filter((entry) => entry.kind === "slash_command");
  const errors = transcript.filter((entry) => entry.kind === "error");
  writeJsonFile(summaryRef, {
    version: 1,
    session_id: session.id,
    generated_at: new Date().toISOString(),
    cwd: session.cwd,
    codex_thread_id: session.codex_thread_id,
    user_message_count: userMessages.length,
    slash_command_count: commands.length,
    error_count: errors.length,
    latest_user_message: userMessages.at(-1)?.payload,
    latest_command: commands.at(-1)?.payload,
    open_questions: [],
    next_action:
      "Continue in OpenStrat TUI or ask Codex to inspect/write strategy code."
  });
  const updated = saveWorkbenchSession(home, {
    ...session,
    summary_ref: summaryRef
  });
  appendArtifactIndexEntry(home, {
    session_id: session.id,
    kind: "session_summary",
    ref: summaryRef,
    summary: `Compacted OpenStrat session ${session.id}`,
    metadata: { transcript_entries: transcript.length }
  });
  return updated;
}

function sessionPath(home: OpenStratCliHome, id: string): string {
  return join(home.sessionsDir, `${basename(id)}.json`);
}

const nullRecord: WorkbenchSessionRecord = {
  id: "",
  created_at: "",
  updated_at: "",
  cwd: "",
  title: "",
  status: "archived",
  transcript_ref: ""
};
