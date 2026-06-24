import { describe, expect, it } from "vitest";
import {
  CodexBaselineContractSchema,
  CodexOpenStratConfigBoundarySchema,
  OPENSTRAT_CODEX_BASELINE_CONTRACT,
  OpenStratCodexToolDefinitionSchema
} from "./index.js";

describe("Codex baseline contract", () => {
  it("assigns harness mechanics to Codex and trading semantics to OpenStrat", () => {
    const contract = CodexBaselineContractSchema.parse(
      OPENSTRAT_CODEX_BASELINE_CONTRACT
    );

    expect(contract.runtime.integration_mode).toBe("sdk");
    expect(contract.runtime.auth_modes).toEqual(["chatgpt", "api_key"]);
    expect(contract.codex_owns).toEqual(
      expect.arrayContaining([
        "auth",
        "conversation_threads",
        "turn_execution",
        "native_file_tools",
        "native_shell_tools",
        "sandboxing",
        "approval_prompts",
        "session_resume",
        "compaction"
      ])
    );
    expect(contract.openstrat_owns).toEqual(
      expect.arrayContaining([
        "market_data",
        "dataset_provenance",
        "strategy_workspace",
        "strategy_validation",
        "backtesting",
        "risk_policy",
        "deployment_gates",
        "builder_code_config",
        "wallet_handle_config"
      ])
    );
  });

  it("keeps OpenStrat tools domain-specific instead of replacing native coding tools", () => {
    const contract = CodexBaselineContractSchema.parse(
      OPENSTRAT_CODEX_BASELINE_CONTRACT
    );

    expect(contract.openstrat_tools.map((tool) => tool.name)).toEqual([
      "market_data.read_snapshot",
      "dataset.plan_ingestion",
      "dataset.execute_ingestion",
      "dataset.validate",
      "dataset.inspect",
      "strategy.guide",
      "strategy.validate",
      "backtest.plan",
      "backtest.run",
      "backtest.request",
      "risk.preflight",
      "risk.validate_intent",
      "strategy_patch.capture",
      "memory_proposal.capture",
      "deployment_gate.inspect"
    ]);
    expect(
      contract.openstrat_tools.every((tool) => tool.codex_native_tool === false)
    ).toBe(true);

    expect(
      OpenStratCodexToolDefinitionSchema.safeParse({
        name: "orders.write_live",
        capability: "deployment_gates",
        side_effect: "external_write_blocked",
        codex_native_tool: false,
        requires_human_approval: true
      }).success
    ).toBe(false);
  });

  it("treats wallet handles and builder codes as config but rejects secrets", () => {
    const boundary = CodexOpenStratConfigBoundarySchema.parse(
      OPENSTRAT_CODEX_BASELINE_CONTRACT.config_boundary
    );

    expect(boundary.codex_home_env).toBe("CODEX_HOME");
    expect(boundary.openstrat_user_home_env).toBe("OPENSTRAT_USER_HOME");
    expect(boundary.project_dir).toBe(".openstrat");
    expect(boundary.project_scope).toContain("builder_codes");
    expect(boundary.project_scope).toContain("wallet_handles");
    expect(boundary.user_scope).toContain("builder_codes");
    expect(boundary.user_scope).toContain("wallet_handles");
    expect(boundary.forbidden_openstrat_secret_classes).toEqual(
      expect.arrayContaining([
        "codex_tokens",
        "private_keys",
        "seed_phrases",
        "wallet_signing_keys"
      ])
    );
    expect(boundary.secret_material_policy).toBe("owned_by_codex_or_wallet_provider");
  });

  it("fails if the baseline stops assigning required capabilities", () => {
    expect(
      CodexBaselineContractSchema.safeParse({
        ...OPENSTRAT_CODEX_BASELINE_CONTRACT,
        codex_owns: ["auth"],
        openstrat_owns: ["market_data"]
      }).success
    ).toBe(false);
  });
});
