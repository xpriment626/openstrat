import { z } from "zod";
import { BotRuntimeModeSchema, DeploymentTargetKindSchema } from "./deployment.js";
import {
  AutonomyModeSchema,
  CanonicalSymbolSchema,
  ConfidenceSchema,
  IsoDateTimeSchema,
  JsonRecordSchema,
  NonEmptyStringSchema,
  PositiveFiniteSchema,
  SourceRefSchema
} from "./common.js";

export const AgentRuntimeKindSchema = z.enum([
  "pi",
  "codex_app_server",
  "openclaw_compat",
  "fake"
]);

export const AgentRuntimeConfigSchema = z.object({
  kind: AgentRuntimeKindSchema,
  adapter: NonEmptyStringSchema,
  model_profile_id: NonEmptyStringSchema.optional(),
  provider: NonEmptyStringSchema.optional(),
  model: NonEmptyStringSchema.optional()
});

export const AgentArtifactKindSchema = z.enum([
  "agent_transcript",
  "proposal",
  "tool_result",
  "runtime_event",
  "scratch_workspace",
  "backtest_report_ref",
  "strategy_patch"
]);

export const AgentArtifactRefSchema = z.object({
  id: NonEmptyStringSchema,
  kind: AgentArtifactKindSchema,
  uri: NonEmptyStringSchema,
  content_hash: NonEmptyStringSchema,
  created_at: IsoDateTimeSchema,
  append_only: z.literal(true),
  metadata: JsonRecordSchema.default({})
});

export const AgentToolPermissionSchema = z.enum([
  "read",
  "inspect",
  "validate",
  "propose"
]);

export const AgentToolScopeSchema = z.enum([
  "market_data",
  "backtests",
  "risk",
  "strategy_workspace",
  "memory_proposals",
  "deployment_gates",
  "runtime"
]);

export const AgentToolGrantSchema = z.object({
  id: NonEmptyStringSchema,
  created_at: IsoDateTimeSchema,
  session_id: NonEmptyStringSchema,
  tool_name: NonEmptyStringSchema,
  permission: AgentToolPermissionSchema,
  scope: AgentToolScopeSchema,
  expires_at: IsoDateTimeSchema.optional()
});

export const AgentSessionPurposeSchema = z.enum([
  "research",
  "strategy_research",
  "strategy_generation",
  "backtest_iteration",
  "risk_review",
  "deployment_planning"
]);

export const AgentSessionManifestSchema = z.object({
  id: NonEmptyStringSchema,
  created_at: IsoDateTimeSchema,
  purpose: AgentSessionPurposeSchema,
  autonomy_mode: AutonomyModeSchema,
  runtime: AgentRuntimeConfigSchema,
  transcript_ref: AgentArtifactRefSchema.refine(
    (ref) => ref.kind === "agent_transcript",
    "agent sessions must point to agent transcript storage"
  ),
  event_stream_id: NonEmptyStringSchema,
  tool_grant_ids: z.array(NonEmptyStringSchema).default([]),
  canonical_ledger_refs: z.array(SourceRefSchema).length(0).default([])
});

export const AgentTurnStatusSchema = z.enum([
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled"
]);

export const AgentTurnSchema = z
  .object({
    id: NonEmptyStringSchema,
    session_id: NonEmptyStringSchema,
    started_at: IsoDateTimeSchema,
    completed_at: IsoDateTimeSchema.optional(),
    status: AgentTurnStatusSchema,
    input_ref: SourceRefSchema,
    output_refs: z.array(SourceRefSchema).default([]),
    tool_call_ids: z.array(NonEmptyStringSchema).default([]),
    error: NonEmptyStringSchema.optional()
  })
  .superRefine((turn, ctx) => {
    if (
      turn.completed_at &&
      Date.parse(turn.completed_at) < Date.parse(turn.started_at)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "completed_at must be at or after started_at",
        path: ["completed_at"]
      });
    }
  });

export const AgentRuntimeEventTypeSchema = z.enum([
  "session_started",
  "turn_started",
  "message_delta",
  "tool_call_requested",
  "tool_call_blocked",
  "tool_call_completed",
  "proposal_captured",
  "turn_completed",
  "session_resumed",
  "session_forked",
  "session_failed"
]);

