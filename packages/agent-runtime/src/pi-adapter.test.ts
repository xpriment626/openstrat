import { describe, expect, it } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { MarketDatum, MarketRegistryEntry, RiskReview } from "@openstrat/domain";
import type { MarketDataReader } from "@openstrat/market-data";
import { SqliteEventLog, type ObjectStore } from "@openstrat/persistence";
import type { RiskPolicyEngine } from "@openstrat/risk";
import { createAgentToolGateway } from "@openstrat/workers";
import {
  createFakePiAgentSessionFactory,
  createPiAgentRuntimeAdapter,
  FilePiTranscriptStore
} from "./pi-adapter.js";
import {
  createAgentRuntimePolicy,
  createAgentRuntimePolicyEnforcer
} from "./runtime-policy.js";

const now = "2026-06-05T00:00:00.000Z";

describe("Pi agent runtime adapter", () => {
  it("creates in-memory sessions with only explicit harness tools enabled", async () => {
    const events = new SqliteEventLog(":memory:");
    const adapter = createPiAgentRuntimeAdapter({
      events,
      now: () => now,
      sessionFactory: createFakePiAgentSessionFactory()
    });

    const session = await adapter.startSession({
      manifest: {
        id: "agent_session_001",
        created_at: now,
        purpose: "strategy_research",
        autonomy_mode: "strategy_workbench",
        runtime: {
          kind: "pi",
          adapter: "@openstrat/agent-runtime/pi",
          model_profile_id: "model/fake"
        },
        transcript_ref: {
          id: "artifact_transcript_001",
          kind: "agent_transcript",
          uri: "agent-sessions/agent_session_001/session.jsonl",
          content_hash: "sha256:in-memory",
          created_at: now,
          append_only: true
        },
        event_stream_id: "agent_sessions/agent_session_001",
        tool_grant_ids: ["grant_read_market_data"],
        canonical_ledger_refs: []
      },
      toolNames: ["market_data.read_snapshot"]
    });

    expect(session.session_id).toBe("agent_session_001");
    expect(session.enabled_tools).toEqual(["market_data.read_snapshot"]);
    expect(session.disabled_builtin_tools).toEqual(["read", "bash", "edit", "write"]);
    expect(events.list("agent_sessions/agent_session_001").at(0)).toMatchObject({
      type: "agent.runtime.session_started",
      payload: {
        runtime: "pi",
        enabled_tools: ["market_data.read_snapshot"]
      }
    });
  });

  it("projects prompt, tool call, tool result, and agent end events", async () => {
    const events = new SqliteEventLog(":memory:");
    const adapter = createPiAgentRuntimeAdapter({
      events,
      now: () => now,
      sessionFactory: createFakePiAgentSessionFactory({
        events: [
          {
            type: "tool_execution_start",
            toolCallId: "tool_call_001",
            toolName: "market_data.read_snapshot"
          },
          {
            type: "tool_execution_end",
            toolCallId: "tool_call_001",
            toolName: "market_data.read_snapshot",
            isError: false
          },
          {
            type: "agent_end",
            messages: []
          }
        ]
      })
    });

    const session = await adapter.startSession({
      manifest: minimalManifest("agent_session_002"),
      toolNames: ["market_data.read_snapshot"]
    });

    await adapter.prompt({
      session_id: session.session_id,
      prompt: "Check the latest ETH market data."
    });

    expect(
      events.list("agent_sessions/agent_session_002").map((event) => event.type)
    ).toEqual([
      "agent.runtime.session_started",
      "agent.runtime.turn_started",
      "agent.runtime.tool_call_requested",
      "agent.runtime.tool_call_completed",
      "agent.runtime.turn_completed"
    ]);
  });

  it("routes fake Pi market data tool requests through the agent tool gateway", async () => {
    const events = new SqliteEventLog(":memory:");
    const gateway = createAgentToolGateway({
      events,
      marketData: new StubMarketDataReader(),
      objects: new MemoryObjectStore(),
      risk: stubRiskEngine(),
      now: () => now
    });
    const adapter = createPiAgentRuntimeAdapter({
      events,
      now: () => now,
      toolGateway: gateway,
      sessionFactory: createFakePiAgentSessionFactory({
        events: [
          {
            type: "tool_execution_start",
            toolCallId: "tool_call_market",
            toolName: "market_data.read_snapshot",
            arguments: {
              canonical_symbol: "ETH-PERP"
            }
          },
          {
            type: "agent_end",
            messages: []
          }
        ] as never
      })
    });

    const session = await adapter.startSession({
      manifest: minimalManifest("agent_session_gateway_market"),
      toolNames: ["market_data.read_snapshot"]
    });

    await adapter.prompt({
      session_id: session.session_id,
      prompt: "Read the latest ETH market data."
    });

    expect(
      events.list("agent_sessions/agent_session_gateway_market").map((event) => ({
        type: event.type,
        payload: event.payload
      }))
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "agent.runtime.tool_call_requested",
          payload: expect.objectContaining({
            tool_call_id: "tool_call_market",
            tool_name: "market_data.read_snapshot"
          })
        }),
        expect.objectContaining({
          type: "agent.tool_call.completed",
          payload: expect.objectContaining({
            tool_call_id: "tool_call_market",
            tool_name: "market_data.read_snapshot",
            result_ref: "market-data/hyperliquid/eth/latest.json"
          })
        }),
        expect.objectContaining({
          type: "agent.runtime.tool_call_completed",
          payload: expect.objectContaining({
            tool_call_id: "tool_call_market",
            tool_name: "market_data.read_snapshot",
            is_error: false
          })
        })
      ])
    );
  });

  it("normalizes real Pi assistant message updates and final text", async () => {
    const events = new SqliteEventLog(":memory:");
    const assistant = assistantMessage("Hello from Pi.");
    const adapter = createPiAgentRuntimeAdapter({
      events,
      now: () => now,
      sessionFactory: createFakePiAgentSessionFactory({
        events: [
          {
            type: "message_update",
            message: assistant,
            assistantMessageEvent: {
              type: "text_delta",
              contentIndex: 0,
              delta: "Hello from Pi.",
              partial: assistant
            }
          },
          {
            type: "agent_end",
            messages: [userMessage("hello"), assistant],
            willRetry: false
          }
        ] as never
      })
    });

    const session = await adapter.startSession({
      manifest: minimalManifest("agent_session_real_pi_text"),
      toolNames: ["market_data.read_snapshot"]
    });

    await adapter.prompt({
      session_id: session.session_id,
      prompt: "hello"
    });

    const stream = events.list("agent_sessions/agent_session_real_pi_text");
    expect(stream.at(2)).toMatchObject({
      type: "agent.runtime.message_delta",
      payload: {
        delta: "Hello from Pi."
      }
    });
    expect(stream.at(-1)).toMatchObject({
      type: "agent.runtime.turn_completed",
      payload: {
        message_count: 2,
        assistant_text: "Hello from Pi."
      }
    });
  });

  it("records forbidden model-requested Pi/native tools as blocked runtime events", async () => {
    const events = new SqliteEventLog(":memory:");
    const adapter = createPiAgentRuntimeAdapter({
      events,
      now: () => now,
      policy: createAgentRuntimePolicyEnforcer(
        createAgentRuntimePolicy({
          autonomy_mode: "strategy_workbench",
          allowed_model_profile_ids: ["model/fake"],
          allowed_tool_names: ["market_data.read_snapshot"]
        })
      ),
      sessionFactory: createFakePiAgentSessionFactory({
        events: [
          {
            type: "tool_execution_start",
            toolCallId: "tool_call_native_write",
            toolName: "write"
          },
          {
            type: "agent_end",
            messages: []
          }
        ]
      })
    });

    const session = await adapter.startSession({
      manifest: minimalManifest("agent_session_policy_block"),
      toolNames: ["market_data.read_snapshot"]
    });

    await adapter.prompt({
      session_id: session.session_id,
      prompt: "Patch the approved strategy manifest directly."
    });

    const stream = events.list("agent_sessions/agent_session_policy_block");
    expect(stream.map((event) => event.type)).toEqual([
      "agent.runtime.session_started",
      "agent.runtime.turn_started",
      "agent.runtime.tool_call_blocked",
      "agent.runtime.turn_completed"
    ]);
    expect(stream.at(2)).toMatchObject({
      type: "agent.runtime.tool_call_blocked",
      payload: {
        tool_call_id: "tool_call_native_write",
        tool_name: "write",
        reason: "agent tool is forbidden by runtime policy"
      }
    });
  });

  it("persists Pi JSONL transcripts under an agent-runtime owned directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "openstrat-agent-runtime-"));
    const transcriptStore = new FilePiTranscriptStore(root);
    const events = new SqliteEventLog(":memory:");
    const adapter = createPiAgentRuntimeAdapter({
      events,
      now: () => now,
      sessionFactory: createFakePiAgentSessionFactory(),
      transcriptStore
    });

    const session = await adapter.startSession({
      manifest: minimalManifest("agent_session_003"),
      toolNames: ["market_data.read_snapshot"]
    });

    await adapter.prompt({
      session_id: session.session_id,
      prompt: "Summarize ETH market conditions."
    });

    expect(session.transcript_ref.startsWith(root)).toBe(true);
    expect(session.transcript_ref).toContain("agent-runtime");
    expect(existsSync(session.transcript_ref)).toBe(true);

    const lines = (await readFile(session.transcript_ref, "utf8")).trim().split("\n");
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
      type: "session",
      version: 3,
      id: "agent_session_003"
    });
    expect(lines.map((line) => JSON.parse(line) as { type: string })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "custom",
          customType: "openstrat.runtime_event"
        })
      ])
    );
    expect(
      events.list("agent_sessions/agent_session_003").at(-1)?.metadata
    ).toMatchObject({
      transcript_ref: session.transcript_ref
    });
  });

  it("records resume and fork identifiers without promoting transcript state", async () => {
    const root = await mkdtemp(join(tmpdir(), "openstrat-agent-runtime-"));
    const transcriptStore = new FilePiTranscriptStore(root);
    const events = new SqliteEventLog(":memory:");
    const adapter = createPiAgentRuntimeAdapter({
      events,
      now: () => now,
      sessionFactory: createFakePiAgentSessionFactory(),
      transcriptStore
    });

    const parent = await adapter.startSession({
      manifest: minimalManifest("agent_session_parent"),
      toolNames: ["market_data.read_snapshot"]
    });
    const child = await adapter.forkSession({
      manifest: minimalManifest("agent_session_child"),
      parent_session_id: parent.session_id,
      parent_transcript_ref: parent.transcript_ref,
      toolNames: ["market_data.read_snapshot"]
    });
    const resumed = await adapter.resumeSession({
      manifest: minimalManifest("agent_session_parent"),
      transcript_ref: parent.transcript_ref,
      toolNames: ["market_data.read_snapshot"]
    });

    expect(child.parent_session_id).toBe(parent.session_id);
    expect(resumed.resumed_from_transcript_ref).toBe(parent.transcript_ref);
    expect(events.list("agent_sessions/agent_session_child").at(0)).toMatchObject({
      type: "agent.runtime.session_forked",
      payload: {
        parent_session_id: "agent_session_parent"
      }
    });
  });

  it("replays transcripts read-only without mutating the append-only event log", async () => {
    const root = await mkdtemp(join(tmpdir(), "openstrat-agent-runtime-"));
    const transcriptStore = new FilePiTranscriptStore(root);
    const events = new SqliteEventLog(":memory:");
    const adapter = createPiAgentRuntimeAdapter({
      events,
      now: () => now,
      sessionFactory: createFakePiAgentSessionFactory(),
      transcriptStore
    });

    const session = await adapter.startSession({
      manifest: minimalManifest("agent_session_004"),
      toolNames: ["market_data.read_snapshot"]
    });
    await adapter.prompt({
      session_id: session.session_id,
      prompt: "Check data."
    });

    const before = events.list("agent_sessions/agent_session_004").length;
    const replay = await adapter.replayTranscript({
      transcript_ref: session.transcript_ref
    });
    const after = events.list("agent_sessions/agent_session_004").length;

    expect(replay.entries.length).toBeGreaterThan(0);
    expect(replay.promoted_memory_writes).toBe(0);
    expect(after).toBe(before);
  });
});

