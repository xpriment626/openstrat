import { describe, expect, it } from "vitest";
import { SqliteEventLog, type ObjectStore } from "@openstrat/persistence";
import {
  createStrategyProposalWorkflow,
  NativeMutationBlockedError
} from "./strategy-proposals.js";

const now = "2026-06-05T00:00:00.000Z";

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
    if (this.values.has(ref)) {
      throw new Error(`Object already exists: ${ref}`);
    }
    this.values.set(ref, value);
  }

  getJson<T = unknown>(ref: string): T {
    return this.values.get(ref) as T;
  }

  exists(ref: string): boolean {
    return this.values.has(ref);
  }
}

describe("strategy proposal workflow", () => {
  it("captures generated code and tests as a scratch patch-bundle proposal", () => {
    const objects = new MemoryObjectStore();
    const events = new SqliteEventLog(":memory:");
    const workflow = createStrategyProposalWorkflow({
      events,
      objects,
      now: () => now
    });

    const proposal = workflow.capturePatchBundle({
      session_id: "agent_session_001",
      turn_id: "turn_001",
      strategy_id: "eth_breakout",
      base_strategy_version: "0.1.0",
      rationale: "Add a volatility expansion threshold.",
      files: [
        {
          path: "src/strategy.ts",
          content: "export const threshold = 1.5;\n"
        },
        {
          path: "src/strategy.test.ts",
          content: "import { threshold } from './strategy.js';\n"
        }
      ]
    });

    expect(proposal.status).toBe("proposed");
    expect(proposal.patch_format).toBe("file_bundle");
    expect(proposal.patch_ref).toContain("scratch/agent_session_001");
    expect(objects.exists(proposal.patch_ref)).toBe(true);
    expect(objects.exists(proposal.artifact_ref.uri)).toBe(true);
    expect(events.list("agent_sessions/agent_session_001").at(-1)).toMatchObject({
      type: "agent.strategy_patch.proposed",
      payload: {
        proposal_id: proposal.id,
        strategy_id: "eth_breakout"
      }
    });
  });

  it("can scope strategy patch proposal refs under a project object namespace", () => {
    const objects = new MemoryObjectStore();
    const events = new SqliteEventLog(":memory:");
    const workflow = createStrategyProposalWorkflow({
      events,
      object_ref_root: "projects/project_001",
      objects,
      now: () => now
    });

    const proposal = workflow.capturePatchBundle({
      session_id: "agent_session_001",
      turn_id: "turn_001",
      strategy_id: "eth_breakout",
      rationale: "Try project-scoped scratch storage.",
      files: [{ path: "src/strategy.ts", content: "export default {};\n" }]
    });

    expect(proposal.patch_ref).toContain(
      "projects/project_001/scratch/agent_session_001"
    );
    expect(proposal.artifact_ref.uri).toContain(
      "projects/project_001/agent-artifacts/agent_session_001"
    );
    expect(objects.exists(proposal.patch_ref)).toBe(true);
    expect(objects.exists(proposal.artifact_ref.uri)).toBe(true);
  });

  it("does not mutate approved strategy manifests when capturing proposals", () => {
    const objects = new MemoryObjectStore();
    const events = new SqliteEventLog(":memory:");
    const approvedManifestRef = "strategies/approved/eth_breakout/manifest.json";
    const approvedManifest = {
      strategy_id: "eth_breakout",
      strategy_version: "1.0.0",
      name: "Approved ETH breakout",
      runtime: "typescript",
      entrypoint: "src/strategy.ts",
      allowed_symbols: ["ETH-PERP"],
      output: "trade_intent",
      created_at: now
    };
    objects.putJson(approvedManifestRef, approvedManifest);

    const workflow = createStrategyProposalWorkflow({
      events,
      objects,
      now: () => now
    });

    workflow.capturePatchBundle({
      session_id: "agent_session_001",
      turn_id: "turn_001",
      strategy_id: "eth_breakout",
      base_strategy_version: "1.0.0",
      rationale: "Try a tighter threshold.",
      files: [{ path: "src/strategy.ts", content: "export default {};\n" }]
    });

    expect(objects.getJson(approvedManifestRef)).toEqual(approvedManifest);
  });

  it("blocks native fs/process mutation requests against canonical harness refs", () => {
    const workflow = createStrategyProposalWorkflow({
      events: new SqliteEventLog(":memory:"),
      objects: new MemoryObjectStore(),
      now: () => now
    });

    expect(() =>
      workflow.capturePatchBundle({
        session_id: "agent_session_001",
        turn_id: "turn_001",
        strategy_id: "eth_breakout",
        base_strategy_version: "1.0.0",
        rationale: "Attempt direct mutation.",
        files: [{ path: "src/strategy.ts", content: "export default {};\n" }],
        native_mutation: {
          tool_name: "write",
          target_ref: "strategies/approved/eth_breakout/manifest.json"
        }
      })
    ).toThrow(NativeMutationBlockedError);
  });
});