export const AgentRuntimeEventSchema = z.object({
  id: NonEmptyStringSchema,
  session_id: NonEmptyStringSchema,
  turn_id: NonEmptyStringSchema.optional(),
  occurred_at: IsoDateTimeSchema,
  type: AgentRuntimeEventTypeSchema,
  payload: JsonRecordSchema,
  event_stream_id: NonEmptyStringSchema
});

export const AgentToolCallStatusSchema = z.enum([
  "requested",
  "blocked",
  "completed",
  "failed"
]);

export const AgentToolSideEffectSchema = z.enum([
  "none",
  "event_logged",
  "proposal_written",
  "scratch_workspace_write"
]);

export const AgentToolCallRecordSchema = z
  .object({
    id: NonEmptyStringSchema,
    session_id: NonEmptyStringSchema,
    turn_id: NonEmptyStringSchema,
    tool_name: NonEmptyStringSchema,
    arguments: JsonRecordSchema,
    status: AgentToolCallStatusSchema,
    requested_at: IsoDateTimeSchema,
    completed_at: IsoDateTimeSchema.optional(),
    output_ref: SourceRefSchema.optional(),
    error: NonEmptyStringSchema.optional(),
    side_effect: AgentToolSideEffectSchema
  })
  .superRefine((call, ctx) => {
    if (
      call.completed_at &&
      Date.parse(call.completed_at) < Date.parse(call.requested_at)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "completed_at must be at or after requested_at",
        path: ["completed_at"]
      });
    }
  });

export const AgentProposalStatusSchema = z.enum([
  "proposed",
  "rejected",
  "superseded",
  "promoted"
]);

const AgentProposalBaseSchema = z
  .object({
    id: NonEmptyStringSchema,
    created_at: IsoDateTimeSchema,
    session_id: NonEmptyStringSchema,
    turn_id: NonEmptyStringSchema.optional(),
    status: AgentProposalStatusSchema.default("proposed"),
    artifact_ref: AgentArtifactRefSchema.refine(
      (ref) => ref.kind === "proposal",
      "proposal artifacts must use proposal artifact refs"
    ),
    promotion_event_ref: SourceRefSchema.optional()
  })
  .superRefine((proposal, ctx) => {
    if (proposal.status === "promoted" && !proposal.promotion_event_ref) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "promoted proposals require promotion_event_ref",
        path: ["promotion_event_ref"]
      });
    }
  });

export const ResearchBriefSchema = AgentProposalBaseSchema.extend({
  title: NonEmptyStringSchema,
  question: NonEmptyStringSchema,
  summary: NonEmptyStringSchema,
  evidence_refs: z.array(SourceRefSchema).min(1),
  limitations: z.array(NonEmptyStringSchema).default([])
});

export const StrategyPatchProposalSchema = AgentProposalBaseSchema.extend({
  strategy_id: NonEmptyStringSchema,
  base_strategy_version: NonEmptyStringSchema.optional(),
  patch_format: z.enum(["unified_diff", "file_bundle"]),
  patch_ref: SourceRefSchema,
  rationale: NonEmptyStringSchema,
  tests_ref: SourceRefSchema.optional()
});

export const BacktestRequestSchema = AgentProposalBaseSchema.extend({
  strategy_ref: SourceRefSchema,
  dataset_ref: SourceRefSchema,
  canonical_symbols: z.array(CanonicalSymbolSchema).min(1),
  parameters: JsonRecordSchema.default({})
});

export const BacktestReportRefSchema = AgentProposalBaseSchema.extend({
  backtest_run_id: NonEmptyStringSchema,
  report_ref: SourceRefSchema,
  metrics_ref: SourceRefSchema.optional()
});

export const RiskValidationRequestSchema = AgentProposalBaseSchema.extend({
  intent_ref: SourceRefSchema,
  risk_policy_ref: SourceRefSchema,
  context_refs: z.array(SourceRefSchema).default([])
});

export const MemorySubjectTypeSchema = z.enum([
  "strategy",
  "risk",
  "execution",
  "regime",
  "market",
  "agent"
]);