function minimalManifest(id: string) {
  return {
    id,
    created_at: now,
    purpose: "strategy_research" as const,
    autonomy_mode: "strategy_workbench" as const,
    runtime: {
      kind: "pi" as const,
      adapter: "@openstrat/agent-runtime/pi",
      model_profile_id: "model/fake"
    },
    transcript_ref: {
      id: `artifact_transcript_${id}`,
      kind: "agent_transcript" as const,
      uri: `agent-sessions/${id}/session.jsonl`,
      content_hash: "sha256:in-memory",
      created_at: now,
      append_only: true as const
    },
    event_stream_id: `agent_sessions/${id}`,
    tool_grant_ids: [],
    canonical_ledger_refs: []
  };
}

function userMessage(text: string) {
  return {
    role: "user",
    content: text,
    timestamp: Date.parse(now)
  };
}

function assistantMessage(text: string) {
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
    timestamp: Date.parse(now)
  };
}

class MemoryObjectStore implements ObjectStore {
  readonly values = new Map<string, unknown>();

  putBytes(ref: string, bytes: Uint8Array): void {
    this.values.set(ref, Buffer.from(bytes).toString("utf8"));
  }

  getBytes(ref: string): Buffer {
    const value = this.values.get(ref);
    if (typeof value !== "string") {
      throw new Error(`missing bytes: ${ref}`);
    }
    return Buffer.from(value);
  }

