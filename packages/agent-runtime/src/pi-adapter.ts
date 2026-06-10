import {
  AgentSessionManifestSchema,
  type AgentSessionManifest
} from "@openstrat/domain";
import type { EventLogRepository } from "@openstrat/persistence";
import type { AgentToolGateway, AgentToolGatewayToolName } from "@openstrat/workers";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AgentRuntimePolicyEnforcer } from "./runtime-policy.js";

const DISABLED_PI_BUILTIN_TOOLS = ["read", "bash", "edit", "write"] as const;
const OPENSTRAT_RUNTIME_EVENT_CUSTOM_TYPE = "openstrat.runtime_event";

export interface PiRuntimeAdapterDependencies {
  events: EventLogRepository;
  now?: () => string;
  policy?: AgentRuntimePolicyEnforcer;
  sessionFactory?: PiAgentSessionFactory;
  toolGateway?: AgentToolGateway;
  transcriptStore?: PiTranscriptStore;
}

export interface StartPiAgentSessionInput {
  manifest: unknown;
  toolNames: readonly AgentToolGatewayToolName[];
}

export interface PiAgentRuntimeSession {
  session_id: string;
  runtime_session_id: string;
  enabled_tools: readonly AgentToolGatewayToolName[];
  disabled_builtin_tools: readonly (typeof DISABLED_PI_BUILTIN_TOOLS)[number][];
  transcript_ref: string;
  parent_session_id?: string;
  resumed_from_transcript_ref?: string;
}

export interface PromptPiAgentSessionInput {
  session_id: string;
  prompt: string;
}

export interface ResumePiAgentSessionInput extends StartPiAgentSessionInput {
  transcript_ref: string;
}

export interface ForkPiAgentSessionInput extends StartPiAgentSessionInput {
  parent_session_id: string;
  parent_transcript_ref: string;
}

export interface ReplayPiTranscriptInput {
  transcript_ref: string;
}

export interface ReplayPiTranscriptResult {
  transcript_ref: string;
  entries: unknown[];
  promoted_memory_writes: number;
}

export interface PiAgentRuntimeAdapter {
  startSession(input: StartPiAgentSessionInput): Promise<PiAgentRuntimeSession>;
  resumeSession(input: ResumePiAgentSessionInput): Promise<PiAgentRuntimeSession>;
  forkSession(input: ForkPiAgentSessionInput): Promise<PiAgentRuntimeSession>;
  prompt(input: PromptPiAgentSessionInput): Promise<void>;
  replayTranscript(input: ReplayPiTranscriptInput): Promise<ReplayPiTranscriptResult>;
  dispose(sessionId: string): Promise<void>;
}

export interface PiAgentSessionFactoryInput {
  manifest: AgentSessionManifest;
  toolNames: readonly AgentToolGatewayToolName[];
}

export interface PiAgentSessionLike {
  readonly sessionId: string;
  subscribe(listener: (event: PiAgentSessionEvent) => void | Promise<void>): () => void;
  prompt(prompt: string): Promise<void>;
  dispose(): void | Promise<void>;
}

export interface PiAgentSessionFactory {
  create(input: PiAgentSessionFactoryInput): Promise<PiAgentSessionLike>;
}

export type PiAgentSessionEvent =
  | {
      type: "tool_execution_start";
      toolCallId?: string;
      toolName?: string;
      arguments?: Record<string, unknown>;
    }
  | {
      type: "tool_execution_end";
      toolCallId?: string;
      toolName?: string;
      isError?: boolean;
    }
  | {
      type: "agent_end";
      messages?: unknown[];
    }
  | {
      type: "message_update";
      delta?: string;
      assistantMessageEvent?: unknown;
      message?: unknown;
    };

interface ActivePiSession {
  manifest: AgentSessionManifest;
  runtime: PiAgentRuntimeSession;
  session: PiAgentSessionLike;
  started_at: string;
  turn_count: number;
  unsubscribe: () => void;
}

export interface PiTranscriptCreateInput {
  manifest: AgentSessionManifest;
  parent_transcript_ref?: string;
}

export interface PiTranscriptStore {
  create(input: PiTranscriptCreateInput): string;
  appendRuntimeEvent(
    transcriptRef: string,
    event: { type: string; data: unknown }
  ): void;
  read(transcriptRef: string): unknown[];
}

export class FilePiTranscriptStore implements PiTranscriptStore {
  private readonly sessionsDir: string;

  constructor(rootDir: string) {
    this.sessionsDir = resolve(rootDir, "agent-runtime", "sessions");
    mkdirSync(this.sessionsDir, { recursive: true });
  }