export const MemoryProposalSchema = AgentProposalBaseSchema.extend({
  subject_type: MemorySubjectTypeSchema,
  subject_id: NonEmptyStringSchema,
  claim: NonEmptyStringSchema,
  evidence_refs: z.array(SourceRefSchema).min(1),
  confidence: ConfidenceSchema,
  allowed_uses: z.array(NonEmptyStringSchema).min(1),
  forbidden_uses: z.array(NonEmptyStringSchema).default([]),
  expiry_or_recheck: NonEmptyStringSchema.optional(),
  dissent: z.array(NonEmptyStringSchema).default([]),
  requires_human_review: z.boolean().default(true)
});

export const DeploymentProposalSchema = AgentProposalBaseSchema.extend({
  strategy_manifest_ref: SourceRefSchema,
  deployment_gate_ref: SourceRefSchema,
  target_kind: DeploymentTargetKindSchema,
  runtime_mode: BotRuntimeModeSchema,
  duration_ms: PositiveFiniteSchema
});

export const AgentProposalArtifactSchema = z.discriminatedUnion("proposal_type", [
  ResearchBriefSchema.extend({ proposal_type: z.literal("research_brief") }),
  StrategyPatchProposalSchema.extend({ proposal_type: z.literal("strategy_patch") }),
  BacktestRequestSchema.extend({ proposal_type: z.literal("backtest_request") }),
  BacktestReportRefSchema.extend({ proposal_type: z.literal("backtest_report_ref") }),
  RiskValidationRequestSchema.extend({
    proposal_type: z.literal("risk_validation_request")
  }),
  MemoryProposalSchema.extend({ proposal_type: z.literal("memory_proposal") }),
  DeploymentProposalSchema.extend({ proposal_type: z.literal("deployment_proposal") })
]);

export type AgentRuntimeKind = z.infer<typeof AgentRuntimeKindSchema>;
export type AgentRuntimeConfig = z.infer<typeof AgentRuntimeConfigSchema>;
export type AgentArtifactKind = z.infer<typeof AgentArtifactKindSchema>;
export type AgentArtifactRef = z.infer<typeof AgentArtifactRefSchema>;
export type AgentToolPermission = z.infer<typeof AgentToolPermissionSchema>;
export type AgentToolScope = z.infer<typeof AgentToolScopeSchema>;
export type AgentToolGrant = z.infer<typeof AgentToolGrantSchema>;
export type AgentSessionPurpose = z.infer<typeof AgentSessionPurposeSchema>;
export type AgentSessionManifest = z.infer<typeof AgentSessionManifestSchema>;
export type AgentTurnStatus = z.infer<typeof AgentTurnStatusSchema>;
export type AgentTurn = z.infer<typeof AgentTurnSchema>;
export type AgentRuntimeEventType = z.infer<typeof AgentRuntimeEventTypeSchema>;
export type AgentRuntimeEvent = z.infer<typeof AgentRuntimeEventSchema>;
export type AgentToolCallStatus = z.infer<typeof AgentToolCallStatusSchema>;
export type AgentToolSideEffect = z.infer<typeof AgentToolSideEffectSchema>;
export type AgentToolCallRecord = z.infer<typeof AgentToolCallRecordSchema>;
export type AgentProposalStatus = z.infer<typeof AgentProposalStatusSchema>;
export type ResearchBrief = z.infer<typeof ResearchBriefSchema>;
export type StrategyPatchProposal = z.infer<typeof StrategyPatchProposalSchema>;
export type BacktestRequest = z.infer<typeof BacktestRequestSchema>;
export type BacktestReportRef = z.infer<typeof BacktestReportRefSchema>;
export type RiskValidationRequest = z.infer<typeof RiskValidationRequestSchema>;
export type MemorySubjectType = z.infer<typeof MemorySubjectTypeSchema>;
export type MemoryProposal = z.infer<typeof MemoryProposalSchema>;
export type DeploymentProposal = z.infer<typeof DeploymentProposalSchema>;
export type AgentProposalArtifact = z.infer<typeof AgentProposalArtifactSchema>;