  putJson(ref: string, value: unknown): void {
    this.values.set(ref, value);
  }

  getJson<T = unknown>(ref: string): T {
    if (!this.values.has(ref)) {
      throw new Error(`missing json: ${ref}`);
    }
    return this.values.get(ref) as T;
  }

  exists(ref: string): boolean {
    return this.values.has(ref);
  }
}

class StubMarketDataReader implements MarketDataReader {
  async getMarket(canonicalSymbol: string): Promise<MarketRegistryEntry | undefined> {
    return {
      canonical_symbol: canonicalSymbol,
      display_symbol: "ETH",
      venue_symbol: "ETH",
      venue: "hyperliquid",
      source: "hyperliquid",
      asset_class: "crypto",
      quote_token: "USDC",
      collateral_token: "USDC",
      max_leverage: 50,
      min_order_size: 0.001,
      tick_size: 0.1,
      lot_size: 0.0001,
      status: "active",
      liquidity_score: 0.9,
      last_verified_at: now,
      source_refs: ["market-registry/hyperliquid/eth.json"]
    };
  }

  async getLatestPrice(): Promise<MarketDatum> {
    return {
      value: 3500,
      source: "hyperliquid",
      venue: "hyperliquid",
      symbol: "ETH",
      canonical_symbol: "ETH-PERP",
      method: "mark",
      timestamp: now,
      received_at: now,
      stale_after_ms: 5000,
      confidence: 0.99,
      raw_ref: "market-data/hyperliquid/eth/latest.json"
    };
  }

  async getCandles(): Promise<never> {
    throw new Error("not used");
  }

  async getOrderbookSnapshot(): Promise<never> {
    throw new Error("not used");
  }
}

function stubRiskEngine(): RiskPolicyEngine {
  return {
    async review(): Promise<RiskReview> {
      throw new Error("not used");
    }
  };
}