  create(input: PiTranscriptCreateInput): string {
    const transcriptRef = this.resolveSessionPath(input.manifest.id);
    const header = {
      type: "session",
      version: 3,
      id: input.manifest.id,
      timestamp: input.manifest.created_at,
      cwd: process.cwd(),
      ...(input.parent_transcript_ref
        ? { parentSession: input.parent_transcript_ref }
        : {})
    };
    writeFileSync(transcriptRef, `${JSON.stringify(header)}\n`, {
      encoding: "utf8",
      mode: 0o600
    });
    return transcriptRef;
  }

  appendRuntimeEvent(
    transcriptRef: string,
    event: { type: string; data: unknown }
  ): void {
    const entry = {
      type: "custom",
      id: entryId(),
      parentId: null,
      timestamp: new Date().toISOString(),
      customType: OPENSTRAT_RUNTIME_EVENT_CUSTOM_TYPE,
      data: event
    };
    appendFileSync(transcriptRef, `${JSON.stringify(entry)}\n`, {
      encoding: "utf8"
    });
  }

  read(transcriptRef: string): unknown[] {
    return readFileSync(transcriptRef, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as unknown);
  }

  private resolveSessionPath(sessionId: string): string {
    return join(this.sessionsDir, `${sessionId}.jsonl`);
  }
}

export function createPiAgentRuntimeAdapter(
  dependencies: PiRuntimeAdapterDependencies
): PiAgentRuntimeAdapter {
  const now = dependencies.now ?? (() => new Date().toISOString());
  const sessionFactory =
    dependencies.sessionFactory ?? createDefaultPiAgentSessionFactory();
  const activeSessions = new Map<string, ActivePiSession>();

  return {
    async startSession(input) {
      return createRuntimeSession({
        dependencies,
        event_type: "agent.runtime.session_started",
        input,
        now,
        sessionFactory
      });
    },

    async resumeSession(input) {
      return createRuntimeSession({
        dependencies,
        event_type: "agent.runtime.session_resumed",
        input,
        now,
        resumed_from_transcript_ref: input.transcript_ref,
        sessionFactory
      });
    },

    async forkSession(input) {
      return createRuntimeSession({
        dependencies,
        event_type: "agent.runtime.session_forked",
        input,
        now,
        parent_session_id: input.parent_session_id,
        parent_transcript_ref: input.parent_transcript_ref,
        sessionFactory
      });
    },

    async prompt(input) {
      const active = activeSessions.get(input.session_id);
      if (!active) {
        throw new Error(`Pi agent session not found: ${input.session_id}`);
      }
      const occurredAt = now();
      dependencies.policy?.assertTurnAllowed(active.turn_count + 1);
      dependencies.policy?.assertRuntimeWithin(active.started_at, occurredAt);
      active.turn_count += 1;
      appendRuntimeEvent(dependencies, {
        manifest: active.manifest,
        occurred_at: occurredAt,
        payload: {
          prompt_ref: `${active.manifest.event_stream_id}/turn/input`,
          runtime_session_id: active.session.sessionId
        },
        transcript_ref: active.runtime.transcript_ref,
        type: "agent.runtime.turn_started"
      });
      await active.session.prompt(input.prompt);
    },

    async replayTranscript(input) {
      const entries = dependencies.transcriptStore?.read(input.transcript_ref) ?? [];
      return {
        transcript_ref: input.transcript_ref,
        entries,
        promoted_memory_writes: entries.filter(isPromotedMemoryWrite).length
      };
    },

    async dispose(sessionId) {
      const active = activeSessions.get(sessionId);
      if (!active) {
        return;
      }
      active.unsubscribe();
      await active.session.dispose();
      activeSessions.delete(sessionId);
    }
  };

  async function createRuntimeSession(params: {
    dependencies: PiRuntimeAdapterDependencies;
    event_type:
      | "agent.runtime.session_started"
      | "agent.runtime.session_resumed"
      | "agent.runtime.session_forked";
    input: StartPiAgentSessionInput;
    now: () => string;
    sessionFactory: PiAgentSessionFactory;
    parent_session_id?: string;
    parent_transcript_ref?: string;
    resumed_from_transcript_ref?: string;
  }): Promise<PiAgentRuntimeSession> {
    const manifest = AgentSessionManifestSchema.parse(params.input.manifest);
    if (manifest.runtime.model_profile_id) {
      params.dependencies.policy?.assertModelProfileAllowed(
        manifest.runtime.model_profile_id
      );
    }
    const startedAt = params.now();
    const filteredToolNames =
      params.dependencies.policy?.filterToolNames(params.input.toolNames) ??
      params.input.toolNames;
    const transcriptRef =
      params.resumed_from_transcript_ref ??
      params.dependencies.transcriptStore?.create({
        manifest,
        ...(params.parent_transcript_ref
          ? { parent_transcript_ref: params.parent_transcript_ref }
          : {})
      }) ??
      manifest.transcript_ref.uri;
    const session = await sessionFactory.create({
      manifest,
      toolNames: filteredToolNames
    });
    const runtime: PiAgentRuntimeSession = {
      session_id: manifest.id,
      runtime_session_id: session.sessionId,
      enabled_tools: [...filteredToolNames],
      disabled_builtin_tools: [...DISABLED_PI_BUILTIN_TOOLS],
      transcript_ref: transcriptRef,
      ...(params.parent_session_id
        ? { parent_session_id: params.parent_session_id }
        : {}),
      ...(params.resumed_from_transcript_ref
        ? { resumed_from_transcript_ref: params.resumed_from_transcript_ref }
        : {})
    };
    const unsubscribe = session.subscribe((event) =>
      projectPiEvent(params.dependencies, params.now(), manifest, runtime, event)
    );
    activeSessions.set(manifest.id, {
      manifest,
      runtime,
      session,
      started_at: startedAt,
      turn_count: 0,
      unsubscribe
    });

    appendRuntimeEvent(params.dependencies, {
      manifest,
      occurred_at: startedAt,
      payload: {
        runtime: manifest.runtime.kind,
        runtime_session_id: session.sessionId,
        enabled_tools: runtime.enabled_tools,
        disabled_builtin_tools: runtime.disabled_builtin_tools,
        transcript_ref: runtime.transcript_ref,
        ...(params.parent_session_id
          ? { parent_session_id: params.parent_session_id }
          : {}),
        ...(params.resumed_from_transcript_ref
          ? { resumed_from_transcript_ref: params.resumed_from_transcript_ref }
          : {})
      },
      transcript_ref: runtime.transcript_ref,
      type: params.event_type
    });

    return runtime;
  }
}

