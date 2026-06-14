import { z } from "zod";
import {
  AutonomyModeSchema,
  NonEmptyStringSchema,
  type AutonomyMode
} from "@openstrat/domain";
import { agentToolGatewayToolNames } from "@openstrat/workers";

export const AgentProposalTypeSchema = z.enum([
  "research_brief",
  "strategy_patch",
  "backtest_request",
  "backtest_report_ref",
  "risk_validation",
  "memory_proposal",
  "deployment_proposal"
]);

export type AgentProposalType = z.infer<typeof AgentProposalTypeSchema>;

export const HARD_BLOCKED_AGENT_TOOLS = [
  "orders.write_live",
  "exchange.place_order",
  "exchange.cancel_order",
  "wallet.sign",
  "wallet.export_key",
  "process.exec",
  "codex.native.exec",
  "bash",
  "read",
  "write",
  "edit"
] as const;

export const AgentRuntimePolicySchema = z.object({
  autonomy_mode: AutonomyModeSchema,
  allowed_tool_names: z.array(NonEmptyStringSchema),
  allowed_model_profile_ids: z.array(NonEmptyStringSchema).min(1),
  max_turns: z.number().int().positive(),
  max_runtime_ms: z.number().int().positive(),
  allowed_proposal_types: z.array(AgentProposalTypeSchema).min(1)
});

export type AgentRuntimePolicy = z.infer<typeof AgentRuntimePolicySchema>;

export interface CreateAgentRuntimePolicyInput {
  autonomy_mode: AutonomyMode;
  allowed_model_profile_ids: readonly string[];
  allowed_tool_names?: readonly string[];
  max_turns?: number;
  max_runtime_ms?: number;
  allowed_proposal_types?: readonly AgentProposalType[];
}

export interface AgentRuntimePolicyEnforcer {
  readonly policy: AgentRuntimePolicy;
  filterToolNames<TToolName extends string>(
    toolNames: readonly TToolName[]
  ): TToolName[];
  assertToolAllowed(toolName: string): void;
  assertModelProfileAllowed(modelProfileId: string): void;
  assertProposalTypeAllowed(proposalType: AgentProposalType): void;
  assertTurnAllowed(nextTurnNumber: number): void;
  assertRuntimeWithin(startedAt: string, now: string): void;
}

export class ForbiddenAgentToolError extends Error {
  constructor(readonly toolName: string) {
    super(`Agent tool is forbidden by runtime policy: ${toolName}`);
    this.name = "ForbiddenAgentToolError";
  }
}

export class ForbiddenAgentModelProfileError extends Error {
  constructor(readonly modelProfileId: string) {
    super(`Agent model profile is forbidden by runtime policy: ${modelProfileId}`);
    this.name = "ForbiddenAgentModelProfileError";
  }
}

export class ForbiddenAgentProposalTypeError extends Error {
  constructor(readonly proposalType: AgentProposalType) {
    super(`Agent proposal type is forbidden by runtime policy: ${proposalType}`);
    this.name = "ForbiddenAgentProposalTypeError";
  }
}

export class TurnBudgetExceededError extends Error {
  constructor(readonly nextTurnNumber: number) {
    super(`Agent turn budget exceeded: ${nextTurnNumber}`);
    this.name = "TurnBudgetExceededError";
  }
}

export class RuntimeBudgetExceededError extends Error {
  constructor(readonly elapsedMs: number) {
    super(`Agent runtime budget exceeded: ${elapsedMs}ms`);
    this.name = "RuntimeBudgetExceededError";
  }
}

export function createAgentRuntimePolicy(
  input: CreateAgentRuntimePolicyInput
): AgentRuntimePolicy {
  const defaults = defaultsForAutonomyMode(input.autonomy_mode);
  return AgentRuntimePolicySchema.parse({
    autonomy_mode: input.autonomy_mode,
    allowed_tool_names: input.allowed_tool_names ?? defaults.allowed_tool_names,
    allowed_model_profile_ids: input.allowed_model_profile_ids,
    max_turns: input.max_turns ?? defaults.max_turns,
    max_runtime_ms: input.max_runtime_ms ?? defaults.max_runtime_ms,
    allowed_proposal_types:
      input.allowed_proposal_types ?? defaults.allowed_proposal_types
  });
}

