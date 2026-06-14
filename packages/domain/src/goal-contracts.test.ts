import { describe, expect, it } from "vitest";
import {
  GoalArtifactIndexSchema,
  GoalArtifactRefSchema,
  GoalFinalGateReportSchema,
  GoalRunManifestSchema
} from "./index.js";

const now = "2026-06-14T00:00:00.000Z";
const finalQuestion =
  "Given what changed during this goal, is the next planned goal still correct?";

describe("goal artifact contracts", () => {
  it("keeps goal artifacts in canonical goal-run storage", () => {
    expect(
      GoalArtifactRefSchema.safeParse(
        "goal-runs/goal-01-harness-contract-hardening/index.json"
      ).success
    ).toBe(true);
    expect(
      GoalArtifactRefSchema.safeParse(
        "agent-artifacts/goal-01-harness-contract-hardening/index.json"
      ).success
    ).toBe(false);
    expect(GoalArtifactRefSchema.safeParse("../goal/index.json").success).toBe(false);
  });

  it("describes a goal run manifest with explicit lanes and product boundary", () => {
    const manifest = GoalRunManifestSchema.parse({
      id: "goal-01-harness-contract-hardening",
      title: "Harness Contract Hardening",
      objective:
        "Make harness contracts stable enough for Codex, CLI, tests, and future UI panels.",
      branch: "codex/goal-01-harness-contract-hardening",
      created_at: now,
      status: "running",
      product_boundary: "trading_strategy_harness",
      lanes: [
        {
          id: "lane-1-contract-audit",
          order: 1,
          title: "Contract audit",
          completion_criteria: ["Audit contracts and write checkpoint."]
        }
      ],
      final_question: finalQuestion
    });

    expect(manifest.product_boundary).toBe("trading_strategy_harness");
    expect(
      GoalRunManifestSchema.safeParse({
        ...manifest,
        product_boundary: "general_coding_assistant"
      }).success
    ).toBe(false);
    expect(
      GoalRunManifestSchema.safeParse({
        ...manifest,
        final_question: "Can we start the next goal?"
      }).success
    ).toBe(false);
  });

  it("requires completed checkpoint entries to carry commits", () => {
    const index = GoalArtifactIndexSchema.parse({
      id: "goal-01-harness-contract-hardening-index",
      goal_id: "goal-01-harness-contract-hardening",
      artifact_ref: "goal-runs/goal-01-harness-contract-hardening/index.json",
      manifest_ref: "goal-runs/goal-01-harness-contract-hardening/manifest.json",
      created_at: now,
      updated_at: now,
      branch: "codex/goal-01-harness-contract-hardening",
      status: "running",
      checkpoints: [
        {
          lane_id: "lane-1-contract-audit",
          status: "completed",
          checkpoint_ref:
            "checkpoints/goal-01-harness-contract-hardening-lane-1-contract-audit.md",
          completed_at: now,
          commit: "1c1341b"
        }
      ],
      commits: ["1c1341b"]
    });

    expect(index.checkpoints).toHaveLength(1);
    expect(
      GoalArtifactIndexSchema.safeParse({
        ...index,
        checkpoints: [
          {
            lane_id: "lane-1-contract-audit",
            status: "completed",
            checkpoint_ref:
              "checkpoints/goal-01-harness-contract-hardening-lane-1-contract-audit.md",
            completed_at: now
          }
        ]
      }).success
    ).toBe(false);
  });

  it("requires completed final reports to include passing gates and next-goal readiness", () => {
    const report = GoalFinalGateReportSchema.parse({
      id: "goal-01-harness-contract-hardening-final",
      goal_id: "goal-01-harness-contract-hardening",
      artifact_ref: "goal-runs/goal-01-harness-contract-hardening/final-report.json",
      created_at: now,
      branch: "codex/goal-01-harness-contract-hardening",
      status: "completed",
      checkpoint_refs: [
        "checkpoints/goal-01-harness-contract-hardening-lane-1-contract-audit.md"
      ],
      commits: ["1c1341b"],
      final_gates: [
        {
          command: "pnpm test",
          status: "passed"
        }
      ],
      remaining_issues: [],
      recommended_next_goal: {
        title: "Market Data Foundation",
        readiness: "ready",
        rationale: "Harness contracts are stable enough to build dataset contracts."
      },
      final_question: finalQuestion
    });

    expect(report.status).toBe("completed");
    expect(
      GoalFinalGateReportSchema.safeParse({
        ...report,
        final_gates: [{ command: "pnpm test", status: "failed" }]
      }).success
    ).toBe(false);
    expect(
      GoalFinalGateReportSchema.safeParse({
        ...report,
        recommended_next_goal: undefined
      }).success
    ).toBe(false);
  });
});