function appendRuntimeEvent(
  dependencies: PiRuntimeAdapterDependencies,
  event: {
    manifest: AgentSessionManifest;
    occurred_at: string;
    payload: Record<string, unknown>;
    transcript_ref: string;
    type: string;
  }
): void {
  dependencies.events.append({
    stream_id: event.manifest.event_stream_id,
    type: event.type,
    occurred_at: event.occurred_at,
    payload: event.payload,
    metadata: {
      transcript_ref: event.transcript_ref
    }
  });
  dependencies.transcriptStore?.appendRuntimeEvent(event.transcript_ref, {
    type: event.type,
    data: event.payload
  });
}

function isPromotedMemoryWrite(entry: unknown): boolean {
  if (!entry || typeof entry !== "object") {
    return false;
  }
  const record = entry as Record<string, unknown>;
  if (
    record.type !== "custom" ||
    record.customType !== OPENSTRAT_RUNTIME_EVENT_CUSTOM_TYPE
  ) {
    return false;
  }
  const data = record.data;
  if (!data || typeof data !== "object") {
    return false;
  }
  return (data as Record<string, unknown>).type === "memory.promoted";
}

function entryId(): string {
  return Math.random().toString(16).slice(2, 10).padEnd(8, "0");
}

export function createFakePiAgentSessionFactory(
  options: {
    events?: PiAgentSessionEvent[];
  } = {}
): PiAgentSessionFactory {
  return {
    async create(input) {
      return new FakePiAgentSession(
        input.manifest.id,
        options.events ?? [{ type: "agent_end", messages: [] }]
      );
    }
  };
}

