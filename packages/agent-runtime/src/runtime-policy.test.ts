import { describe, expect, it } from "vitest";
import { agentToolGatewayToolNames } from "@openstrat/workers";
import {
  createAgentRuntimePolicy,
  createAgentRuntimePolicyEnforcer,
  ForbiddenAgentModelProfileError,
  ForbiddenAgentProposalTypeError,
  ForbiddenAgentToolError,
  RuntimeBudgetExceededError,
  TurnBudgetExceededError
} from "./runtime-policy.js";

describe("agent runtime policy enforcement", () => {
  it("maps autonomy mode to default tool, model, turn, runtime, and proposal limits", () => {
    const policy = createAgentRuntimePolicy({
      autonomy_mode: "strategy_workbench",
      allowed_model_profile_ids: ["model/openai-codex-subscription"]
    });

    expect(policy.allowed_tool_names).toEqual(agentToolGatewayToolNames());
    expect(policy.allowed_model_profile_ids).toEqual([
      "model/openai-codex-subscription"
    ]);
    expect(policy.max_turns).toBe(12);
    expect(policy.max_runtime_ms).toBe(30 * 60 * 1000);
    expect(policy.allowed_proposal_types).toEqual([
      "research_brief",
      "strategy_patch",
      "backtest_request",
      "risk_validation",
      "memory_proposal"
    ]);
  });

  it("hard-blocks live execution, signing, process, and native Pi filesystem tools", () => {
    const enforcer = createAgentRuntimePolicyEnforcer(
      createAgentRuntimePolicy({
        autonomy_mode: "constrained_live",
        allowed_model_profile_ids: ["model/openai-codex-subscription"],
        allowed_tool_names: [
          "market_data.read_snapshot",
          "orders.write_live",
          "wallet.sign",
          "bash",
          "write"
        ]
      })
    );

    expect(enforcer.filterToolNames(["market_data.read_snapshot", "write"])).toEqual([
      "market_data.read_snapshot"
    ]);
    expect(() => enforcer.assertToolAllowed("orders.write_live")).toThrow(
      ForbiddenAgentToolError
    );
    expect(() => enforcer.assertToolAllowed("wallet.sign")).toThrow(
      ForbiddenAgentToolError
    );
    expect(() => enforcer.assertToolAllowed("bash")).toThrow(ForbiddenAgentToolError);
    expect(() => enforcer.assertToolAllowed("write")).toThrow(ForbiddenAgentToolError);
  });

  it("enforces model profile, proposal type, turn, and runtime budgets", () => {
    const enforcer = createAgentRuntimePolicyEnforcer(
      createAgentRuntimePolicy({
        autonomy_mode: "research_only",
        allowed_model_profile_ids: ["model/research"],
        allowed_proposal_types: ["research_brief"],
        max_turns: 2,
        max_runtime_ms: 1_000
      })
    );

    expect(() => enforcer.assertModelProfileAllowed("model/other")).toThrow(
      ForbiddenAgentModelProfileError
    );
    expect(() => enforcer.assertProposalTypeAllowed("strategy_patch")).toThrow(
      ForbiddenAgentProposalTypeError
    );
    expect(() => enforcer.assertTurnAllowed(3)).toThrow(TurnBudgetExceededError);
    expect(() =>
      enforcer.assertRuntimeWithin(
        "2026-06-05T00:00:00.000Z",
        "2026-06-05T00:00:01.001Z"
      )
    ).toThrow(RuntimeBudgetExceededError);
  });
});