export function createAgentRuntimePolicyEnforcer(
  policyInput: AgentRuntimePolicy
): AgentRuntimePolicyEnforcer {
  const policy = AgentRuntimePolicySchema.parse(policyInput);
  const allowedTools = new Set(policy.allowed_tool_names);
  const allowedModelProfiles = new Set(policy.allowed_model_profile_ids);
  const allowedProposalTypes = new Set(policy.allowed_proposal_types);

  return {
    policy,

    filterToolNames(toolNames) {
      return toolNames.filter((toolName) => isAllowedTool(toolName, allowedTools));
    },

    assertToolAllowed(toolName) {
      if (!isAllowedTool(toolName, allowedTools)) {
        throw new ForbiddenAgentToolError(toolName);
      }
    },

    assertModelProfileAllowed(modelProfileId) {
      if (!allowedModelProfiles.has(modelProfileId)) {
        throw new ForbiddenAgentModelProfileError(modelProfileId);
      }
    },

    assertProposalTypeAllowed(proposalType) {
      if (!allowedProposalTypes.has(proposalType)) {
        throw new ForbiddenAgentProposalTypeError(proposalType);
      }
    },

    assertTurnAllowed(nextTurnNumber) {
      if (nextTurnNumber > policy.max_turns) {
        throw new TurnBudgetExceededError(nextTurnNumber);
      }
    },

    assertRuntimeWithin(startedAt, currentTime) {
      const elapsedMs = Date.parse(currentTime) - Date.parse(startedAt);
      if (!Number.isFinite(elapsedMs) || elapsedMs > policy.max_runtime_ms) {
        throw new RuntimeBudgetExceededError(elapsedMs);
      }
    }
  };
}

function isAllowedTool(toolName: string, allowedTools: ReadonlySet<string>): boolean {
  return allowedTools.has(toolName) && !isHardBlockedTool(toolName);
}

function isHardBlockedTool(toolName: string): boolean {
  return HARD_BLOCKED_AGENT_TOOLS.includes(
    toolName as (typeof HARD_BLOCKED_AGENT_TOOLS)[number]
  );
}

function defaultsForAutonomyMode(
  autonomyMode: AutonomyMode
): Omit<AgentRuntimePolicy, "autonomy_mode" | "allowed_model_profile_ids"> {
  switch (autonomyMode) {
    case "research_only":
      return {
        allowed_tool_names: ["market_data.read_snapshot"],
        max_turns: 8,
        max_runtime_ms: 20 * 60 * 1000,
        allowed_proposal_types: ["research_brief", "memory_proposal"]
      };
    case "strategy_workbench":
      return {
        allowed_tool_names: agentToolGatewayToolNames(),
        max_turns: 12,
        max_runtime_ms: 30 * 60 * 1000,
        allowed_proposal_types: [
          "research_brief",
          "strategy_patch",
          "backtest_request",
          "risk_validation",
          "memory_proposal"
        ]
      };
    case "paper_trading":
    case "draft_orders":
      return {
        allowed_tool_names: agentToolGatewayToolNames(),
        max_turns: 10,
        max_runtime_ms: 20 * 60 * 1000,
        allowed_proposal_types: [
          "strategy_patch",
          "backtest_request",
          "risk_validation",
          "deployment_proposal"
        ]
      };
    case "constrained_live":
    case "adaptive_management":
      return {
        allowed_tool_names: [
          "market_data.read_snapshot",
          "risk.validate_intent",
          "deployment_gate.inspect"
        ],
        max_turns: 6,
        max_runtime_ms: 10 * 60 * 1000,
        allowed_proposal_types: ["risk_validation", "deployment_proposal"]
      };
  }
}