export function createDefaultPiAgentSessionFactory(): PiAgentSessionFactory {
  return {
    async create(input) {
      const pi = await import("@earendil-works/pi-coding-agent");
      const authStorage = pi.AuthStorage.inMemory();
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

async function projectPiEvent(
  dependencies: PiRuntimeAdapterDependencies,
  occurredAt: string,
  manifest: AgentSessionManifest,
  runtime: PiAgentRuntimeSession,
  event: PiAgentSessionEvent
): Promise<void> {
  if (event.type === "tool_execution_start") {
    if (event.toolName && dependencies.policy) {
      try {
        dependencies.policy.assertToolAllowed(event.toolName);
      } catch {
        appendRuntimeEvent(dependencies, {
          manifest,
          occurred_at: occurredAt,
          transcript_ref: runtime.transcript_ref,
          type: "agent.runtime.tool_call_blocked",
          payload: {
            tool_call_id: event.toolCallId,
            tool_name: event.toolName,
            reason: "agent tool is forbidden by runtime policy"
          }
        });
        return;
      }
    }

    const toolCallId = event.toolCallId ?? `${manifest.id}:tool_call`;
    appendRuntimeEvent(dependencies, {
      manifest,
      occurred_at: occurredAt,
      transcript_ref: runtime.transcript_ref,
      type: "agent.runtime.tool_call_requested",
      payload: {
        tool_call_id: toolCallId,
        tool_name: event.toolName
      }
    });

    if (dependencies.toolGateway && event.toolName) {
      try {
        const result = await dependencies.toolGateway.invoke({
          call_id: toolCallId,
          session_id: manifest.id,
          turn_id: `${manifest.id}:turn:${toolCallId}`,
          tool_name: event.toolName,
          arguments: event.arguments ?? {}
        });
        appendRuntimeEvent(dependencies, {
          manifest,
          occurred_at: occurredAt,
          transcript_ref: runtime.transcript_ref,
          type: "agent.runtime.tool_call_completed",
          payload: {
            tool_call_id: toolCallId,
            tool_name: event.toolName,
            is_error: false,
            ...gatewayResultRefPayload(result)
          }
        });
      } catch (error) {
        appendRuntimeEvent(dependencies, {
          manifest,
          occurred_at: occurredAt,
          transcript_ref: runtime.transcript_ref,
          type: "agent.runtime.tool_call_blocked",
          payload: {
            tool_call_id: toolCallId,
            tool_name: event.toolName,
            reason: error instanceof Error ? error.message : "agent tool blocked"
          }
        });
      }
    }
    return;
  }

  if (event.type === "tool_execution_end") {
    appendRuntimeEvent(dependencies, {
      manifest,
      occurred_at: occurredAt,
      transcript_ref: runtime.transcript_ref,
      type: "agent.runtime.tool_call_completed",
      payload: {
        tool_call_id: event.toolCallId,
        tool_name: event.toolName,
        is_error: event.isError === true
      }
    });
    return;
  }

  if (event.type === "message_update") {
    appendRuntimeEvent(dependencies, {
      manifest,
      occurred_at: occurredAt,
      transcript_ref: runtime.transcript_ref,
      type: "agent.runtime.message_delta",
      payload: {
        delta: messageUpdateDelta(event)
      }
    });
    return;
  }

  appendRuntimeEvent(dependencies, {
    manifest,
    occurred_at: occurredAt,
    transcript_ref: runtime.transcript_ref,
    type: "agent.runtime.turn_completed",
    payload: {
      message_count: event.messages?.length ?? 0,
      ...finalAssistantTextPayload(event.messages)
    }
  });
}

function messageUpdateDelta(
  event: Extract<PiAgentSessionEvent, { type: "message_update" }>
): string {
  const assistantEvent = event.assistantMessageEvent;
  if (
    isRecord(assistantEvent) &&
    assistantEvent.type === "text_delta" &&
    typeof assistantEvent.delta === "string"
  ) {
    return assistantEvent.delta;
  }
  return event.delta ?? "";
}

function finalAssistantTextPayload(messages: unknown[] | undefined): {
  assistant_text?: string;
} {
  let assistant: unknown;
  for (const message of messages ?? []) {
    if (isRecord(message) && message.role === "assistant") {
      assistant = message;
    }
  }
  const assistantText = extractAssistantText(assistant);
  return assistantText ? { assistant_text: assistantText } : {};
}

function extractAssistantText(message: unknown): string {
  if (!isRecord(message) || !Array.isArray(message.content)) {
    return "";
  }
  return message.content
    .map((content) =>
      isRecord(content) && content.type === "text" && typeof content.text === "string"
        ? content.text
        : ""
    )
    .join("");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function gatewayResultRefPayload(result: unknown): { result_ref?: string } {
  if (!isRecord(result)) {
    return {};
  }
  const latestPrice = result.latest_price;
  if (
    isRecord(latestPrice) &&
    typeof latestPrice.raw_ref === "string" &&
    latestPrice.raw_ref.length > 0
  ) {
    return { result_ref: latestPrice.raw_ref };
  }
  return {};
}

class FakePiAgentSession implements PiAgentSessionLike {
  readonly sessionId: string;
  private readonly listeners = new Set<
    (event: PiAgentSessionEvent) => void | Promise<void>
  >();

  constructor(
    sessionId: string,
    private readonly events: PiAgentSessionEvent[]
  ) {
    this.sessionId = `fake-pi:${sessionId}`;
  }

  subscribe(
    listener: (event: PiAgentSessionEvent) => void | Promise<void>
  ): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async prompt(_prompt: string): Promise<void> {
    for (const event of this.events) {
      await Promise.all([...this.listeners].map((listener) => listener(event)));
    }
  }

  dispose(): void {
    this.listeners.clear();
  }
}
