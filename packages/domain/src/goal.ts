import { z } from "zod";
import {
  CanonicalObjectRefSchema,
  IsoDateTimeSchema,
  NonEmptyStringSchema,
  SourceRefSchema
} from "./common.js";

const REQUIRED_GOAL_FINAL_QUESTION =
  "Given what changed during this goal, is the next planned goal still correct?";

export const GoalArtifactRefSchema = CanonicalObjectRefSchema.refine(
  (ref) => ref.startsWith("goal-runs/"),
  "goal artifacts must live under goal-runs/"
);

export const GoalRunStatusSchema = z.enum([
  "planned",
  "running",
  "completed",
  "blocked",
  "failed"
]);

export const GoalLaneStatusSchema = z.enum([
  "pending",
  "in_progress",
  "completed",
  "blocked",
  "failed",
  "skipped"
]);

export const GoalVerificationStatusSchema = z.enum(["passed", "failed", "skipped"]);

export const NextGoalReadinessSchema = z.enum(["ready", "revise", "split", "delay"]);

export const GoalLaneDefinitionSchema = z.object({
  id: NonEmptyStringSchema,
  order: z.number().int().positive(),
  title: NonEmptyStringSchema,
  completion_criteria: z.array(NonEmptyStringSchema).min(1)
});

export const GoalRunManifestSchema = z.object({
  id: NonEmptyStringSchema,
  title: NonEmptyStringSchema,
  objective: NonEmptyStringSchema,
  branch: NonEmptyStringSchema,
  created_at: IsoDateTimeSchema,
  status: GoalRunStatusSchema,
  product_boundary: z.literal("trading_strategy_harness"),
  lanes: z.array(GoalLaneDefinitionSchema).min(1),
  final_question: z.literal(REQUIRED_GOAL_FINAL_QUESTION)
});

export const GoalCheckpointEntrySchema = z
  .object({
    lane_id: NonEmptyStringSchema,
    status: GoalLaneStatusSchema,
    checkpoint_ref: SourceRefSchema,
    completed_at: IsoDateTimeSchema.optional(),
    commit: NonEmptyStringSchema.optional(),
    remaining_issues: z.array(NonEmptyStringSchema).default([])
  })
  .superRefine((checkpoint, ctx) => {
    if (checkpoint.status !== "completed") {
      return;
    }
    if (!checkpoint.commit) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "completed checkpoints require commit",
        path: ["commit"]
      });
    }
    if (!checkpoint.completed_at) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "completed checkpoints require completed_at",
        path: ["completed_at"]
      });
    }
  });

export const GoalVerificationGateSchema = z.object({
  command: NonEmptyStringSchema,
  status: GoalVerificationStatusSchema,
  details: NonEmptyStringSchema.optional()
});

export const GoalNextRecommendationSchema = z.object({
  title: NonEmptyStringSchema,
  readiness: NextGoalReadinessSchema,
  rationale: NonEmptyStringSchema
});

export const GoalArtifactIndexSchema = z
  .object({
    id: NonEmptyStringSchema,
    goal_id: NonEmptyStringSchema,
    artifact_ref: GoalArtifactRefSchema,
    manifest_ref: GoalArtifactRefSchema,
    created_at: IsoDateTimeSchema,
    updated_at: IsoDateTimeSchema,
    branch: NonEmptyStringSchema,
    status: GoalRunStatusSchema,
    checkpoints: z.array(GoalCheckpointEntrySchema).default([]),
    commits: z.array(NonEmptyStringSchema).default([]),
    final_report_ref: GoalArtifactRefSchema.optional(),
    final_gates: z.array(GoalVerificationGateSchema).default([]),
    recommended_next_goal: GoalNextRecommendationSchema.optional()
  })
  .superRefine((index, ctx) => {
    if (index.status !== "completed") {
      return;
    }
    requireCompletedGoalArtifacts(
      {
        final_report_ref: index.final_report_ref,
        final_gates: index.final_gates,
        recommended_next_goal: index.recommended_next_goal
      },
      ctx
    );
  });

export const GoalFinalGateReportSchema = z
  .object({
    id: NonEmptyStringSchema,
    goal_id: NonEmptyStringSchema,
    artifact_ref: GoalArtifactRefSchema,
    created_at: IsoDateTimeSchema,
    branch: NonEmptyStringSchema,
    status: GoalRunStatusSchema,
    checkpoint_refs: z.array(SourceRefSchema).min(1),
    commits: z.array(NonEmptyStringSchema).min(1),
    final_gates: z.array(GoalVerificationGateSchema).min(1),
    remaining_issues: z.array(NonEmptyStringSchema).default([]),
    recommended_next_goal: GoalNextRecommendationSchema.optional(),
    final_question: z.literal(REQUIRED_GOAL_FINAL_QUESTION)
  })
  .superRefine((report, ctx) => {
    if (report.status !== "completed") {
      return;
    }
    requireCompletedGoalArtifacts(
      {
        final_gates: report.final_gates,
        recommended_next_goal: report.recommended_next_goal
      },
      ctx
    );
  });

export type GoalArtifactRef = z.infer<typeof GoalArtifactRefSchema>;
export type GoalRunStatus = z.infer<typeof GoalRunStatusSchema>;
export type GoalLaneStatus = z.infer<typeof GoalLaneStatusSchema>;
export type GoalVerificationStatus = z.infer<typeof GoalVerificationStatusSchema>;
export type NextGoalReadiness = z.infer<typeof NextGoalReadinessSchema>;
export type GoalLaneDefinition = z.infer<typeof GoalLaneDefinitionSchema>;
export type GoalRunManifest = z.infer<typeof GoalRunManifestSchema>;
export type GoalCheckpointEntry = z.infer<typeof GoalCheckpointEntrySchema>;
export type GoalVerificationGate = z.infer<typeof GoalVerificationGateSchema>;
export type GoalNextRecommendation = z.infer<typeof GoalNextRecommendationSchema>;
export type GoalArtifactIndex = z.infer<typeof GoalArtifactIndexSchema>;
export type GoalFinalGateReport = z.infer<typeof GoalFinalGateReportSchema>;

function requireCompletedGoalArtifacts(
  value: {
    final_report_ref?: string | undefined;
    final_gates: readonly { status: string }[];
    recommended_next_goal?: unknown | undefined;
  },
  ctx: z.RefinementCtx
): void {
  if ("final_report_ref" in value && !value.final_report_ref) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "completed goals require final_report_ref",
      path: ["final_report_ref"]
    });
  }
  if (value.final_gates.some((gate) => gate.status !== "passed")) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "completed goals require passing final gates",
      path: ["final_gates"]
    });
  }
  if (!value.recommended_next_goal) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "completed goals require recommended_next_goal",
      path: ["recommended_next_goal"]
    });
  }
}
